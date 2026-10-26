// Covers: every exported handler of every route file under src/app/api being made by scoped(),
// read from the folder itself, so a route added without the wrapper fails "makes every handler
// of every route file ... with scoped()". And, through a stand-in chain that records
// currentTatumScope() at each call, the Tatum scope of every route that can reach the chain, with
// the client being the address Vercel vouches for: a zkLogin sign-in checked through chain.grpc
// and Ellai's seller as that anonymous client; the overview purse, both onboarding steps and the
// built-in agent's paid calls as the signed-in owner from that client; an agent's paid fetch, over
// HTTP and over MCP, as the agent's owner from that client; and the jobs tick as jobs, only once
// its secret is right.
// Does NOT cover: how the meter counts (tatum-meter.test.ts) or core's hook (core chain.test.ts).
// The onboarding builds, the paid-call flow and the model run are stand-ins that make one chain
// call each, so these tests show the scope each route opened, not every call those modules make
// (their own tests cover them). Routes that never reach the chain are covered only by being made
// by scoped().
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { computeZkLoginAddressFromSeed, getZkLoginSignature } from '@mysten/sui/zklogin';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentFetchRoute from '../src/app/api/agent/fetch/route.js';
import * as nonceRoute from '../src/app/api/auth/nonce/route.js';
import * as verifyRoute from '../src/app/api/auth/verify/route.js';
import * as jobsRoute from '../src/app/api/jobs/tick/route.js';
import * as mcpRoute from '../src/app/api/mcp/route.js';
import * as agentRunRoute from '../src/app/api/owner/agent/run/route.js';
import * as buildRoute from '../src/app/api/owner/onboarding/build/route.js';
import * as confirmRoute from '../src/app/api/owner/onboarding/confirm/route.js';
import * as overviewRoute from '../src/app/api/owner/overview/route.js';
import * as sellRoute from '../src/app/api/sell/wallet-check/route.js';
import { createAgentToken } from '../src/server/auth/agents.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { owners } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { isScoped, setServerContextFactory } from '../src/server/http/context.js';
import { type TatumScope, currentTatumScope } from '../src/server/http/tatum-meter.js';

// One chain call each in place of the work these modules do, so a test sees the scope it ran in.
vi.mock('../src/server/onboarding/build.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/onboarding/build.js')>();
  const buildOnboardingTx: typeof real.buildOnboardingTx = async (args) => {
    await args.chain.getReferenceGasPrice();
    return { txBytesBase64: '', summary: [] };
  };
  return { ...real, buildOnboardingTx };
});
vi.mock('../src/server/onboarding/confirm.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/onboarding/confirm.js')>();
  const confirmOnboardingTx: typeof real.confirmOnboardingTx = async (args) => {
    await args.chain.getTransactionResult(args.digest);
    return { recorded: 'stand-in' };
  };
  return { ...real, confirmOnboardingTx };
});
vi.mock('../src/server/pay/flow.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/pay/flow.js')>();
  const paidFetch: typeof real.paidFetch = async (args) => {
    await args.deps.chain.getCurrentEpoch();
    return { outcome: 'failed', decisionId: null, rule: null, reason: 'stand-in', citedMemories: [], seller: null, payment: null };
  };
  return { ...real, paidFetch };
});
vi.mock('../src/server/agent/run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/agent/run.js')>();
  const runAgentTask: typeof real.runAgentTask = async (args) => {
    const purchase = { url: 'https://seller.example/rooms', method: 'GET' as const, body: null, contentType: null, purpose: 'Find a room' };
    await args.paidFetchFor(globalThis.crypto.randomUUID(), purchase, args.now().getTime() + 60_000);
    return { status: 'done', answer: 'stand-in', steps: [] };
  };
  return { ...real, runAgentTask };
});

const hex = (bytes: number) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
const APP_ORIGIN = 'https://ellai.example';
const CLIENT = '203.0.113.9';
const SECRET = hex(32);
const JOBS_SECRET = hex(32);
const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: hex(32),
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: SECRET,
  JOBS_SECRET,
  APP_ORIGIN,
  ELLAI_SELLER_PAYTO: canonicalSuiAddress(`0x${'5e'.repeat(32)}`),
};
const API_DIR = fileURLToPath(new URL('../src/app/api/', import.meta.url));
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

interface Seen {
  method: string;
  scope: TatumScope | undefined;
}
let seen: Seen[] = [];

