import { LIMITS } from '@ellai/core/limits';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sellerSales, sessions, signinNonces } from '../db/schema.js';

export interface PruneSummary {
  signinNonces: number;
  sellerSales: number;
  sessions: number;
}

/**
 * Deletes rows anonymous traffic leaves behind that can never be used again, at most
 * LIMITS.pruneBatch per table per call, oldest first, so the tables stay bounded however many
 * strangers ask for a sign-in or a challenge (C22):
 * - sign-in nonces whose expiry is before `now`, used or not: completeSignIn refuses an
 *   expired nonce, so the row decides nothing any more;
 * - Ellai's seller sales still 'issued' with no digest whose expiry is before `now`: a sale is
 *   claimed by leaving 'issued' while unexpired, so these were never paid;
 * - sessions that expired, or were revoked, more than LIMITS.endedSessionKeepMs before `now`.
 * Returns how many rows each table lost. Throws for a time that is not a date.
 */
export async function pruneExpiredRows(args: { db: Database; now: Date }): Promise<PruneSummary> {
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, now } = args;
  const endedBefore = new Date(now.getTime() - LIMITS.endedSessionKeepMs);

  const expired = lt(signinNonces.expiresAt, now);
  const nonces = await db
    .delete(signinNonces)
    .where(and(expired, inArray(signinNonces.nonce, db.select({ nonce: signinNonces.nonce }).from(signinNonces).where(expired).orderBy(signinNonces.expiresAt).limit(LIMITS.pruneBatch))))
    .returning({ nonce: signinNonces.nonce });

  const unpaid = and(eq(sellerSales.status, 'issued'), isNull(sellerSales.digest), lt(sellerSales.expiresAt, now));
  const sales = await db
    .delete(sellerSales)
    .where(and(unpaid, inArray(sellerSales.id, db.select({ id: sellerSales.id }).from(sellerSales).where(unpaid).orderBy(sellerSales.expiresAt).limit(LIMITS.pruneBatch))))
    .returning({ id: sellerSales.id });

  const ended = or(lt(sessions.expiresAt, endedBefore), lt(sessions.revokedAt, endedBefore));
  const oldSessions = await db
    .delete(sessions)
    .where(and(ended, inArray(sessions.id, db.select({ id: sessions.id }).from(sessions).where(ended).orderBy(sessions.expiresAt).limit(LIMITS.pruneBatch))))
    .returning({ id: sessions.id });

  return { signinNonces: nonces.length, sellerSales: sales.length, sessions: oldSessions.length };
}
