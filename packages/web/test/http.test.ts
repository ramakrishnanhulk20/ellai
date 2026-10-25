// Covers: the HTTP plumbing under every route: error responses and their log lines, the
// same-origin check, the client key, the rate counter, the capped JSON reader, bigint-safe
// responses, the session requirement, and how request contexts are opened and closed,
// including the default PGlite path and the per-request Neon pool.
// Does NOT cover: the routes themselves (routes-auth and routes-owner do), a real Postgres
// server (the pool test points at a closed port), Vercel's own handling of X-Forwarded-For,
// or two database connections racing one counter (PGlite serves one connection, so the race
// is run with Promise.all on that one).
import { createHash, randomBytes } from 'node:crypto';
import { PaymentError } from '@ellai/core/payment';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Pool } from '@neondatabase/serverless';
import { eq, like } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentError } from '../src/server/auth/agents.js';
import { endSession } from '../src/server/auth/sessions.js';
import { SignInError, completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { rateCounters, sessions } from '../src/server/db/schema.js';
import { AnswerError } from '../src/server/decide/answer.js';
import { DecideError } from '../src/server/decide/decide.js';
import type { ServerEnv } from '../src/server/env.js';
import { clientKey } from '../src/server/http/client.js';
import { type ServerContext, getServerContext, setServerContextFactory, withServerContext } from '../src/server/http/context.js';
import { HttpError, toErrorResponse } from '../src/server/http/errors.js';
import { jsonResponse, readJson } from '../src/server/http/json.js';
import { requireSameOrigin } from '../src/server/http/origin.js';
import { consume } from '../src/server/http/ratelimit.js';
import { requireOwner } from '../src/server/http/session.js';
import { OnboardingError } from '../src/server/onboarding/state.js';
import { SellerError } from '../src/server/seller/challenge.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  setServerContextFactory(null);
  await handle.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const APP_ORIGIN = 'https://ellai.example';
const SECRET = hex(32);
const MASTER = hex(32);
const MARKER = 'MARKER_7f3a_secret';

const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: MASTER,
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: SECRET,
  JOBS_SECRET: hex(32),
  APP_ORIGIN,
};

const untouchable = new Proxy({} as Database, {
  get() {
    throw new Error('the database was touched');
  },
});

