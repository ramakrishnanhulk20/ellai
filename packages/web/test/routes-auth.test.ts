// Covers: the sign-in routes called as Next would call them, with Request objects, on PGlite:
// nonce, verify and logout end to end with a real Ed25519 key; a zkLogin sign-in whose proof
// verify sends, once, to the chain client it was given (a 503 when that chain cannot answer,
// with the nonce spent either way), its per-client limit keyed on the platform's client address
// (429 with the nonce spent), a spent day answered with the day's own 429 and 503 wording, and
// nothing read for any other key;
// the session cookie, its flags and its name (__Host-ellai_session on https, read and cleared
// under that name only, the plain name on http localhost); the same-origin check on all three;
// the per-client and
// overall rate limits, keyed on the platform's client address; and the fixed 400s for a bad
// body.
// Does NOT cover: the owner routes (routes-owner does, including a cookie from this verify
// opening the overview), Sui's own check of a zkLogin proof (the gRPC client is a stub here,
// and no real proof is made), other key types (auth.test.ts covers them on the functions below
// these routes), a browser enforcing the cookie flags, or Vercel's own rewriting of
// X-Forwarded-For.
import { randomBytes } from 'node:crypto';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { computeZkLoginAddressFromSeed, getZkLoginSignature } from '@mysten/sui/zklogin';
import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logoutRoute from '../src/app/api/auth/logout/route.js';
import * as nonceRoute from '../src/app/api/auth/nonce/route.js';
import * as verifyRoute from '../src/app/api/auth/verify/route.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { owners, sessions, signinNonces } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { ZKLOGIN_CHECK_QUOTAS, ZKLOGIN_CLIENT_LIMITS } from '../src/server/auth/signin.js';
import { type ServerContext, setServerContextFactory } from '../src/server/http/context.js';
import { consumeShared, consumeWindow } from '../src/server/http/ratelimit.js';
import { requireOwner } from '../src/server/http/session.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const APP_ORIGIN = 'https://ellai.example';
const SECRET = hex(32);
const MASTER = hex(32);
const HTTPS_ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: MASTER,
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: SECRET,
  JOBS_SECRET: hex(32),
  APP_ORIGIN,
};
// The stand-in for Sui's zkLogin check through the gRPC client, the one part of the chain sign-in
// may use. Every other use of the chain fails the test.
const verifyZkLoginSignature = vi.fn<(input: { bytes: string; signature: string; intentScope: string; address: string }) => Promise<{ success: boolean; errors: string[] }>>();
const chain = new Proxy({} as Chain, {
  get(_target, property) {
    if (property === 'grpc') return { core: { verifyZkLoginSignature } };
    throw new Error('the chain was touched');
  },
});

let env: ServerEnv = HTTPS_ENV;
// Each test runs inside a fixed minute of its own, so its rate counters start at zero and
// can never straddle a window boundary.
const FIRST_MINUTE = Math.floor(Date.now() / 60_000) * 60_000;
let minutesUsed = 0;
let clock = new Date(FIRST_MINUTE);

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
  setServerContextFactory(async () => ({ db, chain, env, now: () => clock }));
});

afterAll(async () => {
  setServerContextFactory(null);
  await handle.close();
});

