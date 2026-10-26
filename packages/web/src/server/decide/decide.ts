import type { CanonicalPayment } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { and, count, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  LIVE_DECISION_STATUSES,
  SELLER_METHODS,
  TEXT_CAPS,
  agents,
  decisionCitations,
  decisions,
  grantUses,
  grants,
  memories,
  owners,
  payments,
  questions,
} from '../db/schema.js';
import { heldOrSpentAtomic } from '../pay/liability.js';
import {
  type BadOutcome,
  type DecideFacts,
  type DecisionRule,
  type OwnerSettings,
  type RecallHit,
  type RecallResult,
  type RuleResult,
  applyRules,
  rulesBeforeRecall,
} from './rules.js';
import { querySentence, requestKey } from './sentences.js';

export type DecideErrorCode = 'BAD_INPUT' | 'BAD_PURPOSE' | 'OWNER' | 'AGENT' | 'REQUEST_MISMATCH';

/** Every refusal from decide. The message is fixed text: nothing the agent sent is copied in. */
export class DecideError extends Error {
  readonly code: DecideErrorCode;

  constructor(code: DecideErrorCode, message: string) {
    super(message);
    this.name = 'DecideError';
    this.code = code;
  }
}

export type Recall = (query: string, limit: number) => Promise<Array<{ blobId: string; distance: number }>>;

export interface DecideArgs {
  db: Database;
  ownerId: string;
  agentId: string;
  payment: CanonicalPayment;
  method: 'GET' | 'POST';
  bodyHash: string;
  purpose: string;
  recall: Recall;
  /** The owner's Ellai delegate key, as 64 lowercase hex characters. Only memories it wrote can earn approval (C9). */
  delegatePublicKeyHex: string;
  /** The owner's namespace. Every memory read is scoped to it (C9). */
  namespace: string;
  /** The time the first pass, before recall and the lock, reads its facts at. */
  now: Date;
  /**
   * Read once inside the transaction, under the owner lock: the time the grant expiry check and
   * the budget window use there, and the time the decision, its question and its grant use are
   * recorded at (C26, C32). Returns `now` when left out.
   */
  clock?: () => Date;
}

export interface DecideResult {
  decisionId: string;
  outcome: RuleResult['outcome'];
  rule: DecisionRule;
  reason: string;
  citedMemoryIds: string[];
  reused: boolean;
}

type Queryable = Pick<Database, 'select' | 'insert'>;

interface Request {
  ownerId: string;
  agentId: string;
  payment: CanonicalPayment;
  method: 'GET' | 'POST';
  bodyHash: string;
  purpose: string;
  key: string;
  delegate: string;
  namespace: string;
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const FAILED: RecallResult = { kind: 'failed' };

function bad(message: string): never {
  throw new DecideError('BAD_INPUT', message);
}

function checkRequest(args: DecideArgs): Request {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) bad('the owner id is not a uuid');
  if (typeof args.agentId !== 'string' || !UUID.test(args.agentId)) bad('the agent id is not a uuid');
  if (!(SELLER_METHODS as readonly string[]).includes(args.method)) bad('the method must be GET or POST');
  if (typeof args.bodyHash !== 'string' || !HEX_32_BYTES.test(args.bodyHash)) bad('the body hash must be 64 lowercase hex characters');
  if (typeof args.delegatePublicKeyHex !== 'string' || !HEX_32_BYTES.test(args.delegatePublicKeyHex)) {
    bad('the delegate public key must be 64 lowercase hex characters');
  }
  if (typeof args.namespace !== 'string' || args.namespace.length === 0 || args.namespace.length > LIMITS.memwalNamespaceMaxLength) {
    bad('the namespace is missing or too long');
  }
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) bad('the current time is not a date');
  if (args.clock !== undefined && typeof args.clock !== 'function') bad('the clock is not a function');
  if (typeof args.recall !== 'function') bad('recall is missing');
  const { payment } = args;
  if (
    typeof payment !== 'object' ||
    payment === null ||
    typeof payment.amount !== 'bigint' ||
    payment.amount <= 0n ||
    typeof payment.recipient !== 'string' ||
    !Number.isSafeInteger(payment.expiresAtMs)
  ) {
    bad('the payment is not a canonical payment');
  }
  // Counted in code points, as Postgres counts the column cap, so the two never disagree.
  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
  const length = Array.from(purpose).length;
  if (length === 0 || length > LIMITS.purposeMaxChars) {
    throw new DecideError('BAD_PURPOSE', `the purpose must be 1 to ${LIMITS.purposeMaxChars} characters`);
  }
  const ownerId = args.ownerId.toLowerCase();
  const agentId = args.agentId.toLowerCase();
  return {
    ownerId,
    agentId,
    payment,
    method: args.method,
    bodyHash: args.bodyHash,
    purpose,
    key: requestKey({ agentId, payment, method: args.method, bodyHash: args.bodyHash, purpose }),
    delegate: args.delegatePublicKeyHex,
    namespace: args.namespace,
    now: args.now,
  };
}

