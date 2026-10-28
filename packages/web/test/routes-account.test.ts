// Covers: the owner's account routes called as Next would call them, with Request objects, on
// PGlite with a stub chain: the session requirement on every one and same origin on every one
// that changes state; decision and memory history holding only the owner's own rows, newest
// first, paged by before and limit without losing or repeating rows that share a millisecond;
// agent tokens shown once and never again, revoking one stopping it, at most five made an hour by
// one session and ten by one owner, twenty held at once, each made and each loosening setting changed with a step-up
// the owner's wallet signed (step-up.test covers which changes need one and every refusal of it),
// the step-up route held to the session and the app's origin like the rest; signing out
// everywhere ending every live session of the owner and no one else's; onboarding passing
// the owner, chain and master secret to the onboarding functions and their summaries and
// refusals back unchanged, a Tatum budget refusal as chain_unavailable_today; an account step Sui
// already shows done answered 409 already_done and then confirmed with no digest from what Sui
// shows; submit relaying only bytes the owner signed that are the step Ellai builds, refusing
// another sender's and another kind of transaction before sending, recording a success, and
// answering an unknown outcome 202 with the digest and a definite refusal 422; decisions saying
// what the owner answered without the memory sentence; the wallet route reading the session owner's
// own address, split into address balance and coins, counted at one chain call; the USDC move built
// and relayed only as Ellai builds it from the coins Sui lists for the owner, refusing another
// recipient, another coin type and a third party's coins before sending and answering
// nothing_to_move and not_enough_sui; a fee paid with the owner's SUI coins relayed only while Sui
// still shows those coins as the owner's; settings read with no chain call;
// settings held to their bounds at each edge, the auto pause cleared
// only on request, the public proof opt-in starting off and switched for the signed-in owner
// only; and the limits the routes that read Sui share: per owner a minute and a day, and for
// every owner a day, with the overview counted only for an owner with an allowance.
// Does NOT cover: a real chain or wallet (the chain is stubbed and core's Walrus Memory builders
// are stand-ins; onboarding.test and prove:onboarding cover those), a real wallet's signature
// being accepted by Sui (submit's signatures are made with a test key and the send is a stand-in),
// two database connections
// racing a settings change against signing (PGlite serves one connection, so the FOR UPDATE
// lock is not raced here), or how a page renders agent text (no pages exist yet).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildIssueAllowance, buildUsdcToAddress } from '@ellai/core/allowance';
import { type Chain, ChainError, type OwnedCoin } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { buildAddDelegateTx, buildCreateAccountTx, findMemoryAccount, MemoryError, WALRUS_MEMORY_PACKAGE_ID, WALRUS_MEMORY_REGISTRY_ID } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import type { Signer } from '@mysten/sui/cryptography';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase58, toBase64 } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentRoute from '../src/app/api/owner/agents/[id]/route.js';
import * as agentsRoute from '../src/app/api/owner/agents/route.js';
import * as decisionsRoute from '../src/app/api/owner/decisions/route.js';
import * as memoriesRoute from '../src/app/api/owner/memories/route.js';
import * as buildRoute from '../src/app/api/owner/onboarding/build/route.js';
import * as confirmRoute from '../src/app/api/owner/onboarding/confirm/route.js';
import * as onboardingRoute from '../src/app/api/owner/onboarding/route.js';
import * as submitRoute from '../src/app/api/owner/onboarding/submit/route.js';
import * as walletRoute from '../src/app/api/owner/onboarding/wallet/route.js';
import * as overviewRoute from '../src/app/api/owner/overview/route.js';
import * as sessionsRoute from '../src/app/api/owner/sessions/route.js';
import * as settingsRoute from '../src/app/api/owner/settings/route.js';
import * as stepUpRoute from '../src/app/api/owner/step-up/route.js';
import { authenticateAgent } from '../src/server/auth/agents.js';
import { endSession } from '../src/server/auth/sessions.js';
import { completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { hashBearerToken } from '../src/server/auth/tokens.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisionCitations, decisions, memories, owners, payments, sessions } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { type ServerContextFactory, setServerContextFactory } from '../src/server/http/context.js';
import { HttpError, type HttpErrorCode } from '../src/server/http/errors.js';
import { limitOwnerChainCalls } from '../src/server/http/owner-limits.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { BUILD_CHAIN_CALLS, buildOnboardingTx } from '../src/server/onboarding/build.js';
import { CONFIRM_CHAIN_CALLS, CONFIRM_EXISTING_CHAIN_CALLS, confirmOnboardingTx } from '../src/server/onboarding/confirm.js';
import { WALLET_CHAIN_CALLS } from '../src/server/onboarding/funds.js';
import { ALREADY_DONE_MESSAGE } from '../src/server/onboarding/state.js';
import { SUBMIT_CHAIN_CALLS, submitOnboardingTx } from '../src/server/onboarding/submit.js';

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
vi.mock('../src/server/onboarding/submit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/onboarding/submit.js')>();
  return { ...real, submitOnboardingTx: vi.fn(real.submitOnboardingTx) };
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
// Submit's send and its read of the allowance it created.
const executeTransaction = vi.fn<Chain['executeTransaction']>();
const getAllowance = vi.fn<Chain['getAllowance']>();
// The owner's wallet, as the fee choice, the wallet route and the USDC move read it.
const getWalletBalances = vi.fn<Chain['getWalletBalances']>();
const listUsdcCoins = vi.fn<Chain['listUsdcCoins']>();
const listSuiCoins = vi.fn<Chain['listSuiCoins']>();
const chain = {
  usesApiKey: true,
  getBalances,
  getWalletBalances,
  listUsdcCoins,
  listSuiCoins,
  getTransactionResult,
  getCurrentEpoch: async () => 900n,
  getReferenceGasPrice: async () => 100n,
  executeTransaction,
  getAllowance,
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
  executeTransaction.mockReset();
  getAllowance.mockReset();
  // One SUI in the address balance and no coins of either kind, unless a test says otherwise.
  getWalletBalances.mockReset();
  getWalletBalances.mockResolvedValue({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiAddressBalance: 1_000_000_000n, suiCoinBalance: 0n });
  listUsdcCoins.mockReset();
  listUsdcCoins.mockResolvedValue({ coins: [], more: false });
  listSuiCoins.mockReset();
  listSuiCoins.mockResolvedValue({ coins: [], more: false });
  vi.mocked(findMemoryAccount).mockReset();
  // Sui shows no account unless a test says otherwise, so a build goes on to core's builder.
  vi.mocked(findMemoryAccount).mockResolvedValue(null);
  vi.mocked(buildCreateAccountTx).mockReset();
  vi.mocked(buildAddDelegateTx).mockReset();
  vi.mocked(buildOnboardingTx).mockClear();
  vi.mocked(confirmOnboardingTx).mockClear();
  vi.mocked(submitOnboardingTx).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  signer: Signer;
}

async function sign(signer: Signer, message: string): Promise<string> {
  return (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
}

async function signedInOwner(signer: Signer = Ed25519Keypair.generate()): Promise<Owner> {
  const { message } = await issueSignIn({ db, address: signer.toSuiAddress(), appOrigin: APP_ORIGIN, now: clock });
  const done = await completeSignIn({ db, message, signature: await sign(signer, message), appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now: clock });
  const row = one(await db.select({ suiAddress: owners.suiAddress }).from(owners).where(eq(owners.id, done.ownerId)));
  return { ownerId: done.ownerId, address: row.suiAddress, cookie: `__Host-ellai_session=${done.sessionToken}`, signer };
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
const submit = (body: unknown, options: SendOptions = {}) => submitRoute.POST(send('POST', '/api/owner/onboarding/submit', body, options));
const wallet = (cookie?: string) => walletRoute.GET(get('/api/owner/onboarding/wallet', cookie));
const getSettings = (cookie?: string, query = '') => settingsRoute.GET(get(`/api/owner/settings${query}`, cookie));
const patchSettings = (body: unknown, options: SendOptions = {}) => settingsRoute.PATCH(send('PATCH', '/api/owner/settings', body, options));
const askStepUp = (body: unknown, options: SendOptions = {}) => stepUpRoute.POST(send('POST', '/api/owner/step-up', body, options));
const signOutEverywhere = (options: SendOptions = {}) => sessionsRoute.DELETE(send('DELETE', '/api/owner/sessions', undefined, options));
const overview = (cookie?: string) => overviewRoute.GET(get('/api/owner/overview', cookie));

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

/** Asks for a step-up for exactly this change and signs its message with the owner's wallet, as the app does. */
async function stepUpFor(owner: Owner, action: string, change: Record<string, unknown>): Promise<{ nonce: string; signature: string }> {
  const asked = await askStepUp({ action, change }, { cookie: owner.cookie });
  expect(asked.status).toBe(200);
  const { nonce, message } = (await asked.json()) as { nonce: string; message: string };
  return { nonce, signature: await sign(owner.signer, message) };
}

const createSigned = async (owner: Owner, label: string) => createAgent({ label, stepUp: await stepUpFor(owner, 'create_agent', { label }) }, { cookie: owner.cookie });

/**
 * Sends a settings change as the app does: on its own, and when the route answers
 * step_up_required, again with a step-up the owner's wallet signed for exactly that change.
 */
async function changeSettings(owner: Owner, change: Record<string, unknown>): Promise<Response> {
  const plain = await patchSettings(change, { cookie: owner.cookie });
  if (plain.status !== 403 || ((await plain.clone().json()) as { error: string }).error !== 'step_up_required') return plain;
  return patchSettings({ ...change, stepUp: await stepUpFor(owner, 'loosen_settings', change) }, { cookie: owner.cookie });
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
  answer: 'approve' | 'refuse' | null;
  answeredAt: string | null;
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
    ['onboarding/submit', submitRoute],
    ['onboarding/wallet', walletRoute],
    ['settings', settingsRoute],
    ['step-up', stepUpRoute],
    ['sessions', sessionsRoute],
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
      answer: null,
      answeredAt: null,
      citedMemories: [{ memoryId, blobId }],
      paid: { digest: DIGEST, settlement: 'verified', explorerUrl: `https://suiscan.xyz/mainnet/tx/${DIGEST}` },
    });
    expect(listed[1]).toMatchObject({ decisionId: older, outcome: 'asked', status: 'expired', citedMemories: [], paid: null });

    const theirList = await json<{ decisions: DecisionItem[] }>(await listDecisions(other.cookie));
    expect(theirList.decisions.map((d) => d.decisionId)).toEqual([theirs]);
  });

  it("says what the owner answered and when, from the owner_decision memory for that decision, and never its sentence (C17)", async () => {
    const owner = await signedInOwner();
    const agentId = await agentFor(owner.ownerId);
    const asked = { outcome: 'asked' as const, rule: 'no_match' as const, status: 'answered' as const };
    const refused = await insertDecision(owner.ownerId, agentId, { ...asked, createdAt: ago(3 * DAY_MS) });
    const approved = await insertDecision(owner.ownerId, agentId, { ...asked, createdAt: ago(2 * DAY_MS) });
    const byRule = await insertDecision(owner.ownerId, agentId, { createdAt: ago(DAY_MS) });
    const refusedAt = ago(3 * DAY_MS - 60_000);
    const approvedAt = ago(2 * DAY_MS - 60_000);
    await insertMemory(owner.ownerId, { decisionId: refused, verdict: 'refuse', sentence: `Reason: "${MARKER}"`, createdAt: refusedAt });
    await insertMemory(owner.ownerId, { decisionId: approved, verdict: 'approve', sentence: MARKER, createdAt: approvedAt });
    // An outcome memory names a decision too, but it is Ellai's note on the seller, not an answer.
    await insertMemory(owner.ownerId, { kind: 'outcome', decisionId: byRule, verdict: null, sentence: MARKER, createdAt: ago(60_000) });

    const response = await listDecisions(owner.cookie);
    const text = await response.clone().text();
    const { decisions: listed } = await json<{ decisions: DecisionItem[] }>(response);
    expect(listed.map((d) => [d.decisionId, d.status, d.answer, d.answeredAt])).toEqual([
      [byRule, 'paid', null, null],
      [approved, 'answered', 'approve', approvedAt.toISOString()],
      [refused, 'answered', 'refuse', refusedAt.toISOString()],
    ]);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('sentence');
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
    const created = await createSigned(owner, '  Trip planner  ');
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
    const first = await json<{ agentId: string }>(await createSigned(owner, 'First'));
    clock = new Date(clock.getTime() + 1_000);
    const second = await json<{ agentId: string }>(await createSigned(owner, 'Second'));
    await createSigned(other, 'Theirs');
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
    // Each from a session of its own, as one session may try only five creates an hour.
    for (const [sent, status, code] of cases) await refusedWith(await createAgent(sent, { cookie: (await signedInOwner(owner.signer)).cookie }), status, code);
    expect(await agentList(owner.cookie)).toEqual([]);
    const longest = await json<{ agentId: string }>(await createSigned(owner, '\u{1F600}'.repeat(60)));
    expect((await agentList(owner.cookie)).map((a) => a.agentId)).toEqual([longest.agentId]);
  });

  it('turns away the 6th create in one hour from one session and the 11th for one owner with 429, others and the next hour untouched (C22, C36)', async () => {
    quiet();
    const owner = await signedInOwner();
    const second = await signedInOwner(owner.signer);
    const third = await signedInOwner(owner.signer);
    const other = await signedInOwner();
    expect([LIMITS.agentCreatesPerSessionPerHour, LIMITS.agentCreatesPerHour]).toEqual([5, 10]);
    const tooMany = async (response: Response) => {
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'too_many_agent_creates', message: new HttpError(429, 'too_many_agent_creates').message });
    };
    // The first call is a bad body: it is counted before the body is read.
    await refusedWith(await createAgent({}, { cookie: owner.cookie }), 400, 'bad_body');
    for (let i = 2; i <= 5; i += 1) expect((await createSigned(owner, `Agent ${i}`)).status).toBe(200);
    // A session past its own hour is turned away without spending the owner's.
    await tooMany(await createSigned(owner, 'Sixth from one session'));
    await tooMany(await createSigned(owner, 'Seventh from one session'));
    for (let i = 6; i <= 10; i += 1) expect((await createSigned(second, `Agent ${i}`)).status).toBe(200);
    await tooMany(await createSigned(third, 'One more'));
    expect(await agentList(owner.cookie)).toHaveLength(9);

    expect((await createSigned(other, 'Theirs')).status).toBe(200);
    clock = new Date(Math.floor(clock.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    expect((await createSigned(owner, 'Next hour')).status).toBe(200);
  });

  it('refuses a 21st live agent with 409 too_many_agents, and takes one again after a revoke', async () => {
    quiet();
    const owner = await signedInOwner();
    const held = [];
    for (let i = 0; i < LIMITS.agentsPerOwnerMax; i += 1) held.push(await agentFor(owner.ownerId, `Agent ${i + 1}`));
    const refused = await createSigned(owner, 'Agent 21');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'too_many_agents', message: 'an owner may hold at most 20 agents at once; revoke one first' });
    expect(await json(await revoke(held[0] ?? '', { cookie: owner.cookie }))).toEqual({ revoked: true });
    expect((await createSigned(owner, 'Agent 21')).status).toBe(200);
  });
});

