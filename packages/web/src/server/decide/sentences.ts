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
// Every character with the Unicode Quotation_Mark property but the two apostrophes, U+0027 and
// U+2019, which cannot pass for the double quote these sentences wrap text in, and the ones that
// read as a quote mark without the property, both before NFKC and in the forms NFKC leaves: grave
// and acute accents and their modifier letters, modifier primes, apostrophes and turned commas,
// the double acute, double grave and double vertical line that NFKC leaves over a space, Armenian
// and N'Ko apostrophes, Hebrew geresh and gershayim, the Vedic nihshvasa, primes (NFKC folds a
// double prime into two), the dingbat quote ornaments, turned and reversed commas, the ditto
// mark, the saltillo and the fullwidth grave. Not covered: a letter or symbol that looks like a
// quote only in some font, or a run of apostrophes, which ordinary text needs.
const QUOTE_MARKS =
  /(?![\u0027\u2019])[\p{Quotation_Mark}\u0060\u00B4\u02B9-\u02BD\u02C8\u02CA\u02CB\u02DD\u02EE\u02F4-\u02F6\u030B\u030E\u030F\u055A\u059C-\u059E\u05F3\u05F4\u07F4\u07F5\u1CD3\u2032-\u2037\u2057\u275B-\u2760\u2E32\u2E41\u3003\uA78B\uA78C\uFF40\u{1F676}-\u{1F678}]/gu;

/**
 * Whether text holds a quote mark other than an apostrophe, or a character that reads as one, as
 * quoted() removes them, checked as written and after NFKC so a compatibility form cannot slip
 * past.
 */
export function hasQuoteMark(text: string): boolean {
  return text.search(QUOTE_MARKS) !== -1 || text.normalize('NFKC').search(QUOTE_MARKS) !== -1;
}

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
 * control, format and line-break characters turned into spaces, every quote mark but the two
 * apostrophes and every character that reads as one removed (QUOTE_MARKS), runs of space
 * collapsed, cut to `maxChars` characters, then wrapped in double quotes, so the text can never
 * seem to close its quotes and start a sentence of its own.
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