async function ownerSettings(q: Queryable, ownerId: string, forUpdate: boolean): Promise<OwnerSettings> {
  const query = q
    .select({
      paused: owners.paused,
      autoPausedReason: owners.autoPausedReason,
      perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
      dailyBudgetAtomic: owners.dailyBudgetAtomic,
      approvalsNeeded: owners.approvalsNeeded,
      distanceCutoff: owners.distanceCutoff,
    })
    .from(owners)
    .where(eq(owners.id, ownerId));
  const [owner] = forUpdate ? await query.for('update') : await query;
  if (owner === undefined) throw new DecideError('OWNER', 'the owner was not found');
  return owner;
}

// One message for an unknown agent, another owner's agent and a revoked one, so the answer
// tells a caller nothing about agents it does not hold (C13).
async function activeAgent(q: Queryable, r: Request): Promise<{ maxPending: number }> {
  const [agent] = await q
    .select({ maxPending: agents.maxPending, revokedAt: agents.revokedAt })
    .from(agents)
    .where(and(eq(agents.id, r.agentId), eq(agents.ownerId, r.ownerId)));
  if (agent === undefined || agent.revokedAt !== null) throw new DecideError('AGENT', 'the agent is not an active agent of this owner');
  return agent;
}

async function liveDecision(q: Queryable, r: Request) {
  const [row] = await q
    .select()
    .from(decisions)
    .where(and(eq(decisions.ownerId, r.ownerId), eq(decisions.requestKey, r.key), inArray(decisions.status, [...LIVE_DECISION_STATUSES])));
  return row;
}

// The key is a digest of these fields, so this only fails if the key format and the stored
// row ever drift apart; even then a stored result goes back only for the identical request (C5).
async function reuse(q: Queryable, row: typeof decisions.$inferSelect, r: Request): Promise<DecideResult> {
  const same =
    row.agentId === r.agentId &&
    row.sellerUrl === r.payment.sellerUrl &&
    row.sellerMethod === r.method &&
    row.bodyHash === r.bodyHash &&
    row.purpose === r.purpose &&
    row.recipient === r.payment.recipient &&
    row.amountAtomic === r.payment.amount &&
    row.asset === r.payment.asset &&
    row.network === r.payment.network;
  if (!same) throw new DecideError('REQUEST_MISMATCH', 'an earlier decision under this request key is for a different request');
  const cited = await q
    .select({ memoryId: decisionCitations.memoryId })
    .from(decisionCitations)
    .where(and(eq(decisionCitations.decisionId, row.id), eq(decisionCitations.ownerId, r.ownerId)));
  return {
    decisionId: row.id,
    outcome: row.outcome,
    rule: row.rule,
    reason: row.reason,
    citedMemoryIds: cited.map((c) => c.memoryId),
    reused: true,
  };
}

const ownedHere = (r: Request) => and(eq(memories.ownerId, r.ownerId), eq(memories.namespace, r.namespace));

