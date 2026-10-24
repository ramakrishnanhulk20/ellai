import { LIMITS } from '@ellai/core/limits';
import type { SafeResponse } from '@ellai/core/net';
import type { SETTLEMENTS } from '../db/schema.js';
import { formatUsdc } from '../decide/sentences.js';

export type Settlement = (typeof SETTLEMENTS)[number];

/** The seller's answer, handed back as data and never read by Ellai. */
export interface SellerAnswer {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export interface PaidPayment {
  /** Computed by Ellai from the bytes it signed. */
  digest: string;
  /** Atomic USDC as a base-10 string, so it survives JSON. */
  amountAtomic: string;
  recipient: string;
  settlement: Settlement;
}

/**
 * What paidFetch tells the agent. `reason` is always text Ellai wrote from fixed sentences,
 * hosts, amounts and codes, never from the purpose, the seller's answer or memory text (C17).
 * `seller.body` is the seller's own answer, cut to LIMITS.sellerAnswerMaxChars characters.
 */
export type PaidFetchResult = {
  outcome: 'free' | 'paid' | 'asked' | 'refused' | 'failed';
  decisionId: string | null;
  rule: string | null;
  reason: string;
  citedMemories: Array<{ memoryId: string; blobId: string | null }>;
  seller: SellerAnswer | null;
  payment: PaidPayment | null;
};

// RFC 6838 section 4.2 caps a type name and a subtype name at 127 characters each.
const RESTRICTED_NAME = '[a-z0-9][a-z0-9!#$&^_.+-]{0,126}';
const MEDIA_TYPE = new RegExp(`^(${RESTRICTED_NAME}/${RESTRICTED_NAME})(?:\\s*;.*)?$`, 'is');
// What Ellai forwards for an agent: a media type and at most one plain name=value parameter
// (charset=utf-8, boundary=...), so the header is bounded and holds no quotes or line breaks.
const PLAIN_CONTENT_TYPE = new RegExp(`^${RESTRICTED_NAME}/${RESTRICTED_NAME}(?:[ \\t]*;[ \\t]*${RESTRICTED_NAME}=${RESTRICTED_NAME})?$`, 'i');

/** True when an agent's content type is one Ellai will send to a seller as it is. */
export function isPlainContentType(value: string): boolean {
  return PLAIN_CONTENT_TYPE.test(value);
}

/**
 * The type/subtype of a seller's content-type header, lowercased, or null when it is missing
 * or not a media type. Parameters are dropped: safeFetch decodes every body as UTF-8 whatever
 * charset the seller names, so a charset would describe bytes the agent never sees.
 */
export function mediaType(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = MEDIA_TYPE.exec(header.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** The seller's answer as the agent receives it, cut by code point so no character is split. */
export function sellerAnswer(response: SafeResponse): SellerAnswer {
  const characters = Array.from(response.bodyText);
  const truncated = characters.length > LIMITS.sellerAnswerMaxChars;
  return {
    status: response.status,
    contentType: mediaType(response.headers['content-type']),
    body: truncated ? characters.slice(0, LIMITS.sellerAnswerMaxChars).join('') : response.bodyText,
    truncated,
  };
}

/** Atomic USDC with trailing zeros dropped down to two places, for example 10000n as '0.01'. */
export function shortUsdc(atomic: bigint): string {
  return formatUsdc(atomic).replace(/(\.\d\d\d*?)0+$/, '$1');
}

/** A result that carries no decision, no seller answer and no payment. */
export function bare(outcome: PaidFetchResult['outcome'], reason: string): PaidFetchResult {
  return { outcome, decisionId: null, rule: null, reason, citedMemories: [], seller: null, payment: null };
}
