// Covers: the owner's account routes called as Next would call them, with Request objects, on
// PGlite with a stub chain: the session requirement on every one and same origin on every one
// that changes state; decision and memory history holding only the owner's own rows, newest
// first, paged by before and limit without losing or repeating rows that share a millisecond;
// agent tokens shown once and never again, revoking one stopping it, at most ten made an hour
// and twenty held at once by one owner; onboarding passing
// the owner, chain and master secret to the onboarding functions and their summaries and
// refusals back unchanged; settings held to their bounds at each edge, the auto pause cleared
// only on request, the public proof opt-in starting off and switched for the signed-in owner
// only; and one shared per-owner limit on the routes that read Sui.
// Does NOT cover: a real chain or wallet (the chain is stubbed and core's Walrus Memory builders
// are stand-ins; onboarding.test and prove:onboarding cover those), two database connections
// racing a settings change against signing (PGlite serves one connection, so the FOR UPDATE
// lock is not raced here), or how a page renders agent text (no pages exist yet).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { buildCreateAccountTx, findMemoryAccount, MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import type { Signer } from '@mysten/sui/cryptography';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentRoute from '../src/app/api/owner/agents/[id]/route.js';
import * as agentsRoute from '../src/app/api/owner/agents/route.js';
import * as decisionsRoute from '../src/app/api/owner/decisions/route.js';
import * as memoriesRoute from '../src/app/api/owner/memories/route.js';
import * as buildRoute from '../src/app/api/owner/onboarding/build/route.js';
import * as confirmRoute from '../src/app/api/owner/onboarding/confirm/route.js';
import * as onboardingRoute from '../src/app/api/owner/onboarding/route.js';
import * as overviewRoute from '../src/app/api/owner/overview/route.js';
import * as settingsRoute from '../src/app/api/owner/settings/route.js';
import { authenticateAgent } from '../src/server/auth/agents.js';
import { endSession } from '../src/server/auth/sessions.js';
import { completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { hashBearerToken } from '../src/server/auth/tokens.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisionCitations, decisions, memories, owners, payments } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { type ServerContextFactory, setServerContextFactory } from '../src/server/http/context.js';
import { HttpError, type HttpErrorCode } from '../src/server/http/errors.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { buildOnboardingTx } from '../src/server/onboarding/build.js';
import { confirmOnboardingTx } from '../src/server/onboarding/confirm.js';

vi.mock('@ellai/core/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ellai/core/memory')>()),
  findMemoryAccount: vi.fn(),
  buildCreateAccountTx: vi.fn(),
  buildAddDelegateTx: vi.fn(),
}));

// The real functions, watched, so a test can see exactly what the routes passed and returned.
vi.mock('../src/server/onboarding/build.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/onboarding/build.js')>();
  return { ...real, buildOnboardingTx: vi.fn(real.buildOnboardingTx) };
});
vi.mock('../src/server/onboarding/confirm.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/onboarding/confirm.js')>();
  return { ...real, confirmOnboardingTx: vi.fn(real.confirmOnboardingTx) };
});

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const address = () => `0x${hex(32)}`;
const APP_ORIGIN = 'https://ellai.example';
const SECRET = hex(32);
const MASTER = hex(32);
const MARKER = 'MARKER_7be2_secret';
const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: MASTER,
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: SECRET,
  JOBS_SECRET: hex(32),
  APP_ORIGIN,
};
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const DIGEST = 'AQ2cfEAh3AiC1SBMkH64f4MP4QsvTettKfhLXErgNcFh';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const FIRST_MINUTE = Math.floor(Date.now() / 60_000) * 60_000;
let minutesUsed = 0;
let clock = new Date(FIRST_MINUTE);
const ago = (ms: number) => new Date(clock.getTime() - ms);

interface ChainSetup {
  sender?: string;
  landed?: boolean;
}

// One stand-in for every read the routes make: the overview's balance, the allowance build's
// epoch and gas price, and confirm's transaction reads. chainSetup changes what confirm sees.
let chainSetup: ChainSetup = {};
let chainOwner = '';
const getBalances = vi.fn<Chain['getBalances']>();
const getTransactionResult = vi.fn(async (_digest: string) => {
  if (chainSetup.landed === false) throw new ChainError('NOT_FOUND', 'stand-in not found');
  return { status: 'success' as const, balanceChanges: [] };
});
const getTransaction = vi.fn(async ({ digest }: { digest: string }) => ({
  response: {
    transaction: {
      digest,
      transaction: { sender: chainSetup.sender ?? chainOwner },
      effects: { changedObjects: [{ objectId: `0x${'9c'.repeat(32)}`, objectType: '0x2::coin::Coin<0x2::sui::SUI>', idOperation: GrpcTypes.ChangedObject_IdOperation.NONE }] },
    },
  },
}));
const chain = {
  usesApiKey: true,
  getBalances,
  getTransactionResult,
  getCurrentEpoch: async () => 900n,
  getReferenceGasPrice: async () => 100n,
  grpc: { ledgerService: { getTransaction } },
} as unknown as Chain;

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
  chainSetup = {};
  getBalances.mockReset();
  getBalances.mockResolvedValue({ usdcAddressBalance: 123_456n, usdcCoinBalance: 0n, suiTotal: 0n });
  getTransactionResult.mockClear();
  getTransaction.mockClear();
  vi.mocked(findMemoryAccount).mockReset();
  vi.mocked(buildCreateAccountTx).mockReset();
  vi.mocked(buildOnboardingTx).mockClear();
  vi.mocked(confirmOnboardingTx).mockClear();
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
  const row = one(await db.select({ suiAddress: owners.suiAddress }).from(owners).where(eq(owners.id, done.ownerId)));
  return { ownerId: done.ownerId, address: row.suiAddress, cookie: `__Host-ellai_session=${done.sessionToken}` };
}

async function agentFor(ownerId: string, label = 'Travel agent'): Promise<string> {
  const row = one(await db.insert(agents).values({ ownerId, label, kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_agent_' }).returning());
  return row.id;
}

async function insertDecision(ownerId: string, agentId: string, overrides: Partial<typeof decisions.$inferInsert> = {}): Promise<string> {
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
        status: 'paid',
        createdAt: clock,
        ...overrides,
      })
      .returning({ id: decisions.id }),
  );
  return row.id;
}

