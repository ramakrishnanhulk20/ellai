// Covers: the fixed rules on their own (order, what counts as an approval, the question cap,
// fail-closed recall) with fast-check properties for the three outcomes that must never be
// "approved"; then decide on PGlite: reuse of a live decision, pending refusals, one-time
// grants, the agent and purpose checks, which recall hits may count, bad outcomes, the
// 24-hour budget window and the question cap.
// Does NOT cover: the live Walrus relayer or its ranking (recall is a stub everywhere here),
// the pay flow that moves an approved decision on, any HTTP or MCP route, or two connections
// blocking on the owner row lock. PGlite serves one connection and runs one transaction at a
// time, so the race test proves the re-read under the lock and the grant_uses key, not
// Postgres lock waits; db.test shows the lock itself is taken.
import { randomBytes, randomUUID } from 'node:crypto';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisionCitations, decisions, grantUses, memories, owners, payments, questions } from '../src/server/db/schema.js';
import { answerQuestion } from '../src/server/decide/answer.js';
import { type DecideArgs, DecideError, type Recall, decide } from '../src/server/decide/decide.js';
import { type DecideFacts, type RecallHit, type RecallResult, applyRules } from '../src/server/decide/rules.js';
import { querySentence } from '../src/server/decide/sentences.js';

const RECIPIENT = `0x${'11'.repeat(32)}`;
const OTHER_RECIPIENT = `0x${'22'.repeat(32)}`;

function approval(overrides: Partial<RecallHit> = {}): RecallHit {
  return {
    memoryId: randomUUID(),
    verdict: 'approve',
    recipient: RECIPIENT,
    amountAtomic: 20_000n,
    distance: 0.1,
    countsAsOwnerDecision: true,
    ...overrides,
  };
}

function hits(list: RecallHit[], limitReached = false): RecallResult {
  return { kind: 'hits', limitReached, hits: list };
}

function facts(overrides: Partial<DecideFacts> = {}, settings: Partial<DecideFacts['settings']> = {}): DecideFacts {
  return {
    settings: {
      paused: false,
      autoPausedReason: null,
      perPaymentMaxAtomic: 50_000n,
      dailyBudgetAtomic: 500_000n,
      approvalsNeeded: 2,
      distanceCutoff: 0.5,
      ...settings,
    },
    spentLast24hAtomic: 0n,
    amountAtomic: 10_000n,
    recipient: RECIPIENT,
    sellerHost: 'hotels.example',
    refusalMemoryIds: [],
    badOutcomes: [],
    pendingQuestions: 0,
    maxPending: 5,
    recall: hits([]),
    ...overrides,
  };
}

const badOutcome = (outcomeMemoryIds: string[] = [], amountAtomic = 10_000n, signedAt = new Date('2026-10-24T08:00:00Z')) => ({
  paymentId: randomUUID(),
  amountAtomic,
  signedAt,
  outcomeMemoryIds,
});

