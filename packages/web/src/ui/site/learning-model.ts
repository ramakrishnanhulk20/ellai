import { badgeFor } from '../DecisionCard.js';
import { formatUsdc } from '../format-usdc.js';
import { formatWhen, type TimelineNode } from '../timeline-model.js';

export type EarlyLate = { n: number; early: number; late: number };

const WINDOW_MAX = 10;

/**
 * Counts the questions among the first decisions and among the latest ones, with the same window size
 * on both sides so the two numbers can be compared. The window is ten, or half the decisions when
 * there are fewer than twenty. Below two decisions per side a comparison says nothing, so it is null.
 * Expects the nodes oldest first, which is how buildTimeline returns them.
 */
export function earlyLate(nodes: readonly TimelineNode[]): EarlyLate | null {
  const n = Math.min(WINDOW_MAX, Math.floor(nodes.length / 2));
  if (n < 2) return null;
  const asked = (slice: readonly TimelineNode[]) => slice.filter((node) => node.kind === 'asked').length;
  return { n, early: asked(nodes.slice(0, n)), late: asked(nodes.slice(-n)) };
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** What a screen reader says for one mark, for example "28 Oct, 09:14: Paid on its own, 0.01 USDC to shop.example". */
export function markLabel(node: TimelineNode): string {
  const what = sentenceCase(badgeFor(node.decision).label);
  return `${formatWhen(node.at)}: ${what}, ${formatUsdc(node.amountUsdc)} USDC to ${node.host}`;
}
