import type { Chain } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { PaymentError, type SignedPayment, signPayment } from '@ellai/core/payment';
import { normalizeStructTag } from '@mysten/sui/utils';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, owners, payments } from '../db/schema.js';

export type SignRefusal = 'expired' | 'wrong_epoch' | 'paused' | 'over_payment_max' | 'over_daily_budget' | 'purse_short' | 'not_open';

/** A refusal over the per-payment maximum carries the maximum it was checked against, so the reason can name it. */
export type SignResult =
  | { signed: SignedPayment }
  | { refusal: Exclude<SignRefusal, 'over_payment_max'> }
  | { refusal: 'over_payment_max'; perPaymentMaxAtomic: bigint };

export interface SignArgs {
  db: Database;
  ownerId: string;
  decisionId: string;
  payment: CanonicalPayment;
  masterSecretHex: string;
  chain: Chain;
  now: Date;
}

/**
 * Set as the owner's auto_paused_reason when the purse derived from the master secret is not
 * the purse on record: the master secret has changed, so no payment may go out until a person
 * looks, and the money in the recorded purse is not lost.
 */
export const PURSE_KEY_MISMATCH = 'purse_key_mismatch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

// Each side of every comparison goes through the same SDK normaliser that produced the
// canonical payment (standard 2), and anything it cannot read compares unequal.
function sameAddress(a: string, b: string): boolean {
  try {
    return canonicalSuiAddress(a) === canonicalSuiAddress(b);
  } catch {
    return false;
  }
}

function sameAsset(a: string, b: string): boolean {
  try {
    return normalizeStructTag(a) === normalizeStructTag(b);
  } catch {
    return false;
  }
}

function decidedThis(decision: typeof decisions.$inferSelect, payment: CanonicalPayment): boolean {
  return (
    sameAddress(decision.recipient, payment.recipient) &&
    decision.amountAtomic === payment.amount &&
    sameAsset(decision.asset, payment.asset) &&
    decision.network === payment.network
  );
}

/**
 * Turns one open, approved decision into a signed payment from the owner's own purse, with
 * the pause, the per-payment maximum and the daily budget checked, and the budget debited,
 * in the same step (C4, C6, C7, C8).
 *
 * Before any lock: reads the chain's current epoch and the recorded purse's USDC address
 * balance; a balance below the amount is 'purse_short'. Then in one transaction: locks the
 * owner row FOR UPDATE and the decision row after it, in the order every other writer takes
 * them. The decision must be this owner's, 'open', and name the canonical payment's
 * recipient, amount, asset and network ('not_open' otherwise). An owner that is paused or has
 * an auto_paused_reason is 'paused', and an amount over per_payment_max_atomic is
 * 'over_payment_max'; either way the decision becomes 'refused' in the same transaction.
 * Everything this owner signed in the 24 hours before `now` and has not released counts,
 * settled or not; going past daily_budget_atomic is 'over_daily_budget'. The purse key is
 * derived from the master secret and the owner's address, and must give the recorded purse
 * address: if it does not, the owner's auto_paused_reason is set to PURSE_KEY_MISMATCH, that
 * is committed, and the answer is 'not_open'. Then core's signPayment builds, checks and signs the plain USDC send (its
 * EXPIRED and WRONG_EPOCH become 'expired' and 'wrong_epoch'), the payments row is written
 * with the digest of the signed bytes and the challenge's maxEpoch as valid_until_epoch, and
 * the decision becomes 'paid'. Nothing is sent anywhere.
 *
 * Throws ChainError from the two reads, and PaymentError for a payment core cannot build
 * (UNSUPPORTED_DIALECT, BUILD_FAILED, MISMATCH); either way nothing is written.
 */
