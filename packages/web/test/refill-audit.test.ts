// Covers: refillIfNeeded on PGlite with a stand-in chain, for the money-path audit fixes. A lost
// refill is failed only by a call at least LIMITS.paymentReleaseGapMs after the first call that saw
// its window closed and its digest missing, never while the window is open, and a later call that
// finds it records it as landed (A-F1, C4, C27); the day's refill count and the new row's sent_at
// come from the clock read under the owner lock, after the reads before it (A-F5, C26); a dry run
// that fails holds the allowance off for LIMITS.refillDryRunWaitMs, an hour, only while the owner
// still holds that allowance, and a dry run with no verdict does not (D-1, C22); an allowance expiring within
// LIMITS.allowanceExpiryMarginMs of the clock read after it, or of the end of a full rate window,
// is forgotten and nothing is built (A-F6, C30).
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    /** Digests the chain shows as landed refills besides the ones sent here. */
    landed: new Set<string>(),
  };
  const executions: string[] = [];
  const reads: string[] = [];
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
  return { chain, state, executions, reads };
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

const refill = (w: Funded, chain: Chain, extra: { clock?: () => Date } = {}) =>
  refillIfNeeded({ db, chain, ownerId: w.ownerId, masterSecretHex: MASTER, gasKeypair: GAS, now: NOW, ...extra });

describe('refillIfNeeded, the money-path audit fixes', () => {
  const GAP = LIMITS.paymentReleaseGapMs;

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

    expect(await refill(w, chain, { clock: () => at(GAP) })).toBe('refilled');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'failed', missingSince: NOW });
    expect(reads.filter((digest) => digest === lost.digest)).toHaveLength(3);
    expect(executions).toHaveLength(1);
  });

  it('records a lost refill that a later call finds as landed, whatever an earlier call missed, and marks nothing while its window is open', async () => {
    const { w, lost, chain, state, executions } = await lostRefill();
    state.epoch = 99n;
    expect(await refill(w, chain)).toBe('skipped_pending');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'pending', missingSince: null });

    state.epoch = 102n;
    expect(await refill(w, chain, { clock: () => at(60_000) })).toBe('skipped_pending');
    expect((await rowOf(lost.id)).missingSince).toEqual(at(60_000));
    state.landed.add(lost.digest);
    expect(await refill(w, chain, { clock: () => at(60_000 + GAP) })).toBe('resolved_pending');
    expect(await rowOf(lost.id)).toMatchObject({ status: 'verified', verifiedAt: at(60_000 + GAP) });
    expect(executions).toEqual([]);
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
});