describe('applyRules', () => {
  it('fires every rule in order, each one winning over every later one', () => {
    const refusal = randomUUID();
    const two = [approval(), approval()];
    const everything = facts(
      {
        amountAtomic: 60_000n,
        spentLast24hAtomic: 495_000n,
        refusalMemoryIds: [refusal],
        badOutcomes: [badOutcome()],
        grantId: randomUUID(),
        recall: { kind: 'failed' },
      },
      { paused: true },
    );
    // Each step removes the trigger of the rule that just fired, so the next one down shows.
    const steps: [Partial<DecideFacts>, string, string][] = [
      [{}, 'refused', 'paused'],
      [{ settings: { ...everything.settings, paused: false } }, 'refused', 'over_payment_max'],
      [{ amountAtomic: 10_000n }, 'refused', 'over_daily_budget'],
      [{ spentLast24hAtomic: 0n }, 'refused', 'refused_recipient'],
      [{ refusalMemoryIds: [] }, 'asked', 'bad_outcome'],
      [{ badOutcomes: [] }, 'approved', 'grant'],
      [{ grantId: undefined }, 'asked', 'recall_unavailable'],
      [{ recall: hits(two) }, 'approved', 'learned'],
      [{ recall: hits(two.slice(1)) }, 'asked', 'no_match'],
    ];
    let current = everything;
    const seen = steps.map(([change]) => {
      current = { ...current, ...change };
      const decided = applyRules(current);
      return [decided.outcome, decided.rule];
    });
    expect(seen).toEqual(steps.map(([, outcome, rule]) => [outcome, rule]));
    expect(applyRules(facts({}, { autoPausedReason: 'settlement mismatch' })).rule).toBe('paused');
  });

  it('lets a refusal beat ten learned approvals and a grant, citing the refusal', () => {
    const refusal = randomUUID();
    const decided = applyRules(
      facts({ refusalMemoryIds: [refusal], grantId: randomUUID(), recall: hits(Array.from({ length: 10 }, () => approval())) }),
    );
    expect(decided).toMatchObject({ outcome: 'refused', rule: 'refused_recipient', citedMemoryIds: [refusal] });
    expect(decided.reason).toBe('You refused payments to hotels.example before.');
  });

  it('never counts approvals for another recipient', () => {
    expect(applyRules(facts({ recall: hits([approval({ recipient: OTHER_RECIPIENT }), approval({ recipient: OTHER_RECIPIENT })]) })).rule).toBe(
      'no_match',
    );
  });

  it('never counts an outcome hit, a hit Ellai did not write, or a refusal hit as an approval', () => {
    const notOwnerDecisions = [approval({ countsAsOwnerDecision: false }), approval({ countsAsOwnerDecision: false })];
    expect(applyRules(facts({ recall: hits(notOwnerDecisions) })).rule).toBe('no_match');
    expect(applyRules(facts({ recall: hits([approval({ verdict: 'refuse' }), approval({ verdict: 'refuse' })]) })).rule).toBe('no_match');
  });

  it('never counts an approval below this amount, and counts one at exactly this amount', () => {
    expect(applyRules(facts({ recall: hits([approval({ amountAtomic: 9_999n }), approval({ amountAtomic: 9_999n })]) })).rule).toBe('no_match');
    expect(applyRules(facts({ recall: hits([approval({ amountAtomic: 10_000n }), approval({ amountAtomic: 10_000n })]) })).rule).toBe('learned');
  });

  it('never counts a hit at or past the distance cutoff, or one with no numeric distance', () => {
    for (const distance of [0.5, 0.9, Number.NaN]) {
      expect(applyRules(facts({ recall: hits([approval({ distance }), approval({ distance })]) })).rule).toBe('no_match');
    }
  });

  it('approves at exactly approvalsNeeded close approvals, citing exactly those, and asks at one fewer', () => {
    const three = [approval(), approval({ amountAtomic: 30_000n }), approval()];
    const decided = applyRules(facts({ recall: hits([...three, approval({ recipient: OTHER_RECIPIENT })]) }, { approvalsNeeded: 3 }));
    expect(decided).toMatchObject({ outcome: 'approved', rule: 'learned' });
    expect(decided.citedMemoryIds.sort()).toEqual(three.map((hit) => hit.memoryId).sort());
    expect(decided.reason).toBe('You approved 3 payments like this to hotels.example, up to 0.030000 USDC.');

    const short = applyRules(facts({ recall: hits(three.slice(1)) }, { approvalsNeeded: 3 }));
    expect(short).toMatchObject({ outcome: 'asked', rule: 'no_match', citedMemoryIds: [] });
    expect(short.reason).toBe('You approved 2 payments like this to hotels.example. Ellai needs 3 before it pays on its own.');

    const [first] = three;
    if (first === undefined) throw new Error('expected an approval');
    expect(applyRules(facts({ recall: hits([first, { ...first }]) })).rule).toBe('no_match');
  });

  it('asks when recall failed, and when it reached its limit even with enough approvals', () => {
    expect(applyRules(facts({ recall: { kind: 'failed' } }))).toMatchObject({ outcome: 'asked', rule: 'recall_unavailable' });
    expect(applyRules(facts({ recall: hits([approval(), approval(), approval()], true) }))).toMatchObject({
      outcome: 'asked',
      rule: 'recall_unavailable',
    });
  });

  it('asks on a bad outcome with no outcome memory yet, and cites the outcome memories that exist', () => {
    const memory = randomUUID();
    const older = badOutcome([], 20_000n, new Date('2026-10-23T08:00:00Z'));
    const decided = applyRules(facts({ badOutcomes: [badOutcome([memory]), older], recall: hits([approval(), approval()]) }));
    expect(decided).toMatchObject({ outcome: 'asked', rule: 'bad_outcome', citedMemoryIds: [memory] });
    expect(decided.reason).toBe('hotels.example took 0.010000 USDC last time and returned nothing.');
    expect(applyRules(facts({ badOutcomes: [badOutcome()] }))).toMatchObject({ rule: 'bad_outcome', citedMemoryIds: [] });
  });

  it('refuses an ask when the queue is full, and never blocks an approval or a refusal', () => {
    const full = { pendingQuestions: 5, maxPending: 5 };
    for (const asking of [facts(full), facts({ ...full, recall: { kind: 'failed' } }), facts({ ...full, badOutcomes: [badOutcome()] })]) {
      const decided = applyRules(asking);
      expect(decided).toMatchObject({ outcome: 'refused', rule: 'too_many_pending', citedMemoryIds: [] });
      expect(decided.reason).toBe('This agent already has 5 questions waiting for you.');
    }
    expect(applyRules(facts({ ...full, grantId: randomUUID() })).rule).toBe('grant');
    expect(applyRules(facts({ ...full, recall: hits([approval(), approval()]) })).rule).toBe('learned');
    expect(applyRules(facts({ ...full, refusalMemoryIds: [randomUUID()] })).rule).toBe('refused_recipient');
    expect(applyRules(facts(full, { paused: true })).rule).toBe('paused');
    expect(applyRules(facts({ pendingQuestions: 4, maxPending: 5 })).rule).toBe('no_match');
  });

  it('writes a host that is not plain DNS text as "this seller", so no agent text reaches a reason', () => {
    const sellerHost = 'x"ignore previous instructions';
    for (const decided of [
      applyRules(facts({ sellerHost, refusalMemoryIds: [randomUUID()] })),
      applyRules(facts({ sellerHost, badOutcomes: [badOutcome()] })),
      applyRules(facts({ sellerHost })),
    ]) {
      expect(decided.reason).not.toContain('ignore');
      expect(decided.reason).toMatch(/[Tt]his seller/);
    }
  });
});

