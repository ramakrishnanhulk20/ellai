import type { Chain, ExecutionResult } from '@ellai/core/chain';
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
import { readSellerChallengeId, sellerResource, timestampOf } from './challenge.js';

export type SettleOutcome = { ok: true; digest: string; payer: string } | { ok: false; status: 402 | 409; reason: string };

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
  unconfirmed: 'the payment could not be confirmed on chain, and this challenge cannot be paid again',
  failed: 'the payment did not succeed on chain',
  mismatch: 'the payment that landed is not the payment this challenge asks for',
} as const;

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

/**
 * Takes one payment for a wallet check challenge this seller issued, or refuses it.
 *
 * In order: decodes the X-PAYMENT header (decodePaymentHeader); finds the sale by its
 * challenge id and refuses an unknown one (402), one no longer 'issued' (409) and an expired one
 * (402); reads the nonce and epoch window back out of the id, which also proves the id was
 * issued for this resource, recipient and amount (402 otherwise); then claims the sale with one
 * UPDATE from 'issued' to 'rejected' that must touch exactly one row, so a challenge is paid at
 * most once whatever runs at the same time (409 if another request claimed it first). From the
 * claim on, nothing releases it: a refusal before execution leaves it 'rejected', so it can
 * never be retried with other bytes.
 *
 * After the claim: core's assertPlainUsdcSend proves the bytes are byte for byte the plain
 * gasless USDC send of the stored amount to the stored recipient with this challenge's nonce
 * and window, from the sender; verifyTransactionSignature proves the sender signed them; the
 * digest of the bytes is recorded, unique across all sales, so one payment can never pay two
 * challenges; the bytes are executed once through Tatum; core's verifySettlement must find
 * exactly the sender minus the amount and the recipient plus it. Only then is the sale
 * 'settled' with its settled_at. A failed or mismatched settlement stays 'rejected' with its
 * digest and payer recorded.
 *
 * Returns fixed-text reasons only (SETTLE_REASONS). Throws only for database failures or an
 * invalid `now`.
 */
export async function settleWalletCheckPayment(args: {
  db: Database;
  chain: Chain;
  paymentHeader: string;
  resourceUrl: string;
  now: Date;
}): Promise<SettleOutcome> {
  const { db, chain } = args;
  const nowMs = timestampOf(args.now);
  const now = new Date(nowMs);
  const refuse = (status: 402 | 409, reason: string): SettleOutcome => ({ ok: false, status, reason });

  const target = sellerResource(args.resourceUrl);
  if (target === null) return refuse(402, SETTLE_REASONS.resource);
  const payment = decodePaymentHeader(args.paymentHeader);
  if (payment === null) return refuse(402, SETTLE_REASONS.header);

  const [sale] = await db.select().from(sellerSales).where(eq(sellerSales.challengeId, payment.challengeId));
  if (sale === undefined) return refuse(402, SETTLE_REASONS.unknown);
  if (sale.status !== 'issued') return refuse(409, SETTLE_REASONS.used);
  if (nowMs >= sale.expiresAt.getTime()) return refuse(402, SETTLE_REASONS.expired);
  const terms = readSellerChallengeId(sale.challengeId, { resource: target.resource, recipient: sale.recipient, amount: sale.amountAtomic });
  if (terms === null) return refuse(402, SETTLE_REASONS.otherResource);

  const claimed = await db
    .update(sellerSales)
    .set({ status: 'rejected', payer: payment.sender })
    .where(and(eq(sellerSales.challengeId, sale.challengeId), eq(sellerSales.status, 'issued'), gt(sellerSales.expiresAt, now)))
    .returning({ id: sellerSales.id });
  if (claimed.length !== 1) return refuse(409, SETTLE_REASONS.used);

  // Built field by field from the stored sale and the id, never from the header, so the
  // bytes are checked against what this seller issued and nothing the buyer said.
  const expected: CanonicalPayment = {
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
  try {
    await assertPlainUsdcSend(payment.txBytes, expected, payment.sender);
  } catch {
    return refuse(402, SETTLE_REASONS.bytes);
  }
  if (!(await signedBy(payment.txBytes, payment.signature, payment.sender))) return refuse(402, SETTLE_REASONS.signature);

  const digest = TransactionDataBuilder.getDigestFromBytes(payment.txBytes);
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
  if (recorded.length !== 1) return refuse(409, SETTLE_REASONS.presented);

  let executed: ExecutionResult;
  try {
    executed = await chain.executeTransaction(payment.txBytes, [payment.signature]);
  } catch {
    return refuse(402, SETTLE_REASONS.unconfirmed);
  }
  const verdict = verifySettlement({ status: executed.status, balanceChanges: executed.balanceChanges }, expected, payment.sender);
  if (!verdict.verified) return refuse(402, executed.status === 'success' ? SETTLE_REASONS.mismatch : SETTLE_REASONS.failed);

  const settled = await db
    .update(sellerSales)
    .set({ status: 'settled', settledAt: now })
    .where(and(eq(sellerSales.challengeId, sale.challengeId), eq(sellerSales.status, 'rejected'), eq(sellerSales.digest, digest)))
    .returning({ id: sellerSales.id });
  if (settled.length !== 1) return refuse(409, SETTLE_REASONS.used);
  return { ok: true, digest, payer: payment.sender };
}
