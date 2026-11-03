// Covers: the numbers and sentences behind the landing page's pinned payment journey. What the five
// cards are told from the public memory map (the example, the memories it cited, the question shown
// and the owner's answer to it, with the learning test's stand-in seller shown last), which beat and where along the route the scroll is at any moment, how far
// the learning arc has drawn, and the day format. All pure, no database.
// Does NOT cover: how the route and the cards are drawn or animated, the GSAP pin, or which decision
// the server writes into the map (memory-map.test.ts and decide.test.ts).
import { describe, expect, it } from 'vitest';
import { pickExample } from '../src/ui/decide-model.js';
import type { MapDecision, MapMemory, MemoryMap } from '../src/ui/memory-map.js';
import { beatAt, buildJourney, formatDay, loopProgress, STAND_IN_HOST, tokenX } from '../src/ui/site/journey-model.js';

const DIGEST = '4Hq9c2DigestOfAVerifiedPayment';

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

function memory(change: Partial<MapMemory> = {}): MapMemory {
  return {
    blobId: 'blob-a',
    verdict: 'approve',
    host: 'hotels.example',
    amountUsdc: '0.250000',
    at: '2026-10-27T05:11:36.976Z',
    ...change,
  };
}

function mapOf(decisions: MapDecision[], memories: MapMemory[]): MemoryMap {
  return {
    generatedAt: '2026-11-03T08:00:00.000Z',
    memories,
    decisions,
    totals: { memories: memories.length, learnedApprovals: 0, questionsAsked: 0 },
  };
}