async function insertMemory(ownerId: string, overrides: Partial<typeof memories.$inferInsert> = {}): Promise<string> {
  const row = one(
    await db
      .insert(memories)
      .values({
        ownerId,
        kind: 'owner_decision',
        recipient: `0x${'11'.repeat(32)}`,
        amountAtomic: 12_345n,
        verdict: 'approve',
        sellerHost: 'hotels.example',
        sentence: 'You approved 0.012345 USDC to hotels.example.',
        namespace: MEMORY_NAMESPACE,
        writerPublicKey: hex(32),
        createdAt: clock,
        ...overrides,
      })
      .returning({ id: memories.id }),
  );
  return row.id;
}

function get(path: string, cookie?: string): Request {
  return new Request(`${APP_ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } });
}

interface SendOptions {
  cookie?: string;
  origin?: string | null;
}

function send(method: string, path: string, body: unknown, options: SendOptions = {}): Request {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (body === undefined) return new Request(`${APP_ORIGIN}${path}`, { method, headers });
  headers['content-type'] = 'application/json';
  return new Request(`${APP_ORIGIN}${path}`, { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const listDecisions = (cookie?: string, query = '') => decisionsRoute.GET(get(`/api/owner/decisions${query}`, cookie));
const listMemories = (cookie?: string, query = '') => memoriesRoute.GET(get(`/api/owner/memories${query}`, cookie));
const listAgents = (cookie?: string) => agentsRoute.GET(get('/api/owner/agents', cookie));
const createAgent = (body: unknown, options: SendOptions = {}) => agentsRoute.POST(send('POST', '/api/owner/agents', body, options));
const revoke = (id: string, options: SendOptions = {}) => agentRoute.DELETE(send('DELETE', `/api/owner/agents/${id}`, undefined, options), { params: Promise.resolve({ id }) });
const onboarding = (cookie?: string) => onboardingRoute.GET(get('/api/owner/onboarding', cookie));
const build = (body: unknown, options: SendOptions = {}) => buildRoute.POST(send('POST', '/api/owner/onboarding/build', body, options));
const confirm = (body: unknown, options: SendOptions = {}) => confirmRoute.POST(send('POST', '/api/owner/onboarding/confirm', body, options));
const patchSettings = (body: unknown, options: SendOptions = {}) => settingsRoute.PATCH(send('PATCH', '/api/owner/settings', body, options));
const overview = (cookie?: string) => overviewRoute.GET(get('/api/owner/overview', cookie));

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

async function refusedWith(response: Response, status: number, code: string): Promise<void> {
  expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, code]);
}

function quiet(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

interface Page<Row> {
  rows: Row[];
  nextBefore: string | null;
}

// Follows nextBefore from the first page to the last, and fails on a page that comes back
// empty while saying there is more, so a pager that stalls cannot loop.
async function allPages<Row>(read: (query: string) => Promise<Page<Row>>, limit: number): Promise<Row[][]> {
  const pages: Row[][] = [];
  let before: string | null = null;
  for (let turn = 0; turn < 100; turn += 1) {
    const page: Page<Row> = await read(`?limit=${limit}${before === null ? '' : `&before=${encodeURIComponent(before)}`}`);
    pages.push(page.rows);
    if (page.nextBefore === null) return pages;
    expect(page.rows.length).toBeGreaterThan(0);
    before = page.nextBefore;
  }
  throw new Error('the pages never ended');
}

interface DecisionItem {
  decisionId: string;
  createdAt: string;
  agent: { id: string; label: string };
  payment: { recipient: string; amountAtomic: string; sellerHost: string };
  purpose: string;
  outcome: string;
  rule: string;
  reason: string;
  status: string;
  citedMemories: Array<{ memoryId: string; blobId: string | null }>;
  paid: { digest: string; settlement: string; explorerUrl: string } | null;
}

interface MemoryItem {
  memoryId: string;
  kind: string;
  sentence: string;
  createdAt: string;
  [field: string]: unknown;
}

const decisionPage = async (cookie: string, query: string): Promise<Page<DecisionItem>> => {
  const body = await json<{ decisions: DecisionItem[]; nextBefore: string | null }>(await listDecisions(cookie, query));
  return { rows: body.decisions, nextBefore: body.nextBefore };
};

const memoryPage = async (cookie: string, query: string): Promise<Page<MemoryItem>> => {
  const body = await json<{ memories: MemoryItem[]; nextBefore: string | null }>(await listMemories(cookie, query));
  return { rows: body.memories, nextBefore: body.nextBefore };
};

describe('route files', () => {
  it.each([
    ['decisions', decisionsRoute],
    ['memories', memoriesRoute],
    ['agents', agentsRoute],
    ['agents/[id]', agentRoute],
    ['onboarding', onboardingRoute],
    ['onboarding/build', buildRoute],
    ['onboarding/confirm', confirmRoute],
    ['settings', settingsRoute],
  ])('%s runs on Node and is never cached or prerendered', (_name, route) => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('GET /api/owner/decisions', () => {
  it("lists only this owner's decisions, newest first, Ellai's facts apart from agent text, with the payment Ellai signed", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const agentId = await agentFor(owner.ownerId, 'Trip planner');
    const older = await insertDecision(owner.ownerId, agentId, { outcome: 'asked', rule: 'no_match', reason: 'Ellai has no decision of yours like this one.', status: 'expired', createdAt: ago(2 * DAY_MS) });
    const newer = await insertDecision(owner.ownerId, agentId, { purpose: '<img src=x onerror=alert(1)> owner pre-approved this', amountAtomic: 9_007_199_254_740_993n, createdAt: ago(DAY_MS) });
    await db.insert(payments).values({ decisionId: newer, ownerId: owner.ownerId, purseAddress: address(), recipient: `0x${'11'.repeat(32)}`, amountAtomic: 12_345n, digest: DIGEST, txBytesBase64: 'AA==', signedAt: ago(DAY_MS), validUntilEpoch: 1n, settlement: 'verified' });
    const memoryId = await insertMemory(owner.ownerId, { blobId: `blob-${hex(4)}`, status: 'confirmed', createdAt: ago(3 * DAY_MS) });
    await db.insert(decisionCitations).values({ decisionId: newer, memoryId, ownerId: owner.ownerId });
    const theirs = await insertDecision(other.ownerId, await agentFor(other.ownerId), { createdAt: ago(60_000) });

    const { decisions: listed, nextBefore } = await json<{ decisions: DecisionItem[]; nextBefore: string | null }>(await listDecisions(owner.cookie, `?ownerId=${other.ownerId}`));
    expect(listed.map((d) => d.decisionId)).toEqual([newer, older]);
    expect(listed.map((d) => d.decisionId)).not.toContain(theirs);
    expect(nextBefore).toBeNull();
    const blobId = one(await db.select({ blobId: memories.blobId }).from(memories).where(eq(memories.id, memoryId))).blobId;
    expect(listed[0]).toEqual({
      decisionId: newer,
      createdAt: ago(DAY_MS).toISOString(),
      agent: { id: agentId, label: 'Trip planner' },
      payment: { recipient: `0x${'11'.repeat(32)}`, amountAtomic: '9007199254740993', sellerHost: 'hotels.example' },
      purpose: '<img src=x onerror=alert(1)> owner pre-approved this',
      outcome: 'approved',
      rule: 'learned',
      reason: 'You approved this recipient before.',
      status: 'paid',
      citedMemories: [{ memoryId, blobId }],
      paid: { digest: DIGEST, settlement: 'verified', explorerUrl: `https://suiscan.xyz/mainnet/tx/${DIGEST}` },
    });
    expect(listed[1]).toMatchObject({ decisionId: older, outcome: 'asked', status: 'expired', citedMemories: [], paid: null });

    const theirList = await json<{ decisions: DecisionItem[] }>(await listDecisions(other.cookie));
    expect(theirList.decisions.map((d) => d.decisionId)).toEqual([theirs]);
  });

  it('pages by before and limit, 20 by default and never more than 50', async () => {
    const owner = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const ids: string[] = [];
    for (let i = 0; i < 55; i += 1) ids.unshift(await insertDecision(owner.ownerId, agentId, { createdAt: ago((55 - i) * 1_000) }));

    const first = await decisionPage(owner.cookie, '');
    expect(first.rows.map((d) => d.decisionId)).toEqual(ids.slice(0, 20));
    expect(first.nextBefore).toBe(first.rows[19]?.createdAt);
    const second = await decisionPage(owner.cookie, `?before=${first.nextBefore}`);
    expect(second.rows.map((d) => d.decisionId)).toEqual(ids.slice(20, 40));
    for (const limit of ['50', '51', '1000', '999999999999999']) {
      expect((await decisionPage(owner.cookie, `?limit=${limit}`)).rows).toHaveLength(50);
    }
    const pages = await allPages((query) => decisionPage(owner.cookie, query), 7);
    expect(pages.map((page) => page.length)).toEqual([7, 7, 7, 7, 7, 7, 7, 6]);
    expect(pages.flat().map((d) => d.decisionId)).toEqual(ids);
  });

  it('never splits decisions that share a millisecond across pages, so none is lost or repeated', async () => {
    const owner = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const instants = [9, 8, 8, 8, 8, 7, 6, 6, 5, 5, 5, 5, 5, 5, 4].map((seconds) => ago(seconds * 1_000));
    for (const createdAt of instants) await insertDecision(owner.ownerId, agentId, { createdAt });
    const all = (await decisionPage(owner.cookie, '?limit=50')).rows.map((d) => d.decisionId);
    expect(all).toHaveLength(15);

    for (const limit of [1, 2, 3, 4, 5]) {
      const pages = await allPages((query) => decisionPage(owner.cookie, query), limit);
      const seen = pages.flat().map((d) => d.decisionId);
      expect(seen).toEqual(all);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(Math.max(limit, 6));
    }
  });

  it('refuses a query it cannot read exactly with 400 bad_query', async () => {
    quiet();
    const owner = await signedInOwner();
    for (const query of [
      '?before=yesterday',
      '?before=2026-10-25T10:00:00%2B01:00',
      '?before=2026-10-25T10:00:00.123456Z',
      '?before=2026-02-30T00:00:00Z',
      '?limit=0',
      '?limit=-1',
      '?limit=1.5',
      '?limit=1e2',
      '?limit=ten',
      '?limit=',
      '?limit=1&limit=2',
      '?before=2026-10-25T10:00:00Z&before=2026-10-24T10:00:00Z',
    ]) {
      const response = await listDecisions(owner.cookie, query);
      expect(await response.json()).toEqual({ error: 'bad_query', message: 'The query string does not have the values this endpoint takes.' });
      expect(response.status).toBe(400);
    }
    expect((await listDecisions(owner.cookie, '?before=2026-10-25T10:00:00Z&limit=5')).status).toBe(200);
  });
});

