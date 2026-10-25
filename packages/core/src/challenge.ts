import { normalizeStructTag } from '@mysten/sui/utils';
import { canonicalSuiAddress } from './keys.js';
import { LIMITS } from './limits.js';
import type { SafeResponse } from './net.js';
import { DEPLOYMENT_NETWORK, SUI_MAINNET_CHAIN_ID } from './network.js';
import { USDC_DECIMALS, USDC_TYPE_MAINNET } from './usdc.js';

export type Dialect = 'x402-v1-t2000' | 'x402-v2';

export interface CanonicalPayment {
  dialect: Dialect;
  /** The URL Ellai itself fetched, as normalised by the URL parser. */
  sellerUrl: string;
  /** From safeFetch, never from the agent. */
  sellerHost: string;
  /** normalizeSuiAddress form, checked valid. */
  recipient: string;
  /** Atomic USDC units. */
  amount: bigint;
  /** normalizeStructTag form; always USDC_TYPE_MAINNET. */
  asset: string;
  network: 'sui:mainnet';
  /** min(the challenge's own expiry, now + LIMITS.paymentValidityMs). */
  expiresAtMs: number;
  /** Length-capped, characters A-Z a-z 0-9 _ - : . only. */
  challengeId: string | null;
  /** Same rule as challengeId. */
  nonce: string | null;
  /** From the t2000 extra.suimpp block, when present. */
  minEpoch: bigint | null;
  maxEpoch: bigint | null;
  /** The challenge's resource field, length-capped. Informational only: never fetched or trusted. */
  resource: string | null;
}

export type ChallengeErrorCode =
  | 'NOT_402'
  | 'NO_DIALECT'
  | 'TWO_DIALECTS'
  | 'MALFORMED'
  | 'NO_PAYABLE_OPTION'
  | 'MANY_PAYABLE_OPTIONS'
  | 'COPIES_DISAGREE'
  | 'BAD_AMOUNT'
  | 'BAD_ASSET'
  | 'BAD_NETWORK'
  | 'EXPIRED'
  | 'TOO_LARGE'
  | 'UNSUPPORTED';

/**
 * Every refusal from parseChallenge. The message is fixed text: nothing the seller
 * wrote is copied in, because these messages reach logs and agents.
 */
export class ChallengeError extends Error {
  readonly code: ChallengeErrorCode;

  constructor(code: ChallengeErrorCode, message: string) {
    super(message);
    this.name = 'ChallengeError';
    this.code = code;
  }
}

const HTTP_PAYMENT_REQUIRED = 402;
const MS_PER_SECOND = 1_000;
const U32_MAX = 0xffff_ffff;
const U64_MAX = 2n ** 64n - 1n;
// Longer than any amount inside the limits, short enough that BigInt never sees a huge string.
const AMOUNT_MAX_CHARS = 40;
const EPOCH_MAX_CHARS = 20;

const ATOMIC_AMOUNT = /^[1-9][0-9]*$/;
const DECIMAL_AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const ID_CHARACTERS = /^[A-Za-z0-9_:.-]+$/;
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TOKEN = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y;

const MPP_PARAMS = ['id', 'method', 'intent', 'request'];
const T2000_PARAMS = ['recipient', 'currency', 'amount'];

type JsonRecord = Record<string, unknown>;

function refuse(code: ChallengeErrorCode, message: string): never {
  throw new ChallengeError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads own keys only, so a "__proto__" key in seller JSON is never followed.
function field(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function exceedsDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
  }
  return false;
}

/**
 * True when any object in `text` names one key twice, at any depth. JSON.parse keeps the last
 * copy and other parsers keep the first, so a seller could show Ellai one value and its own
 * verifier another. Each key is decoded by JSON.parse itself before it is compared, so "a" and
 * "a" are one key. Only called on text JSON.parse has already accepted; anything it cannot
 * read counts as a repeat, so it fails closed.
 */