describe('buildJourney', () => {
  it('has nothing to say without a map', () => {
    expect(buildJourney(null)).toEqual({ example: null, cited: [], asked: null, answer: null });
  });

  it('takes its example from pickExample and nothing else', () => {
    const decisions = [
      decision({ id: 'old', at: '2026-10-01T10:00:00.000Z', digest: DIGEST }),
      decision({ id: 'new', at: '2026-10-05T10:00:00.000Z', digest: DIGEST, host: 'flights.example' }),
      decision({ id: 'unpaid', at: '2026-10-09T10:00:00.000Z', digest: null }),
    ];
    const journey = buildJourney(mapOf(decisions, []));
    expect(journey.example).toEqual(pickExample(decisions));
    expect(journey.example?.host).toBe('flights.example');
  });

  it('reads host, verdict, amount and date from a cited memory that is in the map', () => {
    const paid = decision({
      digest: DIGEST,
      citations: [{ blobId: 'blob-a', distance: 0.12 }],
    });
    const journey = buildJourney(mapOf([paid], [memory()]));
    expect(journey.cited).toEqual([
      { blobId: 'blob-a', verdict: 'approve', host: 'hotels.example', amount: '0.25', at: '2026-10-27T05:11:36.976Z' },
    ]);
  });

  it('keeps the blob id and nulls the rest for a cited memory the map does not hold', () => {
    const paid = decision({
      digest: DIGEST,
      citations: [{ blobId: 'blob-missing', distance: null }],
    });
    const journey = buildJourney(mapOf([paid], [memory()]));
    expect(journey.cited).toEqual([{ blobId: 'blob-missing', verdict: null, host: null, amount: null, at: null }]);
  });

  it('cites at most three memories, in the order the decision listed them', () => {
    const paid = decision({
      digest: DIGEST,
      citations: ['c1', 'c2', 'c3', 'c4'].map((blobId) => ({ blobId, distance: null })),
    });
    const journey = buildJourney(mapOf([paid], []));
    expect(journey.cited.map((entry) => entry.blobId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('picks the newest asked decision as the question', () => {
    const decisions = [
      decision({ id: 'a1', outcome: 'asked', rule: 'no_match', at: '2026-10-03T10:00:00.000Z', host: 'one.example', amountUsdc: '1.000000' }),
      decision({ id: 'a2', outcome: 'asked', rule: 'no_match', at: '2026-10-08T10:00:00.000Z', host: 'two.example', amountUsdc: '0.500000' }),
      decision({ id: 'p1', outcome: 'approved', at: '2026-10-09T10:00:00.000Z', host: 'three.example' }),
    ];
    expect(buildJourney(mapOf(decisions, [])).asked).toEqual({
      amount: '0.50',
      host: 'two.example',
      at: '2026-10-08T10:00:00.000Z',
    });
  });

  it('has no question when nothing was asked', () => {
    expect(buildJourney(mapOf([decision()], [])).asked).toBeNull();
  });

  it('shows a real seller question ahead of the learning test stand-in, even when the stand-in is newer', () => {
    const decisions = [
      decision({ id: 'real', outcome: 'asked', rule: 'no_match', at: '2026-10-03T10:00:00.000Z', host: 'piptradedex.xyz' }),
      decision({ id: 'test', outcome: 'asked', rule: 'no_match', at: '2026-10-27T10:00:00.000Z', host: STAND_IN_HOST }),
    ];
    expect(buildJourney(mapOf(decisions, [])).asked?.host).toBe('piptradedex.xyz');
  });

  it('uses the stand-in question when it is the only one asked', () => {
    const decisions = [
      decision({ id: 'test', outcome: 'asked', rule: 'no_match', at: '2026-10-27T10:00:00.000Z', host: STAND_IN_HOST }),
    ];
    expect(buildJourney(mapOf(decisions, [])).asked?.host).toBe(STAND_IN_HOST);
  });

  it('finds the first answer about the asked seller written at or after the question', () => {
    const asked = decision({ id: 'q', outcome: 'asked', rule: 'no_match', at: '2026-10-10T10:00:00.000Z', host: 'piptradedex.xyz' });
    const memories = [
      memory({ blobId: 'before', host: 'piptradedex.xyz', at: '2026-10-09T10:00:00.000Z' }),
      memory({ blobId: 'other-seller', host: 'hotels.example', at: '2026-10-10T10:30:00.000Z' }),
      memory({ blobId: 'later', host: 'piptradedex.xyz', verdict: 'refuse', at: '2026-10-12T10:00:00.000Z' }),
      memory({ blobId: 'first', host: 'piptradedex.xyz', verdict: 'refuse', at: '2026-10-10T10:00:00.000Z' }),
    ];
    const journey = buildJourney(mapOf([asked], memories));
    expect(journey.answer?.memory.blobId).toBe('first');
    expect(journey.answer?.forAsked).toBe(true);
  });

  it('falls back to the newest memory, marked as not for the question, when none matches', () => {
    const asked = decision({ id: 'q', outcome: 'asked', rule: 'no_match', at: '2026-10-10T10:00:00.000Z', host: 'piptradedex.xyz' });
    const early = memory({ blobId: 'early', host: 'hotels.example', at: '2026-10-01T00:00:00.000Z' });
    const late = memory({ blobId: 'late', host: 'hotels.example', at: '2026-10-20T00:00:00.000Z' });
    const alsoLate = memory({ blobId: 'also-late', host: 'hotels.example', at: '2026-10-20T00:00:00.000Z' });
    const journey = buildJourney(mapOf([asked], [early, late, alsoLate]));
    expect(journey.answer).toEqual({ memory: late, forAsked: false });
    expect(buildJourney(mapOf([asked], [alsoLate, late, early])).answer?.memory.blobId).toBe('also-late');
  });

  it('falls back to the newest memory when nothing was asked', () => {
    const early = memory({ blobId: 'early', at: '2026-10-01T00:00:00.000Z' });
    const late = memory({ blobId: 'late', at: '2026-10-20T00:00:00.000Z' });
    expect(buildJourney(mapOf([], [early, late])).answer).toEqual({ memory: late, forAsked: false });
  });

  it('has no answer when there are no memories', () => {
    const asked = decision({ id: 'q', outcome: 'asked', rule: 'no_match', host: 'piptradedex.xyz' });
    expect(buildJourney(mapOf([asked], [])).answer).toBeNull();
    expect(buildJourney(mapOf([], [])).answer).toBeNull();
  });
});

describe('beatAt', () => {
  it('moves to the next beat exactly at each fifth of the scroll', () => {
    expect(beatAt(0)).toBe(0);
    expect(beatAt(0.199)).toBe(0);
    expect(beatAt(0.2)).toBe(1);
    expect(beatAt(0.8)).toBe(4);
    expect(beatAt(1)).toBe(4);
  });

  it('stays inside the five beats for a progress outside 0 to 1', () => {
    expect(beatAt(-3)).toBe(0);
    expect(beatAt(7)).toBe(4);
  });
});

describe('tokenX', () => {
  it('rests on each node and travels to the next in the first 40 percent of its beat', () => {
    expect(tokenX(0)).toBe(0);
    expect(tokenX(0.08)).toBeCloseTo(0.25, 10);
    expect(tokenX(0.2)).toBeCloseTo(0.25, 10);
    expect(tokenX(0.6)).toBeCloseTo(0.75, 10);
    expect(tokenX(0.68)).toBeCloseTo(1, 10);
    expect(tokenX(1)).toBe(1);
  });

  it('is between the two nodes while it travels', () => {
    const middle = tokenX(0.04);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(0.25);
  });
});

describe('loopProgress', () => {
  it('stays at 0 until the last beat starts, then draws in the first 60 percent of it', () => {
    expect(loopProgress(0.79)).toBe(0);
    expect(loopProgress(0.8)).toBe(0);
    expect(loopProgress(0.86)).toBeCloseTo(0.5, 10);
    expect(loopProgress(0.92)).toBeCloseTo(1, 10);
    expect(loopProgress(1)).toBe(1);
  });
});

describe('formatDay', () => {
  it('writes the UTC day and short month in en-GB', () => {
    expect(formatDay('2026-10-27T05:11:36.976Z')).toBe('27 Oct');
  });

  it('uses the UTC day even when the local day would differ', () => {
    expect(formatDay('2026-10-27T23:59:59.000Z')).toBe('27 Oct');
  });

  it('returns a time it cannot read unchanged instead of throwing', () => {
    expect(formatDay('not a time')).toBe('not a time');
  });
});
