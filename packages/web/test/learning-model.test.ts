// Covers: the numbers and the sentence behind the landing page's "asks you less as it learns" section.
// How many questions sit among the first decisions and among the latest ones (the window is ten, or
// half the decisions when there are fewer than twenty, and nothing below two a side), that only
// questions are counted, and the sentence a screen reader gets for each mark. All pure, no database.
// Does NOT cover: how the strip, the brackets and the tooltip are drawn or animated, or how the
// timeline orders the decisions (that is buildTimeline, which the strip trusts).
import { describe, expect, it } from 'vitest';
import type { MapDecision } from '../src/ui/memory-map.js';
import { formatUsdc } from '../src/ui/format-usdc.js';
import { earlyLate, markLabel } from '../src/ui/site/learning-model.js';
import { buildTimeline, formatWhen, type NodeKind, type TimelineNode } from '../src/ui/timeline-model.js';

function decision(change: Partial<MapDecision> = {}): MapDecision {
  return {
    id: 'd1',
    at: '2026-10-01T10:00:00.000Z',
    outcome: 'approved',
    rule: 'learned',
    host: 'hotels.example',
    amountUsdc: '0.010000',
    digest: null,
    citations: [],
    ...change,
  };
}

function nodeOf(kind: NodeKind, index: number): TimelineNode {
  const at = new Date(Date.UTC(2026, 9, 1, 10, index)).toISOString();
  const base = { id: `d${index}`, at };
  const made =
    kind === 'asked'
      ? decision({ ...base, outcome: 'asked', rule: 'no_match' })
      : kind === 'refused'
        ? decision({ ...base, outcome: 'refused', rule: 'refused_recipient' })
        : kind === 'grant'
          ? decision({ ...base, rule: 'grant' })
          : decision({ ...base, rule: 'learned' });
  const [node] = buildTimeline([made]);
  if (!node) throw new Error('buildTimeline returned no node');
  return node;
}

/** Oldest first, the order buildTimeline gives. */
function nodesOf(kinds: NodeKind[]): TimelineNode[] {
  return kinds.map((kind, index) => nodeOf(kind, index));
}

function repeat(kind: NodeKind, times: number): NodeKind[] {
  return Array.from({ length: times }, () => kind);
}

describe('earlyLate', () => {
  it('is null with no decisions', () => {
    expect(earlyLate([])).toBeNull();
  });

  it('is null with three decisions, because half of three leaves one a side', () => {
    expect(earlyLate(nodesOf(['asked', 'learned', 'learned']))).toBeNull();
  });

  it('compares two against two with four decisions', () => {
    expect(earlyLate(nodesOf(['asked', 'asked', 'learned', 'asked']))).toEqual({ n: 2, early: 2, late: 1 });
  });

  it('uses ten a side with twenty decisions', () => {
    const kinds = [...repeat('asked', 4), ...repeat('learned', 12), ...repeat('asked', 1), ...repeat('learned', 3)];
    expect(kinds).toHaveLength(20);
    expect(earlyLate(nodesOf(kinds))).toEqual({ n: 10, early: 4, late: 1 });
  });

  it('keeps the window at ten with twenty-seven decisions and ignores the middle seven', () => {
    // Today's public record: five questions in the first ten, then only approvals and one refusal.
    const kinds: NodeKind[] = [
      ...repeat('asked', 5),
      ...repeat('grant', 5),
      ...repeat('asked', 7),
      ...repeat('learned', 9),
      'refused',
    ];
    expect(kinds).toHaveLength(27);
    expect(earlyLate(nodesOf(kinds))).toEqual({ n: 10, early: 5, late: 0 });
  });

  it('counts only questions, never approvals, grants or refusals', () => {
    const kinds: NodeKind[] = [
      'learned',
      'grant',
      'refused',
      'learned',
      'asked',
      'learned',
      'grant',
      'refused',
      'asked',
      'grant',
    ];
    expect(earlyLate(nodesOf(kinds))).toEqual({ n: 5, early: 1, late: 1 });
  });
});

describe('markLabel', () => {
  it('writes the time, the sentence-cased badge, the trimmed amount and the host', () => {
    const node = nodeOf('learned', 3);
    expect(markLabel(node)).toBe(`${formatWhen(node.at)}: Approved on its own, 0.01 USDC to hotels.example`);
  });

  it('says paid when the decision carries a payment digest', () => {
    const [node] = buildTimeline([decision({ digest: '4Hq9c2DigestOfAVerifiedPayment', amountUsdc: '0.250000' })]);
    if (!node) throw new Error('buildTimeline returned no node');
    expect(markLabel(node)).toContain(': Paid on its own, 0.25 USDC to hotels.example');
  });

  it('names a question, a grant and a refusal in plain sentences', () => {
    expect(markLabel(nodeOf('asked', 1))).toContain(': Asked you, ');
    expect(markLabel(nodeOf('grant', 2))).toContain(': Approved with your yes, ');
    expect(markLabel(nodeOf('refused', 3))).toContain(': Refused, ');
  });

  it('keeps a host with spaces and brackets whole', () => {
    const [node] = buildTimeline([decision({ host: 'Ellai wallet check (learning test)', amountUsdc: '1.000000' })]);
    if (!node) throw new Error('buildTimeline returned no node');
    expect(markLabel(node).endsWith(`${formatUsdc('1.000000')} USDC to Ellai wallet check (learning test)`)).toBe(true);
  });
});
