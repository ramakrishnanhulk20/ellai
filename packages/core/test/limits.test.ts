// Covers: the bounds of an owner's visit, the background work an owner's own request starts, and
// how they sit against the route ceiling and the tick's time budget they run under; and the read
// spacings and the refills share that keep visits at request rate to the tick's own cadence.
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

describe('what keeps visits at request rate to the tick cadence', () => {
  it('are the values they were designed with', () => {
    expect({
      tatumCallsRefillsPerOwnerPerDay: LIMITS.tatumCallsRefillsPerOwnerPerDay,
      pendingRefillReadIntervalMs: LIMITS.pendingRefillReadIntervalMs,
      freshRefillWindowMs: LIMITS.freshRefillWindowMs,
      refillErrorWaitMs: LIMITS.refillErrorWaitMs,
      closedWindowReadSpacingMs: LIMITS.closedWindowReadSpacingMs,
    }).toEqual({ tatumCallsRefillsPerOwnerPerDay: 100, pendingRefillReadIntervalMs: 600_000, freshRefillWindowMs: 120_000, refillErrorWaitMs: 600_000, closedWindowReadSpacingMs: 600_000 });
    expect({
      blobScanSpacingMs: LIMITS.blobScanSpacingMs,
      allowanceLagWaitMs: LIMITS.allowanceLagWaitMs,
      epochReadingReuseMs: LIMITS.epochReadingReuseMs,
    }).toEqual({ blobScanSpacingMs: 1_800_000, allowanceLagWaitMs: 60_000, epochReadingReuseMs: 600_000 });
  });

  it("fits one visit's whole budget inside the fresh-refill window, and waits less after an index lag than after a failed read", () => {
    expect(LIMITS.tickTimeBudgetMs).toBeLessThanOrEqual(LIMITS.freshRefillWindowMs);
    expect(LIMITS.allowanceLagWaitMs).toBeLessThan(LIMITS.refillErrorWaitMs);
  });

  it('reuses an epoch reading no longer than the closed-window spacing, so a closed window is still seen within one spacing of a read', () => {
    expect(LIMITS.epochReadingReuseMs).toBeLessThanOrEqual(LIMITS.closedWindowReadSpacingMs);
  });

  it('keeps one owner inside the refills pool, so a spent share leaves the pool for others', () => {
    expect(LIMITS.tatumCallsRefillsPerOwnerPerDay).toBeLessThan(LIMITS.tatumCallsRefillsPerDay);
  });

  it('reads a fresh refill on the passes of a visit and a stuck one no faster than the fresh window, and spaces the failed reads that end a payment at least 50 minutes', () => {
    expect(LIMITS.freshRefillWindowMs).toBeGreaterThan(LIMITS.ownerVisitPassGapMs);
    expect(LIMITS.pendingRefillReadIntervalMs).toBeGreaterThanOrEqual(LIMITS.freshRefillWindowMs);
    expect(LIMITS.pendingPaymentReadIntervalMs).toBeGreaterThanOrEqual(LIMITS.pendingRefillReadIntervalMs);
    expect((LIMITS.settlementUnverifiableReads - 1) * LIMITS.closedWindowReadSpacingMs).toBeGreaterThanOrEqual(50 * 60_000);
  });
});
