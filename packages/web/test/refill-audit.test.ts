// Covers: refillIfNeeded on PGlite with a stand-in chain, for the money-path audit fixes. A lost
// refill is failed only by a call at least LIMITS.paymentReleaseGapMs after the first call that saw
// its window closed and its digest missing, never while the window is open, and a later call that
// finds it records it as landed (A-F1, C4, C27); the day's refill count and the new row's sent_at
// come from the clock read under the owner lock, after the reads before it (A-F5, C26); a dry run
// that fails holds the allowance off for LIMITS.refillDryRunWaitMs, an hour, only while the owner
// still holds that allowance, and a dry run with no verdict does not (D-1, C22); an allowance expiring within
// LIMITS.allowanceExpiryMarginMs of the clock read after it, or of the end of a full rate window,
// is forgotten and nothing is built (A-F6, C30); an allowance getAllowance cannot find is forgotten
// only when objectExists agrees it is gone, and is otherwise kept with one warning line, a failed
// check or a passed deadline forgetting nothing, and a lag or a failed check holding the refill
// off for LIMITS.refillErrorWaitMs (WO-E1b, C7, C22); a pending refill is read only when
// refills.last_read_at allows, a failed read stamping it too (C22, C40).
// Does NOT cover: the jobs tick that calls refillIfNeeded (jobs.test.ts), the real Sui chain or
// Tatum, or two connections racing on the owner lock (PGlite serves one).
import { randomBytes } from 'node:crypto';
import type { AllowanceReading, Chain, SimulationResult, TransactionResult } from '@ellai/core/chain';
import { ChainError } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { SUI_TYPE_ARG, normalizeStructTag } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, owners, payments, refills } from '../src/server/db/schema.js';
import { RefillError, refillIfNeeded } from '../src/server/jobs/refill.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  await handle.close();
});

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const MASTER = hex(32);
const NOW = new Date('2026-10-24T10:00:00Z');
const GAS = Ed25519Keypair.generate();
const GAS_ADDRESS = canonicalSuiAddress(GAS.toSuiAddress());
const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);
const REFILL = BigInt(LIMITS.purseRefillAtomic);
const DAY = LIMITS.purseRefillWindowMs;
const MARGIN = LIMITS.allowanceExpiryMarginMs;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const randomDigest = () => TransactionDataBuilder.getDigestFromBytes(randomBytes(64));

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

interface Funded {
  ownerId: string;
  suiAddress: string;
  purse: string;
  allowanceId: string;
}

async function funded(): Promise<Funded> {
  const suiAddress = canonicalSuiAddress(`0x${hex(32)}`);
  const purse = canonicalSuiAddress(derivePurseKeypair(MASTER, suiAddress).toSuiAddress());
  const allowanceId = canonicalSuiAddress(`0x${hex(32)}`);
  const row = one(await db.insert(owners).values({ suiAddress, purseAddress: purse, allowanceId, allowanceCheckedAt: NOW }).returning());
  return { ownerId: row.id, suiAddress, purse, allowanceId };
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
    expirationMs: BigInt(NOW.getTime() + 30 * DAY),
    initialSharedVersion: 7n,
    periodSpent: 0n,
    periodEndMs: null,
    ...overrides,
  };
}

function refillChanges(w: Funded): TransactionResult['balanceChanges'] {
  return [
    { address: w.suiAddress, coinType: USDC_TYPE_MAINNET, amount: -REFILL },
    { address: w.purse, coinType: USDC_TYPE_MAINNET, amount: REFILL },
    { address: GAS_ADDRESS, coinType: SUI_TYPE, amount: -2_000_000n },
  ];
}