function repeatsKey(text: string): boolean {
  // One entry per open object or array: the keys seen so far, or null for an array.
  const open: Array<Set<string> | null> = [];
  let keyNext = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return true;
      const keys = open[open.length - 1];
      if (keyNext && keys) {
        const key: unknown = JSON.parse(text.slice(i, end + 1));
        if (typeof key !== 'string' || keys.has(key)) return true;
        keys.add(key);
        keyNext = false;
      }
      i = end;
    } else if (char === '{') {
      open.push(new Set());
      keyNext = true;
    } else if (char === '[') {
      open.push(null);
      keyNext = false;
    } else if (char === '}' || char === ']') {
      open.pop();
      keyNext = false;
    } else if (char === ',') {
      keyNext = Boolean(open[open.length - 1]);
    }
  }
  return false;
}

function checkSize(text: string, what: string): void {
  if (Buffer.byteLength(text, 'utf8') > LIMITS.challengeMaxBytes) refuse('TOO_LARGE', `${what} is over the size cap`);
}

/**
 * Size and depth are checked on the raw text, before JSON.parse ever runs. Returns null for text
 * that is not a JSON object, and refuses an object that names one key twice at any depth (C3).
 */
function jsonObject(text: string, what: string): JsonRecord | null {
  checkSize(text, what);
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  if (exceedsDepth(trimmed, LIMITS.challengeMaxDepth)) refuse('TOO_LARGE', `${what} is nested too deeply`);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (repeatsKey(trimmed)) refuse('MALFORMED', `${what} names one key twice`);
  return value;
}

function base64JsonObject(value: string): JsonRecord {
  checkSize(value, 'PAYMENT-REQUIRED header');
  if (!STRICT_BASE64.test(value)) refuse('MALFORMED', 'PAYMENT-REQUIRED header is not base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'));
  } catch {
    refuse('MALFORMED', 'PAYMENT-REQUIRED header is not UTF-8');
  }
  const decoded = jsonObject(text, 'PAYMENT-REQUIRED header');
  if (decoded === null) refuse('MALFORMED', 'PAYMENT-REQUIRED header is not a JSON object');
  return decoded;
}

interface AuthChallenge {
  scheme: string;
  params: Map<string, string>;
}

function tokenAt(text: string, at: number): string | undefined {
  TOKEN.lastIndex = at;
  return TOKEN.exec(text)?.[0];
}

function skipSpace(text: string, at: number): number {
  let i = at;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  return i;
}

function readQuoted(text: string, at: number): { value: string; next: number } {
  let value = '';
  for (let i = at + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') return { value, next: i + 1 };
    if (char === '\\') {
      i += 1;
      if (i >= text.length) break;
      value += text[i];
    } else {
      value += char;
    }
  }
  return refuse('MALFORMED', 'WWW-Authenticate has an unterminated quoted value');
}

/**
 * Parses an RFC 9110 WWW-Authenticate value into its challenges, strictly: anything
 * that is not scheme, then name=token or name="quoted" pairs, refuses as MALFORMED,
 * and so does a parameter named twice in one challenge.
 */
function parseAuthChallenges(text: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  let current: AuthChallenge | null = null;
  let i = 0;
  while (i < text.length) {
    i = skipSpace(text, i);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (i >= text.length) break;
    const name = tokenAt(text, i);
    if (name === undefined) refuse('MALFORMED', 'WWW-Authenticate does not parse');
    i = skipSpace(text, i + name.length);
    if (text[i] !== '=') {
      current = { scheme: name.toLowerCase(), params: new Map() };
      challenges.push(current);
      continue;
    }
    if (current === null) refuse('MALFORMED', 'WWW-Authenticate has a parameter before any scheme');
    i = skipSpace(text, i + 1);
    let value: string;
    if (text[i] === '"') {
      const quoted = readQuoted(text, i);
      value = quoted.value;
      i = quoted.next;
    } else {
      const token = tokenAt(text, i);
      if (token === undefined) refuse('MALFORMED', 'WWW-Authenticate has a parameter with no value');
      value = token;
      i += token.length;
    }
    const key = name.toLowerCase();
    if (current.params.has(key)) refuse('MALFORMED', 'WWW-Authenticate names one parameter twice');
    current.params.set(key, value);
    i = skipSpace(text, i);
    if (i < text.length && text[i] !== ',') refuse('MALFORMED', 'WWW-Authenticate does not parse');
  }
  return challenges;
}

