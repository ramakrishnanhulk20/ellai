// Covers: the owner routes called as Next would call them, with Request objects, on PGlite
// with a stub chain: a cookie from the real sign-in routes opening the overview; the session
// requirement on every owner route; the overview's settings, onboarding, purse, counts and
// question rate, with bigints as strings, a chain failure as purse null with purseRead true but the
// Tatum budget's refusal as 503 chain_unavailable_today, the purse still read and metered after the
// allowance is forgotten for an owner with any refill row, whatever its status or Ellai's ledger
// (C38), and no chain read at all, purseRead false, for an owner with neither; whether the
// built-in agent has a key, never the key; the question list
// with Ellai's payment facts apart from agent text; answering, with its memory and grant; one
// owner never seeing or answering another's question; same origin on the answer; and that an
// unexpected failure, including a real database error carrying SQL, is a bare 500.
// Does NOT cover: a real chain read (the chain is stubbed), how a page renders the agent text
// (no pages exist yet), sending the answer's memory to Walrus (a later job), or two database
// connections answering one question at once (PGlite serves one connection).
import { randomBytes } from 'node:crypto';
import { type Chain, ChainError } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nonceRoute from '../src/app/api/auth/nonce/route.js';
import * as verifyRoute from '../src/app/api/auth/verify/route.js';
import * as overviewRoute from '../src/app/api/owner/overview/route.js';
import * as answerRoute from '../src/app/api/owner/questions/[id]/answer/route.js';
import * as questionsRoute from '../src/app/api/owner/questions/route.js';
import { endSession } from '../src/server/auth/sessions.js';
import { completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { SESSION_TOKEN_PREFIX, newBearerToken } from '../src/server/auth/tokens.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisionCitations, decisions, grants, memories, owners, payments, questions, refills } from '../src/server/db/schema.js';
import { decide } from '../src/server/decide/decide.js';
import type { ServerEnv } from '../src/server/env.js';
import { type ServerContextFactory, setServerContextFactory } from '../src/server/http/context.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const address = () => `0x${hex(32)}`;
const APP_ORIGIN = 'https://ellai.example';
const SECRET = hex(32);
const MASTER = hex(32);
const MARKER = 'MARKER_c41d_secret';
const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: MASTER,
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: SECRET,
  JOBS_SECRET: hex(32),
  APP_ORIGIN,
};
const DAY_MS = 86_400_000;

const getBalances = vi.fn<Chain['getBalances']>();
const chain = { getBalances } as unknown as Chain;

const FIRST_MINUTE = Math.floor(Date.now() / 60_000) * 60_000;
let minutesUsed = 0;
let clock = new Date(FIRST_MINUTE);
const ago = (ms: number) => new Date(clock.getTime() - ms);

const realFactory: ServerContextFactory = async () => ({ db, chain, env: ENV, now: () => clock });

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
  setServerContextFactory(realFactory);
  getBalances.mockReset();
  getBalances.mockResolvedValue({ usdcAddressBalance: 123_456n, usdcCoinBalance: 0n, suiTotal: 0n });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

interface Owner {
  ownerId: string;
  address: string;
  cookie: string;
}

