import { type Chain, ChainError, type TransactionResult } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { verifySettlement } from '@ellai/core/payment';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, owners, payments } from '../db/schema.js';
import type { Settlement } from './result.js';

export interface SettleArgs {
  db: Database;
  ownerId: string;
  paymentId: string;
  chain: Chain;
  /** Reads of the digest, from 1 to LIMITS.settlementPollTries. */
  tries: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /** The clock every settlement write is stamped with; the wall clock when left out. */
  now?: () => Date;
  /**
   * Reads the chain's current epoch; chain.getCurrentEpoch when left out. The jobs tick passes one
   * reading shared by every settlement pass it makes (C22).
   */
  readEpoch?: () => Promise<bigint>;
}

/** Set as the owner's auto_paused_reason when a payment landed and was not the approved one (C8). */
export const SETTLEMENT_MISMATCH = 'settlement_mismatch';

/**
 * Set as the owner's auto_paused_reason when a payment's settlement could not be read on
 * LIMITS.settlementUnverifiableReads separate passes after its epoch window closed (C8, C21).
 */
export const SETTLEMENT_UNVERIFIABLE = 'settlement_unverifiable';

/** The mismatch_reason of a payment closed that way: Ellai cannot say whether it landed. */
export const UNVERIFIABLE = 'unverifiable';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Read = { kind: 'landed'; result: TransactionResult } | { kind: 'missing' } | { kind: 'unknown' };

async function read(chain: Chain, digest: string): Promise<Read> {
  try {
    return { kind: 'landed', result: await chain.getTransactionResult(digest) };
  } catch (error) {
    return error instanceof ChainError && error.code === 'NOT_FOUND' ? { kind: 'missing' } : { kind: 'unknown' };
  }
}

async function stored(db: Database, ownerId: string, paymentId: string): Promise<Settlement> {
  const [row] = await db
    .select({ settlement: payments.settlement })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.ownerId, ownerId)));
  return row?.settlement ?? 'pending';
}

/**
 * Reads one signed payment's transaction from chain by the digest Ellai stored when it signed,
 * never one a seller or an agent reported, and records what it finds (C8, C4, C21).
 *
 * Up to `tries` reads, `intervalMs` apart. A NOT_FOUND keeps looking. A landed transaction goes
 * through core's verifySettlement against the decision's recipient, amount, asset and network
 * and the purse that signed it (payments.purse_address): 'verified' sets verified_at;
 * 'mismatch' stores verifySettlement's fixed reason and, in the same transaction, sets the owner's auto_paused_reason to
 * SETTLEMENT_MISMATCH, so decide refuses every later payment until the owner reviews it. When
 * every read missed, the chain's epoch is read through `readEpoch`: only once it is past
 * valid_until_epoch, and LIMITS.paymentReleaseReads further reads taken after it all still miss,
 * is the payment 'not_landed', with released_at set so it stops counting against the daily
 * budget. A window still open, or an epoch that cannot be read, leaves 'pending' for a later pass.
 * A reading taken earlier, as the tick's shared one may be, is safe: epochs only go up, so an
 * older reading can only hold a payment pending longer, and the release reads still come after it.
 *
 * A read that fails with any error but NOT_FOUND ends the pass. Once the epoch is past
 * valid_until_epoch, the pass is counted as one failed pass for this payment, and the pass that
 * brings the count to LIMITS.settlementUnverifiableReads makes the payment 'mismatch' with
 * mismatch_reason UNVERIFIABLE and, in the same transaction, sets the owner's
 * auto_paused_reason to SETTLEMENT_UNVERIFIABLE, so decide refuses every later payment until the
 * owner reviews it (C8, C21). Until then it stays 'pending' and counts against the budget. The
 * count is payments.settlement_failed_reads, raised by one atomic UPDATE from 'pending' only, and
 * it never resets, so the ceiling is reached however far apart the passes come.
 *
 * Every write of a settlement sets outcome_at to `now()` in the same UPDATE, so an owner's yes
 * clears it only from a question asked after Ellai learned it (C32).
 *
 * A payment already past 'pending' is returned as it is. Writes only from 'pending', so two
 * passes never overwrite each other. Throws for an unknown payment or tries out of range.
 */