beforeEach(() => {
  env = HTTPS_ENV;
  minutesUsed += 1;
  clock = new Date(FIRST_MINUTE + minutesUsed * 60_000 + 1_000);
  verifyZkLoginSignature.mockReset();
  verifyZkLoginSignature.mockRejectedValue(new Error('no zkLogin check was expected'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface CallOptions {
  origin?: string | null;
  cookie?: string;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  forwardedFor?: string;
}

function call(path: string, options: CallOptions = {}): Request {
  const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/json' };
  const origin = options.origin === undefined ? env.APP_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.forwardedFor !== undefined) headers['x-forwarded-for'] = options.forwardedFor;
  const body = options.rawBody ?? (options.body === undefined ? null : JSON.stringify(options.body));
  return new Request(`${env.APP_ORIGIN}${path}`, { method: 'POST', headers, body });
}

const nonce = (body: unknown, options: CallOptions = {}) => nonceRoute.POST(call('/api/auth/nonce', { body, ...options }));
const verify = (body: unknown, options: CallOptions = {}) => verifyRoute.POST(call('/api/auth/verify', { body, ...options }));
const logout = (options: CallOptions = {}) => logoutRoute.POST(call('/api/auth/logout', options));

async function sign(signer: Signer, message: string): Promise<string> {
  return (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
}

async function signedMessage(signer: Signer = Ed25519Keypair.generate()): Promise<{ message: string; signature: string; signer: Signer }> {
  const response = await nonce({ address: signer.toSuiAddress() });
  expect(response.status).toBe(200);
  const { message } = (await response.json()) as { message: string };
  return { message, signature: await sign(signer, message), signer };
}

function cookieValue(setCookie: string | null): string {
  const value = setCookie?.split(';')[0];
  if (value === undefined) throw new Error('no Set-Cookie');
  return value;
}

function ownerContext(): ServerContext {
  return { db, chain, env, now: () => clock };
}

async function nonceCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(signinNonces);
  return row?.n ?? 0;
}

describe('route files', () => {
  it.each([
    ['nonce', nonceRoute],
    ['verify', verifyRoute],
    ['logout', logoutRoute],
  ])('%s runs on Node and is never cached or prerendered', (_name, route) => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('sign-in', () => {
  it('signs in end to end with a real Ed25519 key, the session going only into an HttpOnly, Strict, Secure cookie', async () => {
    const signer = Ed25519Keypair.generate();
    const issued = await nonce({ address: signer.toSuiAddress() });
    expect(issued.status).toBe(200);
    const issuedBody = (await issued.json()) as { message: string; expiresAt: string };
    expect(Object.keys(issuedBody).sort()).toEqual(['expiresAt', 'message']);
    expect(issuedBody.message.split('\n')[1]).toBe(canonicalSuiAddress(signer.toSuiAddress()));
    expect(issuedBody.expiresAt).toBe(new Date(clock.getTime() + 300_000).toISOString());

    const response = await verify({ message: issuedBody.message, signature: await sign(signer, issuedBody.message) });
    expect(response.status).toBe(200);
    const text = await response.text();
    const { ownerId } = JSON.parse(text) as { ownerId: string };
    expect(Object.keys(JSON.parse(text))).toEqual(['ownerId']);

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toMatch(/^__Host-ellai_session=ellai_session_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
    const cookie = cookieValue(setCookie);
    expect(text).not.toContain(cookie.slice('__Host-ellai_session='.length));

    const session = await requireOwner(new Request(`${APP_ORIGIN}/`, { headers: { cookie } }), ownerContext());
    expect(session.ownerId).toBe(ownerId);
    const [owner] = await db.select().from(owners).where(eq(owners.id, ownerId));
    expect(owner?.suiAddress).toBe(canonicalSuiAddress(signer.toSuiAddress()));
    expect(verifyZkLoginSignature).not.toHaveBeenCalled();
  });

  it('leaves Secure and the __Host- name off only when the app runs on plain-http localhost', async () => {
    env = { ...HTTPS_ENV, APP_ORIGIN: 'http://localhost:3000' };
    const { message, signature } = await signedMessage();
    const response = await verify({ message, signature });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/^ellai_session=ellai_session_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
  });

  it('refuses a verify from another site or with no Origin with 403, leaving the nonce for the real app', async () => {
    const { message, signature } = await signedMessage();
    for (const origin of ['https://evil.example', null, 'null']) {
      const response = await verify({ message, signature }, { origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'cross_origin' });
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await verify({ message, signature })).status).toBe(200);
  });

  it('refuses a nonce request from another site before storing anything', async () => {
    const before = await nonceCount();
    const response = await nonce({ address: Ed25519Keypair.generate().toSuiAddress() }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await nonceCount()).toBe(before);
  });

  it("refuses another key's signature with 401 and fixed text that repeats nothing sent", async () => {
    const { message } = await signedMessage();
    const forged = await sign(Ed25519Keypair.generate(), message);
    const response = await verify({ message, signature: forged });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'bad_signature', message: 'the signature does not prove the address in the message signed it' });
    expect(text).not.toContain(forged);
    expect(text).not.toContain('Nonce:');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a replayed sign-in with 401 nonce_used', async () => {
    const { message, signature } = await signedMessage();
    expect((await verify({ message, signature })).status).toBe(200);
    const replay = await verify({ message, signature });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'nonce_used' });
  });

  it('refuses an address that is not a Sui address with 400 bad_address', async () => {
    const response = await nonce({ address: 'not an address' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'bad_address' });
  });

  it.each([
    ['a wrong content type', { contentType: 'text/plain', body: { address: '0x1' } }, 'bad_content_type'],
    ['a body over the cap', { rawBody: JSON.stringify({ address: 'a'.repeat(2_000) }) }, 'body_too_large'],
    ['invalid JSON', { rawBody: '{"address":' }, 'bad_json'],
    ['an unknown field', { body: { address: '0x1', admin: true } }, 'bad_body'],
  ] as Array<[string, CallOptions, string]>)('answers %s with 400 and its fixed code', async (_label, options, code) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await nonceRoute.POST(call('/api/auth/nonce', options));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: code });
  });
});

