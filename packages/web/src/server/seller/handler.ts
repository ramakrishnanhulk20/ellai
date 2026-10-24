import { createHash } from 'node:crypto';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { DEPLOYMENT_NETWORK } from '@ellai/core/network';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { rateCounters } from '../db/schema.js';
import type { ServerEnv } from '../env.js';
import { SellerError, issueWalletCheckChallenge, timestampOf } from './challenge.js';
import { settleWalletCheckPayment } from './settle.js';
import { walletCheck } from './walletcheck.js';

export interface SellerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Every message the handler writes itself. None carries anything from the request. */
export const HANDLER_MESSAGES = {
  method: 'This seller takes POST requests only.',
  headers: 'The request headers could not be read.',
  body: 'Send a JSON body {"address": "<Sui address>"} naming the Sui address to check.',
  rate: 'Too many unpaid requests from this caller. Try again in a minute.',
  unavailable: 'The seller cannot issue a payment challenge right now. Try again shortly.',
  undelivered: 'Your payment settled, but the wallet check could not be read. The receipt is in X-PAYMENT-RESPONSE.',
  internal: 'The seller hit an unexpected error.',
} as const;

const MINUTE_MS = 60_000;
const MS_PER_SECOND = 1_000;
const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';
// The caller key is hashed, so the counter row has a fixed length under the column cap and
// never stores a client address in the clear.
const RATE_KEY_PREFIX = 'seller-challenge:';

const requestSchema = z.strictObject({ address: z.string() });

function json(status: number, payload: unknown, extra: Record<string, string> = {}): SellerResponse {
  return { status, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(payload) };
}

/** The X-PAYMENT value, undefined when absent, or null when the headers are not a plain name to text map or name it twice. */
function paymentHeaderOf(headers: Record<string, string>): { value: string | undefined } | null {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return null;
  let value: string | undefined;
  for (const [name, text] of Object.entries(headers)) {
    if (typeof text !== 'string') return null;
    if (name.toLowerCase() !== PAYMENT_HEADER) continue;
    if (value !== undefined) return null;
    value = text;
  }
  return { value };
}

function requestedAddress(body: string): string | null {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > LIMITS.challengeMaxBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const request = requestSchema.safeParse(parsed);
  if (!request.success) return null;
  try {
    return canonicalSuiAddress(request.data.address);
  } catch {
    return null;
  }
}

/**
 * Counts one unpaid request for this caller in the current fixed minute, in one statement so
 * concurrent requests cannot both read the old count (C22).
 */
async function countUnpaid(db: Database, callerKey: string, nowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (typeof callerKey !== 'string' || callerKey === '') throw new SellerError('the caller key is missing');
  const windowStartMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const key = `${RATE_KEY_PREFIX}${createHash('sha256').update(callerKey, 'utf8').digest('hex')}`;
  const [counter] = await db
    .insert(rateCounters)
    .values({ key, windowStart: new Date(windowStartMs), count: 1 })
    .onConflictDoUpdate({ target: [rateCounters.key, rateCounters.windowStart], set: { count: sql`${rateCounters.count} + 1` } })
    .returning({ count: rateCounters.count });
  if (counter === undefined) throw new SellerError('the rate counter returned no row');
  return {
    allowed: counter.count <= LIMITS.sellerChallengesPerMinute,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + MINUTE_MS - nowMs) / MS_PER_SECOND)),
  };
}

/** The settlement receipt as t2000's sellers send it: base64 of { success, network, transaction, payer }. */
function receipt(digest: string, payer: string): Record<string, string> {
  const settled = { success: true, network: DEPLOYMENT_NETWORK, transaction: digest, payer };
  return { [PAYMENT_RESPONSE_HEADER]: Buffer.from(JSON.stringify(settled), 'utf8').toString('base64') };
}

async function handle(args: Parameters<typeof handleWalletCheck>[0]): Promise<SellerResponse> {
  const { db, chain } = args;
  if (args.method !== 'POST') return json(405, { error: HANDLER_MESSAGES.method }, { Allow: 'POST' });
  const nowMs = timestampOf(args.now);
  const payment = paymentHeaderOf(args.headers);
  if (payment === null) return json(400, { error: HANDLER_MESSAGES.headers });
  const address = requestedAddress(args.body);
  if (address === null) return json(400, { error: HANDLER_MESSAGES.body });

  if (payment.value === undefined) {
    const limit = await countUnpaid(db, args.callerKey, nowMs);
    if (!limit.allowed) return json(429, { error: HANDLER_MESSAGES.rate }, { 'Retry-After': String(limit.retryAfterSeconds) });
    try {
      const challenge = await issueWalletCheckChallenge({ db, chain, resourceUrl: args.url, payTo: args.payTo, now: args.now });
      return { status: challenge.status, headers: challenge.headers, body: challenge.body };
    } catch {
      return json(503, { error: HANDLER_MESSAGES.unavailable });
    }
  }

  const settled = await settleWalletCheckPayment({ db, chain, paymentHeader: payment.value, resourceUrl: args.url, now: args.now });
  if (!settled.ok) return json(settled.status, { error: settled.reason });
  const paid = receipt(settled.digest, settled.payer);
  try {
    return json(200, await walletCheck({ chain, address }), paid);
  } catch {
    return json(502, { error: HANDLER_MESSAGES.undelivered }, paid);
  }
}

/**
 * Ellai's own paid service: a 0.01 USDC summary of one Sui address, sold over x402.
 *
 * POST only (405 otherwise). The body must be JSON { address } naming a Sui address (400
 * otherwise, also for headers that are not plain text or that name X-PAYMENT twice). With no
 * X-PAYMENT header, the unpaid request is counted against `callerKey`, which must be the
 * platform's verified client address and never a header the client sets: past
 * LIMITS.sellerChallengesPerMinute in one minute the answer is 429 with Retry-After, else a
 * fresh 402 challenge from issueWalletCheckChallenge (503 when one cannot be issued). With
 * X-PAYMENT, settleWalletCheckPayment must take the payment (its 402 or 409 otherwise) before
 * the wallet check is read; the 200 carries the check as JSON and X-PAYMENT-RESPONSE with the
 * digest. If the check cannot be read after the payment settled, the answer is 502 with the
 * same receipt.
 *
 * No response ever carries the X-PAYMENT value, its bytes or its signature, and every error
 * body is fixed text (C19). Never throws: anything unexpected is a 500 with fixed text.
 */
export async function handleWalletCheck(args: {
  db: Database;
  chain: Chain;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  payTo: string;
  callerKey: string;
  now: Date;
}): Promise<SellerResponse> {
  try {
    return await handle(args);
  } catch {
    return json(500, { error: HANDLER_MESSAGES.internal });
  }
}

/**
 * The address the wallet check is paid to: ELLAI_SELLER_PAYTO when it is set, otherwise the gas
 * wallet's own address, so what the seller earns pays for Ellai's gas. Both go through the one
 * address normaliser. Throws SellerError for a gas key that is not an Ed25519 Sui key; the
 * message never repeats it.
 */
export function sellerPayTo(env: Pick<ServerEnv, 'ELLAI_SELLER_PAYTO' | 'GAS_PRIVATE_KEY'>): string {
  if (env.ELLAI_SELLER_PAYTO !== undefined) return canonicalSuiAddress(env.ELLAI_SELLER_PAYTO);
  try {
    return canonicalSuiAddress(Ed25519Keypair.fromSecretKey(env.GAS_PRIVATE_KEY).toSuiAddress());
  } catch {
    throw new SellerError('GAS_PRIVATE_KEY is not an Ed25519 Sui key');
  }
}
