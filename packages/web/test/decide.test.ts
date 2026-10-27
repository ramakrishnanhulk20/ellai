// Covers: the fixed rules on their own (order, what counts as an approval, the question cap,
// fail-closed recall) with fast-check properties for the three outcomes that must never be
// "approved"; then decide on PGlite: reuse of a live decision, pending refusals and refusals
// under any namespace label, one-time grants, the agent and purpose checks, which recall hits
// may count, the distance kept on a learned approval's citations and on no other, bad outcomes (worded from the worst, cleared only by a yes to a question asked
// after the outcome was recorded), the daily budget (the 24-hour window, counted from the later
// of signing and verification, and pending payments however old), the clock read inside the
// transaction for the grant expiry and the decision's time, and the question cap.
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
import { agents, decisionCitations, decisions, grantUses, grants, memories, owners, payments, questions } from '../src/server/db/schema.js';
import { answerQuestion } from '../src/server/decide/answer.js';
import { type DecideArgs, DecideError, type Recall, decide } from '../src/server/decide/decide.js';
import { type BadOutcome, type DecideFacts, type RecallHit, type RecallResult, applyRules } from '../src/server/decide/rules.js';
import { querySentence } from '../src/server/decide/sentences.js';
import { heldOrSpentAtomic } from '../src/server/pay/liability.js';

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