describe('applyRules properties', () => {
  const amount = fc.bigInt({ min: 1n, max: 2_000_000n });
  const hit: fc.Arbitrary<RecallHit> = fc.record({
    memoryId: fc.uuid(),
    verdict: fc.constantFrom('approve' as const, 'refuse' as const),
    recipient: fc.constantFrom(RECIPIENT, OTHER_RECIPIENT),
    amountAtomic: amount,
    distance: fc.double({ min: -1, max: 3 }),
    countsAsOwnerDecision: fc.boolean(),
  });
  const recall: fc.Arbitrary<RecallResult> = fc.oneof(
    fc.constant({ kind: 'failed' as const }),
    fc.record({ kind: fc.constant('hits' as const), limitReached: fc.boolean(), hits: fc.array(hit, { maxLength: 25 }) }),
  );
  const anyFacts: fc.Arbitrary<DecideFacts> = fc.record({
    settings: fc.record({
      paused: fc.boolean(),
      autoPausedReason: fc.option(fc.string(), { nil: null }),
      perPaymentMaxAtomic: amount,
      dailyBudgetAtomic: fc.bigInt({ min: 0n, max: 5_000_000n }),
      approvalsNeeded: fc.integer({ min: -1, max: 12 }),
      distanceCutoff: fc.double({ min: -1, max: 3 }),
    }),
    spentLast24hAtomic: fc.bigInt({ min: 0n, max: 5_000_000n }),
    amountAtomic: amount,
    recipient: fc.constant(RECIPIENT),
    sellerHost: fc.string(),
    refusalMemoryIds: fc.array(fc.uuid(), { maxLength: 4 }),
    badOutcomes: fc.array(
      fc.record({ paymentId: fc.uuid(), amountAtomic: amount, signedAt: fc.date({ noInvalidDate: true }), outcomeMemoryIds: fc.array(fc.uuid(), { maxLength: 3 }) }),
      { maxLength: 3 },
    ),
    grantId: fc.option(fc.uuid(), { nil: undefined }),
    pendingQuestions: fc.integer({ min: 0, max: 10 }),
    maxPending: fc.integer({ min: 0, max: 10 }),
    recall,
  });
  const runs = { numRuns: 2_000 };

  it('never approves when a refusal memory exists for the recipient', () => {
    fc.assert(
      fc.property(anyFacts, fc.uuid(), (f, refusal) => applyRules({ ...f, refusalMemoryIds: [refusal, ...f.refusalMemoryIds] }).outcome !== 'approved'),
      runs,
    );
  });

  it('never approves while paused', () => {
    fc.assert(fc.property(anyFacts, (f) => applyRules({ ...f, settings: { ...f.settings, paused: true } }).outcome !== 'approved'), runs);
  });

  it('never approves, without a grant, when no recalled approval is for this recipient', () => {
    fc.assert(
      fc.property(anyFacts, fc.array(hit, { maxLength: 25 }), fc.boolean(), (f, list, limitReached) => {
        const elsewhere = list.map((h) => ({ ...h, recipient: OTHER_RECIPIENT }));
        return applyRules({ ...f, grantId: undefined, recall: hits(elsewhere, limitReached) }).outcome !== 'approved';
      }),
      runs,
    );
  });
});

