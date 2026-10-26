import { type Chain, ChainError, type ExecutionResult, type TransactionResult } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { DEPLOYMENT_NETWORK } from '@ellai/core/network';
import { assertPlainUsdcSend, verifySettlement } from '@ellai/core/payment';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { and, eq, gt, isNull, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { sellerSales } from '../db/schema.js';
import { consumeShared, consumeWindow, secondsLeftInWindow } from '../http/ratelimit.js';
import { type ChallengeTerms, SellerError, cachedEpoch, readSellerChallengeId, sellerResource, timestampOf } from './challenge.js';

export type SettleOutcome =
  | { ok: true; digest: string; payer: string }
  /**
   * `retryAfterSeconds` is set on a recheck that came too soon and on every 429 and 503: whole
   * seconds, at least 1, until the window that turned it away ends, the UTC day for a send
   * Ellai's Tatum budget refused.
   */
  | { ok: false; status: 402 | 409 | 429 | 503; reason: string; retryAfterSeconds?: number };

// Every reason is fixed text: nothing from the header, the bytes or the chain is copied in,
// because a reason goes back to whoever sent the payment and may be logged on the way (C19).
export const SETTLE_REASONS = {
  header: 'the X-PAYMENT header is not a payment this seller reads',
  resource: 'this request is not for a resource this seller sells',
  unknown: 'the payment names a challenge this seller did not issue',
  used: 'this challenge has already been used; ask for a new one',
  expired: 'this challenge has expired; ask for a new one',
  otherResource: 'this challenge was not issued for this resource',
  bytes: 'the payment bytes are not exactly the payment this challenge asks for',
  signature: 'the payment signature does not verify for its sender',
  presented: 'these payment bytes were already presented for another challenge',
  unconfirmed: 'the payment could not be confirmed on chain yet; send the same payment again to have it checked',
  failed: 'the payment did not succeed on chain',
  mismatch: 'the payment that landed is not the payment this challenge asks for',
  lapsed: 'the payment did not land on chain before its epoch window closed; ask for a new challenge',
  executeRate: 'too many payments from this caller this minute; ask for a new challenge in a minute',
  executeRateToday: 'too many payments from this caller today; ask for a new challenge tomorrow (days are counted in UTC)',
  executeBusy: 'this seller has sent all the payments it can today; ask for a new challenge tomorrow (days are counted in UTC)',
  chainUnavailableToday: "this seller has used today's budget for reaching Sui and did not send the payment; ask for a new challenge tomorrow (days are counted in UTC)",
} as const;

type Sale = typeof sellerSales.$inferSelect;
type Sleep = (ms: number) => Promise<void>;

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Named per sale, not per caller: the turn belongs to the sale, whoever presents its bytes.
const RECHECK_QUOTA_PREFIX = 'seller-recheck:';
const RECHECK_DAY_QUOTA = 'seller-rechecks:day';
// The minute's limit comes first, so a caller past it spends nothing of its day.
const EXECUTE_CLIENT_LIMITS = [
  { name: 'seller-executes:client:minute', limit: LIMITS.sellerExecutesPerClientPerMinute, windowMs: LIMITS.rateWindowMinuteMs, reason: 'executeRate' },
  { name: 'seller-executes:client:day', limit: LIMITS.sellerExecutesPerClientPerDay, windowMs: LIMITS.rateWindowDayMs, reason: 'executeRateToday' },
] as const;
const EXECUTE_QUOTA = 'seller-executes:day';
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64Text = z.string().min(1).regex(STRICT_BASE64);

// The exact shape t2000's payer and core's paymentHeader send. Any other key refuses.
const paymentSchema = z.strictObject({
  x402Version: z.literal(1),
  scheme: z.literal('exact'),
  network: z.literal(DEPLOYMENT_NETWORK),
  payload: z.strictObject({
    senderAddress: z.string().min(1),
    txBytes: base64Text,
    senderSignature: base64Text,
    challengeId: z.string().min(1).max(LIMITS.challengeIdMaxLength),
  }),
});

interface DecodedPayment {
  sender: string;
  txBytes: Uint8Array;
  signature: string;
  challengeId: string;
}

/**
 * The X-PAYMENT value read strictly: at most LIMITS.challengeMaxBytes, strict base64 of
 * strict UTF-8 JSON of exactly the t2000 shape, with a sender that is a Sui address. Null for
 * anything else; the size is checked before any decoding runs.
 */
function decodePaymentHeader(value: string): DecodedPayment | null {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > LIMITS.challengeMaxBytes) return null;
  if (!STRICT_BASE64.test(value)) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64')));
  } catch {
    return null;
  }
  const parsed = paymentSchema.safeParse(json);
  if (!parsed.success) return null;
  const { senderAddress, txBytes, senderSignature, challengeId } = parsed.data.payload;
  try {
    return { sender: canonicalSuiAddress(senderAddress), txBytes: fromBase64(txBytes), signature: senderSignature, challengeId };
  } catch {
    return null;
  }
}

