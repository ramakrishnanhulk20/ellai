// Covers: the visit an owner's own request starts (runOwnerVisit) on PGlite, with a stand-in chain
// and a stand-in relayer, and the jobs tick's side of the same lease (C40). Of two visits started
// together for one owner exactly one works and the other does no step and calls neither the chain
// nor the relayer; the lease is released after a pass whose step failed and after a visit that
// threw, and a lease past its time is taken over; an answered question's memory is sent and
// confirmed across passes exactly LIMITS.ownerVisitPassGapMs apart, and the visit stops once
// nothing waits; no pass starts at or past the deadline; a memory recorded while another visit
// held the lease is still sent, after that visit releases it, but the lease is never taken again
// for a memory of an owner with no Walrus Memory account, nor after a pass that recorded an error,
// so neither repeats passes at once; ten visits read a purse above the
// refill threshold once (C28); every request of a visit, its epoch reading included, is charged
// to the owner's own share; a refill pending since long before a visit costs it one pass and one
// read, and 32 visits across 40 minutes read it once; a failed refill read holds the refill step
// off for LIMITS.refillErrorWaitMs; a closed-window payment Tatum cannot read counts one failed
// read across a visit's passes and still becomes unverifiable after six reads 10 minutes apart;
// ten visits in ten minutes make one epoch read for a held-back payment; visits every minute scan
// a waiting memory's Blob objects once per LIMITS.blobScanSpacingMs, and at once for a memory
// confirmed since; a refill stuck all day costs at most 72 refills-scope requests; refused writes
// take at least 40 minutes to fail a memory; a memory confirmed just before a scan for others is
// looked for once old enough; and a day of visits, at an agent's cap for its first ten minutes and
// a minute apart after, stays inside the
// N and M of C34 for one held-back payment, one stuck refill and one memory awaiting its blob, on
// one process and with every visit on a fresh instance, the payment still settling (C40); the tick skips an owner whose lease is held; and 'overview' starts
// nothing within LIMITS.ownerVisitMinGapMs of the last visit or for an owner with no work.
// Does NOT cover: the real Sui chain, Tatum or the relayer (npm run prove:visit sends a memory
// live), Tatum failing during the day of visits (each retry is then a request of its own, which
// the 200 and 100 shares cap), an owner whose Blob objects take more than one page, two database
// connections racing on the lease (PGlite serves one connection, so the single UPDATE that takes
// it is not raced here), or what Next does with the scheduled task
// (the route tests hand it to a collector).
import { randomBytes, randomUUID } from 'node:crypto';
import { type Chain, ChainError } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { createMemoryClient } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, memories, owners, payments, questions, refills } from '../src/server/db/schema.js';
import { answerQuestion } from '../src/server/decide/answer.js';
import { type TatumScope, currentTatumScope, tatumMeter } from '../src/server/http/tatum-meter.js';
import { emptySummary, runJobsTick } from '../src/server/jobs/tick.js';
import { type VisitTrigger, runOwnerVisit } from '../src/server/jobs/visit.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';

vi.mock('@ellai/core/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ellai/core/memory')>()),
  createMemoryClient: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;
const opened: Array<Awaited<ReturnType<typeof createDb>>> = [];

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  await handle.close();
  for (const extra of opened) await extra.close();
});

beforeEach(() => {
  vi.mocked(createMemoryClient).mockReset();
});

async function freshDb(): Promise<Database> {
  const extra = await createDb('pglite:memory');
  opened.push(extra);
  await migrate(extra.db);
  return extra.db;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const MASTER = hex(32);
const GAS = Ed25519Keypair.generate();
const NOW = new Date('2026-10-29T10:00:00Z');
const RECIPIENT = canonicalSuiAddress(`0x${'11'.repeat(32)}`);
const PRICE = 10_000n;
const GAP = LIMITS.ownerVisitPassGapMs;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);
const randomAddress = () => canonicalSuiAddress(`0x${hex(32)}`);
const noSleep = async (_ms: number) => undefined;

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

interface World {
  ownerId: string;
  agentId: string;
  suiAddress: string;
  purse: string;
}

async function world(on: Database = db, owner: Partial<typeof owners.$inferInsert> = {}): Promise<World> {
  const suiAddress = randomAddress();
  const purse = canonicalSuiAddress(derivePurseKeypair(MASTER, suiAddress).toSuiAddress());
  const row = one(await on.insert(owners).values({ suiAddress, purseAddress: purse, ...owner }).returning());
  const agent = one(await on.insert(agents).values({ ownerId: row.id, label: 'Test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_ab12' }).returning());
  return { ownerId: row.id, agentId: agent.id, suiAddress, purse };
}

async function decision(w: World, status: 'asked' | 'paid', createdAt: Date, on: Database = db): Promise<string> {
  const row = one(
    await on
      .insert(decisions)
      .values({
        ownerId: w.ownerId,
        agentId: w.agentId,
        requestKey: hex(16),
        sellerUrl: 'https://hotels.example/v1/rooms',
        sellerMethod: 'POST',
        sellerHost: 'hotels.example',
        bodyHash: hex(32),
        purpose: 'search hotels in Lisbon',
        recipient: RECIPIENT,
        amountAtomic: PRICE,
        asset: USDC_TYPE_MAINNET,
        network: 'sui:mainnet',
        expiresAt: new Date(createdAt.getTime() + 60_000),
        outcome: status === 'asked' ? 'asked' : 'approved',
        rule: status === 'asked' ? 'no_match' : 'learned',
        reason: 'test decision',
        status,
        createdAt,
      })
      .returning(),
  );
  if (status === 'asked') await on.insert(questions).values({ decisionId: row.id, ownerId: w.ownerId, createdAt });
  return row.id;
}

