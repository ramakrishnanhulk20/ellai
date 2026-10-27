import { LIMITS } from '@ellai/core/limits';
import type { DECISION_RULES } from '../db/schema.js';
import { formatUsdc, hostLabel } from './sentences.js';

export type DecisionRule = (typeof DECISION_RULES)[number];

export interface OwnerSettings {
  paused: boolean;
  autoPausedReason: string | null;
  perPaymentMaxAtomic: bigint;
  dailyBudgetAtomic: bigint;
  approvalsNeeded: number;
  distanceCutoff: number;
}

/** One recall hit, with every fact read from Ellai's own row for that memory, never from its sentence (C10). */
export interface RecallHit {
  memoryId: string;
  verdict: 'approve' | 'refuse';
  recipient: string;
  amountAtomic: bigint;
  distance: number;
  /** True only when Ellai's row shows Ellai wrote it for this owner, in this namespace, from an owner answer (C9). */
  countsAsOwnerDecision: boolean;
}

/**
 * A search that answered. `cutOffAt` is null when it returned fewer hits than it asked for.
 * When it came back full, it is the largest distance among every hit returned, whether or not
 * Ellai knows the hit's blob: the relayer returns the nearest memories, so everything the
 * limit cut off is at least that far.
 */
export type RecallResult = { kind: 'failed' } | { kind: 'hits'; cutOffAt: number | null; hits: RecallHit[] };

/**
 * A payment to this recipient with no delivery on record, or one that did not match on chain,
 * whose outcome Ellai recorded no earlier than the last question about this recipient that the
 * owner said yes to (C32).
 */
export interface BadOutcome {
  paymentId: string;
  amountAtomic: bigint;
  signedAt: Date;
  /** Null while the seller's answer is unknown. */
  delivered: boolean | null;
  settlement: 'pending' | 'verified' | 'mismatch';
  /** The outcome memories written for it so far, possibly none: the payment alone is enough to ask. */
  outcomeMemoryIds: string[];
}

export interface DecideFacts {
  settings: OwnerSettings;
  /** What already counts against the daily budget, in atomic USDC: pay/liability.ts heldOrSpentAtomic (C4). */
  heldOrSpentAtomic: bigint;
  amountAtomic: bigint;
  recipient: string;
  /** Used only to word the reason. */
  sellerHost: string;
  /** Every owner refusal of this recipient, found by exact lookup. */
  refusalMemoryIds: string[];
  badOutcomes: BadOutcome[];
  /** An unused, unexpired grant matching this exact request and agent. */
  grantId?: string;
  pendingQuestions: number;
  maxPending: number;
  recall: RecallResult;
}

export interface RuleResult {
  outcome: 'approved' | 'refused' | 'asked';
  rule: DecisionRule;
  citedMemoryIds: string[];
  /**
   * Only on a learned approval: the distance recall gave each cited memory, by memory id, the
   * smallest if recall returned it more than once. Every other rule cites by exact lookup, so
   * there is no distance to give.
   */
  citedDistances?: ReadonlyMap<string, number>;
  /** Written by Ellai from the host, amounts and counts only, never from purpose or memory text (C17). */
  reason: string;
  grantId?: string;
}