export async function settlePayment(args: SettleArgs): Promise<Settlement> {
  const { db, chain, sleep } = args;
  const now = args.now ?? (() => new Date());
  const readEpoch = args.readEpoch ?? (() => chain.getCurrentEpoch());
  if (!Number.isSafeInteger(args.tries) || args.tries < 1 || args.tries > LIMITS.settlementPollTries) {
    throw new RangeError(`tries must be 1 to ${LIMITS.settlementPollTries}`);
  }
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId) || typeof args.paymentId !== 'string' || !UUID.test(args.paymentId)) {
    throw new Error('there is no such payment for this owner');
  }
  const ownerId = args.ownerId.toLowerCase();
  const paymentId = args.paymentId.toLowerCase();

  const [row] = await db
    .select({ payment: payments, decision: decisions })
    .from(payments)
    .innerJoin(decisions, and(eq(decisions.id, payments.decisionId), eq(decisions.ownerId, payments.ownerId)))
    .where(and(eq(payments.id, paymentId), eq(payments.ownerId, ownerId)));
  if (row === undefined) throw new Error('there is no such payment for this owner');
  if (row.payment.settlement !== 'pending') return row.payment.settlement;

  const { decision } = row;
  // The purse that signed these bytes, which is the one debited even if the owner's purse on
  // record has changed since.
  const { purseAddress } = row.payment;
  // Only the t2000 dialect is ever signed, and verifySettlement reads nothing but the
  // recipient, amount, asset and network, all of them the decision's own canonical fields.
  const approved: CanonicalPayment = {
    dialect: 'x402-v1-t2000',
    sellerUrl: decision.sellerUrl,
    sellerHost: decision.sellerHost,
    recipient: decision.recipient,
    amount: decision.amountAtomic,
    asset: decision.asset,
    network: decision.network as CanonicalPayment['network'],
    expiresAtMs: decision.expiresAt.getTime(),
    challengeId: decision.challengeId,
    nonce: decision.nonce,
    minEpoch: decision.minEpoch,
    maxEpoch: decision.maxEpoch,
    resource: null,
  };
  const stillPending = and(eq(payments.id, paymentId), eq(payments.ownerId, ownerId), eq(payments.settlement, 'pending'));
  // Read at each write, after the chain reads it records, so outcome_at is never earlier than
  // the fact it dates (C26, C32).
  const stamp = (): Date => {
    const at = now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('the current time is not a date');
    return at;
  };

  // The owner row is locked first, in the order every other writer takes it.
  const mismatch = async (reason: string, pauseReason: string): Promise<Settlement> => {
    const marked = await db.transaction(async (tx) => {
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
      const done = await tx
        .update(payments)
        .set({ settlement: 'mismatch', mismatchReason: reason, outcomeAt: stamp() })
        .where(stillPending)
        .returning({ id: payments.id });
      if (done.length === 0) return false;
      await tx.update(owners).set({ autoPausedReason: pauseReason }).where(eq(owners.id, ownerId));
      return true;
    });
    return marked ? 'mismatch' : stored(db, ownerId, paymentId);
  };

  const judge = async (result: TransactionResult): Promise<Settlement> => {
    const verdict = verifySettlement(result, approved, purseAddress);
    if (verdict.verified) {
      const at = stamp();
      const done = await db
        .update(payments)
        .set({ settlement: 'verified', verifiedAt: at, outcomeAt: at })
        .where(stillPending)
        .returning({ id: payments.id });
      return done.length > 0 ? 'verified' : stored(db, ownerId, paymentId);
    }
    return mismatch(verdict.reason, SETTLEMENT_MISMATCH);
  };

  // Called only once the window has closed, when the bytes can no longer land, so waiting
  // longer would leave the payment pending, and holding the budget, with nothing left to learn.
  // The count lives on the payment's own row and has no time window, because with many owners
  // the tick can come back to this one less often than any window would allow (C8, C21).
  const unreadable = async (): Promise<Settlement> => {
    const [counted] = await db
      .update(payments)
      .set({ settlementFailedReads: sql`${payments.settlementFailedReads} + 1` })
      .where(stillPending)
      .returning({ failedReads: payments.settlementFailedReads });
    if (counted === undefined) return stored(db, ownerId, paymentId);
    if (counted.failedReads < LIMITS.settlementUnverifiableReads) return 'pending';
    return mismatch(UNVERIFIABLE, SETTLEMENT_UNVERIFIABLE);
  };

  const { digest, validUntilEpoch } = row.payment;
  let failed = false;
  for (let attempt = 0; attempt < args.tries && !failed; attempt++) {
    if (attempt > 0) await sleep(args.intervalMs);
    const seen = await read(chain, digest);
    if (seen.kind === 'landed') return judge(seen.result);
    failed = seen.kind === 'unknown';
  }

  let epoch: bigint;
  try {
    epoch = await readEpoch();
  } catch {
    return 'pending';
  }
  if (epoch <= validUntilEpoch) return 'pending';
  if (failed) return unreadable();
  // One lagging node must not release a payment that landed in the last moments of its window.
  for (let attempt = 0; attempt < LIMITS.paymentReleaseReads; attempt++) {
    await sleep(args.intervalMs);
    const seen = await read(chain, digest);
    if (seen.kind === 'unknown') return unreadable();
    if (seen.kind === 'landed') return judge(seen.result);
  }
  const releasedAt = stamp();
  const released = await db
    .update(payments)
    .set({ settlement: 'not_landed', releasedAt, outcomeAt: releasedAt })
    .where(stillPending)
    .returning({ id: payments.id });
  return released.length > 0 ? 'not_landed' : stored(db, ownerId, paymentId);
}