function hits(list: RecallHit[], cutOffAt: number | null = null): RecallResult {
  return { kind: 'hits', cutOffAt, hits: list };
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
    heldOrSpentAtomic: 0n,
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

const badOutcome = (
  outcomeMemoryIds: string[] = [],
  amountAtomic = 10_000n,
  signedAt = new Date('2026-10-24T08:00:00Z'),
  record: Pick<BadOutcome, 'delivered' | 'settlement'> = { delivered: false, settlement: 'verified' },
): BadOutcome => ({
  paymentId: randomUUID(),
  amountAtomic,
  signedAt,
  ...record,
  outcomeMemoryIds,
});

describe('applyRules', () => {
  it('fires every rule in order, each one winning over every later one', () => {
    const refusal = randomUUID();
    const two = [approval(), approval()];
    const everything = facts(
      {
        amountAtomic: 60_000n,
        heldOrSpentAtomic: 495_000n,
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
      [{ heldOrSpentAtomic: 0n }, 'refused', 'refused_recipient'],
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

  const CUT_REASON = 'Ellai found more past answers like this than it can check at once, so it is asking you.';

  it('asks when recall failed, and when a full result ends inside the cutoff with too few approvals in view', () => {
    expect(applyRules(facts({ recall: { kind: 'failed' } }))).toMatchObject({
      outcome: 'asked',
      rule: 'recall_unavailable',
      reason: 'Ellai could not check your past answers just now, so it is asking you.',
    });
    for (const cutOffAt of [0.1, 0.4999, Number.NaN]) {
      expect(applyRules(facts({ recall: hits([approval()], cutOffAt) }))).toMatchObject({ outcome: 'asked', rule: 'recall_unavailable', reason: CUT_REASON, citedMemoryIds: [] });
      expect(applyRules(facts({ recall: hits([], cutOffAt) }))).toMatchObject({ outcome: 'asked', rule: 'recall_unavailable', reason: CUT_REASON });
    }
    expect(applyRules(facts({ recall: hits([approval(), approval()], 1.2) }, { distanceCutoff: Number.NaN }))).toMatchObject({
      rule: 'recall_unavailable',
      reason: CUT_REASON,
    });
    expect(applyRules(facts({ pendingQuestions: 5, maxPending: 5, recall: hits([approval()], 0.1) })).rule).toBe('too_many_pending');
  });

  it('approves from a full result ending inside the cutoff once the approvals in view reach approvalsNeeded, since hidden hits can only add approvals', () => {
    const three = [approval(), approval(), approval()];
    for (const cutOffAt of [0.1, 0.4999, Number.NaN]) {
      const decided = applyRules(facts({ recall: hits(three, cutOffAt) }, { approvalsNeeded: 3 }));
      expect(decided).toMatchObject({ outcome: 'approved', rule: 'learned' });
      expect(decided.citedMemoryIds.sort()).toEqual(three.map((hit) => hit.memoryId).sort());
      expect(applyRules(facts({ recall: hits(three.slice(1), cutOffAt) }, { approvalsNeeded: 3 })).rule).toBe('recall_unavailable');
      // A refusal or a bad outcome is found by exact lookup, so no cut result can hide one.
      expect(applyRules(facts({ recall: hits(three, cutOffAt), refusalMemoryIds: [randomUUID()] })).rule).toBe('refused_recipient');
      expect(applyRules(facts({ recall: hits(three, cutOffAt), badOutcomes: [badOutcome()] })).rule).toBe('bad_outcome');
    }
  });

  it('runs the rules on a full result whose farthest hit is at or past the cutoff, since every hidden hit is farther still', () => {
    for (const cutOffAt of [0.5, 1.2, 2]) {
      expect(applyRules(facts({ recall: hits([approval(), approval()], cutOffAt) }))).toMatchObject({ outcome: 'approved', rule: 'learned' });
      expect(applyRules(facts({ recall: hits([approval()], cutOffAt) })).rule).toBe('no_match');
    }
  });

  it('asks on a bad outcome with no outcome memory yet, and cites the outcome memories that exist', () => {
    const memory = randomUUID();
    const older = badOutcome([], 20_000n, new Date('2026-10-23T08:00:00Z'));
    const decided = applyRules(facts({ badOutcomes: [badOutcome([memory]), older], recall: hits([approval(), approval()]) }));
    expect(decided).toMatchObject({ outcome: 'asked', rule: 'bad_outcome', citedMemoryIds: [memory] });
    expect(decided.reason).toBe('hotels.example took 0.010000 USDC and did not deliver.');
    expect(applyRules(facts({ badOutcomes: [badOutcome()] }))).toMatchObject({ rule: 'bad_outcome', citedMemoryIds: [] });
  });

  it("words a bad outcome from the payment's own record, never claiming the seller failed while its answer is unknown", () => {
    const reasonFor = (record: Pick<BadOutcome, 'delivered' | 'settlement'>) =>
      applyRules(facts({ badOutcomes: [badOutcome([], 10_000n, undefined, record)], recall: hits([approval(), approval()]) })).reason;
    expect(reasonFor({ delivered: null, settlement: 'pending' })).toBe('hotels.example took 0.010000 USDC and Ellai has not seen it deliver yet.');
    expect(reasonFor({ delivered: null, settlement: 'verified' })).toBe('hotels.example took 0.010000 USDC and Ellai has not seen it deliver yet.');
    expect(reasonFor({ delivered: false, settlement: 'pending' })).toBe('hotels.example took 0.010000 USDC and did not deliver.');
    expect(reasonFor({ delivered: true, settlement: 'mismatch' })).toBe(
      'hotels.example was paid 0.010000 USDC and the payment did not match what was agreed.',
    );
  });

  it('words a bad outcome from the worst payment, a mismatch then no delivery then an unknown one, newest within a kind, and cites them all worst first', () => {
    const [m0, m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const failed = badOutcome([m0], 20_000n, new Date('2026-10-23T08:00:00Z'), { delivered: false, settlement: 'verified' });
    const newerUnknown = badOutcome([m1], 10_000n, new Date('2026-10-24T08:00:00Z'), { delivered: null, settlement: 'pending' });
    const decided = applyRules(facts({ badOutcomes: [newerUnknown, failed] }));
    expect(decided).toMatchObject({ outcome: 'asked', rule: 'bad_outcome', citedMemoryIds: [m0, m1] });
    expect(decided.reason).toBe('hotels.example took 0.020000 USDC and did not deliver.');

    const newerFailed = badOutcome([m2], 40_000n, new Date('2026-10-23T09:00:00Z'), { delivered: false, settlement: 'pending' });
    expect(applyRules(facts({ badOutcomes: [failed, newerUnknown, newerFailed] })).reason).toBe('hotels.example took 0.040000 USDC and did not deliver.');

    const oldMismatch = badOutcome([m3], 30_000n, new Date('2026-10-01T08:00:00Z'), { delivered: true, settlement: 'mismatch' });
    const worst = applyRules(facts({ badOutcomes: [newerUnknown, failed, newerFailed, oldMismatch] }));
    expect(worst.reason).toBe('hotels.example was paid 0.030000 USDC and the payment did not match what was agreed.');
    expect(worst.citedMemoryIds).toEqual([m3, m2, m0, m1]);
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
    fc.record({ kind: fc.constant('hits' as const), cutOffAt: fc.option(fc.double({ min: -1, max: 3 }), { nil: null }), hits: fc.array(hit, { maxLength: 25 }) }),
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
    heldOrSpentAtomic: fc.bigInt({ min: 0n, max: 5_000_000n }),
    amountAtomic: amount,
    recipient: fc.constant(RECIPIENT),
    sellerHost: fc.string(),
    refusalMemoryIds: fc.array(fc.uuid(), { maxLength: 4 }),
    badOutcomes: fc.array(
      fc.record({
        paymentId: fc.uuid(),
        amountAtomic: amount,
        signedAt: fc.date({ noInvalidDate: true }),
        delivered: fc.constantFrom(false, null, true),
        settlement: fc.constantFrom('pending' as const, 'verified' as const, 'mismatch' as const),
        outcomeMemoryIds: fc.array(fc.uuid(), { maxLength: 3 }),
      }),
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
      fc.property(anyFacts, fc.array(hit, { maxLength: 25 }), fc.option(fc.double({ min: -1, max: 3 }), { nil: null }), (f, list, cutOffAt) => {
        const elsewhere = list.map((h) => ({ ...h, recipient: OTHER_RECIPIENT }));
        return applyRules({ ...f, grantId: undefined, recall: hits(elsewhere, cutOffAt) }).outcome !== 'approved';
      }),
      runs,
    );
  });

  it('approves from a full result cut inside the cutoff only with approvalsNeeded matching approvals in view, and never past a refusal', () => {
    fc.assert(
      fc.property(
        anyFacts,
        fc.array(hit, { maxLength: 25 }),
        fc.double({ min: 1e-6, max: 4, noNaN: true }),
        fc.option(fc.uuid(), { nil: undefined }),
        (f, list, gap, refusal) => {
          const cutOffAt = f.settings.distanceCutoff - gap;
          const refusalMemoryIds = refusal === undefined ? f.refusalMemoryIds : [refusal, ...f.refusalMemoryIds];
          const decided = applyRules({ ...f, grantId: undefined, refusalMemoryIds, recall: hits(list, cutOffAt) });
          if (decided.outcome !== 'approved') return true;
          if (refusalMemoryIds.length > 0) return false;
          const inView = new Set(
            list
              .filter(
                (h) =>
                  h.countsAsOwnerDecision &&
                  h.verdict === 'approve' &&
                  h.recipient === f.recipient &&
                  h.amountAtomic >= f.amountAtomic &&
                  h.distance < f.settings.distanceCutoff,
              )
              .map((h) => h.memoryId),
          );
          const needed = f.settings.approvalsNeeded;
          return decided.rule === 'learned' && Number.isInteger(needed) && needed >= 1 && inView.size >= needed;
        },
      ),
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

  // A question Ellai asked at `at` that the owner has since answered.
  const questionAt = (w: World, at: Date) => pastDecision(w, { outcome: 'asked', rule: 'no_match', status: 'answered', createdAt: at });

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
      // As signing stamps it; a test that records a later outcome overrides it.
      outcomeAt: signedAt,
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
      { decisionId: result.decisionId, memoryId, ownerId: w.ownerId, distance: null },
    ]);
  });

  it("refuses on this owner's refusal recorded under another namespace label, and never on another owner's (C11)", async () => {
    const w = await world();
    const elsewhere = await approvalMemory(w, { verdict: 'refuse', namespace: 'ellai-demo-v1' });
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    const recall = vi.fn(recallOf(pair));
    expect(await run(w, { recall })).toMatchObject({ outcome: 'refused', rule: 'refused_recipient', citedMemoryIds: [elsewhere.id] });
    expect(recall).not.toHaveBeenCalled();

    const x = await world();
    await approvalMemory(w, { verdict: 'refuse' });
    expect(await run(x, { recall: recallOf([await approvalMemory(x), await approvalMemory(x)]) })).toMatchObject({ outcome: 'approved', rule: 'learned' });
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

  it("keeps the distance recall gave each memory a learned approval cites, the closest of a repeated hit, and none on a refusal's citations", async () => {
    const w = await world();
    const [first, second] = [await approvalMemory(w), await approvalMemory(w)];
    // Powers of two, so a real column gives them back exactly.
    const recall: Recall = async () => [
      { blobId: first.blobId ?? '', distance: 0.125 },
      { blobId: second.blobId ?? '', distance: 0.25 },
      { blobId: second.blobId ?? '', distance: 0.375 },
    ];
    const learned = await run(w, { recall });
    expect(learned).toMatchObject({ outcome: 'approved', rule: 'learned' });
    const cited = (decisionId: string) =>
      db.select({ memoryId: decisionCitations.memoryId, distance: decisionCitations.distance }).from(decisionCitations).where(eq(decisionCitations.decisionId, decisionId));
    expect(new Map((await cited(learned.decisionId)).map((row) => [row.memoryId, row.distance]))).toEqual(
      new Map([
        [first.id, 0.125],
        [second.id, 0.25],
      ]),
    );

    const refusal = await approvalMemory(w, { verdict: 'refuse' });
    const refused = await run(w, { recall, purpose: `${PURPOSE} again` });
    expect(refused).toMatchObject({ outcome: 'refused', rule: 'refused_recipient', citedMemoryIds: [refusal.id] });
    expect(await cited(refused.decisionId)).toEqual([{ memoryId: refusal.id, distance: null }]);
  });

  it('keeps learning for an owner with 20 memories when the full result ends past the cutoff (A2-1)', async () => {
    const w = await world();
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    const others: Array<typeof memories.$inferSelect> = [];
    for (let i = 0; i < LIMITS.decideRecallLimit - 2; i++) {
      others.push(await approvalMemory(w, { recipient: OTHER_RECIPIENT, verdict: i % 2 === 0 ? 'approve' : 'refuse' }));
    }
    expect(await db.select().from(memories).where(eq(memories.ownerId, w.ownerId))).toHaveLength(LIMITS.decideRecallLimit);
    const at = (rows: Array<{ blobId: string | null }>, distance: number) => rows.map((row) => ({ blobId: row.blobId ?? '', distance }));

    const learned = await run(w, { recall: async () => [...at(pair, 0.1), ...at(others, 1.2)] });
    expect(learned).toMatchObject({ outcome: 'approved', rule: 'learned' });
    expect(learned.citedMemoryIds.sort()).toEqual(pair.map((m) => m.id).sort());

    // Cut inside the cutoff: the two approvals in view are enough, and one alone is not.
    const inside = await run(w, { recall: async () => [...at(pair, 0.1), ...at(others, 0.45)], purpose: `${PURPOSE} inside` });
    expect(inside).toMatchObject({ outcome: 'approved', rule: 'learned' });
    expect(inside.citedMemoryIds.sort()).toEqual(pair.map((m) => m.id).sort());
    const short = await run(w, { recall: async () => [...at(pair.slice(1), 0.1), ...at(others, 0.45), { blobId: hex(16), distance: 0.45 }], purpose: `${PURPOSE} short` });
    expect(short).toMatchObject({
      outcome: 'asked',
      rule: 'recall_unavailable',
      reason: 'Ellai found more past answers like this than it can check at once, so it is asking you.',
    });
  });

  it('asks when recall throws, returns a hit without a finite distance, comes back full inside the cutoff short of approvals, or times out', async () => {
    const w = await world();
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    const full = [...pair.slice(1), ...Array.from({ length: LIMITS.decideRecallLimit - 1 }, () => ({ blobId: hex(16) }))];
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
    expect(noMemoryYet.reason).toBe('hotels.example took 0.010000 USDC and did not deliver.');

    const outcome = one(
      await db
        .insert(memories)
        .values({ ownerId: w.ownerId, kind: 'outcome', decisionId: decision.id, sentence: 'The seller returned nothing.', namespace: NAMESPACE, writerPublicKey: DELEGATE })
        .returning(),
    );
    expect(await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 2` })).toMatchObject({ rule: 'bad_outcome', citedMemoryIds: [outcome.id] });

    const askedAfter = await questionAt(w, new Date(NOW.getTime() - 1_800_000));
    await approvalMemory(w, { decisionId: askedAfter.id, writerPublicKey: hex(32), createdAt: new Date(NOW.getTime() - 60_000) });
    expect((await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 3` })).rule).toBe('bad_outcome');
    await approvalMemory(w, { decisionId: askedAfter.id, createdAt: new Date(NOW.getTime() - 60_000) });
    expect((await run(w, { recall: recallOf(pair), purpose: `${PURPOSE} 4` })).rule).toBe('learned');
  });

  it('asks from the moment a payment is signed until the seller is known to have delivered (A2-4)', async () => {
    const hourAgo = new Date(NOW.getTime() - 3_600_000);
    const earlier = new Date(NOW.getTime() - 7_200_000);
    const withPayment = async (record: Partial<typeof payments.$inferInsert>) => {
      const w = await world();
      const pair = [
        await approvalMemory(w, { decisionId: (await questionAt(w, earlier)).id, createdAt: earlier }),
        await approvalMemory(w, { decisionId: (await questionAt(w, earlier)).id, createdAt: earlier }),
      ];
      await signedPayment(w, 10_000n, hourAgo, record);
      return run(w, { recall: recallOf(pair) });
    };

    expect(await withPayment({ settlement: 'pending', delivered: false })).toMatchObject({ outcome: 'asked', rule: 'bad_outcome' });
    expect(await withPayment({ settlement: 'pending' })).toMatchObject({
      outcome: 'asked',
      rule: 'bad_outcome',
      reason: 'hotels.example took 0.010000 USDC and Ellai has not seen it deliver yet.',
    });
    expect((await withPayment({ settlement: 'verified' })).rule).toBe('bad_outcome');
    expect((await withPayment({ settlement: 'mismatch', delivered: true })).rule).toBe('bad_outcome');

    const movedNothingOrDelivered: Array<Partial<typeof payments.$inferInsert>> = [
      { settlement: 'pending', delivered: true },
      { settlement: 'verified', delivered: true },
      { settlement: 'not_landed' },
      { settlement: 'pending', releasedAt: new Date(NOW.getTime() - 1_800_000) },
    ];
    for (const record of movedNothingOrDelivered) expect((await withPayment(record)).rule).toBe('learned');
  });

  it('keeps asking when the only yes since a bad payment answered a question asked before it (A2-5)', async () => {
    const w = await world();
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    const old = await run(w, { now: ago(7_200_000), purpose: `${PURPOSE} old` });
    expect(old.outcome).toBe('asked');
    await signedPayment(w, 10_000n, ago(3_600_000), { settlement: 'verified', delivered: false });
    await ownerAnswer(w, old.decisionId, 'approve', ago(600_000));
    const pair = [await approvalMemory(w, { createdAt: ago(10_800_000) }), await approvalMemory(w, { createdAt: ago(10_800_000) })];

    const stale = await run(w, { recall: recallOf(pair) });
    expect(stale).toMatchObject({ outcome: 'asked', rule: 'bad_outcome' });

    // A yes to the question that showed the bad outcome is what restarts the window.
    await ownerAnswer(w, stale.decisionId, 'approve', NOW);
    expect((await run(w, { recall: recallOf(pair), now: new Date(NOW.getTime() + 60_000) })).rule).toBe('grant');
  });

  it('clears a bad payment only at a yes to a question created strictly after its outcome was recorded, however long before that it was signed (C32)', async () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    const recorded = ago(1_800_000);
    const ruleWithYesAskedAt = async (askedAt: Date) => {
      const w = await world();
      const pair = [await approvalMemory(w, { createdAt: ago(10_800_000) }), await approvalMemory(w, { createdAt: ago(10_800_000) })];
      await signedPayment(w, 10_000n, ago(7_200_000), { settlement: 'verified', delivered: false, outcomeAt: recorded });
      await approvalMemory(w, { decisionId: (await questionAt(w, askedAt)).id, createdAt: NOW });
      return (await run(w, { recall: recallOf(pair) })).rule;
    };
    expect(await ruleWithYesAskedAt(ago(3_600_000))).toBe('bad_outcome');
    expect(await ruleWithYesAskedAt(recorded)).toBe('bad_outcome');
    expect(await ruleWithYesAskedAt(new Date(recorded.getTime() + 1))).toBe('learned');
  });

  it("asks in the worst bad payment's words even when newer payments of unknown delivery would fill the lookup", async () => {
    const w = await world();
    const pair = [await approvalMemory(w), await approvalMemory(w)];
    await signedPayment(w, 30_000n, new Date(NOW.getTime() - 7_200_000), { settlement: 'verified', delivered: false });
    for (let i = 0; i < LIMITS.decideMaxCitedMemories; i++) await signedPayment(w, 10_000n, new Date(NOW.getTime() - 3_600_000 + i * 1_000));
    expect(await run(w, { recall: recallOf(pair) })).toMatchObject({
      outcome: 'asked',
      rule: 'bad_outcome',
      reason: 'hotels.example took 0.030000 USDC and did not deliver.',
    });
  });

  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

  it('counts every signed, unreleased payment of the last 24 hours against the daily budget', async () => {
    const w = await world({ dailyBudgetAtomic: 30_000n });
    // Delivered, so the only rule these payments can trip is the budget.
    await signedPayment(w, 15_000n, hoursAgo(1), { delivered: true });
    await signedPayment(w, 40_000n, hoursAgo(2), { releasedAt: hoursAgo(1), delivered: true });
    await signedPayment(w, 40_000n, hoursAgo(25), { settlement: 'verified', delivered: true });

    expect((await run(w, { payment: payment(NOW, { amount: 15_000n }), purpose: `${PURPOSE} fits` })).rule).toBe('no_match');
    expect(await run(w, { payment: payment(NOW, { amount: 15_001n }), purpose: `${PURPOSE} over` })).toMatchObject({
      outcome: 'refused',
      rule: 'over_daily_budget',
    });
  });

  it('counts a payment signed 25 hours ago that is still pending, exactly as signing does (C4)', async () => {
    const w = await world({ dailyBudgetAtomic: 30_000n });
    const { payment: old } = await signedPayment(w, 20_000n, hoursAgo(25), { delivered: true });
    expect(old.settlement).toBe('pending');
    expect(await heldOrSpentAtomic(db, w.ownerId, NOW)).toBe(20_000n);

    expect((await run(w, { payment: payment(NOW, { amount: 10_000n }), purpose: `${PURPOSE} fits` })).rule).toBe('no_match');
    expect(await run(w, { payment: payment(NOW, { amount: 10_001n }), purpose: `${PURPOSE} over` })).toMatchObject({
      outcome: 'refused',
      rule: 'over_daily_budget',
    });
  });

  it('counts a settled payment for a full day from the later of signing and verification, so one verified 47 hours after signing still holds the budget (A-F2)', async () => {
    const w = await world({ dailyBudgetAtomic: 30_000n });
    const { payment: late } = await signedPayment(w, 20_000n, hoursAgo(47), { settlement: 'verified', verifiedAt: hoursAgo(1), delivered: true });
    // A mismatch is never verified, so it counts from signing alone.
    await signedPayment(w, 5_000n, hoursAgo(25), { settlement: 'mismatch', mismatchReason: 'test', delivered: true, recipient: OTHER_RECIPIENT });
    expect(await heldOrSpentAtomic(db, w.ownerId, NOW)).toBe(20_000n);
    expect(await run(w, { payment: payment(NOW, { amount: 10_001n }), purpose: `${PURPOSE} over` })).toMatchObject({ outcome: 'refused', rule: 'over_daily_budget' });

    await db.update(payments).set({ verifiedAt: hoursAgo(24.001) }).where(eq(payments.id, late.id));
    expect(await heldOrSpentAtomic(db, w.ownerId, NOW)).toBe(0n);
    expect((await run(w, { payment: payment(NOW, { amount: 30_000n }), purpose: `${PURPOSE} fits` })).rule).toBe('no_match');
  });

  it('reads its clock inside the transaction: a grant that expired during recall authorises nothing, and the decision and question carry that time (C26)', async () => {
    const w = await world();
    const asked = await run(w);
    const { grantId } = await ownerAnswer(w, asked.decisionId, 'approve');
    if (grantId === null) throw new Error('expected a grant');
    const expiresAt = one(await db.select({ expiresAt: grants.expiresAt }).from(grants).where(eq(grants.id, grantId))).expiresAt;

    // Valid when the first pass reads its facts, expired by the time the lock is held.
    const locked = new Date(expiresAt.getTime());
    const clock = vi.fn(() => locked);
    const retry = await run(w, { now: new Date(expiresAt.getTime() - 1), clock });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ outcome: 'asked', rule: 'recall_unavailable' });
    expect(await rowCounts(w.ownerId)).toMatchObject({ grantUses: 0 });
    expect(one(await db.select().from(decisions).where(eq(decisions.id, retry.decisionId))).createdAt).toEqual(locked);
    expect(one(await db.select().from(questions).where(eq(questions.decisionId, retry.decisionId))).createdAt).toEqual(locked);

    const unreadable = await world();
    await expect(run(unreadable, { clock: () => new Date(Number.NaN) })).rejects.toMatchObject({ name: 'DecideError', code: 'BAD_INPUT' });
    expect(await rowCounts(unreadable.ownerId)).toMatchObject({ decisions: 0 });
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