async function sign(signer: Signer, message: string): Promise<string> {
  return (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
}

async function signedInOwner(): Promise<Owner> {
  const signer = Ed25519Keypair.generate();
  const { message } = await issueSignIn({ db, address: signer.toSuiAddress(), appOrigin: APP_ORIGIN, now: clock });
  const done = await completeSignIn({ db, message, signature: await sign(signer, message), appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now: clock });
  return { ownerId: done.ownerId, address: canonicalSuiAddress(signer.toSuiAddress()), cookie: `__Host-ellai_session=${done.sessionToken}` };
}

/** Records an allowance for the owner, as onboarding's confirm step does, so the overview has a purse to read. */
async function withAllowance(owner: Owner): Promise<Owner> {
  await db.update(owners).set({ allowanceId: address(), allowanceCheckedAt: clock }).where(eq(owners.id, owner.ownerId));
  return owner;
}

async function agentFor(ownerId: string, label = 'Travel agent'): Promise<string> {
  const row = one(await db.insert(agents).values({ ownerId, label, kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_agent_' }).returning());
  return row.id;
}

type DecisionRow = typeof decisions.$inferInsert;

async function insertDecision(ownerId: string, agentId: string, overrides: Partial<DecisionRow> = {}): Promise<string> {
  const row = one(
    await db
      .insert(decisions)
      .values({
        ownerId,
        agentId,
        requestKey: hex(16),
        sellerUrl: 'https://hotels.example/v1/rooms',
        sellerMethod: 'POST',
        sellerHost: 'hotels.example',
        bodyHash: hex(32),
        purpose: 'Book the hotel room',
        recipient: `0x${'11'.repeat(32)}`,
        amountAtomic: 12_345n,
        asset: USDC_TYPE_MAINNET,
        network: 'sui:mainnet',
        expiresAt: new Date(clock.getTime() + 60_000),
        outcome: 'approved',
        rule: 'learned',
        reason: 'You approved this recipient before.',
        status: 'open',
        createdAt: clock,
        ...overrides,
      })
      .returning({ id: decisions.id }),
  );
  return row.id;
}

async function askQuestion(ownerId: string, agentId: string, askedAt: Date, overrides: Partial<DecisionRow> = {}): Promise<string> {
  const decisionId = await insertDecision(ownerId, agentId, { outcome: 'asked', rule: 'no_match', reason: 'Ellai has no decision of yours like this one.', status: 'asked', createdAt: askedAt, ...overrides });
  await db.insert(questions).values({ decisionId, ownerId, createdAt: askedAt });
  return decisionId;
}

async function verifiedPayment(ownerId: string, decisionId: string, signedAt: Date, settlement: 'verified' | 'not_landed' = 'verified'): Promise<void> {
  await db.insert(payments).values({
    decisionId,
    ownerId,
    purseAddress: address(),
    recipient: `0x${'11'.repeat(32)}`,
    amountAtomic: 12_345n,
    digest: hex(16),
    txBytesBase64: 'AA==',
    signedAt,
    validUntilEpoch: 1n,
    settlement,
  });
}

// A question asked the way agents cause them: through decide, with recall finding nothing.
async function decidedQuestion(owner: Owner): Promise<string> {
  const agentId = await agentFor(owner.ownerId);
  const payment: CanonicalPayment = {
    dialect: 'x402-v2',
    sellerUrl: 'https://hotels.example/v1/rooms',
    sellerHost: 'hotels.example',
    recipient: `0x${'22'.repeat(32)}`,
    amount: 43_210n,
    asset: USDC_TYPE_MAINNET,
    network: 'sui:mainnet',
    expiresAtMs: clock.getTime() + 60_000,
    challengeId: hex(8),
    nonce: '1',
    minEpoch: null,
    maxEpoch: null,
    resource: null,
  };
  const asked = await decide({
    db,
    ownerId: owner.ownerId,
    agentId,
    payment,
    method: 'POST',
    bodyHash: hex(32),
    purpose: 'Book the hotel room',
    recall: async () => [],
    delegatePublicKeyHex: ownerDelegate(MASTER, owner.address).publicKeyHex,
    namespace: MEMORY_NAMESPACE,
    now: clock,
  });
  expect(asked.outcome).toBe('asked');
  return asked.decisionId;
}

function get(path: string, cookie?: string): Request {
  return new Request(`${APP_ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } });
}

function answerRequest(id: string, body: unknown, options: { cookie?: string; origin?: string | null; contentType?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/json' };
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  const request = new Request(`${APP_ORIGIN}/api/owner/questions/${id}/answer`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return answerRoute.POST(request, { params: Promise.resolve({ id }) });
}

const overview = (cookie?: string, path = '/api/owner/overview') => overviewRoute.GET(get(path, cookie));
const listQuestions = (cookie?: string) => questionsRoute.GET(get('/api/owner/questions', cookie));

interface Listed {
  decisionId: string;
  askedAt: string;
  payment: Record<string, string>;
  agent: { id: string; label: string };
  purpose: string;
  rule: string;
  reason: string;
  citedMemories: Array<{ memoryId: string; blobId: string | null }>;
}

async function listed(cookie: string): Promise<Listed[]> {
  const response = await listQuestions(cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { questions: Listed[] }).questions;
}

function quiet(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('route files', () => {
  it.each([
    ['overview', overviewRoute],
    ['questions', questionsRoute],
    ['answer', answerRoute],
  ])('%s runs on Node and is never cached or prerendered', (_name, route) => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('the session requirement', () => {
  const routes: Array<[string, (cookie?: string) => Promise<Response>]> = [
    ['overview', (cookie) => overview(cookie)],
    ['questions', (cookie) => listQuestions(cookie)],
    ['answer', (cookie) => answerRequest('00000000-0000-4000-8000-000000000000', { answer: 'approve' }, cookie === undefined ? {} : { cookie })],
  ];

  it.each(routes)('%s is 401 signed_out with no cookie, a junk cookie, or a session that has ended', async (_name, run) => {
    quiet();
    const owner = await signedInOwner();
    await endSession({ db, token: owner.cookie.slice('__Host-ellai_session='.length), sessionSecretHex: SECRET, now: clock });
    for (const cookie of [undefined, `__Host-ellai_session=${MARKER}`, '__Host-ellai_session=', owner.cookie]) {
      const response = await run(cookie);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'signed_out', message: 'Sign in to Ellai to continue.' });
    }
  });
});

describe('GET /api/owner/overview', () => {
  it('opens with the cookie the real sign-in routes set, reads the owner from the session alone, and reads no chain for an owner with no allowance', async () => {
    const signer = Ed25519Keypair.generate();
    const post = (path: string, body: unknown) => new Request(`${APP_ORIGIN}${path}`, { method: 'POST', headers: { origin: APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { message } = (await (await nonceRoute.POST(post('/api/auth/nonce', { address: signer.toSuiAddress() }))).json()) as { message: string };
    const verified = await verifyRoute.POST(post('/api/auth/verify', { message, signature: await sign(signer, message) }));
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')?.split(';')[0] ?? '';
    const someoneElse = await signedInOwner();

    const response = await overview(cookie, `/api/owner/overview?ownerId=${someoneElse.ownerId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, Record<string, unknown> | null>;
    const ownerAddress = canonicalSuiAddress(signer.toSuiAddress());
    const purseAddress = canonicalSuiAddress(derivePurseKeypair(MASTER, ownerAddress).toSuiAddress());
    expect(body).toEqual({
      owner: {
        suiAddress: ownerAddress,
        purseAddress,
        paused: false,
        autoPausedReason: null,
        perPaymentMaxAtomic: '50000',
        dailyBudgetAtomic: '500000',
        approvalsNeeded: 2,
        distanceCutoff: 0.5,
        publicProof: false,
      },
      onboarding: { memoryAccount: 'missing', delegate: 'missing', allowance: 'missing', purseAddress },
      purse: null,
      purseRead: false,
      counts: { asked: 0, approved: 0, refused: 0, paid: 0 },
      questionsPer20: { asked: 0, window: 0 },
      builtinAgent: 'needs_key',
    });
    expect(getBalances).not.toHaveBeenCalled();
  });

  it("says whether the built-in agent can run, 'ready' only with a key on the server, and never the key", async () => {
    const owner = await signedInOwner();
    const builtinAgent = async () => ((await (await overview(owner.cookie)).json()) as { builtinAgent: unknown }).builtinAgent;
    expect(await builtinAgent()).toBe('needs_key');
    setServerContextFactory(async () => ({ db, chain, env: { ...ENV, ANTHROPIC_API_KEY: MARKER }, now: () => clock }));
    expect(await builtinAgent()).toBe('ready');
    expect(await (await overview(owner.cookie)).text()).not.toContain(MARKER);
  });

  it("reads the purse's USDC from chain once the owner has an allowance, and the rest of the answer keeps its shape", async () => {
    const owner = await withAllowance(await signedInOwner());
    const purseAddress = canonicalSuiAddress(derivePurseKeypair(MASTER, owner.address).toSuiAddress());
    const body = (await (await overview(owner.cookie)).json()) as Record<string, unknown>;
    expect([body.purse, body.purseRead]).toEqual([{ usdcAtomic: '123456' }, true]);
    expect(body.onboarding).toEqual({ memoryAccount: 'missing', delegate: 'missing', allowance: 'present', purseAddress });
    expect(Object.keys(body)).toEqual(['owner', 'onboarding', 'purse', 'purseRead', 'counts', 'questionsPer20', 'builtinAgent']);
    expect(Object.keys(body.owner as object)).not.toContain('allowanceId');
    expect(getBalances.mock.calls).toEqual([[purseAddress]]);
  });

  it('reads the purse whenever it may hold USDC, an allowance recorded or any refill row whatever its status or the ledger, metered as with an allowance, and tells a failed read from no read (C38)', async () => {
    quiet();
    type Body = { purse: unknown; purseRead: unknown; onboarding: { allowance: string } };
    const seen = async (owner: Owner) => {
      const body = (await (await overview(owner.cookie)).json()) as Body;
      return [body.purse, body.purseRead, body.onboarding.allowance];
    };
    const refilled = async (owner: Owner, status: 'pending' | 'verified' | 'failed') =>
      db.insert(refills).values({ ownerId: owner.ownerId, allowanceId: address(), amountAtomic: 100_000n, digest: hex(32), sentAt: ago(DAY_MS), status, verifiedAt: status === 'verified' ? ago(DAY_MS) : null });
    getBalances.mockResolvedValue({ usdcAddressBalance: 100_000n, usdcCoinBalance: 0n, suiTotal: 0n });

    // The first refill landed but Ellai has not read it back, and the allowance it came from was
    // then forgotten: the ledger counts nothing in, while the purse holds 0.10 USDC.
    const firstStillPending = await signedInOwner();
    await refilled(firstStillPending, 'pending');
    expect(await seen(firstStillPending)).toEqual([{ usdcAtomic: '100000' }, true, 'missing']);
    expect(getBalances.mock.calls).toEqual([[canonicalSuiAddress(derivePurseKeypair(MASTER, firstStillPending.address).toSuiAddress())]]);

    // A verified refill all spent puts the ledger at zero; a failed one is still a refill row.
    const spentDown = await signedInOwner();
    await refilled(spentDown, 'verified');
    const spent = await insertDecision(spentDown.ownerId, await agentFor(spentDown.ownerId), { status: 'paid', amountAtomic: 100_000n, createdAt: ago(60_000) });
    await db.insert(payments).values({ decisionId: spent, ownerId: spentDown.ownerId, purseAddress: address(), recipient: `0x${'11'.repeat(32)}`, amountAtomic: 100_000n, digest: hex(16), txBytesBase64: 'AA==', signedAt: ago(60_000), validUntilEpoch: 1n, settlement: 'verified' });
    const onlyFailed = await signedInOwner();
    await refilled(onlyFailed, 'failed');
    for (const owner of [spentDown, onlyFailed]) expect(await seen(owner)).toEqual([{ usdcAtomic: '100000' }, true, 'missing']);

    // A read that fails is still a read: the screen can say so instead of "not set up".
    getBalances.mockRejectedValueOnce(new ChainError('UPSTREAM', 'network error', true));
    expect(await seen(firstStillPending)).toEqual([null, true, 'missing']);

    // The same per-minute cap as an owner with an allowance: the 31st request is turned away before any read.
    getBalances.mockClear();
    for (let i = 2; i < LIMITS.ownerChainReadsPerMinute; i += 1) expect((await overview(firstStillPending.cookie)).status).toBe(200);
    expect((await overview(firstStillPending.cookie)).status).toBe(429);
    expect(getBalances).toHaveBeenCalledTimes(LIMITS.ownerChainReadsPerMinute - 2);

    const neverRefilled = await signedInOwner();
    getBalances.mockClear();
    for (let i = 0; i <= LIMITS.ownerChainReadsPerMinute; i += 1) {
      const response = await overview(neverRefilled.cookie);
      const body = (await response.json()) as Body;
      expect([response.status, body.purse, body.purseRead]).toEqual([200, null, false]);
    }
    expect(getBalances).not.toHaveBeenCalled();
  });

  it("shows whether /proof lists the owner, off until the owner opts in, and never another owner's setting", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    await db.update(owners).set({ publicProof: true }).where(eq(owners.id, other.ownerId));
    const shown = async (cookie: string) => ((await (await overview(cookie)).json()) as { owner: { publicProof: unknown } }).owner.publicProof;
    expect(await shown(owner.cookie)).toBe(false);
    await db.update(owners).set({ publicProof: true }).where(eq(owners.id, owner.ownerId));
    expect(await shown(owner.cookie)).toBe(true);
    await db.update(owners).set({ publicProof: false }).where(eq(owners.id, owner.ownerId));
    expect(await shown(owner.cookie)).toBe(false);
  });

  it('writes every atomic amount as an exact decimal string, even past 2^53', async () => {
    const owner = await withAllowance(await signedInOwner());
    await db.update(owners).set({ perPaymentMaxAtomic: 9_223_372_036_854_775_807n, dailyBudgetAtomic: 9_007_199_254_740_993n }).where(eq(owners.id, owner.ownerId));
    getBalances.mockResolvedValue({ usdcAddressBalance: 18_446_744_073_709_551_615n, usdcCoinBalance: 0n, suiTotal: 0n });
    const text = await (await overview(owner.cookie)).text();
    expect(text).toContain('"perPaymentMaxAtomic":"9223372036854775807"');
    expect(text).toContain('"dailyBudgetAtomic":"9007199254740993"');
    expect(text).toContain('"purse":{"usdcAtomic":"18446744073709551615"}');
  });

  it('gives purse null with purseRead true, not a 500, when the chain cannot be read, logging only a fixed code (C38)', async () => {
    const owner = await withAllowance(await signedInOwner());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Core reports a network failure as UPSTREAM 'network error'.
    for (const failure of [new ChainError('UPSTREAM', 'network error', true), new ChainError('TIMEOUT', 'timed out', true), new Error(MARKER)]) {
      getBalances.mockRejectedValueOnce(failure);
      const response = await overview(owner.cookie);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { purse: unknown; purseRead: unknown; owner: { suiAddress: string } };
      expect([body.purse, body.purseRead]).toEqual([null, true]);
      expect(body.owner.suiAddress).toBe(owner.address);
    }
    expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([
      '[ellai http] purse_balance_unavailable UPSTREAM',
      '[ellai http] purse_balance_unavailable TIMEOUT',
      '[ellai http] purse_balance_unavailable UNEXPECTED',
    ]);
  });

  it("answers 503 chain_unavailable_today, not a blank purse, when Ellai's Tatum budget refused the purse read (C22)", async () => {
    quiet();
    const owner = await withAllowance(await signedInOwner());
    getBalances.mockRejectedValueOnce(new ChainError('BUDGET', MARKER));
    const response = await overview(owner.cookie);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'chain_unavailable_today', message: "Ellai has used today's budget for reading Sui. Try again tomorrow (days are counted in UTC)." });
    expect(text).not.toContain(MARKER);
    expect(getBalances).toHaveBeenCalledTimes(1);
  });

  it('counts the last 30 days of decisions by outcome, and payments the chain verified', async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const recent = ago(DAY_MS);
    const old = ago(31 * DAY_MS);
    for (let i = 0; i < 2; i += 1) await insertDecision(owner.ownerId, agentId, { outcome: 'asked', rule: 'no_match', status: 'expired', createdAt: recent });
    const paidOne = await insertDecision(owner.ownerId, agentId, { status: 'paid', createdAt: recent });
    const neverLanded = await insertDecision(owner.ownerId, agentId, { status: 'paid', createdAt: recent });
    await insertDecision(owner.ownerId, agentId, { createdAt: recent });
    await insertDecision(owner.ownerId, agentId, { outcome: 'refused', rule: 'over_payment_max', status: 'refused', createdAt: recent });
    await verifiedPayment(owner.ownerId, paidOne, recent);
    await verifiedPayment(owner.ownerId, neverLanded, recent, 'not_landed');
    const oldPaid = await insertDecision(owner.ownerId, agentId, { status: 'paid', createdAt: old });
    await verifiedPayment(owner.ownerId, oldPaid, old);
    await insertDecision(owner.ownerId, agentId, { outcome: 'asked', rule: 'no_match', status: 'expired', createdAt: old });
    await insertDecision(other.ownerId, await agentFor(other.ownerId), { outcome: 'refused', rule: 'paused', status: 'refused', createdAt: recent });

    const body = (await (await overview(owner.cookie)).json()) as { counts: unknown };
    expect(body.counts).toEqual({ asked: 2, approved: 3, refused: 1, paid: 1 });
  });

  it('reports how many of the latest 20 approved or asked decisions were asked, ignoring refusals', async () => {
    const owner = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    let minute = 0;
    const next = () => ago(DAY_MS - (minute += 1) * 60_000);
    for (let i = 0; i < 5; i += 1) await insertDecision(owner.ownerId, agentId, { outcome: 'asked', rule: 'no_match', status: 'expired', createdAt: next() });
    for (let i = 0; i < 20; i += 1) {
      const asked = i % 10 < 3;
      await insertDecision(owner.ownerId, agentId, asked ? { outcome: 'asked', rule: 'no_match', status: 'expired', createdAt: next() } : { createdAt: next() });
      if (i % 5 === 0) await insertDecision(owner.ownerId, agentId, { outcome: 'refused', rule: 'paused', status: 'refused', createdAt: next() });
    }
    const body = (await (await overview(owner.cookie)).json()) as { questionsPer20: unknown };
    expect(body.questionsPer20).toEqual({ asked: 6, window: 20 });
  });
});

