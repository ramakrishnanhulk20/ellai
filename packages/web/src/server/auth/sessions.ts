import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { SESSION_TOKEN_PREFIX, hashBearerToken, isBearerToken } from './tokens.js';

/** The session cookie's name on plain-http localhost, the one place it is not Secure. */
export const SESSION_COOKIE_NAME = 'ellai_session';
/**
 * Its name whenever it is Secure. A browser keeps a __Host- cookie only when it was set Secure,
 * with Path=/ and no Domain, by this exact host, so a sibling site on a shared parent domain or
 * a plain-http response cannot plant or overwrite one.
 */
export const SECURE_SESSION_COOKIE_NAME = '__Host-ellai_session';

/** The one rule for the cookie's name, shared by the cookie written, the one read and the one cleared. */
export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

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
 * Ends every live session of one owner, the one asking included, by setting revoked_at to `now`
 * on each that is neither revoked nor expired, so a copied session token stops working however
 * many there are (C13, C14). Sessions already ended keep the time they ended at. Returns how
 * many were ended. Throws Error if `now` is not a date.
 */
export async function endOwnerSessions(args: { db: Database; ownerId: string; now: Date }): Promise<number> {
  const now = checkNow(args.now);
  const ended = await args.db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.ownerId, args.ownerId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .returning({ id: sessions.id });
  return ended.length;
}

/**
 * The Set-Cookie value that carries a session token: HttpOnly, SameSite=Strict, Path=/, no
 * Domain, Max-Age counted from the current clock to `expiresAt` (0 once it has passed), and
 * Secure under the name SECURE_SESSION_COOKIE_NAME unless `secure` is exactly false, which only
 * local plain-http development should pass and which keeps the name SESSION_COOKIE_NAME.
 * Throws Error, without repeating the value, for anything that is not exactly a session
 * token, because the value is written into the header as it is and could otherwise add
 * cookie attributes of its own. Throws Error if `expiresAt` is not a date.
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  if (!isBearerToken(token, SESSION_TOKEN_PREFIX)) throw new Error('Only a session token can be set as the session cookie');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) throw new Error('The session expiry is not a date');
  const isSecure = secure !== false;
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const attributes = [`${sessionCookieName(isSecure)}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`];
  if (isSecure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * The session cookie's value from a Cookie request header, or undefined when the header
 * is missing, holds no session cookie, or holds more than one. Only the name
 * sessionCookieName gives for `secure` is read, so when the cookie is Secure a plain
 * ellai_session, which anyone on a shared parent domain could set, is never taken in its place.
 * As in sessionCookie, a `secure` that is anything but exactly false counts as Secure. The
 * value is returned as sent; resolveSession is what decides whether it is a session.
 */
export function readSessionCookie(cookieHeader: string | null, secure: boolean): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  const name = sessionCookieName(secure !== false);
  let found: string | undefined;
  for (const pair of cookieHeader.split(';')) {
    const equals = pair.indexOf('=');
    if (equals === -1 || pair.slice(0, equals).trim() !== name) continue;
    // Ellai sets exactly one, so a second was set by someone else, for example a sibling
    // site on a shared parent domain. Which one the browser lists first proves nothing.
    if (found !== undefined) return undefined;
    found = pair.slice(equals + 1).trim();
  }
  return found;
}