describe('DELETE /api/owner/agents/[id]', () => {
  it('stops the token at once, and shows when in the list', async () => {
    const owner = await signedInOwner();
    const { agentId, token } = await json<{ agentId: string; token: string }>(await createSigned(owner, 'Trip planner'));
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
    const { agentId, token } = await json<{ agentId: string; token: string }>(await createSigned(theirs, 'Theirs'));
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
    expect(await refused.json()).toEqual({ error: 'chain_refused', message: 'Sui refused this setup transaction. Nothing changed; try again in a minute.' });
    for (const failure of [new MemoryError('TIMEOUT', MARKER), new ChainError('UPSTREAM', MARKER, true)]) {
      vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(failure);
      const unavailable = await build({ step: 'memory_account' }, { cookie: owner.cookie });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.text()).toBe('{"error":"chain_unavailable","message":"Ellai could not read Sui just now. Try again in a minute."}');
    }
    // Ellai's own Tatum budget refused a request, which holds until the UTC day ends.
    vi.mocked(buildCreateAccountTx).mockRejectedValueOnce(new ChainError('BUDGET', MARKER));
    const today = await build({ step: 'memory_account' }, { cookie: owner.cookie });
    expect(today.status).toBe(503);
    expect(await today.json()).toEqual({ error: 'chain_unavailable_today', message: "Ellai has used today's budget for reading Sui. Try again tomorrow (days are counted in UTC)." });
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

const ALREADY_DONE = { error: 'already_done', message: 'This step is already done on Sui. Confirm it to continue.' };
const NOT_THIS_STEP = 'it is not the transaction Ellai builds for this step';
const ALLOWANCE_TYPE = normalizeStructTag(`0x2::allowance::Allowance<0x2::balance::Balance<${USDC_TYPE_MAINNET}>>`);

const accountRow = async (owner: Owner) =>
  one(await db.select({ memwalAccountId: owners.memwalAccountId, delegateRegisteredAt: owners.delegateRegisteredAt, allowanceId: owners.allowanceId }).from(owners).where(eq(owners.id, owner.ownerId)));
const purseOf = async (owner: Owner) => one(await db.select({ purse: owners.purseAddress }).from(owners).where(eq(owners.id, owner.ownerId))).purse;

/** Signs bytes as a wallet does, giving the two fields submit takes besides the step. */
async function signedBy(signer: Signer, bytes: Uint8Array): Promise<{ txBytesBase64: string; signature: string }> {
  return { txBytesBase64: toBase64(bytes), signature: (await signer.signTransaction(bytes)).signature };
}

/** An allowance as buildIssueAllowance makes it for this owner and purse, or with one of these changed. */
async function allowanceBytes(owner: Owner, change: { sender?: string; spender?: string; lifetimeCapAtomic?: bigint } = {}): Promise<Uint8Array> {
  const terms = { lifetimeCapAtomic: change.lifetimeCapAtomic ?? 1_000_000n, periodMs: BigInt(LIMITS.allowancePeriodMs), periodLimitAtomic: 500_000n, expirationMs: BigInt(clock.getTime() + 30 * DAY_MS) };
  return buildIssueAllowance({ owner: change.sender ?? owner.address, spender: change.spender ?? (await purseOf(owner)), terms }, { epoch: 900n, referenceGasPrice: 100n, nonce: 7 });
}

/** A create_account call as core's builder hands it over once Tatum has resolved it, built offline with one gas coin. */
async function createAccountBytes(sender: string, options: { gasVersion?: number; budget?: number } = {}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${WALRUS_MEMORY_PACKAGE_ID}::account::create_account`,
    arguments: [tx.sharedObjectRef({ objectId: WALRUS_MEMORY_REGISTRY_ID, initialSharedVersion: '1', mutable: true }), tx.object.clock()],
  });
  tx.setGasOwner(sender);
  tx.setGasPrice(100);
  tx.setGasBudget(options.budget ?? 5_000_000);
  tx.setGasPayment([{ objectId: `0x${'ab'.repeat(32)}`, version: String(options.gasVersion ?? 1), digest: DIGEST }]);
  return tx.build();
}

function allowanceOnChain(owner: Owner, purse: string) {
  const expirationMs = BigInt(clock.getTime() + 30 * DAY_MS);
  return { funder: owner.address, spender: purse, coinType: USDC_TYPE_MAINNET, lifetimeCap: 1_000_000n, spentTotal: 0n, periodMs: BigInt(LIMITS.allowancePeriodMs), periodLimit: 500_000n, expirationMs, initialSharedVersion: 1n, periodSpent: null, periodEndMs: null };
}

describe('an account step Sui already shows done', () => {
  it("is answered 409 already_done at build, building nothing, for the account and for Ellai's key on the recorded account", async () => {
    clock = new Date(Date.UTC(2031, 4, 1, 10));
    const owner = await signedInOwner();
    const accountId = address();
    const delegateHex = ownerDelegate(MASTER, owner.address).publicKeyHex;
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [] });
    vi.mocked(buildAddDelegateTx).mockResolvedValue(ACCOUNT_BYTES);
    const done = await build({ step: 'memory_account' }, { cookie: owner.cookie });
    expect([done.status, await done.json()]).toEqual([409, ALREADY_DONE]);
    expect(ALREADY_DONE.message).toBe(ALREADY_DONE_MESSAGE);
    expect(vi.mocked(findMemoryAccount)).toHaveBeenCalledWith(chain, owner.address);
    expect(vi.mocked(buildCreateAccountTx)).not.toHaveBeenCalled();

    await db.update(owners).set({ memwalAccountId: accountId }).where(eq(owners.id, owner.ownerId));
    // Another owner's derived key, or Ellai's key on an account other than the recorded one, is not this step done.
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [ownerDelegate(MASTER, address()).publicKeyHex] });
    expect((await build({ step: 'add_delegate' }, { cookie: owner.cookie })).status).toBe(200);
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId: address(), delegates: [delegateHex] });
    expect((await build({ step: 'add_delegate' }, { cookie: owner.cookie })).status).toBe(200);
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [delegateHex] });
    const keyDone = await build({ step: 'add_delegate' }, { cookie: owner.cookie });
    expect([keyDone.status, await keyDone.json()]).toEqual([409, ALREADY_DONE]);
    expect(vi.mocked(buildAddDelegateTx)).toHaveBeenCalledTimes(2);
  });

  it("is recorded from { step, existing: true } by what Sui shows for the owner's address, reading no transaction", async () => {
    clock = new Date(Date.UTC(2031, 4, 2, 10));
    const owner = await signedInOwner();
    const accountId = address();
    const delegateHex = ownerDelegate(MASTER, owner.address).publicKeyHex;
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [delegateHex] });
    await refusedWith(await confirm({ step: 'add_delegate', existing: true }, { cookie: owner.cookie }), 409, 'not_ready');
    expect(await json(await confirm({ step: 'memory_account', existing: true }, { cookie: owner.cookie }))).toEqual({ recorded: accountId });
    expect(await json(await confirm({ step: 'add_delegate', existing: true }, { cookie: owner.cookie }))).toEqual({ recorded: delegateHex });
    // Again, the same values.
    expect(await json(await confirm({ step: 'memory_account', existing: true }, { cookie: owner.cookie }))).toEqual({ recorded: accountId });
    expect(vi.mocked(findMemoryAccount).mock.calls.every(([used, ownerAddress]) => used === chain && ownerAddress === owner.address)).toBe(true);
    expect(getTransactionResult).not.toHaveBeenCalled();
    expect(vi.mocked(confirmOnboardingTx)).not.toHaveBeenCalled();
    expect(await accountRow(owner)).toEqual({ memwalAccountId: accountId, delegateRegisteredAt: clock, allowanceId: null });
    expect(await json(await onboarding(owner.cookie))).toMatchObject({ memoryAccount: 'present', delegate: 'present', allowance: 'missing' });
  });

  it('refuses an existing confirm Sui does not back, or one carrying anything but the step, recording nothing (C7)', async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 3, 10));
    const owner = await signedInOwner();
    for (const sent of [
      { step: 'allowance', existing: true },
      { step: 'memory_account', existing: false },
      { step: 'memory_account', existing: 'true' },
      { step: 'memory_account', existing: true, digest: DIGEST },
      { step: 'memory_account', existing: true, accountId: address() },
    ]) {
      await refusedWith(await confirm(sent, { cookie: owner.cookie }), 400, 'bad_body');
    }
    vi.mocked(findMemoryAccount).mockResolvedValue(null);
    const none = await confirm({ step: 'memory_account', existing: true }, { cookie: owner.cookie });
    expect([none.status, await none.json()]).toEqual([422, { error: 'refused', message: 'Sui shows no Walrus Memory account for this owner' }]);
    vi.mocked(findMemoryAccount).mockRejectedValue(new MemoryError('ACCOUNT', 'the Walrus Memory account belongs to another owner'));
    await refusedWith(await confirm({ step: 'memory_account', existing: true }, { cookie: owner.cookie }), 422, 'refused');
    expect(await accountRow(owner)).toEqual({ memwalAccountId: null, delegateRegisteredAt: null, allowanceId: null });
  });
});

describe('POST /api/owner/onboarding/submit', () => {
  it("sends an allowance the owner signed exactly as the build route made it, through the context's chain, and records it from the result", async () => {
    clock = new Date(Date.UTC(2031, 4, 4, 10));
    const owner = await signedInOwner();
    const built = await json<{ txBytesBase64: string }>(
      await build({ step: 'allowance', allowance: { dailyLimitAtomic: '500000', lifetimeCapAtomic: '1000000', days: 30 } }, { cookie: owner.cookie }),
    );
    const bytes = fromBase64(built.txBytesBase64);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    const allowanceId = address();
    executeTransaction.mockResolvedValue({ digest, status: 'success', errorCode: null, balanceChanges: [], createdObjects: [{ objectId: allowanceId, type: ALLOWANCE_TYPE }] });
    getAllowance.mockResolvedValue(allowanceOnChain(owner, await purseOf(owner)));
    const sent = await signedBy(owner.signer, bytes);

    expect(await json(await submit({ step: 'allowance', ...sent }, { cookie: owner.cookie }))).toEqual({ recorded: allowanceId, digest });
    expect(vi.mocked(submitOnboardingTx).mock.calls[0]?.[0]).toMatchObject({ ownerId: owner.ownerId, step: 'allowance', chain, masterSecretHex: MASTER, now: clock });
    expect(executeTransaction.mock.calls).toEqual([[bytes, [sent.signature]]]);
    expect(getAllowance.mock.calls).toEqual([[allowanceId]]);
    expect(await accountRow(owner)).toMatchObject({ allowanceId });
    expect(await json(await onboarding(owner.cookie))).toMatchObject({ allowance: 'present' });
  });

  it('sends an account step only when it makes the same call on the same inputs as a fresh build, and records the account Sui then shows', async () => {
    clock = new Date(Date.UTC(2031, 4, 5, 10));
    const owner = await signedInOwner();
    const accountId = address();
    const signedBytes = await createAccountBytes(owner.address, { gasVersion: 1 });
    // Tatum picks the gas again for the fresh build, so only the call and its inputs can match.
    vi.mocked(buildCreateAccountTx).mockResolvedValue(await createAccountBytes(owner.address, { gasVersion: 2 }));
    vi.mocked(findMemoryAccount).mockResolvedValueOnce(null).mockResolvedValue({ accountId, delegates: [] });
    const digest = TransactionDataBuilder.getDigestFromBytes(signedBytes);
    executeTransaction.mockResolvedValue({ digest, status: 'success', errorCode: null, balanceChanges: [], createdObjects: [] });
    const sent = await signedBy(owner.signer, signedBytes);

    expect(await json(await submit({ step: 'memory_account', ...sent }, { cookie: owner.cookie }))).toEqual({ recorded: accountId, digest });
    expect(executeTransaction.mock.calls).toEqual([[signedBytes, [sent.signature]]]);
    expect(await accountRow(owner)).toMatchObject({ memwalAccountId: accountId });
    // Sui now shows the account, so the same bytes again are refused before anything is sent.
    await refusedWith(await submit({ step: 'memory_account', ...sent }, { cookie: owner.cookie }), 409, 'already_done');
    expect(executeTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses another sender's bytes, another kind of transaction and an allowance Ellai would not build with 400 bad_transaction, sending nothing (C6, C7)", async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 6, 10));
    const owner = await signedInOwner();
    const stranger = Ed25519Keypair.generate();
    const strangerAddress = normalizeSuiAddress(stranger.toSuiAddress());
    vi.mocked(buildCreateAccountTx).mockResolvedValue(await createAccountBytes(owner.address));
    const allowance = await allowanceBytes(owner);
    const cases: Array<[string, { txBytesBase64: string; signature: string }, string]> = [
      ['allowance', await signedBy(stranger, await allowanceBytes(owner, { sender: strangerAddress })), 'the transaction is not sent from your own address'],
      ['memory_account', await signedBy(stranger, await createAccountBytes(strangerAddress)), 'the transaction is not sent from your own address'],
      ['memory_account', await signedBy(owner.signer, allowance), NOT_THIS_STEP],
      ['allowance', await signedBy(owner.signer, await createAccountBytes(owner.address)), NOT_THIS_STEP],
      ['allowance', await signedBy(owner.signer, await allowanceBytes(owner, { spender: address() })), NOT_THIS_STEP],
      ['allowance', await signedBy(owner.signer, await allowanceBytes(owner, { lifetimeCapAtomic: BigInt(LIMITS.onboardingLifetimeCapMaxAtomic) + 1n })), 'the total cap is missing or over the onboarding maximum'],
      ['memory_account', await signedBy(owner.signer, await createAccountBytes(owner.address, { budget: LIMITS.memwalAccountTxMaxGasMist + 1 })), 'its gas budget is over the most Ellai builds with'],
      ['allowance', await signedBy(owner.signer, new Uint8Array([...allowance, 0])), 'the transaction bytes are not one Sui transaction'],
      ['allowance', { txBytesBase64: `${toBase64(allowance)} `, signature: 'AA==' }, 'the transaction bytes are not base64'],
    ];
    for (const [step, sent, message] of cases) {
      const response = await submit({ step, ...sent }, { cookie: owner.cookie });
      expect([step, response.status, await response.json()]).toEqual([step, 400, { error: 'bad_transaction', message }]);
    }
    const signedAllowance = await signedBy(owner.signer, allowance);
    for (const sent of [
      { step: 'allowance', txBytesBase64: signedAllowance.txBytesBase64 },
      { step: 'allowance', ...signedAllowance, digest: DIGEST },
      { step: 'allowance', txBytesBase64: '', signature: signedAllowance.signature },
      { step: 'everything', ...signedAllowance },
    ]) {
      await refusedWith(await submit(sent, { cookie: owner.cookie }), 400, 'bad_body');
    }
    expect(executeTransaction).not.toHaveBeenCalled();
    expect(await accountRow(owner)).toEqual({ memwalAccountId: null, delegateRegisteredAt: null, allowanceId: null });
  });

  it('answers 202 with the digest when the outcome is unknown or Sui does not show the result yet, and 422 chain_refused on a definite refusal, recording nothing', async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 7, 10));
    const owner = await signedInOwner();
    const bytes = await allowanceBytes(owner);
    const sent = await signedBy(owner.signer, bytes);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    const relay = async () => {
      const response = await submit({ step: 'allowance', ...sent }, { cookie: owner.cookie });
      return [response.status, await response.text()];
    };

    executeTransaction.mockRejectedValueOnce(new ChainError('TIMEOUT', `transaction ${digest} may have landed ${MARKER}`, true));
    expect(await relay()).toEqual([202, JSON.stringify({ digest })]);
    executeTransaction.mockResolvedValueOnce({ digest, status: 'success', errorCode: null, balanceChanges: [], createdObjects: [{ objectId: address(), type: ALLOWANCE_TYPE }] });
    getAllowance.mockRejectedValueOnce(new ChainError('NOT_FOUND', 'stand-in not found'));
    expect(await relay()).toEqual([202, JSON.stringify({ digest })]);
    executeTransaction.mockResolvedValueOnce({ digest, status: 'failure', errorCode: 'INSUFFICIENT_ADDRESS_BALANCE', balanceChanges: [], createdObjects: [] });
    expect(await relay()).toEqual([422, JSON.stringify({ error: 'chain_refused', message: 'Sui refused this setup transaction. Nothing changed; try again in a minute.' })]);
    // These two codes mean the bytes never left.
    executeTransaction.mockRejectedValueOnce(new ChainError('INVALID_INPUT', 'a signature is not base64'));
    expect(await relay()).toEqual([400, JSON.stringify({ error: 'bad_transaction', message: 'the signature is not one Sui can read' })]);
    executeTransaction.mockRejectedValueOnce(new ChainError('BUDGET', MARKER));
    expect(await relay()).toEqual([503, JSON.stringify({ error: 'chain_unavailable_today', message: "Ellai has used today's budget for reading Sui. Try again tomorrow (days are counted in UTC)." })]);

    expect(executeTransaction).toHaveBeenCalledTimes(5);
    expect(await accountRow(owner)).toEqual({ memwalAccountId: null, delegateRegisteredAt: null, allowanceId: null });
  });
});

describe('GET /api/owner/onboarding/wallet', () => {
  it("reads the session owner's own address, whatever the query names, and gives USDC and SUI split into address balance and coins as decimal strings", async () => {
    const owner = await signedInOwner();
    getWalletBalances.mockResolvedValue({ usdcAddressBalance: 2_830_000n, usdcCoinBalance: 9_007_199_254_740_993n, suiAddressBalance: 0n, suiCoinBalance: 51_000_000n });
    const response = await walletRoute.GET(get(`/api/owner/onboarding/wallet?address=${address()}`, owner.cookie));
    expect(await json(response)).toEqual({ usdcAddressAtomic: '2830000', usdcCoinAtomic: '9007199254740993', suiAddressMist: '0', suiCoinMist: '51000000' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getWalletBalances.mock.calls).toEqual([[owner.address]]);
    expect(getBalances).not.toHaveBeenCalled();
  });

  it("answers Tatum failing as 503 chain_unavailable and Ellai's own budget as 503 chain_unavailable_today, with fixed text", async () => {
    quiet();
    const owner = await signedInOwner();
    getWalletBalances.mockRejectedValueOnce(new ChainError('TIMEOUT', MARKER, true));
    const down = await wallet(owner.cookie);
    expect([down.status, await down.text()]).toEqual([503, '{"error":"chain_unavailable","message":"Ellai could not read Sui just now. Try again in a minute."}']);
    getWalletBalances.mockRejectedValueOnce(new ChainError('BUDGET', MARKER));
    await refusedWith(await wallet(owner.cookie), 503, 'chain_unavailable_today');
  });
});

/** A coin as listUsdcCoins and listSuiCoins give one, numbered so each is its own. */
function ownedCoin(n: number, balance: bigint): OwnedCoin {
  return { objectId: normalizeSuiAddress(`0x${n.toString(16)}`), version: BigInt(n), digest: toBase58(new Uint8Array(32).fill(n)), balance };
}

const MOVE_FACTS = { epoch: 900n, referenceGasPrice: 100n, nonce: 7 };

/** The USDC move by hand, with one thing changed: what a tampered client would hand back to be relayed. */
async function handBuiltMove(owner: Owner, coins: OwnedCoin[], change: { recipient?: string; coinType?: string } = {}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(owner.address);
  const [first, ...rest] = [...coins]
    .sort((a, b) => (a.objectId < b.objectId ? -1 : 1))
    .map((coin) => tx.objectRef({ objectId: coin.objectId, version: String(coin.version), digest: coin.digest }));
  if (first === undefined) throw new Error('a move needs a coin');
  if (rest.length > 0) tx.mergeCoins(first, rest);
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [change.coinType ?? USDC_TYPE_MAINNET], arguments: [first, tx.pure.address(change.recipient ?? owner.address)] });
  tx.setGasOwner(owner.address);
  tx.setGasPrice(MOVE_FACTS.referenceGasPrice);
  tx.setGasBudget(LIMITS.usdcMoveGasBudgetMist);
  tx.setGasPayment([]);
  tx.setExpiration({ ValidDuring: { minEpoch: '900', maxEpoch: '901', minTimestamp: null, maxTimestamp: null, chain: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S', nonce: MOVE_FACTS.nonce } });
  return tx.build();
}

describe('the USDC move through build and submit', () => {
  const MINE = [ownedCoin(0x51, 1_500_000n), ownedCoin(0x52, 250_000n)];

  it("builds the move from the coins Sui lists for the owner and relays exactly that, answering what moved and recording nothing", async () => {
    clock = new Date(Date.UTC(2031, 4, 9, 10));
    const owner = await signedInOwner();
    listUsdcCoins.mockResolvedValue({ coins: MINE, more: false });
    const built = await json<{ txBytesBase64: string; summary: unknown }>(await build({ step: 'usdc_to_address' }, { cookie: owner.cookie }));
    expect(built.summary).toEqual([
      { label: 'Action', value: 'Move your USDC into your address balance' },
      { label: 'Amount', value: '1.750000 USDC' },
      { label: 'From', value: '2 coins in your wallet' },
      { label: 'To', value: `your address balance at ${owner.address}` },
    ]);
    const bytes = fromBase64(built.txBytesBase64);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    executeTransaction.mockResolvedValue({ digest, status: 'success', errorCode: null, balanceChanges: [], createdObjects: [] });
    const sent = await signedBy(owner.signer, bytes);

    expect(await json(await submit({ step: 'usdc_to_address', ...sent }, { cookie: owner.cookie }))).toEqual({ recorded: { movedAtomic: '1750000' }, digest });
    expect(executeTransaction.mock.calls).toEqual([[bytes, [sent.signature]]]);
    expect(listUsdcCoins.mock.calls).toEqual([[owner.address], [owner.address]]);
    expect(await accountRow(owner)).toEqual({ memwalAccountId: null, delegateRegisteredAt: null, allowanceId: null });
    expect(await json(await onboarding(owner.cookie))).toMatchObject({ memoryAccount: 'missing', delegate: 'missing', allowance: 'missing' });
  });

  it("refuses another recipient, another coin type, a third party's coins and another sender with 400 bad_transaction, sending nothing (C6, C7)", async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 10, 10));
    const owner = await signedInOwner();
    const stranger = Ed25519Keypair.generate();
    listUsdcCoins.mockResolvedValue({ coins: MINE, more: false });
    const control = await buildUsdcToAddress({ owner: owner.address, coins: MINE }, MOVE_FACTS);
    expect(await handBuiltMove(owner, MINE)).toEqual(control);
    const theirs = [ownedCoin(0x61, 1_500_000n), ownedCoin(0x62, 250_000n)];
    const cases: Array<[Uint8Array, Signer, string]> = [
      [await handBuiltMove(owner, MINE, { recipient: normalizeSuiAddress(stranger.toSuiAddress()) }), owner.signer, NOT_THIS_STEP],
      [await handBuiltMove(owner, MINE, { coinType: '0x2::sui::SUI' }), owner.signer, NOT_THIS_STEP],
      [await buildUsdcToAddress({ owner: owner.address, coins: theirs }, MOVE_FACTS), owner.signer, NOT_THIS_STEP],
      [await buildUsdcToAddress({ owner: owner.address, coins: [...MINE, ...theirs] }, MOVE_FACTS), owner.signer, NOT_THIS_STEP],
      [await buildUsdcToAddress({ owner: normalizeSuiAddress(stranger.toSuiAddress()), coins: MINE }, MOVE_FACTS), stranger, 'the transaction is not sent from your own address'],
      [await allowanceBytes(owner), owner.signer, NOT_THIS_STEP],
    ];
    for (const [bytes, signer, message] of cases) {
      const response = await submit({ step: 'usdc_to_address', ...(await signedBy(signer, bytes)) }, { cookie: owner.cookie });
      expect([response.status, await response.json()]).toEqual([400, { error: 'bad_transaction', message }]);
    }
    // The move's bytes are not any of the three steps either.
    await refusedWith(await submit({ step: 'allowance', ...(await signedBy(owner.signer, control)) }, { cookie: owner.cookie }), 400, 'bad_transaction');
    await refusedWith(await confirm({ step: 'usdc_to_address', digest: DIGEST }, { cookie: owner.cookie }), 400, 'bad_body');
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('answers 409 nothing_to_move when the owner holds no USDC coins, at build and at submit, and 409 not_enough_sui when no SUI covers the fee', async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 11, 10));
    const owner = await signedInOwner();
    const nothing = await build({ step: 'usdc_to_address' }, { cookie: owner.cookie });
    expect([nothing.status, await nothing.json()]).toEqual([409, { error: 'nothing_to_move', message: 'Your wallet holds no USDC coins to move. Any USDC it has is already in its address balance.' }]);
    expect(getWalletBalances).not.toHaveBeenCalled();
    const signed = await signedBy(owner.signer, await buildUsdcToAddress({ owner: owner.address, coins: MINE }, MOVE_FACTS));
    await refusedWith(await submit({ step: 'usdc_to_address', ...signed }, { cookie: owner.cookie }), 409, 'nothing_to_move');

    listUsdcCoins.mockResolvedValue({ coins: MINE, more: false });
    getWalletBalances.mockResolvedValue({ usdcAddressBalance: 0n, usdcCoinBalance: 1_750_000n, suiAddressBalance: BigInt(LIMITS.usdcMoveGasBudgetMist) - 1n, suiCoinBalance: 1n });
    listSuiCoins.mockResolvedValue({ coins: [ownedCoin(0x71, 1n)], more: false });
    const poor = await build({ step: 'usdc_to_address' }, { cookie: owner.cookie });
    expect([poor.status, await poor.json()]).toEqual([409, { error: 'not_enough_sui', message: "Your wallet needs a little SUI to pay this transaction's fee." }]);
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('answers 202 with the digest when the outcome is unknown and 422 chain_refused with the step-neutral text on a definite refusal', async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 12, 10));
    const owner = await signedInOwner();
    listUsdcCoins.mockResolvedValue({ coins: MINE, more: false });
    const bytes = await buildUsdcToAddress({ owner: owner.address, coins: MINE }, MOVE_FACTS);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    const sent = await signedBy(owner.signer, bytes);
    executeTransaction.mockRejectedValueOnce(new ChainError('TIMEOUT', `transaction ${digest} may have landed ${MARKER}`, true));
    const unknown = await submit({ step: 'usdc_to_address', ...sent }, { cookie: owner.cookie });
    expect([unknown.status, await unknown.text()]).toEqual([202, JSON.stringify({ digest })]);
    executeTransaction.mockResolvedValueOnce({ digest, status: 'failure', errorCode: 'INSUFFICIENT_ADDRESS_BALANCE', balanceChanges: [], createdObjects: [] });
    const refused = await submit({ step: 'usdc_to_address', ...sent }, { cookie: owner.cookie });
    expect([refused.status, await refused.json()]).toEqual([422, { error: 'chain_refused', message: 'Sui refused this setup transaction. Nothing changed; try again in a minute.' }]);
  });
});

describe('a fee paid with the owner SUI coins', () => {
  const GAS = [ownedCoin(0x81, 30_000_000n), ownedCoin(0x82, 40_000_000n)];
  const budget = BigInt(LIMITS.issueGasBudgetMist);

  it("is built when the SUI address balance falls short and relayed only while Sui still shows those coins as the owner's own", async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 13, 10));
    const owner = await signedInOwner();
    getWalletBalances.mockResolvedValue({ usdcAddressBalance: 2_000_000n, usdcCoinBalance: 0n, suiAddressBalance: budget - 1n, suiCoinBalance: 70_000_000n });
    listSuiCoins.mockResolvedValue({ coins: GAS, more: false });
    const built = await json<{ txBytesBase64: string }>(
      await build({ step: 'allowance', allowance: { dailyLimitAtomic: '500000', lifetimeCapAtomic: '1000000', days: 30 } }, { cookie: owner.cookie }),
    );
    const bytes = fromBase64(built.txBytesBase64);
    const data = Transaction.from(bytes).getData();
    expect(data.gasData.payment?.map((coin) => coin.objectId)).toEqual([GAS[1]?.objectId, GAS[0]?.objectId]);
    expect(data.expiration).toEqual({ $kind: 'None', None: true });
    const sent = await signedBy(owner.signer, bytes);

    // One gas coin was spent since the build, so it is no longer the coin the bytes name.
    listSuiCoins.mockResolvedValue({ coins: [GAS[0] as OwnedCoin, { ...(GAS[1] as OwnedCoin), version: 99n }], more: false });
    const stale = await submit({ step: 'allowance', ...sent }, { cookie: owner.cookie });
    expect([stale.status, await stale.json()]).toEqual([400, { error: 'bad_transaction', message: 'the SUI coins it pays its fee with are not yours as Sui shows them now; build it again' }]);
    expect(executeTransaction).not.toHaveBeenCalled();

    listSuiCoins.mockResolvedValue({ coins: GAS, more: false });
    const allowanceId = address();
    executeTransaction.mockResolvedValue({ digest: TransactionDataBuilder.getDigestFromBytes(bytes), status: 'success', errorCode: null, balanceChanges: [], createdObjects: [{ objectId: allowanceId, type: ALLOWANCE_TYPE }] });
    getAllowance.mockResolvedValue(allowanceOnChain(owner, await purseOf(owner)));
    expect(await json(await submit({ step: 'allowance', ...sent }, { cookie: owner.cookie }))).toMatchObject({ recorded: allowanceId });
    expect(executeTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a move paid with someone else's SUI coin before sending it", async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 14, 10));
    const owner = await signedInOwner();
    const mine = [ownedCoin(0x91, 1_000_000n)];
    listUsdcCoins.mockResolvedValue({ coins: mine, more: false });
    listSuiCoins.mockResolvedValue({ coins: GAS, more: false });
    const theirGas = [ownedCoin(0x99, budget)];
    const bytes = await buildUsdcToAddress({ owner: owner.address, coins: mine }, { referenceGasPrice: 100n, gasCoins: theirGas });
    await refusedWith(await submit({ step: 'usdc_to_address', ...(await signedBy(owner.signer, bytes)) }, { cookie: owner.cookie }), 400, 'bad_transaction');
    expect(listSuiCoins.mock.calls).toEqual([[owner.address]]);
    expect(executeTransaction).not.toHaveBeenCalled();
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

describe('GET /api/owner/settings', () => {
  it("gives the session's owner's settings in the shape PATCH answers with, whatever the query names, reading no chain", async () => {
    const owner = await withAllowance(await signedInOwner());
    const other = await signedInOwner();
    await db.update(owners).set({ publicProof: true, autoPausedReason: 'settlement_mismatch', autoPausedAt: clock, approvalsNeeded: 5 }).where(eq(owners.id, other.ownerId));
    expect(await json(await getSettings(owner.cookie, `?ownerId=${other.ownerId}`))).toEqual(DEFAULTS);
    const changed = await json<SettingsBody>(await changeSettings(owner, { paused: true, perPaymentMaxAtomic: '200000', dailyBudgetAtomic: '1000000', approvalsNeeded: 3, distanceCutoff: 0.3 }));
    expect(await json(await getSettings(owner.cookie))).toEqual(changed);
    expect(await json(await getSettings(other.cookie))).toEqual({ ...DEFAULTS, publicProof: true, autoPausedReason: 'settlement_mismatch', approvalsNeeded: 5 });
    expect(getBalances).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/owner/settings', () => {
  it("changes only what is sent, on this owner's row only, and returns the settings after the change", async () => {
    const owner = await signedInOwner();
    const other = await signedInOwner();
    const changed = await json<SettingsBody>(await changeSettings(owner, { paused: true, perPaymentMaxAtomic: '200000', dailyBudgetAtomic: '1000000', approvalsNeeded: 3, distanceCutoff: 0.3 }));
    expect(changed).toEqual({ paused: true, autoPausedReason: null, perPaymentMaxAtomic: '200000', dailyBudgetAtomic: '1000000', approvalsNeeded: 3, distanceCutoff: 0.3, publicProof: false });
    expect(await storedSettings(owner.ownerId)).toEqual({ paused: true, autoPausedReason: null, perPaymentMaxAtomic: 200_000n, dailyBudgetAtomic: 1_000_000n, approvalsNeeded: 3, distanceCutoff: 0.3, publicProof: false });
    expect(await json(await patchSettings({ approvalsNeeded: 4 }, { cookie: owner.cookie }))).toEqual({ ...changed, approvalsNeeded: 4 });
    expect(await json(await changeSettings(owner, { paused: false }))).toEqual({ ...changed, approvalsNeeded: 4, paused: false });
    expect(await storedSettings(other.ownerId)).toEqual({ ...DEFAULTS, perPaymentMaxAtomic: 50_000n, dailyBudgetAtomic: 500_000n });
  });

  it('holds every bound at its edge, refusing just past it with nothing changed', async () => {
    quiet();
    const owner = await signedInOwner();
    const ok = async (change: Record<string, unknown>) => expect((await changeSettings(owner, change)).status).toBe(200);
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
    expect(await json<SettingsBody>(await changeSettings(owner, { publicProof: true }))).toEqual({ ...DEFAULTS, publicProof: true });
    expect((await storedSettings(owner.ownerId)).publicProof).toBe(true);
    expect((await storedSettings(other.ownerId)).publicProof).toBe(false);
    expect((await json<SettingsBody>(await patchSettings({ paused: true }, { cookie: owner.cookie }))).publicProof).toBe(true);
    expect((await json<SettingsBody>(await patchSettings({ publicProof: false }, { cookie: owner.cookie }))).publicProof).toBe(false);
    expect((await storedSettings(owner.ownerId)).publicProof).toBe(false);
  });

  it('clears an auto pause, its reason and its time, only when clearAutoPause is sent', async () => {
    const owner = await signedInOwner();
    await db.update(owners).set({ autoPausedReason: 'A payment landed that was not the one approved.', autoPausedAt: ago(60_000) }).where(eq(owners.id, owner.ownerId));
    for (const change of [{ paused: false }, { paused: true }, { paused: false, approvalsNeeded: 3 }]) {
      expect((await json<SettingsBody>(await changeSettings(owner, change))).autoPausedReason).toBe('A payment landed that was not the one approved.');
    }
    const cleared = await json<SettingsBody>(await changeSettings(owner, { clearAutoPause: true }));
    expect(cleared).toMatchObject({ autoPausedReason: null, paused: false, approvalsNeeded: 3 });
    expect((await storedSettings(owner.ownerId)).autoPausedReason).toBeNull();
    expect(one(await db.select({ autoPausedAt: owners.autoPausedAt }).from(owners).where(eq(owners.id, owner.ownerId))).autoPausedAt).toBeNull();
  });
});

describe('DELETE /api/owner/sessions', () => {
  const tokenOf = (owner: Owner) => owner.cookie.slice('__Host-ellai_session='.length);
  const liveSessions = async (ownerId: string) =>
    (await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.ownerId, ownerId))).filter((row) => row.revokedAt === null);

  it("ends every live session of the owner, this one included, so a second session is refused at once, and clears this cookie; another owner's stay open (C13, C14)", async () => {
    quiet();
    const owner = await signedInOwner();
    const stolen = await signedInOwner(owner.signer);
    const ended = await signedInOwner(owner.signer);
    const other = await signedInOwner();
    const endedAt = clock;
    await endSession({ db, token: tokenOf(ended), sessionSecretHex: SECRET, now: endedAt });
    expect((await listAgents(stolen.cookie)).status).toBe(200);
    clock = new Date(clock.getTime() + 1_000);

    const response = await signOutEverywhere({ cookie: owner.cookie });
    expect(response.headers.get('set-cookie')).toBe('__Host-ellai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
    expect(await json(response)).toEqual({ signedOut: true, sessionsEnded: 2 });
    for (const cookie of [stolen.cookie, owner.cookie]) await refusedWith(await listAgents(cookie), 401, 'signed_out');
    await refusedWith(await askStepUp({ action: 'create_agent', change: { label: 'Mine now' } }, { cookie: stolen.cookie }), 401, 'signed_out');
    expect(await liveSessions(owner.ownerId)).toEqual([]);
    const endedRow = one(await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.tokenHash, hashBearerToken(tokenOf(ended), SECRET) ?? '')));
    expect(endedRow.revokedAt).toEqual(endedAt);

    expect((await listAgents(other.cookie)).status).toBe(200);
    expect(await liveSessions(other.ownerId)).toHaveLength(1);
    // Signing in again with the wallet opens a fresh session as usual.
    expect((await listAgents((await signedInOwner(owner.signer)).cookie)).status).toBe(200);
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
    ['onboarding confirm existing', (cookie) => confirm({ step: 'memory_account', existing: true }, cookie === undefined ? {} : { cookie })],
    ['onboarding submit', (cookie) => submit({ step: 'allowance', txBytesBase64: 'AA==', signature: 'AA==' }, cookie === undefined ? {} : { cookie })],
    ['onboarding wallet', (cookie) => wallet(cookie)],
    ['settings read', (cookie) => getSettings(cookie)],
    ['settings', (cookie) => patchSettings({ paused: true }, cookie === undefined ? {} : { cookie })],
    ['settings public proof', (cookie) => patchSettings({ publicProof: true }, cookie === undefined ? {} : { cookie })],
    ['step-up', (cookie) => askStepUp({ action: 'loosen_settings', change: { publicProof: true } }, cookie === undefined ? {} : { cookie })],
    ['sessions', (cookie) => signOutEverywhere(cookie === undefined ? {} : { cookie })],
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
    expect(vi.mocked(submitOnboardingTx)).not.toHaveBeenCalled();
    expect(vi.mocked(findMemoryAccount)).not.toHaveBeenCalled();
    expect(getWalletBalances).not.toHaveBeenCalled();
  });

  const changing: Array<[string, (options: SendOptions, agentId: string) => Promise<Response>]> = [
    ['agents create', (options) => createAgent({ label: 'From elsewhere' }, options)],
    ['agents revoke', (options, agentId) => revoke(agentId, options)],
    ['onboarding build', (options) => build({ step: 'memory_account' }, options)],
    ['onboarding confirm', (options) => confirm({ step: 'memory_account', digest: DIGEST }, options)],
    ['onboarding confirm existing', (options) => confirm({ step: 'memory_account', existing: true }, options)],
    ['onboarding submit', (options) => submit({ step: 'allowance', txBytesBase64: 'AA==', signature: 'AA==' }, options)],
    ['onboarding move build', (options) => build({ step: 'usdc_to_address' }, options)],
    ['onboarding move submit', (options) => submit({ step: 'usdc_to_address', txBytesBase64: 'AA==', signature: 'AA==' }, options)],
    ['settings', (options) => patchSettings({ paused: true }, options)],
    ['settings public proof', (options) => patchSettings({ publicProof: true }, options)],
    ['step-up', (options) => askStepUp({ action: 'create_agent', change: { label: 'From elsewhere' } }, options)],
    ['sessions', (options) => signOutEverywhere(options)],
  ];

  it.each(changing)('%s is 403 cross_origin from another site or with no Origin, changing nothing', async (_name, run) => {
    quiet();
    const owner = await signedInOwner();
    const { agentId, token } = await json<{ agentId: string; token: string }>(await createSigned(owner, 'Mine'));
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
    expect(vi.mocked(submitOnboardingTx)).not.toHaveBeenCalled();
    expect(executeTransaction).not.toHaveBeenCalled();
  });
});

describe('error answers', () => {
  const ROUTES = ['decisions', 'memories', 'agents', 'agents/[id]', 'onboarding', 'onboarding/build', 'onboarding/confirm', 'onboarding/submit', 'onboarding/wallet', 'settings', 'step-up', 'overview', 'sessions'];

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

describe('the limits on routes that read Sui', () => {
  it('turns away the 31st overview, build or confirm call in one minute for one owner with 429, others and the next minute untouched', async () => {
    const owner = await withAllowance(await signedInOwner());
    const other = await withAllowance(await signedInOwner());
    const noAllowance = await signedInOwner();
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

    // Reads that touch no chain are not counted against it, and an overview with no allowance reads none.
    expect((await onboarding(owner.cookie)).status).toBe(200);
    expect((await listDecisions(owner.cookie)).status).toBe(200);
    for (let i = 0; i <= LIMITS.ownerChainReadsPerMinute; i += 1) expect((await overview(noAllowance.cookie)).status).toBe(200);
    expect(getBalances.mock.calls.length).toBe(balanceReads);
    expect((await overview(other.cookie)).status).toBe(200);
    clock = new Date(clock.getTime() + 60_000);
    expect((await overview(owner.cookie)).status).toBe(200);
  });

  it('counts each request at the Tatum calls it makes and turns one owner away past 200 calls in a day with 429, long before 200 requests, the minute limit spending none of the day, others and the next day untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A fixed UTC day no other test counts in, so every count starts at nothing.
    const dayStart = Date.UTC(2031, 1, 1);
    const minute = (n: number) => new Date(dayStart + HOUR_MS + n * 60_000);
    clock = minute(0);
    const owner = await withAllowance(await signedInOwner());
    const other = await withAllowance(await signedInOwner());
    vi.mocked(buildCreateAccountTx).mockResolvedValue(ACCOUNT_BYTES);
    expect([LIMITS.ownerChainReadsPerMinute, LIMITS.ownerChainReadsPerDay, BUILD_CHAIN_CALLS.memory_account]).toEqual([30, 200, 5]);
    const buildOnce = async () => (await build({ step: 'memory_account' }, { cookie: owner.cookie })).status;

    // 30 builds are 150 calls; the 31st request is the minute's to refuse, and costs the day nothing.
    for (let i = 0; i < LIMITS.ownerChainReadsPerMinute; i += 1) expect(await buildOnce()).toBe(200);
    expect(await buildOnce()).toBe(429);
    clock = minute(1);
    for (let i = 0; i < 9; i += 1) expect(await buildOnce()).toBe(200);
    // 39 builds and five overviews: exactly 200 calls, in 44 requests.
    for (let i = 0; i < 5; i += 1) expect((await overview(owner.cookie)).status).toBe(200);
    // Still inside this minute's 30, so only the day can be what turns these away.
    const balanceReads = getBalances.mock.calls.length;
    const builds = vi.mocked(buildOnboardingTx).mock.calls.length;
    for (const refused of [await overview(owner.cookie), await build({ step: 'memory_account' }, { cookie: owner.cookie }), await confirm({ step: 'memory_account', digest: DIGEST }, { cookie: owner.cookie })]) {
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: 'rate_limited_today', message: 'Too many requests today. Try again tomorrow (days are counted in UTC).' });
    }
    expect(getBalances.mock.calls.length).toBe(balanceReads);
    expect(vi.mocked(buildOnboardingTx).mock.calls.length).toBe(builds);
    expect(getTransactionResult).not.toHaveBeenCalled();
    const lines = warn.mock.calls.map((call) => call.join(' '));
    expect(lines).toEqual(['[ellai http] owner_chain too_many_requests', ...Array<string>(3).fill('[ellai http] owner_chain rate_limited_today')]);

    expect((await overview(other.cookie)).status).toBe(200);
    clock = new Date(dayStart + 86_400_000 + HOUR_MS);
    expect((await overview(owner.cookie)).status).toBe(200);
  });

  it("counts a confirm and a delegate build at their own step's calls, 5 and 7 (C22)", async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 1, 2, 10));
    const owner = await withAllowance(await signedInOwner());
    chainOwner = owner.address;
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId: address(), delegates: [] });
    vi.mocked(buildAddDelegateTx).mockResolvedValue(ACCOUNT_BYTES);
    expect(BUILD_CHAIN_CALLS).toEqual({ memory_account: 5, add_delegate: 7, allowance: 3, usdc_to_address: 4 });
    expect(CONFIRM_CHAIN_CALLS).toEqual({ memory_account: 5, add_delegate: 5, allowance: 3 });

    // 26 confirms are 130 calls; 10 delegate builds a minute later bring the day to exactly 200.
    for (let i = 0; i < 26; i += 1) expect((await confirm({ step: 'memory_account', digest: DIGEST }, { cookie: owner.cookie })).status).toBe(200);
    clock = new Date(clock.getTime() + 60_000);
    for (let i = 0; i < 10; i += 1) expect((await build({ step: 'add_delegate' }, { cookie: owner.cookie })).status).toBe(200);
    const refused = await build({ step: 'add_delegate' }, { cookie: owner.cookie });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([429, 'rate_limited_today']);
  });

  it("counts a confirm with no digest at 3 calls, a submit at its step's calls and a wallet read at 1, before anything is sent (C22)", async () => {
    quiet();
    clock = new Date(Date.UTC(2031, 4, 8, 10));
    const owner = await signedInOwner();
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId: address(), delegates: [] });
    expect(CONFIRM_EXISTING_CHAIN_CALLS).toEqual({ memory_account: 3, add_delegate: 3 });
    expect(SUBMIT_CHAIN_CALLS).toEqual({ memory_account: 9, add_delegate: 11, allowance: 3, usdc_to_address: 3 });
    expect(WALLET_CHAIN_CALLS).toBe(1);
    const bytes = await allowanceBytes(owner);
    const sent = await signedBy(owner.signer, bytes);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    executeTransaction.mockResolvedValue({ digest, status: 'success', errorCode: null, balanceChanges: [], createdObjects: [{ objectId: address(), type: ALLOWANCE_TYPE }] });
    getAllowance.mockResolvedValue(allowanceOnChain(owner, await purseOf(owner)));

    // 60 existing confirms over two minutes are 180 calls; 6 allowance submits make 198 and 2 wallet reads exactly 200.
    for (let n = 0; n < 2; n += 1) {
      for (let i = 0; i < 30; i += 1) expect((await confirm({ step: 'memory_account', existing: true }, { cookie: owner.cookie })).status).toBe(200);
      clock = new Date(clock.getTime() + 60_000);
    }
    for (let i = 0; i < 6; i += 1) expect((await submit({ step: 'allowance', ...sent }, { cookie: owner.cookie })).status).toBe(200);
    for (let i = 0; i < 2; i += 1) expect((await wallet(owner.cookie)).status).toBe(200);
    for (const refused of [await submit({ step: 'allowance', ...sent }, { cookie: owner.cookie }), await wallet(owner.cookie)]) {
      expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([429, 'rate_limited_today']);
    }
    expect(executeTransaction).toHaveBeenCalledTimes(6);
    expect(getWalletBalances).toHaveBeenCalledTimes(2);
  });

  const fromClient = (client: string) => new Request(`${APP_ORIGIN}/api/owner/onboarding/confirm`, { headers: { 'x-forwarded-for': client } });

  it('turns one client away past 300 Tatum calls in a day however many owners it signs in, with 429 rate_limited_today, while another client goes on (C34)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('VERCEL', '1');
    const at = new Date(Date.UTC(2031, 3, 1, 10));
    const ctx = { db, chain, env: ENV, now: () => at };
    expect(LIMITS.ownerChainCallsPerClientPerDay).toBe(300);
    // Ten fresh owners at 30 calls each, every one inside its own minute and day.
    for (let n = 0; n < 10; n += 1) {
      const ownerId = `owner-${hex(8)}`;
      for (let i = 0; i < 6; i += 1) expect(await limitOwnerChainCalls(ctx, fromClient('203.0.113.40'), ownerId, CONFIRM_CHAIN_CALLS.memory_account)).toBeNull();
    }
    const refused = await limitOwnerChainCalls(ctx, fromClient('203.0.113.40'), `owner-${hex(8)}`, 1);
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toEqual({ error: 'rate_limited_today', message: 'Too many requests today. Try again tomorrow (days are counted in UTC).' });
    expect(await limitOwnerChainCalls(ctx, fromClient('198.51.100.40'), `owner-${hex(8)}`, 1)).toBeNull();
    expect(warn.mock.calls.map((call) => call.join(' '))).toEqual(['[ellai http] owner_chain client rate_limited_today']);
    await expect(limitOwnerChainCalls(ctx, fromClient('198.51.100.40'), `owner-${hex(8)}`, 0)).rejects.toThrow('the call count must be a positive integer');
  });

  it('turns away the call past 1,000 in one day across every owner and client with 503 chain_unavailable_today, which takes at least 4 clients, logging it once and open again the next day (C22, C34)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('VERCEL', '1');
    const at = new Date(Date.UTC(2031, 2, 1, 10));
    const ctx = { db, chain, env: ENV, now: () => at };
    expect([LIMITS.ownerChainReadsPerDayGlobal, LIMITS.ownerChainCallsPerClientPerDay]).toEqual([1_000, 300]);
    // 5 calls a request and 30 requests an owner, inside every owner's minute and day.
    const spend = async (client: string, calls: number) => {
      let ownerId = '';
      for (let i = 0; i < calls / 5; i += 1) {
        if (i % 30 === 0) ownerId = `owner-${hex(8)}`;
        expect(await limitOwnerChainCalls(ctx, fromClient(client), ownerId, 5)).toBeNull();
      }
    };
    for (const client of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) await spend(client, LIMITS.ownerChainCallsPerClientPerDay);
    // Three clients' whole days leave 100 calls, which a fourth spends.
    await spend('203.0.113.4', 100);
    const refused = await limitOwnerChainCalls(ctx, fromClient('203.0.113.5'), `owner-${hex(8)}`, 1);
    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toEqual({ error: 'chain_unavailable_today', message: "Ellai has used today's budget for reading Sui. Try again tomorrow (days are counted in UTC)." });
    expect((await limitOwnerChainCalls(ctx, fromClient('203.0.113.6'), `owner-${hex(8)}`, 1))?.status).toBe(503);
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual(['[ellai http] quota_spent owner-chain-reads:day']);
    expect(await limitOwnerChainCalls({ ...ctx, now: () => new Date(at.getTime() + 86_400_000) }, fromClient('203.0.113.5'), `owner-${hex(8)}`, 1)).toBeNull();
  });
});