async function badOutcomes(q: Queryable, r: Request): Promise<BadOutcome[]> {
  // The window restarts only at a yes that would itself count toward learning, and it restarts
  // at the time that yes's question was asked, not answered. A question asked before Ellai
  // recorded a payment's outcome (outcome_at) never showed it to the owner, so a yes to it
  // clears nothing, however long before the question the payment was signed (C32).
  const [lastAskedYes] = await q
    .select({ at: decisions.createdAt })
    .from(memories)
    .innerJoin(decisions, and(eq(decisions.id, memories.decisionId), eq(decisions.ownerId, memories.ownerId)))
    .where(
      and(
        ownedHere(r),
        eq(memories.kind, 'owner_decision'),
        eq(memories.verdict, 'approve'),
        eq(memories.recipient, r.payment.recipient),
        eq(memories.writerPublicKey, r.delegate),
      ),
    )
    .orderBy(desc(decisions.createdAt))
    .limit(1);
  // From the moment it is signed until the seller is known to have delivered, a payment counts:
  // a pending settlement and an unknown delivery are not good news. A released or 'not_landed'
  // payment moved no money. A mismatch counts whatever the seller said.
  const bad = await q
    .select({
      id: payments.id,
      decisionId: payments.decisionId,
      amountAtomic: payments.amountAtomic,
      signedAt: payments.signedAt,
      delivered: payments.delivered,
      settlement: payments.settlement,
    })
    .from(payments)
    .where(
      and(
        eq(payments.ownerId, r.ownerId),
        eq(payments.recipient, r.payment.recipient),
        or(
          eq(payments.settlement, 'mismatch'),
          and(inArray(payments.settlement, ['verified', 'pending']), isNull(payments.releasedAt), sql`${payments.delivered} is not true`),
        ),
        lastAskedYes === undefined ? undefined : gte(payments.outcomeAt, lastAskedYes.at),
      ),
    )
    // rules.ts's ranking, worst first and then newest, so the limit can never leave out the
    // payment the reason is worded from.
    .orderBy(sql`case when ${payments.settlement} = 'mismatch' then 0 when ${payments.delivered} is false then 1 else 2 end`, desc(payments.signedAt))
    .limit(LIMITS.decideMaxCitedMemories);
  if (bad.length === 0) return [];
  const outcomes = await q
    .select({ id: memories.id, decisionId: memories.decisionId })
    .from(memories)
    .where(and(ownedHere(r), eq(memories.kind, 'outcome'), inArray(memories.decisionId, bad.map((p) => p.decisionId))))
    .limit(LIMITS.decideMaxCitedMemories);
  return bad.map((p) => ({
    paymentId: p.id,
    amountAtomic: p.amountAtomic,
    signedAt: p.signedAt,
    delivered: p.delivered,
    // The where clause above admits only mismatch, verified and pending.
    settlement: p.settlement as BadOutcome['settlement'],
    outcomeMemoryIds: outcomes.filter((o) => o.decisionId === p.decisionId).map((o) => o.id),
  }));
}

/**
 * The exact refusal lookup (C11): the ids of this owner's own refusals of `recipient`, newest
 * first, at most LIMITS.decideMaxCitedMemories. Any status, since an answer binds from the moment
 * it is recorded, before its Walrus write lands (C11, C12). Keyed on the owner and the recipient
 * only: a namespace label is public and authenticates nothing (C19), so a refusal recorded under
 * any label still refuses. Signing runs this same lookup again under the owner lock.
 */
export async function recipientRefusals(q: Pick<Database, 'select'>, ownerId: string, recipient: string): Promise<string[]> {
  const rows = await q
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), eq(memories.kind, 'owner_decision'), eq(memories.verdict, 'refuse'), eq(memories.recipient, recipient)))
    .orderBy(desc(memories.createdAt))
    .limit(LIMITS.decideMaxCitedMemories);
  return rows.map((row) => row.id);
}

