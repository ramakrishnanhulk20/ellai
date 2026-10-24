import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { LIMITS } from './limits.js';

export type NetErrorCode = 'BAD_URL' | 'NOT_PUBLIC' | 'REDIRECT' | 'TIMEOUT' | 'TOO_LARGE' | 'NETWORK';

/**
 * Every failure from safeFetch is a NetError. Its message is fixed text: the URL, the
 * host, the addresses and the upstream error are never copied in, so nothing a seller
 * or an agent controls ends up in a log line through it.
 */
export class NetError extends Error {
  readonly code: NetErrorCode;

  constructor(code: NetErrorCode, message: string) {
    super(message);
    this.name = 'NetError';
    this.code = code;
  }
}

export interface SafeRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Whole-call ceiling, within [LIMITS.netTimeoutMinMs, LIMITS.netPaidTimeoutMaxMs]. Defaults to LIMITS.netTimeoutMs. */
  timeoutMs?: number;
}

export interface SafeResponse {
  status: number;
  /** Header names lowercased. Repeated headers are joined with ", ". Set-Cookie is dropped. */
  headers: Record<string, string>;
  bodyText: string;
  /** The URL actually requested, as the WHATWG parser normalised it, without any fragment. */
  url: string;
  /** Lowercase, punycode host from the same parse. */
  host: string;
}

export interface SafeFetchDeps {
  resolve?: (host: string) => Promise<string[]>;
}

// IANA's global unicast block. ipaddr.js calls the deprecated IPv4-compatible form
// (for example ::7f00:1, which embeds 127.0.0.1) "unicast", so on its own the library
// predicate would let that through.
const IPV6_GLOBAL_UNICAST = ipaddr.IPv6.parseCIDR('2000::/3');

// Either header would undo a guarantee below: host would send the request to a
// different site on the pinned address, and cookie is ambient credential state.
const REFUSED_REQUEST_HEADERS = new Set(['host', 'cookie']);

const HTTP_FIRST_REDIRECT = 300;
const HTTP_FIRST_NON_REDIRECT = 400;

interface SellerTarget {
  href: string;
  hostname: string;
}

function parseSellerUrl(raw: string): SellerTarget {
  if (typeof raw !== 'string') throw new NetError('BAD_URL', 'Seller URL is not a string');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetError('BAD_URL', 'Seller URL does not parse');
  }
  if (url.protocol !== 'https:') throw new NetError('BAD_URL', 'Seller URL must use https');
  // The parser turns an explicit :443 into the empty string, so empty is the only port allowed.
  if (url.port !== '') throw new NetError('BAD_URL', 'Seller URL must use port 443');
  if (url.username !== '' || url.password !== '') {
    throw new NetError('BAD_URL', 'Seller URL must not carry a user name or password');
  }
  const hostname = url.hostname;
  if (hostname === '' || hostname.endsWith('.')) throw new NetError('BAD_URL', 'Seller host must not end in a dot');
  // The parser has already rewritten every IPv4 spelling (127.1, 0x7f.1) as dotted decimal.
  if (hostname.startsWith('[') || isIP(hostname) !== 0) {
    throw new NetError('BAD_URL', 'Seller host must be a name, not an IP address');
  }
  url.hash = '';
  return { href: url.href, hostname };
}

function requestTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return LIMITS.netTimeoutMs;
  // Written so NaN and anything that is not a number fail both comparisons and are refused.
  if (typeof timeoutMs === 'number' && timeoutMs >= LIMITS.netTimeoutMinMs && timeoutMs <= LIMITS.netPaidTimeoutMaxMs) {
    return timeoutMs;
  }
  throw new NetError('BAD_URL', 'Request timeout is outside the allowed range');
}

function checkRequestHeaders(headers: Record<string, string> | undefined): void {
  if (headers === undefined) return;
  for (const name of Object.keys(headers)) {
    if (REFUSED_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new NetError('BAD_URL', 'Request header is not allowed');
    }
  }
}

interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Returns the address in the form Node will connect to, or null when it is not public
 * unicast. Covers loopback, private, link-local, carrier-grade NAT, multicast, reserved,
 * NAT64, 6to4, Teredo and IPv4-mapped spellings of any of them. Does not cover a public
 * host that is itself hostile.
 */
