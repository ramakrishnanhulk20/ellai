import { createHash } from 'node:crypto';
import { lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { rateCounters } from '../db/schema.js';
import { clientKey } from './client.js';
import { HttpError } from './errors.js';

const MINUTE_MS = 60_000;
// Every key is stored as this prefix and a SHA-256, so a row never holds a client address
// in clear, always fits the column cap, and cannot collide with the seller's own counters.
const STORED_KEY_PREFIX = 'http:';

/** Sign-in requests allowed in one fixed minute, for each step (nonce and verify) separately. */
export const SIGN_IN_RATE_LIMITS = {
  perClientPerMinute: 10,
  globalPerMinute: 300,
} as const;

/**
 * Counts one request against `key` in the fixed minute that holds `now`, and says whether it
 * is within `perMinute`. The count is one atomic upsert, so concurrent requests can never
 * both read the old count. A request over the limit is still counted, so hammering does not
 * reset anything. Throws Error for an empty key, a limit that is not a positive integer, or
 * a `now` that is not a date.
 */
export async function consume(db: Database, key: string, perMinute: number, now: Date): Promise<boolean> {
  if (typeof key !== 'string' || key === '') throw new Error('the rate key is missing');
  if (!Number.isInteger(perMinute) || perMinute < 1) throw new Error('the rate limit must be a positive integer');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  const windowStart = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
  const stored = `${STORED_KEY_PREFIX}${createHash('sha256').update(key, 'utf8').digest('hex')}`;
  const [counter] = await db
    .insert(rateCounters)
    .values({ key: stored, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateCounters.key, rateCounters.windowStart], set: { count: sql`${rateCounters.count} + 1` } })
    .returning({ count: rateCounters.count });
  if (counter === undefined) throw new Error('the rate counter returned no row');
  return counter.count <= perMinute;
}

/**
 * Deletes every rate counter, the seller's included, whose window started before `before`, and
 * returns how many it deleted. Every limit counts one fixed minute, so a window that old can no
 * longer turn anyone away; this only keeps the table from growing. Throws Error for a `before`
 * that is not a date.
 */
export async function pruneRateCounters(db: Database, before: Date): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) throw new Error('The cut-off time is not a date');
  const deleted = await db.delete(rateCounters).where(lt(rateCounters.windowStart, before)).returning({ key: rateCounters.key });
  return deleted.length;
}

/**
 * Holds one sign-in step to SIGN_IN_RATE_LIMITS: first for this client, keyed on the address
 * the platform vouches for (C22), then for everyone together. A client already over its own
 * limit is turned away before it can spend the shared one.
 * Throws HttpError 429 rate_limited when either limit is passed.
 */
export async function limitSignIn(db: Database, request: Request, step: 'nonce' | 'verify', now: Date): Promise<void> {
  const ownTurn = await consume(db, `signin:${step}:client:${clientKey(request)}`, SIGN_IN_RATE_LIMITS.perClientPerMinute, now);
  if (!ownTurn || !(await consume(db, `signin:${step}:global`, SIGN_IN_RATE_LIMITS.globalPerMinute, now))) {
    throw new HttpError(429, 'rate_limited');
  }
}
