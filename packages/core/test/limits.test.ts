// Covers: the bounds of an owner's visit, the background work an owner's own request starts, and
// how they sit against the route ceiling and the tick's time budget they run under.
// Does NOT cover: any other limit (each is held by the tests of the code that uses it), or the
// visit itself (packages/web's visit.test.ts).
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';

describe('owner visit limits', () => {
  it('are the values the visit was designed with', () => {
    expect({
      ownerVisitLeaseMs: LIMITS.ownerVisitLeaseMs,
      ownerVisitPassGapMs: LIMITS.ownerVisitPassGapMs,
      ownerVisitMaxPasses: LIMITS.ownerVisitMaxPasses,
      ownerVisitMinGapMs: LIMITS.ownerVisitMinGapMs,
    }).toEqual({ ownerVisitLeaseMs: 300_000, ownerVisitPassGapMs: 10_000, ownerVisitMaxPasses: 8, ownerVisitMinGapMs: 60_000 });
  });

  it('holds a lease exactly as long as the longest route a visit runs under, so it outlives every run and frees itself after a killed one', () => {
    expect(LIMITS.ownerVisitLeaseMs).toBe(LIMITS.slowRouteMaxDurationS * 1_000);
  });

  it('fits the waits between every pass of one visit inside the time budget a visit shares with the tick', () => {
    expect((LIMITS.ownerVisitMaxPasses - 1) * LIMITS.ownerVisitPassGapMs).toBeLessThan(LIMITS.tickTimeBudgetMs);
  });
});