/**
 * The one amount parser. Atomic units (decimals 0) must match /^[1-9][0-9]*$/: no sign,
 * point, exponent or leading zero. Display units (t2000's header copy, in USDC) may
 * carry up to `decimals` places. Both come out as atomic units, so the copies compare
 * as integers.
 */
function amountFrom(value: unknown, decimals: number, what: string): bigint {
  if (typeof value !== 'string' || value.length > AMOUNT_MAX_CHARS) refuse('BAD_AMOUNT', `${what} is not an amount`);
  if (decimals === 0) {
    if (!ATOMIC_AMOUNT.test(value)) refuse('BAD_AMOUNT', `${what} is not a positive whole number of atomic units`);
    return BigInt(value);
  }
  const match = DECIMAL_AMOUNT.exec(value);
  const whole = match?.[1];
  const fraction = match?.[2] ?? '';
  if (whole === undefined || fraction.length > decimals) refuse('BAD_AMOUNT', `${what} is not a decimal amount`);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (atomic <= 0n) refuse('BAD_AMOUNT', `${what} is not positive`);
  return atomic;
}

function structTagOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return normalizeStructTag(value);
  } catch {
    return null;
  }
}

// Money sent to the zero address is gone for good; no real seller asks for it.
const ZERO_ADDRESS = canonicalSuiAddress('0x0');

function recipientFrom(value: unknown, what: string): string {
  if (typeof value !== 'string') refuse('MALFORMED', `${what} is missing`);
  let recipient: string;
  try {
    recipient = canonicalSuiAddress(value);
  } catch {
    return refuse('MALFORMED', `${what} is not a Sui address`);
  }
  if (recipient === ZERO_ADDRESS) refuse('MALFORMED', `${what} is the zero address`);
  return recipient;
}

function boundedId(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LIMITS.challengeIdMaxLength ||
    !ID_CHARACTERS.test(value)
  ) {
    refuse('MALFORMED', `${what} is not a short id`);
  }
  return value;
}

function nonceFrom(value: unknown): string {
  // t2000 sends a u32 as a JSON number; it is kept as its decimal string.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) refuse('MALFORMED', 'nonce is not a u32');
    return String(value);
  }
  return boundedId(value, 'nonce');
}

function epochFrom(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || value.length > EPOCH_MAX_CHARS || !UNSIGNED_INTEGER.test(value)) {
    refuse('MALFORMED', `${what} is not an epoch`);
  }
  const epoch = BigInt(value);
  if (epoch > U64_MAX) refuse('MALFORMED', `${what} is not an epoch`);
  return epoch;
}

function resourceFrom(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > LIMITS.resourceMaxLength || !PRINTABLE_NO_SPACE.test(value)) {
    refuse('MALFORMED', 'resource is not a short printable string');
  }
  return value;
}

function isPayable(option: JsonRecord): boolean {
  return field(option, 'network') === DEPLOYMENT_NETWORK && structTagOrNull(field(option, 'asset')) === USDC_TYPE_MAINNET;
}