function captureLogs(): { lines: () => string[] } {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { lines: () => [...error.mock.calls, ...warn.mock.calls].map((call) => call.map(String).join(' ')) };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}/api/test`, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
}

async function thrown(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

async function httpError(run: () => unknown): Promise<HttpError> {
  const error = await thrown(run);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('toErrorResponse', () => {
  it.each([
    [new HttpError(403, 'cross_origin'), 403, 'cross_origin'],
    [new SignInError('BAD_SIGNATURE'), 401, 'bad_signature'],
    [new SignInError('NONCE_USED'), 401, 'nonce_used'],
    [new AnswerError('NOT_FOUND', 'there is no such question for this owner'), 404, 'not_found'],
    [new AnswerError('ANSWERED', 'this question has already been answered'), 409, 'answered'],
    [new DecideError('REQUEST_MISMATCH', 'the request does not match'), 409, 'request_mismatch'],
    [new AgentError('NOT_FOUND', 'there is no such agent for this owner'), 404, 'not_found'],
    [new OnboardingError('NOT_LANDED', 'Sui does not show the transaction yet'), 409, 'not_landed'],
    [new PaymentError('EXPIRED', 'the payment has expired'), 409, 'expired'],
  ])('maps %s to its status, its code and its own fixed message', async (error, status, code) => {
    const logs = captureLogs();
    const response = toErrorResponse(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, message: error.message });
    expect(logs.lines()).toEqual([`[ellai http] ${error.name} ${error.code}`]);
  });

  it("gives a SellerError fixed wording of its own instead of its configuration text", async () => {
    captureLogs();
    const response = toErrorResponse(new SellerError(`GAS_PRIVATE_KEY is not an Ed25519 Sui key ${MARKER}`));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'seller_unavailable', message: 'Ellai cannot serve this request right now.' });
    expect(text).not.toContain(MARKER);
  });

  it('replaces a known message that breaks its promise of plain fixed text', async () => {
    captureLogs();
    const response = toErrorResponse(new AnswerError('BAD_INPUT', `line one\n${MARKER}`));
    expect(await response.json()).toEqual({ error: 'bad_input', message: 'The request was refused.' });
  });

  it('turns an unknown error into 500 internal with nothing of its message, stack or cause', async () => {
    const logs = captureLogs();
    const error = new Error(`select * from sessions where token = '${MARKER}'`, { cause: new Error(MARKER) });
    const response = toErrorResponse(error);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
    expect(text).not.toContain(MARKER);
    expect(logs.lines()).toEqual(['[ellai http] Error']);
  });

  it("never lets a DrizzleQueryError's SQL or parameters out, logging its class and the SQLSTATE alone", async () => {
    const logs = captureLogs();
    const cause = Object.assign(new Error(`duplicate key ${MARKER}`), { code: '23505' });
    const response = toErrorResponse(new DrizzleQueryError('select token_hash from sessions where id = $1', [MARKER], cause));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
    expect(text).not.toMatch(/token_hash|MARKER/);
    expect(logs.lines()).toEqual(['[ellai http] DrizzleQueryError 23505']);
  });

  it('handles a thrown value that is not an error, and keeps only a safe name and code from an unknown one', async () => {
    const logs = captureLogs();
    expect(await toErrorResponse(MARKER).json()).toEqual({ error: 'internal' });
    expect(await toErrorResponse(Object.assign(new TypeError(MARKER), { code: `ECONNRESET; ${MARKER}` })).json()).toEqual({ error: 'internal' });
    expect(await toErrorResponse(Object.assign(new TypeError(MARKER), { code: 'ECONNRESET' })).json()).toEqual({ error: 'internal' });
    expect(await toErrorResponse(Object.assign(new Error(MARKER), { name: `Rpc ${MARKER}` })).json()).toEqual({ error: 'internal' });
    expect(logs.lines()).toEqual(['[ellai http] thrown_string', '[ellai http] TypeError', '[ellai http] TypeError ECONNRESET', '[ellai http] Unknown']);
  });

  it("logs a class by its own name, which survives a production build's minified class names", async () => {
    const logs = captureLogs();
    // A minified build turns class SignInError into something like class f; its name stays.
    const minified = class f extends Error {
      readonly code = 'BAD_SIGNATURE';
    };
    toErrorResponse(Object.assign(new minified(MARKER), { name: 'RpcError' }));
    toErrorResponse(new SignInError('NONCE_USED'));
    expect(logs.lines()).toEqual(['[ellai http] RpcError BAD_SIGNATURE', '[ellai http] SignInError NONCE_USED']);
  });

  it('sets no-store and nosniff on error responses', () => {
    captureLogs();
    const response = toErrorResponse(new HttpError(401, 'signed_out'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('refuses to build an HttpError with a status that is not an error', () => {
    expect(() => new HttpError(200, 'not_found')).toThrow(RangeError);
  });
});

describe('requireSameOrigin', () => {
  const withOrigin = (origin?: string) => post(null, origin === undefined ? {} : { origin });

  it('accepts exactly the app origin, read through the same parser on both sides', () => {
    expect(() => requireSameOrigin(withOrigin(APP_ORIGIN), APP_ORIGIN)).not.toThrow();
    expect(() => requireSameOrigin(withOrigin('https://ELLAI.example:443'), APP_ORIGIN)).not.toThrow();
  });

  it.each([
    ['no Origin header', undefined],
    ['the opaque origin', 'null'],
    ['another site', 'https://evil.example'],
    ['a subdomain', 'https://app.ellai.example'],
    ['plain http', 'http://ellai.example'],
    ['another port', 'https://ellai.example:8443'],
    ['an origin with a path', 'https://ellai.example/api'],
    ['credentials', 'https://user@ellai.example'],
    ['two origins', `${APP_ORIGIN}, https://evil.example`],
    ['a lookalike with a trailing dot', 'https://ellai.example.'],
  ])('refuses %s with 403 cross_origin', async (_label, origin) => {
    const error = await httpError(() => requireSameOrigin(withOrigin(origin), APP_ORIGIN));
    expect(error).toMatchObject({ status: 403, code: 'cross_origin' });
  });

  it('throws a plain Error when the app origin itself is not an origin', () => {
    expect(() => requireSameOrigin(withOrigin(APP_ORIGIN), `${APP_ORIGIN}/app`)).toThrow('The app origin is not an origin');
  });
});