export async function signForDecision(args: SignArgs): Promise<SignResult> {
  const { db, payment, now, chain } = args;
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId) || typeof args.decisionId !== 'string' || !UUID.test(args.decisionId)) {
    return { refusal: 'not_open' };
  }
  if (typeof payment?.amount !== 'bigint' || payment.amount <= 0n) return { refusal: 'not_open' };
  // signPayment calls an unreadable time expired too, and the budget window needs a real one.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { refusal: 'expired' };
  const ownerId = args.ownerId.toLowerCase();
  const decisionId = args.decisionId.toLowerCase();

  const [recorded] = await db.select({ purseAddress: owners.purseAddress }).from(owners).where(eq(owners.id, ownerId));
  if (recorded === undefined) return { refusal: 'not_open' };
  // Read before the transaction so no row lock is held while Tatum answers.
  const epoch = await chain.getCurrentEpoch();
  const { usdcAddressBalance } = await chain.getBalances(recorded.purseAddress);
  // A gasless send redeems from the address balance only, so coins at the purse do not count.
  if (usdcAddressBalance < payment.amount) return { refusal: 'purse_short' };

  return db.transaction(async (tx): Promise<SignResult> => {
    const [owner] = await tx
      .select({
        suiAddress: owners.suiAddress,
        purseAddress: owners.purseAddress,
        paused: owners.paused,
        autoPausedReason: owners.autoPausedReason,
        perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
        dailyBudgetAtomic: owners.dailyBudgetAtomic,
      })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .for('update');
    if (owner === undefined) return { refusal: 'not_open' };
    const thisDecision = and(eq(decisions.id, decisionId), eq(decisions.ownerId, ownerId));
    const [decision] = await tx.select().from(decisions).where(thisDecision).for('update');
    if (decision === undefined || decision.status !== 'open' || !decidedThis(decision, payment)) return { refusal: 'not_open' };

    // decide read these settings before its recall, so a pause (a settlement mismatch, or the
    // owner's own) or a lower maximum set since then is caught only here, under the lock (C4, C8).
    const refuse = () => tx.update(decisions).set({ status: 'refused' }).where(and(thisDecision, eq(decisions.status, 'open')));
    if (owner.paused || owner.autoPausedReason !== null) {
      await refuse();
      return { refusal: 'paused' };
    }
    if (payment.amount > owner.perPaymentMaxAtomic) {
      await refuse();
      return { refusal: 'over_payment_max', perPaymentMaxAtomic: owner.perPaymentMaxAtomic };
    }

    // Read under the owner lock, so a payment signed by a racing call is already counted here.
    const [spent] = await tx
      .select({ total: sql<string>`coalesce(sum(${payments.amountAtomic}), 0)::text` })
      .from(payments)
      .where(and(eq(payments.ownerId, ownerId), gte(payments.signedAt, new Date(now.getTime() - DAY_MS)), isNull(payments.releasedAt)));
    if (BigInt(spent?.total ?? '0') + payment.amount > owner.dailyBudgetAtomic) return { refusal: 'over_daily_budget' };

    const purse = derivePurseKeypair(args.masterSecretHex, owner.suiAddress);
    if (!sameAddress(purse.toSuiAddress(), owner.purseAddress)) {
      await tx.update(owners).set({ autoPausedReason: PURSE_KEY_MISMATCH }).where(eq(owners.id, ownerId));
      return { refusal: 'not_open' };
    }

    let signed: SignedPayment;
    try {
      signed = await signPayment(payment, purse, now.getTime(), epoch);
    } catch (error) {
      if (error instanceof PaymentError && error.code === 'EXPIRED') return { refusal: 'expired' };
      if (error instanceof PaymentError && error.code === 'WRONG_EPOCH') return { refusal: 'wrong_epoch' };
      throw error;
    }
    const validUntilEpoch = payment.maxEpoch;
    // signPayment refuses a payment with no epoch window, so this only narrows the type.
    if (validUntilEpoch === null) throw new PaymentError('BUILD_FAILED', 'the epoch window is missing');

    await tx.insert(payments).values({
      decisionId,
      ownerId,
      purseAddress: owner.purseAddress,
      recipient: decision.recipient,
      amountAtomic: payment.amount,
      digest: signed.digest,
      txBytesBase64: signed.txBytesBase64,
      signedAt: now,
      validUntilEpoch,
    });
    await tx.update(decisions).set({ status: 'paid' }).where(and(thisDecision, eq(decisions.status, 'open')));
    return { signed };
  });
}