async function gatherFacts(q: Queryable, r: Request, settings: OwnerSettings, maxPending: number): Promise<Omit<DecideFacts, 'recall'>> {
  const { payment } = r;
  // The same sum signing checks under the owner lock, so decide never approves what signing refuses (C4).
  const held = await heldOrSpentAtomic(q, r.ownerId, r.now);
  const refusals = await recipientRefusals(q, r.ownerId, payment.recipient);

  const [grant] = await q
    .select({ id: grants.id })
    .from(grants)
    .innerJoin(decisions, and(eq(decisions.id, grants.decisionId), eq(decisions.ownerId, grants.ownerId)))
    .leftJoin(grantUses, eq(grantUses.grantId, grants.id))
    .where(
      and(
        eq(grants.ownerId, r.ownerId),
        isNull(grantUses.grantId),
        gt(grants.expiresAt, r.now),
        eq(grants.recipient, payment.recipient),
        gte(grants.maxAmountAtomic, payment.amount),
        eq(grants.sellerUrl, payment.sellerUrl),
        eq(grants.sellerMethod, r.method),
        eq(grants.bodyHash, r.bodyHash),
        eq(decisions.agentId, r.agentId),
      ),
    )
    .orderBy(grants.expiresAt)
    .limit(1);

  const [pending] = await q
    .select({ n: count() })
    .from(questions)
    .innerJoin(decisions, and(eq(decisions.id, questions.decisionId), eq(decisions.ownerId, questions.ownerId)))
    .where(and(eq(questions.ownerId, r.ownerId), eq(decisions.agentId, r.agentId), eq(decisions.status, 'asked'), isNull(questions.answeredAt)));

  return {
    settings,
    heldOrSpentAtomic: held,
    amountAtomic: payment.amount,
    recipient: payment.recipient,
    sellerHost: payment.sellerHost,
    refusalMemoryIds: refusals,
    badOutcomes: await badOutcomes(q, r),
    ...(grant === undefined ? {} : { grantId: grant.id }),
    pendingQuestions: pending?.n ?? 0,
    maxPending,
  };
}

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('recall timed out')), ms);
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Recall, then each hit mapped to Ellai's own row for its blob id. A hit counts as an owner
 * decision only when that row is this owner's, in this namespace, an owner decision, and
 * written by this owner's delegate key (C9). Every fact a rule reads comes from the row,
 * never from the hit (C10). A blob id with no row is dropped, never trusted.
 */
async function recallFacts(db: Database, r: Request, recall: Recall): Promise<RecallResult> {
  let raw: unknown;
  try {
    raw = await withTimeout(() => recall(querySentence({ payment: r.payment, purpose: r.purpose }), LIMITS.decideRecallLimit), LIMITS.decideRecallTimeoutMs);
  } catch {
    return FAILED;
  }
  if (!Array.isArray(raw) || raw.length > LIMITS.decideRecallLimit) return FAILED;
  const parsed: Array<{ blobId: string; distance: number }> = [];
  for (const item of raw as unknown[]) {
    const { blobId, distance } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof blobId !== 'string' || typeof distance !== 'number' || !Number.isFinite(distance)) return FAILED;
    parsed.push({ blobId, distance });
  }
  // Taken over every hit, Ellai's or not, because the limit cut the namespace as a whole.
  const cutOffAt = parsed.length >= LIMITS.decideRecallLimit ? parsed.reduce((far, hit) => Math.max(far, hit.distance), Number.NEGATIVE_INFINITY) : null;
  const blobIds = [...new Set(parsed.map((hit) => hit.blobId))].filter((id) => id.length > 0 && id.length <= TEXT_CAPS.relayerId);
  const rows =
    blobIds.length === 0
      ? []
      : await db
          .select({
            id: memories.id,
            blobId: memories.blobId,
            kind: memories.kind,
            verdict: memories.verdict,
            recipient: memories.recipient,
            amountAtomic: memories.amountAtomic,
            writerPublicKey: memories.writerPublicKey,
          })
          .from(memories)
          .where(and(ownedHere(r), inArray(memories.blobId, blobIds)));
  const byBlob = new Map(rows.map((row) => [row.blobId, row]));
  const hits: RecallHit[] = [];
  for (const hit of parsed) {
    const row = byBlob.get(hit.blobId);
    if (row === undefined || row.verdict === null || row.recipient === null || row.amountAtomic === null) continue;
    hits.push({
      memoryId: row.id,
      verdict: row.verdict,
      recipient: row.recipient,
      amountAtomic: row.amountAtomic,
      distance: hit.distance,
      countsAsOwnerDecision: row.kind === 'owner_decision' && row.writerPublicKey === r.delegate,
    });
  }
  return { kind: 'hits', cutOffAt, hits };
}

const STATUS_FOR = { approved: 'open', refused: 'refused', asked: 'asked' } as const;

