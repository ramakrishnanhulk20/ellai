// Covers: GET /api/public/memory-map called as Next would call it, on PGlite with a chain that
// fails any touch: only owners who opted in, only their owner answers that Walrus Memory
// confirmed, the tick found on chain and Walrus still stores, only decisions Sui or Walrus backs
// (a verified payment, a citation of such an answer, or the question's own answer being one, C37),
// each decision's citations kept to
// those answers with the distance decide stored (cut to what a real column holds) or none, a
// digest only for a verified payment, the totals /proof shows, the exact key set at every level
// with no sentence, purpose, reason, label, owner, agent, database id or address in the text,
// the caps of 200 answers and 50 decisions newest first, one database read per cache window with
// the same headers as /proof, and a 503 with no earlier copy.
// Does NOT cover: how decide writes the distances (decide.test.ts), how the tick confirms or
// expires a blob on chain (routes-public.test.ts and jobs.test.ts), the totals' finer rules
// (routes-public.test.ts, which reads the same queries through /proof), several server
// instances each keeping their own cache, or the page that draws the map.
import { randomBytes } from 'node:crypto';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase58 } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as memoryMapRoute from '../src/app/api/public/memory-map/route.js';
import * as proofRoute from '../src/app/api/public/proof/route.js';
import { createDb, migrate } from '../src/server/db/client.js';
import { agents, decisionCitations, decisions, memories, owners, payments } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { setServerContextFactory } from '../src/server/http/context.js';
import type { MemoryMap } from '../src/server/public/proof.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const MARKER = 'MARKER_7d1e_private';
const RECIPIENT = canonicalSuiAddress(`0x${'11'.repeat(32)}`);
const DIGEST = toBase58(new Uint8Array(32).fill(7));
const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: hex(32),
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: hex(32),
  JOBS_SECRET: hex(32),
  APP_ORIGIN: 'https://ellai.example',
  ELLAI_SELLER_PAYTO: canonicalSuiAddress(`0x${'5e'.repeat(32)}`),
};

let handle: Awaited<ReturnType<typeof createDb>>;
let opened = 0;
let failing = false;
let nowMs = Date.UTC(2031, 0, 1);

// The map never reads the chain, so any touch of it fails the request.
const chain = new Proxy({} as Chain, {
  get() {
    throw new Error('the memory map read the chain');
  },
});

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  await migrate(handle.db);
});

afterAll(async () => {
  setServerContextFactory(null);
  await handle.close();
});

