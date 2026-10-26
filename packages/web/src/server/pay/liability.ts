import { LIMITS } from '@ellai/core/limits';
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payments } from '../db/schema.js';

/**
 * The one definition of what counts against an owner's daily budget (C4). Signing reads it under
 * the owner lock, and decide's pre-check reads it too, so the two never disagree about what is
 * left.
 *
 * The sum, in atomic USDC, of every payment of this owner that has not been released and that
 * either is still settlement 'pending', however long ago it was signed, or was signed or
 * verified in the LIMITS.dailyBudgetWindowMs before `now`, whatever its settlement. A pending
 * payment's signed bytes can land until its epoch window (valid_until_epoch) closes, which on Sui
 * Mainnet can be close to 48 hours after signing, so age alone never frees its share (A1-1). A
 * settled payment counts from the later of signed_at and verified_at, so one that landed late
 * still holds a full day of budget from the moment the money moved (C25). Only settlePayment's
 * release, made once that window has closed and the chain shows the bytes did not land, takes a
 * payment out of the sum.
 *
 * Pass a transaction that holds the owner row FOR UPDATE to see a payment a racing call has just
 * committed. Throws Error for a `now` that is not a date; database errors pass through.
 */
export async function heldOrSpentAtomic(db: Pick<Database, 'select'>, ownerId: string, now: Date): Promise<bigint> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('the current time is not a date');
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${payments.amountAtomic}), 0)::text` })
    .from(payments)
    .where(
      and(
        eq(payments.ownerId, ownerId),
        isNull(payments.releasedAt),
        or(
          eq(payments.settlement, 'pending'),
          // The later of the two is inside the window exactly when either is; a null verified_at matches nothing.
          gte(payments.signedAt, new Date(now.getTime() - LIMITS.dailyBudgetWindowMs)),
          gte(payments.verifiedAt, new Date(now.getTime() - LIMITS.dailyBudgetWindowMs)),
        ),
      ),
    );
  return BigInt(row?.total ?? '0');
}
