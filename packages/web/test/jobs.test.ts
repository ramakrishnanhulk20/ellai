// Covers: the jobs tick on PGlite with a stand-in chain and a stand-in relayer. expireDecisions
// closes every owner's stale open decisions and old unanswered questions in one bounded call,
// oldest first, and nothing fresher. refillIfNeeded
// refills a low purse once, signed by the purse and the gas wallet, with its row written before
// the send and a dry run that must move exactly the refill before it; never while a refill is
// pending, nor in the call that finds one landed, past the daily count, past the float, or on a
// balance read that its own ledger contradicts; never from an allowance that is not this
// owner's, for this purse, in USDC, unexpired and with room under its cap and in its rate
// window; never signs bytes that are not exactly the refill; keeps an unknown send pending and
// reads that digest first next time, but marks one the Tatum budget kept from leaving failed;
// releases a lost refill only once its epoch window has closed and a call
// LIMITS.paymentReleaseGapMs after the first that saw it missing misses it too, recording one a
// later call finds, and leaves rows from before that window was kept
// waiting; asks its own ledger first, so across a day of ticks an owner whose ledger rules a
// refill out costs no chain read, the onboarded owner's first refill included, and one below
// it whose purse reads at or above the threshold costs one purse read an hour, 24 a day at most,
// and an allowance read only for the refill it sends; forgets an
// allowance that can never pay again and waits out a full rate window, reading nothing meanwhile.
// pruneExpiredRows deletes only dead rows, in batches it repeats until each table comes
// back short or its time slice ends, faster than the sign-in cap lets strangers add them,
// day-old owners nothing points at included, 3,001 of them inside the time slice behind
// 200,000 owners in use, expired step-ups before them while an owner holding an unexpired one is
// kept, decisions closed without a payment past their keep time with their citations, grant uses
// and questions, never one a payment, a memory or a grant names, and old rate counters first,
// before the tick does any owner's work.
// confirmBlobsOnChain marks a memory only when its blob id is on one of the owner's own Walrus Blob
// objects, certified and not past its end epoch by the Walrus epoch (read once an hour), reading
// in stretches from a stored cursor, kept through a Tatum budget refusal, a rejected key or a
// failure that can clear and dropped only when the listing cannot be used, matching every
// waiting memory and keeping the latest end
// epoch, filling that end in for memories found before it was kept and hiding one on no Blob of
// the owner only after reading the whole listing in one call;
// expireBlobsOnChain marks one expired once the Walrus epoch reaches that end, a bounded
// number per call, and the tick reads that epoch only while a memory is stored on chain.
// refillIfNeeded defers before any read past the deadline and
// never after its row. runJobsTick isolates each owner's and each step's failure behind a fixed code,
// settles pending payments with one digest read a pass and remembers a paid seller stored as
// delivering nothing exactly once (never one whose delivery is unknown) with one epoch reading for
// every settlement pass in a tick, reads a payment whose window is open at most once per
// LIMITS.pendingPaymentReadIntervalMs and one whose window has closed every tick, releases a lost
// payment only on a second pass
// LIMITS.paymentReleaseGapMs after the first, records an outcome a paid call failed to record,
// expires decisions for every owner without visiting one whose only work they are, fails aged
// pending memories of owners it never visits, runs an owner's money steps before its memory steps,
// charges each visit's chain reads to that owner's jobs scope and the shared reads to the jobs scope
// alone, refills from a Tatum pool of their own once payments spent the jobs day and every owner's
// share, refills with the tick's own sleep, sends and confirms memories and then checks them
// on chain, prunes, reads the gas wallet once an hour however many ticks run and warns when it is
// low, takes at most LIMITS.jobsOwnersPerTick owners,
// least recently visited first, stamped as each visit starts, and past its deadline starts no
// owner and no external call, with the deadline's arithmetic worked out from LIMITS.
// Does NOT cover: the real Sui chain, Tatum or the relayer (scripts/prove-jobs.ts does those
// live), whether Sui accepts the refill bytes (packages/proof's prove-pay sent one live, after a
// dry run of the same shape), two connections racing on the owner lock (PGlite serves one
// connection), or what schedules the tick.
import { randomBytes, randomUUID } from 'node:crypto';
import type { AllowanceReading, Balances, Chain, ExecutionResult, ScannedWalrusBlob, SimulationResult, TransactionResult } from '@ellai/core/chain';
import { ChainError } from '@ellai/core/chain';
import { AllowanceError, buildRefill } from '@ellai/core/allowance';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { createMemoryClient } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { SUI_TYPE_ARG, normalizeStructTag } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { and, count, eq, isNull, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import {
  agents,
  decisionCitations,
  decisions,
  grantUses,
  grants,
  memories,
  owners,
  payments,
  questions,
  rateCounters,
  refills,
  sellerSales,
  sessions,
  signinNonces,
  stepUps,
} from '../src/server/db/schema.js';
import { type TatumScope, currentTatumScope, tatumMeter, withTatumScope } from '../src/server/http/tatum-meter.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { recordOutcome } from '../src/server/memory/outcome.js';
import { confirmBlobsOnChain, expireBlobsOnChain } from '../src/server/jobs/blobs.js';
import { expireDecisions } from '../src/server/jobs/expire.js';
import { pruneExpiredRows } from '../src/server/jobs/prune.js';
import { RefillError, refillIfNeeded } from '../src/server/jobs/refill.js';
import { type JobsTickSummary, runJobsTick } from '../src/server/jobs/tick.js';
import { onboardingState } from '../src/server/onboarding/state.js';
import { settlePayment } from '../src/server/pay/settle.js';

vi.mock('@ellai/core/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ellai/core/memory')>()),
  createMemoryClient: vi.fn(),
}));

// The real build by default; one test makes it return bytes that are not the refill.
vi.mock('@ellai/core/allowance', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ellai/core/allowance')>();
  return { ...original, buildRefill: vi.fn(original.buildRefill) };
});

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

/** A database of its own, for a tick that must see only the owners its test made. */
async function freshDb(): Promise<Database> {
  const extra = await createDb('pglite:memory');
  opened.push(extra);
  await migrate(extra.db);
  return extra.db;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const MASTER = hex(32);
const NOW = new Date('2026-10-24T10:00:00Z');
const RECIPIENT = canonicalSuiAddress(`0x${'11'.repeat(32)}`);
const PRICE = 10_000n;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

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
  const suiAddress = canonicalSuiAddress(`0x${hex(32)}`);
  const purse = canonicalSuiAddress(derivePurseKeypair(MASTER, suiAddress).toSuiAddress());
  const row = one(await on.insert(owners).values({ suiAddress, purseAddress: purse, ...owner }).returning());
  const agent = one(
    await on.insert(agents).values({ ownerId: row.id, label: 'Test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_ab12' }).returning(),
  );
  return { ownerId: row.id, agentId: agent.id, suiAddress, purse: row.purseAddress };
}

async function decision(w: World, status: (typeof decisions.$inferInsert)['status'], createdAt: Date, on: Database = db): Promise<string> {
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

async function payment(w: World, decisionId: string, overrides: Partial<typeof payments.$inferInsert> = {}, on: Database = db) {
  return one(
    await on
      .insert(payments)
      .values({
        decisionId,
        ownerId: w.ownerId,
        purseAddress: w.purse,
        recipient: RECIPIENT,
        amountAtomic: PRICE,
        digest: hex(16),
        txBytesBase64: 'AA==',
        signedAt: NOW,
        validUntilEpoch: 101n,
        ...overrides,
      })
      .returning(),
  );
}

const statusOf = async (id: string, on: Database = db) => one(await on.select({ status: decisions.status }).from(decisions).where(eq(decisions.id, id))).status;

const GAS = Ed25519Keypair.generate();
const GAS_ADDRESS = canonicalSuiAddress(GAS.toSuiAddress());
const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);
const REFILL = BigInt(LIMITS.purseRefillAtomic);
const LOW = BigInt(LIMITS.purseRefillBelowAtomic) - 1n;
const randomAddress = () => canonicalSuiAddress(`0x${hex(32)}`);
// A base58 string of digest length, so a stored refill row looks like one Ellai wrote.
const randomDigest = () => TransactionDataBuilder.getDigestFromBytes(randomBytes(64));

interface Funded extends World {
  allowanceId: string;
}

async function funded(on: Database = db, owner: Partial<typeof owners.$inferInsert> = {}): Promise<Funded> {
  const allowanceId = randomAddress();
  return { ...(await world(on, { allowanceId, ...owner })), allowanceId };
}

function allowanceFor(w: Funded, overrides: Partial<AllowanceReading> = {}): AllowanceReading {
  return {
    funder: w.suiAddress,
    spender: w.purse,
    coinType: USDC_TYPE_MAINNET,
    lifetimeCap: 1_000_000n,
    spentTotal: 0n,
    periodMs: 86_400_000n,
    periodLimit: 500_000n,
    expirationMs: BigInt(NOW.getTime() + 30 * 86_400_000),
    initialSharedVersion: 7n,
    periodSpent: 0n,
    periodEndMs: null,
    ...overrides,
  };
}

function refillChanges(w: World, amount = REFILL) {
  return [
    { address: w.suiAddress, coinType: USDC_TYPE_MAINNET, amount: -amount },
    { address: w.purse, coinType: USDC_TYPE_MAINNET, amount },
    { address: GAS_ADDRESS, coinType: SUI_TYPE, amount: -2_000_000n },
  ];
}

interface StubState {
  /** Balances by canonical address; an address not here reads as empty. */
  balances: Map<string, Partial<Balances>>;
  /** Allowances by id; an id not here, or an Error, throws. */
  allowances: Map<string, AllowanceReading | Error>;
  /** What a successful send moves. */
  changes: TransactionResult['balanceChanges'];
  /** The dry run's verdict on these bytes. By default, a success that moves `changes`. */
  simulate: (digest: string) => SimulationResult;
  execute: (digest: string) => ExecutionResult | Promise<ExecutionResult>;
  /** What the chain has for a digest, or null for NOT_FOUND. By default, whatever was sent. */
  landed: (digest: string) => TransactionResult | null;
  /** The epoch the chain reports now. */
  epoch: bigint;
  /** Walrus Blob objects by canonical owner address, in listing order; an address not here holds none. */
  blobs: Map<string, ScannedWalrusBlob[]>;
  /** The epoch Walrus reports now, counted as Walrus counts, not as Sui does. */
  walrusEpoch: number;
}

/**
 * A chain that answers from `state`, which a test may change between calls. Every call is
 * logged in order; the send also logs whether the refill row with that digest was already
 * committed when the bytes went out.
 */
function stubChain(on: Database = db) {
  const sent = new Set<string>();
  const state: StubState = {
    balances: new Map(),
    allowances: new Map(),
    changes: [],
    simulate: () => ({ status: 'success', errorCode: null, balanceChanges: state.changes }),
    execute: (digest) => {
      sent.add(digest);
      return { digest, status: 'success', errorCode: null, balanceChanges: state.changes, createdObjects: [] };
    },
    landed: (digest) => (sent.has(digest) ? { status: 'success', balanceChanges: state.changes } : null),
    epoch: 100n,
    blobs: new Map(),
    walrusEpoch: 45,
  };
  const calls: string[] = [];
  const executions: Array<{ txBytes: Uint8Array; signatures: string[]; rowWritten: boolean }> = [];
  const chain = {
    usesApiKey: false,
    getCurrentEpoch: async () => {
      calls.push('getCurrentEpoch');
      return state.epoch;
    },
    getReferenceGasPrice: async () => {
      calls.push('getReferenceGasPrice');
      return 100n;
    },
    getBalances: async (address: string) => {
      calls.push(`getBalances:${address}`);
      return { usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiTotal: 0n, ...state.balances.get(canonicalSuiAddress(address)) };
    },
    getAllowance: async (id: string) => {
      calls.push(`getAllowance:${id}`);
      const allowance = state.allowances.get(id) ?? new ChainError('NOT_FOUND', 'not found');
      if (allowance instanceof Error) throw allowance;
      return allowance;
    },
    // gRPC's view of the same allowances: gone exactly when getAllowance would answer NOT_FOUND.
    objectExists: async (id: string) => {
      calls.push(`objectExists:${id}`);
      const allowance = state.allowances.get(id);
      return allowance !== undefined && !(allowance instanceof ChainError && allowance.code === 'NOT_FOUND');
    },
    getTransactionResult: async (digest: string) => {
      calls.push(`getTransactionResult:${digest}`);
      const result = state.landed(digest);
      if (result === null) throw new ChainError('NOT_FOUND', 'not found (gRPC NOT_FOUND)');
      return result;
    },
    simulate: async (txBytes: Uint8Array) => {
      const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
      calls.push(`simulate:${digest}`);
      return state.simulate(digest);
    },
    getWalrusEpoch: async () => {
      calls.push('getWalrusEpoch');
      return state.walrusEpoch;
    },
    // Pages of LIMITS.graphqlPageSize, each cursor naming the page after it, as Tatum's do.
    scanOwnedWalrusBlobs: async (address: string, { after, maxPages }: { after: string | null; maxPages: number }) => {
      calls.push(`scanOwnedWalrusBlobs:${address}:${after ?? 'start'}`);
      const all = state.blobs.get(canonicalSuiAddress(address)) ?? [];
      const from = after === null ? 0 : Number(after.slice('page-'.length)) * LIMITS.graphqlPageSize;
      const to = Math.min(all.length, from + maxPages * LIMITS.graphqlPageSize);
      return { blobs: all.slice(from, to), next: to < all.length ? `page-${to / LIMITS.graphqlPageSize}` : null };
    },
    executeTransaction: async (txBytes: Uint8Array, signatures: string[]) => {
      const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
      calls.push(`executeTransaction:${digest}`);
      const [row] = await on.select({ id: refills.id }).from(refills).where(eq(refills.digest, digest));
      executions.push({ txBytes, signatures, rowWritten: row !== undefined });
      return state.execute(digest);
    },
  } as unknown as Chain;
  return { chain, state, calls, executions };
}

/** A chain on which `w`'s purse holds `purseUsdc` and `w`'s allowance is exactly as issued. */
function stubFor(w: Funded, purseUsdc: bigint, on: Database = db) {
  const stub = stubChain(on);
  stub.state.balances.set(w.purse, { usdcAddressBalance: purseUsdc });
  stub.state.allowances.set(w.allowanceId, allowanceFor(w));
  stub.state.changes = refillChanges(w);
  return stub;
}

const noNap = async (_ms: number) => undefined;
const refill = (w: World, chain: Chain, now: Date = NOW, on: Database = db, sleep: (ms: number) => Promise<void> = noNap) =>
  refillIfNeeded({ db: on, chain, ownerId: w.ownerId, masterSecretHex: MASTER, gasKeypair: GAS, now, sleep });
const sendTimesOut = () => {
  throw new ChainError('TIMEOUT', 'Tatum executeTransaction: timed out; the transaction may have landed', true);
};
const refillRows = (ownerId: string, on: Database = db) => on.select().from(refills).where(eq(refills.ownerId, ownerId));
const allowanceOf = async (w: World, on: Database = db) =>
  one(
    await on
      .select({ allowanceId: owners.allowanceId, allowanceCheckedAt: owners.allowanceCheckedAt, refillNotBefore: owners.refillNotBefore })
      .from(owners)
      .where(eq(owners.id, w.ownerId)),
  );
const FORGOTTEN = { allowanceId: null, allowanceCheckedAt: null, refillNotBefore: null };

async function refillRow(w: Funded, sentAt: Date, status: 'pending' | 'verified' | 'failed', on: Database = db) {
  return one(await on.insert(refills).values({ ownerId: w.ownerId, allowanceId: w.allowanceId, amountAtomic: REFILL, digest: randomDigest(), sentAt, status }).returning());
}

/** Raises one limit for the length of `run`, so a branch today's numbers never reach can be driven. */
async function withLimit(name: keyof typeof LIMITS, value: number, run: () => Promise<void>): Promise<void> {
  const limits = LIMITS as unknown as Record<string, number>;
  const before = limits[name];
  limits[name] = value;
  try {
    await run();
  } finally {
    if (before !== undefined) limits[name] = before;
  }
}

