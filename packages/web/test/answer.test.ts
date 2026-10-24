// Covers: recording an owner's answer on PGlite: the answer, the pending owner_decision
// memory, the one grant a yes creates, and every state in which an answer is refused.
// Does NOT cover: writing the memory to Walrus (a later order), the owner's session or
// same-origin checks on the route that calls this, or two connections answering at once
// (PGlite serves one connection; the question row lock is taken but never waited on).
import { randomBytes } from 'node:crypto';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, grants, memories, owners, questions } from '../src/server/db/schema.js';
import { type AnswerArgs, AnswerError, answerQuestion } from '../src/server/decide/answer.js';
import { decide } from '../src/server/decide/decide.js';
import { ownerDecisionSentence } from '../src/server/decide/sentences.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  await handle.close();
});

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const DELEGATE = hex(32);
const NAMESPACE = 'ellai-test-v1';
const NOW = new Date('2026-10-24T10:00:00Z');
const RECIPIENT = `0x${'11'.repeat(32)}`;
const BODY = hex(32);

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

function payment(): CanonicalPayment {
  return {
    dialect: 'x402-v2',
    sellerUrl: 'https://hotels.example/v1/rooms',
    sellerHost: 'hotels.example',
    recipient: RECIPIENT,
    amount: 12_345n,
    asset: USDC_TYPE_MAINNET,
    network: 'sui:mainnet',
    expiresAtMs: NOW.getTime() + 60_000,
    challengeId: hex(8),
    nonce: '1',
    minEpoch: null,
    maxEpoch: null,
    resource: null,
  };
}

async function askedQuestion(): Promise<{ ownerId: string; decisionId: string }> {
  const owner = one(await db.insert(owners).values({ suiAddress: `0x${hex(32)}`, purseAddress: `0x${hex(32)}` }).returning());
  const agent = one(
    await db.insert(agents).values({ ownerId: owner.id, label: 'Test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_ab12' }).returning(),
  );
  const asked = await decide({
    db,
    ownerId: owner.id,
    agentId: agent.id,
    payment: payment(),
    method: 'POST',
    bodyHash: BODY,
    purpose: 'Book the hotel room',
    recall: async () => [],
    delegatePublicKeyHex: DELEGATE,
    namespace: NAMESPACE,
    now: NOW,
  });
  expect(asked.outcome).toBe('asked');
  return { ownerId: owner.id, decisionId: asked.decisionId };
}

function answer(q: { ownerId: string; decisionId: string }, overrides: Partial<AnswerArgs> = {}) {
  return answerQuestion({
    db,
    ownerId: q.ownerId,
    decisionId: q.decisionId,
    answer: 'approve',
    reason: 'I booked here before',
    delegatePublicKeyHex: DELEGATE,
    namespace: NAMESPACE,
    now: NOW,
    ...overrides,
  });
}

async function grantsFor(decisionId: string) {
  return db.select().from(grants).where(eq(grants.decisionId, decisionId));
}

describe('answerQuestion', () => {
  it('records a yes with one pending memory and one grant for exactly this payment', async () => {
    const q = await askedQuestion();
    const { memoryId, grantId } = await answer(q);

    const memory = one(await db.select().from(memories).where(eq(memories.id, memoryId)));
    expect(memory).toMatchObject({
      ownerId: q.ownerId,
      kind: 'owner_decision',
      decisionId: q.decisionId,
      verdict: 'approve',
      recipient: RECIPIENT,
      amountAtomic: 12_345n,
      sellerHost: 'hotels.example',
      namespace: NAMESPACE,
      writerPublicKey: DELEGATE,
      status: 'pending',
      blobId: null,
    });
    expect(memory.sentence).toBe(
      ownerDecisionSentence({
        verdict: 'approve',
        recipient: RECIPIENT,
        amountAtomic: 12_345n,
        sellerHost: 'hotels.example',
        purpose: 'Book the hotel room',
        reason: 'I booked here before',
        date: NOW,
      }),
    );

    const [grant, ...extra] = await grantsFor(q.decisionId);
    expect(extra).toEqual([]);
    expect(grant).toMatchObject({
      id: grantId,
      ownerId: q.ownerId,
      recipient: RECIPIENT,
      maxAmountAtomic: 12_345n,
      sellerUrl: 'https://hotels.example/v1/rooms',
      sellerMethod: 'POST',
      bodyHash: BODY,
    });
    expect(grant?.expiresAt.getTime()).toBe(NOW.getTime() + LIMITS.grantTtlMs);

    expect(one(await db.select().from(questions).where(eq(questions.decisionId, q.decisionId)))).toMatchObject({
      answer: 'approve',
      reason: 'I booked here before',
      answeredAt: NOW,
      memoryId,
    });
    expect(one(await db.select().from(decisions).where(eq(decisions.id, q.decisionId))).status).toBe('answered');
  });

  it('records a no with a pending refusal memory and no grant, keeping a blank reason as none', async () => {
    const q = await askedQuestion();
    const { memoryId, grantId } = await answer(q, { answer: 'refuse', reason: '   ' });
    expect(grantId).toBeNull();
    expect(await grantsFor(q.decisionId)).toEqual([]);
    expect(one(await db.select().from(memories).where(eq(memories.id, memoryId)))).toMatchObject({ verdict: 'refuse', status: 'pending' });
    expect(one(await db.select().from(questions).where(eq(questions.decisionId, q.decisionId)))).toMatchObject({ answer: 'refuse', reason: null });
  });

  it('refuses a second answer, leaving the first and its one grant as they were', async () => {
    const q = await askedQuestion();
    const first = await answer(q);
    await expect(answer(q, { answer: 'refuse' })).rejects.toThrow(new AnswerError('ANSWERED', 'this question has already been answered'));
    expect(await grantsFor(q.decisionId)).toHaveLength(1);
    expect((await db.select().from(memories).where(eq(memories.decisionId, q.decisionId))).map((m) => m.id)).toEqual([first.memoryId]);
  });

  it("refuses an answer to another owner's question with the same message as a missing one", async () => {
    const mine = await askedQuestion();
    const theirs = await askedQuestion();
    const notFound = new AnswerError('NOT_FOUND', 'there is no such question for this owner');
    await expect(answer({ ownerId: mine.ownerId, decisionId: theirs.decisionId })).rejects.toThrow(notFound);
    await expect(answer({ ownerId: mine.ownerId, decisionId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(notFound);
    expect(one(await db.select().from(questions).where(eq(questions.decisionId, theirs.decisionId))).answer).toBeNull();
    expect(await grantsFor(theirs.decisionId)).toEqual([]);
  });

  it("refuses an answer once the decision is no longer 'asked'", async () => {
    const q = await askedQuestion();
    await db.update(decisions).set({ status: 'expired' }).where(eq(decisions.id, q.decisionId));
    await expect(answer(q)).rejects.toMatchObject({ name: 'AnswerError', code: 'NOT_ASKED' });
    expect(await grantsFor(q.decisionId)).toEqual([]);
    expect(await db.select().from(memories).where(eq(memories.decisionId, q.decisionId))).toEqual([]);
  });

  it('refuses a reason over the cap before touching the database', async () => {
    const q = await askedQuestion();
    await expect(answer(q, { reason: 'r'.repeat(LIMITS.reasonMaxChars + 1) })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(one(await db.select().from(questions).where(eq(questions.decisionId, q.decisionId))).answer).toBeNull();
  });
});
