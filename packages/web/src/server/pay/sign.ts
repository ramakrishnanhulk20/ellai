import type { Chain } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { PaymentError, type SignedPayment, signPayment } from '@ellai/core/payment';
import { KNOWN_SELLERS } from '@ellai/core/sellers';
import { normalizeStructTag } from '@mysten/sui/utils';
import { and, eq, gt, ne, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agents, decisions, owners, payments } from '../db/schema.js';
import { heldOrSpentAtomic } from './liability.js';

/** The database, or a transaction open on it. */
export type DbHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export type SignRefusal =
  | 'expired'
  | 'wrong_epoch'
  | 'agent_revoked'
  | 'paused'
  | 'over_payment_max'
  | 'over_daily_budget'
  | 'purse_short'
  | 'not_open'
  | 'in_flight';

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
  /** Read once, after the chain reads and under the owner lock. */
  now: () => Date;
}

/**
 * Set as the owner's auto_paused_reason when the purse derived from the master secret is not
 * the purse on record: the master secret has changed, so no payment may go out until a person
 * looks, and the money in the recorded purse is not lost.
 */
export const PURSE_KEY_MISMATCH = 'purse_key_mismatch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function normalizedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** How long a paid request may run: the recorded patience of a known seller, else the default (C21). */
export function paidTimeoutMs(sellerUrl: string): number {
  const target = normalizedUrl(sellerUrl);
  const known = KNOWN_SELLERS.find((seller) => target !== null && normalizedUrl(seller.url) === target);
  return known?.paidTimeoutMs ?? LIMITS.netPaidTimeoutDefaultMs;
}

/**
 * True when this owner already signed a payment for this request key that may still be under
 * way: its decision is 'paid' (and is not `excludeDecisionId`), it has not been released as
 * 'not_landed', and either its settlement is still 'pending' or it was signed less than the
 * price's validity, plus the seller's paid patience, plus the inline settlement reads ago (C5).
 * A pending payment counts whatever its age: Sui refuses a timestamp bound on a gasless send, so
 * its bytes can land until its epoch window (valid_until_epoch) closes, and only settlePayment,
 * once that window has closed, releases it or records how it landed (A1-2). The time window
 * covers a payment that has landed while the paid call that sent it may still be running. A
 * 'paid' decision has left decide's live statuses, so decide alone would decide and sign the
 * same request again. Pass a transaction that holds the owner lock to read every payment a
 * racing call has already committed.
 */
export async function paymentInFlight(db: DbHandle, ownerId: string, key: string, sellerUrl: string, now: Date, excludeDecisionId?: string): Promise<boolean> {
  const windowMs = LIMITS.paymentValidityMs + paidTimeoutMs(sellerUrl) + LIMITS.settlementInlineTries * LIMITS.settlementInlineIntervalMs;
  const [row] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .innerJoin(payments, and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId)))
    .where(
      and(
        eq(decisions.ownerId, ownerId),
        eq(decisions.requestKey, key),
        eq(decisions.status, 'paid'),
        excludeDecisionId === undefined ? undefined : ne(decisions.id, excludeDecisionId),
        ne(payments.settlement, 'not_landed'),
        or(eq(payments.settlement, 'pending'), gt(payments.signedAt, new Date(now.getTime() - windowMs))),
      ),
    )
    .limit(1);
  return row !== undefined;
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
 * the pause, the per-payment maximum, a payment already under way for the same request, and
 * the daily budget checked, and the budget debited, in the same step (C4, C5, C6, C7, C8).
 *
 * Before any lock: reads the chain's current epoch and the recorded purse's USDC address
 * balance; a balance below the amount is 'purse_short'. Then in one transaction: locks the
 * owner row FOR UPDATE and the decision row after it, in the order every other writer takes
 * them. The decision must be this owner's, 'open', and name the canonical payment's
 * recipient, amount, asset and network ('not_open' otherwise). Only then is `now` read, once:
 * that reading is the time the price's expiry is checked against, the end of the budget
 * window, and the stored signed_at, so the time spent on the reads and the lock waits counts
 * against the price; an unreadable time is 'expired'. A decision whose agent has been revoked
 * (or is not this owner's) is 'agent_revoked', an owner that is paused or has an
 * auto_paused_reason is 'paused', and an amount over per_payment_max_atomic is
 * 'over_payment_max'; each way the decision becomes 'refused' in the same transaction.
 * Another decision under the decision's own stored request key with a payment that may still
 * be under way (paymentInFlight, read under the lock) is 'in_flight', and the decision becomes
 * 'failed' in the same transaction (C5). What counts against the budget is heldOrSpentAtomic,
 * read under the lock: every unreleased payment still pending whatever its age, and everything
 * else signed in the last 24 hours and not released; going past daily_budget_atomic with this
 * payment is 'over_daily_budget'. The purse key is
 * derived from the master secret and the owner's address, and must give the recorded purse
 * address: if it does not, the owner's auto_paused_reason is set to PURSE_KEY_MISMATCH, that
 * is committed, and the answer is 'not_open'. Then core's signPayment builds, checks and signs the plain USDC send (its
 * EXPIRED and WRONG_EPOCH become 'expired' and 'wrong_epoch'), the payments row is written
 * with the digest of the signed bytes, the challenge's maxEpoch as valid_until_epoch and `now`
 * as both signed_at and outcome_at (C32), and the decision becomes 'paid'. Nothing is sent
 * anywhere.
 *
 * Throws ChainError from the two reads, and PaymentError for a payment core cannot build
 * (UNSUPPORTED_DIALECT, BUILD_FAILED, MISMATCH); either way nothing is written.
 */