describe('expireDecisions', () => {
  it("expires every owner's stale open decisions with no payment and old unanswered questions in one call, and nothing fresher", async () => {
    const on = await freshDb();
    const w = await world(on);
    const staleOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    const freshOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs), on);
    const signedOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    await payment(w, signedOpen, {}, on);
    const oldAsked = await decision(w, 'asked', ago(LIMITS.questionTtlMs + 1), on);
    const freshAsked = await decision(w, 'asked', ago(LIMITS.questionTtlMs), on);
    const answered = await decision(w, 'asked', ago(LIMITS.questionTtlMs + 1), on);
    await on.update(questions).set({ answer: 'refuse', answeredAt: ago(1) }).where(eq(questions.decisionId, answered));
    const oldPaid = await decision(w, 'paid', ago(LIMITS.questionTtlMs * 2), on);
    const other = await world(on);
    const othersStale = await decision(other, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    const othersAsked = await decision(other, 'asked', ago(LIMITS.questionTtlMs + 1), on);

    expect(await expireDecisions({ db: on, now: NOW })).toEqual({ decisionsExpired: 2, questionsClosed: 2 });
    for (const [id, status] of [
      [staleOpen, 'expired'],
      [oldAsked, 'expired'],
      [othersStale, 'expired'],
      [othersAsked, 'expired'],
      [freshOpen, 'open'],
      [signedOpen, 'open'],
      [freshAsked, 'asked'],
      [answered, 'asked'],
      [oldPaid, 'paid'],
    ] as const) {
      expect(await statusOf(id, on)).toBe(status);
    }
    expect(await expireDecisions({ db: on, now: NOW })).toEqual({ decisionsExpired: 0, questionsClosed: 0 });
    await expect(expireDecisions({ db: on, now: new Date(Number.NaN) })).rejects.toThrow('the current time is not a date');
  });

  it('expires at most LIMITS.pruneBatch decisions in one call, oldest first, and the rest in the next', async () => {
    const on = await freshDb();
    const w = await world(on);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1_000 * (3 - i)), on));
    await withLimit('pruneBatch', 2, async () => {
      expect(await expireDecisions({ db: on, now: NOW })).toEqual({ decisionsExpired: 2, questionsClosed: 0 });
      expect(await Promise.all(ids.map((id) => statusOf(id, on)))).toEqual(['expired', 'expired', 'open']);
      expect(await expireDecisions({ db: on, now: NOW })).toEqual({ decisionsExpired: 1, questionsClosed: 0 });
    });
  });
});