/** A signed payment still waiting on the chain. Valid until epoch 101 by default, and the stand-in chain is at 100. */
async function payment(w: World, overrides: Partial<typeof payments.$inferInsert> = {}, on: Database = db) {
  const decisionId = await decision(w, 'paid', ago(120_000), on);
  return one(
    await on
      .insert(payments)
      .values({ decisionId, ownerId: w.ownerId, purseAddress: w.purse, recipient: RECIPIENT, amountAtomic: PRICE, digest: hex(16), txBytesBase64: 'AA==', signedAt: ago(120_000), validUntilEpoch: 101n, ...overrides })
      .returning(),
  );
}

async function pendingMemory(w: World, sentence: string, on: Database = db): Promise<string> {
  const row = one(
    await on
      .insert(memories)
      .values({
        ownerId: w.ownerId,
        kind: 'owner_decision',
        recipient: RECIPIENT,
        amountAtomic: PRICE,
        verdict: 'approve',
        sellerHost: 'hotels.example',
        sentence,
        namespace: MEMORY_NAMESPACE,
        writerPublicKey: ownerDelegate(MASTER, w.suiAddress).publicKeyHex,
        status: 'pending',
        createdAt: ago(60_000),
      })
      .returning({ id: memories.id }),
  );
  return row.id;
}

/** A refill the chain has not seen, its window open until epoch 1_200. */
async function pendingRefill(w: World, sentAt: Date) {
  return one(
    await db
      .insert(refills)
      .values({ ownerId: w.ownerId, allowanceId: randomAddress(), amountAtomic: BigInt(LIMITS.purseRefillAtomic), digest: hex(32), sentAt, validUntilEpoch: 1_200n, status: 'pending' })
      .returning(),
  );
}

/** A memory Walrus Memory reported done with this blob id, not yet found on chain. */
async function confirmedMemory(w: World, blobId: string, confirmedAt: Date): Promise<string> {
  const row = one(
    await db
      .insert(memories)
      .values({
        ownerId: w.ownerId,
        kind: 'owner_decision',
        recipient: RECIPIENT,
        amountAtomic: PRICE,
        verdict: 'approve',
        sellerHost: 'hotels.example',
        sentence: `On 2026-10-29 the owner approved a hotel search ${blobId}.`,
        namespace: MEMORY_NAMESPACE,
        writerPublicKey: ownerDelegate(MASTER, w.suiAddress).publicKeyHex,
        blobId,
        status: 'confirmed',
        confirmedAt,
        createdAt: confirmedAt,
      })
      .returning({ id: memories.id }),
  );
  return row.id;
}

/** A clock that only `sleep` and the test move. */
function fakeClock(startMs: number) {
  const clock = {
    ms: startMs,
    now: () => new Date(clock.ms),
    sleep: async (ms: number) => {
      clock.ms += ms;
    },
  };
  return clock;
}

const memoryOf = async (id: string, on: Database = db) => one(await on.select({ status: memories.status, jobId: memories.jobId, blobId: memories.blobId }).from(memories).where(eq(memories.id, id)));
const ownerRow = async (w: World, on: Database = db) =>
  one(await on.select({ visitedAt: owners.lastTickedAt, leaseUntil: owners.visitLeaseUntil, refillNotBefore: owners.refillNotBefore }).from(owners).where(eq(owners.id, w.ownerId)));

interface Stub {
  chain: Chain;
  /** Every call in order, with its first argument when that is a string. */
  calls: string[];
  /** The Tatum scope each call ran in, in the same order. */
  scopes: Array<TatumScope | undefined>;
  /** USDC address balances by canonical address; any other address holds none. */
  balances: Map<string, bigint>;
}

type Answer = (...args: never[]) => unknown;

/** A chain that records every call; a method with no answer here fails after recording, so no call goes unseen. */
function stubChain(answers: Record<string, Answer> = {}): Stub {
  const calls: string[] = [];
  const scopes: Array<TatumScope | undefined> = [];
  const balances = new Map<string, bigint>();
  const table: Record<string, Answer> = {
    getCurrentEpoch: () => 100n,
    getBalances: (address: string) => ({ usdcAddressBalance: balances.get(canonicalSuiAddress(address)) ?? 0n, usdcCoinBalance: 0n, suiTotal: 0n }),
    getTransactionResult: () => {
      throw new ChainError('NOT_FOUND', 'not found (gRPC NOT_FOUND)');
    },
    getWalrusEpoch: () => 45,
    scanOwnedWalrusBlobs: () => ({ blobs: [], next: null }),
    ...answers,
  };
  const chain = new Proxy({} as Chain, {
    get(_target, property) {
      if (property === 'usesApiKey') return false;
      if (typeof property !== 'string' || property === 'then') return undefined;
      return async (...args: unknown[]) => {
        calls.push(typeof args[0] === 'string' ? `${property}:${args[0]}` : property);
        scopes.push(currentTatumScope());
        const answer = table[property];
        if (answer === undefined) throw new Error(`the stand-in chain has no answer for ${property}`);
        return (answer as (...given: unknown[]) => unknown)(...args);
      };
    },
  });
  return { chain, calls, scopes, balances };
}