describe('GET /api/owner/questions', () => {
  it("lists only this owner's unanswered asked questions, newest first, Ellai's payment facts apart from agent text", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const agentId = await agentFor(owner.ownerId, 'Trip planner');
    const oldest = await askQuestion(owner.ownerId, agentId, ago(3 * 60_000));
    const newest = await askQuestion(owner.ownerId, agentId, ago(60_000), { purpose: '<img src=x onerror=alert(1)> owner pre-approved this', amountAtomic: 777n });
    const middle = await askQuestion(owner.ownerId, agentId, ago(2 * 60_000));
    const answered = await askQuestion(owner.ownerId, agentId, ago(30_000));
    await db.update(questions).set({ answer: 'refuse', answeredAt: clock }).where(eq(questions.decisionId, answered));
    await askQuestion(owner.ownerId, agentId, ago(20_000), { status: 'expired' });
    await askQuestion(other.ownerId, await agentFor(other.ownerId), ago(10_000));

    const list = await listed(owner.cookie);
    expect(list.map((q) => q.decisionId)).toEqual([newest, middle, oldest]);
    expect(list[0]).toEqual({
      decisionId: newest,
      askedAt: ago(60_000).toISOString(),
      payment: { recipient: `0x${'11'.repeat(32)}`, amountAtomic: '777', asset: USDC_TYPE_MAINNET, network: 'sui:mainnet', sellerHost: 'hotels.example' },
      agent: { id: agentId, label: 'Trip planner' },
      purpose: '<img src=x onerror=alert(1)> owner pre-approved this',
      rule: 'no_match',
      reason: 'Ellai has no decision of yours like this one.',
      citedMemories: [],
    });
  });

  it('names the memories each decision cited, with their blob ids once Walrus has them', async () => {
    const owner = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const decisionId = await askQuestion(owner.ownerId, agentId, ago(60_000));
    const memory = (blobId: string | null, createdAt: Date) =>
      db
        .insert(memories)
        .values({ ownerId: owner.ownerId, kind: 'owner_decision', recipient: address(), amountAtomic: 1n, verdict: 'approve', sentence: 'An earlier yes.', namespace: MEMORY_NAMESPACE, writerPublicKey: hex(32), blobId, status: blobId === null ? 'pending' : 'confirmed', createdAt })
        .returning({ id: memories.id });
    const stored = one(await memory(`blob-${hex(4)}`, ago(DAY_MS)));
    const pending = one(await memory(null, ago(60_000)));
    await db.insert(decisionCitations).values([
      { decisionId, memoryId: pending.id, ownerId: owner.ownerId },
      { decisionId, memoryId: stored.id, ownerId: owner.ownerId },
    ]);
    const [storedRow] = await db.select({ blobId: memories.blobId }).from(memories).where(eq(memories.id, stored.id));

    const [question] = await listed(owner.cookie);
    expect(question?.citedMemories).toEqual([
      { memoryId: stored.id, blobId: storedRow?.blobId },
      { memoryId: pending.id, blobId: null },
    ]);
  });

  it('returns at most 50, dropping the oldest', async () => {
    const owner = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const ids = [];
    for (let i = 0; i < 51; i += 1) ids.push(await askQuestion(owner.ownerId, agentId, ago((51 - i) * 1_000)));
    const list = await listed(owner.cookie);
    expect(list).toHaveLength(50);
    expect(list.map((q) => q.decisionId)).not.toContain(ids[0]);
    expect(list[0]?.decisionId).toBe(ids[50]);
  });
});

