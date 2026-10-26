import { type Chain, ChainError, type TransactionResult } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { verifySettlement } from '@ellai/core/payment';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, owners, payments } from '../db/schema.js';
import type { Settlement } from './result.js';
import { PURSE_KEY_MISMATCH } from './sign.js';

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
  /**
   * True for the paid call's own reads right after signing. Such a pass only verifies, or records
   * a mismatch, when it finds the transaction; otherwise it leaves the payment 'pending' without
   * reading the epoch, so it never marks a payment missing, counts a failed read or releases one.
   * Those belong to the jobs tick's passes (C4, C27).
   */
  inline?: boolean;
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

/** The mismatch_reason of a payment released because its transaction ran and failed, moving no USDC. */
export const FAILED_ON_CHAIN = 'failed_on_chain';

/** True when any balance change is in USDC, or in a coin type that cannot be read and so might be. */
function touchesUsdc(result: TransactionResult): boolean {
  return result.balanceChanges.some((change) => {
    try {
      return normalizeStructTag(change.coinType) === USDC_TYPE_MAINNET;
    } catch {
      return true;
    }
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Read = { kind: 'landed'; result: TransactionResult } | { kind: 'missing' } | { kind: 'unknown' } | { kind: 'not_read' };

async function read(chain: Chain, digest: string): Promise<Read> {
  try {
    return { kind: 'landed', result: await chain.getTransactionResult(digest) };
  } catch (error) {
    if (!(error instanceof ChainError)) return { kind: 'unknown' };
    if (error.code === 'NOT_FOUND') return { kind: 'missing' };
    // Ellai's own Tatum budget refused the read before it was sent, so the chain was never
    // asked; counting it as a failed read would let other owners' traffic pause this one (D-1).
    return error.code === 'BUDGET' ? { kind: 'not_read' } : { kind: 'unknown' };
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
 * SETTLEMENT_MISMATCH, so decide refuses every later payment until the owner reviews it. A
 * transaction that ran and failed with no USDC balance change moved no money: it becomes
 * 'not_landed' with mismatch_reason FAILED_ON_CHAIN and released_at set, and the owner is not
 * paused. A transaction found at any pass settles this way, whatever an earlier pass missed.
 *
 * An `inline` pass stops there and answers 'pending'. Otherwise, when every read missed, the
 * chain's epoch is read through `readEpoch`. A window still open, or an epoch that cannot be
 * read, leaves 'pending' for a later pass. Once the epoch is past valid_until_epoch, no single
 * pass may release the payment, since one node lagging behind the chain can miss bytes that
 * landed at the very end of their window (C4, C27): the first such pass only stamps
 * missing_since, and a later pass releases it as 'not_landed', with released_at set so it stops
 * counting against the daily budget, only when missing_since is at least
 * LIMITS.paymentReleaseGapMs old and every read of that pass missed too. Its reads come after
 * missing_since, which was stamped after an epoch reading showed the window closed, so they are
 * reads made after the window. A reading taken earlier, as the tick's shared one may be, is safe:
 * epochs only go up, so an older reading can only hold a payment pending longer.
 *
 * A read the request budget refused (ChainError BUDGET) was never sent: it ends the pass with
 * the payment 'pending' and is not counted below, nor taken as a miss. A read that fails with
 * any other error but NOT_FOUND ends the pass. Once the epoch is past
 * valid_until_epoch, the pass is counted as one failed pass for this payment, and the pass that
 * brings the count to LIMITS.settlementUnverifiableReads makes the payment 'mismatch' with
 * mismatch_reason UNVERIFIABLE and, in the same transaction, sets the owner's
 * auto_paused_reason to SETTLEMENT_UNVERIFIABLE, so decide refuses every later payment until the
 * owner reviews it (C8, C21). Until then it stays 'pending' and counts against the budget. The
 * count is payments.settlement_failed_reads, raised by one atomic UPDATE from 'pending' only, and
 * it never resets, so the ceiling is reached however far apart the passes come.
 *
 * Every write of a settlement sets outcome_at to `now()` in the same UPDATE, so an owner's yes
 * clears it only from a question asked after Ellai learned it (C32); the verified and mismatch
 * writes read that time while holding the owner row FOR UPDATE (C26). Either pause also sets the
 * owner's auto_paused_at to that same time, in the same update, and neither replaces a
 * PURSE_KEY_MISMATCH pause already in place (A-F4).
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
      const at = stamp();
      const done = await tx
        .update(payments)
        .set({ settlement: 'mismatch', mismatchReason: reason, outcomeAt: at })
        .where(stillPending)
        .returning({ id: payments.id });
      if (done.length === 0) return false;
      // A purse key mismatch says the master secret changed, which outranks any one payment, so it
      // is never replaced. Any other pause takes this time, so a signed clear issued before it
      // cannot lift it (A-F4).
      await tx
        .update(owners)
        .set({ autoPausedReason: pauseReason, autoPausedAt: at })
        .where(and(eq(owners.id, ownerId), or(isNull(owners.autoPausedReason), ne(owners.autoPausedReason, PURSE_KEY_MISMATCH))));
      return true;
    });
    return marked ? 'mismatch' : stored(db, ownerId, paymentId);
  };

  const judge = async (result: TransactionResult): Promise<Settlement> => {
    // Sui undoes every effect of a failed transaction but its gas, and a gasless send pays none,
    // so the purse still holds the money and the digest can never run again. Keeping it as a
    // mismatch would leave Ellai's ledger short by money that never left (C23, C27).
    if (result.status === 'failure' && !touchesUsdc(result)) {
      const at = stamp();
      const done = await db
        .update(payments)
        .set({ settlement: 'not_landed', mismatchReason: FAILED_ON_CHAIN, releasedAt: at, outcomeAt: at })
        .where(stillPending)
        .returning({ id: payments.id });
      return done.length > 0 ? 'not_landed' : stored(db, ownerId, paymentId);
    }
    const verdict = verifySettlement(result, approved, purseAddress);
    if (verdict.verified) {
      // Under the owner lock decide dates a question under, so a question is dated either before
      // this outcome or after it, never in between (C26, C32).
      const done = await db.transaction(async (tx) => {
        await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
        const at = stamp();
        return tx.update(payments).set({ settlement: 'verified', verifiedAt: at, outcomeAt: at }).where(stillPending).returning({ id: payments.id });
      });
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

  const { digest, validUntilEpoch, missingSince } = row.payment;
  let failed = false;
  for (let attempt = 0; attempt < args.tries && !failed; attempt++) {
    if (attempt > 0) await sleep(args.intervalMs);
    const seen = await read(chain, digest);
    if (seen.kind === 'landed') return judge(seen.result);
    if (seen.kind === 'not_read') return 'pending';
    failed = seen.kind === 'unknown';
  }
  if (args.inline === true) return 'pending';

  let epoch: bigint;
  try {
    epoch = await readEpoch();
  } catch {
    return 'pending';
  }
  if (epoch <= validUntilEpoch) return 'pending';
  if (failed) return unreadable();

  const at = stamp();
  if (missingSince === null) {
    const marked = await db
      .update(payments)
      .set({ missingSince: at })
      .where(and(stillPending, isNull(payments.missingSince)))
      .returning({ id: payments.id });
    return marked.length > 0 ? 'pending' : stored(db, ownerId, paymentId);
  }
  const releaseFrom = new Date(at.getTime() - LIMITS.paymentReleaseGapMs);
  if (missingSince.getTime() > releaseFrom.getTime()) return 'pending';
  const released = await db
    .update(payments)
    .set({ settlement: 'not_landed', releasedAt: at, outcomeAt: at })
    .where(and(stillPending, lte(payments.missingSince, releaseFrom)))
    .returning({ id: payments.id });
  return released.length > 0 ? 'not_landed' : stored(db, ownerId, paymentId);
}