describe('GET /api/owner/memories', () => {
  it("lists only this owner's memories, sentences included, newest first", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const decisionId = await insertDecision(owner.ownerId, agentId, { createdAt: ago(3 * DAY_MS) });
    const confirmedAt = ago(DAY_MS);
    const stored = await insertMemory(owner.ownerId, { decisionId, blobId: `blob-${hex(4)}`, status: 'confirmed', confirmedAt, createdAt: ago(2 * DAY_MS) });
    const outcome = await insertMemory(owner.ownerId, { kind: 'outcome', decisionId, verdict: null, sentence: 'The seller did not deliver.', createdAt: ago(60_000) });
    const theirs = await insertMemory(other.ownerId, { sentence: MARKER, createdAt: ago(1_000) });

    const page = await memoryPage(owner.cookie, `?ownerId=${other.ownerId}`);
    expect(page.rows.map((m) => m.memoryId)).toEqual([outcome, stored]);
    expect(page.nextBefore).toBeNull();
    const blobId = one(await db.select({ blobId: memories.blobId }).from(memories).where(eq(memories.id, stored))).blobId;
    expect(page.rows[1]).toEqual({
      memoryId: stored,
      kind: 'owner_decision',
      verdict: 'approve',
      recipient: `0x${'11'.repeat(32)}`,
      amountAtomic: '12345',
      sellerHost: 'hotels.example',
      sentence: 'You approved 0.012345 USDC to hotels.example.',
      status: 'confirmed',
      blobId,
      createdAt: ago(2 * DAY_MS).toISOString(),
      confirmedAt: confirmedAt.toISOString(),
    });
    expect(page.rows[0]).toMatchObject({ kind: 'outcome', verdict: null, status: 'pending', blobId: null, confirmedAt: null });
    expect(JSON.stringify(page)).not.toContain(MARKER);
    expect((await memoryPage(other.cookie, '')).rows.map((m) => m.memoryId)).toEqual([theirs]);
  });

  it('pages by before and limit like decisions, ties included, capped at 50', async () => {
    quiet();
    const owner = await signedInOwner();
    const ids: string[] = [];
    // 54 at their own seconds, then the 6 oldest all in one millisecond.
    for (let i = 0; i < 60; i += 1) ids.push(await insertMemory(owner.ownerId, { createdAt: ago(Math.min(i + 1, 55) * 1_000) }));
    expect((await memoryPage(owner.cookie, '?limit=50')).rows.map((m) => m.memoryId)).toEqual(ids.slice(0, 50));
    expect((await memoryPage(owner.cookie, '')).rows.map((m) => m.memoryId)).toEqual(ids.slice(0, 20));
    const pages = await allPages((query) => memoryPage(owner.cookie, query), 4);
    expect(new Set(pages.flat().map((m) => m.memoryId))).toEqual(new Set(ids));
    expect(pages.flat()).toHaveLength(60);
    await refusedWith(await listMemories(owner.cookie, '?limit=0'), 400, 'bad_query');
  });
});