describe('POST /api/owner/questions/[id]/answer', () => {
  it('records a yes as the owner decision memory written by their delegate key, and a grant for that payment', async () => {
    const owner = await signedInOwner();
    const decisionId = await decidedQuestion(owner);
    const response = await answerRequest(decisionId, { answer: 'approve', reason: 'I stay here every year' }, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const { memoryId, grantId } = (await response.json()) as { memoryId: string; grantId: string };

    expect(one(await db.select().from(memories).where(eq(memories.id, memoryId)))).toMatchObject({
      ownerId: owner.ownerId,
      kind: 'owner_decision',
      decisionId,
      verdict: 'approve',
      recipient: `0x${'22'.repeat(32)}`,
      amountAtomic: 43_210n,
      namespace: MEMORY_NAMESPACE,
      writerPublicKey: ownerDelegate(MASTER, owner.address).publicKeyHex,
      status: 'pending',
    });
    const grant = one(await db.select().from(grants).where(eq(grants.decisionId, decisionId)));
    expect(grant).toMatchObject({ id: grantId, ownerId: owner.ownerId, recipient: `0x${'22'.repeat(32)}`, maxAmountAtomic: 43_210n });
    expect(grant.expiresAt.getTime()).toBe(clock.getTime() + LIMITS.grantTtlMs);
    expect(await listed(owner.cookie)).toEqual([]);
  });

  it('records a no with its memory and no grant', async () => {
    const owner = await signedInOwner();
    const decisionId = await decidedQuestion(owner);
    const response = await answerRequest(decisionId, { answer: 'refuse' }, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const { memoryId, grantId } = (await response.json()) as { memoryId: string; grantId: null };
    expect(grantId).toBeNull();
    expect(one(await db.select().from(memories).where(eq(memories.id, memoryId)))).toMatchObject({ verdict: 'refuse', decisionId });
    expect(await db.select().from(grants).where(eq(grants.decisionId, decisionId))).toEqual([]);
  });

  it("answers another owner's question exactly as a missing one, 404, and leaves it untouched", async () => {
    quiet();
    const mine = await signedInOwner();
    const theirs = await signedInOwner();
    const theirQuestion = await decidedQuestion(theirs);
    expect((await listed(mine.cookie)).map((q) => q.decisionId)).not.toContain(theirQuestion);

    const stolen = await answerRequest(theirQuestion, { answer: 'approve' }, { cookie: mine.cookie });
    const missing = await answerRequest('00000000-0000-4000-8000-000000000000', { answer: 'approve' }, { cookie: mine.cookie });
    expect(stolen.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await stolen.text()).toBe(await missing.text());

    expect(one(await db.select().from(questions).where(eq(questions.decisionId, theirQuestion))).answer).toBeNull();
    expect(await db.select().from(memories).where(eq(memories.decisionId, theirQuestion))).toEqual([]);
    expect(await db.select().from(grants).where(eq(grants.decisionId, theirQuestion))).toEqual([]);
    expect((await answerRequest(theirQuestion, { answer: 'refuse' }, { cookie: theirs.cookie })).status).toBe(200);
  });

  it('refuses an answer from another site or with no Origin with 403, recording nothing', async () => {
    quiet();
    const owner = await signedInOwner();
    const decisionId = await decidedQuestion(owner);
    for (const origin of ['https://evil.example', null]) {
      const response = await answerRequest(decisionId, { answer: 'approve' }, { cookie: owner.cookie, origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'cross_origin' });
    }
    expect(one(await db.select().from(questions).where(eq(questions.decisionId, decisionId))).answer).toBeNull();
  });

  it('refuses a second answer with 409, and a bad answer, reason or id with 400', async () => {
    quiet();
    const owner = await signedInOwner();
    const decisionId = await decidedQuestion(owner);
    const cases: Array<[Promise<Response>, number, string]> = [
      [answerRequest(decisionId, { answer: 'maybe' }, { cookie: owner.cookie }), 400, 'bad_body'],
      [answerRequest(decisionId, { answer: 'approve', reason: 'r'.repeat(LIMITS.reasonMaxChars + 1) }, { cookie: owner.cookie }), 400, 'bad_input'],
      [answerRequest('not-a-uuid', { answer: 'approve' }, { cookie: owner.cookie }), 400, 'bad_input'],
      [answerRequest(decisionId, '{"answer":', { cookie: owner.cookie }), 400, 'bad_json'],
      [answerRequest(decisionId, { answer: 'approve' }, { cookie: owner.cookie, contentType: 'text/plain' }), 400, 'bad_content_type'],
    ];
    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, code]);
    }
    expect((await answerRequest(decisionId, { answer: 'approve' }, { cookie: owner.cookie })).status).toBe(200);
    const again = await answerRequest(decisionId, { answer: 'refuse' }, { cookie: owner.cookie });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'answered' });
  });
});

