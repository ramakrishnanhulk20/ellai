// Covers: the public routes called as Next would call them, with Request objects, on PGlite
// with a stub chain: Ellai's wallet check seller bound to APP_ORIGIN whatever Host says, its
// 402 and its paid 200 with a stubbed settlement, and its body cap; the jobs tick refused
// without the exact secret, with its own Bearer challenge, and run with it, its summary in fixed codes only, and old rate
// counters pruned; the public proof listing only verified payments and memories found on chain,
// only for owners who opted in and with totals over those owners only, with no sentence,
// purpose, label or owner address, at most 20 of each, read from the
// database at most once per cache window however many requests come, and its last good copy
// or a 503 when a refresh fails; and the fixed status, code and wording toErrorResponse gives
// every error class these routes and the agent tools can meet.
// Does NOT cover: the live chain or Tatum (npm run prove:seller and npm run prove:jobs do
// those), the seller's own settlement rules (seller.test.ts), each job's own branches
// (jobs.test.ts), the timing of the secret comparison itself (node's timingSafeEqual), the
// GitHub schedule that calls the tick, or several server instances each keeping their own
// proof cache (each one still reads at most once per window).
import { randomBytes } from 'node:crypto';
import { type Chain, ChainError, type ExecutionResult, type WalrusBlob } from '@ellai/core/chain';
import { ChallengeError, parseChallenge } from '@ellai/core/challenge';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError, findMemoryAccount } from '@ellai/core/memory';
import { NetError } from '@ellai/core/net';
import { PaymentError, paymentHeader, signPayment } from '@ellai/core/payment';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase58 } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as jobsRoute from '../src/app/api/jobs/tick/route.js';
import * as proofRoute from '../src/app/api/public/proof/route.js';
import * as sellRoute from '../src/app/api/sell/wallet-check/route.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, memories, owners, payments, rateCounters, sellerSales } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { setServerContextFactory } from '../src/server/http/context.js';
import { HttpError, toErrorResponse } from '../src/server/http/errors.js';
import { confirmBlobsOnChain } from '../src/server/jobs/blobs.js';
import { MemoryServiceError } from '../src/server/memory/delegate.js';
import { ProofUnavailableError } from '../src/server/public/proof.js';
import { SellerError } from '../src/server/seller/challenge.js';
import { HANDLER_MESSAGES } from '../src/server/seller/handler.js';

vi.mock('@ellai/core/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ellai/core/memory')>()),
  findMemoryAccount: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const APP_ORIGIN = 'https://ellai.example';
const RESOURCE = `${APP_ORIGIN}/api/sell/wallet-check`;
const PAY_TO = canonicalSuiAddress(`0x${'5e'.repeat(32)}`);
const JOBS_SECRET = hex(32);
const GAS = Ed25519Keypair.generate();
const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: hex(32),
  GAS_PRIVATE_KEY: GAS.getSecretKey(),
  SESSION_SECRET: hex(32),
  JOBS_SECRET,
  APP_ORIGIN,
  ELLAI_SELLER_PAYTO: PAY_TO,
};
const MARKER = 'MARKER_52b9_secret';
const EPOCH = 1_100n;
const PRICE = BigInt(LIMITS.sellerPriceAtomic);
const buyer = Ed25519Keypair.generate();
const BUYER = canonicalSuiAddress(buyer.toSuiAddress());
const CHECKED = canonicalSuiAddress(`0x${'c4'.repeat(32)}`);