/** Exactly one option may be payable. With a single option that is not, the refusal names why. */
function onlyPayableOption(accepts: unknown): JsonRecord {
  if (!Array.isArray(accepts)) refuse('MALFORMED', 'accepts is not a list');
  const options: JsonRecord[] = accepts.map((entry) => (isRecord(entry) ? entry : refuse('MALFORMED', 'accepts holds a non-object')));
  const payable = options.filter(isPayable);
  if (payable.length > 1) refuse('MANY_PAYABLE_OPTIONS', 'more than one option pays USDC on Sui Mainnet');
  const [chosen] = payable;
  if (chosen !== undefined) return chosen;
  const [only] = options;
  if (options.length === 1 && only !== undefined) {
    if (field(only, 'network') !== DEPLOYMENT_NETWORK) refuse('BAD_NETWORK', 'the only option is not on Sui Mainnet');
    refuse('BAD_ASSET', 'the only option does not pay in Sui Mainnet USDC');
  }
  return refuse('NO_PAYABLE_OPTION', 'no option pays USDC on Sui Mainnet');
}

interface Terms {
  recipient: string;
  amount: bigint;
  timeoutSeconds: number;
  resource: string | null;
}

function termsFrom(option: JsonRecord, rawAmount: unknown, resource: string | null): Terms {
  // t2000 marks a job-class entry, paid into an escrow object instead of by a plain
  // send, with extra.escrow. The key refuses whatever its shape, so a half-formed escrow
  // entry is never paid as a per-call payment.
  const extra = field(option, 'extra');
  if (isRecord(extra) && Object.hasOwn(extra, 'escrow')) refuse('UNSUPPORTED', 'escrow jobs are not paid, only per-call sellers');
  if (field(option, 'scheme') !== 'exact') refuse('MALFORMED', 'scheme is not exact');
  const amount = amountFrom(rawAmount, 0, 'amount');
  if (amount < BigInt(LIMITS.minPaymentAtomic) || amount > BigInt(LIMITS.maxPaymentAtomic)) {
    refuse('BAD_AMOUNT', 'amount is outside the per-payment limits');
  }
  const recipient = recipientFrom(field(option, 'payTo'), 'payTo');
  const timeoutSeconds = field(option, 'maxTimeoutSeconds');
  if (typeof timeoutSeconds !== 'number' || !Number.isSafeInteger(timeoutSeconds)) {
    refuse('MALFORMED', 'maxTimeoutSeconds is not a whole number');
  }
  return { recipient, amount, timeoutSeconds, resource };
}

interface T2000Extra {
  challengeId: string | null;
  nonce: string | null;
  minEpoch: bigint | null;
  maxEpoch: bigint | null;
}

function t2000Extra(option: JsonRecord): T2000Extra {
  const extra = field(option, 'extra');
  const suimpp = isRecord(extra) ? field(extra, 'suimpp') : undefined;
  if (suimpp === undefined) return { challengeId: null, nonce: null, minEpoch: null, maxEpoch: null };
  if (!isRecord(suimpp)) refuse('MALFORMED', 'extra.suimpp is not an object');
  const chain = field(suimpp, 'chain');
  if (typeof chain !== 'string') refuse('MALFORMED', 'extra.suimpp.chain is missing');
  if (chain !== SUI_MAINNET_CHAIN_ID) refuse('BAD_NETWORK', 'extra.suimpp.chain is not Sui Mainnet');
  const minEpoch = epochFrom(field(suimpp, 'minEpoch'), 'minEpoch');
  const maxEpoch = epochFrom(field(suimpp, 'maxEpoch'), 'maxEpoch');
  if (minEpoch > maxEpoch) refuse('MALFORMED', 'minEpoch is after maxEpoch');
  return {
    challengeId: boundedId(field(suimpp, 'challengeId'), 'challengeId'),
    nonce: nonceFrom(field(suimpp, 'nonce')),
    minEpoch,
    maxEpoch,
  };
}

function hasAny(challenge: AuthChallenge, names: string[]): boolean {
  return names.some((name) => challenge.params.has(name));
}