async function signedBy(txBytes: Uint8Array, signature: string, sender: string): Promise<boolean> {
  try {
    // No client is passed, so this never reaches the network. A zkLogin signature needs one
    // to check its proof, so it refuses here: closed, not open.
    await verifyTransactionSignature(txBytes, signature, { address: sender });
    return true;
  } catch {
    return false;
  }
}

const refusal = (status: 402 | 409, reason: string): SettleOutcome => ({ ok: false, status, reason });

/**
 * Counts one send of a buyer's bytes against this caller's LIMITS.sellerExecutesPerClientPerMinute,
 * then its LIMITS.sellerExecutesPerClientPerDay, then every caller's LIMITS.sellerExecutesPerDayGlobal,
 * and returns null within all three (C22, C34). Past a caller's own limit the answer is 429 and
 * nothing shared is spent; past the shared day it is 503, and the first refusal in that day logs
 * the quota's fixed name. Every refusal carries the seconds until its window ends.
 */
async function executeCapRefusal(db: Database, callerKey: string, now: Date): Promise<SettleOutcome | null> {
  for (const cap of EXECUTE_CLIENT_LIMITS) {
    if (await consumeWindow(db, `${cap.name}:${callerKey}`, cap.limit, cap.windowMs, now)) continue;
    console.warn(`[ellai seller] execute_limited ${cap.name}`);
    return { ok: false, status: 429, reason: SETTLE_REASONS[cap.reason], retryAfterSeconds: secondsLeftInWindow(cap.windowMs, now) };
  }
  const turn = await consumeShared(db, EXECUTE_QUOTA, LIMITS.sellerExecutesPerDayGlobal, LIMITS.rateWindowDayMs, now);
  if (turn.allowed) return null;
  if (turn.firstRefusal) console.error(`[ellai seller] quota_spent ${EXECUTE_QUOTA}`);
  return { ok: false, status: 503, reason: SETTLE_REASONS.executeBusy, retryAfterSeconds: turn.retryAfterSeconds };
}

/** A sale whose bytes were sent and whose outcome is not yet known. Only those same bytes can pick it up again. */
function awaitingChain(sale: Sale): sale is Sale & { digest: string } {
  return sale.status === 'rejected' && sale.digest !== null && sale.settledAt === null;
}

// Built field by field from the stored sale and the id, never from the header, so the bytes
// are checked against what this seller issued and nothing the buyer said.
function expectedPayment(sale: Sale, target: { resource: string; host: string }, terms: ChallengeTerms): CanonicalPayment {
  return {
    dialect: 'x402-v1-t2000',
    sellerUrl: target.resource,
    sellerHost: target.host,
    recipient: sale.recipient,
    amount: sale.amountAtomic,
    asset: USDC_TYPE_MAINNET,
    network: DEPLOYMENT_NETWORK,
    expiresAtMs: sale.expiresAt.getTime(),
    challengeId: sale.challengeId,
    nonce: String(terms.nonce),
    minEpoch: terms.minEpoch,
    maxEpoch: terms.maxEpoch,
    resource: target.resource,
  };
}

/** Null when the bytes are exactly the payment `expected` describes and the sender signed them, otherwise the reason. */
async function paymentRefusal(payment: DecodedPayment, expected: CanonicalPayment): Promise<string | null> {
  try {
    await assertPlainUsdcSend(payment.txBytes, expected, payment.sender);
  } catch {
    return SETTLE_REASONS.bytes;
  }
  return (await signedBy(payment.txBytes, payment.signature, payment.sender)) ? null : SETTLE_REASONS.signature;
}

/**
 * What the chain did with `digest`, read up to LIMITS.chainReadAfterWriteTries times,
 * LIMITS.chainReadAfterWriteDelayMs apart, or null when every read missed or failed. A node
 * that has not caught up with the write and a read that failed both leave the outcome unknown;
 * neither ever means the payment did not land.
 */