describe('refillIfNeeded', () => {
  it('refills a low purse once: checked, signed by the purse and the gas wallet, its row written before the send, then verified', async () => {
    const w = await funded();
    const { chain, state, calls, executions } = stubFor(w, LOW);
    expect(await refill(w, chain)).toBe('refilled');

    const row = one(await refillRows(w.ownerId));
    expect(row).toMatchObject({ allowanceId: w.allowanceId, amountAtomic: REFILL, sentAt: NOW, status: 'verified', verifiedAt: NOW });
    expect(calls).toEqual([
      `getBalances:${w.purse}`,
      `getAllowance:${w.allowanceId}`,
      'getCurrentEpoch',
      'getReferenceGasPrice',
      `simulate:${row.digest}`,
      `executeTransaction:${row.digest}`,
      `getTransactionResult:${row.digest}`,
    ]);
    const [sent, ...more] = executions;
    expect(more).toHaveLength(0);
    expect(sent?.rowWritten).toBe(true);
    const txBytes = sent?.txBytes ?? new Uint8Array();
    expect(TransactionDataBuilder.getDigestFromBytes(txBytes)).toBe(row.digest);
    const v1 = bcs.TransactionData.parse(txBytes).V1;
    expect([canonicalSuiAddress(v1?.sender ?? ''), canonicalSuiAddress(v1?.gasData.owner ?? '')]).toEqual([w.purse, GAS_ADDRESS]);
    const [purseSignature, gasSignature] = sent?.signatures ?? [];
    expect((await verifyTransactionSignature(txBytes, purseSignature ?? '', { address: w.purse })).toSuiAddress()).toBe(w.purse);
    expect((await verifyTransactionSignature(txBytes, gasSignature ?? '', { address: GAS_ADDRESS })).toSuiAddress()).toBe(GAS_ADDRESS);

    state.balances.set(w.purse, { usdcAddressBalance: LOW + REFILL });
    expect(await refill(w, chain)).toBe('not_needed');
    expect(executions).toHaveLength(1);
  });

  it('never refills while an earlier refill is pending, and reads that digest before anything else', async () => {
    const w = await funded();
    const pending = await refillRow(w, ago(60_000), 'pending');
    const { chain, calls, executions } = stubFor(w, 0n);
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(calls).toEqual([`getTransactionResult:${pending.digest}`]);
    expect(executions).toHaveLength(0);
    expect(await refillRows(w.ownerId)).toHaveLength(1);
  });

  it('never refills past the daily count, counting every refill sent in the last 24 hours whatever its status', async () => {
    const w = await funded();
    const oldest = await refillRow(w, ago(86_400_000 - 1), 'verified');
    await refillRow(w, ago(3_600_000), 'failed');
    await refillRow(w, ago(60_000), 'verified');
    // Payments spent what the two verified refills brought, so only the count stands in the way.
    await payment(w, await decision(w, 'paid', ago(30_000)), { amountAtomic: 2n * REFILL });
    expect(LIMITS.purseMaxRefillsPerDay).toBe(3);
    const { chain, calls, executions } = stubFor(w, 0n);
    expect(await refill(w, chain)).toBe('not_needed');
    expect(calls).not.toContain('getCurrentEpoch');
    expect(executions).toHaveLength(0);

    await db.update(refills).set({ sentAt: ago(86_400_000 + 1) }).where(eq(refills.id, oldest.id));
    expect(await refill(w, chain)).toBe('refilled');
    expect(executions).toHaveLength(1);
  });

  it('never refills at or above the threshold, or past the float', async () => {
    const w = await funded();
    const { chain, state, executions } = stubFor(w, BigInt(LIMITS.purseRefillBelowAtomic));
    expect(await refill(w, chain)).toBe('not_needed');

    // Today's threshold keeps every refill under the float on its own, so the threshold is
    // raised to reach the float check through the job.
    const float = BigInt(LIMITS.purseMaxFloatAtomic);
    await withLimit('purseRefillBelowAtomic', LIMITS.purseMaxFloatAtomic, async () => {
      state.balances.set(w.purse, { usdcAddressBalance: float - REFILL + 1n });
      expect(await refill(w, chain)).toBe('not_needed');
      expect(executions).toHaveLength(0);
      state.balances.set(w.purse, { usdcAddressBalance: float - REFILL });
      expect(await refill(w, chain)).toBe('refilled');
    });
    expect(executions).toHaveLength(1);
  });

  it("refuses, building and sending nothing, an allowance that is not this owner's, for this purse, in USDC, unexpired and with room, and records why (C22)", async () => {
    const windowEnd = NOW.getTime() + 3_600_000;
    const never: Array<Partial<AllowanceReading> | Error> = [
      { funder: randomAddress() },
      { spender: randomAddress() },
      { coinType: SUI_TYPE },
      { expirationMs: BigInt(NOW.getTime()) },
      { spentTotal: 1_000_000n - REFILL + 1n },
      // A rate limit smaller than one refill has no room in any window.
      { periodLimit: REFILL - 1n },
      // The full window ends as the allowance expires, so no later window can pay either.
      { periodSpent: 500_000n, periodEndMs: BigInt(windowEnd), expirationMs: BigInt(windowEnd) },
      new ChainError('NOT_FOUND', 'not found'),
    ];
    const waits: Array<[Partial<AllowanceReading>, Date]> = [
      // The current rate window, still open, has less left than one refill.
      [{ periodSpent: 500_000n - REFILL + 1n, periodEndMs: BigInt(windowEnd) }, new Date(windowEnd)],
      // A rate limit whose window cannot be placed counts as full for one whole period.
      [{ periodSpent: null }, new Date(NOW.getTime() + 86_400_000)],
    ];
    const refuse = async (variant: Partial<AllowanceReading> | Error) => {
      const w = await funded(db, { allowanceCheckedAt: ago(60_000) });
      const { chain, state, calls, executions } = stubFor(w, 0n);
      state.allowances.set(w.allowanceId, variant instanceof Error ? variant : allowanceFor(w, variant));
      expect(await refill(w, chain)).toBe('refused');
      // The allowance is read only once the balance says a refill will be sent, and a NOT_FOUND is checked through gRPC before it is forgotten.
      const missing = variant instanceof ChainError && variant.code === 'NOT_FOUND';
      expect(calls).toEqual([`getBalances:${w.purse}`, `getAllowance:${w.allowanceId}`, ...(missing ? [`objectExists:${w.allowanceId}`] : [])]);
      expect(executions).toHaveLength(0);
      expect(await refillRows(w.ownerId)).toHaveLength(0);
      return { w, recorded: await allowanceOf(w) };
    };
    for (const variant of never) expect((await refuse(variant)).recorded).toEqual(FORGOTTEN);
    for (const [variant, end] of waits) {
      const { w, recorded } = await refuse(variant);
      expect(recorded).toEqual({ allowanceId: w.allowanceId, allowanceCheckedAt: ago(60_000), refillNotBefore: end });
    }

    // An allowance the owner replaced while the old one was being read is kept.
    const replaced = await funded();
    const stub = stubFor(replaced, 0n);
    const newer = randomAddress();
    const replacing = {
      ...stub.chain,
      getAllowance: async () => {
        await db.update(owners).set({ allowanceId: newer }).where(eq(owners.id, replaced.ownerId));
        return allowanceFor(replaced, { expirationMs: BigInt(NOW.getTime()) });
      },
    } as Chain;
    expect(await refill(replaced, replacing)).toBe('refused');
    expect((await allowanceOf(replaced)).allowanceId).toBe(newer);

    const moved = await funded(db, { purseAddress: randomAddress() });
    const { chain, calls } = stubFor(moved, 0n);
    expect(await refill(moved, chain)).toBe('refused');
    expect(calls).toEqual([]);
    expect((await allowanceOf(moved)).allowanceId).toBe(moved.allowanceId);
    expect(await refill(await world(), chain)).toBe('refused');
  });

  it('refills when the open rate window has exactly one refill left, or a full window has ended, since the next spend opens a new one', async () => {
    for (const variant of [
      { periodSpent: 500_000n - REFILL, periodEndMs: BigInt(NOW.getTime() + 1) },
      { periodSpent: 500_000n, periodEndMs: BigInt(NOW.getTime()) },
    ]) {
      const w = await funded();
      const { chain, state, executions } = stubFor(w, 0n);
      state.allowances.set(w.allowanceId, allowanceFor(w, variant));
      expect(await refill(w, chain)).toBe('refilled');
      expect(executions).toHaveLength(1);
    }
  });

  it('stops at the float when the balance read keeps saying the purse is empty, because it decides on its own ledger too', async () => {
    // The review's reproduction: a missing balance entry reads as 0. Deciding on that read
    // alone refilled three times in a day, 0.30 USDC, into a purse whose float is 0.20.
    const w = await funded();
    const { chain, executions } = stubFor(w, 0n);
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const float = BigInt(LIMITS.purseMaxFloatAtomic);
    const verifiedIn = async () => (await refillRows(w.ownerId)).filter((row) => row.status === 'verified').reduce((sum, row) => sum + row.amountAtomic, 0n);

    const outcomes: string[] = [];
    for (let minute = 0; minute < 4; minute++) outcomes.push(await refill(w, chain, at(minute)));
    expect(outcomes).toEqual(['refilled', 'not_needed', 'not_needed', 'not_needed']);

    // A signed payment counts as gone until it is released, which takes the ledger below the
    // threshold, so one more refill goes. Even if that payment never lands, the purse holds
    // no more than the float.
    const spent = REFILL - LOW;
    const signed = await payment(w, await decision(w, 'paid', NOW), { amountAtomic: spent });
    expect(await refill(w, chain, at(4))).toBe('refilled');
    expect(await refill(w, chain, at(5))).toBe('not_needed');
    expect(executions).toHaveLength(2);
    const inflow = await verifiedIn();
    expect(inflow).toBe(2n * REFILL);
    expect(inflow <= float).toBe(true);

    await db.update(payments).set({ settlement: 'not_landed', releasedAt: at(6) }).where(eq(payments.id, signed.id));
    expect(await refill(w, chain, at(7))).toBe('not_needed');
    expect(executions).toHaveLength(2);
  });

  it('sends nothing, and marks the row failed, when the dry run fails, moves anything but the refill, or gives no verdict', async () => {
    const verdicts: Array<(w: World) => SimulationResult> = [
      () => ({ status: 'failure', errorCode: 'MOVE_ABORT', balanceChanges: [] }),
      (w) => ({ status: 'success', errorCode: null, balanceChanges: [...refillChanges(w), { address: randomAddress(), coinType: USDC_TYPE_MAINNET, amount: 1n }] }),
    ];
    for (const verdict of verdicts) {
      const w = await funded();
      const { chain, state, calls, executions } = stubFor(w, 0n);
      state.simulate = () => verdict(w);
      await expect(refill(w, chain)).rejects.toEqual(new RefillError('DRY_RUN_FAILED', 'the refill dry run did not move exactly the refill, so nothing was sent'));
      const row = one(await refillRows(w.ownerId));
      expect(row.status).toBe('failed');
      expect(calls).toContain(`simulate:${row.digest}`);
      expect(calls.filter((call) => call.startsWith('executeTransaction'))).toEqual([]);
      expect(executions).toHaveLength(0);
    }

    const w = await funded();
    const { chain, state, executions } = stubFor(w, 0n);
    state.simulate = () => {
      throw new ChainError('TIMEOUT', 'Tatum simulate: timed out', true);
    };
    await expect(refill(w, chain)).rejects.toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    expect(one(await refillRows(w.ownerId)).status).toBe('failed');
    expect(executions).toHaveLength(0);
  });

  it('keeps an unknown send outcome pending; the next call reads that digest first and, finding it landed, refills nothing more', async () => {
    const w = await funded();
    const { chain, state, calls, executions } = stubFor(w, 0n);
    state.execute = () => {
      throw new ChainError('TIMEOUT', 'Tatum executeTransaction: timed out; the transaction may have landed', true);
    };
    await expect(refill(w, chain)).rejects.toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    const row = one(await refillRows(w.ownerId));
    expect(row.status).toBe('pending');

    calls.length = 0;
    state.landed = (digest) => (digest === row.digest ? { status: 'success', balanceChanges: refillChanges(w) } : null);
    // The purse still reads empty, as a lagging node would show it right after the refill landed.
    expect(await refill(w, chain)).toBe('resolved_pending');
    expect(calls).toEqual([`getTransactionResult:${row.digest}`]);
    expect(one(await refillRows(w.ownerId))).toMatchObject({ status: 'verified', verifiedAt: NOW });
    expect(executions).toHaveLength(1);
  });

  it("marks a refill failed, never pending, when core reports its send never left because Ellai's Tatum budget refused it, so the next call reads no digest first", async () => {
    const w = await funded();
    const { chain, state, calls, executions } = stubFor(w, 0n);
    const send = state.execute;
    state.execute = () => {
      throw new ChainError('BUDGET', 'Tatum executeTransaction: the request budget refused the send; transaction was not sent');
    };
    await expect(refill(w, chain)).rejects.toMatchObject({ name: 'ChainError', code: 'BUDGET' });
    const unsent = one(await refillRows(w.ownerId));
    expect(unsent.status).toBe('failed');
    expect(executions).toHaveLength(1);

    calls.length = 0;
    state.execute = send;
    expect(await refill(w, chain)).toBe('refilled');
    expect(calls[0]).toBe(`getBalances:${w.purse}`);
    expect(calls).not.toContain(`getTransactionResult:${unsent.digest}`);
    expect((await refillRows(w.ownerId)).map((row) => row.status).sort()).toEqual(['failed', 'verified']);
  });

  it('signs, records and sends nothing when the built bytes are not exactly the refill', async () => {
    const w = await funded();
    const { chain, executions } = stubFor(w, 0n);
    const original = (await vi.importActual<typeof import('@ellai/core/allowance')>('@ellai/core/allowance')).buildRefill;
    vi.mocked(buildRefill).mockImplementationOnce((args, facts) => original({ ...args, amountAtomic: args.amountAtomic - 1n }, facts));
    const refused = await refill(w, chain).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AllowanceError);
    expect((refused as AllowanceError).code).toBe('MISMATCH');
    expect(executions).toHaveLength(0);
    expect(await refillRows(w.ownerId)).toHaveLength(0);
  });

  it('marks a refill the chain failed as failed, and keeps one that moved anything else pending and refused', async () => {
    const w = await funded();
    const { chain, state } = stubFor(w, 0n);
    state.execute = (digest) => ({ digest, status: 'failure', errorCode: 'INSUFFICIENT_ADDRESS_BALANCE', balanceChanges: [], createdObjects: [] });
    await expect(refill(w, chain)).rejects.toEqual(new RefillError('FAILED', 'the refill did not land'));
    expect(one(await refillRows(w.ownerId)).status).toBe('failed');

    const odd = await funded();
    const stub = stubFor(odd, 0n);
    // The dry run showed exactly the refill; what landed did not.
    stub.state.simulate = () => ({ status: 'success', errorCode: null, balanceChanges: refillChanges(odd) });
    stub.state.changes = [...refillChanges(odd), { address: randomAddress(), coinType: USDC_TYPE_MAINNET, amount: 1n }];
    await expect(refill(odd, stub.chain)).rejects.toMatchObject({ name: 'RefillError', code: 'MISMATCH' });
    expect(one(await refillRows(odd.ownerId)).status).toBe('pending');
    await expect(refill(odd, stub.chain)).rejects.toMatchObject({ code: 'MISMATCH' });
    expect(stub.executions).toHaveLength(1);
  });

  it('fails a lost refill only once its epoch window has closed and a call LIMITS.paymentReleaseGapMs after the first that saw it closed misses it too, and may then refill', async () => {
    const w = await funded();
    const { chain, state, calls, executions } = stubFor(w, 0n);
    const send = state.execute;
    state.execute = sendTimesOut;
    await expect(refill(w, chain)).rejects.toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    const lost = one(await refillRows(w.ownerId));
    const expiration = bcs.TransactionData.parse(executions[0]?.txBytes ?? new Uint8Array()).V1?.expiration;
    const signedMaxEpoch = expiration?.$kind === 'ValidDuring' ? expiration.ValidDuring.maxEpoch : undefined;
    expect([lost.status, lost.validUntilEpoch, signedMaxEpoch]).toEqual(['pending', 101n, '101']);
    const readLost = `getTransactionResult:${lost.digest}`;
    const lostRow = async () => one((await refillRows(w.ownerId)).filter((row) => row.id === lost.id));

    // The window is still open: nothing is marked.
    state.execute = send;
    state.epoch = 101n;
    calls.length = 0;
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(calls).toEqual([readLost, 'getCurrentEpoch']);
    expect(await lostRow()).toMatchObject({ status: 'pending', missingSince: null });

    // The first call that sees the window closed and the digest missing only marks it.
    state.epoch = 102n;
    calls.length = 0;
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(calls).toEqual([readLost, 'getCurrentEpoch']);
    expect(await lostRow()).toMatchObject({ status: 'pending', missingSince: NOW });

    // A miss sooner than LIMITS.paymentReleaseGapMs after that changes nothing.
    expect(await refill(w, chain, new Date(NOW.getTime() + LIMITS.paymentReleaseGapMs - 1))).toBe('skipped_pending');
    expect(await lostRow()).toMatchObject({ status: 'pending', missingSince: NOW });
    expect(executions).toHaveLength(1);

    calls.length = 0;
    expect(await refill(w, chain, new Date(NOW.getTime() + LIMITS.paymentReleaseGapMs))).toBe('refilled');
    expect(calls.slice(0, 2)).toEqual([readLost, 'getCurrentEpoch']);
    expect(calls.filter((call) => call === readLost)).toHaveLength(1);
    const rows = await refillRows(w.ownerId);
    expect(rows.map((row) => [row.digest === lost.digest, row.status, row.validUntilEpoch]).sort()).toEqual([
      [false, 'verified', 103n],
      [true, 'failed', 101n],
    ]);
    expect(executions).toHaveLength(2);
  });

  it('records a lost refill that a later call finds, instead of failing it', async () => {
    const w = await funded();
    const { chain, state } = stubFor(w, 0n);
    state.execute = sendTimesOut;
    await expect(refill(w, chain)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const lost = one(await refillRows(w.ownerId));

    state.epoch = 102n;
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(one(await refillRows(w.ownerId))).toMatchObject({ id: lost.id, status: 'pending', missingSince: NOW });

    // The node the first call asked was behind: by the second call the chain shows it.
    const later = new Date(NOW.getTime() + LIMITS.paymentReleaseGapMs);
    state.landed = (digest) => (digest === lost.digest ? { status: 'success', balanceChanges: refillChanges(w) } : null);
    state.balances.set(w.purse, { usdcAddressBalance: REFILL });
    expect(await refill(w, chain, later)).toBe('resolved_pending');
    expect(one(await refillRows(w.ownerId))).toMatchObject({ id: lost.id, status: 'verified', verifiedAt: later });
  });

  it("answers 'deferred' with nothing written or sent when canStart says no before any read it needs, and never stops once its row is written", async () => {
    // One question before each of: the purse balance, the allowance, the epoch, the gas price, and the row.
    const gates = 5;
    for (let yes = 0; yes < gates; yes++) {
      const w = await funded();
      const { chain, calls, executions } = stubFor(w, LOW);
      let left = yes;
      expect(await refillIfNeeded({ db, chain, ownerId: w.ownerId, masterSecretHex: MASTER, gasKeypair: GAS, now: NOW, sleep: noNap, canStart: () => left-- > 0 })).toBe('deferred');
      expect(calls).toHaveLength(yes);
      expect(executions).toHaveLength(0);
      expect(await refillRows(w.ownerId)).toHaveLength(0);
    }
    const w = await funded();
    const { chain, calls } = stubFor(w, LOW);
    let left = gates;
    expect(await refillIfNeeded({ db, chain, ownerId: w.ownerId, masterSecretHex: MASTER, gasKeypair: GAS, now: NOW, sleep: noNap, canStart: () => left-- > 0 })).toBe('refilled');
    expect(calls.map((call) => call.split(':')[0])).toEqual([
      'getBalances',
      'getAllowance',
      'getCurrentEpoch',
      'getReferenceGasPrice',
      'simulate',
      'executeTransaction',
      'getTransactionResult',
    ]);
    expect(one(await refillRows(w.ownerId)).status).toBe('verified');

    // A refill still pending from an earlier call is not even read once the deadline has passed.
    const lost = await funded();
    await refillRow(lost, ago(60_000), 'pending');
    const stub = stubFor(lost, 0n);
    expect(await refillIfNeeded({ db, chain: stub.chain, ownerId: lost.ownerId, masterSecretHex: MASTER, gasKeypair: GAS, now: NOW, sleep: noNap, canStart: () => false })).toBe('deferred');
    expect(stub.calls).toEqual([]);
  });

  it('keeps a pending refill written before valid_until_epoch was kept waiting, however late the epoch', async () => {
    const w = await funded();
    const old = await refillRow(w, ago(7 * 86_400_000), 'pending');
    expect(old.validUntilEpoch).toBeNull();
    const { chain, state, calls, executions } = stubFor(w, 0n);
    state.epoch = 1_000_000n;
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(calls).toEqual([`getTransactionResult:${old.digest}`]);
    expect(executions).toHaveLength(0);
    expect(one(await refillRows(w.ownerId)).status).toBe('pending');
  });

  // The jobs workflow ticks every 10 minutes, so 144 ticks are a day.
  const TICK_MS = 600_000;
  const ticker = (on: Database, chain: Chain) => (n: number) =>
    runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + n * TICK_MS), sleep: noNap });
  const notGas = (calls: string[]) => calls.filter((call) => call !== `getBalances:${GAS_ADDRESS}`);

  it("refills an owner just onboarded on the first tick, and with that refill 'verified' in its ledger reads nothing from chain for it across the next 144 ticks (C22, C23)", { timeout: 120_000 }, async () => {
    const on = await freshDb();
    const w = await funded(on, { allowanceCheckedAt: NOW });
    const { chain, calls } = stubFor(w, 0n, on);
    const tickAt = ticker(on, chain);
    expect(await tickAt(0)).toMatchObject({ owners: 1, refills: 1, errors: [] });
    expect(one(await refillRows(w.ownerId, on))).toMatchObject({ amountAtomic: REFILL, status: 'verified' });

    calls.length = 0;
    for (let n = 1; n <= 144; n++) expect(await tickAt(n)).toMatchObject({ owners: 1, refills: 0, errors: [] });
    // The purse still reads empty on chain, so any read would have shown up here; the ledger alone answered.
    expect(notGas(calls)).toEqual([]);
  });

  it('reads a purse holding more than its ledger once, then nothing until LIMITS.pendingPaymentReadIntervalMs later, and the allowance only for the refill it sends (C22, C23)', async () => {
    expect(LIMITS.pendingPaymentReadIntervalMs).toBe(6 * TICK_MS);
    const on = await freshDb();
    const w = await funded(on, { allowanceCheckedAt: NOW });
    // 0.06 USDC the owner sent the purse straight from their wallet: on chain, not in the ledger.
    const { chain, state, calls } = stubFor(w, BigInt(LIMITS.purseRefillBelowAtomic) + 10_000n, on);
    const tickAt = ticker(on, chain);
    expect(await tickAt(0)).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([`getBalances:${w.purse}`]);
    expect((await allowanceOf(w, on)).refillNotBefore).toEqual(new Date(NOW.getTime() + LIMITS.pendingPaymentReadIntervalMs));

    // The purse runs low meanwhile; the owner waits out the hour before the next read finds it.
    state.balances.set(w.purse, { usdcAddressBalance: LOW });
    for (let n = 1; n < 6; n++) expect(await tickAt(n)).toMatchObject({ owners: 0, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([`getBalances:${w.purse}`]);

    calls.length = 0;
    expect(await tickAt(6)).toMatchObject({ owners: 1, refills: 1, errors: [] });
    expect(notGas(calls).filter((call) => /^get(Balances|Allowance):/.test(call))).toEqual([`getBalances:${w.purse}`, `getAllowance:${w.allowanceId}`]);
    calls.length = 0;
    expect(await tickAt(7)).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([]);
  });

  it('reads a purse holding more than its ledger at most 24 times across a day of 144 ticks (C22)', { timeout: 120_000 }, async () => {
    const on = await freshDb();
    const w = await funded(on, { allowanceCheckedAt: NOW });
    // Exactly at the threshold, which is no refill.
    const { chain, calls } = stubFor(w, BigInt(LIMITS.purseRefillBelowAtomic), on);
    const tickAt = ticker(on, chain);
    const readOn: number[] = [];
    for (let n = 0; n < 144; n++) {
      const before = notGas(calls).length;
      expect(await tickAt(n)).toMatchObject({ refills: 0, errors: [] });
      if (notGas(calls).length > before) readOn.push(n);
    }
    expect(notGas(calls)).toEqual(Array<string>(24).fill(`getBalances:${w.purse}`));
    expect(readOn).toEqual(Array.from({ length: 24 }, (_, i) => 6 * i));
  });

  it('reads an expired allowance once with a ledger at 0, forgets it, and reads nothing for that owner on the next three ticks (C22)', async () => {
    const on = await freshDb();
    const w = await funded(on, { allowanceCheckedAt: NOW });
    const { chain, state, calls } = stubFor(w, 0n, on);
    state.allowances.set(w.allowanceId, allowanceFor(w, { expirationMs: BigInt(NOW.getTime() - 1) }));
    const tickAt = ticker(on, chain);
    expect(await tickAt(0)).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([`getBalances:${w.purse}`, `getAllowance:${w.allowanceId}`]);
    expect(await allowanceOf(w, on)).toEqual(FORGOTTEN);
    expect((await onboardingState({ db: on, ownerId: w.ownerId })).allowance).toBe('missing');

    calls.length = 0;
    for (let n = 1; n <= 3; n++) expect(await tickAt(n)).toMatchObject({ owners: 0, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([]);
  });

  it('asks the chain nothing about a full rate window until it ends, then reads it again and refills (C22)', async () => {
    const on = await freshDb();
    const w = await funded(on, { allowanceCheckedAt: NOW });
    const { chain, state, calls } = stubFor(w, 0n, on);
    const windowEnd = new Date(NOW.getTime() + 2.5 * TICK_MS);
    state.allowances.set(w.allowanceId, allowanceFor(w, { periodSpent: 500_000n, periodEndMs: BigInt(windowEnd.getTime()) }));
    const tickAt = ticker(on, chain);
    expect(await tickAt(0)).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([`getBalances:${w.purse}`, `getAllowance:${w.allowanceId}`]);
    expect(await allowanceOf(w, on)).toEqual({ allowanceId: w.allowanceId, allowanceCheckedAt: NOW, refillNotBefore: windowEnd });

    calls.length = 0;
    for (const n of [1, 2]) expect(await tickAt(n)).toMatchObject({ owners: 0, refills: 0, errors: [] });
    expect(notGas(calls)).toEqual([]);
    // Past the window's end the next spend opens a new window, so the same reading now has room.
    expect(await tickAt(3)).toMatchObject({ owners: 1, refills: 1, errors: [] });
    expect(notGas(calls).filter((call) => /^get(Balances|Allowance):/.test(call))).toEqual([`getBalances:${w.purse}`, `getAllowance:${w.allowanceId}`]);
  });
});

describe('pruneExpiredRows', () => {
  const DAY = 86_400_000;
  const nonce = (on: Database, expiresAt: Date, usedAt: Date | null = null) => on.insert(signinNonces).values({ nonce: hex(16), createdAt: ago(DAY * 2), expiresAt, usedAt });
  const sale = (on: Database, expiresAt: Date, values: Partial<typeof sellerSales.$inferInsert> = {}) =>
    on.insert(sellerSales).values({ challengeId: hex(16), amountAtomic: PRICE, recipient: RECIPIENT, issuedAt: ago(DAY * 2), expiresAt, ...values });
  const session = (on: Database, w: World, expiresAt: Date, revokedAt: Date | null = null) =>
    on.insert(sessions).values({ ownerId: w.ownerId, tokenHash: hex(32), createdAt: ago(DAY * 8), expiresAt, revokedAt });
  const kept = async (on: Database) => ({
    signinNonces: (await on.select().from(signinNonces)).length,
    sellerSales: (await on.select().from(sellerSales)).length,
    sessions: (await on.select().from(sessions)).length,
  });
  /** A per-client rate counter whose window started a minute or more past the retention. */
  const oldCounter = (on: Database, i: number) =>
    on.insert(rateCounters).values({ key: `http:old-${i}`, windowStart: ago(LIMITS.rateCounterRetentionMs + 60_000 * (i + 1)), count: 1 });
  const oldCounters = async (on: Database) => (await on.select().from(rateCounters).where(like(rateCounters.key, 'http:old-%'))).length;

  it('deletes only rows that can never be used again: expired nonces, expired sales never sent, rejected sales long expired and sessions expired over a day ago', async () => {
    const on = await freshDb();
    const w = await world(on);
    await nonce(on, ago(1));
    await nonce(on, ago(1), ago(DAY));
    const liveNonce = hex(16);
    await on.insert(signinNonces).values({ nonce: liveNonce, createdAt: NOW, expiresAt: new Date(NOW.getTime() + 1) });
    await sale(on, ago(1));
    await sale(on, new Date(NOW.getTime() + 1));
    await sale(on, ago(DAY), { status: 'settled' });
    // Refused, or turned away by a cap on sends, before its bytes were recorded: gone once expired, kept until then.
    await sale(on, ago(DAY), { status: 'rejected' });
    await sale(on, new Date(NOW.getTime() + 1), { status: 'rejected' });
    // An issued sale holding a digest may have been paid, so it is never pruned as unpaid.
    await sale(on, ago(DAY), { digest: randomDigest() });
    // Waiting on the chain: kept for its buyer until LIMITS.sellerWaitingSaleKeepMs past its expiry.
    await sale(on, ago(LIMITS.sellerWaitingSaleKeepMs + 1), { status: 'rejected', digest: randomDigest() });
    await sale(on, ago(LIMITS.sellerWaitingSaleKeepMs), { status: 'rejected', digest: randomDigest() });
    // Closed for good: kept as long as a waiting one, then deleted.
    await sale(on, ago(LIMITS.sellerWaitingSaleKeepMs + 1), { status: 'rejected', digest: randomDigest(), settledAt: ago(DAY) });
    await sale(on, ago(LIMITS.sellerWaitingSaleKeepMs), { status: 'rejected', settledAt: ago(DAY) });
    await session(on, w, ago(DAY + 1));
    // Revoked long ago but not yet expired: it goes when it expires, found through expires_at.
    await session(on, w, new Date(NOW.getTime() + DAY), ago(DAY + 1));
    await session(on, w, ago(DAY - 1));
    await session(on, w, new Date(NOW.getTime() + DAY), ago(DAY - 1));
    await session(on, w, new Date(NOW.getTime() + DAY));

    expect(await pruneExpiredRows({ db: on, now: NOW })).toEqual({ rateCounters: 0, signinNonces: 2, stepUps: 0, sellerSales: 4, sessions: 1, decisions: 0, owners: 0 });
    expect(await kept(on)).toEqual({ signinNonces: 1, sellerSales: 6, sessions: 4 });
    expect((await on.select({ nonce: signinNonces.nonce }).from(signinNonces)).map((row) => row.nonce)).toEqual([liveNonce]);
    expect(await pruneExpiredRows({ db: on, now: NOW })).toEqual({ rateCounters: 0, signinNonces: 0, stepUps: 0, sellerSales: 0, sessions: 0, decisions: 0, owners: 0 });
  });

  it('clears more expired nonces and empty owners in one call than the global sign-in cap lets strangers create between two ticks', async () => {
    // The jobs workflow ticks every 10 minutes (.github/workflows/jobs-tick.yml).
    const created = LIMITS.signInRequestsPerMinuteGlobal * 10 + 1;
    expect(created).toBe(3_001);
    expect(created).toBeGreaterThan(LIMITS.pruneBatch * 3);
    const on = await freshDb();
    await on
      .insert(signinNonces)
      .values(Array.from({ length: created }, (_, i) => ({ nonce: hex(16), createdAt: ago(DAY), expiresAt: ago(1 + i) })));
    // Every verified sign-in can leave an owner row behind once its session has ended.
    await on.insert(owners).values(Array.from({ length: created }, () => ({ suiAddress: randomAddress(), purseAddress: randomAddress(), createdAt: dayOld() })));
    expect(await pruneExpiredRows({ db: on, now: NOW, clock: () => NOW })).toEqual({ rateCounters: 0, signinNonces: created, stepUps: 0, sellerSales: 0, sessions: 0, decisions: 0, owners: created });
    expect(await kept(on)).toEqual({ signinNonces: 0, sellerSales: 0, sessions: 0 });
    expect(await ownerIds(on)).toEqual([]);
  });

  it('runs one batch per rule, repeats a full one only inside LIMITS.pruneTimeSliceMs, and the tick repeats on its own clock', async () => {
    const on = await freshDb();
    const w = await world(on);
    for (let i = 0; i < 5; i++) {
      await nonce(on, ago(DAY + i));
      await sale(on, ago(DAY + i));
      await session(on, w, ago(2 * DAY + i));
      await oldCounter(on, i);
    }
    let reads = 0;
    // Every read of this clock is one whole time slice later than the one before.
    const slow = () => new Date(NOW.getTime() + reads++ * LIMITS.pruneTimeSliceMs);
    await withLimit('pruneBatch', 3, async () => {
      expect(await pruneExpiredRows({ db: on, now: NOW, clock: slow })).toEqual({ rateCounters: 3, signinNonces: 3, stepUps: 0, sellerSales: 3, sessions: 3, decisions: 0, owners: 0 });
      expect(await kept(on)).toEqual({ signinNonces: 2, sellerSales: 2, sessions: 2 });
      expect(await oldCounters(on)).toBe(2);
      const { chain } = stubChain(on);
      expect(await tick(on, chain)).toMatchObject({ rowsPruned: 8, errors: [] });
    });
    expect(await kept(on)).toEqual({ signinNonces: 0, sellerSales: 0, sessions: 0 });
    expect(await oldCounters(on)).toBe(0);
  });

  it('prunes old rate counters in the tick before the gas wallet read and any owner work, keeping every count still inside its window (C34)', async () => {
    const on = await freshDb();
    const w = await funded(on, { allowanceCheckedAt: NOW });
    for (let i = 0; i < 3; i++) await oldCounter(on, i);
    const atRetention = { key: 'http:at-retention', windowStart: ago(LIMITS.rateCounterRetentionMs), count: 4 };
    await on.insert(rateCounters).values(atRetention);
    const stub = stubFor(w, 0n, on);
    const seen: number[] = [];
    const chain = {
      ...stub.chain,
      getBalances: async (address: string) => {
        seen.push(await oldCounters(on));
        return stub.chain.getBalances(address);
      },
    } as Chain;
    expect(await tick(on, chain)).toMatchObject({ owners: 1, refills: 1, rowsPruned: 3, errors: [] });
    // The gas wallet read and then the owner's purse read: both found the old counters gone.
    expect(seen).toEqual([0, 0]);
    expect(await on.select().from(rateCounters).where(eq(rateCounters.key, atRetention.key))).toEqual([atRetention]);
  });

  const dayOld = () => ago(LIMITS.emptyOwnerKeepMs + 1);
  /** An owner row as sign-in leaves it, with no agent. */
  async function bareOwner(on: Database, values: Partial<typeof owners.$inferInsert> = {}): Promise<World> {
    const suiAddress = randomAddress();
    const row = one(await on.insert(owners).values({ suiAddress, purseAddress: randomAddress(), createdAt: dayOld(), ...values }).returning());
    return { ownerId: row.id, agentId: '', suiAddress, purse: row.purseAddress };
  }
  const ownerIds = async (on: Database) => (await on.select({ id: owners.id }).from(owners)).map((row) => row.id).sort();
  const sessionsOf = async (on: Database, w: World) => (await on.select().from(sessions).where(eq(sessions.ownerId, w.ownerId))).length;

  it('deletes a day-old owner nothing ever used, with its ended sessions, and keeps every owner something still points at', async () => {
    const on = await freshDb();
    const empty = await bareOwner(on);
    await session(on, empty, ago(1));
    await session(on, empty, new Date(NOW.getTime() + DAY), ago(60_000));
    const kept: World[] = [await bareOwner(on, { createdAt: ago(LIMITS.emptyOwnerKeepMs) })];
    kept.push(await bareOwner(on, { allowanceId: randomAddress() }));
    kept.push(await bareOwner(on, { memwalAccountId: randomAddress() }));
    kept.push(await bareOwner(on, { delegateRegisteredAt: ago(DAY) }));
    const withAgent = await world(on, { createdAt: dayOld() });
    const withDecision = await world(on, { createdAt: dayOld() });
    await decision(withDecision, 'expired', ago(DAY), on);
    const withPayment = await world(on, { createdAt: dayOld() });
    await payment(withPayment, await decision(withPayment, 'paid', ago(DAY), on), {}, on);
    const withMemory = await bareOwner(on);
    await pendingMemory(withMemory, 'On 2026-10-23 the owner approved a hotel search.', ago(DAY), on);
    const signedIn = await bareOwner(on);
    await session(on, signedIn, new Date(NOW.getTime() + 1));
    await session(on, signedIn, ago(1));
    // Refilled once, then its allowance was forgotten: the refill row still names it.
    const withRefill = await bareOwner(on);
    await on.insert(refills).values({ ownerId: withRefill.ownerId, allowanceId: randomAddress(), amountAtomic: REFILL, digest: randomDigest(), sentAt: ago(DAY), status: 'verified' });
    kept.push(withAgent, withDecision, withPayment, withMemory, signedIn, withRefill);

    expect(await pruneExpiredRows({ db: on, now: NOW })).toEqual({ rateCounters: 0, signinNonces: 0, stepUps: 0, sellerSales: 0, sessions: 2, decisions: 0, owners: 1 });
    expect(await ownerIds(on)).toEqual(kept.map((w) => w.ownerId).sort());
    expect([await sessionsOf(on, empty), await sessionsOf(on, signedIn)]).toEqual([0, 2]);
    expect(await pruneExpiredRows({ db: on, now: NOW })).toMatchObject({ owners: 0 });
  });

  it('deletes expired step-ups, used or not, before empty owners, and keeps an empty owner while it holds an unexpired one', async () => {
    const on = await freshDb();
    const stepUp = (w: World, expiresAt: Date, usedAt: Date | null = null) =>
      on.insert(stepUps).values({ nonce: hex(16), ownerId: w.ownerId, action: 'create_agent', changeHash: hex(32), message: 'Confirm', createdAt: ago(DAY), expiresAt, usedAt });
    await bareOwner(on);
    const expired = await bareOwner(on);
    await stepUp(expired, ago(1));
    await stepUp(expired, ago(1), ago(2));
    // Signed out within the step-up's five minutes: no live session, but an unexpired step-up.
    const holding = await bareOwner(on);
    await stepUp(holding, new Date(NOW.getTime() + 1));

    expect(await pruneExpiredRows({ db: on, now: NOW })).toEqual({ rateCounters: 0, signinNonces: 0, stepUps: 2, sellerSales: 0, sessions: 0, decisions: 0, owners: 2 });
    expect(await ownerIds(on)).toEqual([holding.ownerId]);
    expect(await pruneExpiredRows({ db: on, now: new Date(NOW.getTime() + 2) })).toMatchObject({ stepUps: 1, owners: 1 });
    expect(await ownerIds(on)).toEqual([]);
    expect(await on.select().from(stepUps)).toEqual([]);
  });

  it('deletes decisions closed without a payment over LIMITS.closedDecisionKeepMs ago with their citations, grant uses and questions, and keeps any a payment, a memory or a grant names (C34)', async () => {
    const on = await freshDb();
    const w = await world(on);
    const old = ago(LIMITS.closedDecisionKeepMs + 1);
    const closed = async (status: 'refused' | 'expired' | 'failed', createdAt = old) => {
      const id = await decision(w, status === 'expired' ? 'asked' : status, createdAt, on);
      if (status === 'expired') await on.update(decisions).set({ status }).where(eq(decisions.id, id));
      return id;
    };
    const memoryNaming = async (decisionId: string | null) =>
      one(
        await on
          .insert(memories)
          .values({
            ownerId: w.ownerId,
            kind: 'outcome',
            decisionId,
            sentence: `On 2026-09-01 a paid seller delivered nothing ${hex(4)}.`,
            namespace: MEMORY_NAMESPACE,
            writerPublicKey: ownerDelegate(MASTER, w.suiAddress).publicKeyHex,
            status: 'confirmed',
            createdAt: old,
          })
          .returning({ id: memories.id }),
      ).id;
    const grantFor = async (decisionId: string) =>
      one(
        await on
          .insert(grants)
          .values({ ownerId: w.ownerId, decisionId, recipient: RECIPIENT, maxAmountAtomic: PRICE, sellerUrl: 'https://hotels.example/v1/rooms', sellerMethod: 'POST', bodyHash: hex(32), expiresAt: new Date(old.getTime() + LIMITS.grantTtlMs) })
          .returning({ id: grants.id }),
      ).id;

    const refused = await closed('refused');
    // Its question goes with it.
    const unanswered = await closed('expired');
    // A retry that used an answered decision's grant and cited a memory, then failed before signing.
    const answered = await decision(w, 'answered', old, on);
    const failedRetry = await closed('failed');
    await on.insert(grantUses).values({ grantId: await grantFor(answered), ownerId: w.ownerId, decisionId: failedRetry, usedAt: old });
    await on.insert(decisionCitations).values({ decisionId: failedRetry, memoryId: await memoryNaming(null), ownerId: w.ownerId });

    const young = await closed('refused', ago(LIMITS.closedDecisionKeepMs));
    const withPayment = await closed('failed');
    await payment(w, withPayment, {}, on);
    const named = await closed('expired');
    await memoryNaming(named);
    const owningGrant = await closed('expired');
    await grantFor(owningGrant);
    const paid = await decision(w, 'paid', old, on);
    await payment(w, paid, {}, on);

    expect(await pruneExpiredRows({ db: on, now: NOW })).toMatchObject({ decisions: 3, owners: 0 });
    const left = (await on.select({ id: decisions.id }).from(decisions)).map((row) => row.id).sort();
    expect(left).toEqual([answered, young, withPayment, named, owningGrant, paid].sort());
    expect((await on.select().from(questions)).map((row) => row.decisionId).sort()).toEqual([named, owningGrant].sort());
    expect(await on.select().from(grantUses)).toEqual([]);
    expect(await on.select().from(decisionCitations)).toEqual([]);
    expect((await on.select({ decisionId: grants.decisionId }).from(grants)).map((row) => row.decisionId).sort()).toEqual([answered, owningGrant].sort());
    for (const id of [refused, unanswered, failedRetry]) expect(left).not.toContain(id);
    expect(await pruneExpiredRows({ db: on, now: NOW })).toMatchObject({ decisions: 0 });
  });

  it('deletes closed decisions in batches of LIMITS.pruneBatch, oldest first, and repeats a full batch only inside LIMITS.pruneTimeSliceMs', async () => {
    const on = await freshDb();
    const w = await world(on);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await decision(w, 'refused', ago(LIMITS.closedDecisionKeepMs + 1_000 * (5 - i)), on));
    let reads = 0;
    const slow = () => new Date(NOW.getTime() + reads++ * LIMITS.pruneTimeSliceMs);
    await withLimit('pruneBatch', 2, async () => {
      expect(await pruneExpiredRows({ db: on, now: NOW, clock: slow })).toMatchObject({ decisions: 2 });
      const left = async () => (await on.select({ id: decisions.id }).from(decisions)).map((row) => row.id).sort();
      expect(await left()).toEqual(ids.slice(2).sort());
      expect(await pruneExpiredRows({ db: on, now: NOW, clock: () => NOW })).toMatchObject({ decisions: 3 });
      expect(await left()).toEqual([]);
    });
  });

  it('clears 3,001 empty owners inside LIMITS.pruneTimeSliceMs on the wall clock while 200,000 older owners hold live sessions (C34)', { timeout: 600_000 }, async () => {
    const on = await freshDb();
    const live = 200_000;
    const empty = 3_001;
    // One statement: the live owners are the oldest, so the walk passes every one of them before
    // it reaches an empty owner, and each live owner gets a session that ends a day from now.
    await on.execute(sql`
      with made as (
        insert into owners (sui_address, purse_address, created_at)
        select '0x' || lpad(to_hex(g), 64, '0'),
               '0x' || md5(g::text) || md5((g + ${live + empty})::text),
               case when g <= ${live} then ${ago(2 * DAY).toISOString()}::timestamptz - g * interval '1 millisecond'
                    else ${dayOld().toISOString()}::timestamptz - (g - ${live}) * interval '1 millisecond' end
        from generate_series(1, ${live + empty}::integer) g
        returning id, created_at
      )
      insert into sessions (owner_id, token_hash, created_at, expires_at)
      select id, md5(id::text), ${ago(3_600_000).toISOString()}::timestamptz, ${new Date(NOW.getTime() + DAY).toISOString()}::timestamptz
      from made where created_at < ${ago(1.5 * DAY).toISOString()}::timestamptz
    `);
    const [before] = await on.select({ n: count() }).from(sessions);
    expect(before?.n).toBe(live);

    const startedMs = performance.now();
    const pruned = await pruneExpiredRows({ db: on, now: NOW });
    const tookMs = performance.now() - startedMs;
    expect(pruned).toMatchObject({ owners: empty, sessions: 0 });
    expect(tookMs).toBeLessThan(LIMITS.pruneTimeSliceMs);
    const [after] = await on.select({ n: count() }).from(owners);
    expect(after?.n).toBe(live);
  });

  it('repeats a full batch of empty owners only inside LIMITS.pruneTimeSliceMs, like every other rule, and the tick counts them', async () => {
    const on = await freshDb();
    for (let i = 0; i < 3; i++) await bareOwner(on);
    let reads = 0;
    const slow = () => new Date(NOW.getTime() + reads++ * LIMITS.pruneTimeSliceMs);
    await withLimit('pruneBatch', 2, async () => {
      expect(await pruneExpiredRows({ db: on, now: NOW, clock: slow })).toMatchObject({ owners: 2 });
      expect(await ownerIds(on)).toHaveLength(1);
      const { chain } = stubChain(on);
      expect(await tick(on, chain)).toMatchObject({ rowsPruned: 1, owners: 0, errors: [] });
    });
    expect(await ownerIds(on)).toEqual([]);
  });
});

const noSleep = async () => undefined;
const tick = (on: Database, chain: Chain): Promise<JobsTickSummary> =>
  runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => NOW, sleep: noSleep });