type Method = (...args: never[]) => Promise<unknown>;

/** A stand-in relayer behind the mocked createMemoryClient. Unset methods fail the call. */
function relayer(methods: Partial<Record<'rememberBulk' | 'getRememberBulkStatus', Method>>) {
  const untouched = () => Promise.reject(new Error('relayer was called'));
  const mocks = {
    rememberBulk: vi.fn(methods.rememberBulk ?? untouched),
    getRememberBulkStatus: vi.fn(methods.getRememberBulkStatus ?? untouched),
    recall: vi.fn(untouched),
    destroy: vi.fn(),
  };
  vi.mocked(createMemoryClient).mockImplementation(() => ({ ...mocks }) as never);
  return mocks;
}

const accepted = async (items: unknown[]) => ({ job_ids: items.map(() => randomUUID()), total: items.length, status: 'running' });
const jobsAre = (state: 'running' | 'done') => async (ids: string[]) => ({
  results: ids.map((id) => (state === 'done' ? { job_id: id, status: 'done', blob_id: `blob-${id}` } : { job_id: id, status: 'running' })),
});

interface VisitOptions {
  trigger?: VisitTrigger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
}

function visit(on: Database, chain: Chain, w: World, options: VisitOptions = {}) {
  const now = options.now ?? (() => NOW);
  return runOwnerVisit({
    db: on,
    chain,
    masterSecretHex: MASTER,
    gasKeypair: GAS,
    now,
    sleep: options.sleep ?? noSleep,
    ownerId: w.ownerId,
    trigger: options.trigger ?? 'answer',
    deadlineMs: options.deadlineMs ?? now().getTime() + LIMITS.tickTimeBudgetMs,
  });
}

/**
 * `on`, except that the first release of a visit lease runs `before` first, so a test can act in
 * the moment after a visit's last check for waiting work and before its lease is free.
 */
function beforeFirstRelease(on: Database, before: () => Promise<void>): Database {
  let hook: (() => Promise<void>) | null = before;
  return new Proxy(on, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property !== 'update') return typeof value === 'function' ? value.bind(target) : value;
      return (table: typeof owners) => {
        const builder = target.update(table);
        if (table !== owners) return builder;
        return {
          set(values: Partial<typeof owners.$inferInsert>) {
            const query = builder.set(values);
            if (values.visitLeaseUntil !== null || hook === null) return query;
            const run = hook;
            hook = null;
            return { where: (condition: Parameters<typeof query.where>[0]) => run().then(() => query.where(condition)) };
          },
        };
      };
    },
  });
}