async function readOutcome(chain: Chain, digest: string, sleep: Sleep): Promise<TransactionResult | null> {
  for (let attempt = 0; attempt < LIMITS.chainReadAfterWriteTries; attempt += 1) {
    if (attempt > 0) await sleep(LIMITS.chainReadAfterWriteDelayMs);
    try {
      return await chain.getTransactionResult(digest);
    } catch {
      // Not found yet, or not readable: unknown either way, so read again.
    }
  }
  return null;
}

interface Closing {
  db: Database;
  chain: Chain;
  sale: Sale;
  digest: string;
  expected: CanonicalPayment;
  payer: string;
  now: Date;
  sleep: Sleep;
}

const thisWait = (closing: Closing) =>
  and(eq(sellerSales.challengeId, closing.sale.challengeId), eq(sellerSales.status, 'rejected'), eq(sellerSales.digest, closing.digest), isNull(sellerSales.settledAt));

/**
 * Ends the wait on the sale with the chain's answer for its digest: 'settled' when
 * verifySettlement finds exactly this payment, otherwise left 'rejected' with settled_at set,
 * which records that the chain's answer is in and that the sale can no longer be picked up again.
 */
async function closeOn(result: Pick<TransactionResult, 'status' | 'balanceChanges'>, closing: Closing): Promise<SettleOutcome> {
  const verdict = verifySettlement({ status: result.status, balanceChanges: result.balanceChanges }, closing.expected, closing.payer);
  if (!verdict.verified) {
    await closing.db.update(sellerSales).set({ settledAt: closing.now }).where(thisWait(closing));
    return refusal(402, result.status === 'success' ? SETTLE_REASONS.mismatch : SETTLE_REASONS.failed);
  }
  const settled = await closing.db
    .update(sellerSales)
    .set({ status: 'settled', settledAt: closing.now })
    .where(thisWait(closing))
    .returning({ id: sellerSales.id });
  if (settled.length !== 1) return refusal(409, SETTLE_REASONS.used);
  return { ok: true, digest: closing.digest, payer: closing.payer };
}

/**
 * Ends the wait on a sale whose bytes core reported as never sent because Ellai's Tatum budget
 * refused the send: the digest is cleared, so the sale is closed like a refusal before execution
 * and is never read on chain. Answers 503 with the seconds left in the UTC day.
 */
async function closeUnsent(closing: Closing): Promise<SettleOutcome> {
  await closing.db.update(sellerSales).set({ digest: null }).where(thisWait(closing));
  return { ok: false, status: 503, reason: SETTLE_REASONS.chainUnavailableToday, retryAfterSeconds: secondsLeftInWindow(LIMITS.rateWindowDayMs, closing.now) };
}

/**
 * True once the cached epoch is past the bytes' max epoch. assertPlainUsdcSend has already held
 * the bytes' ValidDuring window equal to `expected`'s, so its maxEpoch is the bytes' own. An
 * epoch that cannot be read counts as a window still open.
 */
async function windowClosed(closing: Closing): Promise<boolean> {
  const { maxEpoch } = closing.expected;
  if (maxEpoch === null) return false;
  try {
    return (await cachedEpoch(closing.chain, closing.now.getTime())) > maxEpoch;
  } catch {
    return false;
  }
}

/**
 * Reads the digest (readOutcome) and closes on what it finds. While it finds nothing the sale
 * keeps waiting, unless the bytes' epoch window has closed, after which they can never land: then
 * one more read, taken after that epoch was seen, that the chain answers NOT_FOUND closes the sale
 * as rejected for good. Any other answer to that read leaves it waiting.
 */
async function confirmOnChain(closing: Closing): Promise<SettleOutcome> {
  const landed = await readOutcome(closing.chain, closing.digest, closing.sleep);
  if (landed !== null) return closeOn(landed, closing);
  if (!(await windowClosed(closing))) return refusal(402, SETTLE_REASONS.unconfirmed);
  let final: TransactionResult;
  try {
    final = await closing.chain.getTransactionResult(closing.digest);
  } catch (error) {
    if (!(error instanceof ChainError && error.code === 'NOT_FOUND')) return refusal(402, SETTLE_REASONS.unconfirmed);
    await closing.db.update(sellerSales).set({ settledAt: closing.now }).where(thisWait(closing));
    return refusal(402, SETTLE_REASONS.lapsed);
  }
  return closeOn(final, closing);
}