describe('zkLogin sign-in', () => {
  // A well-formed zkLogin signature for a Google account. Its proof is not real: what Sui would
  // say about it is the stub's answer.
  const ISS = 'https://accounts.google.com';
  const ADDRESS_SEED = '13322897930163218532266430409510394316985274769125667290600321564259466511711';
  const zkLoginAddress = canonicalSuiAddress(computeZkLoginAddressFromSeed(BigInt(ADDRESS_SEED), ISS, false));

  async function zkLoginSigned(): Promise<{ message: string; signature: string }> {
    const issued = await nonce({ address: zkLoginAddress });
    const { message } = (await issued.json()) as { message: string };
    const signature = getZkLoginSignature({
      inputs: {
        proofPoints: { a: ['1', '2', '1'], b: [['1', '0'], ['3', '4'], ['1', '0']], c: ['5', '6', '1'] },
        issBase64Details: { value: 'yJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLC', indexMod4: 1 },
        headerBase64: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ',
        addressSeed: ADDRESS_SEED,
      },
      maxEpoch: '10',
      userSignature: await sign(Ed25519Keypair.generate(), message),
    });
    return { message, signature };
  }

  it('signs in a zkLogin wallet, its proof checked once through the chain client the route passes', async () => {
    verifyZkLoginSignature.mockResolvedValue({ success: true, errors: [] });
    const { message, signature } = await zkLoginSigned();
    const response = await verify({ message, signature });
    expect(response.status).toBe(200);
    const { ownerId } = (await response.json()) as { ownerId: string };
    expect(verifyZkLoginSignature.mock.calls).toEqual([[{ bytes: toBase64(new TextEncoder().encode(message)), signature, intentScope: 'PersonalMessage', address: zkLoginAddress }]]);
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-ellai_session=ellai_session_/);
    const [owner] = await db.select().from(owners).where(eq(owners.id, ownerId));
    expect(owner?.suiAddress).toBe(zkLoginAddress);
  });

  it('refuses with 401 and no session a zkLogin proof the chain rejects', async () => {
    verifyZkLoginSignature.mockResolvedValueOnce({ success: false, errors: ['the proof does not verify'] });
    const { message, signature } = await zkLoginSigned();
    const response = await verify({ message, signature });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'bad_signature', message: 'the signature does not prove the address in the message signed it' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);
  });

  it('answers 503 chain_unavailable and no session when the chain cannot check a zkLogin proof; the nonce is spent, and a fresh sign-in works once it can', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    verifyZkLoginSignature.mockRejectedValueOnce(new Error('UNAVAILABLE: the gateway did not answer'));
    const { message, signature } = await zkLoginSigned();
    const response = await verify({ message, signature });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'chain_unavailable', message: 'Ellai could not read Sui just now. Try again in a minute.' });
    expect(response.headers.get('set-cookie')).toBeNull();

    verifyZkLoginSignature.mockResolvedValue({ success: true, errors: [] });
    const replay = await verify({ message, signature });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'nonce_used' });
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);
    const fresh = await zkLoginSigned();
    expect((await verify(fresh)).status).toBe(200);
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(2);
  });

  it("holds one client to LIMITS.zkLoginChecksPerClientPerMinute zkLogin checks a minute, keyed on Vercel's address: 429 rate_limited with its nonce spent, while another client still signs in (C34)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('VERCEL', '1');
    verifyZkLoginSignature.mockResolvedValue({ success: true, errors: [] });
    const busy = { forwardedFor: '203.0.113.7' };
    const other = { forwardedFor: '198.51.100.7' };
    const statuses = [];
    for (let i = 0; i < LIMITS.zkLoginChecksPerClientPerMinute; i += 1) statuses.push((await verify(await zkLoginSigned(), busy)).status);
    expect(statuses).toEqual(Array<number>(LIMITS.zkLoginChecksPerClientPerMinute).fill(200));

    const limited = await zkLoginSigned();
    const response = await verify(limited, busy);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(LIMITS.zkLoginChecksPerClientPerMinute);

    const replay = await verify(limited, other);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'nonce_used' });
    expect((await verify(await zkLoginSigned(), other)).status).toBe(200);
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(LIMITS.zkLoginChecksPerClientPerMinute + 1);
  });

  it("answers a spent day with the day's wording, 429 rate_limited_today for the client and 503 chain_unavailable_today for everyone, reading nothing (C22, C34)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('VERCEL', '1');
    verifyZkLoginSignature.mockResolvedValue({ success: true, errors: [] });
    // A day of its own, so the counters spent here touch no other test.
    clock = new Date(Date.UTC(2031, 3, 1, 10));
    const [, clientDay] = ZKLOGIN_CLIENT_LIMITS;
    const [, sharedDay] = ZKLOGIN_CHECK_QUOTAS;
    const busy = '203.0.113.21';
    for (let use = 0; use < clientDay.limit; use += 1) await consumeWindow(db, `${clientDay.name}:${busy}`, clientDay.limit, clientDay.windowMs, clock);

    const clientRefused = await verify(await zkLoginSigned(), { forwardedFor: busy });
    expect(clientRefused.status).toBe(429);
    expect(await clientRefused.json()).toEqual({ error: 'rate_limited_today', message: 'Too many requests today. Try again tomorrow (days are counted in UTC).' });

    for (let use = 0; use < sharedDay.limit; use += 1) await consumeShared(db, sharedDay.name, sharedDay.limit, sharedDay.windowMs, clock);
    const everyoneRefused = await verify(await zkLoginSigned(), { forwardedFor: '198.51.100.21' });
    expect(everyoneRefused.status).toBe(503);
    expect(await everyoneRefused.json()).toEqual({ error: 'chain_unavailable_today', message: "Ellai has used today's budget for reading Sui. Try again tomorrow (days are counted in UTC)." });
    expect(everyoneRefused.headers.get('set-cookie')).toBeNull();
    expect(verifyZkLoginSignature).not.toHaveBeenCalled();
  });
});