function publicUnicast(raw: string): CheckedAddress | null {
  if (typeof raw !== 'string' || isIP(raw) === 0) return null;
  const ip = ipaddr.process(raw);
  if (ip.range() !== 'unicast') return null;
  if (ip instanceof ipaddr.IPv6) {
    return ip.match(IPV6_GLOBAL_UNICAST) ? { address: ip.toString(), family: 6 } : null;
  }
  return { address: ip.toString(), family: 4 };
}

function pinTo(checked: CheckedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: checked.address, family: checked.family }]);
    else callback(null, checked.address, checked.family);
  };
}

async function systemResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new NetError('TIMEOUT', 'Seller request timed out')), { once: true });
  });
}

function flattenHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(raw)) {
    const lowered = name.toLowerCase();
    if (value === undefined || lowered === 'set-cookie') continue;
    entries.push([lowered, Array.isArray(value) ? value.join(', ') : value]);
  }
  // fromEntries defines own properties, so a header named __proto__ stays a plain key.
  return Object.fromEntries(entries);
}

async function readCapped(body: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > LIMITS.netMaxResponseBytes) {
      throw new NetError('TOO_LARGE', 'Seller response is larger than the size cap');
    }
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * Makes one HTTPS request to a seller, refusing anything that could reach a place the
 * public internet cannot.
 *
 * The URL must be https on port 443 with a host name (no IP literal, no trailing dot,
 * no user name or password). The host is resolved once; every address must be public
 * unicast, and the connection is pinned to the first of them while TLS still checks the
 * certificate against the host name. Redirects are refused, not followed. The whole
 * call, lookup included, is bounded by init.timeoutMs, which must lie within
 * [LIMITS.netTimeoutMinMs, LIMITS.netPaidTimeoutMaxMs] and defaults to LIMITS.netTimeoutMs,
 * and the body by LIMITS.netMaxResponseBytes. Only the headers passed in are sent: no
 * cookies, no credentials, and never a Host or Cookie header.
 *
 * Throws NetError: BAD_URL (also for a timeout outside its range), NOT_PUBLIC, REDIRECT,
 * TIMEOUT, TOO_LARGE or NETWORK.
 */
export async function safeFetch(url: string, init: SafeRequest, deps: SafeFetchDeps = {}): Promise<SafeResponse> {
  const target = parseSellerUrl(url);
  checkRequestHeaders(init.headers);
  const timeoutMs = requestTimeoutMs(init.timeoutMs);
  const resolve = deps.resolve ?? systemResolve;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let agent: Agent | undefined;
  try {
    let addresses: string[];
    try {
      addresses = await Promise.race([resolve(target.hostname), rejectOnAbort(controller.signal)]);
    } catch (error) {
      if (error instanceof NetError) throw error;
      throw new NetError('NETWORK', 'Seller host did not resolve');
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new NetError('NETWORK', 'Seller host did not resolve');
    }
    const checked = addresses.map(publicUnicast);
    const pinned = checked[0];
    if (pinned === null || pinned === undefined || checked.some((entry) => entry === null)) {
      throw new NetError('NOT_PUBLIC', 'Seller host resolves to an address that is not public');
    }

    agent = new Agent({
      // HTTP/1.1 only: undici's HTTP/2 client is the newer path, and no seller needs it.
      allowH2: false,
      connect: { lookup: pinTo(pinned), timeout: LIMITS.netTimeoutMs },
    });
    const response = await request(target.href, {
      dispatcher: agent,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
      signal: controller.signal,
    });
    // Destroying an unread undici body emits an abort error. With no listener that error
    // would crash the process; the read loop below still sees real errors on its own.
    response.body.on('error', () => undefined);

    if (response.statusCode >= HTTP_FIRST_REDIRECT && response.statusCode < HTTP_FIRST_NON_REDIRECT) {
      response.body.destroy();
      throw new NetError('REDIRECT', 'Seller answered with a redirect');
    }
    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > LIMITS.netMaxResponseBytes) {
      response.body.destroy();
      throw new NetError('TOO_LARGE', 'Seller response is larger than the size cap');
    }
    const bodyText = await readCapped(response.body);

    return {
      status: response.statusCode,
      headers: flattenHeaders(response.headers),
      bodyText,
      url: target.href,
      host: target.hostname,
    };
  } catch (error) {
    if (error instanceof NetError) throw error;
    if (controller.signal.aborted) throw new NetError('TIMEOUT', 'Seller request timed out');
    throw new NetError('NETWORK', 'Seller request failed');
  } finally {
    clearTimeout(timer);
    if (agent !== undefined) await agent.destroy().catch(() => undefined);
  }
}