/** The t2000 WWW-Authenticate mirror must say what the body says, read by the same parsers. */
function checkT2000HeaderCopies(copies: AuthChallenge[], terms: Terms): void {
  for (const copy of copies) {
    const recipient = copy.params.get('recipient');
    if (recipient !== undefined && recipientFrom(recipient, 'header recipient') !== terms.recipient) {
      refuse('COPIES_DISAGREE', 'header and body name different recipients');
    }
    const currency = copy.params.get('currency');
    if (currency !== undefined) {
      const asset = structTagOrNull(currency);
      if (asset === null) refuse('MALFORMED', 'header currency is not a coin type');
      if (asset !== USDC_TYPE_MAINNET) refuse('COPIES_DISAGREE', 'header and body name different assets');
    }
    const amount = copy.params.get('amount');
    if (amount !== undefined && amountFrom(amount, USDC_DECIMALS, 'header amount') !== terms.amount) {
      refuse('COPIES_DISAGREE', 'header and body ask for different amounts');
    }
  }
}

function v1Terms(body: JsonRecord): { terms: Terms; extra: T2000Extra } {
  const option = onlyPayableOption(field(body, 'accepts'));
  const terms = termsFrom(option, field(option, 'maxAmountRequired'), resourceFrom(field(option, 'resource')));
  return { terms, extra: t2000Extra(option) };
}

function v2Terms(copy: JsonRecord): Terms {
  const option = onlyPayableOption(field(copy, 'accepts'));
  const resource = field(copy, 'resource');
  if (resource !== undefined && !isRecord(resource)) refuse('MALFORMED', 'resource is not an object');
  return termsFrom(option, field(option, 'amount'), resource === undefined ? null : resourceFrom(field(resource, 'url')));
}

function sameTerms(a: Terms, b: Terms): boolean {
  return a.recipient === b.recipient && a.amount === b.amount && a.timeoutSeconds === b.timeoutSeconds && a.resource === b.resource;
}

function entriesCarry(root: JsonRecord, key: string): boolean {
  const accepts = field(root, 'accepts');
  return Array.isArray(accepts) && accepts.some((entry) => isRecord(entry) && Object.hasOwn(entry, key));
}

function lowercasedHeaders(headers: Record<string, string>): Map<string, string> {
  if (!isRecord(headers)) refuse('MALFORMED', 'headers are missing');
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (typeof value !== 'string' || out.has(key)) refuse('MALFORMED', 'headers are not a plain name to text map');
    out.set(key, value);
  }
  return out;
}

function sellerOf(res: SafeResponse): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(res.url);
  } catch {
    return refuse('MALFORMED', 'seller URL does not parse');
  }
  // The host must be the one the URL parser gives for the URL that was fetched, so the
  // two can never name different sellers.
  if (
    parsed.protocol !== 'https:' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname !== res.host ||
    parsed.hash !== '' ||
    parsed.href !== res.url
  ) {
    refuse('MALFORMED', 'seller URL and host do not match');
  }
  return { url: parsed.href, host: parsed.hostname };
}

/**
 * Turns a seller's unpaid response into the one canonical payment every later step
 * reads, or refuses it.
 *
 * Reads two dialects, x402 v1 as t2000 sellers send it (JSON body, mirrored in a
 * WWW-Authenticate "Payment" header) and x402 v2 (base64 PAYMENT-REQUIRED header and
 * or JSON body). Exactly one option may pay USDC on Sui Mainnet; every copy of a value
 * must agree once read by the same parser; no object in the body or the header copy may
 * name one key twice, since parsers differ on which copy wins; the amount must be whole atomic units
 * within LIMITS. The result is a new frozen object built field by field, never a merge
 * of seller JSON.
 *
 * Throws ChallengeError with one of: NOT_402, NO_DIALECT (including MPP, not supported
 * yet), TWO_DIALECTS, MALFORMED, NO_PAYABLE_OPTION, MANY_PAYABLE_OPTIONS,
 * COPIES_DISAGREE, BAD_AMOUNT, BAD_ASSET, BAD_NETWORK, EXPIRED, TOO_LARGE, UNSUPPORTED
 * (a t2000 escrow job entry).
 */