describe('clientKey', () => {
  const forwarded = (value?: string) => post(null, value === undefined ? {} : { 'x-forwarded-for': value });

  it('trusts no header off Vercel, so every caller there is the one local client', () => {
    expect(clientKey(forwarded('203.0.113.9'))).toBe('local');
    vi.stubEnv('VERCEL', 'true');
    expect(clientKey(forwarded('203.0.113.9'))).toBe('local');
  });

  it("takes the first X-Forwarded-For entry on Vercel, and pools anything that is not an address", () => {
    vi.stubEnv('VERCEL', '1');
    expect(clientKey(forwarded(' 203.0.113.9 , 10.0.0.1'))).toBe('203.0.113.9');
    expect(clientKey(forwarded('2001:DB8::1'))).toBe('2001:db8::1');
    expect(clientKey(forwarded('not-an-address'))).toBe('unknown');
    expect(clientKey(forwarded())).toBe('unknown');
  });
});

describe('consume', () => {
  const minute = new Date('2026-10-25T09:30:00.000Z');
  const at = (ms: number) => new Date(minute.getTime() + ms);

  it('allows up to the limit in one fixed minute, refuses past it, and starts again next minute', async () => {
    const key = `test:${hex(4)}`;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await consume(db, key, 3, at(i * 1_000)));
    expect(results).toEqual([true, true, true, false]);
    expect(await consume(db, key, 3, at(59_999))).toBe(false);
    expect(await consume(db, key, 3, at(60_000))).toBe(true);
  });

  it('counts concurrent requests exactly, so a burst cannot slip past the limit', async () => {
    const key = `test:${hex(4)}`;
    const results = await Promise.all(Array.from({ length: 12 }, () => consume(db, key, 5, minute)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('stores only a hash of the key, never the key itself', async () => {
    const key = `signin:nonce:client:198.51.100.${randomBytes(1)[0]}`;
    await consume(db, key, 10, minute);
    const stored = `http:${createHash('sha256').update(key).digest('hex')}`;
    expect(await db.select().from(rateCounters).where(eq(rateCounters.key, stored))).toHaveLength(1);
    expect(await db.select().from(rateCounters).where(like(rateCounters.key, '%198.51.100%'))).toEqual([]);
  });

  it('refuses an empty key, a limit that is not a positive integer, and a bad time', async () => {
    await expect(consume(untouchable, '', 1, minute)).rejects.toThrow('the rate key is missing');
    await expect(consume(untouchable, 'k', 0, minute)).rejects.toThrow('positive integer');
    await expect(consume(untouchable, 'k', 1.5, minute)).rejects.toThrow('positive integer');
    await expect(consume(untouchable, 'k', 1, new Date(Number.NaN))).rejects.toThrow('not a date');
  });
});

describe('readJson', () => {
  const schema = z.strictObject({ address: z.string() });
  const json = (body: BodyInit | null, type = 'application/json') => post(body, { 'content-type': type });

  function streamOf(bytes: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const size = Math.min(256, bytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x20));
        sent += size;
      },
    });
  }

  it("returns the schema's output for a valid body, with or without a UTF-8 charset", async () => {
    expect(await readJson(json('{"address":"0x1"}'), schema, 100)).toEqual({ address: '0x1' });
    expect(await readJson(json('{"address":"0x1"}', 'Application/JSON; charset="UTF-8"'), schema, 100)).toEqual({ address: '0x1' });
  });

  it.each([
    ['no Content-Type', null],
    ['text/plain', 'text/plain'],
    ['a form', 'application/x-www-form-urlencoded'],
    ['JSON in another charset', 'application/json; charset=latin1'],
    ['a lookalike media type', 'application/jsonp'],
  ])('refuses %s with 400 bad_content_type before reading the body', async (_label, type) => {
    const request = post('{"address":"0x1"}', type === null ? {} : { 'content-type': type });
    expect(await httpError(() => readJson(request, schema, 100))).toMatchObject({ status: 400, code: 'bad_content_type' });
    expect(request.bodyUsed).toBe(false);
  });

  it('refuses a body over the cap whether Content-Length says so, lies, or is absent', async () => {
    const declared = post('{}', { 'content-type': 'application/json', 'content-length': '101' });
    expect(await httpError(() => readJson(declared, schema, 100))).toMatchObject({ status: 400, code: 'body_too_large' });

    const lying = post(`{"address":"${'a'.repeat(500)}"}`, { 'content-type': 'application/json', 'content-length': '5' });
    expect(await httpError(() => readJson(lying, schema, 100))).toMatchObject({ status: 400, code: 'body_too_large' });

    const streamed = json(streamOf(10_000_000));
    expect(streamed.headers.get('content-length')).toBeNull();
    expect(await httpError(() => readJson(streamed, schema, 1_000))).toMatchObject({ status: 400, code: 'body_too_large' });
  });

  it('accepts a body of exactly the cap', async () => {
    const body = `{"address":"${'a'.repeat(100 - 14)}"}`;
    expect(Buffer.byteLength(body)).toBe(100);
    expect(await readJson(json(body), schema, 100)).toEqual({ address: 'a'.repeat(86) });
  });

  it.each([
    ['broken JSON', '{"address":'],
    ['an empty body', ''],
    ['bytes that are not UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
  ])('refuses %s with 400 bad_json', async (_label, body) => {
    expect(await httpError(() => readJson(json(body), schema, 100))).toMatchObject({ status: 400, code: 'bad_json' });
  });

  it('refuses JSON the schema rejects with 400 bad_body, and the response quotes none of it', async () => {
    captureLogs();
    for (const body of ['[]', '{"address":7}', `{"address":"0x1","${MARKER}":true}`, '{"__proto__":{"admin":true},"address":"0x1"}']) {
      const error = await httpError(() => readJson(json(body), schema, 1_000));
      expect(error).toMatchObject({ status: 400, code: 'bad_body' });
      expect(await toErrorResponse(error).text()).not.toContain(MARKER);
    }
  });

  it('refuses a cap that is not a positive integer', async () => {
    await expect(readJson(json('{}'), schema, 0)).rejects.toThrow('the body cap must be a positive integer');
  });
});