/** A chain on which `w`'s purse is empty and its allowance is as issued, unless `state` is changed. */
function stubChain(w: Funded) {
  const sent = new Set<string>();
  const state = {
    epoch: 100n,
    allowance: allowanceFor(w) as AllowanceReading | Error,
    simulate: (): SimulationResult => ({ status: 'success', errorCode: null, balanceChanges: refillChanges(w) }),
    onAllowanceRead: async () => undefined as void,
    /** What objectExists answers: whether gRPC still holds the allowance, or the error it throws. */
    grpcHolds: true as boolean | Error,
    /** Digests the chain shows as landed refills besides the ones sent here. */
    landed: new Set<string>(),
  };
  const executions: string[] = [];
  const reads: string[] = [];
  const objectReads: string[] = [];
  const chain = {
    usesApiKey: false,
    getCurrentEpoch: async () => state.epoch,
    getReferenceGasPrice: async () => 100n,
    getBalances: async () => ({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiTotal: 0n }),
    getAllowance: async () => {
      await state.onAllowanceRead();
      if (state.allowance instanceof Error) throw state.allowance;
      return state.allowance;
    },
    objectExists: async (id: string) => {
      objectReads.push(id);
      if (state.grpcHolds instanceof Error) throw state.grpcHolds;
      return state.grpcHolds;
    },
    simulate: async () => state.simulate(),
    executeTransaction: async (txBytes: Uint8Array) => {
      const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
      sent.add(digest);
      executions.push(digest);
      return { digest, status: 'success', errorCode: null, balanceChanges: refillChanges(w), createdObjects: [] };
    },
    getTransactionResult: async (digest: string) => {
      reads.push(digest);
      if (!sent.has(digest) && !state.landed.has(digest)) throw new ChainError('NOT_FOUND', 'not found (gRPC NOT_FOUND)');
      return { status: 'success', balanceChanges: refillChanges(w) };
    },
  } as unknown as Chain;
  return { chain, state, executions, reads, objectReads };
}

const refillRows = (ownerId: string) => db.select().from(refills).where(eq(refills.ownerId, ownerId));
const ownerRow = async (ownerId: string) => one(await db.select().from(owners).where(eq(owners.id, ownerId)));

async function refillRow(w: Funded, sentAt: Date, status: 'pending' | 'verified', validUntilEpoch: bigint | null = null, missingSince: Date | null = null) {
  return one(
    await db.insert(refills).values({ ownerId: w.ownerId, allowanceId: w.allowanceId, amountAtomic: REFILL, digest: randomDigest(), sentAt, status, validUntilEpoch, missingSince }).returning(),
  );
}

/** A signed, unreleased payment of `amount`, so Ellai's ledger shows the verified refills spent. */
async function spent(w: Funded, amount: bigint) {
  const agent = one(await db.insert(agents).values({ ownerId: w.ownerId, label: 'Test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_ab12' }).returning());
  const decision = one(
    await db
      .insert(decisions)
      .values({
        ownerId: w.ownerId,
        agentId: agent.id,
        requestKey: hex(16),
        sellerUrl: 'https://hotels.example/v1/rooms',
        sellerMethod: 'POST',
        sellerHost: 'hotels.example',
        bodyHash: hex(32),
        purpose: 'search hotels',
        recipient: canonicalSuiAddress(`0x${'11'.repeat(32)}`),
        amountAtomic: amount,
        asset: USDC_TYPE_MAINNET,
        network: 'sui:mainnet',
        expiresAt: NOW,
        outcome: 'approved',
        rule: 'learned',
        reason: 'test decision',
        status: 'paid',
      })
      .returning(),
  );
  await db.insert(payments).values({
    decisionId: decision.id,
    ownerId: w.ownerId,
    purseAddress: w.purse,
    recipient: decision.recipient,
    amountAtomic: amount,
    digest: hex(16),
    txBytesBase64: 'AA==',
    signedAt: NOW,
    validUntilEpoch: 101n,
  });
}

const refill = (w: Funded, chain: Chain, extra: { clock?: () => Date; canStart?: () => boolean } = {}) =>
  refillIfNeeded({ db, chain, ownerId: w.ownerId, masterSecretHex: MASTER, gasKeypair: GAS, now: NOW, ...extra });