interface AgentListed {
  agentId: string;
  label: string;
  kind: string;
  displayPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}

const agentList = async (cookie: string) => (await json<{ agents: AgentListed[] }>(await listAgents(cookie))).agents;

describe('GET and POST /api/owner/agents', () => {
  it('shows a new token once, never cached, and never again, nor its hash', async () => {
    const owner = await signedInOwner();
    const created = await createAgent({ label: '  Trip planner  ' }, { cookie: owner.cookie });
    expect(created.headers.get('cache-control')).toBe('no-store');
    const { agentId, token, displayPrefix } = await json<{ agentId: string; token: string; displayPrefix: string }>(created);
    expect(token).toMatch(/^ellai_agent_[A-Za-z0-9_-]{43}$/);
    expect(displayPrefix).toBe(token.slice(0, 'ellai_agent_'.length + 6));
    expect(await authenticateAgent({ db, token, sessionSecretHex: SECRET })).toEqual({ ownerId: owner.ownerId, agentId });

    const hash = hashBearerToken(token, SECRET);
    expect(one(await db.select({ tokenHash: agents.tokenHash }).from(agents).where(eq(agents.id, agentId))).tokenHash).toBe(hash);
    const listed = await listAgents(owner.cookie);
    const text = await listed.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(String(hash));
    expect(text).not.toContain('tokenHash');
    expect((JSON.parse(text) as { agents: AgentListed[] }).agents).toEqual([
      { agentId, label: 'Trip planner', kind: 'external', displayPrefix, createdAt: clock.toISOString(), revokedAt: null },
    ]);
  });

  it("lists only this owner's agents, oldest first", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const first = await json<{ agentId: string }>(await createAgent({ label: 'First' }, { cookie: owner.cookie }));
    clock = new Date(clock.getTime() + 1_000);
    const second = await json<{ agentId: string }>(await createAgent({ label: 'Second' }, { cookie: owner.cookie }));
    await createAgent({ label: 'Theirs' }, { cookie: other.cookie });
    expect((await agentList(owner.cookie)).map((a) => [a.agentId, a.label])).toEqual([
      [first.agentId, 'First'],
      [second.agentId, 'Second'],
    ]);
    expect((await agentList(other.cookie)).map((a) => a.label)).toEqual(['Theirs']);
  });

  it('takes a label of 1 to 60 characters with no control characters, and nothing else', async () => {
    quiet();
    const owner = await signedInOwner();
    const cases: Array<[unknown, number, string]> = [
      [{ label: '' }, 400, 'bad_input'],
      [{ label: '   ' }, 400, 'bad_input'],
      [{ label: 'x'.repeat(61) }, 400, 'bad_input'],
      [{ label: 'bell\u0007' }, 400, 'bad_input'],
      [{ label: 42 }, 400, 'bad_body'],
      [{ label: 'ok', kind: 'builtin' }, 400, 'bad_body'],
      [{}, 400, 'bad_body'],
      ['{"label":', 400, 'bad_json'],
    ];
    for (const [sent, status, code] of cases) await refusedWith(await createAgent(sent, { cookie: owner.cookie }), status, code);
    expect(await agentList(owner.cookie)).toEqual([]);
    const longest = await json<{ agentId: string }>(await createAgent({ label: '\u{1F600}'.repeat(60) }, { cookie: owner.cookie }));
    expect((await agentList(owner.cookie)).map((a) => a.agentId)).toEqual([longest.agentId]);
  });

  it('turns away the 11th create in one hour for one owner with 429, others and the next hour untouched', async () => {
    quiet();
    const owner = await signedInOwner();
    const other = await signedInOwner();
    expect(LIMITS.agentCreatesPerHour).toBe(10);
    // The first call is a bad body: it is counted before the body is read.
    await refusedWith(await createAgent({}, { cookie: owner.cookie }), 400, 'bad_body');
    for (let i = 2; i <= 10; i += 1) expect((await createAgent({ label: `Agent ${i}` }, { cookie: owner.cookie })).status).toBe(200);
    const refused = await createAgent({ label: 'One more' }, { cookie: owner.cookie });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'too_many_agent_creates', message: new HttpError(429, 'too_many_agent_creates').message });
    expect(await agentList(owner.cookie)).toHaveLength(9);

    expect((await createAgent({ label: 'Theirs' }, { cookie: other.cookie })).status).toBe(200);
    clock = new Date(Math.floor(clock.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    expect((await createAgent({ label: 'Next hour' }, { cookie: owner.cookie })).status).toBe(200);
  });

  it('refuses a 21st live agent with 409 too_many_agents, and takes one again after a revoke', async () => {
    quiet();
    const owner = await signedInOwner();
    const held = [];
    for (let i = 0; i < LIMITS.agentsPerOwnerMax; i += 1) held.push(await agentFor(owner.ownerId, `Agent ${i + 1}`));
    const refused = await createAgent({ label: 'Agent 21' }, { cookie: owner.cookie });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'too_many_agents', message: 'an owner may hold at most 20 agents at once; revoke one first' });
    expect(await json(await revoke(held[0] ?? '', { cookie: owner.cookie }))).toEqual({ revoked: true });
    expect((await createAgent({ label: 'Agent 21' }, { cookie: owner.cookie })).status).toBe(200);
  });
});

