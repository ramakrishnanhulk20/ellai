import { createHash } from 'node:crypto';
import { LIMITS } from '@ellai/core/limits';
import { lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { rateCounters } from '../db/schema.js';
import { clientKey } from './client.js';
import { HttpError } from './errors.js';

const MS_PER_SECOND = 1_000;
// Every key is stored as this prefix and a SHA-256, so a row never holds a client address
// in clear, always fits the column cap, and cannot collide with the seller's own counters.
const STORED_KEY_PREFIX = 'http:';
// A quota every caller shares is named under this prefix before hashing, so no per-client key
// can ever land on the same counter.
const SHARED_KEY_PREFIX = 'shared:';

export interface SharedTurn {
  allowed: boolean;
  /** Whole seconds, at least 1, until the window that was counted ends. */
  retryAfterSeconds: number;
}

/**
 * Counts one request against `key` in the fixed window of `windowMs` that holds `now`, and says
 * whether it is within `limit`. The count is one atomic upsert, so concurrent requests can never
 * both read the old count. A request over the limit is still counted, so hammering does not
 * reset anything. Throws Error for an empty key, a limit that is not a positive integer, a
 * `now` that is not a date, or a window that is not a whole number of milliseconds shorter
 * than LIMITS.rateCounterRetentionMs, since pruneRateCounters could delete a longer window
 * while it is still counting.
 */
export async function consumeWindow(db: Database, key: string, limit: number, windowMs: number, now: Date): Promise<boolean> {
  if (typeof key !== 'string' || key === '') throw new Error('the rate key is missing');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('the rate limit must be a positive integer');
  if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs >= LIMITS.rateCounterRetentionMs) {
    throw new Error('the rate window must be a whole number of milliseconds shorter than the counter retention');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const stored = `${STORED_KEY_PREFIX}${createHash('sha256').update(key, 'utf8').digest('hex')}`;
  const [counter] = await db
    .insert(rateCounters)
    .values({ key: stored, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateCounters.key, rateCounters.windowStart], set: { count: sql`${rateCounters.count} + 1` } })
    .returning({ count: rateCounters.count });
  if (counter === undefined) throw new Error('the rate counter returned no row');
  return counter.count <= limit;
}

/** consumeWindow over the fixed minute (LIMITS.rateWindowMinuteMs) that holds `now`, with the same refusals. */
export async function consume(db: Database, key: string, perMinute: number, now: Date): Promise<boolean> {
  return consumeWindow(db, key, perMinute, LIMITS.rateWindowMinuteMs, now);
}

/**
 * Counts one use of the quota `name` that every caller shares, the global cap that stands
 * behind a per-client one (C22), in the fixed window of `windowMs` that holds `now`. The count
 * is consumeWindow's, with its refusals, under a key no per-client key can equal. Count the
 * caller's own limit first, so a caller already over it never spends the shared one.
 * Returns whether this use is within `limit` and how long until the window ends.
 * Throws Error for an empty name, or for anything consumeWindow refuses.
 */
export async function consumeShared(db: Database, name: string, limit: number, windowMs: number, now: Date): Promise<SharedTurn> {
  if (typeof name !== 'string' || name === '') throw new Error('the quota name is missing');
  const allowed = await consumeWindow(db, `${SHARED_KEY_PREFIX}${name}`, limit, windowMs, now);
  const windowEndMs = (Math.floor(now.getTime() / windowMs) + 1) * windowMs;
  return { allowed, retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - now.getTime()) / MS_PER_SECOND)) };
}

/**
 * Deletes every rate counter, the seller's and the built-in agent's included, whose window
 * started more than LIMITS.rateCounterRetentionMs before `now`, and returns how many it deleted.
 * The retention is longer than the longest window any counter is read over (the agent run's
 * day), so a window that can still turn anyone away is never deleted; this only keeps the table
 * from growing. `now` is the current time: the cut-off is always worked out here from the
 * retention, and a caller passing an earlier time, as an older cut-off, only keeps rows longer.
 * Throws Error for a `now` that is not a date.
 */
export async function pruneRateCounters(db: Database, now: Date): Promise<number> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  const cutoff = new Date(now.getTime() - LIMITS.rateCounterRetentionMs);
  const deleted = await db.delete(rateCounters).where(lt(rateCounters.windowStart, cutoff)).returning({ key: rateCounters.key });
  return deleted.length;
}

/**
 * Holds one sign-in step to LIMITS.signInRequestsPerMinute for this client, keyed on the address
 * the platform vouches for (C22), then to LIMITS.signInRequestsPerMinuteGlobal for everyone
 * together. A client already over its own limit is turned away before it can spend the shared one.
 * Throws HttpError 429 rate_limited when either limit is passed.
 */
export async function limitSignIn(db: Database, request: Request, step: 'nonce' | 'verify', now: Date): Promise<void> {
  const ownTurn = await consume(db, `signin:${step}:client:${clientKey(request)}`, LIMITS.signInRequestsPerMinute, now);
  if (!ownTurn || !(await consume(db, `signin:${step}:global`, LIMITS.signInRequestsPerMinuteGlobal, now))) {
    throw new HttpError(429, 'rate_limited');
  }
}