describe('sign-in rate limits', () => {
  const address = () => ({ address: Ed25519Keypair.generate().toSuiAddress() });

  it('turns away the eleventh nonce request in a minute from one client with 429, and lets it back next minute', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await nonce(address())).status);
    expect(statuses).toEqual([...Array<number>(10).fill(200), 429]);
    const refused = await nonce(address());
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' });

    clock = new Date(clock.getTime() + 60_000);
    expect((await nonce(address())).status).toBe(200);
  });

  it('ignores X-Forwarded-For off Vercel, so changing it does not buy more requests', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await nonce(address(), { forwardedFor: `203.0.113.${i}` })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("keys on Vercel's client address, so one client's limit does not touch another's", async () => {
    vi.stubEnv('VERCEL', '1');
    for (let i = 0; i < 10; i += 1) expect((await nonce(address(), { forwardedFor: '203.0.113.7' })).status).toBe(200);
    expect((await nonce(address(), { forwardedFor: '203.0.113.7' })).status).toBe(429);
    expect((await nonce(address(), { forwardedFor: '198.51.100.7' })).status).toBe(200);
  });

  it('holds every client together to 300 nonce requests a minute', async () => {
    vi.stubEnv('VERCEL', '1');
    for (let client = 0; client < 30; client += 1) {
      for (let i = 0; i < 10; i += 1) {
        const response = await nonce(address(), { forwardedFor: `10.1.${client}.1` });
        if (response.status !== 200) throw new Error(`request ${client * 10 + i + 1} was refused`);
      }
    }
    const overall = await nonce(address(), { forwardedFor: '10.2.0.1' });
    expect(overall.status).toBe(429);
  });

  it('limits verify the same way, counting before the body is even read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await verifyRoute.POST(call('/api/auth/verify', { rawBody: 'junk' }))).status);
    expect(statuses).toEqual([...Array<number>(10).fill(400), 429]);
  });
});