describe('DELETE /api/owner/agents/[id]', () => {
  it('stops the token at once, and shows when in the list', async () => {
    const owner = await signedInOwner();
    const { agentId, token } = await json<{ agentId: string; token: string }>(await createAgent({ label: 'Trip planner' }, { cookie: owner.cookie }));
    const revokedAt = clock;
    expect(await json(await revoke(agentId, { cookie: owner.cookie }))).toEqual({ revoked: true });
    expect(await authenticateAgent({ db, token, sessionSecretHex: SECRET })).toBeNull();
    clock = new Date(clock.getTime() + 1_000);
    expect(await json(await revoke(agentId, { cookie: owner.cookie }))).toEqual({ revoked: true });
    expect((await agentList(owner.cookie)).map((a) => a.revokedAt)).toEqual([revokedAt.toISOString()]);
  });

  it("answers another owner's agent exactly as a missing one, 404, and leaves it working", async () => {
    quiet();
    const mine = await signedInOwner();
    const theirs = await signedInOwner();
    const { agentId, token } = await json<{ agentId: string; token: string }>(await createAgent({ label: 'Theirs' }, { cookie: theirs.cookie }));
    const stolen = await revoke(agentId, { cookie: mine.cookie });
    const missing = await revoke(MISSING_ID, { cookie: mine.cookie });
    expect([stolen.status, missing.status]).toEqual([404, 404]);
    expect(await stolen.text()).toBe(await missing.text());
    expect(await authenticateAgent({ db, token, sessionSecretHex: SECRET })).toEqual({ ownerId: theirs.ownerId, agentId });
    await refusedWith(await revoke('not-a-uuid', { cookie: mine.cookie }), 400, 'bad_input');
  });
});

const ACCOUNT_BYTES = new Uint8Array([1, 2, 3]);

describe('GET /api/owner/onboarding', () => {
  it("gives onboardingState for the session's owner, reading no chain", async () => {
    const owner = await signedInOwner();
    const purseAddress = one(await db.select({ purse: owners.purseAddress }).from(owners).where(eq(owners.id, owner.ownerId))).purse;
    expect(await json(await onboarding(owner.cookie))).toEqual({ memoryAccount: 'missing', delegate: 'missing', allowance: 'missing', purseAddress });
    await db.update(owners).set({ memwalAccountId: address() }).where(eq(owners.id, owner.ownerId));
    expect(await json(await onboarding(owner.cookie))).toMatchObject({ memoryAccount: 'present', delegate: 'missing' });
    expect(getBalances).not.toHaveBeenCalled();
    expect(getTransactionResult).not.toHaveBeenCalled();
  });
});

describe('POST /api/owner/onboarding/build', () => {
  it("passes the session's owner, the context's chain and the env's master secret, and returns the build unchanged", async () => {
    const owner = await signedInOwner();
    vi.mocked(buildCreateAccountTx).mockResolvedValue(ACCOUNT_BYTES);
    const body = await json<unknown>(await build({ step: 'memory_account' }, { cookie: owner.cookie }));
    const [call] = vi.mocked(buildOnboardingTx).mock.calls;
    expect(call?.[0]).toMatchObject({ ownerId: owner.ownerId, step: 'memory_account', chain, masterSecretHex: MASTER, now: clock });
    expect(call?.[0].allowance).toBeUndefined();
    expect(body).toEqual(await vi.mocked(buildOnboardingTx).mock.results[0]?.value);
    expect(body).toEqual({
      txBytesBase64: toBase64(ACCOUNT_BYTES),
      summary: [
        { label: 'Action', value: 'Create your Walrus Memory account' },
        { label: 'Account owner', value: owner.address },
      ],
    });
  });

  it('reads the allowance amounts as bigints and passes the summary through as built', async () => {
    const owner = await signedInOwner();
    const purse = one(await db.select({ purse: owners.purseAddress }).from(owners).where(eq(owners.id, owner.ownerId))).purse;
    const body = await json<{ txBytesBase64: string; summary: unknown }>(
      await build({ step: 'allowance', allowance: { dailyLimitAtomic: '500000', lifetimeCapAtomic: '9000000', days: 30 } }, { cookie: owner.cookie }),
    );
    expect(vi.mocked(buildOnboardingTx).mock.calls[0]?.[0].allowance).toEqual({ dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 9_000_000n, days: 30 });
    expect(body).toEqual(await vi.mocked(buildOnboardingTx).mock.results[0]?.value);
    expect(Transaction.from(fromBase64(body.txBytesBase64)).getData().sender).toBe(owner.address);
    const ends = new Date(clock.getTime() + 30 * DAY_MS).toISOString();
    expect(body.summary).toEqual([
      { label: 'Action', value: 'Let your Ellai purse draw USDC from your address balance' },
      { label: 'Who may spend', value: purse },
      { label: 'Daily limit', value: '0.500000 USDC' },
      { label: 'Total cap', value: '9.000000 USDC' },
      { label: 'Ends', value: `${ends.slice(0, 10)} ${ends.slice(11, 16)} UTC` },
    ]);
  });

  it("returns the onboarding functions' refusals as their fixed codes, and core's chain failures as fixed codes of their own", async () => {
    quiet();
    const owner = await signedInOwner();
    const terms = (daily: unknown, cap: unknown = '1000000', days: unknown = 30) => ({ step: 'allowance', allowance: { dailyLimitAtomic: daily, lifetimeCapAtomic: cap, days } });
    const cases: Array<[unknown, number, string]> = [
      [{ step: 'add_delegate' }, 409, 'not_ready'],
      [{ step: 'allowance' }, 400, 'bad_input'],
      [terms(String(LIMITS.purseRefillAtomic - 1)), 400, 'bad_input'],
      [terms(String(LIMITS.onboardingDailyLimitMaxAtomic + 1), String(LIMITS.onboardingLifetimeCapMaxAtomic)), 400, 'bad_input'],
      [terms('500000', '1000000', 91), 400, 'bad_input'],
      [terms('500000', '1000000', 1.5), 400, 'bad_input'],
      [terms(500_000), 400, 'bad_body'],
      [terms('0500000'), 400, 'bad_body'],
      [terms('-500000'), 400, 'bad_body'],
      [terms('5e5'), 400, 'bad_body'],
      [terms('500000.0'), 400, 'bad_body'],
      [terms('500000', '1000000', '30'), 400, 'bad_body'],
      [{ step: 'everything' }, 400, 'bad_body'],
      [{ step: 'memory_account', ownerId: MISSING_ID }, 400, 'bad_body'],
    ];
    for (const [sent, status, code] of cases) await refusedWith(await build(sent, { cookie: owner.cookie }), status, code);

    vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(new MemoryError('ACCOUNT', `the owner already has a Walrus Memory account ${MARKER}`));
    const refused = await build({ step: 'memory_account' }, { cookie: owner.cookie });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'chain_refused', message: 'Sui does not allow this step for your Walrus Memory account right now.' });
    for (const failure of [new MemoryError('TIMEOUT', MARKER), new ChainError('UPSTREAM', MARKER, true)]) {
      vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(failure);
      const unavailable = await build({ step: 'memory_account' }, { cookie: owner.cookie });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.text()).toBe('{"error":"chain_unavailable","message":"Ellai could not read Sui just now. Try again in a minute."}');
    }
    vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(new Error(MARKER));
    const unexpected = await build({ step: 'memory_account' }, { cookie: owner.cookie });
    expect([unexpected.status, await unexpected.text()]).toEqual([500, '{"error":"internal"}']);
  });
});