describe('refillIfNeeded, the money-path audit fixes', () => {
  const GAP = LIMITS.paymentReleaseGapMs;
  const PACE = LIMITS.pendingRefillReadIntervalMs;
  const HOUR = LIMITS.pendingPaymentReadIntervalMs;

  /** An owner whose only refill was sent an hour ago for epochs up to 99 and never seen; the chain is at 102. */
  async function lostRefill() {
    const w = await funded();
    const lost = await refillRow(w, at(-3_600_000), 'pending', 99n);
    const stub = stubChain(w);
    stub.state.epoch = 102n;
    return { w, lost, ...stub };
  }
  const rowOf = async (id: string) => one(await db.select().from(refills).where(eq(refills.id, id)));

  it('fails a lost refill only on a call at least LIMITS.paymentReleaseGapMs after the first that saw it missing, one read a call, and then refills (A-F1, C4, C27)', async () => {
    const { w, lost, chain, executions, reads } = await lostRefill();
    expect(await refill(w, chain, { clock: () => NOW })).toBe('skipped_pending');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'pending', missingSince: NOW });
    expect(await refill(w, chain, { clock: () => at(GAP - 1) })).toBe('skipped_pending');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'pending', missingSince: NOW });
    expect(reads).toEqual([lost.digest, lost.digest]);
    expect(executions).toEqual([]);

    // Read a moment ago, so a call at the gap itself waits for the next read LIMITS.pendingRefillReadIntervalMs on.
    expect(await refill(w, chain, { clock: () => at(GAP) })).toBe('skipped_pending');
    expect(reads).toHaveLength(2);
    expect(await refill(w, chain, { clock: () => at(GAP - 1 + PACE) })).toBe('refilled');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'failed', missingSince: NOW });
    expect(reads.filter((digest) => digest === lost.digest)).toHaveLength(3);
    expect(executions).toHaveLength(1);

    // When the next read comes exactly the gap after the call that marked it, that read releases it.
    const exact = await lostRefill();
    expect(await refill(exact.w, exact.chain, { clock: () => NOW })).toBe('skipped_pending');
    expect(await refill(exact.w, exact.chain, { clock: () => at(GAP) })).toBe('refilled');
    expect(await rowOf(exact.lost.id)).toMatchObject({ status: 'failed', missingSince: NOW });
  });

  it('records a lost refill that a later call finds as landed, whatever an earlier call missed, and marks nothing while its window is open', async () => {
    const { w, lost, chain, state, executions } = await lostRefill();
    state.epoch = 99n;
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'pending', missingSince: null });

    // That read saw the window open, so the next is LIMITS.pendingPaymentReadIntervalMs after it.
    state.epoch = 102n;
    expect(await refill(w, chain, { clock: () => at(HOUR - 1) })).toBe('skipped_pending');
    expect((await rowOf(lost.id)).missingSince).toBeNull();
    expect(await refill(w, chain, { clock: () => at(HOUR) })).toBe('skipped_pending');
    expect((await rowOf(lost.id)).missingSince).toEqual(at(HOUR));
    state.landed.add(lost.digest);
    expect(await refill(w, chain, { clock: () => at(HOUR + GAP) })).toBe('resolved_pending');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'verified', verifiedAt: at(HOUR + GAP) });
    expect(executions).toEqual([]);
  });

  it('reads a pending refill no more often than last_read_at allows: every LIMITS.ownerVisitPassGapMs while fresh, hourly while its window is open, every LIMITS.pendingRefillReadIntervalMs once a read saw it closed, a failed read stamping it too (C22, C40)', async () => {
    const PASS = LIMITS.ownerVisitPassGapMs;
    const FRESH = LIMITS.freshRefillWindowMs;
    const w = await funded();
    // Sent at NOW with its window open past epoch 100, so every read is the digest and the epoch.
    const pending = await refillRow(w, NOW, 'pending', 200n);
    const { chain, state, reads } = stubChain(w);
    let failing = false;
    const flaky = {
      ...chain,
      getTransactionResult: async (digest: string) => {
        if (!failing) return chain.getTransactionResult(digest);
        reads.push(digest);
        throw new ChainError('UPSTREAM', 'Tatum getTransactionResult: gateway error', true);
      },
    } as Chain;
    const callAt = (ms: number) => refill(w, flaky, { clock: () => at(ms) });
    const lastReadAt = async () => (await rowOf(pending.id)).lastReadAt;

    for (const ms of [0, PASS - 1, PASS]) expect(await callAt(ms)).toBe('skipped_pending');
    expect([reads.length, await lastReadAt()]).toEqual([2, at(PASS)]);
    // Past the fresh window, with no read yet seeing it closed, the next read waits an hour from the last one.
    for (const ms of [FRESH, PASS + HOUR - 1]) expect(await callAt(ms)).toBe('skipped_pending');
    expect(reads).toHaveLength(2);
    failing = true;
    await expect(callAt(PASS + HOUR)).rejects.toMatchObject({ name: 'ChainError', code: 'UPSTREAM' });
    expect([reads.length, await lastReadAt()]).toEqual([3, at(PASS + HOUR)]);
    failing = false;
    expect(await callAt(PASS + 2 * HOUR - 1)).toBe('skipped_pending');
    expect(reads).toHaveLength(3);
    // This read sees the window closed and stamps missing_since; from then on reads are the tick's ten minutes apart.
    state.epoch = 201n;
    expect(await callAt(PASS + 2 * HOUR)).toBe('skipped_pending');
    expect([reads.length, (await rowOf(pending.id)).missingSince]).toEqual([4, at(PASS + 2 * HOUR)]);
    expect(await callAt(PASS + 2 * HOUR + PACE - 1)).toBe('skipped_pending');
    expect(reads).toHaveLength(4);
    expect(await callAt(PASS + 2 * HOUR + PACE)).toBe('skipped_pending');
    expect(reads).toHaveLength(5);
  });

  /** Three refills that fill the day at NOW, the oldest leaving the window 5 s later; the newest is lost and is released by this call. */
  async function dayFullAtNow() {
    const w = await funded();
    await refillRow(w, at(-DAY + 5_000), 'verified');
    await refillRow(w, at(-2 * 3_600_000), 'verified');
    const lost = await refillRow(w, at(-3_600_000), 'pending', 99n, at(-GAP));
    await spent(w, 2n * REFILL);
    const stub = stubChain(w);
    stub.state.epoch = 102n;
    return { w, lost, ...stub };
  }

  it("counts the day's refills and stamps sent_at at the clock read under the owner lock, after the reads before it (A-F5, C26)", async () => {
    const stale = await dayFullAtNow();
    expect(LIMITS.purseMaxRefillsPerDay).toBe(3);
    expect(await refill(stale.w, stale.chain)).toBe('not_needed');

    const { w, lost, chain, executions } = await dayFullAtNow();
    let clockMs = NOW.getTime();
    // Reading the lost digest takes 4 s and each epoch read 5 s; nothing else moves the clock.
    const slow = {
      ...chain,
      getTransactionResult: async (digest: string) => {
        clockMs += 4_000;
        return chain.getTransactionResult(digest);
      },
      getCurrentEpoch: async () => {
        clockMs += 5_000;
        return chain.getCurrentEpoch();
      },
    } as Chain;
    expect(await refill(w, slow, { clock: () => new Date(clockMs) })).toBe('refilled');
    const rows = await refillRows(w.ownerId);
    expect(rows.find((row) => row.id === lost.id)?.status).toBe('failed');
    // The lost digest and the release epoch (9 s), then the build's epoch (14 s) before the lock, then the read back (18 s).
    const sentNow = one(rows.filter((row) => row.digest === executions[0]));
    expect(sentNow).toMatchObject({ status: 'verified', sentAt: at(14_000), verifiedAt: at(18_000) });
  });

  it('holds the allowance off for an hour after a dry run that fails, only while the owner still holds it, and not after a dry run with no verdict (D-1, C22)', async () => {
    expect(LIMITS.refillDryRunWaitMs).toBe(3_600_000);
    const lockedAt = at(5_000);
    const failed = await funded();
    const stub = stubChain(failed);
    stub.state.simulate = () => ({ status: 'failure', errorCode: 'INSUFFICIENT_ADDRESS_BALANCE', balanceChanges: [] });
    await expect(refill(failed, stub.chain, { clock: () => lockedAt })).rejects.toEqual(
      new RefillError('DRY_RUN_FAILED', 'the refill dry run did not move exactly the refill, so nothing was sent'),
    );
    expect(stub.executions).toEqual([]);
    expect(one(await refillRows(failed.ownerId)).status).toBe('failed');
    expect(await ownerRow(failed.ownerId)).toMatchObject({ allowanceId: failed.allowanceId, refillNotBefore: new Date(lockedAt.getTime() + LIMITS.refillDryRunWaitMs) });

    const replaced = await funded();
    const newer = canonicalSuiAddress(`0x${hex(32)}`);
    const replacing = stubChain(replaced);
    replacing.state.simulate = () => ({ status: 'failure', errorCode: 'MOVE_ABORT', balanceChanges: [] });
    const dryRun = replacing.chain.simulate;
    const chain = {
      ...replacing.chain,
      simulate: async (txBytes: Uint8Array) => {
        await db.update(owners).set({ allowanceId: newer }).where(eq(owners.id, replaced.ownerId));
        return dryRun(txBytes);
      },
    } as Chain;
    await expect(refill(replaced, chain)).rejects.toMatchObject({ name: 'RefillError', code: 'DRY_RUN_FAILED' });
    expect(await ownerRow(replaced.ownerId)).toMatchObject({ allowanceId: newer, refillNotBefore: null });

    const silent = await funded();
    const noVerdict = stubChain(silent);
    noVerdict.state.simulate = () => {
      throw new ChainError('TIMEOUT', 'Tatum simulate: timed out', true);
    };
    await expect(refill(silent, noVerdict.chain)).rejects.toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    expect(await ownerRow(silent.ownerId)).toMatchObject({ allowanceId: silent.allowanceId, refillNotBefore: null });
  });

  it('forgets, building nothing, an allowance that expires within the margin of the clock read after it, or of the end of a full window, and uses one that does not (A-F6, C30)', async () => {
    const forgotten = { allowanceId: null, allowanceCheckedAt: null, refillNotBefore: null };
    const attempt = async (overrides: Partial<AllowanceReading>, readTakesMs = 0) => {
      const w = await funded();
      const stub = stubChain(w);
      stub.state.allowance = allowanceFor(w, overrides);
      let clockMs = NOW.getTime();
      stub.state.onAllowanceRead = async () => {
        clockMs += readTakesMs;
      };
      const outcome = await refill(w, stub.chain, { clock: () => new Date(clockMs) });
      const owner = await ownerRow(w.ownerId);
      return { w, outcome, sent: stub.executions.length, recorded: { allowanceId: owner.allowanceId, allowanceCheckedAt: owner.allowanceCheckedAt, refillNotBefore: owner.refillNotBefore } };
    };

    const short = await attempt({ expirationMs: BigInt(NOW.getTime() + MARGIN - 1) });
    expect(short).toMatchObject({ outcome: 'refused', sent: 0, recorded: forgotten });
    expect(await refillRows(short.w.ownerId)).toHaveLength(0);
    expect(await attempt({ expirationMs: BigInt(NOW.getTime() + MARGIN) })).toMatchObject({ outcome: 'refilled', sent: 1 });

    // Enough margin at the time the read was asked for, not once it answered two seconds later.
    expect(await attempt({ expirationMs: BigInt(NOW.getTime() + MARGIN + 1_000) }, 2_000)).toMatchObject({ outcome: 'refused', sent: 0, recorded: forgotten });

    const windowEnd = NOW.getTime() + 3_600_000;
    const full = { periodSpent: 500_000n - REFILL + 1n, periodEndMs: BigInt(windowEnd) };
    expect(await attempt({ ...full, expirationMs: BigInt(windowEnd + MARGIN - 1) })).toMatchObject({ outcome: 'refused', sent: 0, recorded: forgotten });
    const waits = await attempt({ ...full, expirationMs: BigInt(windowEnd + MARGIN) });
    expect(waits).toMatchObject({ outcome: 'refused', sent: 0, recorded: { allowanceId: waits.w.allowanceId, refillNotBefore: new Date(windowEnd) } });
  });

  it('forgets an allowance GraphQL cannot find only when gRPC agrees it is gone, and otherwise leaves the owner as is with one warning that names no id (C7, C22)', async () => {
    const missing = () => new ChainError('NOT_FOUND', 'Allowance was not found on Sui mainnet');
    const visit = async (grpcHolds: boolean | Error, canStart?: () => boolean, onAllowanceRead?: () => Promise<void>) => {
      const w = await funded();
      const stub = stubChain(w);
      stub.state.allowance = missing();
      stub.state.grpcHolds = grpcHolds;
      if (onAllowanceRead) stub.state.onAllowanceRead = onAllowanceRead;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let outcome: unknown;
      let lines: string[];
      try {
        outcome = await refill(w, stub.chain, canStart ? { canStart } : {}).catch((error: unknown) => error);
        lines = warn.mock.calls.map((call) => call.join(' '));
      } finally {
        warn.mockRestore();
      }
      const owner = await ownerRow(w.ownerId);
      expect(stub.executions).toEqual([]);
      expect(await refillRows(w.ownerId)).toHaveLength(0);
      return { w, outcome, lines, objectReads: stub.objectReads, recorded: { allowanceId: owner.allowanceId, allowanceCheckedAt: owner.allowanceCheckedAt, refillNotBefore: owner.refillNotBefore } };
    };

    const lag = await visit(true);
    expect(lag).toMatchObject({ outcome: 'refused', lines: ['[ellai refill] allowance_index_lag'], objectReads: [lag.w.allowanceId] });
    // Held off for LIMITS.allowanceLagWaitMs, a minute: the index usually catches up within one, and the first refill after setup should not wait ten (C40).
    expect(lag.recorded).toEqual({ allowanceId: lag.w.allowanceId, allowanceCheckedAt: NOW, refillNotBefore: at(LIMITS.allowanceLagWaitMs) });

    const gone = await visit(false);
    expect(gone).toMatchObject({ outcome: 'refused', lines: [], objectReads: [gone.w.allowanceId] });
    expect(gone.recorded).toEqual({ allowanceId: null, allowanceCheckedAt: null, refillNotBefore: null });

    // A check that cannot answer forgets nothing; the tick records the failure and a visit reads again once the hold-off ends.
    const unanswered = await visit(new ChainError('TIMEOUT', 'Tatum objectExists: timed out', true));
    expect(unanswered.outcome).toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    expect(unanswered.recorded).toMatchObject({ allowanceId: unanswered.w.allowanceId, refillNotBefore: at(LIMITS.refillErrorWaitMs) });

    // The check is a chain read like any other, so a deadline that passed during the allowance read stops it.
    let open = true;
    const late = await visit(false, () => open, async () => {
      open = false;
    });
    expect(late).toMatchObject({ outcome: 'deferred', objectReads: [] });
    expect(late.recorded).toMatchObject({ allowanceId: late.w.allowanceId, refillNotBefore: null });
  });

  it('waits LIMITS.allowanceLagWaitMs after the first index lag for an allowance and LIMITS.refillErrorWaitMs after each lag that outlasts it (C7, C22, C40)', async () => {
    const w = await funded();
    const stub = stubChain(w);
    stub.state.allowance = new ChainError('NOT_FOUND', 'Allowance was not found on Sui mainnet');
    let clockMs = NOW.getTime();
    const waits: number[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Each call comes as the wait the one before it set ends, as the next visit would.
      for (let lag = 0; lag < 3; lag++) {
        expect(await refill(w, stub.chain, { clock: () => new Date(clockMs) })).toBe('refused');
        const notBefore = (await ownerRow(w.ownerId)).refillNotBefore?.getTime() ?? clockMs;
        waits.push(notBefore - clockMs);
        clockMs = notBefore;
      }
    } finally {
      warn.mockRestore();
    }
    expect(waits).toEqual([60_000, 600_000, 600_000]);
  });
});