/** `chain` behind the real Tatum meter, as createChain's hook puts it: a refused call is a ChainError BUDGET with nothing sent. */
function metered(chain: Chain, on: Database, now: () => Date): Chain {
  const admit = tatumMeter(on, now);
  return new Proxy(chain, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          await admit({ transport: 'grpc', method: String(property) });
        } catch {
          throw new ChainError('BUDGET', `${String(property)} refused by the request budget, nothing was sent`);
        }
        return (value as (...given: unknown[]) => unknown)(...args);
      };
    },
  });
}

function settled(purse: string, recipient: string, amount: bigint): TransactionResult {
  return {
    status: 'success',
    balanceChanges: [
      { address: purse, coinType: USDC_TYPE_MAINNET, amount: -amount },
      { address: recipient, coinType: USDC_TYPE_MAINNET, amount },
    ],
  };
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

async function pendingMemory(w: World, sentence: string, createdAt: Date, on: Database) {
  await on.insert(memories).values({
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
    createdAt,
  });
}

const outcomesOf = (ownerId: string, on: Database) => on.select().from(memories).where(and(eq(memories.ownerId, ownerId), eq(memories.kind, 'outcome')));

// The epochs a Walrus Memory blob carried on Walrus Mainnet: registered 39, certified 41, kept until 54.
const blob = (blobId: string, change: Partial<ScannedWalrusBlob> = {}): ScannedWalrusBlob => ({
  objectId: randomAddress(),
  blobId,
  registeredEpoch: 39,
  certifiedEpoch: 41,
  endEpoch: 54,
  deletable: true,
  ...change,
});

/** A memory Walrus Memory reported done with this blob id, not yet checked on chain. */
async function confirmedMemory(w: World, blobId: string, confirmedAt: Date, on: Database): Promise<string> {
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
        sentence: 'On 2026-10-24 the owner approved a hotel search.',
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

const chainConfirmedAt = async (id: string, on: Database) => one(await on.select({ at: memories.chainConfirmedAt }).from(memories).where(eq(memories.id, id))).at;
const blobEndEpochOf = async (id: string, on: Database) => one(await on.select({ end: memories.blobEndEpoch }).from(memories).where(eq(memories.id, id))).end;
const chainExpiredAt = async (id: string, on: Database) => one(await on.select({ at: memories.chainExpiredAt }).from(memories).where(eq(memories.id, id))).at;

/** A memory found on chain five days ago, before blob_end_epoch was kept (migration 0004). */
async function legacyMemory(w: World, blobId: string, on: Database): Promise<string> {
  const id = await confirmedMemory(w, blobId, ago(5 * 86_400_000), on);
  await on.update(memories).set({ chainConfirmedAt: ago(5 * 86_400_000 - 60_000) }).where(eq(memories.id, id));
  return id;
}

/** A memory found on chain a day ago, its Blob stored until Walrus epoch `endEpoch`. */
async function storedMemory(w: World, blobId: string, endEpoch: number, on: Database): Promise<string> {
  const id = await confirmedMemory(w, blobId, ago(86_400_000), on);
  await on.update(memories).set({ chainConfirmedAt: ago(86_400_000 - 60_000), blobEndEpoch: endEpoch }).where(eq(memories.id, id));
  return id;
}

describe('confirmBlobsOnChain', () => {
  it("marks only memories whose blob id is among this owner's Walrus Blob objects, and asks the chain only when one is waiting", async () => {
    const on = await freshDb();
    const w = await world(on);
    const other = await world(on);
    const found = await confirmedMemory(w, 'blob-found', ago(120_000), on);
    const missing = await confirmedMemory(w, 'blob-missing', ago(60_000), on);
    // The same blob id under another owner proves nothing for this one.
    const elsewhere = await confirmedMemory(other, 'blob-elsewhere', ago(60_000), on);
    await pendingMemory(w, 'Not written yet.', ago(30_000), on);
    const { chain, state, calls } = stubChain(on);
    state.blobs.set(w.suiAddress, [blob('blob-found'), blob('blob-elsewhere')]);

    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 2, confirmed: 1 });
    expect(calls).toEqual(['getWalrusEpoch', `scanOwnedWalrusBlobs:${w.suiAddress}:start`]);
    expect([await chainConfirmedAt(found, on), await chainConfirmedAt(missing, on), await chainConfirmedAt(elsewhere, on)]).toEqual([NOW, null, null]);

    calls.length = 0;
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: other.ownerId, now: NOW })).toEqual({ checked: 1, confirmed: 0 });
    const empty = await world(on);
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: empty.ownerId, now: NOW })).toEqual({ checked: 0, confirmed: 0 });
    // The Walrus epoch read for the first owner still stands, so only the scan goes out.
    expect(calls).toEqual([`scanOwnedWalrusBlobs:${other.suiAddress}:start`]);
    await expect(confirmBlobsOnChain({ db: on, chain, ownerId: 'not-a-uuid', now: NOW })).rejects.toThrow('the owner id is not a uuid');
  });

  it('checks only memories confirmed between the minimum and maximum age ago, both ends included, and lists nothing when none is in range', async () => {
    const on = await freshDb();
    const w = await world(on);
    const tooNew = await confirmedMemory(w, 'blob-too-new', ago(LIMITS.blobChainCheckMinAgeMs - 1), on);
    const newest = await confirmedMemory(w, 'blob-newest', ago(LIMITS.blobChainCheckMinAgeMs), on);
    const oldest = await confirmedMemory(w, 'blob-oldest', ago(LIMITS.blobChainCheckMaxAgeMs), on);
    const tooOld = await confirmedMemory(w, 'blob-too-old', ago(LIMITS.blobChainCheckMaxAgeMs + 1), on);
    const { chain, state, calls } = stubChain(on);
    state.blobs.set(w.suiAddress, ['blob-too-new', 'blob-newest', 'blob-oldest', 'blob-too-old'].map((id) => blob(id)));
    const at = async () => Promise.all([tooNew, newest, oldest, tooOld].map((id) => chainConfirmedAt(id, on)));

    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 2, confirmed: 2 });
    expect(await at()).toEqual([null, NOW, NOW, null]);
    calls.length = 0;
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 0, confirmed: 0 });
    expect(calls).toEqual([]);

    // A millisecond on, the too-new memory is old enough, and the too-old one stays unchecked for good.
    const later = new Date(NOW.getTime() + 1);
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: later })).toEqual({ checked: 1, confirmed: 1 });
    expect(await at()).toEqual([later, NOW, NOW, null]);
    expect(LIMITS.blobChainCheckMaxAgeMs).toBe(3 * 86_400_000);
    expect(LIMITS.blobChainCheckMinAgeMs).toBe(60_000);
  });

  it('matches every memory waiting in the age window against the pages it reads, not only the oldest LIMITS.blobConfirmBatch, and stores the latest end epoch of each', async () => {
    const on = await freshDb();
    const w = await world(on);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await confirmedMemory(w, `blob-${i}`, ago(60_000 * (3 - i)), on));
    const { chain, state } = stubChain(on);
    // blob-1 is on two Blob objects, and the one stored longer says how long Walrus keeps it.
    state.blobs.set(w.suiAddress, [blob('blob-0'), blob('blob-1'), blob('blob-1', { endEpoch: 60 }), blob('blob-2', { endEpoch: 50 }), blob('blob-not-mine')]);
    await withLimit('blobConfirmBatch', 2, async () => {
      expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 3, confirmed: 3 });
    });
    for (const id of ids) expect(await chainConfirmedAt(id, on)).toEqual(NOW);
    expect(await Promise.all(ids.map((id) => blobEndEpochOf(id, on)))).toEqual([54, 60, 50]);
  });

  it('fills in the end epoch of memories found on chain before it was kept, an ended Blob included, and hides one on no Blob of the owner once one call read the whole listing (C18)', async () => {
    const on = await freshDb();
    const w = await world(on);
    const stored = await legacyMemory(w, 'blob-old-stored', on);
    const ended = await legacyMemory(w, 'blob-old-ended', on);
    const gone = await legacyMemory(w, 'blob-old-gone', on);
    const { chain, state, calls } = stubChain(on);
    // An uncertified copy says nothing about how long Walrus keeps a blob.
    state.blobs.set(w.suiAddress, [blob('blob-old-stored'), blob('blob-old-stored', { certifiedEpoch: null, endEpoch: 80 }), blob('blob-old-ended', { endEpoch: 44 })]);
    // Nothing is waiting, so only the memories to fill in send the scan out.
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 0, confirmed: 0 });
    expect(calls).toEqual(['getWalrusEpoch', `scanOwnedWalrusBlobs:${w.suiAddress}:start`]);
    expect(await Promise.all([stored, ended, gone].map((id) => blobEndEpochOf(id, on)))).toEqual([54, 44, null]);
    expect(await Promise.all([stored, ended, gone].map((id) => chainExpiredAt(id, on)))).toEqual([null, null, NOW]);

    // The Blob that ended at 44 is past Walrus epoch 45, so the expiry step retires its memory.
    expect(await expireBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ expired: 1 });
    expect(await chainExpiredAt(ended, on)).toEqual(NOW);
    calls.length = 0;
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 0, confirmed: 0 });
    expect(calls).toEqual([]);
  });

  it('never hides a memory lacking its end epoch on a listing read across calls, since a page cap proves presence, never absence (C18)', async () => {
    const on = await freshDb();
    const w = await world(on);
    const gone = await legacyMemory(w, 'blob-old-gone', on);
    const { chain, state } = stubChain(on);
    state.blobs.set(w.suiAddress, Array.from({ length: 2 * LIMITS.graphqlPageSize }, (_, i) => blob(`blob-${i}`)));
    const scanOnce = () => confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW });
    await withLimit('blobScanPagesPerTick', 1, async () => {
      // The top and the end of the listing, each in a call of its own.
      await scanOnce();
      await scanOnce();
    });
    expect(await chainExpiredAt(gone, on)).toBeNull();
    await scanOnce();
    expect(await chainExpiredAt(gone, on)).toEqual(NOW);
  });

  const cursorOf = async (w: World, on: Database) => one(await on.select({ cursor: owners.blobScanCursor }).from(owners).where(eq(owners.id, w.ownerId))).cursor;
  const scans = (calls: string[]) => calls.filter((call) => call.startsWith('scanOwnedWalrusBlobs'));

  it('confirms a memory on page 25 of an owner holding 1,250 Blob objects on its second call, resuming where the first stopped', async () => {
    expect(LIMITS.blobScanPagesPerTick * LIMITS.graphqlPageSize).toBe(1_000);
    const on = await freshDb();
    const w = await world(on);
    const held = Array.from({ length: 25 * LIMITS.graphqlPageSize }, (_, i) => blob(`blob-${i}`));
    const target = `blob-${24 * LIMITS.graphqlPageSize + 7}`;
    const memory = await confirmedMemory(w, target, ago(120_000), on);
    const { chain, state, calls } = stubChain(on);
    state.blobs.set(w.suiAddress, held);

    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ checked: 1, confirmed: 0 });
    expect(scans(calls)).toHaveLength(LIMITS.blobScanPagesPerTick);
    expect(await cursorOf(w, on)).toBe(`page-${LIMITS.blobScanPagesPerTick}`);

    calls.length = 0;
    const second = new Date(NOW.getTime() + 600_000);
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: second })).toEqual({ checked: 1, confirmed: 1 });
    expect(scans(calls)).toEqual([20, 21, 22, 23, 24].map((page) => `scanOwnedWalrusBlobs:${w.suiAddress}:page-${page}`));
    expect(await chainConfirmedAt(memory, on)).toEqual(second);
    // The listing ended, so the next scan starts from the top.
    expect(await cursorOf(w, on)).toBeNull();
  });

  it('confirms only a certified blob whose end epoch is past the current Walrus epoch: end 54 confirms at 45, never at 54', async () => {
    const on = await freshDb();
    const atFortyFive = await world(on);
    const live = await confirmedMemory(atFortyFive, 'blob-live', ago(120_000), on);
    const uncertified = await confirmedMemory(atFortyFive, 'blob-uncertified', ago(120_000), on);
    const early = stubChain(on);
    early.state.blobs.set(atFortyFive.suiAddress, [blob('blob-live'), blob('blob-uncertified', { certifiedEpoch: null })]);
    expect(early.state.walrusEpoch).toBe(45);
    expect(await confirmBlobsOnChain({ db: on, chain: early.chain, ownerId: atFortyFive.ownerId, now: NOW })).toEqual({ checked: 2, confirmed: 1 });
    expect([await chainConfirmedAt(live, on), await chainConfirmedAt(uncertified, on)]).toEqual([NOW, null]);

    const atFiftyFour = await world(on);
    const ended = await confirmedMemory(atFiftyFour, 'blob-ended', ago(120_000), on);
    const late = stubChain(on);
    late.state.walrusEpoch = 54;
    late.state.blobs.set(atFiftyFour.suiAddress, [blob('blob-ended')]);
    expect(await confirmBlobsOnChain({ db: on, chain: late.chain, ownerId: atFiftyFour.ownerId, now: NOW })).toEqual({ checked: 1, confirmed: 0 });
    expect(await chainConfirmedAt(ended, on)).toBeNull();
    expect(await confirmBlobsOnChain({ db: on, chain: early.chain, ownerId: atFortyFive.ownerId, now: NOW })).toEqual({ checked: 1, confirmed: 0 });
  });

  it('reads the Walrus epoch at most once per LIMITS.walrusEpochCacheMs for one chain client', async () => {
    expect(LIMITS.walrusEpochCacheMs).toBe(3_600_000);
    const on = await freshDb();
    const w = await world(on);
    await confirmedMemory(w, 'blob-not-there', ago(120_000), on);
    const { chain, calls } = stubChain(on);
    const at = (ms: number) => confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: new Date(NOW.getTime() + ms) });
    await at(0);
    await at(LIMITS.walrusEpochCacheMs - 1);
    expect(calls.filter((call) => call === 'getWalrusEpoch')).toHaveLength(1);
    await at(LIMITS.walrusEpochCacheMs);
    expect(calls.filter((call) => call === 'getWalrusEpoch')).toHaveLength(2);
    expect(scans(calls)).toHaveLength(3);
  });

  it('starts no read once canStart says no and resumes there; a failure keeps what was found, and one that will not clear starts over', async () => {
    const on = await freshDb();
    const w = await world(on);
    const onPageOne = await confirmedMemory(w, 'blob-0', ago(120_000), on);
    await confirmedMemory(w, 'blob-not-there', ago(120_000), on);
    const { chain, state, calls } = stubChain(on);
    state.blobs.set(w.suiAddress, Array.from({ length: 3 * LIMITS.graphqlPageSize }, (_, i) => blob(`blob-${i}`)));

    // Yes to the epoch read and one page, then no.
    let yes = 2;
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW, canStart: () => yes-- > 0 })).toEqual({ checked: 2, confirmed: 1 });
    expect(scans(calls)).toHaveLength(1);
    expect(await cursorOf(w, on)).toBe('page-1');
    expect(await chainConfirmedAt(onPageOne, on)).toEqual(NOW);
    expect(await confirmBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW, canStart: () => false })).toEqual({ checked: 0, confirmed: 0 });
    expect(scans(calls)).toHaveLength(1);

    const failing = (retryable: boolean) =>
      ({
        ...chain,
        scanOwnedWalrusBlobs: async (address: string, opts: { after: string | null; maxPages: number }) => {
          if (opts.after === 'page-2') throw new ChainError(retryable ? 'UPSTREAM' : 'BAD_RESPONSE', 'Tatum scanOwnedWalrusBlobs: refused', retryable);
          return chain.scanOwnedWalrusBlobs(address, opts);
        },
      }) as Chain;
    await expect(confirmBlobsOnChain({ db: on, chain: failing(true), ownerId: w.ownerId, now: NOW })).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(await cursorOf(w, on)).toBe('page-2');
    await expect(confirmBlobsOnChain({ db: on, chain: failing(false), ownerId: w.ownerId, now: NOW })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    expect(await cursorOf(w, on)).toBeNull();
  });

  it("keeps the scan cursor when Ellai's Tatum budget refused a page, the key was rejected or the failure can clear, and starts over only when the listing itself cannot be used", async () => {
    const on = await freshDb();
    const w = await world(on);
    await confirmedMemory(w, 'blob-not-there', ago(120_000), on);
    const { chain } = stubChain(on);
    const failingWith = (failure: ChainError) =>
      ({
        ...chain,
        scanOwnedWalrusBlobs: async () => {
          throw failure;
        },
      }) as Chain;
    const scanFrom = async (cursor: string, failure: ChainError) => {
      await on.update(owners).set({ blobScanCursor: cursor }).where(eq(owners.id, w.ownerId));
      await expect(confirmBlobsOnChain({ db: on, chain: failingWith(failure), ownerId: w.ownerId, now: NOW })).rejects.toBe(failure);
      return cursorOf(w, on);
    };
    const kept = [
      new ChainError('BUDGET', 'Tatum scanOwnedWalrusBlobs: EllaiOwnedWalrusBlobs refused by the request budget, nothing was sent'),
      new ChainError('UNAUTHORIZED', 'Tatum scanOwnedWalrusBlobs: API key rejected (HTTP 401)'),
      new ChainError('RATE_LIMITED', 'Tatum scanOwnedWalrusBlobs: rate limited (HTTP 429)', true),
      new ChainError('TIMEOUT', 'Tatum scanOwnedWalrusBlobs: timed out', true),
      new ChainError('UPSTREAM', 'Tatum scanOwnedWalrusBlobs: gateway error (HTTP 503)', true),
    ];
    for (const failure of kept) expect(await scanFrom('page-2', failure), failure.code).toBe('page-2');
    const unusable = [
      new ChainError('INVALID_INPUT', 'a page cursor is 1 to 512 characters'),
      new ChainError('BAD_RESPONSE', 'unexpected response from Tatum: Walrus blob page has the wrong shape'),
      new ChainError('LIMIT_EXCEEDED', 'GraphQL response is over the byte cap'),
      new ChainError('UPSTREAM', 'Tatum scanOwnedWalrusBlobs: GraphQL returned 1 error(s)'),
    ];
    for (const failure of unusable) expect(await scanFrom('page-2', failure), failure.code).toBeNull();
  });
});

