import { AsyncLocalStorage } from 'node:async_hooks';
import type { BeforeTatumRequest } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import type { Database } from '../db/client.js';
import { consumeShared, consumeWindow } from './ratelimit.js';

/**
 * Who a request to Tatum is charged to. 'jobs' is the scheduled tick and the operator's scripts.
 * 'person' is anything a caller started: an anonymous caller by its client key alone, a
 * signed-in owner or an agent with that owner's id as well.
 */
export type TatumScope = { readonly kind: 'jobs' } | { readonly kind: 'person'; readonly clientKey: string; readonly ownerId?: string };

const CLIENT_DAY_KEY_PREFIX = 'tatum-client-day:';
const OWNER_DAY_KEY_PREFIX = 'tatum-owner-day:';
const PERSON_QUOTA = 'tatum-calls:day';
const JOBS_QUOTA = 'tatum-jobs-calls:day';

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
 * run. Returns what `run` returns. Throws Error for a person scope with an empty client key or an
 * empty owner id, which is a server bug.
 */
export function withTatumScope<T>(scope: TatumScope, run: () => T): T {
  let fixed: TatumScope;
  if (scope.kind === 'jobs') {
    fixed = { kind: 'jobs' };
  } else {
    if (typeof scope.clientKey !== 'string' || scope.clientKey === '') throw new Error('a person scope needs a client key');
    if (scope.ownerId !== undefined && (typeof scope.ownerId !== 'string' || scope.ownerId === '')) throw new Error('an owner id in a scope cannot be empty');
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

/**
 * The beforeRequest hook for createChain: counts each request to Tatum, every page and retry,
 * against the budgets of the scope it runs in, in fixed UTC days (LIMITS.rateWindowDayMs), in
 * `db` (C22, C34).
 * - Outside any scope it refuses, logging the fixed code no_scope: a path that cannot say who it
 *   runs for must not spend anyone's credits.
 * - 'jobs' counts one of LIMITS.tatumCallsJobsPerDay, a budget of its own, so strangers spending
 *   the shared day cannot stop settlement and refills, and the tick spends none of theirs.
 * - 'person' counts one each, in this order, of LIMITS.tatumCallsPerClientPerDay for its client
 *   key, LIMITS.tatumCallsPerOwnerPerDay for its owner when it names one, and
 *   LIMITS.tatumCallsPerDayGlobal shared by every person. It stops at the first one passed, so a
 *   caller past its own limit spends nothing after it.
 * A request over a limit still counts toward that limit. A refusal throws Error with fixed text,
 * which createChain turns into ChainError BUDGET with nothing sent. A client or owner refusal logs
 * a fixed code each time; a shared budget (the persons' or the jobs') logs its name once, at its
 * first refusal in a day. A database failure throws as well, so no request is sent uncounted.
 */
export function tatumMeter(db: Database, now: () => Date): BeforeTatumRequest {
  return async () => {
    const scope = currentTatumScope();
    if (scope === undefined) {
      console.error('[ellai tatum] no_scope');
      throw refusal();
    }
    const at = now();
    if (scope.kind === 'jobs') return sharedTurn(db, JOBS_QUOTA, LIMITS.tatumCallsJobsPerDay, at);
    if (!(await consumeWindow(db, `${CLIENT_DAY_KEY_PREFIX}${scope.clientKey}`, LIMITS.tatumCallsPerClientPerDay, LIMITS.rateWindowDayMs, at))) {
      console.warn('[ellai tatum] client rate_limited_today');
      throw refusal();
    }
    // Owner ids come out of the database in one case already; lower-casing keeps any other
    // spelling from opening a second count.
    const ownerKey = scope.ownerId?.toLowerCase();
    if (ownerKey !== undefined && !(await consumeWindow(db, `${OWNER_DAY_KEY_PREFIX}${ownerKey}`, LIMITS.tatumCallsPerOwnerPerDay, LIMITS.rateWindowDayMs, at))) {
      console.warn('[ellai tatum] owner rate_limited_today');
      throw refusal();
    }
    return sharedTurn(db, PERSON_QUOTA, LIMITS.tatumCallsPerDayGlobal, at);
  };
}