/**
 * Takes one payment for a wallet check challenge this seller issued, or refuses it, and never
 * keeps a payment that landed without settling its sale.
 *
 * In order: decodes the X-PAYMENT header (decodePaymentHeader) and finds the sale by its
 * challenge id (402 for an unknown one). A sale still waiting on the chain (its bytes were sent,
 * no outcome is recorded) is picked up again only by a header carrying those same bytes, whose
 * digest it holds (409 for any other), whatever the challenge's expiry, since the payment was
 * taken in time: the bytes and signature are checked again as below, then the sale's recheck is
 * counted through consumeShared, at most one per sale in each fixed window of
 * LIMITS.sellerRecheckIntervalMs whoever asks, and LIMITS.sellerRechecksPerDayGlobal a day across
 * every sale (one too soon, or past the day's, is 402 unconfirmed with retryAfterSeconds and reads
 * nothing; the day's first refusal logs its fixed name), then the digest is read as after an
 * unknown outcome.
 * Otherwise the sale must still be 'issued' (409) and unexpired
 * (402); the nonce and epoch window are read back out of the id, which also proves the id was
 * issued for this resource, recipient and amount (402 otherwise); then the sale is claimed with
 * one UPDATE from 'issued' to 'rejected' that must touch exactly one row, so a challenge is paid
 * at most once whatever runs at the same time (409 if another request claimed it first). From
 * the claim on, nothing releases it: a refusal before execution leaves it 'rejected' with no
 * digest, so it can never be retried with other bytes.
 *
 * After the claim: core's assertPlainUsdcSend proves the bytes are byte for byte the plain
 * gasless USDC send of the stored amount to the stored recipient with this challenge's nonce
 * and window, from the sender; verifyTransactionSignature proves the sender signed them. Only
 * then is the send counted against the caps on sends (executeCapRefusal, keyed on `callerKey`,
 * which must be the platform's verified client address): past this caller's
 * LIMITS.sellerExecutesPerClientPerMinute or LIMITS.sellerExecutesPerClientPerDay it is 429, past
 * every caller's LIMITS.sellerExecutesPerDayGlobal it is 503, each with retryAfterSeconds, and
 * nothing reaches Tatum (C22). A sale turned away there keeps no digest, so it is closed like any
 * refusal before execution. Then the
 * digest of the bytes is recorded, unique across all sales, so one payment can never pay two
 * challenges; the bytes are executed once through Tatum. Only a definite answer closes the sale:
 * core's verifySettlement finding exactly the sender minus the amount and the recipient plus it
 * makes it 'settled'; a transaction that ran and failed, bytes the network refused, or one that
 * landed as anything but this payment leaves it 'rejected' with settled_at set. Core's BUDGET,
 * Ellai's Tatum budget refusing the send, means the bytes were never sent: the digest is cleared,
 * closing the sale like a refusal before execution, and the answer is 503 chainUnavailableToday
 * with retryAfterSeconds to the end of the UTC day. When the outcome is unknown (any other
 * ChainError but core's own INVALID_INPUT refusal, which also sends nothing), the
 * digest is read up to LIMITS.chainReadAfterWriteTries times and the sale closed on what is
 * found; if nothing is found the answer is 402 unconfirmed and the sale keeps waiting for the
 * same bytes, until the seller's cached epoch (cachedEpoch) is past the bytes' max epoch: then
 * one final read of the digest that is NOT_FOUND sets settled_at, leaving the sale 'rejected'
 * for good (402 lapsed), and it is never read again. The bytes are never sent again.
 *
 * `sleep` waits between those reads; tests pass one that does not wait. Returns fixed-text
 * reasons only (SETTLE_REASONS). Throws only for database failures, an invalid `now` or an empty
 * `callerKey` (SellerError).
 */
