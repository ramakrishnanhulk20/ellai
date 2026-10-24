import { type Chain, ChainError, type TransactionResult } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { verifySettlement } from '@ellai/core/payment';
import { and, eq } from 'drizzle-orm';
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
}

/** Set as the owner's auto_paused_reason when a payment landed and was not the approved one (C8). */
export const SETTLEMENT_MISMATCH = 'settlement_mismatch';

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
 * and the owner's recorded purse: 'verified' sets verified_at; 'mismatch' stores verifySettlement's
 * fixed reason and, in the same transaction, sets the owner's auto_paused_reason to
 * SETTLEMENT_MISMATCH, so decide refuses every later payment until the owner reviews it. When
 * every read missed, the chain's epoch is read: only once it is past valid_until_epoch, and
 * LIMITS.paymentReleaseReads further reads taken after it all still miss, is the payment
 * 'not_landed', with released_at set so it stops counting against the daily budget. Any other
 * chain error, or a window still open, leaves 'pending' for a later pass.
 *
 * A payment already past 'pending' is returned as it is. Writes only from 'pending', so two
 * passes never overwrite each other. Throws for an unknown payment or tries out of range.
 */
export async function settlePayment(args: SettleArgs): Promise<Settlement> {
  const { db, chain, sleep } = args;
  if (!Number.isSafeInteger(args.tries) || args.tries < 1 || args.tries > LIMITS.settlementPollTries) {
    throw new RangeError(`tries must be 1 to ${LIMITS.settlementPollTries}`);
  }
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId) || typeof args.paymentId !== 'string' || !UUID.test(args.paymentId)) {
    throw new Error('there is no such payment for this owner');
  }
  const ownerId = args.ownerId.toLowerCase();
  const paymentId = args.paymentId.toLowerCase();

  const [row] = await db
    .select({ payment: payments, decision: decisions, purseAddress: owners.purseAddress })
    .from(payments)
    .innerJoin(decisions, and(eq(decisions.id, payments.decisionId), eq(decisions.ownerId, payments.ownerId)))
    .innerJoin(owners, eq(owners.id, payments.ownerId))
    .where(and(eq(payments.id, paymentId), eq(payments.ownerId, ownerId)));
  if (row === undefined) throw new Error('there is no such payment for this owner');
  if (row.payment.settlement !== 'pending') return row.payment.settlement;

  const { decision, purseAddress } = row;
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

  const judge = async (result: TransactionResult): Promise<Settlement> => {
    const verdict = verifySettlement(result, approved, purseAddress);
    if (verdict.verified) {
      const done = await db.update(payments).set({ settlement: 'verified', verifiedAt: new Date() }).where(stillPending).returning({ id: payments.id });
      return done.length > 0 ? 'verified' : stored(db, ownerId, paymentId);
    }
    const marked = await db.transaction(async (tx) => {
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
      const done = await tx
        .update(payments)
        .set({ settlement: 'mismatch', mismatchReason: verdict.reason })
        .where(stillPending)
        .returning({ id: payments.id });
      if (done.length === 0) return false;
      await tx.update(owners).set({ autoPausedReason: SETTLEMENT_MISMATCH }).where(eq(owners.id, ownerId));
      return true;
    });
    return marked ? 'mismatch' : stored(db, ownerId, paymentId);
  };

  const { digest, validUntilEpoch } = row.payment;
  for (let attempt = 0; attempt < args.tries; attempt++) {
    if (attempt > 0) await sleep(args.intervalMs);
    const seen = await read(chain, digest);
    if (seen.kind === 'unknown') return 'pending';
    if (seen.kind === 'landed') return judge(seen.result);
  }

  let epoch: bigint;
  try {
    epoch = await chain.getCurrentEpoch();
  } catch {
    return 'pending';
  }
  if (epoch <= validUntilEpoch) return 'pending';
  // One lagging node must not release a payment that landed in the last moments of its window.
  for (let attempt = 0; attempt < LIMITS.paymentReleaseReads; attempt++) {
    await sleep(args.intervalMs);
    const seen = await read(chain, digest);
    if (seen.kind === 'unknown') return 'pending';
    if (seen.kind === 'landed') return judge(seen.result);
  }
  const released = await db
    .update(payments)
    .set({ settlement: 'not_landed', releasedAt: new Date() })
    .where(stillPending)
    .returning({ id: payments.id });
  return released.length > 0 ? 'not_landed' : stored(db, ownerId, paymentId);
}
