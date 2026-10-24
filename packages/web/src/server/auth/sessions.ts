import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { SESSION_TOKEN_PREFIX, hashBearerToken, isBearerToken } from './tokens.js';

export const SESSION_COOKIE_NAME = 'ellai_session';

function checkNow(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  return now;
}

function sessionTokenHash(token: string | undefined, sessionSecretHex: string): string | null {
  if (!isBearerToken(token, SESSION_TOKEN_PREFIX)) return null;
  return hashBearerToken(token, sessionSecretHex);
}

/**
 * The owner and session a session token belongs to, or null for a missing, malformed,
 * unknown, expired or revoked token. Anything that is not exactly a session token,
 * including an agent token, is refused before any query. The owner comes only from the
 * session row. Throws Error if `now` is not a date or the secret is malformed.
 */
export async function resolveSession(args: {
  db: Database;
  token: string | undefined;
  sessionSecretHex: string;
  now: Date;
}): Promise<{ ownerId: string; sessionId: string } | null> {
  const now = checkNow(args.now);
  const hash = sessionTokenHash(args.token, args.sessionSecretHex);
  if (hash === null) return null;
  const [row] = await args.db
    .select({ ownerId: sessions.ownerId, sessionId: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
  return row ?? null;
}

/**
 * Ends the session a session token belongs to by setting its revoked_at to `now`, so it
 * never resolves again. Returns true when a session that was not already revoked was
 * ended, and false otherwise, including for a malformed token, which is refused before any
 * query. Throws Error if `now` is not a date or the secret is malformed.
 */
export async function endSession(args: { db: Database; token: string | undefined; sessionSecretHex: string; now: Date }): Promise<boolean> {
  const now = checkNow(args.now);
  const hash = sessionTokenHash(args.token, args.sessionSecretHex);
  if (hash === null) return false;
  const ended = await args.db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return ended.length === 1;
}

/**
 * The Set-Cookie value that carries a session token: HttpOnly, SameSite=Strict, Path=/,
 * Max-Age counted from the current clock to `expiresAt` (0 once it has passed), and Secure
 * unless `secure` is exactly false, which only local plain-http development should pass.
 * Throws Error, without repeating the value, for anything that is not exactly a session
 * token, because the value is written into the header as it is and could otherwise add
 * cookie attributes of its own. Throws Error if `expiresAt` is not a date.
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  if (!isBearerToken(token, SESSION_TOKEN_PREFIX)) throw new Error('Only a session token can be set as the session cookie');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) throw new Error('The session expiry is not a date');
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const attributes = [`${SESSION_COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`];
  if (secure !== false) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * The session cookie's value from a Cookie request header, or undefined when the header
 * is missing, holds no session cookie, or holds more than one. The value is returned as
 * sent; resolveSession is what decides whether it is a session.
 */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  let found: string | undefined;
  for (const pair of cookieHeader.split(';')) {
    const equals = pair.indexOf('=');
    if (equals === -1 || pair.slice(0, equals).trim() !== SESSION_COOKIE_NAME) continue;
    // Ellai sets exactly one, so a second was set by someone else, for example a sibling
    // site on a shared parent domain. Which one the browser lists first proves nothing.
    if (found !== undefined) return undefined;
    found = pair.slice(equals + 1).trim();
  }
  return found;
}