describe('unexpected failures', () => {
  const sessionCookie = () => `__Host-ellai_session=${newBearerToken(SESSION_TOKEN_PREFIX, SECRET).token}`;

  it('turns an unknown error inside a handler into 500 { error: internal } with no message text anywhere', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exploding = new Proxy({} as Database, {
      get() {
        throw new Error(`select token_hash from sessions ${MARKER}`);
      },
    });
    setServerContextFactory(async () => ({ db: exploding, chain, env: ENV, now: () => clock }));
    for (const response of [await overview(sessionCookie()), await listQuestions(sessionCookie()), await answerRequest(hex(4), { answer: 'approve' }, { cookie: sessionCookie() })]) {
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
    }
    expect(logged.mock.calls.flat().join(' ')).not.toContain(MARKER);
  });

  it("keeps a real database error's SQL and bound values out of the response and the log", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bare = await createDb('pglite:memory');
    try {
      setServerContextFactory(async () => ({ db: bare.db, chain, env: ENV, now: () => clock }));
      const response = await overview(sessionCookie());
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
      // 42P01 is Postgres's "undefined table": the table name and the token hash stay out.
      expect(logged.mock.calls.map((call) => call.join(' '))).toEqual(['[ellai http] DrizzleQueryError 42P01']);
    } finally {
      await bare.close();
    }
  });
});
