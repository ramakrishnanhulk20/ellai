import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { DEPLOYMENT_NETWORK, SUI_MAINNET_CHAIN_ID } from '@ellai/core/network';
import { USDC_DECIMALS, USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { bcs } from '@mysten/sui/bcs';
import type { Database } from '../db/client.js';
import { sellerSales } from '../db/schema.js';

/**
 * A refusal from Ellai's own seller that is Ellai's fault, not the buyer's: a bad
 * configuration or a state the seller cannot issue from. The message is fixed text.
 */
export class SellerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SellerError';
  }
}

/** What a challenge id is bound to besides its own bits: the stored sale and the URL it sells. */
export interface ChallengeBinding {
  resource: string;
  recipient: string;
  amount: bigint;
}

/** The parts of a payment that seller_sales has no column for, read back out of the challenge id. */
export interface ChallengeTerms {
  nonce: number;
  minEpoch: bigint;
  maxEpoch: bigint;
}

interface IdParts {
  nonce: number;
  minEpoch: bigint;
  random: number;
}

const MS_PER_SECOND = 1_000;
const X402_VERSION = 1;
const ZERO_ADDRESS = canonicalSuiAddress('0x0');
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
// Sui refuses a gasless send whose window is wider than this, so every challenge uses the widest.
const EPOCH_SPAN = BigInt(LIMITS.paymentMaxEpochSpan);

// The challenge id is an RFC 9562 version 8 UUID, the version set aside for a layout of one's
// own. Its 122 free bits hold the nonce, the starting epoch, random bits so ids cannot be
// guessed, and a tag over everything the payment must match. seller_sales has no column for
// the nonce, the epochs or the resource, so they are read back from the id and the tag proves
// the id was issued for this resource, recipient and amount.
const NONCE_BITS = 32n;
const EPOCH_BITS = 32n;
const RANDOM_BITS = 26n;
const TAG_BITS = 32n;
const EPOCH_MAX = (1n << EPOCH_BITS) - 1n;
const UUID_LOW_BITS = 62n;
const UUID_MIDDLE_BITS = 12n;
const UUID_VERSION_8 = 0x8n;
const UUID_VARIANT_RFC = 0b10n;
const SELLER_CHALLENGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMITMENT_DOMAIN = 'ellai/seller-challenge/v1';

const mask = (bits: bigint) => (1n << bits) - 1n;

const Commitment = bcs.struct('EllaiSellerChallenge', {
  domain: bcs.string(),
  nonce: bcs.u32(),
  minEpoch: bcs.u64(),
  random: bcs.u32(),
  resource: bcs.string(),
  recipient: bcs.Address,
  amount: bcs.u64(),
});

function commitmentTag(parts: IdParts, binding: ChallengeBinding): bigint {
  const encoded = Commitment.serialize({
    domain: COMMITMENT_DOMAIN,
    nonce: parts.nonce,
    minEpoch: parts.minEpoch,
    random: parts.random,
    resource: binding.resource,
    recipient: binding.recipient,
    amount: binding.amount,
  }).toBytes();
  return BigInt(createHash('sha256').update(encoded).digest().readUInt32BE(0));
}

/**
 * Packs the parts and their tag into a version 8 UUID. Exported so tests can build an id with
 * chosen parts; the seller itself only calls it from issueWalletCheckChallenge.
 * Throws RangeError for a part that does not fit its bits.
 */