describe('expireBlobsOnChain', () => {
  it('marks a memory expired once the Walrus epoch reaches its end epoch, never before, and reads nothing for an owner with none stored (C18, C22)', async () => {
    const on = await freshDb();
    const w = await world(on);
    const ending = await storedMemory(w, 'blob-ending', 54, on);
    const lasting = await storedMemory(w, 'blob-lasting', 60, on);
    const at53 = stubChain(on);
    at53.state.walrusEpoch = 53;
    expect(await expireBlobsOnChain({ db: on, chain: at53.chain, ownerId: w.ownerId, now: NOW })).toEqual({ expired: 0 });

    const at54 = stubChain(on);
    at54.state.walrusEpoch = 54;
    expect(await expireBlobsOnChain({ db: on, chain: at54.chain, ownerId: w.ownerId, now: NOW })).toEqual({ expired: 1 });
    expect([await chainExpiredAt(ending, on), await chainExpiredAt(lasting, on)]).toEqual([NOW, null]);
    expect(await expireBlobsOnChain({ db: on, chain: at54.chain, ownerId: w.ownerId, now: NOW })).toEqual({ expired: 0 });
    expect(at54.calls).toEqual(['getWalrusEpoch']);

    const bare = stubChain(on);
    expect(await expireBlobsOnChain({ db: on, chain: bare.chain, ownerId: (await world(on)).ownerId, now: NOW })).toEqual({ expired: 0 });
    // A stale reading is refreshed only while canStart says yes; a fresh one is used past the deadline.
    expect(await expireBlobsOnChain({ db: on, chain: bare.chain, ownerId: w.ownerId, now: NOW, canStart: () => false })).toEqual({ expired: 0 });
    expect(bare.calls).toEqual([]);
    const third = await storedMemory(w, 'blob-third', 54, on);
    expect(await expireBlobsOnChain({ db: on, chain: at54.chain, ownerId: w.ownerId, now: NOW, canStart: () => false })).toEqual({ expired: 1 });
    expect(await chainExpiredAt(third, on)).toEqual(NOW);
    expect(at54.calls).toEqual(['getWalrusEpoch']);
    await expect(expireBlobsOnChain({ db: on, chain: bare.chain, ownerId: 'not-a-uuid', now: NOW })).rejects.toThrow('the owner id is not a uuid');
  });

  it('marks at most LIMITS.blobConfirmBatch per call, earliest end first', async () => {
    const on = await freshDb();
    const w = await world(on);
    const ids = [await storedMemory(w, 'blob-52', 52, on), await storedMemory(w, 'blob-50', 50, on), await storedMemory(w, 'blob-51', 51, on)];
    const { chain, state } = stubChain(on);
    state.walrusEpoch = 54;
    await withLimit('blobConfirmBatch', 2, async () => {
      expect(await expireBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ expired: 2 });
      expect(await Promise.all(ids.map((id) => chainExpiredAt(id, on)))).toEqual([null, NOW, NOW]);
      expect(await expireBlobsOnChain({ db: on, chain, ownerId: w.ownerId, now: NOW })).toEqual({ expired: 1 });
    });
  });
});

