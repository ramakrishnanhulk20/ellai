import { PaymentError, type PaymentErrorCode } from '@ellai/core/payment';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { AgentError, type AgentErrorCode } from '../auth/agents.js';
import { SignInError, type SignInErrorCode } from '../auth/signin.js';
import { AnswerError, type AnswerErrorCode } from '../decide/answer.js';
import { DecideError, type DecideErrorCode } from '../decide/decide.js';
import { OnboardingError, type OnboardingErrorCode } from '../onboarding/state.js';
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
  | 'bad_body';

const HTTP_ERROR_MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  cross_origin: 'This request did not come from the Ellai app.',
  signed_out: 'Sign in to Ellai to continue.',
  rate_limited: 'Too many requests. Try again in a minute.',
  not_found: 'There is nothing here.',
  bad_content_type: 'Send the request body as application/json in UTF-8.',
  body_too_large: 'The request body is too large.',
  bad_json: 'The request body could not be read as JSON.',
  bad_body: 'The request body does not have the fields this endpoint takes.',
};

/**
 * A refusal the HTTP layer makes itself. The message comes from the code alone, so it can
 * never carry anything the caller sent (C19). Throws RangeError for a status that is not 4xx
 * or 5xx, which is a server bug.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;

  constructor(status: number, code: HttpErrorCode) {
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError('an HTTP error status must be 400 to 599');
    super(HTTP_ERROR_MESSAGES[code]);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

// Typed as complete records, so a code added to one of these classes without a status here
// fails the typecheck instead of quietly becoming a 500.
const SIGN_IN_STATUS: Readonly<Record<SignInErrorCode, number>> = {
  BAD_ADDRESS: 400,
  BAD_MESSAGE: 400,
  WRONG_SITE: 400,
  BAD_SIGNATURE: 401,
  ZKLOGIN_UNAVAILABLE: 400,
  NONCE_UNKNOWN: 401,
  NONCE_USED: 401,
  NONCE_EXPIRED: 401,
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

const FALLBACK_MESSAGE = 'The request was refused.';
// The known classes promise fixed text plus values Ellai checked itself. This holds them to
// it on the way out, since the next reader may be a page or an agent (C17).
const SAFE_MESSAGE = /^[^\p{Cc}]{1,300}$/u;
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

function mapKnown(error: unknown): Mapped | null {
  if (error instanceof HttpError) return coded(error.status, error.code, error.message);
  if (error instanceof SignInError) return coded(SIGN_IN_STATUS[error.code], error.code, error.message);
  if (error instanceof AnswerError) return coded(ANSWER_STATUS[error.code], error.code, error.message);
  if (error instanceof DecideError) return coded(DECIDE_STATUS[error.code], error.code, error.message);
  if (error instanceof AgentError) return coded(AGENT_STATUS[error.code], error.code, error.message);
  if (error instanceof OnboardingError) return coded(ONBOARDING_STATUS[error.code], error.code, error.message);
  if (error instanceof PaymentError) return coded(PAYMENT_STATUS[error.code], error.code, error.message);
  if (error instanceof SellerError) return { ...SELLER_UNAVAILABLE, logCode: 'SELLER' };
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

function errorJson(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status, headers: API_RESPONSE_HEADERS });
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
 * fixed text. Anything else, including a database error whose text carries SQL and
 * parameters, becomes 500 { error: 'internal' } with nothing taken from the error (C19).
 * The log line holds only the class name and its code. Never throws.
 */
export function toErrorResponse(error: unknown): Response {
  const known = mapKnown(error);
  if (known !== null) {
    const log = known.status >= 500 ? console.error : console.warn;
    log(`[ellai http] ${className(error)} ${known.logCode}`);
    return errorJson(known.status, { error: known.code, message: known.message });
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
