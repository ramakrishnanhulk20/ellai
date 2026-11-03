import { formatUsdc } from './format-usdc.js';
import type { MapDecision } from './memory-map.js';

/** The real decision the five steps are told with. Every field comes from the memory map. */
export type Example = {
  amount: string;
  host: string;
  /** Always set: the steps tell a payment story, so only a decision with a verified payment is picked. */
  digest: string;
  /** The picked decision whole, because the card's badge is worked out from its rule and digest. */
  decision: MapDecision;
  /** All memories the decision cited. */
  citationCount: number;
  /** Closest-match distances of the first three citations, in order. Null where recall gave none. */
  distances: (number | null)[];
};

const MAX_DOTS = 3;

/** 2 is a payment verified on Sui on a learned rule, 1 is one on any other rule, 0 cannot tell the story. */
function exampleRank(decision: MapDecision): number {
  if (decision.outcome !== 'approved' || !decision.digest) return 0;
  return decision.rule === 'learned' ? 2 : 1;
}

/**
 * The newest approved learned decision with a verified payment. If there is none, the newest
 * approved decision on any other rule with a verified payment. An approval with no payment is
 * never picked, because the steps say the purse paid and Sui confirmed. If there is none, the
 * steps are told with no numbers.
 */
export function pickExample(decisions: readonly MapDecision[]): Example | null {
  let best: MapDecision | null = null;
  let bestRank = 0;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const decision of decisions) {
    const rank = exampleRank(decision);
    if (rank === 0) continue;
    const time = Date.parse(decision.at);
    if (rank > bestRank || (rank === bestRank && time > bestTime)) {
      best = decision;
      bestRank = rank;
      bestTime = time;
    }
  }
  if (!best?.digest) return null;
  return {
    amount: formatUsdc(best.amountUsdc),
    host: best.host,
    digest: best.digest,
    decision: best,
    citationCount: best.citations.length,
    distances: best.citations.slice(0, MAX_DOTS).map((citation) => citation.distance),
  };
}

/** Changes only when the picked example changes, so a refresh with the same data does not rebuild the pin. */
export function exampleSignature(example: Example | null): string {
  if (!example) return 'none';
  return [
    example.amount,
    example.host,
    example.decision.rule,
    example.digest,
    example.citationCount,
    example.distances.join(','),
  ].join('|');
}
