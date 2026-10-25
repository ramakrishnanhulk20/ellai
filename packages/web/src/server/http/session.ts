import { readSessionCookie, resolveSession, sessionCookieName } from '../auth/sessions.js';
import type { ServerContext } from './context.js';
import { HttpError } from './errors.js';

/**
 * The owner a request acts for, taken from its session cookie alone (C13): nothing in the
 * path, query or body can name a different owner. The cookie is read under the name
 * cookieIsSecure gives for this app's origin, and no other. A missing, duplicated, malformed,
 * unknown, expired or ended session is 401 signed_out, the same answer for each, so the
 * response says nothing about which it was.
 */
export async function requireOwner(request: Request, ctx: ServerContext): Promise<{ ownerId: string; sessionId: string }> {
  const token = readSessionCookie(request.headers.get('cookie'), cookieIsSecure(ctx.env.APP_ORIGIN));
  const session = await resolveSession({ db: ctx.db, token, sessionSecretHex: ctx.env.SESSION_SECRET, now: ctx.now() });
  if (session === null) throw new HttpError(401, 'signed_out');
  return session;
}

/**
 * Whether the session cookie carries Secure, and so the __Host- name: whenever the app is
 * served over https (C14). env.ts allows plain http only for localhost in development and
 * tests, the one place a Secure cookie would never be sent back.
 */
export function cookieIsSecure(appOrigin: string): boolean {
  return new URL(appOrigin).protocol === 'https:';
}

/** A Set-Cookie value that empties the session cookie at once, under the same name and with the same attributes it was set with. */
export function clearedSessionCookie(secure: boolean): string {
  const attributes = [`${sessionCookieName(secure)}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
