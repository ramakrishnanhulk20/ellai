import { ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { z } from 'zod';
import type { ServerContext } from './context.js';
import { HttpError, httpErrorResponse, tooManyRequestsResponse } from './errors.js';
import { consume, consumeWindow } from './ratelimit.js';

/** Rows a history route reads for one page, whatever its limit, so cutPage can see past it. */
export const PAGE_READ = LIMITS.ownerPageMax + 1;

const OWNER_CHAIN_KEY_PREFIX = 'owner-chain:';
const AGENT_CREATE_KEY_PREFIX = 'owner-agent-create:';

/**
 * Counts one request to an owner route that reads Sui through Tatum against this owner's
 * LIMITS.ownerChainReadsPerMinute (C22). The key is the owner the session named, never
 * anything the caller sends, and every route that calls this shares it, so spreading calls
 * across routes buys nothing. A request over the limit still counts.
 * Returns null within the limit, and beyond it errors.ts's one 429 too_many_requests response,
 * which the route must return as it is.
 */
export async function limitOwnerChainReads(ctx: ServerContext, ownerId: string): Promise<Response | null> {
  if (await consume(ctx.db, `${OWNER_CHAIN_KEY_PREFIX}${ownerId}`, LIMITS.ownerChainReadsPerMinute, ctx.now())) return null;
  console.warn('[ellai http] owner_chain too_many_requests');
  return tooManyRequestsResponse();
}

/**
 * Counts one agent creation against this owner's LIMITS.agentCreatesPerHour, in the fixed hour
 * that holds the context's clock (C22). The key is the owner the session named, never anything
 * the caller sends, and a request over the limit still counts. Throws HttpError 429
 * too_many_agent_creates beyond the limit.
 */
export async function limitAgentCreates(ctx: ServerContext, ownerId: string): Promise<void> {
  if (!(await consumeWindow(ctx.db, `${AGENT_CREATE_KEY_PREFIX}${ownerId}`, LIMITS.agentCreatesPerHour, LIMITS.rateWindowHourMs, ctx.now()))) {
    throw new HttpError(429, 'too_many_agent_creates');
  }
}

/**
 * The one reading of an atomic amount sent as text, for every owner route that takes one: a
 * positive base-10 integer with no sign, point, exponent or leading zero, as C3 reads amounts,
 * and at most 19 digits, the width of the bigint columns. Outputs a bigint.
 */
export const atomicAmountText = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .transform((text) => BigInt(text));

// Ellai writes every time it keeps from a JavaScript Date, so no stored time is finer than a
// millisecond. A finer `before` would be cut to the millisecond and could hide rows, so it is
// refused rather than rounded.
const pageTime = z.iso.datetime().refine((text) => !/\.[0-9]{4,}Z$/.test(text));
const PAGE_LIMIT_TEXT = /^[1-9][0-9]{0,14}$/;

export interface PageQuery {
  /** Only rows created strictly before this time, or every row when null. */
  before: Date | null;
  /** Rows wanted on the page, from 1 to LIMITS.ownerPageMax. */
  limit: number;
}

function single(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
}

/**
 * Reads ?before=<ISO 8601 UTC time>&limit=<whole number> from a history route's URL. limit
 * defaults to LIMITS.ownerPageDefault and is cut to LIMITS.ownerPageMax. Returns null, which the route answers with
 * HttpError 400 bad_query, for a parameter given twice, a before that is not an ISO time in UTC to
 * at most the millisecond, or a limit that is not a whole number of at least 1. Other
 * parameters are ignored: the owner comes from the session, never the URL (C13).
 */
export function readPageQuery(request: Request): PageQuery | null {
  const params = new URL(request.url).searchParams;
  const beforeText = single(params, 'before');
  const limitText = single(params, 'limit');
  if (beforeText === undefined || limitText === undefined) return null;

  let before: Date | null = null;
  if (beforeText !== null) {
    if (!pageTime.safeParse(beforeText).success) return null;
    before = new Date(beforeText);
    if (Number.isNaN(before.getTime())) return null;
  }
  if (limitText !== null && !PAGE_LIMIT_TEXT.test(limitText)) return null;
  const limit = limitText === null ? LIMITS.ownerPageDefault : Math.min(Number(limitText), LIMITS.ownerPageMax);
  return { before, limit };
}

/**
 * Cuts rows read newest first to one page, and says where the next page starts. `rows` must be
 * the first PAGE_READ rows of the query, or all of them when there are fewer, whatever the
 * limit. The next page holds rows strictly before nextBefore, so a page never ends
 * part way through rows that share one millisecond: it ends early instead, before that
 * millisecond, or when the whole page is one millisecond, runs on through it to
 * LIMITS.ownerPageMax rows. A page can therefore hold more than `limit` rows, never more than
 * LIMITS.ownerPageMax. nextBefore is null on the last page.
 * Not covered: more than LIMITS.ownerPageMax rows in one millisecond for one owner. The page
 * stops there and the rest of that millisecond is skipped, with a fixed log line.
 */
export function cutPage<Row extends { createdAt: Date }>(rows: readonly Row[], limit: number): { rows: Row[]; nextBefore: Date | null } {
  if (rows.length <= limit) return { rows: [...rows], nextBefore: null };
  const timeAt = (index: number) => rows[index]?.createdAt.getTime();
  const cut = timeAt(limit);
  let end = limit;
  while (end > 0 && timeAt(end - 1) === cut) end -= 1;
  if (end === 0) {
    end = limit;
    while (end < LIMITS.ownerPageMax && end < rows.length && timeAt(end) === cut) end += 1;
    if (end === LIMITS.ownerPageMax && timeAt(end) === cut) console.warn('[ellai http] page_millisecond_over_cap');
  }
  const page = rows.slice(0, end);
  const last = page[page.length - 1];
  return { rows: page, nextBefore: rows.length > end && last !== undefined ? last.createdAt : null };
}

/**
 * The answer for a failure from core while an onboarding step is built or confirmed, or null
 * for anything else, which the route rethrows. Onboarding reads these classes differently from
 * every other route, so they are mapped here, onto errors.ts's codes: a Walrus Memory account
 * or delegate refusal (Sui already shows the account, the key, a frozen account or a closed
 * registry) is 422 chain_refused; Tatum not answering is 503 chain_unavailable. Only the class
 * and code of the failure are logged.
 */
export function onboardingChainFailure(error: unknown): Response | null {
  if (error instanceof MemoryError && (error.code === 'ACCOUNT' || error.code === 'DELEGATE')) {
    console.warn(`[ellai http] MemoryError ${error.code}`);
    return httpErrorResponse(new HttpError(422, 'chain_refused'));
  }
  if (error instanceof MemoryError || error instanceof ChainError) {
    console.warn(`[ellai http] ${error.name} ${error.code}`);
    return httpErrorResponse(new HttpError(503, 'chain_unavailable'));
  }
  return null;
}
