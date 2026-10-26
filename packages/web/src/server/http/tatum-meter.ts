import { AsyncLocalStorage } from 'node:async_hooks';
import type { BeforeTatumRequest } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import type { Database } from '../db/client.js';
import { consumeShared, consumeWindow } from './ratelimit.js';

/**
 * Who a request to Tatum is charged to. 'jobs' is the scheduled tick and the operator's scripts,
 * with the owner whose visit the tick is on when it is on one. 'refills' is the tick's refill step,
 * whichever owner it is for. 'person' is anything a caller started: an anonymous caller by its
 * client key alone, a signed-in owner or an agent with that owner's id as well.
 */
export type TatumScope =
  | { readonly kind: 'jobs'; readonly ownerId?: string }
  | { readonly kind: 'refills' }
  | { readonly kind: 'person'; readonly clientKey: string; readonly ownerId?: string };

const CLIENT_DAY_KEY_PREFIX = 'tatum-client-day:';
const OWNER_DAY_KEY_PREFIX = 'tatum-owner-day:';
const JOBS_OWNER_DAY_KEY_PREFIX = 'tatum-jobs-owner-day:';
const PERSON_QUOTA = 'tatum-calls:day';
const ANONYMOUS_QUOTA = 'tatum-anonymous-calls:day';
const JOBS_QUOTA = 'tatum-jobs-calls:day';
const REFILLS_QUOTA = 'tatum-refills-calls:day';

// Kept on globalThis, as context.ts keeps its shared state: the Next dev server can load this
// module more than once, and a hook made by one copy must see the scope a route entered in another.
const SCOPE_STORE_KEY = '__ellaiTatumScope';

function scopes(): AsyncLocalStorage<TatumScope> {
  const holder = globalThis as unknown as Record<string, AsyncLocalStorage<TatumScope> | undefined>;
  holder[SCOPE_STORE_KEY] ??= new AsyncLocalStorage<TatumScope>();
  return holder[SCOPE_STORE_KEY];
}

/**
 * Runs `run` with `scope` as the one every Tatum request it starts is charged to, requests from
 * promises it leaves running included. A scope entered inside another replaces it for that inner
 * run. Returns what `run` returns. Throws Error for a person scope with an empty client key, or an
 * empty owner id in a jobs or person scope, which is a server bug.
 */
export function withTatumScope<T>(scope: TatumScope, run: () => T): T {
  if (scope.kind === 'refills') return scopes().run(Object.freeze({ kind: 'refills' as const }), run);
  if (scope.ownerId !== undefined && (typeof scope.ownerId !== 'string' || scope.ownerId === '')) throw new Error('an owner id in a scope cannot be empty');
  let fixed: TatumScope;
  if (scope.kind === 'jobs') {
    fixed = scope.ownerId === undefined ? { kind: 'jobs' } : { kind: 'jobs', ownerId: scope.ownerId };
  } else {
    if (typeof scope.clientKey !== 'string' || scope.clientKey === '') throw new Error('a person scope needs a client key');
    fixed = scope.ownerId === undefined ? { kind: 'person', clientKey: scope.clientKey } : { kind: 'person', clientKey: scope.clientKey, ownerId: scope.ownerId };
  }
  return scopes().run(Object.freeze(fixed), run);
}

/** The scope the calling code runs in, or undefined outside every withTatumScope. */
export function currentTatumScope(): TatumScope | undefined {
  return scopes().getStore();
}

const refusal = (): Error => new Error('the Tatum request budget refused this request');

async function sharedTurn(db: Database, quota: string, limit: number, now: Date): Promise<void> {
  const turn = await consumeShared(db, quota, limit, LIMITS.rateWindowDayMs, now);
  if (turn.allowed) return;
  if (turn.firstRefusal) console.error(`[ellai tatum] quota_spent ${quota}`);
  throw refusal();
}