describe('POST /api/owner/onboarding/confirm', () => {
  it("records a step from what the chain shows for the session's owner, with the context's chain and the env's master secret", async () => {
    const owner = await signedInOwner();
    chainOwner = owner.address;
    const accountId = address();
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [] });
    expect(await json(await confirm({ step: 'memory_account', digest: DIGEST }, { cookie: owner.cookie }))).toEqual({ recorded: accountId });
    expect(vi.mocked(confirmOnboardingTx).mock.calls[0]?.[0]).toMatchObject({ ownerId: owner.ownerId, step: 'memory_account', digest: DIGEST, chain, masterSecretHex: MASTER, now: clock });
    expect(getTransactionResult).toHaveBeenCalledWith(DIGEST);
    expect(one(await db.select({ id: owners.memwalAccountId }).from(owners).where(eq(owners.id, owner.ownerId))).id).toBe(accountId);
  });

  it("returns confirm's refusals as their fixed codes, recording nothing", async () => {
    quiet();
    const owner = await signedInOwner();
    chainOwner = owner.address;
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId: address(), delegates: [] });
    await refusedWith(await confirm({ step: 'add_delegate', digest: DIGEST }, { cookie: owner.cookie }), 409, 'not_ready');
    await refusedWith(await confirm({ step: 'memory_account', digest: 'not-a-digest' }, { cookie: owner.cookie }), 400, 'bad_input');
    await refusedWith(await confirm({ step: 'memory_account', digest: 'x'.repeat(65) }, { cookie: owner.cookie }), 400, 'bad_body');
    await refusedWith(await confirm({ step: 'memory_account' }, { cookie: owner.cookie }), 400, 'bad_body');
    chainSetup = { landed: false };
    await refusedWith(await confirm({ step: 'memory_account', digest: DIGEST }, { cookie: owner.cookie }), 409, 'not_landed');
    chainSetup = { sender: address() };
    await refusedWith(await confirm({ step: 'memory_account', digest: DIGEST }, { cookie: owner.cookie }), 422, 'refused');
    expect(one(await db.select({ id: owners.memwalAccountId }).from(owners).where(eq(owners.id, owner.ownerId))).id).toBeNull();
  });
});

interface SettingsBody {
  paused: boolean;
  autoPausedReason: string | null;
  perPaymentMaxAtomic: string;
  dailyBudgetAtomic: string;
  approvalsNeeded: number;
  distanceCutoff: number;
  publicProof: boolean;
}

const DEFAULTS: SettingsBody = { paused: false, autoPausedReason: null, perPaymentMaxAtomic: '50000', dailyBudgetAtomic: '500000', approvalsNeeded: 2, distanceCutoff: 0.5, publicProof: false };

async function storedSettings(ownerId: string) {
  return one(
    await db
      .select({
        paused: owners.paused,
        autoPausedReason: owners.autoPausedReason,
        perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
        dailyBudgetAtomic: owners.dailyBudgetAtomic,
        approvalsNeeded: owners.approvalsNeeded,
        distanceCutoff: owners.distanceCutoff,
        publicProof: owners.publicProof,
      })
      .from(owners)
      .where(eq(owners.id, ownerId)),
  );
}