beforeEach(async () => {
  for (const table of [decisionCitations, payments, memories, decisions, agents, owners]) await handle.db.delete(table);
  opened = 0;
  failing = false;
  setServerContextFactory(async () => {
    opened += 1;
    if (failing) throw new Error(`connect ECONNREFUSED ${MARKER}`);
    return { db: handle.db, chain, env: ENV, now: () => new Date(nowMs) };
  });
  // The caches live on globalThis for the life of the process; each test starts with none.
  delete (globalThis as Record<string, unknown>).__ellaiMemoryMap;
  delete (globalThis as Record<string, unknown>).__ellaiPublicProof;
  nowMs += 10 * LIMITS.publicProofCacheMs;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (msAgo: number) => new Date(nowMs - msAgo);

interface Party {
  ownerId: string;
  agentId: string;
  suiAddress: string;
  purseAddress: string;
}

async function party(publicProof = true): Promise<Party> {
  const suiAddress = canonicalSuiAddress(`0x${hex(32)}`);
  const purseAddress = canonicalSuiAddress(`0x${hex(32)}`);
  const [owner] = await handle.db.insert(owners).values({ suiAddress, purseAddress, publicProof }).returning({ id: owners.id });
  const ownerId = owner?.id ?? '';
  const [agent] = await handle.db
    .insert(agents)
    .values({ ownerId, label: `Agent ${MARKER}`, kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_agent_' })
    .returning({ id: agents.id });
  return { ownerId, agentId: agent?.id ?? '', suiAddress, purseAddress };
}

function decisionValues(p: Party, values: Partial<typeof decisions.$inferInsert>): typeof decisions.$inferInsert {
  return {
    ownerId: p.ownerId,
    agentId: p.agentId,
    requestKey: hex(16),
    sellerUrl: 'https://hotels.example/v1/rooms',
    sellerMethod: 'POST',
    sellerHost: 'hotels.example',
    bodyHash: hex(32),
    purpose: `Book the room ${MARKER}`,
    recipient: RECIPIENT,
    amountAtomic: 10_000n,
    asset: USDC_TYPE_MAINNET,
    network: 'sui:mainnet',
    expiresAt: at(-60_000),
    outcome: 'asked',
    rule: 'no_match',
    reason: `A reason ${MARKER}`,
    status: 'asked',
    ...values,
  };
}

async function decision(p: Party, values: Partial<typeof decisions.$inferInsert>): Promise<string> {
  const [row] = await handle.db.insert(decisions).values(decisionValues(p, values)).returning({ id: decisions.id });
  return row?.id ?? '';
}

async function paid(p: Party, decisionId: string, settlement: 'verified' | 'pending', digest = toBase58(randomBytes(32))): Promise<void> {
  await handle.db.insert(payments).values({
    decisionId,
    ownerId: p.ownerId,
    purseAddress: p.purseAddress,
    recipient: RECIPIENT,
    amountAtomic: 10_000n,
    digest,
    txBytesBase64: 'AA==',
    signedAt: at(100_000),
    validUntilEpoch: 1n,
    settlement,
  });
}

type Shown = 'on_chain' | 'pending' | 'not_found_on_chain' | 'expired';

function memoryValues(p: Party, blobId: string | null, shown: Shown, values: Partial<typeof memories.$inferInsert> = {}): typeof memories.$inferInsert {
  const confirmedAt = shown === 'pending' ? null : at(500_000);
  return {
    ownerId: p.ownerId,
    kind: 'owner_decision',
    recipient: RECIPIENT,
    amountAtomic: 20_000n,
    verdict: 'approve',
    sellerHost: 'hotels.example',
    sentence: `The owner said yes, ${p.suiAddress}. ${MARKER}`,
    namespace: 'ellai-v1',
    writerPublicKey: hex(32),
    blobId,
    status: shown === 'pending' ? 'pending' : 'confirmed',
    confirmedAt,
    chainConfirmedAt: shown === 'on_chain' || shown === 'expired' ? confirmedAt : null,
    chainExpiredAt: shown === 'expired' ? at(1_000) : null,
    ...values,
  };
}

async function memory(p: Party, blobId: string | null, shown: Shown, values: Partial<typeof memories.$inferInsert> = {}): Promise<string> {
  const [row] = await handle.db.insert(memories).values(memoryValues(p, blobId, shown, values)).returning({ id: memories.id });
  return row?.id ?? '';
}

async function cite(p: Party, decisionId: string, memoryId: string, distance: number | null): Promise<void> {
  await handle.db.insert(decisionCitations).values({ decisionId, memoryId, ownerId: p.ownerId, distance });
}

async function map(): Promise<{ response: Response; text: string; body: MemoryMap }> {
  const response = await memoryMapRoute.GET();
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as MemoryMap };
}

/** One opted-in owner with every kind of memory and decision the map must sort out, and one owner who never opted in. */
async function fixture() {
  const shown = await party();
  const yes1 = await memory(shown, 'yes-hotel-1', 'on_chain', { confirmedAt: at(300_000), chainConfirmedAt: at(300_000) });
  const yes2 = await memory(shown, 'yes-hotel-2', 'on_chain', { confirmedAt: at(240_000), chainConfirmedAt: at(240_000) });
  const no = await memory(shown, 'no-odd-seller', 'on_chain', { verdict: 'refuse', sellerHost: 'evil"host.example', amountAtomic: 50_000n, confirmedAt: at(200_000), chainConfirmedAt: at(200_000) });
  const pending = await memory(shown, null, 'pending');
  const unfound = await memory(shown, 'not-found-on-chain', 'not_found_on_chain');
  const expired = await memory(shown, 'expired-on-walrus', 'expired');
  const outcome = await memory(shown, 'outcome-memory', 'on_chain', { kind: 'outcome', verdict: null });

  const asked = await decision(shown, { createdAt: at(180_000) });
  const learned = await decision(shown, { outcome: 'approved', rule: 'learned', status: 'paid', createdAt: at(120_000) });
  await paid(shown, learned, 'verified', DIGEST);
  await cite(shown, learned, yes2, 0.25);
  await cite(shown, learned, yes1, 0.125);
  await cite(shown, learned, unfound, 0.0625);
  await cite(shown, learned, expired, 0.2);
  const refused = await decision(shown, { outcome: 'refused', rule: 'refused_recipient', status: 'refused', sellerHost: 'evil"host.example', amountAtomic: 30_000n, createdAt: at(60_000) });
  await cite(shown, refused, no, null);
  await cite(shown, refused, pending, null);
  const badOutcome = await decision(shown, { rule: 'bad_outcome', createdAt: at(30_000) });
  await cite(shown, badOutcome, outcome, null);
  const unsettled = await decision(shown, { outcome: 'approved', rule: 'learned', status: 'paid', createdAt: at(20_000) });
  await paid(shown, unsettled, 'pending');
  await cite(shown, unsettled, yes1, 0.1);

  const hidden = await party(false);
  const hiddenYes = await memory(hidden, 'hidden-owner-yes', 'on_chain');
  const hiddenLearned = await decision(hidden, { outcome: 'approved', rule: 'learned', status: 'paid', createdAt: at(10_000) });
  await paid(hidden, hiddenLearned, 'verified');
  await cite(hidden, hiddenLearned, hiddenYes, 0.125);

  return {
    parties: [shown, hidden],
    databaseIds: [yes1, yes2, no, pending, unfound, expired, outcome, asked, learned, refused, badOutcome, unsettled, hiddenYes, hiddenLearned],
  };
}

describe('GET /api/public/memory-map', () => {
  it("shows only opted-in owners' answers on chain and still stored, and drops every citation to any other memory", async () => {
    await fixture();
    const { response, body } = await map();
    expect(response.status).toBe(200);
    const usdc = { ten: '0.010000', twenty: '0.020000' };
    expect(body).toEqual({
      generatedAt: at(0).toISOString(),
      memories: [
        { blobId: 'no-odd-seller', verdict: 'refuse', host: 'this seller', amountUsdc: '0.050000', at: at(200_000).toISOString() },
        { blobId: 'yes-hotel-2', verdict: 'approve', host: 'hotels.example', amountUsdc: usdc.twenty, at: at(240_000).toISOString() },
        { blobId: 'yes-hotel-1', verdict: 'approve', host: 'hotels.example', amountUsdc: usdc.twenty, at: at(300_000).toISOString() },
      ],
      // The bare question and the bad-outcome question (it cites only an outcome memory) are not
      // backed by an owner answer on chain, so neither is listed or counted (C37).
      decisions: [
        { id: '0', at: at(20_000).toISOString(), outcome: 'approved', rule: 'learned', host: 'hotels.example', amountUsdc: usdc.ten, digest: null, citations: [{ blobId: 'yes-hotel-1', distance: 0.1 }] },
        { id: '1', at: at(60_000).toISOString(), outcome: 'refused', rule: 'refused_recipient', host: 'this seller', amountUsdc: '0.030000', digest: null, citations: [{ blobId: 'no-odd-seller', distance: null }] },
        {
          id: '2',
          at: at(120_000).toISOString(),
          outcome: 'approved',
          rule: 'learned',
          host: 'hotels.example',
          amountUsdc: usdc.ten,
          digest: DIGEST,
          citations: [
            { blobId: 'yes-hotel-1', distance: 0.125 },
            { blobId: 'yes-hotel-2', distance: 0.25 },
          ],
        },
      ],
      totals: { memories: 3, learnedApprovals: 1, questionsAsked: 0 },
    });
  });

  it('holds exactly the agreed keys, and no text, owner, agent, database id or address (C17, C18, C19)', async () => {
    const { parties, databaseIds } = await fixture();
    const { text, body } = await map();
    const keys = (value: object) => Object.keys(value).sort();
    expect(keys(body)).toEqual(['decisions', 'generatedAt', 'memories', 'totals']);
    expect(keys(body.totals)).toEqual(['learnedApprovals', 'memories', 'questionsAsked']);
    expect(body.memories.length).toBeGreaterThan(0);
    for (const row of body.memories) expect(keys(row)).toEqual(['amountUsdc', 'at', 'blobId', 'host', 'verdict']);
    expect(body.decisions.flatMap((row) => row.citations).length).toBeGreaterThan(0);
    for (const row of body.decisions) {
      expect(keys(row)).toEqual(['amountUsdc', 'at', 'citations', 'digest', 'host', 'id', 'outcome', 'rule']);
      for (const citation of row.citations) expect(keys(citation)).toEqual(['blobId', 'distance']);
    }
    const secrets = [MARKER, 'evil', 'The owner said', 'Book the room', 'A reason', RECIPIENT, RECIPIENT.slice(2), ...databaseIds];
    for (const p of parties) secrets.push(p.ownerId, p.agentId, p.suiAddress, p.suiAddress.slice(2), p.purseAddress, p.purseAddress.slice(2));
    for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it('leaves out a question of an opted-in owner with nothing on chain, and still after another answer is on chain, until its own answer is (C37)', async () => {
    const p = await party();
    const asked = await decision(p, { status: 'answered', createdAt: at(5_000) });
    const itsAnswer = await memory(p, 'its-answer', 'not_found_on_chain', { decisionId: asked });
    const reload = async () => {
      delete (globalThis as Record<string, unknown>).__ellaiMemoryMap;
      return (await map()).body;
    };
    expect(await reload()).toMatchObject({ decisions: [], totals: { questionsAsked: 0 } });

    // The owner is on the page now, but nothing on chain answers this question.
    await memory(p, 'another-answer', 'on_chain');
    expect(await reload()).toMatchObject({ decisions: [], totals: { questionsAsked: 0 } });

    await handle.db.update(memories).set({ chainConfirmedAt: at(1_000) }).where(eq(memories.id, itsAnswer));
    const shown = await reload();
    expect(shown.decisions.map((row) => [row.at, row.outcome])).toEqual([[at(5_000).toISOString(), 'asked']]);
    expect(shown.totals.questionsAsked).toBe(1);
  });

  it('lists a decision only when Sui or Walrus backs it, and counts only such questions, on the map and /proof alike (C37)', async () => {
    const p = await party();
    const yes = await memory(p, 'yes-on-chain', 'on_chain');
    const no = await memory(p, 'no-on-chain', 'on_chain', { verdict: 'refuse' });
    const paidDigest = toBase58(new Uint8Array(32).fill(8));

    // Left out: a limit refusal, an unanswered question, a grant whose payment is unverified, and
    // a question whose answer Walrus Memory has not been found storing.
    await decision(p, { outcome: 'refused', rule: 'over_payment_max', status: 'refused', createdAt: at(10_000) });
    await decision(p, { createdAt: at(20_000) });
    const unpaidGrant = await decision(p, { outcome: 'approved', rule: 'grant', status: 'paid', createdAt: at(30_000) });
    await paid(p, unpaidGrant, 'pending');
    const offChain = await decision(p, { status: 'answered', createdAt: at(35_000) });
    await memory(p, 'answer-not-found', 'not_found_on_chain', { decisionId: offChain });

    // Kept: a verified paid grant, learned approvals citing an answer on chain (paid or not), a
    // refused_recipient citing a refusal on chain, and a question whose own answer is on chain.
    const paidGrant = await decision(p, { outcome: 'approved', rule: 'grant', status: 'paid', createdAt: at(40_000) });
    await paid(p, paidGrant, 'verified', DIGEST);
    const learnedPaid = await decision(p, { outcome: 'approved', rule: 'learned', status: 'paid', createdAt: at(50_000) });
    await paid(p, learnedPaid, 'verified', paidDigest);
    await cite(p, learnedPaid, yes, 0.1);
    const learnedUnpaid = await decision(p, { outcome: 'approved', rule: 'learned', status: 'paid', createdAt: at(60_000) });
    await paid(p, learnedUnpaid, 'pending');
    await cite(p, learnedUnpaid, yes, 0.2);
    const refusedRecipient = await decision(p, { outcome: 'refused', rule: 'refused_recipient', status: 'refused', createdAt: at(70_000) });
    await cite(p, refusedRecipient, no, null);
    const answered = await decision(p, { status: 'answered', createdAt: at(80_000) });
    await memory(p, 'its-answer', 'on_chain', { decisionId: answered });

    const { body } = await map();
    expect(body.decisions.map((row) => [row.at, row.outcome, row.rule, row.digest, row.citations.map((c) => c.blobId)])).toEqual([
      [at(40_000).toISOString(), 'approved', 'grant', DIGEST, []],
      [at(50_000).toISOString(), 'approved', 'learned', paidDigest, ['yes-on-chain']],
      [at(60_000).toISOString(), 'approved', 'learned', null, ['yes-on-chain']],
      [at(70_000).toISOString(), 'refused', 'refused_recipient', null, ['no-on-chain']],
      [at(80_000).toISOString(), 'asked', 'no_match', null, []],
    ]);
    expect(body.totals).toEqual({ memories: 3, learnedApprovals: 1, questionsAsked: 1 });

    const proof = (await (await proofRoute.GET()).json()) as { totals: { approvedByLearning: number; askedDecisions: number } };
    expect([proof.totals.approvedByLearning, proof.totals.askedDecisions]).toEqual([body.totals.learnedApprovals, body.totals.questionsAsked]);
  });

  it('lists at most 200 answers and 50 decisions, newest first', async () => {
    const p = await party();
    const answers = Array.from({ length: LIMITS.memoryMapMemories + 1 }, (_, i) =>
      memoryValues(p, `answer-${i}`, 'on_chain', { confirmedAt: at((LIMITS.memoryMapMemories + 1 - i) * 1_000), chainConfirmedAt: at(1_000) }),
    );
    const answerIds = await handle.db.insert(memories).values(answers).returning({ id: memories.id });
    const listed = await handle.db
      .insert(decisions)
      .values(Array.from({ length: LIMITS.memoryMapDecisions + 1 }, (_, i) => decisionValues(p, { createdAt: at((LIMITS.memoryMapDecisions + 1 - i) * 1_000) })))
      .returning({ id: decisions.id });
    // Each cites an answer on chain, so every one of them may be listed (C37) and only the cap stops them.
    const cited = answerIds[0]?.id ?? '';
    await handle.db.insert(decisionCitations).values(listed.map((row) => ({ decisionId: row.id, memoryId: cited, ownerId: p.ownerId, distance: 0.1 })));
    expect([LIMITS.memoryMapMemories, LIMITS.memoryMapDecisions]).toEqual([200, 50]);

    const { body } = await map();
    expect(body.memories.map((row) => row.blobId)).toEqual(answers.slice(1).map((row) => row.blobId).reverse());
    expect(body.decisions.map((row) => row.at)).toEqual(
      Array.from({ length: LIMITS.memoryMapDecisions }, (_, i) => at((i + 1) * 1_000).toISOString()),
    );
    expect(body.totals.memories).toBe(LIMITS.memoryMapMemories + 1);
  });

  it('reads the database once per cache window, so a second call inside it makes no query, and answers with the headers /proof does', async () => {
    const p = await party();
    await memory(p, 'first-answer', 'on_chain');
    const selects = vi.spyOn(handle.db, 'select');

    const first = await map();
    expect(first.body.totals.memories).toBe(1);
    const readsPerRefresh = selects.mock.calls.length;
    expect(readsPerRefresh).toBeGreaterThan(0);
    expect(opened).toBe(1);

    await memory(p, 'second-answer', 'on_chain');
    nowMs += LIMITS.publicProofCacheMs - 1;
    const second = await map();
    expect(second.text).toBe(first.text);
    expect(selects.mock.calls.length).toBe(readsPerRefresh);
    expect(opened).toBe(1);

    nowMs += 1;
    expect((await map()).body.totals.memories).toBe(2);
    expect(opened).toBe(2);

    const proof = await proofRoute.GET();
    expect(proof.status).toBe(200);
    expect(Object.fromEntries(first.response.headers)).toEqual(Object.fromEntries(proof.headers));
    expect(first.response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 with no earlier copy when its read fails, logging a fixed code only', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    failing = true;
    const { response, text } = await map();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: 'proof_unavailable', message: 'The public proof cannot be read right now. Try again in a minute.' });
    expect(logged.mock.calls.flat()).toContain('[ellai memory-map] refresh_failed');
    expect(logged.mock.calls.flat().join(' ')).not.toContain(MARKER);
  });
});
