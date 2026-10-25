import { HttpError } from './errors.js';

// The same reading env.ts gives APP_ORIGIN: the WHATWG URL parser's origin, and only for a
// value that is nothing but an origin. Both sides of the comparison come out of this one
// function, so case, a default port or a trailing slash can never make them differ.
function originOf(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  // Opaque origins (file:, data: and the like) all serialise as "null" and name no site.
  return url.origin === 'null' ? null : url.origin;
}

/**
 * Refuses a state-changing request that a page on another site could have sent with the
 * owner's cookie (C14). The Origin header must name exactly the app's origin. A missing
 * header, "null", several origins, or anything else is 403 cross_origin: browsers send Origin
 * on every POST, so only a request from outside the app lacks it.
 * Throws Error when `appOrigin` is not an origin, which is a server misconfiguration.
 */
export function requireSameOrigin(request: Request, appOrigin: string): void {
  const expected = originOf(appOrigin);
  if (expected === null) throw new Error('The app origin is not an origin');
  const sent = request.headers.get('origin');
  if (sent === null || originOf(sent) !== expected) throw new HttpError(403, 'cross_origin');
}
