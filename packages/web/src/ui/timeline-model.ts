import type { MapDecision } from './memory-map.js';

/** The four marks on the timeline. Approved decisions split by whether Ellai approved on a learned rule or on a grant. */
export type NodeKind = 'asked' | 'learned' | 'grant' | 'refused';

export type TimelineNode = {
  id: string;
  kind: NodeKind;
  outcome: MapDecision['outcome'];
  at: string;
  host: string;
  amountUsdc: string;
  /** The decision behind the mark, kept whole because its badge reads the rule and the digest. */
  decision: MapDecision;
  /** Where the mark sits along the line, from 0 (left end) to 1 (right end). */
  position: number;
};

function kindOf(decision: MapDecision): NodeKind {
  if (decision.outcome === 'asked') return 'asked';
  if (decision.outcome === 'refused') return 'refused';
  return decision.rule === 'learned' ? 'learned' : 'grant';
}

/**
 * Lays the decisions out oldest first, evenly spaced, each half a step in from the ends so the
 * first mark does not sit on the line's edge. The map arrives newest first, so decisions with the
 * same timestamp are reversed to keep their true order.
 */
export function buildTimeline(decisions: readonly MapDecision[]): TimelineNode[] {
  const oldestFirst = decisions
    .map((decision, index) => ({ decision, index, time: Date.parse(decision.at) }))
    .sort((a, b) => a.time - b.time || b.index - a.index);
  return oldestFirst.map(({ decision }, slot) => ({
    id: decision.id,
    kind: kindOf(decision),
    outcome: decision.outcome,
    at: decision.at,
    host: decision.host,
    amountUsdc: decision.amountUsdc,
    decision,
    position: (slot + 0.5) / oldestFirst.length,
  }));
}

/**
 * Changes whenever the set of marks changes, and not when a refresh brings the same decisions back.
 * The digest is in it because a decision that gets paid later changes its badge.
 */
export function timelineSignature(decisions: readonly MapDecision[]): string {
  return decisions
    .map((decision) => `${decision.id}:${decision.outcome}:${decision.rule}:${decision.digest ?? ''}`)
    .join('|');
}

export type Tally = { asked: number; learned: number };

/** How many questions and approvals on its own (paid or not) sit among the first `shown` marks. Grants are not counted. */
export function tallyThrough(nodes: readonly TimelineNode[], shown: number): Tally {
  let asked = 0;
  let learned = 0;
  for (const node of nodes.slice(0, shown)) {
    if (node.kind === 'asked') asked += 1;
    else if (node.kind === 'learned') learned += 1;
  }
  return { asked, learned };
}

/** The date and time in the viewer's own locale, for example "28 Oct, 09:14". */
export function formatWhen(isoTime: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoTime));
}