const ANSWERS: Readonly<Record<string, () => unknown>> = {
  getCurrentEpoch: () => 1_100n,
  getReferenceGasPrice: () => 1_000n,
  getBalances: () => ({ usdcAddressBalance: 50_000n, usdcCoinBalance: 0n, suiTotal: 2_000_000_000n }),
  getTransactionResult: () => ({ status: 'success', balanceChanges: [] }),
};

// Every method records the scope it was called in before anything else, and a method with no
// answer here fails after recording, so no call goes unseen.
const chain = new Proxy({} as Chain, {
  get(_target, property) {
    if (property === 'usesApiKey') return false;
    if (property === 'grpc') {
      return {
        core: {
          verifyZkLoginSignature: async () => {
            seen.push({ method: 'verifyZkLoginSignature', scope: currentTatumScope() });
            return { success: true, errors: [] };
          },
        },
      };
    }
    if (typeof property !== 'string' || property === 'then') return undefined;
    return async () => {
      seen.push({ method: property, scope: currentTatumScope() });
      const answer = ANSWERS[property];
      if (answer === undefined) throw new Error(`the stand-in chain has no answer for ${property}`);
      return answer();
    };
  },
});

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;
const FIRST_MINUTE = Math.floor(Date.now() / 60_000) * 60_000;
let minutesUsed = 0;
let clock = new Date(FIRST_MINUTE);

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  setServerContextFactory(null);
  await handle.close();
});