describe('PATCH /api/owner/settings', () => {
  it("changes only what is sent, on this owner's row only, and returns the settings after the change", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const changed = await json<SettingsBody>(await patchSettings({ paused: true, perPaymentMaxAtomic: '200000', dailyBudgetAtomic: '1000000', approvalsNeeded: 3, distanceCutoff: 0.3 }, { cookie: owner.cookie }));
    expect(changed).toEqual({ paused: true, autoPausedReason: null, perPaymentMaxAtomic: '200000', dailyBudgetAtomic: '1000000', approvalsNeeded: 3, distanceCutoff: 0.3, publicProof: false });
    expect(await storedSettings(owner.ownerId)).toEqual({ paused: true, autoPausedReason: null, perPaymentMaxAtomic: 200_000n, dailyBudgetAtomic: 1_000_000n, approvalsNeeded: 3, distanceCutoff: 0.3, publicProof: false });
    expect(await json(await patchSettings({ approvalsNeeded: 4 }, { cookie: owner.cookie }))).toEqual({ ...changed, approvalsNeeded: 4 });
    expect(await json(await patchSettings({ paused: false }, { cookie: owner.cookie }))).toEqual({ ...changed, approvalsNeeded: 4, paused: false });
    expect(await storedSettings(other.ownerId)).toEqual({ ...DEFAULTS, perPaymentMaxAtomic: 50_000n, dailyBudgetAtomic: 500_000n });
  });

  it('holds every bound at its edge, refusing just past it with nothing changed', async () => {
    quiet();
    const owner = await signedInOwner();
    const ok = async (change: Record<string, unknown>) => expect((await patchSettings(change, { cookie: owner.cookie })).status).toBe(200);
    const refused = async (change: Record<string, unknown>) => {
      const before = await storedSettings(owner.ownerId);
      await refusedWith(await patchSettings(change, { cookie: owner.cookie }), 400, 'out_of_bounds');
      expect(await storedSettings(owner.ownerId)).toEqual(before);
    };
    const min = LIMITS.minPaymentAtomic;
    const max = LIMITS.maxPaymentAtomic;
    const dailyMax = LIMITS.onboardingDailyLimitMaxAtomic;

    await refused({ perPaymentMaxAtomic: String(min - 1) });
    await ok({ perPaymentMaxAtomic: String(min) });
    await ok({ perPaymentMaxAtomic: String(max), dailyBudgetAtomic: String(max) });
    await refused({ perPaymentMaxAtomic: String(max + 1), dailyBudgetAtomic: String(dailyMax) });
    await refused({ dailyBudgetAtomic: String(max - 1) });
    await ok({ dailyBudgetAtomic: String(dailyMax) });
    await refused({ dailyBudgetAtomic: String(dailyMax + 1) });
    await ok({ perPaymentMaxAtomic: '300000', dailyBudgetAtomic: '300000' });
    await refused({ perPaymentMaxAtomic: '300000', dailyBudgetAtomic: '299999' });
    // Raising the maximum alone past the stored budget leaves the budget below it.
    await refused({ perPaymentMaxAtomic: '300001' });
    for (const approvalsNeeded of [0, 11, 1.5, -1]) await refused({ approvalsNeeded });
    for (const approvalsNeeded of [1, 10]) await ok({ approvalsNeeded });
    for (const distanceCutoff of [0, -0.1, 1.0001, Number.MIN_VALUE]) await refused({ distanceCutoff });
    for (const distanceCutoff of [1, 1e-6]) await ok({ distanceCutoff });

    const response = await patchSettings({ perPaymentMaxAtomic: String(min - 1) }, { cookie: owner.cookie });
    expect(await response.json()).toEqual({ error: 'out_of_bounds', message: 'The per-payment maximum must be from 0.010000 to 1.000000 USDC.' });
  });

  it('refuses a body that is not exactly the settings, with nothing changed', async () => {
    quiet();
    const owner = await signedInOwner();
    for (const sent of [
      {},
      { paused: 'yes' },
      { perPaymentMaxAtomic: 50_000 },
      { perPaymentMaxAtomic: '05000' },
      { dailyBudgetAtomic: '1e6' },
      { approvalsNeeded: '3' },
      { clearAutoPause: false },
      { autoPausedReason: null },
      { paused: true, ownerId: MISSING_ID },
      { publicProof: 'yes' },
      { publicProof: null },
    ]) {
      await refusedWith(await patchSettings(sent, { cookie: owner.cookie }), 400, 'bad_body');
    }
    expect(await storedSettings(owner.ownerId)).toEqual({ ...DEFAULTS, perPaymentMaxAtomic: 50_000n, dailyBudgetAtomic: 500_000n });
  });

  it("turns this owner's place on the public proof on and off, starting off, and touches no other owner", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    expect((await storedSettings(owner.ownerId)).publicProof).toBe(false);
    expect(await json<SettingsBody>(await patchSettings({ publicProof: true }, { cookie: owner.cookie }))).toEqual({ ...DEFAULTS, publicProof: true });
    expect((await storedSettings(owner.ownerId)).publicProof).toBe(true);
    expect((await storedSettings(other.ownerId)).publicProof).toBe(false);
    expect((await json<SettingsBody>(await patchSettings({ paused: true }, { cookie: owner.cookie }))).publicProof).toBe(true);
    expect((await json<SettingsBody>(await patchSettings({ publicProof: false }, { cookie: owner.cookie }))).publicProof).toBe(false);
    expect((await storedSettings(owner.ownerId)).publicProof).toBe(false);
  });

  it('clears an auto pause only when clearAutoPause is sent', async () => {
    const owner = await signedInOwner();
    await db.update(owners).set({ autoPausedReason: 'A payment landed that was not the one approved.' }).where(eq(owners.id, owner.ownerId));
    for (const change of [{ paused: false }, { paused: true }, { paused: false, approvalsNeeded: 3 }]) {
      expect((await json<SettingsBody>(await patchSettings(change, { cookie: owner.cookie }))).autoPausedReason).toBe('A payment landed that was not the one approved.');
    }
    const cleared = await json<SettingsBody>(await patchSettings({ clearAutoPause: true }, { cookie: owner.cookie }));
    expect(cleared).toMatchObject({ autoPausedReason: null, paused: false, approvalsNeeded: 3 });
    expect((await storedSettings(owner.ownerId)).autoPausedReason).toBeNull();
  });
});

