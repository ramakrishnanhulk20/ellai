import { ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';

const MS_PER_SECOND = 1_000;

/**
 * The longest one Tatum read through core can take: every try runs to LIMITS.tatumTimeoutMs, with
 * core's waits of LIMITS.tatumRetryDelayMs, doubling each time, between them. Core's request
 * metering runs inside each try's time limit. 33 s at today's limits.
 */
export const LONGEST_READ_MS =
  LIMITS.tatumTimeoutMs * (LIMITS.tatumRetries + 1) + LIMITS.tatumRetryDelayMs * (2 ** LIMITS.tatumRetries - 1);

/**
 * How long after a seller request starts it may still be waiting on the chain: the route's
 * LIMITS.slowRouteMaxDurationS less LIMITS.paidRequestMarginMs, which is left for storing what
 * happened and building the answer.
 */
export const SELLER_END_BY_MS = LIMITS.slowRouteMaxDurationS * MS_PER_SECOND - LIMITS.paidRequestMarginMs;

/** How long after a seller request starts a read may still begin, so the slowest one still ends by SELLER_END_BY_MS. */
export const SELLER_READ_BY_MS = SELLER_END_BY_MS - LONGEST_READ_MS;

/** One seller request's limits, as times in epoch ms on `clock`. */
export interface SellerDeadline {
  clock: () => number;
  /** No read, and no wait before one, may begin at or after this. */
  readByMs: number;
  /** Nothing the request waits on may still be running at this time. */
  endByMs: number;
}

/** The limits of a seller request that started at `startMs` on `clock`. */
export function sellerDeadline(startMs: number, clock: () => number): SellerDeadline {
  return { clock, readByMs: startMs + SELLER_READ_BY_MS, endByMs: startMs + SELLER_END_BY_MS };
}

/**
 * True when a read may still begin after a wait of `waitMs`: the wait and the read both start
 * before the deadline's readByMs. A clock that does not answer a number counts as past it.
 */
export function canStartRead(deadline: SellerDeadline, waitMs = 0): boolean {
  return deadline.clock() + waitMs < deadline.readByMs;
}

/** The error for a read the deadline stopped. Fixed text; a TIMEOUT, so no reader takes it for NOT_FOUND. */
export function pastDeadline(): ChainError {
  return new ChainError('TIMEOUT', 'the seller request reached its deadline before this read finished');
}

/**
 * Runs `work` and rejects with pastDeadline once the deadline's endByMs comes, whatever `work` is
 * still waiting on, so a library call with steps and waits of its own cannot hold the request
 * past the route's limit (C21). The call it cut off may still finish in the background; it
 * changes nothing here. Rejects at once when endByMs has already passed.
 */
export async function withinDeadline<T>(deadline: SellerDeadline, work: () => Promise<T>): Promise<T> {
  const leftMs = deadline.endByMs - deadline.clock();
  // Written so NaN fails the comparison.
  if (!(leftMs > 0)) throw pastDeadline();
  let timer: NodeJS.Timeout | undefined;
  const cutOff = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(pastDeadline()), leftMs);
  });
  try {
    return await Promise.race([work(), cutOff]);
  } finally {
    clearTimeout(timer);
  }
}