let clock = new Date('2026-10-25T10:00:00Z');
let chain: Chain;

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
  clock = new Date(clock.getTime() + 3_600_000);
  chain = {} as Chain;
  setServerContextFactory(async () => ({ db, chain, env: ENV, now: () => clock }));
  vi.mocked(findMemoryAccount).mockReset();
  vi.mocked(findMemoryAccount).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet(): ReturnType<typeof vi.spyOn> {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

/** What a chain shows for the buyer's exact send of the price to PAY_TO. */
function landed(txBytes: Uint8Array): ExecutionResult {
  const payer = canonicalSuiAddress(TransactionDataBuilder.fromBytes(txBytes).getData().sender ?? '');
  return {
    digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
    status: 'success',
    errorCode: null,
    balanceChanges: [
      { address: payer, coinType: USDC_TYPE_MAINNET, amount: -PRICE },
      { address: PAY_TO, coinType: USDC_TYPE_MAINNET, amount: PRICE },
    ],
    createdObjects: [],
  };
}

function sellerChain() {
  const calls = { epochs: 0, executions: 0 };
  const stub = {
    usesApiKey: false,
    getCurrentEpoch: async () => {
      calls.epochs += 1;
      return EPOCH;
    },
    executeTransaction: async (txBytes: Uint8Array) => {
      calls.executions += 1;
      return landed(txBytes);
    },
    getBalances: async () => ({ usdcAddressBalance: 50_000n, usdcCoinBalance: 0n, suiTotal: 1_500_000_000n }),
    listOwnedWalrusBlobs: async () => [],
  } as unknown as Chain;
  return { stub, calls };
}

function sell(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  return sellRoute.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }));
}

