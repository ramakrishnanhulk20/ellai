// Covers: the words and colours a public decision wears. "Paid" only with a digest, the cause
// only from the rule, a reason line for every rule the server writes, the landing page's second
// counter counting only learned approvals, and the hero picking its example by the order
// verified learned, learned, verified grant.
// Does NOT cover: how the components lay these words out, or what the server writes into a
// decision (memory-map.test.ts and decide.test.ts).
import { describe, expect, it } from 'vitest';
import { badgeFor, reasonFor } from '../src/ui/DecisionCard.js';
import { exampleSignature, pickExample } from '../src/ui/decide-model.js';
import type { MapDecision } from '../src/ui/memory-map.js';
import { buildTimeline, tallyThrough, timelineSignature } from '../src/ui/timeline-model.js';

const DIGEST = '4Hq9c2DigestOfAVerifiedPayment';

function decision(change: Partial<MapDecision> = {}): MapDecision {
  return {
    id: 'd1',
    at: '2026-10-01T10:00:00.000Z',
    outcome: 'approved',
    rule: 'learned',
    host: 'hotels.example',
    amountUsdc: '0.100000',
    digest: null,
    citations: [],
    ...change,
  };
}

describe('badgeFor', () => {
  it('says paid only when a digest is set, and takes the cause from the rule', () => {
    expect(badgeFor(decision({ digest: DIGEST }))).toEqual({ label: 'PAID ON ITS OWN', tone: 'border-paid text-paid' });
    expect(badgeFor(decision({ rule: 'grant', digest: DIGEST }))).toEqual({
      label: 'PAID WITH YOUR YES',
      tone: 'border-paid text-paid',
    });
    expect(badgeFor(decision())).toEqual({ label: 'APPROVED ON ITS OWN', tone: 'border-accent text-accent' });
    expect(badgeFor(decision({ rule: 'grant' }))).toEqual({
      label: 'APPROVED WITH YOUR YES',
      tone: 'border-line text-muted',
    });
  });

  it('treats any approval that is not learned as a yes the owner gave', () => {
    expect(badgeFor(decision({ rule: 'something_new' })).label).toBe('APPROVED WITH YOUR YES');
    expect(badgeFor(decision({ rule: 'something_new', digest: DIGEST })).label).toBe('PAID WITH YOUR YES');
  });

  it('keeps asked and refused as they were, whatever the rule or digest', () => {
    expect(badgeFor(decision({ outcome: 'asked', rule: 'no_match' }))).toEqual({
      label: 'ASKED YOU',
      tone: 'border-asked text-asked',
    });
    expect(badgeFor(decision({ outcome: 'refused', rule: 'refused_recipient', digest: DIGEST }))).toEqual({
      label: 'REFUSED',
      tone: 'border-refused text-refused',
    });
  });
});

describe('reasonFor', () => {
  it('words a learned approval by what it matched', () => {
    const citations = [
      { blobId: 'a', distance: 0.31 },
      { blobId: 'b', distance: 0.118 },
      { blobId: 'c', distance: null },
    ];
    expect(reasonFor(decision({ citations }))).toBe('Matched 3 of your past answers, closest 0.12');
    expect(reasonFor(decision({ citations: [{ blobId: 'a', distance: null }] }))).toBe('Matched 1 of your past answers');
    expect(reasonFor(decision())).toBe('Matched your past answers');
  });

  it('says paid for a grant only when a digest is set', () => {
    expect(reasonFor(decision({ rule: 'grant', digest: DIGEST }))).toBe('Paid with the yes you gave');
    expect(reasonFor(decision({ rule: 'grant' }))).toBe('Approved with the yes you gave');
  });

  it('has a line for every rule the server writes, and none for a rule it does not know', () => {
    const lines: Array<[string, string]> = [
      ['refused_recipient', 'You said no to this seller before'],
      ['bad_outcome', 'This seller has not been seen to deliver yet'],
      ['no_match', 'Not enough past answers like this yet'],
      ['recall_unavailable', 'Could not search your past answers, so it asked'],
      ['too_many_pending', 'Too many questions already waiting for you'],
      ['paused', 'Payments are paused'],
      ['over_payment_max', 'Above the most you allow per payment'],
      ['over_daily_budget', 'Over your daily budget'],
    ];
    for (const [rule, line] of lines) {
      expect(reasonFor(decision({ outcome: 'asked', rule }))).toBe(line);
    }
    expect(reasonFor(decision({ rule: 'something_new' }))).toBeNull();
  });
});