export function parseChallenge(res: SafeResponse, nowMs: number): CanonicalPayment {
  if (!isRecord(res)) refuse('MALFORMED', 'response is missing');
  if (res.status !== HTTP_PAYMENT_REQUIRED) refuse('NOT_402', 'seller did not answer 402');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) refuse('MALFORMED', 'current time is not a timestamp');
  const seller = sellerOf(res);
  const headers = lowercasedHeaders(res.headers);
  if (typeof res.bodyText !== 'string') refuse('MALFORMED', 'body is missing');

  const body = jsonObject(res.bodyText, 'body');
  const paymentRequired = headers.get('payment-required');
  const v2Header = paymentRequired === undefined ? null : base64JsonObject(paymentRequired);
  const authText = headers.get('www-authenticate');
  if (authText !== undefined) checkSize(authText, 'WWW-Authenticate header');
  const paymentAuth = authText === undefined ? [] : parseAuthChallenges(authText).filter((c) => c.scheme === 'payment');

  const mppAuth = paymentAuth.filter((c) => hasAny(c, MPP_PARAMS));
  const t2000Auth = paymentAuth.filter((c) => hasAny(c, T2000_PARAMS));
  if (paymentAuth.some((c) => !hasAny(c, MPP_PARAMS) && !hasAny(c, T2000_PARAMS))) {
    refuse('MALFORMED', 'WWW-Authenticate Payment challenge carries no payment terms');
  }

  const version = body === null ? undefined : field(body, 'x402Version');
  const v1Body = body !== null && version === 1 ? body : null;
  const v2Body = body !== null && version === 2 ? body : null;
  const v2Copies = [v2Header, v2Body].filter((copy): copy is JsonRecord => copy !== null);

  const dialects = new Set<string>();
  if (v1Body !== null) dialects.add('x402-v1');
  if (v2Copies.length > 0) dialects.add('x402-v2');
  if (v1Body !== null && entriesCarry(v1Body, 'amount')) dialects.add('x402-v2');
  if (v2Copies.some((copy) => entriesCarry(copy, 'maxAmountRequired'))) dialects.add('x402-v1');
  // t2000's header mirror belongs to the v1 body. On its own it is the older digest dialect.
  if (t2000Auth.length > 0 && v1Body === null) dialects.add('t2000-digest');
  if (mppAuth.length > 0) dialects.add('mpp');
  if (dialects.size > 1) refuse('TWO_DIALECTS', 'challenge matches more than one dialect');
  if (!dialects.has('x402-v1') && !dialects.has('x402-v2')) refuse('NO_DIALECT', 'no supported payment dialect');

  let dialect: Dialect;
  let terms: Terms;
  let extra: T2000Extra = { challengeId: null, nonce: null, minEpoch: null, maxEpoch: null };
  if (v1Body !== null) {
    dialect = 'x402-v1-t2000';
    ({ terms, extra } = v1Terms(v1Body));
    checkT2000HeaderCopies(t2000Auth, terms);
  } else {
    dialect = 'x402-v2';
    const [first, ...others] = v2Copies.map(v2Terms);
    if (first === undefined) return refuse('NO_DIALECT', 'no supported payment dialect');
    if (others.some((other) => !sameTerms(first, other))) refuse('COPIES_DISAGREE', 'header and body copies disagree');
    terms = first;
  }

  if (terms.timeoutSeconds <= 0) refuse('EXPIRED', 'challenge allows no time to pay');
  const expiresAtMs = Math.min(nowMs + terms.timeoutSeconds * MS_PER_SECOND, nowMs + LIMITS.paymentValidityMs);

  return Object.freeze({
    dialect,
    sellerUrl: seller.url,
    sellerHost: seller.host,
    recipient: terms.recipient,
    amount: terms.amount,
    asset: USDC_TYPE_MAINNET,
    network: DEPLOYMENT_NETWORK,
    expiresAtMs,
    challengeId: extra.challengeId,
    nonce: extra.nonce,
    minEpoch: extra.minEpoch,
    maxEpoch: extra.maxEpoch,
    resource: terms.resource,
  });
}