export function sellerChallengeId(parts: IdParts, binding: ChallengeBinding): string {
  if (!Number.isSafeInteger(parts.nonce) || parts.nonce < 0 || BigInt(parts.nonce) > mask(NONCE_BITS)) throw new RangeError('the nonce is not a u32');
  if (typeof parts.minEpoch !== 'bigint' || parts.minEpoch < 0n || parts.minEpoch > EPOCH_MAX) throw new RangeError('the epoch does not fit');
  if (!Number.isSafeInteger(parts.random) || parts.random < 0 || BigInt(parts.random) > mask(RANDOM_BITS)) throw new RangeError('the random part does not fit');
  const payload =
    (BigInt(parts.nonce) << (EPOCH_BITS + RANDOM_BITS + TAG_BITS)) |
    (parts.minEpoch << (RANDOM_BITS + TAG_BITS)) |
    (BigInt(parts.random) << TAG_BITS) |
    commitmentTag(parts, binding);
  const high = payload >> (UUID_LOW_BITS + UUID_MIDDLE_BITS);
  const middle = (payload >> UUID_LOW_BITS) & mask(UUID_MIDDLE_BITS);
  const low = payload & mask(UUID_LOW_BITS);
  const value = (high << 80n) | (UUID_VERSION_8 << 76n) | (middle << 64n) | (UUID_VARIANT_RFC << 62n) | low;
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Reads the nonce and the epoch window back out of a challenge id this seller issued, or null
 * when the text is not one of its ids or its tag does not match `binding`: another resource,
 * another recipient or another amount. Never throws.
 */
export function readSellerChallengeId(challengeId: string, binding: ChallengeBinding): ChallengeTerms | null {
  if (typeof challengeId !== 'string' || !SELLER_CHALLENGE_ID.test(challengeId)) return null;
  const value = BigInt(`0x${challengeId.replaceAll('-', '')}`);
  const high = value >> 80n;
  const middle = (value >> 64n) & mask(UUID_MIDDLE_BITS);
  const low = value & mask(UUID_LOW_BITS);
  const payload = (high << (UUID_LOW_BITS + UUID_MIDDLE_BITS)) | (middle << UUID_LOW_BITS) | low;
  const parts: IdParts = {
    nonce: Number(payload >> (EPOCH_BITS + RANDOM_BITS + TAG_BITS)),
    minEpoch: (payload >> (RANDOM_BITS + TAG_BITS)) & mask(EPOCH_BITS),
    random: Number((payload >> TAG_BITS) & mask(RANDOM_BITS)),
  };
  let expected: bigint;
  try {
    expected = commitmentTag(parts, binding);
  } catch {
    return null;
  }
  if (expected !== (payload & mask(TAG_BITS))) return null;
  return { nonce: parts.nonce, minEpoch: parts.minEpoch, maxEpoch: parts.minEpoch + EPOCH_SPAN };
}

/**
 * The resource a challenge is bound to, written by the WHATWG URL parser as origin plus path,
 * so the URL a challenge was issued at and the URL it is paid at compare after the same parse.
 * The query and fragment are dropped. Null for anything but a plain http or https URL with no
 * credentials, or one over LIMITS.resourceMaxLength.
 */
export function sellerResource(url: string): { resource: string; host: string } | null {
  if (typeof url !== 'string' || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const resource = `${parsed.origin}${parsed.pathname}`;
  if (resource.length > LIMITS.resourceMaxLength || !PRINTABLE_NO_SPACE.test(resource)) return null;
  return { resource, host: parsed.hostname };
}

/** Atomic units as a plain decimal with no trailing zeros, for example 10000n with 6 decimals as '0.01'. Throws RangeError below zero. */
export function decimalAmount(atomic: bigint, decimals: number): string {
  if (typeof atomic !== 'bigint' || atomic < 0n) throw new RangeError('an amount must be a whole number of atomic units, zero or more');
  const scale = 10n ** BigInt(decimals);
  const fraction = (atomic % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? `${atomic / scale}` : `${atomic / scale}.${fraction}`;
}

/** Throws SellerError for an invalid Date, so a NaN can never make an expiry look later. */
export function timestampOf(now: Date): number {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 0) throw new SellerError('the current time is not a timestamp');
  return ms;
}

function payableAddress(value: string): string {
  let address: string;
  try {
    address = canonicalSuiAddress(value);
  } catch {
    throw new SellerError('the seller pay-to address is not a Sui address');
  }
  if (address === ZERO_ADDRESS) throw new SellerError('the seller pay-to address is the zero address');
  return address;
}

/**
 * Issues a 402 for one wallet check, in the t2000 x402 v1 dialect that core's parseChallenge
 * reads and core's signPayment pays: a JSON body with one accepts entry asking for exactly
 * LIMITS.sellerPriceAtomic of Sui Mainnet USDC to `payTo`, valid for
 * LIMITS.sellerChallengeTtlMs, with a fresh challenge id, a random u32 nonce and the window
 * [current epoch, current epoch + 1] read through Tatum, mirrored in a WWW-Authenticate
 * "Payment" header whose recipient, currency and amount agree with the body under
 * parseChallenge. Stores the sale as 'issued' before returning, so only stored challenges pay.
 * Reads the chain once. Throws SellerError for a resource URL sellerResource refuses, a
 * pay-to address that is not a payable Sui address, an invalid `now`, an epoch past 2^32 - 1,
 * or an id that is already stored; throws ChainError when the epoch cannot be read.
 */
export async function issueWalletCheckChallenge(args: {
  db: Database;
  chain: Chain;
  resourceUrl: string;
  payTo: string;
  now: Date;
}): Promise<{ status: 402; headers: Record<string, string>; body: string; challengeId: string }> {
  const nowMs = timestampOf(args.now);
  const target = sellerResource(args.resourceUrl);
  if (target === null) throw new SellerError('the resource URL is not one this seller can sell');
  const payTo = payableAddress(args.payTo);
  const amount = BigInt(LIMITS.sellerPriceAtomic);

  const minEpoch = await args.chain.getCurrentEpoch();
  if (typeof minEpoch !== 'bigint' || minEpoch < 0n || minEpoch > EPOCH_MAX) throw new SellerError('the current epoch does not fit a challenge id');
  const parts: IdParts = {
    nonce: randomBytes(4).readUInt32BE(0),
    minEpoch,
    random: randomInt(2 ** Number(RANDOM_BITS)),
  };
  const challengeId = sellerChallengeId(parts, { resource: target.resource, recipient: payTo, amount });

  const stored = await args.db
    .insert(sellerSales)
    .values({
      challengeId,
      amountAtomic: amount,
      recipient: payTo,
      issuedAt: new Date(nowMs),
      expiresAt: new Date(nowMs + LIMITS.sellerChallengeTtlMs),
      status: 'issued',
    })
    .onConflictDoNothing({ target: sellerSales.challengeId })
    .returning({ id: sellerSales.id });
  if (stored.length !== 1) throw new SellerError('a challenge with this id is already stored');

  const body = {
    x402Version: X402_VERSION,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: DEPLOYMENT_NETWORK,
        asset: USDC_TYPE_MAINNET,
        maxAmountRequired: amount.toString(),
        payTo,
        resource: target.resource,
        maxTimeoutSeconds: LIMITS.sellerChallengeTtlMs / MS_PER_SECOND,
        extra: {
          suimpp: {
            challengeId,
            nonce: parts.nonce,
            chain: SUI_MAINNET_CHAIN_ID,
            minEpoch: minEpoch.toString(),
            maxEpoch: (minEpoch + EPOCH_SPAN).toString(),
          },
        },
      },
    ],
  };
  // The header copy carries the amount in display units, as t2000's own sellers send it.
  const authenticate = `Payment realm="${target.host}", recipient="${payTo}", currency="${USDC_TYPE_MAINNET}", amount="${decimalAmount(amount, USDC_DECIMALS)}"`;
  return {
    status: 402,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': authenticate },
    body: JSON.stringify(body),
    challengeId,
  };
}