describe('the learning counters', () => {
  it('counts questions, and counts only learned approvals, paid or not, not grants', () => {
    const nodes = buildTimeline([
      decision({ id: '5', at: '2026-10-05T10:00:00.000Z', outcome: 'refused', rule: 'refused_recipient' }),
      decision({ id: '4', at: '2026-10-04T10:00:00.000Z', rule: 'grant', digest: DIGEST }),
      decision({ id: '3', at: '2026-10-03T10:00:00.000Z', digest: DIGEST }),
      decision({ id: '2', at: '2026-10-02T10:00:00.000Z' }),
      decision({ id: '1', at: '2026-10-01T10:00:00.000Z', outcome: 'asked', rule: 'no_match' }),
    ]);
    expect(nodes.map((node) => node.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(tallyThrough(nodes, 0)).toEqual({ asked: 0, learned: 0 });
    expect(tallyThrough(nodes, 2)).toEqual({ asked: 1, learned: 1 });
    expect(tallyThrough(nodes, 5)).toEqual({ asked: 1, learned: 2 });
  });

  it('keeps the whole decision on each mark so its badge can be worked out', () => {
    const [node] = buildTimeline([decision({ digest: DIGEST })]);
    expect(node?.decision.digest).toBe(DIGEST);
  });

  it('changes the timeline signature when a decision gains a digest', () => {
    expect(timelineSignature([decision()])).not.toBe(timelineSignature([decision({ digest: DIGEST })]));
  });
});

describe('pickExample', () => {
  const newer = '2026-10-09T10:00:00.000Z';
  const older = '2026-10-02T10:00:00.000Z';

  it('prefers a verified learned approval over everything, newest first', () => {
    const picked = pickExample([
      decision({ id: 'grant-paid', at: newer, rule: 'grant', digest: DIGEST }),
      decision({ id: 'learned-open', at: newer }),
      decision({ id: 'learned-paid-old', at: older, digest: 'old' }),
      decision({ id: 'learned-paid-new', at: '2026-10-05T10:00:00.000Z', digest: 'new' }),
    ]);
    expect(picked?.decision.id).toBe('learned-paid-new');
    expect(picked?.digest).toBe('new');
  });

  it('falls to a learned approval with no payment, then to a verified grant', () => {
    expect(
      pickExample([
        decision({ id: 'grant-paid', at: newer, rule: 'grant', digest: DIGEST }),
        decision({ id: 'learned-open', at: older }),
      ])?.decision.id,
    ).toBe('learned-open');
    expect(
      pickExample([
        decision({ id: 'grant-open', at: newer, rule: 'grant' }),
        decision({ id: 'grant-paid', at: older, rule: 'grant', digest: DIGEST }),
      ])?.decision.id,
    ).toBe('grant-paid');
  });

  it('picks nothing from questions, refusals and unpaid grants', () => {
    expect(
      pickExample([
        decision({ outcome: 'asked', rule: 'no_match' }),
        decision({ outcome: 'refused', rule: 'refused_recipient' }),
        decision({ rule: 'grant' }),
      ]),
    ).toBeNull();
    expect(pickExample([])).toBeNull();
  });

  it('hands the card the picked decision, so its badge is never a fixed word', () => {
    const picked = pickExample([decision({ rule: 'grant', digest: DIGEST })]);
    expect(picked ? badgeFor(picked.decision).label : null).toBe('PAID WITH YOUR YES');
    const open = pickExample([decision()]);
    expect(open ? badgeFor(open.decision).label : null).toBe('APPROVED ON ITS OWN');
  });

  it('changes the example signature when the rule or the digest changes', () => {
    const base = exampleSignature(pickExample([decision()]));
    expect(exampleSignature(pickExample([decision({ digest: DIGEST })]))).not.toBe(base);
    expect(exampleSignature(pickExample([decision({ rule: 'grant', digest: DIGEST })]))).not.toBe(
      exampleSignature(pickExample([decision({ digest: DIGEST })])),
    );
  });
});