describe('route files', () => {
  it.each([
    ['sell', sellRoute],
    ['jobs', jobsRoute],
    ['proof', proofRoute],
  ])('%s runs on Node and is never cached or prerendered', (_name, route) => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('POST /api/sell/wallet-check', () => {
  it('binds the challenge to APP_ORIGIN even when Host names another site, then answers 402 and a paid 200', async () => {
    const { stub, calls } = sellerChain();
    chain = stub;
    const elsewhere = 'https://evil.example/api/sell/wallet-check';
    const spoofed = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' };
    const body = JSON.stringify({ address: CHECKED });

    const unpaid = await sell(elsewhere, spoofed, body);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get('cache-control')).toBe('no-store');
    const challengeText = await unpaid.text();
    const challenge = JSON.parse(challengeText) as { accepts: Array<{ resource: string; payTo: string }> };
    expect(challenge.accepts[0]).toMatchObject({ resource: RESOURCE, payTo: PAY_TO });
    expect(unpaid.headers.get('www-authenticate')).toContain('realm="ellai.example"');
    expect(challengeText).not.toContain('evil.example');

    const payment = parseChallenge(
      { status: 402, headers: Object.fromEntries(unpaid.headers), bodyText: challengeText, url: RESOURCE, host: 'ellai.example' },
      clock.getTime(),
    );
    const signed = await signPayment(payment, buyer, clock.getTime(), payment.minEpoch ?? EPOCH);
    const paid = await sell(elsewhere, { ...spoofed, 'X-PAYMENT': paymentHeader(payment, signed).value }, body);
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ address: CHECKED, sui: '1.5 SUI', usdcAddressBalance: '0.05 USDC', hasWalrusMemoryAccount: false, walrusBlobs: 0 });
    const receipt = JSON.parse(Buffer.from(paid.headers.get('x-payment-response') ?? '', 'base64').toString('utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({ success: true, transaction: signed.digest, payer: BUYER });
    expect(calls).toEqual({ epochs: 1, executions: 1 });
    const [sale] = await db.select().from(sellerSales).where(eq(sellerSales.digest, signed.digest));
    expect(sale?.status).toBe('settled');
  });

  it("refuses a body over the cap with the seller's own 400, before any chain read", async () => {
    const { stub, calls } = sellerChain();
    chain = stub;
    const response = await sell(RESOURCE, {}, JSON.stringify({ address: CHECKED, pad: 'x'.repeat(LIMITS.challengeMaxBytes) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: HANDLER_MESSAGES.body });
    expect(calls).toEqual({ epochs: 0, executions: 0 });
  });
});

function tick(headers: Record<string, string>): Promise<Response> {
  return jobsRoute.POST(new Request(`${APP_ORIGIN}/api/jobs/tick`, { method: 'POST', headers }));
}

function gasChain(read: () => Promise<{ usdcAddressBalance: bigint; usdcCoinBalance: bigint; suiTotal: bigint }>) {
  const getBalances = vi.fn(read);
  return { stub: { usesApiKey: false, getBalances } as unknown as Chain, getBalances };
}

describe('POST /api/jobs/tick', () => {
  it('is 401 and runs nothing without exactly the jobs secret', async () => {
    quiet();
    const { stub, getBalances } = gasChain(async () => ({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiTotal: 0n }));
    chain = stub;
    const refused: Array<Record<string, string>> = [
      {},
      { authorization: `Bearer ${hex(32)}` },
      { authorization: `Bearer ${JOBS_SECRET}0` },
      { authorization: `Bearer ${JOBS_SECRET.slice(0, -1)}` },
      { authorization: `Basic ${JOBS_SECRET}` },
      { authorization: JOBS_SECRET },
      { authorization: `Bearer ${JOBS_SECRET}, Bearer ${JOBS_SECRET}` },
      { cookie: `jobs=${JOBS_SECRET}` },
    ];
    for (const headers of refused) {
      const response = await tick(headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="ellai-jobs"');
      expect(await response.json()).toEqual({ error: 'jobs_unauthorized', message: 'This endpoint needs the jobs secret.' });
    }
    expect(getBalances).not.toHaveBeenCalled();
  });

  it('runs the tick with the secret, answering with its summary, and prunes counters older than the retention window', async () => {
    const { stub, getBalances } = gasChain(async () => ({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiTotal: 2_000_000_000n }));
    chain = stub;
    const suiAddress = canonicalSuiAddress(`0x${hex(32)}`);
    const [owner] = await db.insert(owners).values({ suiAddress, purseAddress: canonicalSuiAddress(`0x${hex(32)}`) }).returning({ id: owners.id });
    const ownerId = owner?.id ?? '';
    const [agent] = await db.insert(agents).values({ ownerId, label: 'Old agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_agent_' }).returning({ id: agents.id });
    const abandonedAt = new Date(clock.getTime() - LIMITS.staleOpenDecisionMs - 60_000);
    await db.insert(decisions).values({
      ownerId,
      agentId: agent?.id ?? '',
      requestKey: hex(16),
      sellerUrl: 'https://hotels.example/v1/rooms',
      sellerMethod: 'POST',
      sellerHost: 'hotels.example',
      bodyHash: hex(32),
      purpose: 'Book the hotel room',
      recipient: canonicalSuiAddress(`0x${'11'.repeat(32)}`),
      amountAtomic: 10_000n,
      asset: USDC_TYPE_MAINNET,
      network: 'sui:mainnet',
      expiresAt: new Date(abandonedAt.getTime() + 60_000),
      outcome: 'approved',
      rule: 'learned',
      reason: 'You approved this recipient before.',
      status: 'open',
      createdAt: abandonedAt,
    });
    const minute = (msAgo: number) => new Date(Math.floor((clock.getTime() - msAgo) / 60_000) * 60_000);
    await db.insert(rateCounters).values([
      { key: 'http:old', windowStart: minute(26 * 3_600_000), count: 3 },
      { key: 'seller-challenge:old', windowStart: minute(LIMITS.rateCounterRetentionMs + 120_000), count: 1 },
      { key: 'agent-run-all:day', windowStart: minute(2 * 3_600_000), count: 1 },
      { key: 'http:recent', windowStart: minute(60_000), count: 1 },
    ]);

    const response = await tick({ authorization: `bearer ${JOBS_SECRET}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owners: 1,
      memoriesSubmitted: 0,
      memoriesConfirmed: 0,
      memoriesFailed: 0,
      memoriesChainConfirmed: 0,
      paymentsVerified: 0,
      paymentsNotLanded: 0,
      paymentsMismatched: 0,
      outcomesRecorded: 0,
      decisionsExpired: 1,
      questionsClosed: 0,
      refills: 0,
      rowsPruned: 0,
      gasWalletLow: false,
      timeBudgetReached: false,
      errors: [],
    });
    expect(getBalances).toHaveBeenCalledWith(GAS.toSuiAddress());
    const kept = (await db.select({ key: rateCounters.key }).from(rateCounters)).map((row) => row.key);
    expect(kept).toEqual(expect.arrayContaining(['agent-run-all:day', 'http:recent']));
    expect(kept).not.toContain('http:old');
    expect(kept).not.toContain('seller-challenge:old');
  });

  it('reports a failure as a fixed code and never the error text', async () => {
    quiet();
    const { stub } = gasChain(async () => {
      throw new ChainError('TIMEOUT', `timed out reading ${MARKER}`, true);
    });
    chain = stub;
    const response = await tick({ authorization: `Bearer ${JOBS_SECRET}` });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ gasWalletLow: true, errors: [{ ownerId: '', step: 'gas_wallet', code: 'CHAIN_TIMEOUT' }] });
    expect(text).not.toContain(MARKER);
  });
});

interface Proof {
  totals: Record<string, number | string>;
  payments: Array<{ digest: string; amountAtomic: string; sellerHost: string; signedAt: string; explorerUrl: string }>;
  memories: Array<{ blobId: string; kind: string; confirmedAt: string }>;
}

describe('GET /api/public/proof', () => {
  let proofDb: Awaited<ReturnType<typeof createDb>>;
  let opened = 0;
  let failing = false;
  let nowMs = Date.UTC(2031, 0, 1);

  // The totals count the whole database, so the proof gets one of its own, emptied before each test.
  beforeAll(async () => {
    proofDb = await createDb('pglite:memory');
    await migrate(proofDb.db);
  });

  afterAll(async () => {
    await proofDb.close();
  });

  beforeEach(async () => {
    for (const table of [payments, memories, decisions, agents, owners]) await proofDb.db.delete(table);
    opened = 0;
    failing = false;
    // The proof never reads the chain, so any touch of it fails the request.
    chain = new Proxy({} as Chain, {
      get() {
        throw new Error('the public proof read the chain');
      },
    });
    setServerContextFactory(async () => {
      opened += 1;
      if (failing) throw new Error(`connect ECONNREFUSED ${MARKER}`);
      return { db: proofDb.db, chain, env: ENV, now: () => clock };
    });
    // The route's cache lives on globalThis for the life of the process; each test starts with none.
    delete (globalThis as Record<string, unknown>).__ellaiPublicProof;
    nowMs += 10 * LIMITS.publicProofCacheMs;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  const at =(msAgo: number) => new Date(nowMs - msAgo);

  async function proofOwner(publicProof = true): Promise<{ ownerId: string; agentId: string; suiAddress: string; purseAddress: string }> {
    const suiAddress = canonicalSuiAddress(`0x${hex(32)}`);
    const purseAddress = canonicalSuiAddress(`0x${hex(32)}`);
    const [owner] = await proofDb.db.insert(owners).values({ suiAddress, purseAddress, publicProof }).returning({ id: owners.id });
    const ownerId = owner?.id ?? '';
    const [agent] = await proofDb.db
      .insert(agents)
      .values({ ownerId, label: `Agent ${MARKER}`, kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_agent_' })
      .returning({ id: agents.id });
    return { ownerId, agentId: agent?.id ?? '', suiAddress, purseAddress };
  }

  type Party = Awaited<ReturnType<typeof proofOwner>>;

  async function proofDecision(w: Party, values: Partial<typeof decisions.$inferInsert> = {}): Promise<string> {
    const [row] = await proofDb.db
      .insert(decisions)
      .values({
        ownerId: w.ownerId,
        agentId: w.agentId,
        requestKey: hex(16),
        sellerUrl: 'https://hotels.example/v1/rooms',
        sellerMethod: 'POST',
        sellerHost: 'hotels.example',
        bodyHash: hex(32),
        purpose: `Book the room ${MARKER}`,
        recipient: canonicalSuiAddress(`0x${'11'.repeat(32)}`),
        amountAtomic: 10_000n,
        asset: USDC_TYPE_MAINNET,
        network: 'sui:mainnet',
        expiresAt: at(-60_000),
        outcome: 'approved',
        rule: 'learned',
        reason: `You approved this recipient before. ${MARKER}`,
        status: 'paid',
        createdAt: at(600_000),
        ...values,
      })
      .returning({ id: decisions.id });
    return row?.id ?? '';
  }

  async function proofPayment(w: Party, settlement: 'verified' | 'pending' | 'mismatch' | 'not_landed', signedAt: Date, amountAtomic = 10_000n): Promise<string> {
    const decisionId = await proofDecision(w, { amountAtomic });
    const digest = toBase58(randomBytes(32));
    await proofDb.db.insert(payments).values({
      decisionId,
      ownerId: w.ownerId,
      purseAddress: w.purseAddress,
      recipient: canonicalSuiAddress(`0x${'11'.repeat(32)}`),
      amountAtomic,
      digest,
      txBytesBase64: 'AA==',
      signedAt,
      validUntilEpoch: 1n,
      settlement,
      ...(settlement === 'mismatch' ? { mismatchReason: `wrong recipient ${MARKER}` } : {}),
    });
    return digest;
  }

  // A confirmed memory is found on chain at its confirmation unless the test says it never was.
  async function proofMemory(
    w: Party,
    kind: 'owner_decision' | 'outcome',
    status: 'confirmed' | 'pending' | 'failed',
    confirmedAt: Date | null,
    chainConfirmedAt: Date | null = status === 'confirmed' ? confirmedAt : null,
  ): Promise<string | null> {
    const blobId = status === 'confirmed' ? randomBytes(32).toString('base64url') : null;
    await proofDb.db.insert(memories).values({
      ownerId: w.ownerId,
      kind,
      recipient: canonicalSuiAddress(`0x${'11'.repeat(32)}`),
      amountAtomic: 10_000n,
      verdict: 'approve',
      sellerHost: 'hotels.example',
      sentence: `The owner said yes to this hotel, ${w.suiAddress}. ${MARKER}`,
      namespace: 'ellai-v1',
      writerPublicKey: hex(32),
      blobId,
      status,
      confirmedAt,
      chainConfirmedAt,
    });
    return blobId;
  }

  async function proof(): Promise<{ response: Response; text: string; body: Proof }> {
    const response = await proofRoute.GET();
    const text = await response.text();
    return { response, text, body: JSON.parse(text) as Proof };
  }

  it('lists only payments Ellai verified and memories Walrus confirmed, and nothing an owner or agent wrote', async () => {
    const w = await proofOwner();
    const older = await proofPayment(w, 'verified', at(120_000), 10_000n);
    const newer = await proofPayment(w, 'verified', at(60_000), 25_000n);
    await proofPayment(w, 'pending', at(30_000));
    await proofPayment(w, 'mismatch', at(20_000));
    await proofPayment(w, 'not_landed', at(10_000));
    await proofDecision(w, { outcome: 'asked', rule: 'recall_unavailable', status: 'asked' });
    await proofDecision(w, { outcome: 'asked', rule: 'no_match', status: 'expired' });
    await proofDecision(w, { outcome: 'approved', rule: 'grant', status: 'expired' });
    await proofDecision(w, { outcome: 'refused', rule: 'paused', status: 'refused' });
    const answerBlob = await proofMemory(w, 'owner_decision', 'confirmed', at(180_000));
    const outcomeBlob = await proofMemory(w, 'outcome', 'confirmed', at(90_000));
    await proofMemory(w, 'owner_decision', 'pending', null);
    await proofMemory(w, 'owner_decision', 'failed', null);

    const { response, text, body } = await proof();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      totals: { verifiedPayments: 2, verifiedUsdcAtomic: '35000', confirmedOwnerAnswers: 1, approvedByLearning: 5, askedDecisions: 2 },
      payments: [
        { digest: newer, amountAtomic: '25000', sellerHost: 'hotels.example', signedAt: at(60_000).toISOString(), explorerUrl: `https://suiscan.xyz/mainnet/tx/${newer}` },
        { digest: older, amountAtomic: '10000', sellerHost: 'hotels.example', signedAt: at(120_000).toISOString(), explorerUrl: `https://suiscan.xyz/mainnet/tx/${older}` },
      ],
      memories: [
        { blobId: outcomeBlob, kind: 'outcome', confirmedAt: at(90_000).toISOString() },
        { blobId: answerBlob, kind: 'owner_decision', confirmedAt: at(180_000).toISOString() },
      ],
    });
    for (const secret of [MARKER, w.suiAddress, w.purseAddress, w.suiAddress.slice(2), w.purseAddress.slice(2), 'The owner said', 'Book the room']) {
      expect(text).not.toContain(secret);
    }
  });

  it('never lists or counts a memory Walrus Memory confirmed until the tick finds its blob among the owner\'s Blob objects on chain', async () => {
    const w = await proofOwner();
    const confirmedAt = at(60_000);
    const blobId = (await proofMemory(w, 'owner_decision', 'confirmed', confirmedAt, null)) ?? '';
    const listing = (ids: string[]) =>
      ({
        listOwnedWalrusBlobs: async (owner: string): Promise<WalrusBlob[]> =>
          owner === w.suiAddress ? ids.map((id) => ({ objectId: canonicalSuiAddress(`0x${hex(32)}`), blobId: id, registeredEpoch: 1, endEpoch: 2, deletable: false })) : [],
      }) as unknown as Chain;

    const before = await proof();
    expect([before.body.memories, before.body.totals.confirmedOwnerAnswers]).toEqual([[], 0]);
    expect(await confirmBlobsOnChain({ db: proofDb.db, chain: listing([]), ownerId: w.ownerId, now: new Date(nowMs) })).toEqual({ checked: 1, confirmed: 0 });
    nowMs += LIMITS.publicProofCacheMs;
    expect((await proof()).body.memories).toEqual([]);

    expect(await confirmBlobsOnChain({ db: proofDb.db, chain: listing([blobId]), ownerId: w.ownerId, now: new Date(nowMs) })).toEqual({ checked: 1, confirmed: 1 });
    nowMs += LIMITS.publicProofCacheMs;
    const after = await proof();
    expect(after.body.memories).toEqual([{ blobId, kind: 'owner_decision', confirmedAt: confirmedAt.toISOString() }]);
    expect(after.body.totals.confirmedOwnerAnswers).toBe(1);
  });

  it('never shows an owner who has not opted in, in the lists or the totals, until they opt in', async () => {
    const shown = await proofOwner();
    const hidden = await proofOwner(false);
    const shownDigest = await proofPayment(shown, 'verified', at(60_000), 10_000n);
    const hiddenDigest = await proofPayment(hidden, 'verified', at(30_000), 40_000n);
    const shownBlob = await proofMemory(shown, 'owner_decision', 'confirmed', at(90_000));
    const hiddenBlob = (await proofMemory(hidden, 'owner_decision', 'confirmed', at(45_000))) ?? '';
    await proofDecision(hidden, { outcome: 'asked', rule: 'no_match', status: 'asked' });

    const { text, body } = await proof();
    expect(body.totals).toEqual({ verifiedPayments: 1, verifiedUsdcAtomic: '10000', confirmedOwnerAnswers: 1, approvedByLearning: 1, askedDecisions: 0 });
    expect(body.payments.map((row) => row.digest)).toEqual([shownDigest]);
    expect(body.memories.map((row) => row.blobId)).toEqual([shownBlob]);
    for (const secret of [hiddenDigest, hiddenBlob, hidden.suiAddress, hidden.purseAddress]) expect(text).not.toContain(secret);

    await proofDb.db.update(owners).set({ publicProof: true }).where(eq(owners.id, hidden.ownerId));
    nowMs += LIMITS.publicProofCacheMs;
    const opted = await proof();
    expect(opted.body.payments.map((row) => row.digest)).toEqual([hiddenDigest, shownDigest]);
    expect(opted.body.totals).toMatchObject({ verifiedPayments: 2, verifiedUsdcAtomic: '50000', askedDecisions: 1 });
  });

  it('reads the database at most once per window, however many requests arrive, and again after it', async () => {
    const w = await proofOwner();
    await proofPayment(w, 'verified', at(60_000));
    const selects = vi.spyOn(proofDb.db, 'select');

    const first = await proof();
    expect(first.body.totals.verifiedPayments).toBe(1);
    const readsPerRefresh = selects.mock.calls.length;
    expect(readsPerRefresh).toBe(5);

    await proofPayment(w, 'verified', at(30_000));
    nowMs += LIMITS.publicProofCacheMs - 1;
    const sameWindow = await Promise.all(Array.from({ length: 25 }, () => proof()));
    for (const { text } of sameWindow) expect(text).toBe(first.text);
    expect(selects.mock.calls.length).toBe(readsPerRefresh);
    expect(opened).toBe(1);

    nowMs += 1;
    const together = await Promise.all(Array.from({ length: 10 }, () => proof()));
    for (const { body } of together) expect(body.totals.verifiedPayments).toBe(2);
    expect(selects.mock.calls.length).toBe(2 * readsPerRefresh);
    expect(opened).toBe(2);
  });

  it('lists at most 20 of each, newest first', async () => {
    const w = await proofOwner();
    const digests: string[] = [];
    const blobs: Array<string | null> = [];
    for (let i = 0; i < 21; i += 1) {
      digests.push(await proofPayment(w, 'verified', at((21 - i) * 1_000)));
      blobs.push(await proofMemory(w, 'owner_decision', 'confirmed', at((21 - i) * 1_000)));
    }
    const { body } = await proof();
    expect(body.payments.map((row) => row.digest)).toEqual(digests.slice(1).reverse());
    expect(body.memories.map((row) => row.blobId)).toEqual(blobs.slice(1).reverse());
    expect(body.totals.verifiedPayments).toBe(21);
  });

  it('serves the last good copy when a refresh fails, 503 with none, and never retries inside a window', async () => {
    const logged = quiet();
    const w = await proofOwner();
    await proofPayment(w, 'verified', at(60_000));

    failing = true;
    for (let i = 0; i < 3; i += 1) {
      const { response, body } = await proof();
      expect(response.status).toBe(503);
      expect(body).toEqual({ error: 'proof_unavailable', message: 'The public proof cannot be read right now. Try again in a minute.' });
    }
    expect(opened).toBe(1);

    failing = false;
    nowMs += LIMITS.publicProofCacheMs;
    const good = await proof();
    expect(good.response.status).toBe(200);

    failing = true;
    nowMs += LIMITS.publicProofCacheMs;
    const stale = await proof();
    expect(stale.response.status).toBe(200);
    expect(stale.text).toBe(good.text);
    expect(opened).toBe(3);
    expect(logged.mock.calls.flat()).toContain('[ellai proof] refresh_failed');
    expect(logged.mock.calls.flat().join(' ')).not.toContain(MARKER);
  });
});

describe('toErrorResponse for the classes these routes meet', () => {
  const CHAIN = 'Ellai could not read Sui just now. Try again shortly.';
  it.each([
    ['ChainError TIMEOUT', new ChainError('TIMEOUT', `no answer within 10000 ms ${MARKER}`, true), 504, 'chain_timeout', CHAIN, 'TIMEOUT'],
    ['ChainError NOT_FOUND', new ChainError('NOT_FOUND', `Transaction ${MARKER} was not found on Sui mainnet`), 502, 'chain_not_found', CHAIN, 'NOT_FOUND'],
    ['ChainError UNAUTHORIZED', new ChainError('UNAUTHORIZED', `API key rejected ${MARKER}`), 503, 'chain_unauthorized', CHAIN, 'UNAUTHORIZED'],
    ['ChallengeError MALFORMED', new ChallengeError('MALFORMED', `the body is not JSON ${MARKER}`), 502, 'challenge_malformed', "Ellai could not read this seller's price safely.", 'MALFORMED'],
    ['NetError NOT_PUBLIC', new NetError('NOT_PUBLIC', `refused ${MARKER}`), 400, 'net_not_public', 'Ellai could not reach this address safely.', 'NOT_PUBLIC'],
    ['NetError TIMEOUT', new NetError('TIMEOUT', `timed out ${MARKER}`), 504, 'net_timeout', 'Ellai could not reach this address safely.', 'TIMEOUT'],
    ['MemoryError RATE_LIMITED', new MemoryError('RATE_LIMITED', `429 from relayer ${MARKER}`), 503, 'memory_rate_limited', 'Walrus Memory could not be reached just now. Try again shortly.', 'RATE_LIMITED'],
    ['MemoryServiceError NO_ACCOUNT', new MemoryServiceError('NO_ACCOUNT', `no account ${MARKER}`), 409, 'memory_service_no_account', 'Ellai could not finish this memory step.', 'NO_ACCOUNT'],
    ['MemoryServiceError SEND_UNCERTAIN', new MemoryServiceError('SEND_UNCERTAIN', `unsure ${MARKER}`), 503, 'memory_service_send_uncertain', 'Ellai could not finish this memory step.', 'SEND_UNCERTAIN'],
    ['PaymentError MISMATCH', new PaymentError('MISMATCH', 'the built bytes do not match'), 500, 'mismatch', 'the built bytes do not match', 'MISMATCH'],
    ['SellerError', new SellerError(`GAS_PRIVATE_KEY is not an Ed25519 Sui key ${MARKER}`), 503, 'seller_unavailable', 'Ellai cannot serve this request right now.', 'SELLER'],
    ['ProofUnavailableError', new ProofUnavailableError(), 503, 'proof_unavailable', 'The public proof cannot be read right now. Try again in a minute.', 'PROOF'],
    ['HttpError agent_unauthorized', new HttpError(401, 'agent_unauthorized'), 401, 'agent_unauthorized', 'Send a valid Ellai agent token as Authorization: Bearer <token>.', 'agent_unauthorized'],
    ['HttpError jobs_unauthorized', new HttpError(401, 'jobs_unauthorized'), 401, 'jobs_unauthorized', 'This endpoint needs the jobs secret.', 'jobs_unauthorized'],
  ] as const)('maps %s to a fixed status, code and message, logging only the class and code', async (_label, error, status, code, message, logCode) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = toErrorResponse(error);
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: code, message });
    expect(text).not.toContain(MARKER);
    const lines = [...warn.mock.calls, ...logError.mock.calls].map((call) => call.join(' '));
    expect(lines).toEqual([`[ellai http] ${error.name} ${logCode}`]);
  });

  it('answers a known class carrying a code outside its set, even an inherited name, as unknown', async () => {
    quiet();
    for (const forged of [
      Object.assign(new ChainError('TIMEOUT', MARKER), { code: 'toString' }),
      Object.assign(new NetError('TIMEOUT', MARKER), { code: 'SOMETHING_ELSE' }),
      Object.assign(new MemoryServiceError('OWNER', MARKER), { code: 42 }),
    ]) {
      const response = toErrorResponse(forged);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
    }
  });
});