export async function signForDecision(args: SignArgs): Promise<SignResult> {
  const { db, payment, chain } = args;
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId) || typeof args.decisionId !== 'string' || !UUID.test(args.decisionId)) {
    return { refusal: 'not_open' };
  }
  if (typeof payment?.amount !== 'bigint' || payment.amount <= 0n) return { refusal: 'not_open' };
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

    // Taken after both Tatum reads and the lock waits, so time they used counts against the
    // price's expiry, and this one reading is the expiry check, the budget window and signed_at.
    const now = args.now();
    // signPayment calls an unreadable time expired too, and the budget window needs a real one.
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { refusal: 'expired' };

    const close = (status: 'refused' | 'failed') => tx.update(decisions).set({ status }).where(and(thisDecision, eq(decisions.status, 'open')));
    // decide checked the agent before its recall. revokeAgent takes the owner lock too, so a
    // revocation committed since then is seen here, and no payment is signed for it (C13).
    const [agent] = await tx
      .select({ revokedAt: agents.revokedAt })
      .from(agents)
      .where(and(eq(agents.id, decision.agentId), eq(agents.ownerId, ownerId)));
    if (agent === undefined || agent.revokedAt !== null) {
      await close('refused');
      return { refusal: 'agent_revoked' };
    }
    // decide read these settings before its recall, so a pause (a settlement mismatch, or the
    // owner's own) or a lower maximum set since then is caught only here, under the lock (C4, C8).
    if (owner.paused || owner.autoPausedReason !== null) {
      await close('refused');
      return { refusal: 'paused' };
    }
    if (payment.amount > owner.perPaymentMaxAtomic) {
      await close('refused');
      return { refusal: 'over_payment_max', perPaymentMaxAtomic: owner.perPaymentMaxAtomic };
    }
    // flow's early check can run while a twin request is still 'open'; once that twin is paid,
    // decide opens this decision afresh. Every signature for this owner takes this lock, so a
    // twin signed first is committed and seen here (C5).
    if (await paymentInFlight(tx, ownerId, decision.requestKey, decision.sellerUrl, now, decisionId)) {
      await close('failed');
      return { refusal: 'in_flight' };
    }

    // Read under the owner lock, so a payment signed by a racing call is already counted here.
    if ((await heldOrSpentAtomic(tx, ownerId, now)) + payment.amount > owner.dailyBudgetAtomic) return { refusal: 'over_daily_budget' };

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
      outcomeAt: now,
      validUntilEpoch,
    });
    await tx.update(decisions).set({ status: 'paid' }).where(and(thisDecision, eq(decisions.status, 'open')));
    return { signed };
  });
}
