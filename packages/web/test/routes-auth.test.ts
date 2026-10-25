// Covers: the sign-in routes called as Next would call them, with Request objects, on PGlite:
// nonce, verify and logout end to end with a real Ed25519 key; the session cookie and its
// flags; the same-origin check on all three; the per-client and overall rate limits, keyed on
// the platform's client address; and the fixed 400s for a bad body.
// Does NOT cover: the owner routes (routes-owner does, including a cookie from this verify
// opening the overview), zkLogin or other key types (auth.test.ts covers them on the functions
// below these routes), a browser enforcing the cookie flags, or Vercel's own rewriting of
// X-Forwarded-For.
import { randomBytes } from 'node:crypto';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logoutRoute from '../src/app/api/auth/logout/route.js';
import * as nonceRoute from '../src/app/api/auth/nonce/route.js';
import * as verifyRoute from '../src/app/api/auth/verify/route.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { owners, sessions, signinNonces } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { type ServerContext, setServerContextFactory } from '../src/server/http/context.js';
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
// Nothing in sign-in reads the chain, so any use of it fails the test.
const chain = new Proxy({} as Chain, {
  get() {
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
    expect(setCookie).toMatch(/^ellai_session=ellai_session_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
    const cookie = cookieValue(setCookie);
    expect(text).not.toContain(cookie.slice('ellai_session='.length));

    const session = await requireOwner(new Request(`${APP_ORIGIN}/`, { headers: { cookie } }), ownerContext());
    expect(session.ownerId).toBe(ownerId);
    const [owner] = await db.select().from(owners).where(eq(owners.id, ownerId));
    expect(owner?.suiAddress).toBe(canonicalSuiAddress(signer.toSuiAddress()));
  });

  it('leaves Secure off only when the app runs on plain-http localhost', async () => {
    env = { ...HTTPS_ENV, APP_ORIGIN: 'http://localhost:3000' };
    const { message, signature } = await signedMessage();
    const response = await verify({ message, signature });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
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
    expect(response.headers.get('set-cookie')).toBe('ellai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');

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
    const response = await logout({ cookie: 'ellai_session=junk' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