describe('jsonResponse', () => {
  it('writes every bigint as its exact decimal string', async () => {
    const big = 2n ** 64n + 7n;
    const response = jsonResponse({ amount: big, nested: [{ n: 0n }], plain: 3 });
    expect(await response.text()).toBe(`{"amount":"${big.toString()}","nested":[{"n":"0"}],"plain":3}`);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the status and headers it is given', () => {
    const response = jsonResponse({}, { status: 201, headers: { 'set-cookie': 'a=b' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toBe('a=b');
  });

  it('refuses a value with no JSON form', () => {
    expect(() => jsonResponse(undefined)).toThrow('no JSON form');
  });
});

describe('requireOwner', () => {
  const ctx = (database: Database): ServerContext => ({ db: database, chain: {} as ServerContext['chain'], env: ENV, now: () => new Date() });
  const withCookie = (cookie?: string) => post(null, cookie === undefined ? {} : { cookie });

  async function session(): Promise<{ ownerId: string; token: string }> {
    const signer = Ed25519Keypair.generate();
    const now = new Date();
    const { message } = await issueSignIn({ db, address: signer.toSuiAddress(), appOrigin: APP_ORIGIN, now });
    const { signature } = await signer.signPersonalMessage(new TextEncoder().encode(message));
    const done = await completeSignIn({ db, message, signature, appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now });
    return { ownerId: done.ownerId, token: done.sessionToken };
  }

  it('returns the owner and session the cookie belongs to', async () => {
    const { ownerId, token } = await session();
    const [row] = await db.select().from(sessions).where(eq(sessions.ownerId, ownerId));
    expect(await requireOwner(withCookie(`theme=dark; ellai_session=${token}`), ctx(db))).toEqual({ ownerId, sessionId: row?.id });
  });

  it.each([
    ['no cookie', undefined],
    ['an empty cookie', 'ellai_session='],
    ['junk', `ellai_session=${MARKER}`],
    ['a record id', 'ellai_session=00000000-0000-4000-8000-000000000000'],
  ])('refuses %s with 401 signed_out without touching the database', async (_label, cookie) => {
    expect(await httpError(() => requireOwner(withCookie(cookie), ctx(untouchable)))).toMatchObject({ status: 401, code: 'signed_out' });
  });

  it('refuses an ended session, and two session cookies even when one is real', async () => {
    const { token } = await session();
    const other = await session();
    expect(await httpError(() => requireOwner(withCookie(`ellai_session=${token}; ellai_session=${other.token}`), ctx(db)))).toMatchObject({ status: 401 });
    await endSession({ db, token, sessionSecretHex: SECRET, now: new Date() });
    expect(await httpError(() => requireOwner(withCookie(`ellai_session=${token}`), ctx(db)))).toMatchObject({ status: 401, code: 'signed_out' });
  });
});

describe('server contexts', () => {
  afterEach(() => {
    setServerContextFactory(null);
  });

  it("runs on the factory's context and closes it after a result and after a throw", async () => {
    const close = vi.fn(async () => undefined);
    const chain = {} as ServerContext['chain'];
    setServerContextFactory(async () => ({ db, chain, env: ENV, now: () => new Date(0), close }));

    expect(await withServerContext(async (ctx) => ({ same: ctx.db === db && ctx.chain === chain, time: ctx.now().getTime() }))).toEqual({ same: true, time: 0 });
    expect(close).toHaveBeenCalledTimes(1);
    await expect(
      withServerContext(async () => {
        throw new Error('the handler failed');
      }),
    ).rejects.toThrow('the handler failed');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("keeps run's own result when closing fails, recording only a fixed code", async () => {
    const logs = captureLogs();
    setServerContextFactory(async () => ({ db, chain: {} as ServerContext['chain'], env: ENV, now: () => new Date(), close: async () => Promise.reject(new Error(MARKER)) }));
    expect(await withServerContext(async () => 'done')).toBe('done');
    expect(logs.lines()).toEqual(['[ellai db] close_failed']);
  });

  function stubServerEnv(databaseUrl: string): void {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('ELLAI_MASTER_SECRET', MASTER);
    vi.stubEnv('GAS_PRIVATE_KEY', ENV.GAS_PRIVATE_KEY);
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('JOBS_SECRET', ENV.JOBS_SECRET);
    vi.stubEnv('APP_ORIGIN', APP_ORIGIN);
    vi.stubEnv('TATUM_API_KEY', '');
  }

  it('opens one process-wide PGlite database for a pglite: URL, migrated once, and reuses it', async () => {
    stubServerEnv('pglite:memory');
    const first = await getServerContext();
    const second = await getServerContext();
    try {
      expect(first.db).toBe(second.db);
      expect(first.chain).toBe(second.chain);
      expect(first.env.APP_ORIGIN).toBe(APP_ORIGIN);
      expect(await first.db.select().from(sessions)).toEqual([]);
    } finally {
      await first.close();
      await second.close();
      first.chain.close();
    }
  });

  it('opens a Neon pool per request for a postgres URL, ends it in finally, and logs a pool error as a fixed code', async () => {
    vi.resetModules();
    stubServerEnv('postgres://ellai:pw@127.0.0.1:1/ellai');
    const fresh = await import('../src/server/http/context.js');
    const on = vi.spyOn(Pool.prototype, 'on');
    const end = vi.spyOn(Pool.prototype, 'end');
    const logs = captureLogs();

    await expect(fresh.withServerContext(async (ctx) => ctx.db.select().from(sessions))).rejects.toBeDefined();
    expect(end).toHaveBeenCalledTimes(1);

    const pool = on.mock.contexts[0] as Pool;
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    pool.emit('error', new Error(`connection to db.internal failed ${MARKER}`));
    expect(logs.lines()).toEqual(['[ellai db] pool_error']);
  });
});