describe('decide', () => {
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
  const BODY = hex(32);
  const PURPOSE = 'Find a room in Lisbon for two nights';
  const noHits: Recall = async () => [];

  interface World {
    ownerId: string;
    agentId: string;
  }

  function one<T>(rows: T[]): T {
    const [row] = rows;
    if (row === undefined) throw new Error('expected a row');
    return row;
  }

  async function newAgent(ownerId: string, overrides: Partial<typeof agents.$inferInsert> = {}): Promise<string> {
    const values = { ownerId, label: 'Test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_ab12', ...overrides } as const;
    return one(await db.insert(agents).values(values).returning()).id;
  }

  async function world(owner: Partial<typeof owners.$inferInsert> = {}, agent: Partial<typeof agents.$inferInsert> = {}): Promise<World> {
    const row = one(await db.insert(owners).values({ suiAddress: `0x${hex(32)}`, purseAddress: `0x${hex(32)}`, ...owner }).returning());
    return { ownerId: row.id, agentId: await newAgent(row.id, agent) };
  }

  function payment(now: Date = NOW, overrides: Partial<CanonicalPayment> = {}): CanonicalPayment {
    return {
      dialect: 'x402-v2',
      sellerUrl: 'https://hotels.example/v1/rooms',
      sellerHost: 'hotels.example',
      recipient: RECIPIENT,
      amount: 10_000n,
      asset: USDC_TYPE_MAINNET,
      network: 'sui:mainnet',
      expiresAtMs: now.getTime() + 60_000,
      challengeId: hex(8),
      nonce: String(randomBytes(4).readUInt32BE()),
      minEpoch: null,
      maxEpoch: null,
      resource: null,
      ...overrides,
    };
  }

  function run(w: World, overrides: Partial<DecideArgs> = {}) {
    const now = overrides.now ?? NOW;
    return decide({
      db,
      ownerId: w.ownerId,
      agentId: w.agentId,
      payment: payment(now),
      method: 'GET',
      bodyHash: BODY,
      purpose: PURPOSE,
      recall: noHits,
      delegatePublicKeyHex: DELEGATE,
      namespace: NAMESPACE,
      now,
      ...overrides,
    });
  }

  function ownerAnswer(w: World, decisionId: string, answer: 'approve' | 'refuse', now = NOW) {
    return answerQuestion({ db, ownerId: w.ownerId, decisionId, answer, reason: null, delegatePublicKeyHex: DELEGATE, namespace: NAMESPACE, now });
  }

  async function rowCounts(ownerId: string) {
    return {
      decisions: (await db.select().from(decisions).where(eq(decisions.ownerId, ownerId))).length,
      questions: (await db.select().from(questions).where(eq(questions.ownerId, ownerId))).length,
      citations: (await db.select().from(decisionCitations).where(eq(decisionCitations.ownerId, ownerId))).length,
      grantUses: (await db.select().from(grantUses).where(eq(grantUses.ownerId, ownerId))).length,
    };
  }

  async function pastDecision(w: World, overrides: Partial<typeof decisions.$inferInsert> = {}) {
    const values = {
      ownerId: w.ownerId,
      agentId: w.agentId,
      requestKey: hex(32),
      sellerUrl: 'https://hotels.example/v1/rooms',
      sellerMethod: 'GET',
      sellerHost: 'hotels.example',
      bodyHash: BODY,
      purpose: 'An earlier request',
      recipient: RECIPIENT,
      amountAtomic: 10_000n,
      asset: USDC_TYPE_MAINNET,
      network: 'sui:mainnet',
      expiresAt: NOW,
      outcome: 'approved',
      rule: 'learned',
      reason: 'An earlier reason.',
      status: 'paid',
      ...overrides,
    } satisfies typeof decisions.$inferInsert;
    return one(await db.insert(decisions).values(values).returning());
  }

  async function signedPayment(w: World, amountAtomic: bigint, signedAt: Date, overrides: Partial<typeof payments.$inferInsert> = {}) {
    const decision = await pastDecision(w, { amountAtomic });
    const values = {
      decisionId: decision.id,
      ownerId: w.ownerId,
      purseAddress: `0x${hex(32)}`,
      recipient: RECIPIENT,
      amountAtomic,
      digest: randomBytes(32).toString('base64url'),
      txBytesBase64: 'AA==',
      signedAt,
      validUntilEpoch: 900n,
      ...overrides,
    } satisfies typeof payments.$inferInsert;
    return { decision, payment: one(await db.insert(payments).values(values).returning()) };
  }

  async function approvalMemory(w: World, overrides: Partial<typeof memories.$inferInsert> = {}) {
    const values = {
      ownerId: w.ownerId,
      kind: 'owner_decision',
      recipient: RECIPIENT,
      amountAtomic: 20_000n,
      verdict: 'approve',
      sellerHost: 'hotels.example',
      sentence: 'The owner approved.',
      namespace: NAMESPACE,
      writerPublicKey: DELEGATE,
      blobId: hex(16),
      status: 'confirmed',
      ...overrides,
    } satisfies typeof memories.$inferInsert;
    return one(await db.insert(memories).values(values).returning());
  }

  const recallOf =
    (rows: Array<{ blobId: string | null }>, distance = 0.1): Recall =>
    async () =>
      rows.map((row) => ({ blobId: row.blobId ?? '', distance }));

  it('asks the first time, recording the decision and its question', async () => {
    const w = await world();
    const recall = vi.fn(noHits);
    const p = payment();
    const result = await run(w, { recall, payment: p, purpose: `  ${PURPOSE}  ` });
    expect(result).toMatchObject({
      outcome: 'asked',
      rule: 'no_match',
      reused: false,
      citedMemoryIds: [],
      reason: 'You have not approved a payment like this to hotels.example yet.',
    });
    expect(recall).toHaveBeenCalledWith(querySentence({ payment: p, purpose: PURPOSE }), LIMITS.decideRecallLimit);
    const row = one(await db.select().from(decisions).where(eq(decisions.id, result.decisionId)));
    expect(row).toMatchObject({ status: 'asked', purpose: PURPOSE, recipient: RECIPIENT, amountAtomic: 10_000n, challengeId: p.challengeId });
    expect(row.expiresAt.getTime()).toBe(p.expiresAtMs);
    const question = one(await db.select().from(questions).where(eq(questions.decisionId, result.decisionId)));
    expect(question).toMatchObject({ ownerId: w.ownerId, answer: null, answeredAt: null });
  });

  it('returns the same decision for a retry with a fresh challenge, and writes nothing', async () => {
    const w = await world();
    const first = await run(w);
    const before = await rowCounts(w.ownerId);
    const recall = vi.fn(noHits);
    const again = await run(w, { recall });
    expect(again).toEqual({ ...first, reused: true });
    expect(recall).not.toHaveBeenCalled();
    expect(await rowCounts(w.ownerId)).toEqual(before);
  });

  it('refuses after an owner refusal still waiting for its Walrus write, without calling recall', async () => {
    const w = await world();
    const asked = await run(w);
    const { memoryId } = await ownerAnswer(w, asked.decisionId, 'refuse');
    const stored = one(await db.select().from(memories).where(eq(memories.id, memoryId)));
    expect(stored).toMatchObject({ status: 'pending', blobId: null });

    const recall = vi.fn(noHits);
    const result = await run(w, { recall, purpose: 'A different purpose entirely' });
    expect(result).toMatchObject({ outcome: 'refused', rule: 'refused_recipient', citedMemoryIds: [memoryId] });
    expect(recall).not.toHaveBeenCalled();
    expect(one(await db.select().from(decisions).where(eq(decisions.id, result.decisionId))).status).toBe('refused');
    expect(await db.select().from(decisionCitations).where(eq(decisionCitations.decisionId, result.decisionId))).toEqual([
      { decisionId: result.decisionId, memoryId, ownerId: w.ownerId },
    ]);
  });

  it("turns the owner's yes into exactly one approval, and the next retry asks again", async () => {
    const w = await world();
    const asked = await run(w);
    const { grantId } = await ownerAnswer(w, asked.decisionId, 'approve');

    const retry = await run(w);
    expect(retry).toMatchObject({ outcome: 'approved', rule: 'grant', reused: false });
    expect(one(await db.select().from(decisions).where(eq(decisions.id, retry.decisionId))).status).toBe('open');
    expect(await db.select({ grantId: grantUses.grantId, decisionId: grantUses.decisionId }).from(grantUses).where(eq(grantUses.ownerId, w.ownerId))).toEqual([
      { grantId, decisionId: retry.decisionId },
    ]);

    // The pay flow moves an approved decision on; until then the same request returns it.
    expect((await run(w)).reused).toBe(true);
    await db.update(decisions).set({ status: 'paid' }).where(eq(decisions.id, retry.decisionId));
    expect(await run(w)).toMatchObject({ outcome: 'asked', rule: 'no_match', reused: false });
  });

  it('does not approve with an expired grant', async () => {
    const w = await world();
    const asked = await run(w);
    await ownerAnswer(w, asked.decisionId, 'approve');
    const later = new Date(NOW.getTime() + LIMITS.grantTtlMs + 1);
    expect(await run(w, { now: later })).toMatchObject({ outcome: 'asked', rule: 'no_match' });
  });

  it('does not approve with a grant for a different seller url, or for another agent of the same owner', async () => {
    const w = await world();
    const asked = await run(w);
    await ownerAnswer(w, asked.decisionId, 'approve');
    const otherUrl = payment(NOW, { sellerUrl: 'https://hotels.example/v1/rooms?city=porto' });
    expect(await run(w, { payment: otherUrl })).toMatchObject({ outcome: 'asked', rule: 'no_match' });
    const sibling = { ownerId: w.ownerId, agentId: await newAgent(w.ownerId) };
    expect(await run(sibling)).toMatchObject({ outcome: 'asked', rule: 'no_match' });
    expect(await rowCounts(w.ownerId)).toMatchObject({ grantUses: 0 });
  });

  it("refuses another owner's agent, a revoked agent, and an empty or oversized purpose with DecideError", async () => {
    const w = await world();
    const stranger = await world();
    const revoked = { ownerId: w.ownerId, agentId: await newAgent(w.ownerId, { revokedAt: NOW }) };
    for (const attempt of [run({ ownerId: w.ownerId, agentId: stranger.agentId }), run(revoked)]) {
      await expect(attempt).rejects.toThrow(new DecideError('AGENT', 'the agent is not an active agent of this owner'));
    }
    for (const purpose of ['', '   \n ', 'a'.repeat(LIMITS.purposeMaxChars + 1)]) {
      await expect(run(w, { purpose })).rejects.toMatchObject({ name: 'DecideError', code: 'BAD_PURPOSE' });
    }
    expect((await run(w, { purpose: 'a'.repeat(LIMITS.purposeMaxChars) })).outcome).toBe('asked');
    expect(await rowCounts(stranger.ownerId)).toMatchObject({ decisions: 0 });
  });

  it('lets only one of two racing decides spend one grant', async () => {
    const w = await world();
    const asked = await run(w);
    const { grantId } = await ownerAnswer(w, asked.decisionId, 'approve');
    if (grantId === null) throw new Error('expected a grant');

    const raced = await Promise.all([run(w, { purpose: 'Book the room, first try' }), run(w, { purpose: 'Book the room, second try' })]);
    expect(raced.map((r) => r.rule).sort()).toEqual(['grant', 'recall_unavailable']);
    const uses = await db.select().from(grantUses).where(eq(grantUses.grantId, grantId));
    expect(uses).toHaveLength(1);

    const loser = raced.find((r) => r.rule !== 'grant');
    if (loser === undefined) throw new Error('expected a loser');
    await expect(db.insert(grantUses).values({ grantId, ownerId: w.ownerId, decisionId: loser.decisionId })).rejects.toThrow();
    expect(await db.select().from(grantUses).where(eq(grantUses.grantId, grantId))).toHaveLength(1);
  });

  it('approves nothing from recall hits whose blob ids Ellai does not know', async () => {
    const w = await world();
    const unknown = Array.from({ length: 5 }, () => ({ blobId: hex(16) }));
    expect(await run(w, { recall: recallOf(unknown, 0.01) })).toMatchObject({ outcome: 'asked', rule: 'no_match', citedMemoryIds: [] });
  });

  it("learns only from this owner's approvals that Ellai wrote, in this namespace", async () => {
    const w = await world();
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    const learned = await run(w, { recall: recallOf(pair) });
    expect(learned).toMatchObject({ outcome: 'approved', rule: 'learned' });
    expect(learned.citedMemoryIds.sort()).toEqual(pair.map((m) => m.id).sort());
    expect(one(await db.select().from(decisions).where(eq(decisions.id, learned.decisionId))).status).toBe('open');

    const cases: Array<(x: World) => Promise<Array<{ blobId: string | null }>>> = [
      async (x) => [await approvalMemory(x, { writerPublicKey: hex(32) }), await approvalMemory(x, { writerPublicKey: hex(32) })],
      async (x) => [await approvalMemory(x, { namespace: 'ellai-demo-v1' }), await approvalMemory(x, { namespace: 'ellai-demo-v1' })],
      async () => {
        const stranger = await world();
        return [await approvalMemory(stranger), await approvalMemory(stranger)];
      },
      async (x) => [await approvalMemory(x, { kind: 'outcome' }), await approvalMemory(x, { kind: 'outcome' })],
    ];
    for (const make of cases) {
      const x = await world();
      expect(await run(x, { recall: recallOf(await make(x)) })).toMatchObject({ outcome: 'asked', rule: 'no_match' });
    }
  });

  it('asks when recall throws, returns a hit without a finite distance, reaches its limit, or times out', async () => {
    const w = await world();
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    const full = [...pair, ...Array.from({ length: LIMITS.decideRecallLimit - 2 }, () => ({ blobId: hex(16) }))];
    const failing: Recall[] = [
      async () => {
        throw new Error('relayer down');
      },
      async () => [...(await recallOf(pair)('', 0)), { blobId: hex(16), distance: Number.NaN }],
      recallOf(full),
    ];
    for (const [index, recall] of failing.entries()) {
      expect(await run(w, { recall, purpose: `${PURPOSE} ${index}` })).toMatchObject({ outcome: 'asked', rule: 'recall_unavailable' });
    }

    let reached: () => void = () => undefined;
    const called = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hanging: Recall = () => {
      reached();
      return new Promise(() => undefined);
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = run(w, { recall: hanging, purpose: `${PURPOSE} hanging` });
      await called;
      await vi.advanceTimersByTimeAsync(LIMITS.decideRecallTimeoutMs);
      vi.useRealTimers();
      expect(await pending).toMatchObject({ outcome: 'asked', rule: 'recall_unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks after a verified payment that returned nothing, until the owner approves the recipient again', async () => {
    const w = await world();
    const { decision } = await signedPayment(w, 10_000n, new Date(NOW.getTime() - 3_600_000), { settlement: 'verified', delivered: false });
    const pair = [await approvalMemory(w, { createdAt: new Date(NOW.getTime() - 7_200_000) }), await approvalMemory(w, { createdAt: new Date(NOW.getTime() - 7_200_000) })];

    const noMemoryYet = await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 1` });
    expect(noMemoryYet).toMatchObject({ outcome: 'asked', rule: 'bad_outcome', citedMemoryIds: [] });
    expect(noMemoryYet.reason).toBe('hotels.example took 0.010000 USDC last time and returned nothing.');

    const outcome = one(
      await db
        .insert(memories)
        .values({ ownerId: w.ownerId, kind: 'outcome', decisionId: decision.id, sentence: 'The seller returned nothing.', namespace: NAMESPACE, writerPublicKey: DELEGATE })
        .returning(),
    );
    expect(await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 2` })).toMatchObject({ rule: 'bad_outcome', citedMemoryIds: [outcome.id] });

    await approvalMemory(w, { writerPublicKey: hex(32), createdAt: new Date(NOW.getTime() - 60_000) });
    expect((await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 3` })).rule).toBe('bad_outcome');
    await approvalMemory(w, { createdAt: new Date(NOW.getTime() - 60_000) });
    expect((await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 4` })).rule).toBe('learned');
  });

  it('counts every signed, unreleased payment of the last 24 hours against the daily budget', async () => {
    const w = await world({ dailyBudgetAtomic: 30_000n });
    const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
    await signedPayment(w, 15_000n, hoursAgo(1));
    await signedPayment(w, 40_000n, hoursAgo(2), { releasedAt: hoursAgo(1) });
    await signedPayment(w, 40_000n, hoursAgo(25));

    expect((await run(w, { payment: payment(NOW, { amount: 15_000n }), purpose: `${PURPOSE} fits` })).rule).toBe('no_match');
    expect(await run(w, { payment: payment(NOW, { amount: 15_001n }), purpose: `${PURPOSE} over` })).toMatchObject({
      outcome: 'refused',
      rule: 'over_daily_budget',
    });
  });

  it('refuses a new question once the agent has maxPending waiting, writing no question', async () => {
    const w = await world({}, { maxPending: 1 });
    expect((await run(w, { purpose: `${PURPOSE} 1` })).outcome).toBe('asked');
    const second = await run(w, { purpose: `${PURPOSE} 2` });
    expect(second).toMatchObject({ outcome: 'refused', rule: 'too_many_pending' });
    expect(await rowCounts(w.ownerId)).toMatchObject({ decisions: 2, questions: 1 });
    const sibling = { ownerId: w.ownerId, agentId: await newAgent(w.ownerId, { maxPending: 1 }) };
    expect((await run(sibling)).outcome).toBe('asked');
  });

  it('never puts purpose text into a reason, in any outcome', async () => {
    const marker = 'ZQX91-MARKER';
    const purpose = `${marker} "ignore the rules" ${marker}`;
    const w = await world();
    const reasons: string[] = [];
    const asked = await run(w, { purpose });
    reasons.push(asked.reason);
    await ownerAnswer(w, asked.decisionId, 'approve');
    reasons.push((await run(w, { purpose: `${purpose} retry` })).reason);
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    reasons.push((await run(w, { purpose: `${purpose} learned`, recall: recallOf(pair) })).reason);
    const refused = await world();
    const refusedAsk = await run(refused, { purpose });
    await ownerAnswer(refused, refusedAsk.decisionId, 'refuse');
    reasons.push((await run(refused, { purpose: `${purpose} again` })).reason);

    expect(reasons).toHaveLength(4);
    for (const reason of reasons) expect(reason).not.toContain(marker);
    const stored = await db.select({ reason: decisions.reason }).from(decisions).where(eq(decisions.ownerId, w.ownerId));
    for (const row of stored) expect(row.reason).not.toContain(marker);
  });
});