describe('runOwnerVisit', () => {
  it('lets exactly one of two visits started together for one owner work: the other does no step and calls neither the chain nor the relayer (C40)', async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Lisbon.');
    // Past its window, so every pass of a visit reads it.
    const lost = await payment(w, { validUntilEpoch: 99n });
    const client = relayer({ rememberBulk: accepted, getRememberBulkStatus: jobsAre('done') });
    const stubs = [stubChain(), stubChain()] as const;

    const results = await Promise.all(stubs.map((stub) => visit(db, stub.chain, w)));
    expect(results.map((result) => result.started).sort()).toEqual([false, true]);
    const winner = results[0]?.started === true ? 0 : 1;
    const [worked, idle] = [stubs[winner], stubs[1 - winner]];
    expect(results[winner]).toMatchObject({ passes: 1, summary: { memoriesSubmitted: 1, memoriesConfirmed: 1, errors: [] } });
    expect(results[1 - winner]).toEqual({ started: false, passes: 0, summary: emptySummary(null) });
    expect(idle?.calls).toEqual([]);
    expect(worked?.calls).toContain(`getTransactionResult:${lost.digest}`);
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
    expect(client.getRememberBulkStatus).toHaveBeenCalledTimes(1);
    expect((await ownerRow(w)).leaseUntil).toBeNull();
  });

  it('releases the lease after a pass whose step failed and after a visit that threw, and takes over a lease past its time', async () => {
    const funded = await world(db, { allowanceId: randomAddress() });
    let heldDuringPass: Date | null = null;
    const failing = stubChain({
      getBalances: async () => {
        heldDuringPass = (await ownerRow(funded)).leaseUntil;
        throw new ChainError('UPSTREAM', 'Tatum getBalances: gateway error', true);
      },
    });
    const failed = await visit(db, failing.chain, funded);
    expect(failed).toMatchObject({ started: true, passes: 1, summary: { errors: [{ ownerId: funded.ownerId, step: 'refill', code: 'CHAIN_UPSTREAM' }] } });
    expect(heldDuringPass).toEqual(later(LIMITS.ownerVisitLeaseMs));
    expect((await ownerRow(funded)).leaseUntil).toBeNull();

    const writing = await world(db, { memwalAccountId: randomAddress() });
    await pendingMemory(writing, 'On 2026-10-29 the owner approved a hotel search in Porto.');
    relayer({ rememberBulk: accepted, getRememberBulkStatus: jobsAre('running') });
    const sleepFails = async () => {
      throw new Error('stand-in sleep failed');
    };
    await expect(visit(db, stubChain().chain, writing, { sleep: sleepFails })).rejects.toThrow('stand-in sleep failed');
    expect((await ownerRow(writing)).leaseUntil).toBeNull();

    const left = await world(db);
    await payment(left);
    await db.update(owners).set({ visitLeaseUntil: later(1) }).where(eq(owners.id, left.ownerId));
    expect(await visit(db, stubChain().chain, left)).toMatchObject({ started: false, passes: 0 });
    // A function killed while holding it leaves the lease behind; at its end it is anyone's.
    await db.update(owners).set({ visitLeaseUntil: NOW }).where(eq(owners.id, left.ownerId));
    expect(await visit(db, stubChain().chain, left)).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    expect((await ownerRow(left)).leaseUntil).toBeNull();
  });

  it("sends an answered question's memory, confirms it on the next pass exactly LIMITS.ownerVisitPassGapMs later, and stops once nothing waits", async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    const asked = await decision(w, 'asked', ago(60_000));
    const delegatePublicKeyHex = ownerDelegate(MASTER, w.suiAddress).publicKeyHex;
    const { memoryId } = await answerQuestion({ db, ownerId: w.ownerId, decisionId: asked, answer: 'approve', reason: 'fine for hotel searches', delegatePublicKeyHex, namespace: MEMORY_NAMESPACE, now: NOW });
    let statusReads = 0;
    const client = relayer({
      rememberBulk: accepted,
      getRememberBulkStatus: async (ids: string[]) => jobsAre((statusReads += 1) === 1 ? 'running' : 'done')(ids),
    });
    let clockMs = NOW.getTime();
    const naps: number[] = [];
    const sleep = async (ms: number) => {
      naps.push(ms);
      clockMs += ms;
    };

    const result = await visit(db, stubChain().chain, w, { now: () => new Date(clockMs), sleep });
    expect(result).toMatchObject({ started: true, passes: 2, summary: { memoriesSubmitted: 1, memoriesConfirmed: 1, errors: [] } });
    expect(naps).toEqual([GAP]);
    const memory = await memoryOf(memoryId);
    expect(memory).toMatchObject({ status: 'confirmed', blobId: `blob-${memory.jobId}` });
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
    expect(client.getRememberBulkStatus).toHaveBeenCalledTimes(2);
    expect(await ownerRow(w)).toMatchObject({ visitedAt: later(GAP), leaseUntil: null });
  });

  it('starts no pass at or past deadlineMs, on a fake clock', async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Madrid.');
    relayer({ rememberBulk: accepted, getRememberBulkStatus: jobsAre('running') });
    const stub = stubChain();

    expect(await visit(db, stub.chain, w, { deadlineMs: NOW.getTime() })).toEqual({ started: false, passes: 0, summary: { ...emptySummary(null), timeBudgetReached: true } });
    expect(stub.calls).toEqual([]);
    expect(createMemoryClient).not.toHaveBeenCalled();
    expect(await ownerRow(w)).toMatchObject({ visitedAt: null, leaseUntil: null });

    // The sleep after the second pass ends exactly at the deadline, so there is no third.
    let clockMs = NOW.getTime();
    const naps: number[] = [];
    const sleep = async (ms: number) => {
      naps.push(ms);
      clockMs += ms;
    };
    const cut = await visit(db, stub.chain, w, { now: () => new Date(clockMs), sleep, deadlineMs: NOW.getTime() + 2 * GAP });
    expect(cut).toMatchObject({ started: true, passes: 2, summary: { memoriesSubmitted: 1, timeBudgetReached: true, errors: [] } });
    expect(naps).toEqual([GAP, GAP]);
    expect(await ownerRow(w)).toMatchObject({ visitedAt: later(GAP), leaseUntil: null });
  });

  it('still sends a memory recorded while the visit held the lease, once it lets the lease go, though that request\'s own visit found the lease taken', async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    const first = await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Faro.');
    const client = relayer({ rememberBulk: accepted, getRememberBulkStatus: jobsAre('done') });
    let racing: { memoryId: string; started: boolean } | null = null;
    // A second answer lands after the visit's last check for waiting work and before its release.
    const hooked = beforeFirstRelease(db, async () => {
      const memoryId = await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Braga.');
      const own = await visit(db, stubChain().chain, w);
      racing = { memoryId, started: own.started };
    });

    const result = await visit(hooked, stubChain().chain, w);
    expect(racing).toMatchObject({ started: false });
    const second = (racing as { memoryId: string } | null)?.memoryId ?? '';
    expect(result).toMatchObject({ started: true, passes: 2, summary: { memoriesSubmitted: 2, memoriesConfirmed: 2, errors: [] } });
    expect([(await memoryOf(first)).status, (await memoryOf(second)).status]).toEqual(['confirmed', 'confirmed']);
    expect(client.rememberBulk).toHaveBeenCalledTimes(2);
    expect((await ownerRow(w)).leaseUntil).toBeNull();
  });

  it('makes one pass for an owner with no Walrus Memory account, whose pending memory no pass can send, when other work brought the visit', async () => {
    const w = await world(db, { allowanceId: randomAddress() });
    const memoryId = await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Evora.');
    const stub = stubChain();
    stub.balances.set(w.purse, BigInt(LIMITS.purseRefillAtomic));

    expect(await visit(db, stub.chain, w)).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    expect(stub.calls.filter((call) => call === `getBalances:${w.purse}`)).toHaveLength(1);
    expect(createMemoryClient).not.toHaveBeenCalled();
    expect(await memoryOf(memoryId)).toMatchObject({ status: 'pending', jobId: null });
  });

  it('ends the visit after a pass whose memory submit failed and left the memory unsent, instead of meeting the relayer again at once', async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    const memoryId = await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Coimbra.');
    // A refused key makes the writer put submitted_at back, so the memory is free for any pass to send.
    const client = relayer({ rememberBulk: () => Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })) });

    expect(await visit(db, stubChain().chain, w)).toMatchObject({
      started: true,
      passes: 1,
      summary: { errors: [{ ownerId: w.ownerId, step: 'memory_submit', code: 'MEMORY_DELEGATE' }] },
    });
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
    const unsent = one(await db.select({ status: memories.status, jobId: memories.jobId, submittedAt: memories.submittedAt }).from(memories).where(eq(memories.id, memoryId)));
    expect(unsent).toEqual({ status: 'pending', jobId: null, submittedAt: null });
    expect((await ownerRow(w)).leaseUntil).toBeNull();
  });

  it('reads a purse above the refill threshold once across ten back-to-back visits, so visits cannot drain the refills pool (C28)', async () => {
    const w = await world(db, { allowanceId: randomAddress() });
    // A payment the seller is holding back keeps the owner's work going, so every visit starts.
    await payment(w);
    const stub = stubChain();
    stub.balances.set(w.purse, BigInt(LIMITS.purseRefillAtomic));

    const results = [];
    for (let i = 0; i < 10; i++) results.push(await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(i * 1_000) }));
    expect(results.map((result) => [result.started, result.passes, result.summary.errors])).toEqual(Array(10).fill([true, 1, []]));
    expect(stub.calls.filter((call) => call === `getBalances:${w.purse}`)).toHaveLength(1);
    expect(stub.scopes.filter((scope) => scope?.kind === 'refills')).toHaveLength(1);
    expect((await ownerRow(w)).refillNotBefore).toEqual(later(LIMITS.pendingPaymentReadIntervalMs));
  });

  it("charges every request of a visit to the owner's own share, its epoch reading included, so none lands on the shared jobs day alone (C22, C28, C40)", async () => {
    const w = await world();
    // A payment the seller is holding back, visited an hour apart: every visit reads it and a new epoch reading.
    await payment(w);
    const stub = stubChain();

    for (let i = 0; i < 10; i++) {
      expect(await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(i * LIMITS.pendingPaymentReadIntervalMs) })).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    }
    expect(stub.scopes.filter((scope) => scope?.kind === 'jobs' && scope.ownerId === undefined)).toHaveLength(0);
    expect(stub.scopes.filter((_, i) => stub.calls[i] === 'getCurrentEpoch')).toEqual(Array(10).fill({ kind: 'jobs', ownerId: w.ownerId }));
  });

  it('makes one pass and one digest read for a refill pending since long before the visit, and 32 visits across 40 minutes read it once, 2 refills-scope requests (C22, C23, C40)', async () => {
    const w = await world(db, { allowanceId: randomAddress() });
    const stuck = await pendingRefill(w, ago(3_600_000));
    const stub = stubChain({ getCurrentEpoch: () => 1_100n });
    const digestReads = () => stub.calls.filter((call) => call === `getTransactionResult:${stuck.digest}`).length;
    const refillsRequests = () => stub.scopes.filter((scope) => scope?.kind === 'refills').length;
    const clock = fakeClock(NOW.getTime());

    expect(await visit(db, stub.chain, w, { now: clock.now, sleep: clock.sleep })).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    expect(digestReads()).toBe(1);

    // 75 s apart, so the 32 visits fill 40 minutes; that read saw its window open, so the next waits an hour.
    for (let i = 1; i < 32; i++) {
      clock.ms = NOW.getTime() + i * 75_000;
      expect(await visit(db, stub.chain, w, { trigger: 'agent', now: clock.now, sleep: clock.sleep })).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    }
    expect([digestReads(), refillsRequests()]).toEqual([1, 2]);
  });

  it('holds the refill step off for LIMITS.refillErrorWaitMs after a chain read in it failed, so a visit within that wait asks the refills pool nothing (C22, C40)', async () => {
    const w = await world(db, { allowanceId: randomAddress() });
    // A payment the seller is holding back keeps the owner's work going while the refill is held off.
    await payment(w);
    const stub = stubChain({
      getBalances: () => {
        throw new ChainError('UPSTREAM', 'Tatum getBalances: gateway error', true);
      },
    });
    const refillsRequests = () => stub.scopes.filter((scope) => scope?.kind === 'refills').length;

    expect(await visit(db, stub.chain, w, { trigger: 'agent' })).toMatchObject({ started: true, passes: 1, summary: { errors: [{ ownerId: w.ownerId, step: 'refill', code: 'CHAIN_UPSTREAM' }] } });
    expect(await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(300_000) })).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    expect(refillsRequests()).toBe(1);
    expect((await ownerRow(w)).refillNotBefore).toEqual(later(LIMITS.refillErrorWaitMs));
  });

  it("keeps a closed-window payment pending through one visit's passes while Tatum fails, counting one failed read, and six reads 10 minutes apart still make it unverifiable (C8, C21, C22, C40)", async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    // A relayer job that stays running keeps the visit passing for as long as it may.
    await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Lagos.');
    relayer({ rememberBulk: accepted, getRememberBulkStatus: jobsAre('running') });
    const closed = await payment(w, { validUntilEpoch: 99n });
    const stub = stubChain({
      getTransactionResult: () => {
        throw new ChainError('UPSTREAM', 'Tatum getTransactionResult: gateway error', true);
      },
    });
    const settlement = async () =>
      one(await db.select({ settlement: payments.settlement, failedReads: payments.settlementFailedReads, reason: payments.mismatchReason }).from(payments).where(eq(payments.id, closed.id)));
    const clock = fakeClock(NOW.getTime());

    expect(await visit(db, stub.chain, w, { now: clock.now, sleep: clock.sleep })).toMatchObject({ started: true, passes: LIMITS.ownerVisitMaxPasses, summary: { paymentsMismatched: 0 } });
    expect(await settlement()).toEqual({ settlement: 'pending', failedReads: 1, reason: null });

    for (let i = 1; i <= 5; i++) {
      clock.ms = NOW.getTime() + i * 600_000;
      await visit(db, stub.chain, w, { trigger: 'agent', now: clock.now, sleep: clock.sleep });
      if (i < 5) expect(await settlement()).toEqual({ settlement: 'pending', failedReads: i + 1, reason: null });
    }
    expect(await settlement()).toEqual({ settlement: 'mismatch', failedReads: 6, reason: 'unverifiable' });
    expect(one(await db.select({ reason: owners.autoPausedReason }).from(owners).where(eq(owners.id, w.ownerId))).reason).toBe('settlement_unverifiable');
  });

  it('makes one epoch read across 10 visits within 10 minutes for an owner whose seller holds a payment back (C22, C40)', async () => {
    const w = await world();
    await payment(w);
    const stub = stubChain();

    for (let i = 0; i < 10; i++) {
      expect(await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(i * 60_000) })).toMatchObject({ started: true, passes: 1, summary: { errors: [] } });
    }
    expect(stub.calls.filter((call) => call === 'getCurrentEpoch')).toHaveLength(1);
  });

  it("scans the owner's Blob objects once across visits every minute for 30 minutes, and once more at once for a memory confirmed since that scan (C18, C22, C40)", async () => {
    const w = await world();
    await confirmedMemory(w, 'blob-waiting', ago(120_000));
    const stub = stubChain();
    const scans = () => stub.calls.filter((call) => call.startsWith('scanOwnedWalrusBlobs')).length;
    const scannedAt: number[] = [];

    for (let minute = 0; minute < 30; minute++) {
      if (minute === 10) await confirmedMemory(w, 'blob-newer', later(10 * 60_000));
      const before = scans();
      await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(minute * 60_000) });
      if (scans() > before) scannedAt.push(minute);
    }
    // The newer memory waits LIMITS.blobChainCheckMinAgeMs before it is looked for.
    expect(scannedAt).toEqual([0, 11]);
  });

  it('looks for a memory confirmed just before a scan that ran for other memories as soon as it is old enough to be looked for, not a spacing later (C18, C40)', async () => {
    const w = await world();
    await confirmedMemory(w, 'blob-older', ago(10 * 60_000));
    await confirmedMemory(w, 'blob-just-confirmed', NOW);
    const stub = stubChain();
    const scans = () => stub.calls.filter((call) => call.startsWith('scanOwnedWalrusBlobs')).length;

    // Thirty seconds on, the newer memory is too new to be looked for, so this scan is for the older one alone.
    expect(await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(30_000) })).toMatchObject({ started: true, passes: 1 });
    expect(scans()).toBe(1);
    expect(await visit(db, stub.chain, w, { trigger: 'agent', now: () => later(LIMITS.blobChainCheckMinAgeMs) })).toMatchObject({ started: true, passes: 1 });
    expect(scans()).toBe(2);
  });

  it('reads a refill stuck pending all day with its window open 2 x (12 fresh + 24 hourly) = 72 refills-scope requests at most, under the owner\'s refills share (C22, C23, C40)', { timeout: 120_000 }, async () => {
    // Reads while fresh are ownerVisitPassGapMs apart, then pendingPaymentReadIntervalMs apart while the window is open; each is the digest and the epoch.
    const bound = 2 * (Math.ceil(LIMITS.freshRefillWindowMs / LIMITS.ownerVisitPassGapMs) + Math.ceil(LIMITS.rateWindowDayMs / LIMITS.pendingPaymentReadIntervalMs));
    const w = await world(db, { allowanceId: randomAddress() });
    await pendingRefill(w, NOW);
    const stub = stubChain({ getCurrentEpoch: () => 1_100n });
    const clock = fakeClock(NOW.getTime());

    // Visits back to back while the refill is fresh, then one a minute: past the fresh window every
    // read waits at least ten minutes, so more visits than one a minute cannot add a read.
    while (clock.ms < NOW.getTime() + LIMITS.rateWindowDayMs) {
      await visit(db, stub.chain, w, { trigger: 'agent', now: clock.now, sleep: clock.sleep });
      clock.ms += clock.ms - NOW.getTime() < 2 * LIMITS.freshRefillWindowMs ? 2_000 : 60_000;
    }
    const refillsRequests = stub.scopes.filter((scope) => scope?.kind === 'refills').length;
    expect(refillsRequests).toBeLessThanOrEqual(bound);
    expect([bound, bound < LIMITS.tatumCallsRefillsPerOwnerPerDay]).toEqual([72, true]);
  });

  const DAY = LIMITS.rateWindowDayMs;
  const HOURLY = Math.ceil(DAY / LIMITS.pendingPaymentReadIntervalMs);
  // core's getWalrusEpoch reads the System object and then its version's dynamic field.
  const WALRUS_EPOCH_REQUESTS = 2;
  // A scan per spacing, and one more at once for the memory's confirmation; one page of Blob objects each.
  const SCANS = Math.ceil(DAY / LIMITS.blobScanSpacingMs) + 1;
  // The payment: a digest read and an epoch reading an hour. The memory: its scans and the Walrus
  // epoch, hourly when one process keeps the reading, or before every scan on fresh instances.
  const N_ONE_PROCESS = 2 * HOURLY + SCANS + WALRUS_EPOCH_REQUESTS * Math.ceil(DAY / LIMITS.walrusEpochCacheMs);
  const N_FRESH_INSTANCES = 2 * HOURLY + SCANS + WALRUS_EPOCH_REQUESTS * SCANS;
  // The refill: its send (balance, allowance, epoch, gas price, dry run, send, read back), reads
  // every pass gap while fresh, then hourly, each read the digest and the epoch. No cache is involved.
  const M = 7 + 2 * Math.ceil(LIMITS.freshRefillWindowMs / LIMITS.ownerVisitPassGapMs) + 2 * HOURLY;

  it('derives N, M and K for C34 from LIMITS, with the many-instance N under the jobs share', () => {
    const K = (n: number, pool: number) => Math.ceil(pool / n);
    expect({
      nOneProcess: N_ONE_PROCESS,
      kOneProcess: K(N_ONE_PROCESS, LIMITS.tatumCallsJobsPerDay),
      nFreshInstances: N_FRESH_INSTANCES,
      kFreshInstances: K(N_FRESH_INSTANCES, LIMITS.tatumCallsJobsPerDay),
      m: M,
      kRefills: K(M, LIMITS.tatumCallsRefillsPerDay),
    }).toEqual({ nOneProcess: 145, kOneProcess: 11, nFreshInstances: 195, kFreshInstances: 8, m: 79, kRefills: 7 });
    expect([N_FRESH_INSTANCES < LIMITS.tatumCallsJobsPerOwnerPerDay, M < LIMITS.tatumCallsRefillsPerOwnerPerDay]).toEqual([true, true]);
  });

  /**
   * A day of one owner's visits for one held-back payment, one stuck refill and one memory awaiting
   * its blob, through the real Tatum meter, with getWalrusEpoch charged its two requests. With
   * `freshProcess` every visit gets a chain client of its own, as a cold server instance would, so
   * neither the Walrus epoch reading nor the Sui epoch reading is kept between visits. Returns what
   * the meter charged the owner's jobs and refills shares, the error codes, and the payment's end.
   */
  // A simulated day is hundreds of visits against a real in-memory Postgres; on a slower machine that outlasts the 30 s default.
  const DAY_TEST_TIMEOUT_MS = 180_000;

  async function dayOfVisits(startIso: string, freshProcess: boolean) {
    // One UTC day, so the meter's daily counts cover exactly this run.
    const start = new Date(startIso).getTime();
    const w = await world(db, { allowanceId: randomAddress() });
    const held = await payment(w);
    await pendingRefill(w, new Date(start));
    await confirmedMemory(w, `blob-awaiting-all-day-${hex(4)}`, new Date(start - 120_000));
    let landed = false;
    const stub = stubChain({
      getTransactionResult: (digest: string) => {
        if (landed && digest === held.digest) {
          return { status: 'success', balanceChanges: [{ address: w.purse, coinType: USDC_TYPE_MAINNET, amount: -PRICE }, { address: RECIPIENT, coinType: USDC_TYPE_MAINNET, amount: PRICE }] };
        }
        throw new ChainError('NOT_FOUND', 'not found (gRPC NOT_FOUND)');
      },
    });
    const clock = fakeClock(start);
    const admit = tatumMeter(db, clock.now);
    const charged: Array<TatumScope | undefined> = [];
    const meteredClient = () =>
      new Proxy(stub.chain, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            const requests = property === 'getWalrusEpoch' ? WALRUS_EPOCH_REQUESTS : 1;
            for (let request = 0; request < requests; request++) {
              charged.push(currentTatumScope());
              try {
                await admit({ transport: 'graphql', method: String(property) });
              } catch {
                throw new ChainError('BUDGET', `${String(property)} refused by the request budget, nothing was sent`);
              }
            }
            return (value as (...given: unknown[]) => unknown)(...args);
          };
        },
      });
    const shared = meteredClient();

    const codes = new Set<string>();
    // LIMITS.agentCallsPerMinute paid calls a minute, each starting a visit, for the first ten
    // minutes, which hold the fresh refill's reads; after that every read waits at least ten
    // minutes on a stored time, so one visit a minute meets each as the cap would.
    const atCapMs = 60_000 / LIMITS.agentCallsPerMinute;
    while (clock.ms < start + DAY) {
      if (!landed && clock.ms >= start + DAY - 90 * 60_000) landed = true;
      const result = await visit(db, freshProcess ? meteredClient() : shared, w, { trigger: 'agent', now: clock.now, sleep: clock.sleep });
      for (const error of result.summary.errors) codes.add(error.code);
      clock.ms += clock.ms - start < 10 * 60_000 ? atCapMs : 60_000;
    }
    const share = (kind: TatumScope['kind']) => charged.filter((scope) => scope?.kind === kind && scope.ownerId === w.ownerId).length;
    const settled = one(await db.select({ settlement: payments.settlement }).from(payments).where(eq(payments.id, held.id))).settlement;
    return { jobs: share('jobs'), refills: share('refills'), codes: [...codes], settled };
  }

  it("keeps one owner's visits on one process for a day, at its agent's cap for the first ten minutes, inside N and M for one held-back payment, one stuck refill and one memory awaiting its blob, and the payment still settles (C22, C28, C34, C40)", async () => {
    const day = await dayOfVisits('2026-10-31T00:00:00Z', false);
    expect(day).toEqual({ jobs: 143, refills: 70, codes: [], settled: 'verified' });
    expect([day.jobs <= N_ONE_PROCESS, day.refills <= M]).toEqual([true, true]);
  }, DAY_TEST_TIMEOUT_MS);

  it('keeps the same day inside the many-instance N when every visit lands on a fresh server instance, which keeps no epoch reading, and under the jobs share (C22, C28, C34, C40)', async () => {
    const day = await dayOfVisits('2026-11-01T00:00:00Z', true);
    expect(day).toEqual({ jobs: 191, refills: 70, codes: [], settled: 'verified' });
    expect([day.jobs <= N_FRESH_INSTANCES, day.jobs < LIMITS.tatumCallsJobsPerOwnerPerDay, day.refills <= M]).toEqual([true, true, true]);
  }, DAY_TEST_TIMEOUT_MS);

  it('spaces the refused write attempts that fail a memory at LIMITS.closedWindowReadSpacingMs, so five take at least 40 minutes at request rate (C33, C40)', async () => {
    const w = await world(db, { memwalAccountId: randomAddress() });
    const memoryId = await pendingMemory(w, 'On 2026-10-29 the owner approved a hotel search in Tavira.');
    // A 400: the relayer refused what was sent, which spends one of LIMITS.memoryWriteMaxAttempts.
    const client = relayer({ rememberBulk: () => Promise.reject(Object.assign(new Error('bad request'), { status: 400 })) });
    const clock = fakeClock(NOW.getTime());

    let failedAtMs: number | null = null;
    while (failedAtMs === null && clock.ms < NOW.getTime() + 60 * 60_000) {
      await visit(db, stubChain().chain, w, { trigger: 'agent', now: clock.now, sleep: clock.sleep });
      if ((await memoryOf(memoryId)).status === 'failed') failedAtMs = clock.ms - NOW.getTime();
      clock.ms += 2_000;
    }
    expect(client.rememberBulk).toHaveBeenCalledTimes(LIMITS.memoryWriteMaxAttempts);
    expect(failedAtMs).toBeGreaterThanOrEqual(40 * 60_000);
  });

  it("starts nothing for 'overview' when the owner's last visit is newer than LIMITS.ownerVisitMinGapMs or the owner has no work", async () => {
    const recent = await world(db, { lastTickedAt: ago(LIMITS.ownerVisitMinGapMs - 1) });
    const due = await world(db, { lastTickedAt: ago(LIMITS.ownerVisitMinGapMs) });
    for (const w of [recent, due]) await payment(w);
    const idle = await world(db);
    const stub = stubChain();
    const overview = (w: World) => visit(db, stub.chain, w, { trigger: 'overview' });

    expect(await overview(recent)).toEqual({ started: false, passes: 0, summary: emptySummary(null) });
    expect(await overview(idle)).toEqual({ started: false, passes: 0, summary: emptySummary(null) });
    expect(stub.calls).toEqual([]);
    expect(await ownerRow(recent)).toMatchObject({ visitedAt: ago(LIMITS.ownerVisitMinGapMs - 1), leaseUntil: null });
    expect(await ownerRow(idle)).toMatchObject({ visitedAt: null, leaseUntil: null });
    // The gap is the overview's alone, and a last visit exactly that old no longer holds it back.
    expect(await overview(due)).toMatchObject({ started: true, passes: 1 });
    expect(await visit(db, stub.chain, recent, { trigger: 'answer' })).toMatchObject({ started: true, passes: 1 });
  });
});

