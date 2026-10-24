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

export type RecallResult = { kind: 'failed' } | { kind: 'hits'; limitReached: boolean; hits: RecallHit[] };

/** A verified payment to this recipient that delivered nothing, signed after the owner last approved the recipient. */
export interface BadOutcome {
  paymentId: string;
  amountAtomic: bigint;
  signedAt: Date;
  /** The outcome memories written for it so far, possibly none: the payment alone is enough to ask. */
  outcomeMemoryIds: string[];
}

export interface DecideFacts {
  settings: OwnerSettings;
  /** Everything signed in the last 24 hours and not released, in atomic USDC. */
  spentLast24hAtomic: bigint;
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

// The queue cap turns an ask into a refusal and leaves approvals and refusals alone (C22).
// A count that is not below the cap, including one that is not a number, refuses.
function capAsk(facts: Omit<DecideFacts, 'recall'>, decided: RuleResult): RuleResult {
  if (decided.outcome !== 'asked' || facts.pendingQuestions < facts.maxPending) return decided;
  return result('refused', 'too_many_pending', `This agent already has ${plural(facts.pendingQuestions, 'question')} waiting for you.`);
}

/**
 * Rules 1 to 6, the ones that need no recall: paused, the per-payment maximum, the daily
 * budget, a past refusal of this recipient, a bad outcome since the owner last approved it,
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
  if (facts.spentLast24hAtomic + amountAtomic > settings.dailyBudgetAtomic) {
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
  if (facts.badOutcomes.length > 0) {
    const latest = facts.badOutcomes.reduce((a, b) => (b.signedAt > a.signedAt ? b : a));
    return capAsk(
      facts,
      result(
        'asked',
        'bad_outcome',
        `${hostLabel(facts.sellerHost, true)} took ${formatUsdc(latest.amountAtomic)} USDC last time and returned nothing.`,
        facts.badOutcomes.flatMap((bad) => bad.outcomeMemoryIds),
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
  if (recall.kind === 'failed' || recall.limitReached) {
    return result('asked', 'recall_unavailable', 'Ellai could not check your past answers just now, so it is asking you.');
  }
  // Keyed by memory id, so a hit the relayer repeats counts once.
  const matching = new Map<string, bigint>();
  for (const hit of recall.hits) {
    if (
      hit.countsAsOwnerDecision === true &&
      hit.verdict === 'approve' &&
      hit.recipient === facts.recipient &&
      hit.amountAtomic >= facts.amountAtomic &&
      hit.distance < settings.distanceCutoff
    ) {
      matching.set(hit.memoryId, hit.amountAtomic);
    }
  }
  const needed = settings.approvalsNeeded;
  if (Number.isInteger(needed) && needed >= 1 && matching.size >= needed) {
    const highest = [...matching.values()].reduce((a, b) => (b > a ? b : a));
    return result(
      'approved',
      'learned',
      `You approved ${plural(matching.size, 'payment')} like this to ${host}, up to ${formatUsdc(highest)} USDC.`,
      [...matching.keys()],
    );
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
 * this recipient (refuse); 5 a bad outcome since the last approval (ask); 6 a matching grant
 * (approve); 7 recall failed or hit its limit (ask); 8 enough close owner approvals for this
 * recipient at or above this amount (approve); 9 otherwise ask. An ask from rules 5 to 9 is
 * refused instead when the agent's question queue is full. Pure: no database, no network.
 */
export function applyRules(facts: DecideFacts): RuleResult {
  return rulesBeforeRecall(facts) ?? capAsk(facts, rulesAfterRecall(facts));
}