describe('runJobsTick', () => {
  it('records a failing step with the owner, the step and a fixed code only, and still runs the rest and the next owner', async () => {
    const on = await freshDb();
    const marker = 'QX7-MARKER';
    const first = await funded(on, { memwalAccountId: randomAddress(), allowanceCheckedAt: ago(3_600_000) });
    await pendingMemory(first, `The owner approved a room ${marker}.`, ago(7_200_000), on);
    relayer({ rememberBulk: () => Promise.reject(Object.assign(new Error(marker), { status: 429 })) });
    const second = await funded(on);
    const staleOpen = await decision(second, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    const oldAsked = await decision(second, 'asked', ago(LIMITS.questionTtlMs + 1), on);
    const freshOpen = await decision(second, 'open', NOW, on);

    const stub = stubFor(second, LOW, on);
    stub.state.allowances.set(first.allowanceId, new ChainError('UPSTREAM', `gateway error ${marker}`, true));
    const chain = {
      ...stub.chain,
      getBalances: async (address: string) => {
        if (canonicalSuiAddress(address) === GAS_ADDRESS) throw new Error(`gas ${marker}`);
        return stub.chain.getBalances(address);
      },
    } as Chain;

    const summary = await tick(on, chain);
    // The gas wallet is read first, before any owner, so a busy tick cannot crowd it out; within a
    // visit the money steps run before the memory steps.
    expect(summary.errors).toEqual([
      { ownerId: '', step: 'gas_wallet', code: 'UNEXPECTED' },
      { ownerId: first.ownerId, step: 'refill', code: 'CHAIN_UPSTREAM' },
      { ownerId: first.ownerId, step: 'memory_submit', code: 'MEMORY_RATE_LIMITED' },
    ]);
    expect(summary).toMatchObject({ owners: 2, decisionsExpired: 1, questionsClosed: 1, refills: 1, gasWalletLow: true });
    expect([await statusOf(staleOpen, on), await statusOf(oldAsked, on), await statusOf(freshOpen, on)]).toEqual(['expired', 'expired', 'open']);
    expect(one(await refillRows(second.ownerId, on)).status).toBe('verified');
    expect(JSON.stringify(summary)).not.toContain(marker);
    for (const error of summary.errors) expect(error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('settles each pending payment with one read a pass, releases a lost one on the second pass, and remembers a paid seller that delivered nothing exactly once across two ticks, never one whose delivery is unknown', async () => {
    const on = await freshDb();
    const w = await world(on);
    const paid = async (sellerStatus: number | null, delivered: boolean | null, overrides: Partial<typeof payments.$inferInsert> = {}) =>
      payment(w, await decision(w, 'paid', ago(120_000), on), { sellerStatus, delivered, signedAt: ago(120_000), ...overrides }, on);
    const failedSeller = await paid(500, false);
    const answered = await paid(200, true);
    const silent = await paid(null, false);
    // The paid call could not store what the seller did, so Ellai does not know.
    const unknown = await paid(null, null);
    const lost = await paid(null, false, { validUntilEpoch: 99n });
    const wrong = await paid(200, true);
    const notYet = await paid(null, false);
    const { chain, state, calls } = stubChain(on);
    const readsOf = (digest: string) => calls.filter((call) => call === `getTransactionResult:${digest}`).length;
    const landed = new Map([
      [failedSeller.digest, settled(w.purse, RECIPIENT, PRICE)],
      [answered.digest, settled(w.purse, RECIPIENT, PRICE)],
      [silent.digest, settled(w.purse, RECIPIENT, PRICE)],
      [unknown.digest, settled(w.purse, RECIPIENT, PRICE)],
      [wrong.digest, settled(w.purse, randomAddress(), PRICE)],
    ]);
    state.landed = (digest) => landed.get(digest) ?? null;

    const first = await tick(on, chain);
    expect(first).toMatchObject({ owners: 1, paymentsVerified: 4, paymentsNotLanded: 0, paymentsMismatched: 1, outcomesRecorded: 2, errors: [] });
    const outcomes = await outcomesOf(w.ownerId, on);
    expect(outcomes.map((row) => row.decisionId).sort()).toEqual([failedSeller.decisionId, silent.decisionId].sort());
    for (const row of outcomes) expect(row).toMatchObject({ verdict: null, status: 'pending', writerPublicKey: ownerDelegate(MASTER, w.suiAddress).publicKeyHex });
    const settlement = async (id: string) => one(await on.select({ settlement: payments.settlement }).from(payments).where(eq(payments.id, id))).settlement;
    // The first pass past the window only marks the lost one missing.
    expect(await settlement(lost.id)).toBe('pending');
    expect(await settlement(wrong.id)).toBe('mismatch');
    expect(await settlement(notYet.id)).toBe('pending');
    expect([readsOf(notYet.digest), readsOf(lost.digest)]).toEqual([1, 1]);

    const second = await runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + LIMITS.paymentReleaseGapMs), sleep: noSleep });
    expect(second).toMatchObject({ owners: 1, paymentsVerified: 0, paymentsNotLanded: 1, outcomesRecorded: 0, errors: [] });
    expect(await settlement(lost.id)).toBe('not_landed');
    expect(await outcomesOf(w.ownerId, on)).toHaveLength(2);
    // notYet's window is still open and it was read half an hour ago, so only the lost one is read again.
    expect([readsOf(notYet.digest), readsOf(lost.digest), readsOf(failedSeller.digest)]).toEqual([1, 2, 1]);
  });

  it('reads the epoch once a tick for 5 pending payments past their window, two owners between them, and releases each one on a second pass LIMITS.paymentReleaseGapMs later (C4, C22)', async () => {
    const on = await freshDb();
    const pair = [await world(on), await world(on)];
    for (let i = 0; i < 5; i++) {
      const w = pair[i % 2] as World;
      // Signed for epochs up to 99; the stand-in chain is at 100 and never saw them.
      await payment(w, await decision(w, 'paid', ago(120_000), on), { validUntilEpoch: 99n, signedAt: ago(120_000) }, on);
    }
    const { chain, calls } = stubChain(on);
    const tickAfter = (ms: number) => runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + ms), sleep: noSleep });
    const counted = () => [calls.filter((call) => call === 'getCurrentEpoch').length, calls.filter((call) => call.startsWith('getTransactionResult')).length];

    // One epoch reading for the whole tick and one digest read per payment; the pass only marks each missing.
    expect(await tickAfter(0)).toMatchObject({ owners: 2, paymentsNotLanded: 0, errors: [] });
    expect(counted()).toEqual([1, 5]);
    expect((await on.select({ missingSince: payments.missingSince }).from(payments)).map((row) => row.missingSince)).toEqual(Array<Date>(5).fill(NOW));

    expect(await tickAfter(LIMITS.paymentReleaseGapMs)).toMatchObject({ owners: 2, paymentsNotLanded: 5, errors: [] });
    expect(counted()).toEqual([2, 10]);
    const released = await on.select({ settlement: payments.settlement }).from(payments);
    expect(released.map((row) => row.settlement)).toEqual(Array<string>(5).fill('not_landed'));
  });

  it('reads 10 payments a seller holds back for a day at most 10 x 24 times, then reads them every tick once their window closes and releases them on the two-pass rule (C4, C22)', { timeout: 120_000 }, async () => {
    expect(LIMITS.pendingPaymentReadIntervalMs).toBe(3_600_000);
    const on = await freshDb();
    const w = await world(on);
    const held: Array<typeof payments.$inferSelect> = [];
    for (let i = 0; i < 10; i++) held.push(await payment(w, await decision(w, 'paid', ago(120_000), on), { signedAt: ago(120_000) }, on));
    const { chain, state, calls } = stubChain(on);
    const tickMs = 600_000;
    const at = (n: number) => new Date(NOW.getTime() + n * tickMs);
    const tickAt = (n: number) => runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => at(n), sleep: noSleep });
    const reads = () => calls.filter((call) => call.startsWith('getTransactionResult')).length;
    const rows = () => on.select({ settlement: payments.settlement, missingSince: payments.missingSince, lastReadAt: payments.lastReadAt }).from(payments);

    // The paid call's own reads stamp nothing, so the tick still reads that payment first.
    const first = held[0] as (typeof held)[number];
    expect(await settlePayment({ db: on, ownerId: w.ownerId, paymentId: first.id, chain, tries: 1, intervalMs: 0, sleep: noSleep, now: () => NOW, inline: true })).toBe('pending');
    expect((await rows()).map((row) => row.lastReadAt)).toEqual(Array<Date | null>(10).fill(null));
    calls.length = 0;

    // A day of ticks ten minutes apart, every window still open: a read an hour each, and the tick's one epoch reading.
    for (let n = 0; n < 144; n++) expect(await tickAt(n)).toMatchObject({ owners: 1, paymentsVerified: 0, paymentsNotLanded: 0, errors: [] });
    expect(reads()).toBe(10 * 24);
    expect(calls.filter((call) => call === 'getCurrentEpoch')).toHaveLength(144);
    expect((await rows()).map((row) => row.lastReadAt)).toEqual(Array<Date>(10).fill(at(138)));

    expect(await tickAt(144)).toMatchObject({ owners: 1, paymentsNotLanded: 0, errors: [] });
    expect(reads()).toBe(10 * 25);
    // The window closes ten minutes after that read: from then on every tick reads every payment.
    state.epoch = 102n;
    expect(await tickAt(145)).toMatchObject({ owners: 1, paymentsNotLanded: 0, errors: [] });
    expect(reads()).toBe(10 * 26);
    expect((await rows()).map((row) => [row.settlement, row.missingSince])).toEqual(Array(10).fill(['pending', at(145)]));
    // Released only by a pass LIMITS.paymentReleaseGapMs after the one that stamped missing_since.
    expect(LIMITS.paymentReleaseGapMs).toBe(3 * tickMs);
    for (const n of [146, 147]) expect(await tickAt(n)).toMatchObject({ owners: 1, paymentsNotLanded: 0, errors: [] });
    expect(reads()).toBe(10 * 28);
    expect(await tickAt(148)).toMatchObject({ owners: 1, paymentsNotLanded: 10, errors: [] });
    expect(reads()).toBe(10 * 29);
    expect((await rows()).map((row) => row.settlement)).toEqual(Array<string>(10).fill('not_landed'));
  });

  it("counts a payment's failed settlement reads on the payment row itself, one per tick", async () => {
    const on = await freshDb();
    const w = await world(on);
    const unreadable = await payment(w, await decision(w, 'paid', ago(120_000), on), { validUntilEpoch: 99n }, on);
    const stub = stubChain(on);
    const chain = {
      ...stub.chain,
      getTransactionResult: async () => {
        throw new ChainError('UPSTREAM', 'Tatum getTransactionResult: gateway error', true);
      },
    } as Chain;
    const failedReads = async () =>
      one(await on.select({ count: payments.settlementFailedReads }).from(payments).where(eq(payments.id, unreadable.id))).count;

    expect(await tick(on, chain)).toMatchObject({ owners: 1, paymentsMismatched: 0, errors: [] });
    expect(await tick(on, chain)).toMatchObject({ owners: 1, errors: [] });
    expect(await failedReads()).toBe(2);
  });

  it('records the outcome a paid call failed to record for a verified payment that delivered nothing, exactly once across two ticks', async () => {
    const on = await freshDb();
    const w = await world(on);
    const verified = async (delivered: boolean | null) =>
      payment(w, await decision(w, 'paid', ago(600_000), on), { settlement: 'verified', sellerStatus: delivered === true ? 200 : null, delivered, signedAt: ago(600_000) }, on);
    const owed = await verified(false);
    await verified(null);
    await verified(true);
    const remembered = await verified(false);
    const delegatePublicKeyHex = ownerDelegate(MASTER, w.suiAddress).publicKeyHex;
    const earlier = await recordOutcome({ db: on, ownerId: w.ownerId, decisionId: remembered.decisionId, delivered: false, delegatePublicKeyHex, now: ago(500_000) });
    const { chain, calls } = stubChain(on);

    expect(await tick(on, chain)).toMatchObject({ owners: 1, paymentsVerified: 0, outcomesRecorded: 1, errors: [] });
    const outcomes = await outcomesOf(w.ownerId, on);
    expect(outcomes.map((row) => row.decisionId).sort()).toEqual([owed.decisionId, remembered.decisionId].sort());
    expect(outcomes.find((row) => row.decisionId === remembered.decisionId)?.id).toBe(earlier.memoryId);
    expect(outcomes.find((row) => row.decisionId === owed.decisionId)).toMatchObject({ verdict: null, status: 'pending', writerPublicKey: delegatePublicKeyHex, createdAt: NOW });

    expect(await tick(on, chain)).toMatchObject({ owners: 0, outcomesRecorded: 0, errors: [] });
    expect(await outcomesOf(w.ownerId, on)).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('getTransactionResult'))).toEqual([]);
  });

  it('hands its clock to the refill job, which stamps a lost refill with the time after its reads and fails it on a tick LIMITS.paymentReleaseGapMs later, never sleeping (C26)', async () => {
    const on = await freshDb();
    const w = await funded(on);
    const lost = one(
      await on
        .insert(refills)
        .values({ ownerId: w.ownerId, allowanceId: w.allowanceId, amountAtomic: REFILL, digest: randomDigest(), sentAt: ago(3_600_000), validUntilEpoch: 99n, status: 'pending' })
        .returning(),
    );
    const stub = stubFor(w, REFILL, on);
    let clockMs = NOW.getTime();
    // Each epoch read takes a minute, so a stamp from the time handed in before the reads would be a minute early.
    const chain = {
      ...stub.chain,
      getCurrentEpoch: async () => {
        clockMs += 60_000;
        return stub.chain.getCurrentEpoch();
      },
    } as Chain;
    const naps: number[] = [];
    const tickNow = () =>
      runJobsTick({
        db: on,
        chain,
        masterSecretHex: MASTER,
        gasKeypair: GAS,
        now: () => new Date(clockMs),
        sleep: async (ms: number) => {
          naps.push(ms);
        },
      });

    expect(await tickNow()).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(one(await refillRows(w.ownerId, on))).toMatchObject({ id: lost.id, status: 'pending', missingSince: new Date(NOW.getTime() + 60_000) });
    // Its own epoch read then brings this tick's clock to exactly LIMITS.paymentReleaseGapMs after the stamp.
    clockMs = NOW.getTime() + LIMITS.paymentReleaseGapMs;
    expect(await tickNow()).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(one(await refillRows(w.ownerId, on))).toMatchObject({ id: lost.id, status: 'failed' });
    expect(naps).toEqual([]);
  });

  it('refills a low purse, keeps an unknown send pending, and the next tick reads that digest before anything else for that owner', async () => {
    const on = await freshDb();
    const w = await funded(on);
    const stub = stubFor(w, 0n, on);
    stub.state.execute = () => {
      throw new ChainError('TIMEOUT', 'Tatum executeTransaction: timed out; the transaction may have landed', true);
    };
    expect(await tick(on, stub.chain)).toMatchObject({ owners: 1, refills: 0, errors: [{ ownerId: w.ownerId, step: 'refill', code: 'CHAIN_TIMEOUT' }] });
    const row = one(await refillRows(w.ownerId, on));
    expect(row.status).toBe('pending');
    expect(stub.executions.map((sent) => sent.rowWritten)).toEqual([true]);

    stub.calls.length = 0;
    stub.state.landed = (digest) => (digest === row.digest ? { status: 'success', balanceChanges: refillChanges(w) } : null);
    stub.state.balances.set(w.purse, { usdcAddressBalance: REFILL });
    expect(await tick(on, stub.chain)).toMatchObject({ owners: 1, refills: 0, errors: [] });
    // The first tick took this hour's gas wallet read, so the digest is the first call of all.
    expect(stub.calls.slice(0, 1)).toEqual([`getTransactionResult:${row.digest}`]);
    expect(one(await refillRows(w.ownerId, on)).status).toBe('verified');
    expect(stub.executions).toHaveLength(1);
  });

  it('sends pending memories to Walrus Memory and confirms them on a later tick', async () => {
    const on = await freshDb();
    const w = await world(on, { memwalAccountId: randomAddress() });
    await pendingMemory(w, 'On 2026-10-24 the owner approved a hotel search.', ago(60_000), on);
    let done = false;
    const client = relayer({
      rememberBulk: async (items: unknown[]) => ({ job_ids: items.map((_, index) => `job-${index}`), total: items.length, status: 'running' }),
      getRememberBulkStatus: async (ids: string[]) => ({
        results: ids.map((id) => (done ? { job_id: id, status: 'done', blob_id: `blob-${id}` } : { job_id: id, status: 'running' })),
      }),
    });
    const { chain, state, calls } = stubChain(on);
    const minutesOn = (minutes: number) =>
      runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + minutes * 60_000), sleep: noSleep });
    const listings = () => calls.filter((call) => call.startsWith('scanOwnedWalrusBlobs')).length;
    expect(await minutesOn(0)).toMatchObject({ owners: 1, memoriesSubmitted: 1, memoriesConfirmed: 0, memoriesFailed: 0, errors: [] });
    done = true;
    expect(await minutesOn(1)).toMatchObject({ owners: 1, memoriesSubmitted: 0, memoriesConfirmed: 1, memoriesChainConfirmed: 0, errors: [] });
    // Confirmed this tick, too new to be listed yet, so the chain is not asked.
    expect(listings()).toBe(0);
    // Confirmed by the relayer a minute ago but not yet seen on chain, so the owner still has work.
    expect(await minutesOn(2)).toMatchObject({ owners: 1, memoriesChainConfirmed: 0, errors: [] });
    state.blobs.set(w.suiAddress, [blob('blob-job-0')]);
    expect(await minutesOn(3)).toMatchObject({ owners: 1, memoriesChainConfirmed: 1, errors: [] });
    expect(await minutesOn(4)).toMatchObject({ owners: 0 });
    expect(listings()).toBe(2);
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
  });

  it('records a refused delegate key once per owner per tick, skipping the confirm step after the submit met it', async () => {
    const on = await freshDb();
    const w = await world(on, { memwalAccountId: randomAddress() });
    await pendingMemory(w, 'On 2026-10-24 the owner approved a hotel search.', ago(120_000), on);
    await on.insert(memories).values({
      ownerId: w.ownerId,
      kind: 'owner_decision',
      recipient: RECIPIENT,
      amountAtomic: PRICE,
      verdict: 'approve',
      sellerHost: 'hotels.example',
      sentence: 'On 2026-10-23 the owner approved a hotel search.',
      namespace: MEMORY_NAMESPACE,
      writerPublicKey: ownerDelegate(MASTER, w.suiAddress).publicKeyHex,
      status: 'pending',
      jobId: 'job-sent',
      submittedAt: ago(60_000),
      createdAt: ago(180_000),
    });
    const unauthorized = () => Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 }));
    const client = relayer({ rememberBulk: unauthorized, getRememberBulkStatus: unauthorized });
    const { chain } = stubChain(on);

    expect((await tick(on, chain)).errors).toEqual([{ ownerId: w.ownerId, step: 'memory_submit', code: 'MEMORY_DELEGATE' }]);
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
    expect(client.getRememberBulkStatus).not.toHaveBeenCalled();

    // With nothing left to send, the confirm step is the one that meets the refusal, still once.
    await on.update(memories).set({ status: 'failed' }).where(and(eq(memories.ownerId, w.ownerId), isNull(memories.jobId)));
    expect((await tick(on, chain)).errors).toEqual([{ ownerId: w.ownerId, step: 'memory_confirm', code: 'MEMORY_DELEGATE' }]);
    expect(client.getRememberBulkStatus).toHaveBeenCalledTimes(1);
  });

  it('gives an owner whose only unchecked memory is past the maximum age no blob work and no listing', async () => {
    const on = await freshDb();
    const w = await world(on);
    const old = await confirmedMemory(w, 'blob-old', ago(LIMITS.blobChainCheckMaxAgeMs + 1), on);
    const { chain, state, calls } = stubChain(on);
    state.blobs.set(w.suiAddress, [blob('blob-old')]);
    expect(await tick(on, chain)).toMatchObject({ owners: 0, memoriesChainConfirmed: 0, errors: [] });
    expect(calls.filter((call) => call.startsWith('scanOwnedWalrusBlobs') || call === 'getWalrusEpoch')).toEqual([]);
    expect(await chainConfirmedAt(old, on)).toBeNull();
  });

  it('reads the Walrus epoch at most hourly and only while a memory is stored on chain, visits an owner once its Blob ends, and marks it expired (C18, C22)', async () => {
    const on = await freshDb();
    const w = await world(on);
    const stored = await storedMemory(w, 'blob-stored', 54, on);
    const { chain, state, calls } = stubChain(on);
    const minutesOn = (minutes: number) =>
      runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + minutes * 60_000), sleep: noSleep });
    const epochReads = () => calls.filter((call) => call === 'getWalrusEpoch').length;

    expect(await minutesOn(0)).toMatchObject({ owners: 0, memoriesChainExpired: 0, errors: [] });
    state.walrusEpoch = 54;
    // The reading at 45 stands for the rest of the hour, so nothing has ended yet.
    expect(await minutesOn(30)).toMatchObject({ owners: 0, memoriesChainExpired: 0, errors: [] });
    expect(epochReads()).toBe(1);
    expect(await minutesOn(60)).toMatchObject({ owners: 1, memoriesChainExpired: 1, errors: [] });
    expect(await chainExpiredAt(stored, on)).toEqual(new Date(NOW.getTime() + 60 * 60_000));
    // Nothing is stored on chain any more, so the next hour reads no epoch at all.
    expect(await minutesOn(120)).toMatchObject({ owners: 0, memoriesChainExpired: 0, errors: [] });
    expect(epochReads()).toBe(2);
  });

  it('visits an owner whose only work is a memory found on chain before blob_end_epoch was kept, fills it in, and then finds no work', async () => {
    const on = await freshDb();
    const w = await world(on);
    const old = await legacyMemory(w, 'blob-old', on);
    const { chain, state } = stubChain(on);
    state.blobs.set(w.suiAddress, [blob('blob-old')]);
    expect(await tick(on, chain)).toMatchObject({ owners: 1, memoriesChainExpired: 0, errors: [] });
    expect(await blobEndEpochOf(old, on)).toBe(54);
    expect(await tick(on, chain)).toMatchObject({ owners: 0, errors: [] });
  });

  it('records a failing Walrus epoch read as its own step and still visits every owner with other work', async () => {
    const on = await freshDb();
    const w = await world(on);
    await storedMemory(w, 'blob-stored', 54, on);
    const staleOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    // The other work: a payment still waiting on the chain.
    await payment(w, await decision(w, 'paid', ago(120_000), on), { signedAt: ago(120_000) }, on);
    const stub = stubChain(on);
    const chain = {
      ...stub.chain,
      getWalrusEpoch: async () => {
        throw new ChainError('UPSTREAM', 'Tatum getWalrusEpoch: gateway error', true);
      },
    } as Chain;
    expect(await tick(on, chain)).toMatchObject({
      owners: 1,
      decisionsExpired: 1,
      errors: [
        { ownerId: '', step: 'walrus_epoch', code: 'CHAIN_UPSTREAM' },
        { ownerId: w.ownerId, step: 'blob_expiry', code: 'CHAIN_UPSTREAM' },
      ],
    });
    expect(await statusOf(staleOpen, on)).toBe('expired');
  });

  it('records a failing blob scan as the owner\'s blobs step and still runs the owner\'s other steps', async () => {
    const on = await freshDb();
    const w = await world(on);
    await confirmedMemory(w, 'blob-a', ago(60_000), on);
    const staleOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    const stub = stubChain(on);
    const chain = {
      ...stub.chain,
      scanOwnedWalrusBlobs: async () => {
        throw new ChainError('UPSTREAM', 'Tatum scanOwnedWalrusBlobs: gateway error', true);
      },
    } as Chain;
    expect(await tick(on, chain)).toMatchObject({ owners: 1, decisionsExpired: 1, errors: [{ ownerId: w.ownerId, step: 'blobs', code: 'CHAIN_UPSTREAM' }] });
    expect(await statusOf(staleOpen, on)).toBe('expired');
  });

  it('warns when the gas wallet holds less SUI than the threshold, and not at it', async () => {
    const on = await freshDb();
    const { chain, state } = stubChain(on);
    state.balances.set(GAS_ADDRESS, { suiTotal: BigInt(LIMITS.gasWalletLowMist) });
    expect(await tick(on, chain)).toEqual({
      owners: 0,
      memoriesSubmitted: 0,
      memoriesConfirmed: 0,
      memoriesFailed: 0,
      memoriesChainConfirmed: 0,
      memoriesChainExpired: 0,
      paymentsVerified: 0,
      paymentsNotLanded: 0,
      paymentsMismatched: 0,
      outcomesRecorded: 0,
      decisionsExpired: 0,
      questionsClosed: 0,
      refills: 0,
      rowsPruned: 0,
      gasWalletLow: false,
      timeBudgetReached: false,
      errors: [],
    });
    state.balances.set(GAS_ADDRESS, { suiTotal: BigInt(LIMITS.gasWalletLowMist) - 1n });
    const nextHour = await runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + LIMITS.gasWalletCheckIntervalMs), sleep: noSleep });
    expect(nextHour.gasWalletLow).toBe(true);
  });

  it('reads the gas wallet once across six ticks in one hour and again in the next hour, through a counter every instance shares (C21, C22)', async () => {
    const on = await freshDb();
    const { chain, calls } = stubChain(on);
    expect(LIMITS.gasWalletCheckIntervalMs).toBe(3_600_000);
    const tickAt = (minutes: number) => runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(NOW.getTime() + minutes * 60_000), sleep: noSleep });
    const lows: Array<boolean | null> = [];
    for (const minutes of [0, 10, 20, 30, 40, 50]) lows.push((await tickAt(minutes)).gasWalletLow);
    expect(calls).toEqual([`getBalances:${GAS_ADDRESS}`]);
    // The stand-in gas wallet holds no SUI, so the one reading says low; the ticks that did not read say nothing.
    expect(lows).toEqual([true, null, null, null, null, null]);
    expect((await tickAt(60)).gasWalletLow).toBe(true);
    expect(calls).toEqual([`getBalances:${GAS_ADDRESS}`, `getBalances:${GAS_ADDRESS}`]);
  });

  const visitedAt = async (w: World, on: Database) => one(await on.select({ at: owners.lastTickedAt }).from(owners).where(eq(owners.id, w.ownerId))).at;

  it('handles at most LIMITS.jobsOwnersPerTick owners, oldest work first', async () => {
    const on = await freshDb();
    const all: World[] = [];
    for (let i = 0; i <= LIMITS.jobsOwnersPerTick; i++) {
      // Each owner's pending payment was signed a second after the one before.
      const w = await world(on);
      const signedAt = ago(120_000 + 1_000 * (LIMITS.jobsOwnersPerTick + 1 - i));
      await payment(w, await decision(w, 'paid', signedAt, on), { signedAt }, on);
      all.push(w);
    }
    const last = all[LIMITS.jobsOwnersPerTick] as World;
    const { chain } = stubChain(on);
    expect(await tick(on, chain)).toMatchObject({ owners: LIMITS.jobsOwnersPerTick, errors: [] });
    expect(await visitedAt(last, on)).toBeNull();
    for (const w of all.slice(0, LIMITS.jobsOwnersPerTick)) expect(await visitedAt(w, on)).toEqual(NOW);
  });

  it('visits no owner whose only work is an open or asked decision, and still expires those for every owner in the same tick (C28)', async () => {
    const on = await freshDb();
    const w = await world(on);
    const staleOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1), on);
    const oldAsked = await decision(w, 'asked', ago(LIMITS.questionTtlMs + 1), on);
    // Questions from free wallets: each one used to be a visit.
    for (let i = 0; i < LIMITS.jobsOwnersPerTick; i++) await decision(await world(on), 'asked', NOW, on);
    const paying = await world(on);
    await payment(paying, await decision(paying, 'paid', ago(120_000), on), { signedAt: ago(120_000) }, on);
    const { chain } = stubChain(on);
    expect(await tick(on, chain)).toMatchObject({ owners: 1, decisionsExpired: 1, questionsClosed: 1, errors: [] });
    expect([await statusOf(staleOpen, on), await statusOf(oldAsked, on)]).toEqual(['expired', 'expired']);
    expect([await visitedAt(w, on), await visitedAt(paying, on)]).toEqual([null, NOW]);
  });

  it("runs an owner's payments, outcomes and refill before its memory steps, so a hung relayer cannot hold them up (C28)", async () => {
    const on = await freshDb();
    const w = await funded(on, { memwalAccountId: randomAddress() });
    await pendingMemory(w, 'On 2026-10-24 the owner approved a hotel search.', ago(60_000), on);
    const pending = await payment(w, await decision(w, 'paid', ago(120_000), on), { signedAt: ago(120_000) }, on);
    const owed = await payment(w, await decision(w, 'paid', ago(600_000), on), { settlement: 'verified', delivered: false, signedAt: ago(600_000) }, on);
    const stub = stubFor(w, 0n, on);
    let clockMs = NOW.getTime();
    // The relayer takes the rest of the tick's time budget.
    const client = relayer({
      rememberBulk: async (items: unknown[]) => {
        stub.calls.push('rememberBulk');
        clockMs += LIMITS.tickTimeBudgetMs;
        return { job_ids: items.map((_, index) => `job-${index}`), total: items.length, status: 'running' };
      },
    });
    const summary = await runJobsTick({ db: on, chain: stub.chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(clockMs), sleep: noSleep });
    expect(summary).toMatchObject({ owners: 1, outcomesRecorded: 1, refills: 1, memoriesSubmitted: 2, timeBudgetReached: true });
    const order = (call: string) => stub.calls.indexOf(call);
    expect(order(`getTransactionResult:${pending.digest}`)).toBeGreaterThanOrEqual(0);
    expect(order(`getTransactionResult:${pending.digest}`)).toBeLessThan(order(`getBalances:${w.purse}`));
    expect(order(`getBalances:${w.purse}`)).toBeLessThan(order('rememberBulk'));
    // The outcome recorded in this visit went out in the same visit's write.
    expect((await outcomesOf(w.ownerId, on)).map((row) => row.decisionId)).toEqual([owed.decisionId]);
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
  });

  it("fails every owner's pending memory past its age in one statement each tick, an owner without an account included, without visiting it (C33)", async () => {
    const on = await freshDb();
    const w = await world(on);
    await pendingMemory(w, 'On 2026-10-20 the owner approved a hotel search.', ago(LIMITS.memoryWriteMaxAgeMs), on);
    await pendingMemory(w, 'On 2026-10-21 the owner approved a hotel search.', ago(LIMITS.memoryWriteMaxAgeMs - 1), on);
    const { chain } = stubChain(on);
    expect(await tick(on, chain)).toMatchObject({ owners: 0, memoriesFailed: 1, errors: [] });
    const statuses = (await on.select({ status: memories.status }).from(memories).where(eq(memories.ownerId, w.ownerId)).orderBy(memories.createdAt)).map((row) => row.status);
    expect(statuses).toEqual(['failed', 'pending']);
    expect(createMemoryClient).not.toHaveBeenCalled();
  });

  it("charges each owner's visit to that owner's jobs scope, and the gas wallet and the tick's shared epoch reading to the jobs scope alone (C22, C28)", async () => {
    const on = await freshDb();
    const pair = [await world(on), await world(on)];
    const digests = new Map<string, string>();
    for (const w of pair) {
      // Past their window, so each settlement pass asks for the tick's one epoch reading.
      const row = await payment(w, await decision(w, 'paid', ago(120_000), on), { validUntilEpoch: 99n, signedAt: ago(120_000) }, on);
      digests.set(row.digest, w.ownerId);
    }
    const stub = stubChain(on);
    const seen: Array<{ call: string; scope: TatumScope | undefined }> = [];
    const chain = new Proxy(stub.chain, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          seen.push({ call: `${String(property)}:${String(args[0] ?? '')}`, scope: currentTatumScope() });
          return (value as (...given: unknown[]) => unknown)(...args);
        };
      },
    });
    // As the jobs route runs it.
    expect(await withTatumScope({ kind: 'jobs' }, () => tick(on, chain))).toMatchObject({ owners: 2, errors: [] });
    expect(seen.filter(({ call }) => call.startsWith('getBalances') || call.startsWith('getCurrentEpoch')).map(({ scope }) => scope)).toEqual([{ kind: 'jobs' }, { kind: 'jobs' }]);
    const reads = seen.filter(({ call }) => call.startsWith('getTransactionResult'));
    expect(new Set(reads.map(({ call }) => call)).size).toBe(2);
    for (const { call, scope } of reads) expect(scope).toEqual({ kind: 'jobs', ownerId: digests.get(call.slice('getTransactionResult:'.length)) });
  });

  it("refills a low purse after payments spent the jobs day and every owner's jobs share, since refills draw on a Tatum pool of their own (C23, C28)", async () => {
    const on = await freshDb();
    const low = await funded(on, { allowanceCheckedAt: NOW });
    const other = await world(on);
    for (const w of [low, other]) {
      for (let i = 0; i < 5; i++) await payment(w, await decision(w, 'paid', ago(120_000), on), { signedAt: ago(120_000) }, on);
    }
    const stub = stubFor(low, 0n, on);
    const chain = metered(stub.chain, on, () => NOW);
    const spent: TatumScope[] = [{ kind: 'jobs' }, { kind: 'jobs', ownerId: low.ownerId }, { kind: 'jobs', ownerId: other.ownerId }];
    await withLimit('tatumCallsJobsPerOwnerPerDay', 3, () =>
      withLimit('tatumCallsJobsPerDay', 5, async () => {
        // As the jobs route runs it. Whichever owner goes first sends three payment reads before its
        // share runs out, which with the gas wallet and epoch reads spends the jobs day; every
        // owner's five payment reads count toward its share of three.
        expect(await withTatumScope({ kind: 'jobs' }, () => tick(on, chain))).toMatchObject({ owners: 2, refills: 1, paymentsVerified: 0, errors: [] });
        for (const scope of spent) await expect(withTatumScope(scope, () => chain.getCurrentEpoch())).rejects.toMatchObject({ name: 'ChainError', code: 'BUDGET' });
      }),
    );
    const refilled = one(await refillRows(low.ownerId, on));
    expect(refilled).toMatchObject({ amountAtomic: REFILL, status: 'verified' });
    const paymentReads = stub.calls.filter((call) => call.startsWith('getTransactionResult:') && call !== `getTransactionResult:${refilled.digest}`);
    expect(paymentReads).toHaveLength(3);
  });

  it('visits the 26th owner within three ticks when 26 owners all have an allowance, which is work that never runs out', { timeout: 120_000 }, async () => {
    const on = await freshDb();
    const all: Funded[] = [];
    for (let i = 0; i <= LIMITS.jobsOwnersPerTick; i++) {
      // The 26th owner's allowance work is the newest, so ordering by work alone never reached it.
      all.push(await funded(on, { allowanceCheckedAt: ago(60_000 * (LIMITS.jobsOwnersPerTick + 1 - i)) }));
    }
    const last = all[LIMITS.jobsOwnersPerTick] as Funded;
    const { chain } = stubChain(on);
    // Every ledger holds a verified refill, above the threshold, so each visit ends at not_needed
    // with nothing read or waited for, and every allowance stays.
    for (const w of all) await refillRow(w, ago(60_000), 'verified', on);
    const tickAt = (at: Date) => runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => at, sleep: noSleep });

    expect(await tickAt(NOW)).toMatchObject({ owners: LIMITS.jobsOwnersPerTick, timeBudgetReached: false, errors: [] });
    expect(await visitedAt(last, on)).toBeNull();
    const second = new Date(NOW.getTime() + 60_000);
    expect(await tickAt(second)).toMatchObject({ owners: LIMITS.jobsOwnersPerTick, errors: [] });
    expect(await visitedAt(last, on)).toEqual(second);
    expect(await tickAt(new Date(NOW.getTime() + 120_000))).toMatchObject({ owners: LIMITS.jobsOwnersPerTick, errors: [] });
    for (const w of all) expect(await visitedAt(w, on)).not.toBeNull();
  });

  it('starts no owner once the time budget has passed, and the next tick begins with the owners it left', async () => {
    const on = await freshDb();
    const all: Funded[] = [];
    for (let i = 0; i < 4; i++) all.push(await funded(on, { allowanceCheckedAt: ago(60_000 * (4 - i)) }));
    const stub = stubChain(on);
    let clockMs = NOW.getTime();
    // Each owner's refill step reads its allowance once, so each owner costs half the budget.
    const chain = {
      ...stub.chain,
      getAllowance: async (id: string) => {
        clockMs += LIMITS.tickTimeBudgetMs / 2;
        return stub.chain.getAllowance(id);
      },
    } as Chain;
    const tickNow = () => runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(clockMs), sleep: noSleep });

    expect(await tickNow()).toMatchObject({ owners: 2, timeBudgetReached: true, errors: [] });
    expect(await Promise.all(all.map((w) => visitedAt(w, on).then((at) => at !== null)))).toEqual([true, true, false, false]);
    expect(await tickNow()).toMatchObject({ owners: 2, timeBudgetReached: true, errors: [] });
    expect(await Promise.all(all.map((w) => visitedAt(w, on).then((at) => at !== null)))).toEqual([true, true, true, true]);
  });

  it('lets the longest unit it may start just before its deadline end inside LIMITS.tickEndByMs, worked out from LIMITS', () => {
    const retryWaits = Array.from({ length: LIMITS.tatumRetries }, (_, i) => LIMITS.tatumRetryDelayMs * 2 ** i).reduce((a, b) => a + b, 0);
    // core's bounded(): every try waits out tatumTimeoutMs, with the retry waits between.
    const tatumRead = (LIMITS.tatumRetries + 1) * LIMITS.tatumTimeoutMs + retryWaits;
    // executeTransaction: a send each round, a digest lookup before each later round, the waits, then a refusal's wait and lookup.
    const send = (LIMITS.tatumRetries + 1) * LIMITS.tatumTimeoutMs + LIMITS.tatumRetries * LIMITS.tatumTimeoutMs + retryWaits + LIMITS.tatumRetryDelayMs + LIMITS.tatumTimeoutMs;
    const units = {
      // settlePayment with tries 1: the digest, then the epoch. A release takes a second pass instead
      // of more reads in this one, so no pass waits or reads again.
      settlementPass: 2 * tatumRead,
      // Once its row is written a refill always dry-runs, sends and reads back.
      refillSend: tatumRead + send + tatumRead,
      refillRead: LIMITS.settlementPollIntervalMs + tatumRead,
      gasWalletBalances: LIMITS.balanceMaxPages * tatumRead,
      walrusEpoch: 2 * tatumRead,
      blobScanPage: tatumRead,
      // The tick hands the writer canStart, so core never waits for a delegate key's points before a
      // call (memory-service.test.ts proves the refusal); the call ceiling is then the whole unit.
      relayerCall: LIMITS.memwalCallTimeoutMs,
    };
    expect(units).toEqual({
      settlementPass: 66_000,
      refillSend: 130_000,
      refillRead: 36_000,
      gasWalletBalances: 165_000,
      walrusEpoch: 66_000,
      blobScanPage: 33_000,
      relayerCall: 120_000,
    });
    const slowest = Math.max(...Object.values(units));
    expect(LIMITS.tickTimeBudgetMs + slowest).toBeLessThanOrEqual(LIMITS.tickEndByMs);
    expect(LIMITS.tickEndByMs).toBeLessThanOrEqual(LIMITS.slowRouteMaxDurationS * 1_000 - 20_000);
  });

  it('past its deadline starts no owner, no further payment read and no refill, and stamps each visit as it starts', async () => {
    const on = await freshDb();
    const first = await funded(on, { allowanceCheckedAt: ago(120_000) });
    const second = await funded(on, { allowanceCheckedAt: ago(60_000) });
    const read = await payment(first, await decision(first, 'paid', ago(120_000), on), { signedAt: ago(120_000) }, on);
    const unread = await payment(first, await decision(first, 'paid', ago(60_000), on), { signedAt: ago(60_000) }, on);
    const stub = stubFor(first, LOW, on);
    let clockMs = NOW.getTime();
    // The first settlement read takes the clock to the deadline.
    const chain = {
      ...stub.chain,
      getTransactionResult: async (digest: string) => {
        clockMs = NOW.getTime() + LIMITS.tickTimeBudgetMs;
        return stub.chain.getTransactionResult(digest);
      },
    } as Chain;
    const summary = await runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => new Date(clockMs), sleep: noSleep });

    expect(summary).toMatchObject({ owners: 1, refills: 0, timeBudgetReached: true, errors: [] });
    expect(stub.calls).toEqual([`getBalances:${GAS_ADDRESS}`, `getTransactionResult:${read.digest}`, 'getCurrentEpoch']);
    expect(stub.calls).not.toContain(`getTransactionResult:${unread.digest}`);
    expect([await visitedAt(first, on), await visitedAt(second, on)]).toEqual([NOW, null]);
  });
});
