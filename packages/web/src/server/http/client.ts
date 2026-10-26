import { isIP } from 'node:net';

const LOCAL_CLIENT = 'local';
// On Vercel a request without a usable address is something the platform did not vouch
// for, so every such request shares one key and one limit rather than escaping limits.
const UNKNOWN_CLIENT = 'unknown';
const IPV6_GROUPS = 8;
// One host is routinely handed a whole /64, 2^64 addresses, so a limit keyed any finer is no limit.
const IPV6_PREFIX_GROUPS = 4;
const IPV4_MAPPED_MARK = 0xffff;
const GROUP_BITS = 16;
const BYTE_MASK = 0xff;
const BYTE_BITS = 8;

/**
 * The eight 16-bit groups of an address node:net's isIP has already accepted as IPv6, with
 * the zone dropped and an embedded dotted IPv4 tail turned into its two groups. Null if the
 * text still does not come apart into exactly eight groups, which isIP should never let through.
 */
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0] ?? '';
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << BYTE_BITS) | b).toString(16)}:${((c << BYTE_BITS) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) => (part === undefined || part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16)));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const gap = IPV6_GROUPS - head.length - rest.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...head, ...Array<number>(halves.length === 1 ? 0 : gap).fill(0), ...rest];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group >> GROUP_BITS === 0) ? groups : null;
}

/**
 * The rate-limit key for one IP address text: an IPv4 address as written; an IPv4-mapped IPv6
 * address (::ffff:a.b.c.d, in either spelling) as that IPv4 address; any other IPv6 address
 * as its /64 prefix, the first four groups in lowercase hex without leading zeros followed by
 * '::/64', so every spelling of one address, and every address in one /64, gives one key.
 * 'unknown' for anything node:net's isIP does not accept.
 */
export function addressKey(text: string): string {
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6) return UNKNOWN_CLIENT;
  const groups = ipv6Groups(text);
  if (groups === null) return UNKNOWN_CLIENT;
  const [, , , , , mark = -1, high = 0, low = 0] = groups;
  if (groups.slice(0, 5).every((group) => group === 0) && mark === IPV4_MAPPED_MARK) {
    return [high >> BYTE_BITS, high & BYTE_MASK, low >> BYTE_BITS, low & BYTE_MASK].join('.');
  }
  return `${groups
    .slice(0, IPV6_PREFIX_GROUPS)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/**
 * The client address the hosting platform vouches for, to key rate limits on (C22).
 * On Vercel (VERCEL is '1') that is the first entry of X-Forwarded-For, which Vercel
 * overwrites with the connecting address, so a caller cannot choose it, put through
 * addressKey so an IPv6 client is keyed on its /64. Anywhere else no header is trusted at all,
 * because a caller can set any of them, and every request is the one client 'local'. The value
 * is in clear: ratelimit.ts hashes every key before it is stored. A handler called with no request
 * at all, which Next never does, is keyed as one the platform did not vouch for.
 */
export function clientKey(request: Request | undefined): string {
  if (process.env.VERCEL !== '1') return LOCAL_CLIENT;
  if (request === undefined) return UNKNOWN_CLIENT;
  return addressKey(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '');
}
