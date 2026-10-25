import { ChainError, type ChainErrorCode } from '@ellai/core/chain';
import { ChallengeError, type ChallengeErrorCode } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError, type MemoryErrorCode } from '@ellai/core/memory';
import { NetError, type NetErrorCode } from '@ellai/core/net';
import { PaymentError, type PaymentErrorCode } from '@ellai/core/payment';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { AgentError, type AgentErrorCode } from '../auth/agents.js';
import { SignInError, type SignInErrorCode } from '../auth/signin.js';
import { AnswerError, type AnswerErrorCode } from '../decide/answer.js';
import { DecideError, type DecideErrorCode } from '../decide/decide.js';
import { MemoryServiceError, type MemoryServiceErrorCode } from '../memory/delegate.js';
import { OnboardingError, type OnboardingErrorCode } from '../onboarding/state.js';
import { ProofUnavailableError } from '../public/proof.js';
import { SellerError } from '../seller/challenge.js';

/**
 * Headers on every API response. Owner data must never sit in a shared cache, and a JSON
 * body must never be sniffed into something a browser would run.
 */
export const API_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export type HttpErrorCode =
  | 'cross_origin'
  | 'signed_out'
  | 'rate_limited'
  | 'not_found'
  | 'bad_content_type'
  | 'body_too_large'
  | 'bad_json'
  | 'bad_body'
  | 'agent_unauthorized'
  | 'jobs_unauthorized'
  | 'too_many_agent_creates'
  | 'bad_query'
  | 'out_of_bounds'
  | 'too_many_requests'
  | 'bad_task'
  | 'chain_refused'
  | 'chain_unavailable';

/** The one code whose refusal may say which bound was passed, in a sentence Ellai wrote. */
export type BoundsHttpErrorCode = 'out_of_bounds';

const HTTP_ERROR_MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  cross_origin: 'This request did not come from the Ellai app.',
  signed_out: 'Sign in to Ellai to continue.',
  rate_limited: 'Too many requests. Try again in a minute.',
  not_found: 'There is nothing here.',
  bad_content_type: 'Send the request body as application/json in UTF-8.',
  body_too_large: 'The request body is too large.',
  bad_json: 'The request body could not be read as JSON.',
  bad_body: 'The request body does not have the fields this endpoint takes.',
  agent_unauthorized: 'Send a valid Ellai agent token as Authorization: Bearer <token>.',
  jobs_unauthorized: 'This endpoint needs the jobs secret.',
  too_many_agent_creates: 'Too many agent keys were made this hour. Try again later.',
  bad_query: 'The query string does not have the values this endpoint takes.',
  out_of_bounds: 'A value in the request is outside the bounds this endpoint allows.',
  too_many_requests: 'Too many requests. Try again in a minute.',
  bad_task: `The task must be 1 to ${LIMITS.agentTaskMaxChars} characters.`,
  chain_refused: 'Sui does not allow this step for your Walrus Memory account right now.',
  chain_unavailable: 'Ellai could not read Sui just now. Try again in a minute.',
};

// RFC 6750 section 3: a 401 from a resource behind a bearer token names the scheme it wants. Each
// credential has a realm of its own, so a caller can tell which one was refused.
const BEARER_CHALLENGES: Readonly<Partial<Record<HttpErrorCode, string>>> = {
  agent_unauthorized: 'Bearer realm="ellai"',
  jobs_unauthorized: 'Bearer realm="ellai-jobs"',
};

/**
 * The one body for a per-minute limit (C22), the same from every route and every MCP tool.
 * Nothing in it comes from the caller (C19).
 */
export const TOO_MANY_REQUESTS = { error: 'too_many_requests', message: HTTP_ERROR_MESSAGES.too_many_requests } as const;

// The known classes promise fixed text plus values Ellai checked itself. This holds them to
// it on the way out, since the next reader may be a page or an agent (C17).
const SAFE_MESSAGE = new RegExp(`^[^\\p{Cc}]{1,${LIMITS.errorMessageMaxChars}}$`, 'u');

