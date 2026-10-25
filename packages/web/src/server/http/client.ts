import { isIP } from 'node:net';

const LOCAL_CLIENT = 'local';
// On Vercel a request without a usable address is something the platform did not vouch
// for, so every such request shares one key and one limit rather than escaping limits.
const UNKNOWN_CLIENT = 'unknown';

/**
 * The client address the hosting platform vouches for, to key rate limits on (C22).
 * On Vercel (VERCEL is '1') that is the first entry of X-Forwarded-For, which Vercel
 * overwrites with the connecting address, so a caller cannot choose it. Anywhere else no
 * header is trusted at all, because a caller can set any of them, and every request is the
 * one client 'local'. The value is an IP address in clear: ratelimit.ts hashes every key
 * before it is stored.
 */
export function clientKey(request: Request): string {
  if (process.env.VERCEL !== '1') return LOCAL_CLIENT;
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return isIP(first) === 0 ? UNKNOWN_CLIENT : first.toLowerCase();
}