beforeEach(() => {
  minutesUsed += 1;
  clock = new Date(FIRST_MINUTE + minutesUsed * 60_000 + 1_000);
  seen = [];
  setServerContextFactory(async () => ({ db, chain, env: ENV, now: () => clock }));
  // clientKey trusts X-Forwarded-For only on Vercel, which is where a client key means anything.
  vi.stubEnv('VERCEL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': CLIENT, origin: APP_ORIGIN, ...options.headers };
  if (options.body === undefined) return new Request(`${APP_ORIGIN}${path}`, { method, headers });
  return new Request(`${APP_ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(options.body) });
}

async function messageFor(address: string): Promise<string> {
  const issued = await nonceRoute.POST(request('POST', '/api/auth/nonce', { body: { address } }));
  expect(issued.status).toBe(200);
  return ((await issued.json()) as { message: string }).message;
}

async function signedIn(): Promise<{ ownerId: string; cookie: string }> {
  const signer = Ed25519Keypair.generate();
  const message = await messageFor(signer.toSuiAddress());
  const { signature } = await signer.signPersonalMessage(new TextEncoder().encode(message));
  const verified = await verifyRoute.POST(request('POST', '/api/auth/verify', { body: { message, signature } }));
  expect(verified.status).toBe(200);
  const { ownerId } = (await verified.json()) as { ownerId: string };
  return { ownerId, cookie: (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
}

const anonymous: TatumScope = { kind: 'person', clientKey: CLIENT };
const asOwner = (ownerId: string): TatumScope => ({ kind: 'person', clientKey: CLIENT, ownerId });

describe('route handlers', () => {
  it('makes every handler of every route file under src/app/api with scoped(), so none can reach Tatum outside a scope', async () => {
    const files = readdirSync(API_DIR, { recursive: true })
      .map((file) => String(file).replaceAll('\\', '/'))
      .filter((file) => basename(file) === 'route.ts');
    expect(files).toContain('owner/overview/route.ts');
    const unscoped: string[] = [];
    let handlers = 0;
    for (const file of files) {
      // Resolved when the test runs, since the list comes from the folder.
      const specifier = `../src/app/api/${file}`;
      const route = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      for (const method of HTTP_METHODS) {
        if (route[method] === undefined) continue;
        handlers += 1;
        if (!isScoped(route[method])) unscoped.push(`${file} ${method}`);
      }
    }
    expect(unscoped).toEqual([]);
    expect(handlers).toBeGreaterThanOrEqual(files.length);
    // A handler written without the wrapper is caught.
    expect(isScoped(async () => new Response(null))).toBe(false);
  });
});

describe('the Tatum scope each route that can reach the chain runs in', () => {
  it('runs the jobs tick as jobs, and nothing at all without the exact secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = await jobsRoute.POST(request('POST', '/api/jobs/tick', { headers: { authorization: `Bearer ${hex(32)}` } }));
    expect(refused.status).toBe(401);
    expect(seen).toEqual([]);

    const ran = await jobsRoute.POST(request('POST', '/api/jobs/tick', { headers: { authorization: `Bearer ${JOBS_SECRET}` } }));
    expect(ran.status).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.scope).toEqual({ kind: 'jobs' });
  });

  it('checks a zkLogin sign-in through chain.grpc as the anonymous client, with no owner', async () => {
    const seed = '13322897930163218532266430409510394316985274769125667290600321564259466511711';
    const address = canonicalSuiAddress(computeZkLoginAddressFromSeed(BigInt(seed), 'https://accounts.google.com', false));
    const message = await messageFor(address);
    const { signature: userSignature } = await Ed25519Keypair.generate().signPersonalMessage(new TextEncoder().encode(message));
    const signature = getZkLoginSignature({
      inputs: {
        proofPoints: { a: ['1', '2', '1'], b: [['1', '0'], ['3', '4'], ['1', '0']], c: ['5', '6', '1'] },
        issBase64Details: { value: 'yJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLC', indexMod4: 1 },
        headerBase64: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ',
        addressSeed: seed,
      },
      maxEpoch: '10',
      userSignature,
    });
    const verified = await verifyRoute.POST(request('POST', '/api/auth/verify', { body: { message, signature } }));
    expect(verified.status).toBe(200);
    expect(seen).toEqual([{ method: 'verifyZkLoginSignature', scope: anonymous }]);
  });

  it("runs Ellai's seller as the anonymous client", async () => {
    const response = await sellRoute.POST(request('POST', '/api/sell/wallet-check', { body: { address: `0x${'c4'.repeat(32)}` } }));
    expect(response.status).toBe(402);
    expect(seen).toEqual([{ method: 'getCurrentEpoch', scope: anonymous }]);
  });

  it("reads the overview's purse as the signed-in owner from its client", async () => {
    const { ownerId, cookie } = await signedIn();
    await db.update(owners).set({ allowanceId: `0x${'a1'.repeat(32)}`, allowanceCheckedAt: clock }).where(eq(owners.id, ownerId));
    const response = await overviewRoute.GET(request('GET', '/api/owner/overview', { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: 'getBalances', scope: asOwner(ownerId) }]);
  });

  it('builds and confirms onboarding steps as the signed-in owner from its client', async () => {
    const { ownerId, cookie } = await signedIn();
    const built = await buildRoute.POST(request('POST', '/api/owner/onboarding/build', { body: { step: 'memory_account' }, headers: { cookie } }));
    expect(built.status).toBe(200);
    const confirmed = await confirmRoute.POST(request('POST', '/api/owner/onboarding/confirm', { body: { step: 'memory_account', digest: 'stand-in' }, headers: { cookie } }));
    expect(confirmed.status).toBe(200);
    expect(seen).toEqual([
      { method: 'getReferenceGasPrice', scope: asOwner(ownerId) },
      { method: 'getTransactionResult', scope: asOwner(ownerId) },
    ]);
  });

  it("runs the built-in agent's paid calls as the signed-in owner from its client", async () => {
    const { ownerId, cookie } = await signedIn();
    const response = await agentRunRoute.POST(request('POST', '/api/owner/agent/run', { body: { task: 'Find a room in Lisbon' }, headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: 'getCurrentEpoch', scope: asOwner(ownerId) }]);
  });

  it("runs an agent's paid fetch, over HTTP and over MCP, as that agent's owner from its client", async () => {
    await signedIn();
    const { ownerId } = await signedIn();
    const { token } = await createAgentToken({ db, ownerId, label: 'Scope agent', kind: 'external', sessionSecretHex: SECRET, now: clock });
    const authorization = `Bearer ${token}`;
    const purchase = { url: 'https://seller.example/rooms', method: 'GET', purpose: 'Find a room' };

    const fetched = await agentFetchRoute.POST(request('POST', '/api/agent/fetch', { body: purchase, headers: { authorization } }));
    expect(fetched.status).toBe(200);
    const called = await mcpRoute.POST(
      request('POST', '/api/mcp', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'paid_fetch', arguments: purchase } },
        headers: { authorization, accept: 'application/json, text/event-stream' },
      }),
    );
    expect(called.status).toBe(200);
    expect(seen).toEqual([
      { method: 'getCurrentEpoch', scope: asOwner(ownerId) },
      { method: 'getCurrentEpoch', scope: asOwner(ownerId) },
    ]);
  });
});