/**
 * A refusal the HTTP layer makes itself. The message comes from the code alone, so it can
 * never carry anything the caller sent (C19). The one exception is out_of_bounds, which may
 * carry a sentence naming the bound that was passed; it must be fixed text and limits Ellai
 * wrote, never the caller's value, and one that is not a single short line is replaced by the
 * code's own text. Throws RangeError for a status that is not 4xx or 5xx, which is a server bug.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;

  constructor(status: number, code: HttpErrorCode);
  constructor(status: number, code: BoundsHttpErrorCode, detail: string);
  constructor(status: number, code: HttpErrorCode, detail?: string) {
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError('an HTTP error status must be 400 to 599');
    const detailed = code === 'out_of_bounds' && typeof detail === 'string' && SAFE_MESSAGE.test(detail);
    super(detailed ? detail : HTTP_ERROR_MESSAGES[code]);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The JSON answer for one HttpError, exactly as toErrorResponse gives it, for a helper that
 * returns its refusal rather than throwing it. A 401 for a bearer credential carries its
 * WWW-Authenticate challenge. Logs nothing: the caller logs its own line.
 */
export function httpErrorResponse(error: HttpError): Response {
  return errorJson(error.status, { error: error.code, message: error.message }, BEARER_CHALLENGES[error.code]);
}

/** The 429 answer with TOO_MANY_REQUESTS as its body. Logs nothing: the caller logs its own line. */
export function tooManyRequestsResponse(): Response {
  return errorJson(429, TOO_MANY_REQUESTS);
}

// Typed as complete records, so a code added to one of these classes without a status here
// fails the typecheck instead of quietly becoming a 500.
const SIGN_IN_STATUS: Readonly<Record<SignInErrorCode, number>> = {
  BAD_ADDRESS: 400,
  BAD_MESSAGE: 400,
  WRONG_SITE: 400,
  BAD_SIGNATURE: 401,
  ZKLOGIN_UNAVAILABLE: 400,
  CHAIN_UNAVAILABLE: 503,
  NONCE_UNKNOWN: 401,
  NONCE_USED: 401,
  NONCE_EXPIRED: 401,
};

// A sign-in refusal the HTTP table already names answers with that code and its text, so a
// caller reads one chain_unavailable whichever route it came from.
const SIGN_IN_AS_HTTP: Readonly<Partial<Record<SignInErrorCode, HttpErrorCode>>> = {
  CHAIN_UNAVAILABLE: 'chain_unavailable',
};

const ANSWER_STATUS: Readonly<Record<AnswerErrorCode, number>> = {
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  ANSWERED: 409,
  NOT_ASKED: 409,
};

const DECIDE_STATUS: Readonly<Record<DecideErrorCode, number>> = {
  BAD_INPUT: 400,
  BAD_PURPOSE: 400,
  OWNER: 404,
  AGENT: 403,
  REQUEST_MISMATCH: 409,
};

const AGENT_STATUS: Readonly<Record<AgentErrorCode, number>> = {
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  TOO_MANY_AGENTS: 409,
};

const ONBOARDING_STATUS: Readonly<Record<OnboardingErrorCode, number>> = {
  BAD_INPUT: 400,
  NO_OWNER: 404,
  NOT_READY: 409,
  NOT_LANDED: 409,
  REFUSED: 422,
};

const PAYMENT_STATUS: Readonly<Record<PaymentErrorCode, number>> = {
  UNSUPPORTED_DIALECT: 422,
  EXPIRED: 409,
  WRONG_EPOCH: 409,
  MISMATCH: 500,
  BUILD_FAILED: 500,
};

// SellerError has no code and its text describes Ellai's own configuration, which is no
// business of the caller's, so it gets fixed wording of its own.
const SELLER_UNAVAILABLE = { status: 503, code: 'seller_unavailable', message: 'Ellai cannot serve this request right now.' } as const;

const PROOF_UNAVAILABLE = { status: 503, code: 'proof_unavailable', message: 'The public proof cannot be read right now. Try again in a minute.' } as const;

