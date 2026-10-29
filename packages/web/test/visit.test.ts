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
// refill threshold once (C28); the tick skips an owner whose lease is held; and 'overview' starts
// nothing within LIMITS.ownerVisitMinGapMs of the last visit or for an owner with no work.
// Does NOT cover: the real Sui chain, Tatum or the relayer (npm run prove:visit sends a memory
// live), two database connections racing on the lease (PGlite serves one connection, so the
// single UPDATE that takes it is not raced here), or what Next does with the scheduled task
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
import { agents, decisions, memories, owners, payments, questions } from '../src/server/db/schema.js';
import { answerQuestion } from '../src/server/decide/answer.js';
import { type TatumScope, currentTatumScope } from '../src/server/http/tatum-meter.js';
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
