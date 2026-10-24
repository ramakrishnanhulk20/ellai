import { createHash } from 'node:crypto';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { USDC_DECIMALS } from '@ellai/core/usdc';

const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);
// The URL parser lets through hosts holding characters such as a double quote or a
// parenthesis. Only plain DNS characters are written out; anything else gets a fixed label.
const PLAIN_HOST = /^[a-z0-9.-]{1,253}$/;
// Control and format characters (bidi overrides, zero-width marks) and line or paragraph
// separators could split a sentence or reorder it on screen.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Every opening and closing quote mark, not only the straight one, so quoted text can never
// look as if it closed its own quotes.
const QUOTE_MARKS = /["\p{Pi}\p{Pf}]/gu;

/** Atomic USDC as a decimal with all six places, for example 10000n as '0.010000'. Throws RangeError below zero. */
export function formatUsdc(atomic: bigint): string {
  if (typeof atomic !== 'bigint' || atomic < 0n) throw new RangeError('formatUsdc needs a whole number of atomic units, zero or more');
  const whole = atomic / USDC_SCALE;
  const fraction = (atomic % USDC_SCALE).toString().padStart(USDC_DECIMALS, '0');
  return `${whole}.${fraction}`;
}

/** The seller host as shown in sentences and reasons, or "this seller" when it holds anything but plain DNS characters. */
export function hostLabel(host: string, startOfSentence = false): string {
  if (typeof host === 'string' && PLAIN_HOST.test(host)) return host;
  return startOfSentence ? 'This seller' : 'this seller';
}

/**
 * Agent or owner text made safe to sit inside an Ellai sentence: look-alike forms folded,
 * control, format and line-break characters turned into spaces, every quote mark removed,
 * runs of space collapsed, cut to `maxChars` characters, then wrapped in double quotes.
 */
export function quoted(text: string | null, maxChars: number): string {
  const cleaned = (text ?? '')
    .normalize('NFKC')
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(QUOTE_MARKS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return `"${Array.from(cleaned).slice(0, maxChars).join('').trim()}"`;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function paying(amountAtomic: bigint, recipient: string, sellerHost: string, purpose: string): string {
  return `paying ${formatUsdc(amountAtomic)} USDC to ${recipient} at ${hostLabel(sellerHost)} for ${quoted(purpose, LIMITS.sentencePurposeMaxChars)}`;
}

/**
 * The key that finds an earlier decision for the same request (C5): a SHA-256 hex digest
 * of a fixed-order JSON array of the agent id, seller URL, method, body hash, recipient,
 * amount as a base-10 string, asset, network and purpose. The challenge id and nonce are
 * left out on purpose, because a retry carries a fresh challenge for the same request.
 */
export function requestKey(args: {
  agentId: string;
  payment: CanonicalPayment;
  method: 'GET' | 'POST';
  bodyHash: string;
  purpose: string;
}): string {
  const { payment } = args;
  const canonical = JSON.stringify([
    'ellai-request-v1',
    args.agentId,
    payment.sellerUrl,
    args.method,
    args.bodyHash,
    payment.recipient,
    payment.amount.toString(10),
    payment.asset,
    payment.network,
    args.purpose,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The recall query for a payment, in the same shape as the decision sentences so they land close in meaning. */
export function querySentence(args: { payment: CanonicalPayment; purpose: string }): string {
  const { payment } = args;
  return `Paying ${formatUsdc(payment.amount)} USDC to ${payment.recipient} at ${hostLabel(payment.sellerHost)} for ${quoted(args.purpose, LIMITS.sentencePurposeMaxChars)}.`;
}

/** The memory sentence for an owner's answer. The reason, when given, is quoted like the purpose. */
export function ownerDecisionSentence(args: {
  verdict: 'approve' | 'refuse';
  recipient: string;
  amountAtomic: bigint;
  sellerHost: string;
  purpose: string;
  reason: string | null;
  date: Date;
}): string {
  const verb = args.verdict === 'approve' ? 'approved' : 'refused';
  const reason = args.reason === null || args.reason.trim() === '' ? '' : ` Reason: ${quoted(args.reason, LIMITS.reasonMaxChars)}.`;
  return `On ${day(args.date)} the owner ${verb} ${paying(args.amountAtomic, args.recipient, args.sellerHost, args.purpose)}.${reason}`;
}

/** The memory sentence for what a paid seller did. Outcomes only ever make later decisions stricter. */
export function outcomeSentence(args: {
  recipient: string;
  amountAtomic: bigint;
  sellerHost: string;
  purpose: string;
  delivered: boolean;
  date: Date;
}): string {
  const result = args.delivered ? 'the seller delivered' : 'the seller returned nothing';
  return `On ${day(args.date)} Ellai finished ${paying(args.amountAtomic, args.recipient, args.sellerHost, args.purpose)} and ${result}.`;
}