// These classes write their messages from fixed text plus values they checked, such as a
// digest, a status code or a count. That is fine in a log line but not owed to the caller, so
// each class answers with one fixed sentence and its code names the failure. Each table is a
// complete record, like the ones above, so a new code fails the typecheck instead of a 500.
const CHAIN_STATUS: Readonly<Record<ChainErrorCode, number>> = {
  INVALID_INPUT: 502,
  NOT_FOUND: 502,
  TIMEOUT: 504,
  RATE_LIMITED: 503,
  UNAUTHORIZED: 503,
  UPSTREAM: 502,
  BAD_RESPONSE: 502,
  LIMIT_EXCEEDED: 502,
};

// Every one of these is a seller answer Ellai would not act on, so each is a bad gateway.
const CHALLENGE_STATUS: Readonly<Record<ChallengeErrorCode, number>> = {
  NOT_402: 502,
  NO_DIALECT: 502,
  TWO_DIALECTS: 502,
  MALFORMED: 502,
  NO_PAYABLE_OPTION: 502,
  MANY_PAYABLE_OPTIONS: 502,
  COPIES_DISAGREE: 502,
  BAD_AMOUNT: 502,
  BAD_ASSET: 502,
  BAD_NETWORK: 502,
  EXPIRED: 502,
  TOO_LARGE: 502,
  UNSUPPORTED: 502,
};

// A URL that is malformed or names a private address is the caller's to fix; the rest is the far side.
const NET_STATUS: Readonly<Record<NetErrorCode, number>> = {
  BAD_URL: 400,
  NOT_PUBLIC: 400,
  REDIRECT: 502,
  TIMEOUT: 504,
  TOO_LARGE: 502,
  NETWORK: 502,
};

const MEMORY_STATUS: Readonly<Record<MemoryErrorCode, number>> = {
  ACCOUNT: 502,
  DELEGATE: 502,
  WRITE: 502,
  RECALL: 502,
  TIMEOUT: 504,
  RATE_LIMITED: 503,
  UPSTREAM: 502,
};

const MEMORY_SERVICE_STATUS: Readonly<Record<MemoryServiceErrorCode, number>> = {
  BAD_INPUT: 400,
  OWNER: 404,
  NO_ACCOUNT: 409,
  DECISION: 404,
  SEND_UNCERTAIN: 503,
};

const FIXED_MESSAGES = {
  chain: 'Ellai could not read Sui just now. Try again shortly.',
  challenge: "Ellai could not read this seller's price safely.",
  net: 'Ellai could not reach this address safely.',
  memory: 'Walrus Memory could not be reached just now. Try again shortly.',
  memory_service: 'Ellai could not finish this memory step.',
} as const;

const FALLBACK_MESSAGE = 'The request was refused.';
const SAFE_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

interface Mapped {
  status: number;
  code: string;
  message: string;
  logCode: string;
}

function coded(status: number, code: string, message: string): Mapped {
  return { status, code: code.toLowerCase(), message: SAFE_MESSAGE.test(message) ? message : FALLBACK_MESSAGE, logCode: code };
}

// A code outside its class's closed set means the object did not come from that class's own
// code paths, so it gets no status from the table and is answered as unknown.
function fixed(table: Readonly<Record<string, number>>, kind: keyof typeof FIXED_MESSAGES, code: unknown): Mapped | null {
  if (typeof code !== 'string' || !Object.hasOwn(table, code)) return null;
  const status = table[code];
  if (status === undefined) return null;
  return { status, code: `${kind}_${code.toLowerCase()}`, message: FIXED_MESSAGES[kind], logCode: code };
}