describe('logout', () => {
  async function signedInCookie(): Promise<string> {
    const { message, signature } = await signedMessage();
    const response = await verify({ message, signature });
    return cookieValue(response.headers.get('set-cookie'));
  }

  it('ends the session for good and clears the cookie with the same flags', async () => {
    const cookie = await signedInCookie();
    const { sessionId } = await requireOwner(new Request(`${APP_ORIGIN}/`, { headers: { cookie } }), ownerContext());

    const response = await logout({ cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedOut: true });
    expect(response.headers.get('set-cookie')).toBe('__Host-ellai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.revokedAt).toEqual(clock);
    await expect(requireOwner(new Request(`${APP_ORIGIN}/`, { headers: { cookie } }), ownerContext())).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a logout from another site with 403, leaving the session open', async () => {
    const cookie = await signedInCookie();
    const response = await logout({ cookie, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(requireOwner(new Request(`${APP_ORIGIN}/`, { headers: { cookie } }), ownerContext())).resolves.toMatchObject({});
  });

  it('still clears the cookie when there is no session to end', async () => {
    const response = await logout({ cookie: '__Host-ellai_session=junk' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('on https never reads a plain-named cookie, even one carrying a real session token', async () => {
    const cookie = await signedInCookie();
    const plain = `ellai_session=${cookie.slice('__Host-ellai_session='.length)}`;
    const response = await logout({ cookie: plain });
    expect(response.status).toBe(200);
    await expect(requireOwner(new Request(`${APP_ORIGIN}/`, { headers: { cookie } }), ownerContext())).resolves.toMatchObject({});
  });

  it('on plain-http localhost reads and clears the plain-named cookie, and ends its session', async () => {
    env = { ...HTTPS_ENV, APP_ORIGIN: 'http://localhost:3000' };
    const cookie = await signedInCookie();
    expect(cookie.startsWith('ellai_session=ellai_session_')).toBe(true);
    const { sessionId } = await requireOwner(new Request(`${env.APP_ORIGIN}/`, { headers: { cookie } }), ownerContext());
    const response = await logout({ cookie });
    expect(response.headers.get('set-cookie')).toBe('ellai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.revokedAt).toEqual(clock);
  });
});
