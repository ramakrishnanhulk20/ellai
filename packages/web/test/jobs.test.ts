// Covers: the jobs tick on PGlite with a stand-in chain and a stand-in relayer. expireDecisions
// closes stale open decisions and old unanswered questions and nothing fresher. refillIfNeeded
// refills a low purse once, signed by the purse and the gas wallet, with its row written before
// the send; never while a refill is pending, past the daily count or past the float; never from
// an allowance that is not this owner's, for this purse, in USDC, unexpired and with room; never
// signs bytes that are not exactly the refill; keeps an unknown send pending and reads that
// digest first next time; releases a lost refill only once its epoch window has closed and
// further reads still miss it, and leaves rows from before that window was kept waiting.
// runJobsTick isolates each
// owner's and each step's failure behind a fixed code, settles pending payments and remembers a
// paid seller stored as delivering nothing exactly once (never one whose delivery is unknown),
// records an outcome a paid call failed to record, expires, refills with the tick's own sleep,
// sends and confirms memories, warns on a low gas wallet, and takes at most
// LIMITS.jobsOwnersPerTick owners.
// Does NOT cover: the real Sui chain, Tatum or the relayer (scripts/prove-jobs.ts does those
// live), whether Sui accepts the refill bytes (packages/proof's prove-pay sent one live), two
// connections racing on the owner lock (PGlite serves one connection), or what schedules the
// tick.
import { randomBytes, randomUUID } from 'node:crypto';
import type { AllowanceState, Balances, Chain, ExecutionResult, TransactionResult } from '@ellai/core/chain';
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
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, memories, owners, payments, questions, refills } from '../src/server/db/schema.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { recordOutcome } from '../src/server/memory/outcome.js';
import { expireDecisions } from '../src/server/jobs/expire.js';
import { RefillError, refillIfNeeded } from '../src/server/jobs/refill.js';
import { type JobsTickSummary, runJobsTick } from '../src/server/jobs/tick.js';

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