describe('the session and origin requirements', () => {
  const routes: Array<[string, (cookie?: string) => Promise<Response>]> = [
    ['decisions', (cookie) => listDecisions(cookie)],
    ['memories', (cookie) => listMemories(cookie)],
    ['agents list', (cookie) => listAgents(cookie)],
    ['agents create', (cookie) => createAgent({ label: 'x' }, cookie === undefined ? {} : { cookie })],
    ['agents revoke', (cookie) => revoke(MISSING_ID, cookie === undefined ? {} : { cookie })],
    ['onboarding', (cookie) => onboarding(cookie)],
    ['onboarding build', (cookie) => build({ step: 'memory_account' }, cookie === undefined ? {} : { cookie })],
    ['onboarding confirm', (cookie) => confirm({ step: 'memory_account', digest: DIGEST }, cookie === undefined ? {} : { cookie })],
    ['settings', (cookie) => patchSettings({ paused: true }, cookie === undefined ? {} : { cookie })],
    ['settings public proof', (cookie) => patchSettings({ publicProof: true }, cookie === undefined ? {} : { cookie })],
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
    expect(vi.mocked(buildOnboardingTx)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmOnboardingTx)).not.toHaveBeenCalled();
  });

  const changing: Array<[string, (options: SendOptions, agentId: string) => Promise<Response>]> = [
    ['agents create', (options) => createAgent({ label: 'From elsewhere' }, options)],
    ['agents revoke', (options, agentId) => revoke(agentId, options)],
    ['onboarding build', (options) => build({ step: 'memory_account' }, options)],
    ['onboarding confirm', (options) => confirm({ step: 'memory_account', digest: DIGEST }, options)],
    ['settings', (options) => patchSettings({ paused: true }, options)],
    ['settings public proof', (options) => patchSettings({ publicProof: true }, options)],
  ];

  it.each(changing)('%s is 403 cross_origin from another site or with no Origin, changing nothing', async (_name, run) => {
    quiet();
    const owner = await signedInOwner();
    const { agentId, token } = await json<{ agentId: string; token: string }>(await createAgent({ label: 'Mine' }, { cookie: owner.cookie }));
    const before = await storedSettings(owner.ownerId);
    for (const origin of ['https://evil.example', 'https://ellai.example.evil.example', 'null', null]) {
      const response = await run({ cookie: owner.cookie, origin }, agentId);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'cross_origin' });
    }
    expect(await storedSettings(owner.ownerId)).toEqual(before);
    expect((await agentList(owner.cookie)).map((a) => [a.agentId, a.revokedAt])).toEqual([[agentId, null]]);
    expect(await authenticateAgent({ db, token, sessionSecretHex: SECRET })).not.toBeNull();
    expect(vi.mocked(buildOnboardingTx)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmOnboardingTx)).not.toHaveBeenCalled();
  });
});

describe('error answers', () => {
  const ROUTES = ['decisions', 'memories', 'agents', 'agents/[id]', 'onboarding', 'onboarding/build', 'onboarding/confirm', 'settings', 'overview'];

  it('come from the one table in errors.ts: no owner route, nor the helpers they share, writes an error body by hand', async () => {
    const files = [...ROUTES.map((route) => `../src/app/api/owner/${route}/route.ts`), '../src/server/http/owner-limits.ts'];
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect([file, source.match(/\berror\s*:\s*['"`]/)?.[0] ?? null]).toEqual([file, null]);
    }
  });

  it("answer each refusal with exactly the status, code and text errors.ts holds for it", async () => {
    quiet();
    const owner = await signedInOwner();
    const table = (status: number, code: HttpErrorCode) => ({ status, body: { error: code, message: new HttpError(status, code).message } });
    const seen = async (response: Response) => ({ status: response.status, body: (await response.json()) as { error: string; message: string } });

    expect(await seen(await listDecisions(owner.cookie, '?limit=0'))).toEqual(table(400, 'bad_query'));
    expect(await seen(await listMemories(owner.cookie, '?before=yesterday'))).toEqual(table(400, 'bad_query'));
    vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(new MemoryError('DELEGATE', MARKER));
    expect(await seen(await build({ step: 'memory_account' }, { cookie: owner.cookie }))).toEqual(table(422, 'chain_refused'));
    vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(new ChainError('TIMEOUT', MARKER, true));
    expect(await seen(await build({ step: 'memory_account' }, { cookie: owner.cookie }))).toEqual(table(503, 'chain_unavailable'));

    const bound = await seen(await patchSettings({ approvalsNeeded: 11 }, { cookie: owner.cookie }));
    expect(bound).toEqual({ status: 400, body: { error: 'out_of_bounds', message: 'Approvals needed must be a whole number from 1 to 10.' } });
    expect(new HttpError(400, 'out_of_bounds', bound.body.message).message).toBe(bound.body.message);
  });
});

describe('the per-owner limit on routes that read Sui', () => {
  it('turns away the 31st overview, build or confirm call in one minute for one owner with 429, others and the next minute untouched', async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    vi.mocked(buildCreateAccountTx).mockResolvedValue(ACCOUNT_BYTES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(LIMITS.ownerChainReadsPerMinute).toBe(30);
    for (let i = 0; i < 15; i += 1) expect((await overview(owner.cookie)).status).toBe(200);
    for (let i = 0; i < 15; i += 1) expect((await build({ step: 'memory_account' }, { cookie: owner.cookie })).status).toBe(200);

    const balanceReads = getBalances.mock.calls.length;
    const builds = vi.mocked(buildOnboardingTx).mock.calls.length;
    for (const refused of [await overview(owner.cookie), await build({ step: 'memory_account' }, { cookie: owner.cookie }), await confirm({ step: 'memory_account', digest: DIGEST }, { cookie: owner.cookie })]) {
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: 'too_many_requests', message: 'Too many requests. Try again in a minute.' });
    }
    expect(getBalances.mock.calls.length).toBe(balanceReads);
    expect(vi.mocked(buildOnboardingTx).mock.calls.length).toBe(builds);
    expect(getTransactionResult).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call.join(' '))).toEqual(Array(3).fill('[ellai http] owner_chain too_many_requests'));

    // Reads that touch no chain are not counted against it.
    expect((await onboarding(owner.cookie)).status).toBe(200);
    expect((await listDecisions(owner.cookie)).status).toBe(200);
    expect((await overview(other.cookie)).status).toBe(200);
    clock = new Date(clock.getTime() + 60_000);
    expect((await overview(owner.cookie)).status).toBe(200);
  });
});
