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
import { and, eq, gt, isNull, lt, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { sellerSales } from '../db/schema.js';
import { consumeShared, consumeWindow, secondsLeftInWindow } from '../http/ratelimit.js';
import { type ChallengeTerms, SellerError, cachedEpoch, readSellerChallengeId, sellerResource, timestampOf } from './challenge.js';
import { type SellerDeadline, canStartRead, sellerDeadline } from './deadline.js';

export type SettleOutcome =
  | { ok: true; digest: string; payer: string }
  /**
   * `retryAfterSeconds` is set on a recheck that came too soon and on every 429 and 503: whole
   * seconds, at least 1, until the window that turned it away ends, the UTC day for a send
   * Ellai's Tatum budget refused.
   */
  | { ok: false; status: 402 | 409 | 410 | 429 | 503; reason: string; retryAfterSeconds?: number };

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
  deliverSoon: 'this payment has settled; send the same payment again after Retry-After to receive the wallet check',
  deliverToday: "this payment has settled, but this seller has used today's rechecks; send the same payment again tomorrow to receive the wallet check (days are counted in UTC)",
  deliverExhausted: 'this payment has settled, but its wallet check failed on every retry this seller allows for one payment; it will not be tried again',
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

/** A sale whose payment settled and whose buyer was never served the check. Only those same bytes can collect it. */
function awaitingDelivery(sale: Sale): sale is Sale & { digest: string } {
  return sale.status === 'settled' && sale.digest !== null && sale.deliveredAt === null;
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
 * Checks bytes presented again for a sale that already holds a digest: they must be those bytes
 * (409 for any others), the id must still read back for this resource, and the bytes and the
 * signature must pass as they did at the claim (402 otherwise). Returns the payment they were
 * checked against.
 */
async function presentedAgain(
  sale: Sale & { digest: string },
  digest: string,
  payment: DecodedPayment,
  target: { resource: string; host: string },
): Promise<{ expected: CanonicalPayment } | { refused: SettleOutcome }> {
  if (sale.digest !== digest) return { refused: refusal(409, SETTLE_REASONS.used) };
  const terms = readSellerChallengeId(sale.challengeId, { resource: target.resource, recipient: sale.recipient, amount: sale.amountAtomic });
  if (terms === null) return { refused: refusal(402, SETTLE_REASONS.otherResource) };
  const expected = expectedPayment(sale, target, terms);
  const refused = await paymentRefusal(payment, expected);
  return refused === null ? { expected } : { refused: refusal(402, refused) };
}

/**
 * Counts one of every sale's rechecks and redeliveries today against
 * LIMITS.sellerRechecksPerDayGlobal (C22). Null within it; otherwise the seconds until the UTC day
 * ends. The day's first refusal logs its fixed name.
 */
async function dayRefusal(db: Database, now: Date): Promise<number | null> {
  const day = await consumeShared(db, RECHECK_DAY_QUOTA, LIMITS.sellerRechecksPerDayGlobal, LIMITS.rateWindowDayMs, now);
  if (day.allowed) return null;
  if (day.firstRefusal) console.error(`[ellai seller] quota_spent ${RECHECK_DAY_QUOTA}`);
  return day.retryAfterSeconds;
}

/**
 * Hands a settled, undelivered sale back to be served again, at most
 * LIMITS.sellerRedeliveriesPerSale times in its life (C22, C29). The turn is claimed with one
 * UPDATE that adds 1 to the sale's redeliveries only while the sale is settled, undelivered and
 * under that count, so two requests can never both take the last one; then the turn is counted
 * against the recheck day (dayRefusal). A sale with no turn left, or one the day turns away, is
 * 503 deliverToday with the seconds left in the UTC day, and nothing is read on chain. A turn
 * the day refused is given back, since no check was read for it.
 */
async function redeliver(db: Database, sale: Sale, digest: string, payer: string, now: Date): Promise<SettleOutcome> {
  const claimed = await db
    .update(sellerSales)
    .set({ redeliveries: sql`${sellerSales.redeliveries} + 1` })
    .where(
      and(
        eq(sellerSales.id, sale.id),
        eq(sellerSales.status, 'settled'),
        isNull(sellerSales.deliveredAt),
        lt(sellerSales.redeliveries, LIMITS.sellerRedeliveriesPerSale),
      ),
    )
    .returning({ id: sellerSales.id });
  if (claimed.length !== 1) {
    console.warn('[ellai seller] redelivery_limited seller-redeliveries:sale');
    // Final for this sale, so it names no time to come back.
    return { ok: false, status: 410, reason: SETTLE_REASONS.deliverExhausted };
  }
  const refusedFor = await dayRefusal(db, now);
  if (refusedFor === null) return { ok: true, digest, payer };
  await db
    .update(sellerSales)
    .set({ redeliveries: sql`${sellerSales.redeliveries} - 1` })
    .where(and(eq(sellerSales.id, sale.id), gt(sellerSales.redeliveries, 0)));
  return { ok: false, status: 503, reason: SETTLE_REASONS.deliverToday, retryAfterSeconds: refusedFor };
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
  deadline: SellerDeadline;
}

/**
 * What the chain did with the digest, read up to LIMITS.chainReadAfterWriteTries times,
 * LIMITS.chainReadAfterWriteDelayMs apart, or null when every read missed or failed, or the
 * deadline stopped the reads (no read or wait begins past its readByMs). A node that has not
 * caught up with the write, a read that failed and a read never made all leave the outcome
 * unknown; none ever means the payment did not land.
 */
async function readOutcome(closing: Closing): Promise<TransactionResult | null> {
  for (let attempt = 0; attempt < LIMITS.chainReadAfterWriteTries; attempt += 1) {
    if (attempt > 0) {
      if (!canStartRead(closing.deadline, LIMITS.chainReadAfterWriteDelayMs)) return null;
      await closing.sleep(LIMITS.chainReadAfterWriteDelayMs);
    }
    if (!canStartRead(closing.deadline)) return null;
    try {
      return await closing.chain.getTransactionResult(closing.digest);
    } catch {
      // Not found yet, or not readable: unknown either way, so read again.
    }
  }
  return null;
}

const thisWait = (closing: Closing) =>
  and(eq(sellerSales.challengeId, closing.sale.challengeId), eq(sellerSales.status, 'rejected'), eq(sellerSales.digest, closing.digest), isNull(sellerSales.settledAt));

/**
 * Ends the wait on the sale with the chain's answer for its digest: 'settled' when
 * verifySettlement finds exactly this payment, with delivered_at still empty until the buyer is
 * served (markDelivered), otherwise left 'rejected' with settled_at set, which records that the
 * chain's answer is in and that the sale can no longer be picked up again.
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
 * epoch that cannot be read, or that the deadline leaves no time to read, counts as a window
 * still open.
 */
async function windowClosed(closing: Closing): Promise<boolean> {
  const { maxEpoch } = closing.expected;
  if (maxEpoch === null) return false;
  // cachedEpoch may read the chain, so it is asked only while a read may begin.
  if (!canStartRead(closing.deadline)) return false;
  try {
    return (await cachedEpoch(closing.chain, closing.now.getTime())) > maxEpoch;
  } catch {
    return false;
  }
}

/**
 * Reads the digest LIMITS.paymentReleaseReads times, LIMITS.settlementPollIntervalMs apart, for
 * bytes whose epoch window was already seen closed: what the first read that finds it answers,
 * 'missing' when every read is NOT_FOUND, or 'unknown' as soon as one fails any other way or the
 * deadline leaves no time for the next read or the wait before it.
 */
async function readAfterWindow(closing: Closing): Promise<TransactionResult | 'missing' | 'unknown'> {
  for (let read = 0; read < LIMITS.paymentReleaseReads; read += 1) {
    if (read > 0) {
      if (!canStartRead(closing.deadline, LIMITS.settlementPollIntervalMs)) return 'unknown';
      await closing.sleep(LIMITS.settlementPollIntervalMs);
    }
    if (!canStartRead(closing.deadline)) return 'unknown';
    try {
      return await closing.chain.getTransactionResult(closing.digest);
    } catch (error) {
      if (!(error instanceof ChainError && error.code === 'NOT_FOUND')) return 'unknown';
    }
  }
  return 'missing';
}

/**
 * Reads the digest (readOutcome) and closes on what it finds. While it finds nothing the sale
 * keeps waiting, unless the bytes' epoch window has closed, after which they can never land:
 * then LIMITS.paymentReleaseReads more reads, all taken after that epoch was seen, that the chain
 * all answers NOT_FOUND close the sale as rejected for good, so one lagging node cannot close a
 * payment that landed at the very end of its window. Any other answer to any of them leaves it
 * waiting. No read or wait begins past the deadline's readByMs, and a pass the deadline cut short
 * leaves the sale waiting, never lapsed (C21, C29).
 */
async function confirmOnChain(closing: Closing): Promise<SettleOutcome> {
  const landed = await readOutcome(closing);
  if (landed !== null) return closeOn(landed, closing);
  if (!(await windowClosed(closing))) return refusal(402, SETTLE_REASONS.unconfirmed);
  const final = await readAfterWindow(closing);
  if (final === 'unknown') return refusal(402, SETTLE_REASONS.unconfirmed);
  if (final === 'missing') {
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
 * no outcome is recorded), or one that settled but whose buyer was never served (delivered_at
 * empty), is picked up again only by a header carrying those same bytes, whose digest it holds
 * (409 for any other), whatever the challenge's expiry, since the payment was taken in time: the
 * bytes and signature are checked again as below, then the sale's own turn is counted, at most
 * one per sale in each fixed window of LIMITS.sellerRecheckIntervalMs whoever asks. A waiting
 * sale is then counted against LIMITS.sellerRechecksPerDayGlobal a day across every sale
 * (dayRefusal, whose first refusal logs its fixed name); turned away by either it is 402
 * unconfirmed with retryAfterSeconds and reads nothing; otherwise its digest is read as after an
 * unknown outcome. A settled sale turned away by its own window is 429 deliverSoon with
 * retryAfterSeconds; otherwise redeliver claims one of its LIMITS.sellerRedeliveriesPerSale turns
 * and then counts the day, answering 503 deliverToday with no turn left or past the day, and
 * otherwise hands it back as settled, with nothing read on chain, for the caller to serve again.
 * A sale already served is 409.
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
 * makes it 'settled'; a transaction that landed and failed, or the network refusing the first
 * send (core returns both as status failure), or one that landed as anything but this payment
 * leaves it 'rejected' with settled_at set. Core's executeTransaction throws INVALID_INPUT and
 * BUDGET only when nothing was sent. INVALID_INPUT, bytes or signatures core will not send,
 * closes the sale the same way. BUDGET, Ellai's Tatum budget refusing the send, clears the
 * digest, closing the sale like a refusal before execution, and the answer is 503
 * chainUnavailableToday with retryAfterSeconds to the end of the UTC day. Every other failure,
 * whatever its code or type, leaves the outcome unknown: the
 * digest is read up to LIMITS.chainReadAfterWriteTries times and the sale closed on what is
 * found; if nothing is found the answer is 402 unconfirmed and the sale keeps waiting for the
 * same bytes, until the seller's cached epoch (cachedEpoch) is past the bytes' max epoch: then
 * LIMITS.paymentReleaseReads further reads of the digest, LIMITS.settlementPollIntervalMs apart,
 * that are all NOT_FOUND set settled_at, leaving the sale 'rejected' for good (402 lapsed), and it
 * is never read again. The bytes are never sent again.
 *
 * A settled outcome never marks the sale delivered: the caller does that with markDelivered once
 * the answer it serves is built.
 *
 * `sleep` waits between those reads; tests pass one that does not wait. `deadline` is the
 * request's (sellerDeadline): no read after the send, and no wait before one, begins past its
 * readByMs, and a check cut short answers 402 unconfirmed with the sale still waiting. Left out,
 * it starts now on the wall clock. Returns fixed-text
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
  deadline?: SellerDeadline;
}): Promise<SettleOutcome> {
  const { db, chain } = args;
  const sleep = args.sleep ?? timerSleep;
  const deadline = args.deadline ?? sellerDeadline(Date.now(), Date.now);
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

  if (awaitingChain(sale) || awaitingDelivery(sale)) {
    const again = await presentedAgain(sale, digest, payment, target);
    if ('refused' in again) return again.refused;
    // Counted only after the bytes check out, so nobody without them can use up the buyer's turn,
    // and before anything else, so a turn too soon spends none of the sale's life or the day.
    const turn = await consumeShared(db, `${RECHECK_QUOTA_PREFIX}${sale.id}`, 1, LIMITS.sellerRecheckIntervalMs, now);
    if (awaitingDelivery(sale)) {
      if (!turn.allowed) return { ok: false, status: 429, reason: SETTLE_REASONS.deliverSoon, retryAfterSeconds: turn.retryAfterSeconds };
      return redeliver(db, sale, digest, payment.sender, now);
    }
    if (!turn.allowed) return { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed, retryAfterSeconds: turn.retryAfterSeconds };
    const refusedFor = await dayRefusal(db, now);
    if (refusedFor !== null) return { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed, retryAfterSeconds: refusedFor };
    return confirmOnChain({ db, chain, sale, digest, expected: again.expected, payer: payment.sender, now, sleep, deadline });
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

  const closing: Closing = { db, chain, sale, digest, expected, payer: payment.sender, now, sleep, deadline };
  let executed: ExecutionResult;
  try {
    executed = await chain.executeTransaction(payment.txBytes, [payment.signature]);
  } catch (error) {
    // Core throws these two only when nothing was sent; any other failure, of any type, may have landed.
    if (error instanceof ChainError && error.code === 'INVALID_INPUT') return closeOn({ status: 'failure', balanceChanges: [] }, closing);
    if (error instanceof ChainError && error.code === 'BUDGET') return closeUnsent(closing);
    return confirmOnChain(closing);
  }
  return closeOn(executed, closing);
}

/**
 * Records that the buyer of the sale that settled with `digest` has been served, so the same
 * bytes are refused from then on (409). Called only once the wallet check has answered and the
 * response carrying it is built, never at settlement, so a check that fails after the payment
 * settled can still be delivered to the same bytes (C29). Touches only a settled sale not yet
 * marked; a second call changes nothing. Throws SellerError for an invalid `now`, and otherwise
 * only for database failures.
 */
export async function markDelivered(db: Database, digest: string, now: Date): Promise<void> {
  const deliveredAt = new Date(timestampOf(now));
  await db
    .update(sellerSales)
    .set({ deliveredAt })
    .where(and(eq(sellerSales.digest, digest), eq(sellerSales.status, 'settled'), isNull(sellerSales.deliveredAt)));
}