function allowanceFor(w: Funded, overrides: Partial<AllowanceState> = {}): AllowanceState {
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
  allowances: Map<string, AllowanceState | Error>;
  /** What a successful send moves. */
  changes: TransactionResult['balanceChanges'];
  execute: (digest: string) => ExecutionResult | Promise<ExecutionResult>;
  /** What the chain has for a digest, or null for NOT_FOUND. By default, whatever was sent. */
  landed: (digest: string) => TransactionResult | null;
  /** The epoch the chain reports now. */
  epoch: bigint;
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
    execute: (digest) => {
      sent.add(digest);
      return { digest, status: 'success', errorCode: null, balanceChanges: state.changes, createdObjects: [] };
    },
    landed: (digest) => (sent.has(digest) ? { status: 'success', balanceChanges: state.changes } : null),
    epoch: 100n,
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
    getTransactionResult: async (digest: string) => {
      calls.push(`getTransactionResult:${digest}`);
      const result = state.landed(digest);
      if (result === null) throw new ChainError('NOT_FOUND', 'not found (gRPC NOT_FOUND)');
      return result;
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
  it('expires a stale open decision with no payment and an old unanswered question, and nothing fresher', async () => {
    const w = await world();
    const staleOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1));
    const freshOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs));
    const signedOpen = await decision(w, 'open', ago(LIMITS.staleOpenDecisionMs + 1));
    await payment(w, signedOpen);
    const oldAsked = await decision(w, 'asked', ago(LIMITS.questionTtlMs + 1));
    const freshAsked = await decision(w, 'asked', ago(LIMITS.questionTtlMs));
    const oldPaid = await decision(w, 'paid', ago(LIMITS.questionTtlMs * 2));
    const other = await world();
    const othersStale = await decision(other, 'open', ago(LIMITS.staleOpenDecisionMs + 1));

    expect(await expireDecisions({ db, ownerId: w.ownerId, now: NOW })).toEqual({ decisionsExpired: 1, questionsClosed: 1 });
    expect(await statusOf(staleOpen)).toBe('expired');
    expect(await statusOf(oldAsked)).toBe('expired');
    for (const [id, status] of [
      [freshOpen, 'open'],
      [signedOpen, 'open'],
      [freshAsked, 'asked'],
      [oldPaid, 'paid'],
      [othersStale, 'open'],
    ] as const) {
      expect(await statusOf(id)).toBe(status);
    }
    expect(await expireDecisions({ db, ownerId: w.ownerId, now: NOW })).toEqual({ decisionsExpired: 0, questionsClosed: 0 });
  });

  it('leaves an old asked decision whose question was answered, and expires nothing for an unknown owner', async () => {
    const w = await world();
    const answered = await decision(w, 'asked', ago(LIMITS.questionTtlMs + 1));
    await db.update(questions).set({ answer: 'refuse', answeredAt: ago(1) }).where(eq(questions.decisionId, answered));
    expect(await expireDecisions({ db, ownerId: w.ownerId, now: NOW })).toEqual({ decisionsExpired: 0, questionsClosed: 0 });
    expect(await statusOf(answered)).toBe('asked');
    expect(await expireDecisions({ db, ownerId: randomUUID(), now: NOW })).toEqual({ decisionsExpired: 0, questionsClosed: 0 });
    await expect(expireDecisions({ db, ownerId: 'not-a-uuid', now: NOW })).rejects.toThrow('the owner id is not a uuid');
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
      `getAllowance:${w.allowanceId}`,
      `getBalances:${w.purse}`,
      'getCurrentEpoch',
      'getReferenceGasPrice',
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

  it("refuses, building and sending nothing, an allowance that is not this owner's, for this purse, in USDC, unexpired and with room", async () => {
    const variants: Array<Partial<AllowanceState> | Error> = [
      { funder: randomAddress() },
      { spender: randomAddress() },
      { coinType: SUI_TYPE },
      { expirationMs: BigInt(NOW.getTime()) },
      { spentTotal: 1_000_000n - REFILL + 1n },
      new ChainError('NOT_FOUND', 'not found'),
    ];
    for (const variant of variants) {
      const w = await funded();
      const { chain, state, calls, executions } = stubFor(w, 0n);
      state.allowances.set(w.allowanceId, variant instanceof Error ? variant : allowanceFor(w, variant));
      expect(await refill(w, chain)).toBe('refused');
      expect(calls).toEqual([`getAllowance:${w.allowanceId}`]);
      expect(executions).toHaveLength(0);
      expect(await refillRows(w.ownerId)).toHaveLength(0);
    }

    const moved = await funded(db, { purseAddress: randomAddress() });
    const { chain, calls } = stubFor(moved, 0n);
    expect(await refill(moved, chain)).toBe('refused');
    expect(calls).toEqual([]);
    expect(await refill(await world(), chain)).toBe('refused');
  });

  it('keeps an unknown send outcome pending, and the next call reads that digest before anything else', async () => {
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
    state.balances.set(w.purse, { usdcAddressBalance: REFILL });
    expect(await refill(w, chain)).toBe('not_needed');
    expect(calls[0]).toBe(`getTransactionResult:${row.digest}`);
    expect(one(await refillRows(w.ownerId))).toMatchObject({ status: 'verified', verifiedAt: NOW });
    expect(executions).toHaveLength(1);
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
    stub.state.changes = [...refillChanges(odd), { address: randomAddress(), coinType: USDC_TYPE_MAINNET, amount: 1n }];
    await expect(refill(odd, stub.chain)).rejects.toMatchObject({ name: 'RefillError', code: 'MISMATCH' });
    expect(one(await refillRows(odd.ownerId)).status).toBe('pending');
    await expect(refill(odd, stub.chain)).rejects.toMatchObject({ code: 'MISMATCH' });
    expect(stub.executions).toHaveLength(1);
  });

  it('fails a lost refill only once its epoch window has closed and three more reads miss it, and may then refill', async () => {
    const w = await funded();
    const { chain, state, calls, executions } = stubFor(w, 0n);
    const send = state.execute;
    state.execute = sendTimesOut;
    await expect(refill(w, chain)).rejects.toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    const lost = one(await refillRows(w.ownerId));
    const expiration = bcs.TransactionData.parse(executions[0]?.txBytes ?? new Uint8Array()).V1?.expiration;
    const signedMaxEpoch = expiration?.$kind === 'ValidDuring' ? expiration.ValidDuring.maxEpoch : undefined;
    expect([lost.status, lost.validUntilEpoch, signedMaxEpoch]).toEqual(['pending', 101n, '101']);

    const naps: number[] = [];
    const sleep = async (ms: number) => {
      naps.push(ms);
    };
    state.execute = send;
    state.epoch = 101n;
    calls.length = 0;
    expect(await refill(w, chain, NOW, db, sleep)).toBe('skipped_pending');
    expect(calls).toEqual([`getTransactionResult:${lost.digest}`, 'getCurrentEpoch']);
    expect(naps).toEqual([]);

    state.epoch = 102n;
    calls.length = 0;
    expect(await refill(w, chain, NOW, db, sleep)).toBe('refilled');
    expect(LIMITS.paymentReleaseReads).toBe(3);
    expect(naps).toEqual([LIMITS.settlementPollIntervalMs, LIMITS.settlementPollIntervalMs, LIMITS.settlementPollIntervalMs]);
    const readLost = `getTransactionResult:${lost.digest}`;
    expect(calls.slice(0, 5)).toEqual([readLost, 'getCurrentEpoch', readLost, readLost, readLost]);
    const rows = await refillRows(w.ownerId);
    expect(rows.map((row) => [row.digest === lost.digest, row.status, row.validUntilEpoch]).sort()).toEqual([
      [false, 'verified', 103n],
      [true, 'failed', 101n],
    ]);
    expect(executions).toHaveLength(2);
  });

  it('records a lost refill that one of the later reads finds, instead of failing it', async () => {
    const w = await funded();
    const { chain, state } = stubFor(w, 0n);
    state.execute = sendTimesOut;
    await expect(refill(w, chain)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const lost = one(await refillRows(w.ownerId));

    state.epoch = 102n;
    let reads = 0;
    state.landed = (digest) => (digest === lost.digest && ++reads === 3 ? { status: 'success', balanceChanges: refillChanges(w) } : null);
    state.balances.set(w.purse, { usdcAddressBalance: REFILL });
    expect(await refill(w, chain)).toBe('not_needed');
    expect(reads).toBe(3);
    expect(one(await refillRows(w.ownerId))).toMatchObject({ id: lost.id, status: 'verified', verifiedAt: NOW });
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
});

const noSleep = async () => undefined;
const tick = (on: Database, chain: Chain): Promise<JobsTickSummary> =>
  runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => NOW, sleep: noSleep });

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
    expect(summary.errors).toEqual([
      { ownerId: first.ownerId, step: 'memory_submit', code: 'MEMORY_RATE_LIMITED' },
      { ownerId: first.ownerId, step: 'refill', code: 'CHAIN_UPSTREAM' },
      { ownerId: '', step: 'gas_wallet', code: 'UNEXPECTED' },
    ]);
    expect(summary).toMatchObject({ owners: 2, decisionsExpired: 1, questionsClosed: 1, refills: 1, gasWalletLow: true });
    expect([await statusOf(staleOpen, on), await statusOf(oldAsked, on), await statusOf(freshOpen, on)]).toEqual(['expired', 'expired', 'open']);
    expect(one(await refillRows(second.ownerId, on)).status).toBe('verified');
    expect(JSON.stringify(summary)).not.toContain(marker);
    for (const error of summary.errors) expect(error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('settles each pending payment once, and remembers a paid seller that delivered nothing exactly once across two ticks, never one whose delivery is unknown', async () => {
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
    expect(first).toMatchObject({ owners: 1, paymentsVerified: 4, paymentsNotLanded: 1, paymentsMismatched: 1, outcomesRecorded: 2, errors: [] });
    const outcomes = await outcomesOf(w.ownerId, on);
    expect(outcomes.map((row) => row.decisionId).sort()).toEqual([failedSeller.decisionId, silent.decisionId].sort());
    for (const row of outcomes) expect(row).toMatchObject({ verdict: null, status: 'pending', writerPublicKey: ownerDelegate(MASTER, w.suiAddress).publicKeyHex });
    const settlement = async (id: string) => one(await on.select({ settlement: payments.settlement }).from(payments).where(eq(payments.id, id))).settlement;
    expect(await settlement(lost.id)).toBe('not_landed');
    expect(await settlement(wrong.id)).toBe('mismatch');
    expect(await settlement(notYet.id)).toBe('pending');
    expect(readsOf(notYet.digest)).toBe(1);

    const second = await tick(on, chain);
    expect(second).toMatchObject({ owners: 1, paymentsVerified: 0, outcomesRecorded: 0, errors: [] });
    expect(await outcomesOf(w.ownerId, on)).toHaveLength(2);
    expect([readsOf(notYet.digest), readsOf(failedSeller.digest)]).toEqual([2, 1]);
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

  it('hands its sleep to the refill job, which waits on it while it confirms a lost refill', async () => {
    const on = await freshDb();
    const w = await funded(on);
    const lost = one(
      await on
        .insert(refills)
        .values({ ownerId: w.ownerId, allowanceId: w.allowanceId, amountAtomic: REFILL, digest: randomDigest(), sentAt: ago(3_600_000), validUntilEpoch: 99n, status: 'pending' })
        .returning(),
    );
    const { chain } = stubFor(w, REFILL, on);
    const naps: number[] = [];
    const sleep = async (ms: number) => {
      naps.push(ms);
    };
    const summary = await runJobsTick({ db: on, chain, masterSecretHex: MASTER, gasKeypair: GAS, now: () => NOW, sleep });
    expect(summary).toMatchObject({ owners: 1, refills: 0, errors: [] });
    expect(naps).toEqual(Array(LIMITS.paymentReleaseReads).fill(LIMITS.settlementPollIntervalMs));
    expect(one(await refillRows(w.ownerId, on))).toMatchObject({ id: lost.id, status: 'failed' });
  });

  it('refills a low purse, keeps an unknown send pending, and the next tick reads that digest before anything else', async () => {
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
    expect(stub.calls[0]).toBe(`getTransactionResult:${row.digest}`);
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
    const { chain } = stubChain(on);
    expect(await tick(on, chain)).toMatchObject({ owners: 1, memoriesSubmitted: 1, memoriesConfirmed: 0, memoriesFailed: 0, errors: [] });
    done = true;
    expect(await tick(on, chain)).toMatchObject({ owners: 1, memoriesSubmitted: 0, memoriesConfirmed: 1, errors: [] });
    expect(await tick(on, chain)).toMatchObject({ owners: 0 });
    expect(client.rememberBulk).toHaveBeenCalledTimes(1);
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
      paymentsVerified: 0,
      paymentsNotLanded: 0,
      paymentsMismatched: 0,
      outcomesRecorded: 0,
      decisionsExpired: 0,
      questionsClosed: 0,
      refills: 0,
      gasWalletLow: false,
      errors: [],
    });
    state.balances.set(GAS_ADDRESS, { suiTotal: BigInt(LIMITS.gasWalletLowMist) - 1n });
    expect((await tick(on, chain)).gasWalletLow).toBe(true);
  });

  it('handles at most LIMITS.jobsOwnersPerTick owners, oldest work first', async () => {
    const on = await freshDb();
    const ids: string[] = [];
    for (let i = 0; i <= LIMITS.jobsOwnersPerTick; i++) {
      // Each owner's stale decision is a second newer than the one before.
      ids.push(await decision(await world(on), 'open', ago(LIMITS.staleOpenDecisionMs + 1_000 * (LIMITS.jobsOwnersPerTick + 1 - i)), on));
    }
    const { chain } = stubChain(on);
    expect(await tick(on, chain)).toMatchObject({ owners: LIMITS.jobsOwnersPerTick, decisionsExpired: LIMITS.jobsOwnersPerTick, errors: [] });
    expect(await statusOf(ids[LIMITS.jobsOwnersPerTick] ?? '', on)).toBe('open');
    expect(await tick(on, chain)).toMatchObject({ owners: 1, decisionsExpired: 1 });
  });
});