/**
 * Decides pay, refuse or ask for one canonical payment an agent wants to make, and records
 * the decision.
 *
 * - A live (open or asked) decision for the same request is returned as it is, with
 *   reused true, and nothing is written (C5).
 * - Otherwise the facts are read and rules 1 to 6 run. Recall is called only when they
 *   decide nothing, outside any lock, with LIMITS.decideRecallTimeoutMs; a throw, a
 *   timeout, a malformed answer or a hit without a finite distance counts as failed (C12).
 *   A result of LIMITS.decideRecallLimit hits whose farthest hit is inside the owner's distance
 *   cutoff approves only when the approvals it shows already reach approvalsNeeded, and
 *   otherwise asks, since the limit can have hidden closer approvals but never a refusal or a
 *   bad outcome, which are exact lookups (applyRules).
 * - Then, in one transaction that first locks the owner row FOR UPDATE, `clock` is read and
 *   every fact is read again at that time and the rules run again, so two decides for one owner
 *   can never both spend one grant or both fit under the daily budget, and a grant that expired
 *   during recall or the lock wait authorises nothing (C26). If that pass needs a recall the
 *   first did not take, the recall counts as failed and Ellai asks. The decision, its
 *   citations, its question (for an ask) and its grant use (for a grant approval) are written
 *   together, each stamped with that same reading.
 *
 * Statuses: approved is 'open', refused is 'refused', asked is 'asked'. expires_at is the
 * payment's own expiry. Throws DecideError: BAD_INPUT, BAD_PURPOSE (empty after trimming or
 * over LIMITS.purposeMaxChars), OWNER, AGENT (not this owner's, or revoked), and
 * REQUEST_MISMATCH.
 */
export async function decide(args: DecideArgs): Promise<DecideResult> {
  const r = checkRequest(args);
  const { db } = args;

  const { maxPending } = await activeAgent(db, r);
  const earlier = await liveDecision(db, r);
  if (earlier !== undefined) return reuse(db, earlier, r);

  const before = await gatherFacts(db, r, await ownerSettings(db, r.ownerId, false), maxPending);
  const recall = rulesBeforeRecall(before) === null ? await recallFacts(db, r, args.recall) : FAILED;

  return db.transaction(async (tx) => {
    const settings = await ownerSettings(tx, r.ownerId, true);
    // After recall and the wait for the lock, so a grant that expired meanwhile authorises
    // nothing, and the question is dated after any outcome a writer holding this lock recorded.
    const at = (args.clock ?? (() => args.now))();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) bad('the current time is not a date');
    const locked: Request = { ...r, now: at };
    const agent = await activeAgent(tx, locked);
    const live = await liveDecision(tx, locked);
    if (live !== undefined) return reuse(tx, live, locked);

    const decided = applyRules({ ...(await gatherFacts(tx, locked, settings, agent.maxPending)), recall });
    const { payment } = r;
    const [row] = await tx
      .insert(decisions)
      .values({
        ownerId: r.ownerId,
        agentId: r.agentId,
        requestKey: r.key,
        sellerUrl: payment.sellerUrl,
        sellerMethod: r.method,
        sellerHost: payment.sellerHost,
        bodyHash: r.bodyHash,
        purpose: r.purpose,
        recipient: payment.recipient,
        amountAtomic: payment.amount,
        asset: payment.asset,
        network: payment.network,
        challengeId: payment.challengeId,
        nonce: payment.nonce,
        minEpoch: payment.minEpoch,
        maxEpoch: payment.maxEpoch,
        expiresAt: new Date(payment.expiresAtMs),
        outcome: decided.outcome,
        rule: decided.rule,
        reason: decided.reason,
        status: STATUS_FOR[decided.outcome],
        createdAt: at,
      })
      .returning({ id: decisions.id });
    if (row === undefined) throw new Error('the decision insert returned no row');

    if (decided.citedMemoryIds.length > 0) {
      await tx
        .insert(decisionCitations)
        .values(decided.citedMemoryIds.map((memoryId) => ({ decisionId: row.id, memoryId, ownerId: r.ownerId })));
    }
    if (decided.outcome === 'asked') {
      await tx.insert(questions).values({ decisionId: row.id, ownerId: r.ownerId, createdAt: at });
    }
    if (decided.rule === 'grant' && decided.grantId !== undefined) {
      await tx.insert(grantUses).values({ grantId: decided.grantId, ownerId: r.ownerId, decisionId: row.id, usedAt: at });
    }
    return {
      decisionId: row.id,
      outcome: decided.outcome,
      rule: decided.rule,
      reason: decided.reason,
      citedMemoryIds: decided.citedMemoryIds,
      reused: false,
    };
  });
}