// One caller's own day, so its refusal is logged every time, unlike a shared budget's.
async function ownTurn(db: Database, key: string, limit: number, now: Date, who: string): Promise<void> {
  if (await consumeWindow(db, key, limit, LIMITS.rateWindowDayMs, now)) return;
  console.warn(`[ellai tatum] ${who} rate_limited_today`);
  throw refusal();
}

/**
 * The beforeRequest hook for createChain: counts each request to Tatum, every page and retry,
 * against the budgets of the scope it runs in, in fixed UTC days (LIMITS.rateWindowDayMs), in
 * `db` (C22, C34).
 * - Outside any scope it refuses, logging the fixed code no_scope: a path that cannot say who it
 *   runs for must not spend anyone's credits.
 * - 'jobs' with an owner counts one of LIMITS.tatumCallsJobsPerOwnerPerDay for that owner first,
 *   so owners whose visits cost reads without paying cannot spend the shared jobs day that every
 *   other owner's settlement and refills need (C28). Then every 'jobs' request counts one of
 *   LIMITS.tatumCallsJobsPerDay, a budget of its own, so strangers spending the persons' day cannot
 *   stop settlement, and the tick spends none of theirs.
 * - 'refills' counts one of LIMITS.tatumCallsRefillsPerDay, shared by every owner's refill and
 *   apart from the jobs day and every owner's jobs share, so owners whose payments spend those
 *   cannot stop other owners' purses being refilled (C23, C28). Strangers cannot reach it either.
 * - 'person' counts one each, in this order, of LIMITS.tatumCallsPerClientPerDay for its client
 *   key; LIMITS.tatumCallsPerOwnerPerDay for its owner when it names one, or, when it names none,
 *   LIMITS.tatumCallsAnonymousPerDay shared by every caller with no owner, so strangers can never
 *   take the share owners need to sign; and LIMITS.tatumCallsPerDayGlobal shared by every person.
 * Each request stops at the first limit passed, so a caller past its own limit spends nothing after
 * it. A request over a limit still counts toward that limit. A refusal throws Error with fixed text,
 * which createChain turns into ChainError BUDGET with nothing sent. A client, owner or jobs owner
 * refusal logs a fixed code each time; a shared budget (the anonymous, the persons', the jobs' or
 * the refills') logs its name once, at its first refusal in a day. A database failure throws as well, so no
 * request is sent uncounted.
 */
export function tatumMeter(db: Database, now: () => Date): BeforeTatumRequest {
  return async () => {
    const scope = currentTatumScope();
    if (scope === undefined) {
      console.error('[ellai tatum] no_scope');
      throw refusal();
    }
    const at = now();
    if (scope.kind === 'refills') return sharedTurn(db, REFILLS_QUOTA, LIMITS.tatumCallsRefillsPerDay, at);
    // Owner ids come out of the database in one case already; lower-casing keeps any other
    // spelling from opening a second count.
    const ownerKey = scope.ownerId?.toLowerCase();
    if (scope.kind === 'jobs') {
      if (ownerKey !== undefined) await ownTurn(db, `${JOBS_OWNER_DAY_KEY_PREFIX}${ownerKey}`, LIMITS.tatumCallsJobsPerOwnerPerDay, at, 'jobs_owner');
      return sharedTurn(db, JOBS_QUOTA, LIMITS.tatumCallsJobsPerDay, at);
    }
    await ownTurn(db, `${CLIENT_DAY_KEY_PREFIX}${scope.clientKey}`, LIMITS.tatumCallsPerClientPerDay, at, 'client');
    if (ownerKey === undefined) await sharedTurn(db, ANONYMOUS_QUOTA, LIMITS.tatumCallsAnonymousPerDay, at);
    else await ownTurn(db, `${OWNER_DAY_KEY_PREFIX}${ownerKey}`, LIMITS.tatumCallsPerOwnerPerDay, at, 'owner');
    return sharedTurn(db, PERSON_QUOTA, LIMITS.tatumCallsPerDayGlobal, at);
  };
}