describe('runJobsTick and the visit lease', () => {
  it('skips an owner whose lease another visit holds, neither counting nor stamping it, and still visits the others (C40)', async () => {
    const on = await freshDb();
    const held = await world(on);
    const free = await world(on);
    // Past their window, so a visit reads each one.
    const [heldPayment, freePayment] = [await payment(held, { validUntilEpoch: 99n }, on), await payment(free, { validUntilEpoch: 99n }, on)];
    const until = later(60_000);
    await on.update(owners).set({ visitLeaseUntil: until }).where(eq(owners.id, held.ownerId));
    const stub = stubChain();

    const summary = await runJobsTick({ db: on, chain: stub.chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => NOW, sleep: noSleep });
    expect(summary).toMatchObject({ owners: 1, errors: [] });
    expect([await ownerRow(held, on), await ownerRow(free, on)]).toMatchObject([
      { visitedAt: null, leaseUntil: until },
      { visitedAt: NOW, leaseUntil: null },
    ]);
    expect(stub.calls).toContain(`getTransactionResult:${freePayment.digest}`);
    expect(stub.calls).not.toContain(`getTransactionResult:${heldPayment.digest}`);
    const stillPending = await on.select({ id: payments.id }).from(payments).where(and(eq(payments.id, heldPayment.id), eq(payments.settlement, 'pending')));
    expect(stillPending).toHaveLength(1);
  });
});