function cite(ids: string[]): string[] {
  return [...new Set(ids)].slice(0, LIMITS.decideMaxCitedMemories);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function result(outcome: RuleResult['outcome'], rule: DecisionRule, reason: string, citedMemoryIds: string[] = []): RuleResult {
  return { outcome, rule, reason, citedMemoryIds: cite(citedMemoryIds) };
}

// decide.ts orders its bad-payment lookup by the same ranking, so its row limit can never drop
// the payment the reason is worded from.
function severity(bad: BadOutcome): number {
  if (bad.settlement === 'mismatch') return 0;
  return bad.delivered === false ? 1 : 2;
}

function worstFirst(a: BadOutcome, b: BadOutcome): number {
  return severity(a) - severity(b) || b.signedAt.getTime() - a.signedAt.getTime();
}

// Worded from the worst payment's own record, so the owner hears the worst that happened and is
// never told a seller failed while its answer is still unknown. It says no "last time", since
// the worst payment need not be the latest.
function badOutcomeReason(sellerHost: string, worst: BadOutcome): string {
  const seller = hostLabel(sellerHost, true);
  const paid = formatUsdc(worst.amountAtomic);
  if (worst.settlement === 'mismatch') return `${seller} was paid ${paid} USDC and the payment did not match what was agreed.`;
  if (worst.delivered === false) return `${seller} took ${paid} USDC and did not deliver.`;
  return `${seller} took ${paid} USDC and Ellai has not seen it deliver yet.`;
}

// The queue cap turns an ask into a refusal and leaves approvals and refusals alone (C22).
// A count that is not below the cap, including one that is not a number, refuses.
function capAsk(facts: Omit<DecideFacts, 'recall'>, decided: RuleResult): RuleResult {
  if (decided.outcome !== 'asked' || facts.pendingQuestions < facts.maxPending) return decided;
  return result('refused', 'too_many_pending', `This agent already has ${plural(facts.pendingQuestions, 'question')} waiting for you.`);
}

/**
 * Rules 1 to 6, the ones that need no recall: paused, the per-payment maximum, the daily
 * budget, a past refusal of this recipient, a bad outcome the owner has not said yes past,
 * and a matching grant. Returns null when none of them decides, which is the only case in
 * which recall is worth calling.
 */
export function rulesBeforeRecall(facts: Omit<DecideFacts, 'recall'>): RuleResult | null {
  const { settings, amountAtomic } = facts;
  const host = hostLabel(facts.sellerHost);
  if (settings.paused || settings.autoPausedReason !== null) {
    return result('refused', 'paused', 'Automatic payments are paused for this account.');
  }
  if (amountAtomic > settings.perPaymentMaxAtomic) {
    return result(
      'refused',
      'over_payment_max',
      `This payment of ${formatUsdc(amountAtomic)} USDC is over your limit of ${formatUsdc(settings.perPaymentMaxAtomic)} USDC per payment.`,
    );
  }
  if (facts.heldOrSpentAtomic + amountAtomic > settings.dailyBudgetAtomic) {
    return result(
      'refused',
      'over_daily_budget',
      `This payment of ${formatUsdc(amountAtomic)} USDC would take the last 24 hours past your daily budget of ${formatUsdc(settings.dailyBudgetAtomic)} USDC.`,
    );
  }
  // An exact lookup by recipient, so no purpose text, distance or result limit can hide it (C11).
  if (facts.refusalMemoryIds.length > 0) {
    return result('refused', 'refused_recipient', `You refused payments to ${host} before.`, facts.refusalMemoryIds);
  }
  // Cited worst first, so the citation cap can only drop the memories of milder payments.
  const bad = [...facts.badOutcomes].sort(worstFirst);
  const [worst] = bad;
  if (worst !== undefined) {
    return capAsk(
      facts,
      result(
        'asked',
        'bad_outcome',
        badOutcomeReason(facts.sellerHost, worst),
        bad.flatMap((payment) => payment.outcomeMemoryIds),
      ),
    );
  }
  if (facts.grantId !== undefined) {
    return { ...result('approved', 'grant', `You approved this payment to ${host} when Ellai asked.`), grantId: facts.grantId };
  }
  return null;
}

function rulesAfterRecall(facts: DecideFacts): RuleResult {
  const { settings, recall } = facts;
  const host = hostLabel(facts.sellerHost);
  if (recall.kind === 'failed') {
    return result('asked', 'recall_unavailable', 'Ellai could not check your past answers just now, so it is asking you.');
  }
  // Past the owner's cutoff, every hit the limit hid is farther still and never counts. Inside
  // it, the hidden hits can only be more approvals: refusals (C11) and bad outcomes were already
  // looked up exactly in rulesBeforeRecall. So the visible approvals may still approve, but
  // falling short of approvalsNeeded proves nothing (C12). Written as "not at or past" so a
  // cutoff that is not a number counts as cut inside it.
  const cutInside = recall.cutOffAt !== null && !(recall.cutOffAt >= settings.distanceCutoff);
  // Keyed by memory id, so a hit the relayer repeats counts once.
  const matching = new Map<string, { amountAtomic: bigint; distance: number }>();
  for (const hit of recall.hits) {
    if (
      hit.countsAsOwnerDecision === true &&
      hit.verdict === 'approve' &&
      hit.recipient === facts.recipient &&
      hit.amountAtomic >= facts.amountAtomic &&
      hit.distance < settings.distanceCutoff
    ) {
      const seen = matching.get(hit.memoryId);
      if (seen === undefined || hit.distance < seen.distance) matching.set(hit.memoryId, { amountAtomic: hit.amountAtomic, distance: hit.distance });
    }
  }
  const needed = settings.approvalsNeeded;
  if (Number.isInteger(needed) && needed >= 1 && matching.size >= needed) {
    const highest = [...matching.values()].map((match) => match.amountAtomic).reduce((a, b) => (b > a ? b : a));
    return {
      ...result(
        'approved',
        'learned',
        `You approved ${plural(matching.size, 'payment')} like this to ${host}, up to ${formatUsdc(highest)} USDC.`,
        [...matching.keys()],
      ),
      citedDistances: new Map([...matching].map(([memoryId, match]) => [memoryId, match.distance])),
    };
  }
  if (cutInside) {
    return result('asked', 'recall_unavailable', 'Ellai found more past answers like this than it can check at once, so it is asking you.');
  }
  if (matching.size === 0) return result('asked', 'no_match', `You have not approved a payment like this to ${host} yet.`);
  return result(
    'asked',
    'no_match',
    `You approved ${plural(matching.size, 'payment')} like this to ${host}. Ellai needs ${needed} before it pays on its own.`,
  );
}

/**
 * Decides one payment with fixed rules, first match wins:
 * 1 paused, 2 over the per-payment maximum, 3 over the daily budget, 4 a past refusal of
 * this recipient (refuse); 5 a bad outcome the owner has not yet said yes past (ask); 6 a matching grant
 * (approve); 7 recall failed (ask, recall_unavailable); 8 at least approvalsNeeded close owner
 * approvals for this recipient at or above this amount among the hits returned (approve,
 * learned), whether or not the result came back full; 9 a result that came back full with its
 * farthest hit inside the cutoff, or a cutoff that is not a number, and too few approvals among
 * the hits returned (ask, recall_unavailable), since the hits the limit hid could have been the
 * missing approvals; 10 otherwise ask (no_match). A full result can never hide a refusal or a
 * bad outcome, because rules 4 and 5 find those by exact lookup. An ask from rules 5 to 10 is
 * refused instead when the agent's question queue is full. Pure: no database, no network.
 */
export function applyRules(facts: DecideFacts): RuleResult {
  return rulesBeforeRecall(facts) ?? capAsk(facts, rulesAfterRecall(facts));
}