function mapKnown(error: unknown): Mapped | null {
  if (error instanceof HttpError) return coded(error.status, error.code, error.message);
  if (error instanceof SignInError) {
    const shared = SIGN_IN_AS_HTTP[error.code];
    return shared === undefined ? coded(SIGN_IN_STATUS[error.code], error.code, error.message) : coded(SIGN_IN_STATUS[error.code], shared, HTTP_ERROR_MESSAGES[shared]);
  }
  if (error instanceof AnswerError) return coded(ANSWER_STATUS[error.code], error.code, error.message);
  if (error instanceof DecideError) return coded(DECIDE_STATUS[error.code], error.code, error.message);
  if (error instanceof AgentError) return coded(AGENT_STATUS[error.code], error.code, error.message);
  if (error instanceof OnboardingError) return coded(ONBOARDING_STATUS[error.code], error.code, error.message);
  if (error instanceof PaymentError) return coded(PAYMENT_STATUS[error.code], error.code, error.message);
  if (error instanceof SellerError) return { ...SELLER_UNAVAILABLE, logCode: 'SELLER' };
  if (error instanceof ProofUnavailableError) return { ...PROOF_UNAVAILABLE, logCode: 'PROOF' };
  if (error instanceof ChainError) return fixed(CHAIN_STATUS, 'chain', error.code);
  if (error instanceof ChallengeError) return fixed(CHALLENGE_STATUS, 'challenge', error.code);
  if (error instanceof NetError) return fixed(NET_STATUS, 'net', error.code);
  if (error instanceof MemoryError) return fixed(MEMORY_STATUS, 'memory', error.code);
  if (error instanceof MemoryServiceError) return fixed(MEMORY_SERVICE_STATUS, 'memory_service', error.code);
  return null;
}

// error.name, not the constructor's name, because production builds minify class names; every
// class in this codebase sets its name as a literal. DrizzleQueryError never sets one, and its
// message holds the SQL and the bound values, so it is recognised by class and only labelled.
function className(error: unknown): string {
  if (typeof error !== 'object' || error === null) return `thrown_${typeof error}`;
  if (error instanceof DrizzleQueryError) return 'DrizzleQueryError';
  const name: unknown = (error as { name?: unknown }).name;
  return typeof name === 'string' && SAFE_NAME.test(name) ? name : 'Unknown';
}

function errorJson(status: number, body: Record<string, string>, challenge?: string): Response {
  return Response.json(body, { status, headers: challenge === undefined ? API_RESPONSE_HEADERS : { ...API_RESPONSE_HEADERS, 'www-authenticate': challenge } });
}

// A database error's code is its SQLSTATE, which names the kind of failure without any of
// the query, so it is the one part of a DrizzleQueryError's cause worth logging.
function codeOf(error: unknown): string | null {
  const source: unknown = error instanceof DrizzleQueryError ? error.cause : error;
  if (typeof source !== 'object' || source === null) return null;
  const code: unknown = (source as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : null;
}

/**
 * The JSON response for anything a route handler threw. A class from this codebase becomes
 * its status with { error: code in lower case, message }, the message being that class's
 * fixed text; for ChainError, ChallengeError, NetError, MemoryError and MemoryServiceError the
 * code is prefixed with the kind (chain_timeout) and the message is one fixed sentence per
 * class, whatever the error itself says. Anything else, including a database error whose
 * text carries SQL and parameters, becomes 500 { error: 'internal' } with nothing taken from
 * the error (C19). An HttpError 401 for a bearer credential (agent_unauthorized,
 * jobs_unauthorized) carries that credential's WWW-Authenticate challenge.
 * The log line holds only the class name and its code. Never throws.
 */
export function toErrorResponse(error: unknown): Response {
  const known = mapKnown(error);
  if (known !== null) {
    const log = known.status >= 500 ? console.error : console.warn;
    log(`[ellai http] ${className(error)} ${known.logCode}`);
    const challenge = error instanceof HttpError ? BEARER_CHALLENGES[error.code] : undefined;
    return errorJson(known.status, { error: known.code, message: known.message }, challenge);
  }
  const code = codeOf(error);
  console.error(`[ellai http] ${className(error)}${code === null ? '' : ` ${code}`}`);
  return errorJson(500, { error: 'internal' });
}

/** Runs a route handler's body and turns anything it throws into toErrorResponse's answer. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return toErrorResponse(error);
  }
}
