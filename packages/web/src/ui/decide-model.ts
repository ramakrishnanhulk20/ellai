import { formatUsdc } from './format-usdc.js';
import type { MapDecision } from './memory-map.js';

export const STEPS = [
  {
    title: 'Your agent hits a paywall.',
    text: 'It asks a seller for something, and the seller answers 402: pay first.',
  },
  {
    title: 'Ellai remembers what you said.',
    text: 'It searches your Walrus Memory for past answers that look like this one.',
  },
  {
    title: 'Fixed rules decide. No AI touches your money.',
    text: 'A refusal always wins. Your limits come next. It pays on its own only when you have said yes enough times before.',
  },
  {
    title: 'It pays from a small purse.',
    text: 'The money stays in your wallet behind a Sui allowance you set and can revoke. Ellai keeps only a few cents ready to pay.',
  },
  {
    title: 'Sui confirms it. Walrus remembers it.',
    text: 'Tatum reads the payment back from Sui, and the outcome becomes one more memory, so the next answer is better.',
  },
] as const;

export const STEP_COUNT = STEPS.length;

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

export function distanceLabel(distance: number | null): string | null {
  return distance === null ? null : `distance ${distance.toFixed(2)}`;
}

/** The rows of step 3. The last one needs a count, so it is left out when the example has no citations. */
export function checkRows(example: Example | null): string[] {
  const rows = ['You never refused this seller', 'Within your limits'];
  if (example && example.citationCount > 0) {
    rows.push(`${example.citationCount} of your yeses look like this`);
  }
  return rows;
}

/** Everything below is in stage units: the stage is a 640 by 640 square that scales to fit. */
export const STAGE = 640;
export const RING = { cx: 230, cy: 240, r: 170 };
export const GAP_DEGREES = 40;
export const GAP_CENTRE_DEGREES = 45;

export const CARD = { x: 420, width: 220, cy: 240 };
export const ROWS = { x: 60, y: 430, width: 340, rowHeight: 28 };
export const BAR = { x: 50, y: 560, width: 360, height: 8, purseWidth: 40, labelY: 540, purseLabelY: 574 };

export const CITE_ANGLES = [150, 30, 210] as const;
export const NEW_DOT_ANGLE = 330;
const DOT_FRACTION = 0.4;

/** A point at 40 percent of the ring's radius. The angle runs counter-clockwise from 3 o'clock. */
export function innerPoint(angleDegrees: number): { x: number; y: number } {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: RING.cx + RING.r * DOT_FRACTION * Math.cos(radians),
    y: RING.cy - RING.r * DOT_FRACTION * Math.sin(radians),
  };
}

/** The limit ring as an open arc: a full circle minus the 40 degree gap at the top right. */
export function ringPath(): string {
  const point = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${(RING.cx + RING.r * Math.cos(radians)).toFixed(3)} ${(RING.cy - RING.r * Math.sin(radians)).toFixed(3)}`;
  };
  const start = GAP_CENTRE_DEGREES + GAP_DEGREES / 2;
  const end = GAP_CENTRE_DEGREES - GAP_DEGREES / 2 + 360;
  return `M${point(start)}A${RING.r} ${RING.r} 0 1 0 ${point(end)}`;
}

/** How bright a step's additions are: hidden before the step, full on it, dimmed once later steps arrive. */
export function layerOpacity(step: number, addedAt: number): number {
  if (step < addedAt) return 0;
  return step === addedAt ? 1 : 0.4;
}

/** The request card is touched again in step 5 (it gets its badge), so it comes back to full. */
export function cardOpacity(step: number): number {
  return step === 0 || step === STEP_COUNT - 1 ? 1 : 0.4;
}

export function percent(units: number): string {
  return `${(units / STAGE) * 100}%`;
}