export async function settleWalletCheckPayment(args: {
  db: Database;
  chain: Chain;
  paymentHeader: string;
  resourceUrl: string;
  callerKey: string;
  now: Date;
  sleep?: Sleep;
}): Promise<SettleOutcome> {
  const { db, chain } = args;
  const sleep = args.sleep ?? timerSleep;
  const nowMs = timestampOf(args.now);
  const now = new Date(nowMs);
  if (typeof args.callerKey !== 'string' || args.callerKey === '') throw new SellerError('the caller key is missing');

  const target = sellerResource(args.resourceUrl);
  if (target === null) return refusal(402, SETTLE_REASONS.resource);
  const payment = decodePaymentHeader(args.paymentHeader);
  if (payment === null) return refusal(402, SETTLE_REASONS.header);

  const [sale] = await db.select().from(sellerSales).where(eq(sellerSales.challengeId, payment.challengeId));
  if (sale === undefined) return refusal(402, SETTLE_REASONS.unknown);
  const digest = TransactionDataBuilder.getDigestFromBytes(payment.txBytes);
  const binding = { resource: target.resource, recipient: sale.recipient, amount: sale.amountAtomic };

  if (awaitingChain(sale)) {
    if (sale.digest !== digest) return refusal(409, SETTLE_REASONS.used);
    const terms = readSellerChallengeId(sale.challengeId, binding);
    if (terms === null) return refusal(402, SETTLE_REASONS.otherResource);
    const expected = expectedPayment(sale, target, terms);
    const refused = await paymentRefusal(payment, expected);
    if (refused !== null) return refusal(402, refused);
    // Counted only after the bytes check out, so nobody without them can use up the buyer's turn.
    const turn = await consumeShared(db, `${RECHECK_QUOTA_PREFIX}${sale.id}`, 1, LIMITS.sellerRecheckIntervalMs, now);
    if (!turn.allowed) return { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed, retryAfterSeconds: turn.retryAfterSeconds };
    // Every waiting sale's turns together, after the sale's own, so a turn too soon spends none of the day.
    const day = await consumeShared(db, RECHECK_DAY_QUOTA, LIMITS.sellerRechecksPerDayGlobal, LIMITS.rateWindowDayMs, now);
    if (!day.allowed) {
      if (day.firstRefusal) console.error(`[ellai seller] quota_spent ${RECHECK_DAY_QUOTA}`);
      return { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed, retryAfterSeconds: day.retryAfterSeconds };
    }
    return confirmOnChain({ db, chain, sale, digest, expected, payer: payment.sender, now, sleep });
  }

  if (sale.status !== 'issued') return refusal(409, SETTLE_REASONS.used);
  if (nowMs >= sale.expiresAt.getTime()) return refusal(402, SETTLE_REASONS.expired);
  const terms = readSellerChallengeId(sale.challengeId, binding);
  if (terms === null) return refusal(402, SETTLE_REASONS.otherResource);

  const claimed = await db
    .update(sellerSales)
    .set({ status: 'rejected', payer: payment.sender })
    .where(and(eq(sellerSales.challengeId, sale.challengeId), eq(sellerSales.status, 'issued'), gt(sellerSales.expiresAt, now)))
    .returning({ id: sellerSales.id });
  if (claimed.length !== 1) return refusal(409, SETTLE_REASONS.used);

  const expected = expectedPayment(sale, target, terms);
  const refused = await paymentRefusal(payment, expected);
  if (refused !== null) return refusal(402, refused);

  // Before the digest is recorded: a sale with a digest and no outcome waits on the chain, and
  // its rechecks would read Tatum for bytes that were never sent.
  const capped = await executeCapRefusal(db, args.callerKey, now);
  if (capped !== null) return capped;

  const otherSale = alias(sellerSales, 'other_sale');
  const recorded = await db
    .update(sellerSales)
    .set({ digest })
    .where(
      and(
        eq(sellerSales.challengeId, sale.challengeId),
        eq(sellerSales.status, 'rejected'),
        isNull(sellerSales.digest),
        notExists(db.select({ id: otherSale.id }).from(otherSale).where(eq(otherSale.digest, digest))),
      ),
    )
    .returning({ id: sellerSales.id });
  if (recorded.length !== 1) return refusal(409, SETTLE_REASONS.presented);

  const closing: Closing = { db, chain, sale, digest, expected, payer: payment.sender, now, sleep };
  let executed: ExecutionResult;
  try {
    executed = await chain.executeTransaction(payment.txBytes, [payment.signature]);
  } catch (error) {
    if (error instanceof ChainError && error.code === 'INVALID_INPUT') return closeOn({ status: 'failure', balanceChanges: [] }, closing);
    if (error instanceof ChainError && error.code === 'BUDGET') return closeUnsent(closing);
    return confirmOnChain(closing);
  }
  return closeOn(executed, closing);
}
