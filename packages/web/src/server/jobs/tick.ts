import { AllowanceError } from '@ellai/core/allowance';
import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, asc, eq, isNotNull, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { memories, owners, payments, refills } from '../db/schema.js';
import { consumeShared } from '../http/ratelimit.js';
import { withTatumScope } from '../http/tatum-meter.js';
import { MemoryServiceError, ownerDelegate } from '../memory/delegate.js';
import { recordOutcome } from '../memory/outcome.js';
import { confirmMemoryJobs, failAgedMemories, isKeyRefused, submitPendingMemories } from '../memory/writer.js';
import { settlePayment } from '../pay/settle.js';
import { awaitingChainCheck, chainExpiring, confirmBlobsOnChain, expireBlobsOnChain, lackingEndEpoch, walrusEpochForExpiry } from './blobs.js';
import { expireDecisions } from './expire.js';
import { pruneExpiredRows } from './prune.js';
import { RefillError, refillIfNeeded, resolvePendingRefill } from './refill.js';
import { acquireVisitLease, releaseVisitLease } from './visit.js';

export interface JobsTickArgs {
  db: Database;
  chain: Chain;
  masterSecretHex: string;
  /** The gas wallet: it sponsors refills, and its SUI is what the low-gas warning reads. */
  gasKeypair: Ed25519Keypair;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface JobsTickError {
  /** The owner whose step failed, or '' for the gas wallet read. */
  ownerId: string;
  step: string;
  /** A fixed upper-case code, never an error message or a value (C19). */
  code: string;
}

export interface JobsTickSummary {
  owners: number;
  memoriesSubmitted: number;
  memoriesConfirmed: number;
  memoriesFailed: number;
  /** Confirmed memories whose blob this tick found among the owner's Walrus Blob objects. */
  memoriesChainConfirmed: number;
  /** Memories found on chain whose Blob this tick saw Walrus stop storing, so /proof no longer shows them. */
  memoriesChainExpired: number;
  paymentsVerified: number;
  paymentsNotLanded: number;
  paymentsMismatched: number;
  outcomesRecorded: number;
  decisionsExpired: number;
  questionsClosed: number;
  refills: number;
  /** Old rate counters, dead sign-in nonces and step-ups, seller sales, sessions, closed decisions and empty owners deleted by this tick. */
  rowsPruned: number;
  /** Null when an earlier tick already took this window's one gas wallet read (LIMITS.gasWalletCheckIntervalMs). */
  gasWalletLow: boolean | null;
  /** True when the tick's deadline (LIMITS.tickTimeBudgetMs) had passed by its end, so some owner or step may not have started. */
  timeBudgetReached: boolean;
  errors: JobsTickError[];
}

/** Runs one named step for an owner ('' for none), recording a failure in the summary with a fixed code instead of throwing. */
export type JobsStep = (ownerId: string, name: string, run: () => Promise<void>) => Promise<void>;

/** What one visit to one owner works with: the tick's own arguments, and the deadline, epoch reading, summary and step of the run it is part of. */
export interface OwnerVisitArgs extends JobsTickArgs {
  ownerId: string;
  /** False once the run's deadline has passed: no step starts a new external call after that. */
  canStart: () => boolean;
  /** The one epoch reading every settlement pass of the run shares (oneEpochReading). */
  readEpoch: () => Promise<bigint>;
  summary: JobsTickSummary;
  step: JobsStep;
}

// The most payments one owner can sign in a day at the largest budget onboarding allows, so a
// full day's backlog fits in one pass and an owner's pending payments, or its payments still
// owed an outcome, are still a bounded loop.
const PAYMENTS_PER_OWNER = Math.ceil(LIMITS.onboardingDailyLimitMaxAtomic / LIMITS.minPaymentAtomic);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
// A shared counter, not a timestamp in memory, so every server instance running ticks shares the one read.
const GAS_WALLET_CHECK = 'gas-wallet-check';

/**
 * A verified payment stored as delivering nothing whose decision has no outcome memory yet. A
 * null delivered, which means the seller's answer could not be stored, never matches.
 */
function owedOutcome(db: Database) {
  const outcome = db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.ownerId, payments.ownerId), eq(memories.decisionId, payments.decisionId), eq(memories.kind, 'outcome')));
  return and(eq(payments.settlement, 'verified'), eq(payments.delivered, false), notExists(outcome));
}

/**
 * An owner whose refill_not_before is still ahead (a full rate window, a failed dry run, or a
 * purse read at or above the threshold) asks the chain nothing about a refill until then (C22).
 */
function refillMayStart(now: Date) {
  return or(isNull(owners.refillNotBefore), lte(owners.refillNotBefore, now));
}

/**
 * One reading of the chain's epoch for a whole tick, taken the first time a settlement pass asks,
 * so a backlog of payments past their window costs one epoch read rather than one each (C22). A
 * failed reading is kept as well, and those passes leave their payments pending for the next tick.
 * It is charged to the jobs day with no owner, since every owner's pass shares it: charged to the
 * owner whose pass asked first, that owner's spent share would fail it for everyone (C28).
 */
export function oneEpochReading(chain: Chain): () => Promise<bigint> {
  let reading: Promise<bigint> | null = null;
  return () => {
    reading ??= withTatumScope({ kind: 'jobs' }, () => chain.getCurrentEpoch());
    return reading;
  };
}

/**
 * The fixed code for a failure: the kind of error and its own code, both from closed sets in
 * Ellai's error classes. Anything else, or a code that is not plain upper-case text, is
 * UNEXPECTED, so no message, value or upstream text can reach the summary (C19).
 */
export function errorCode(error: unknown): string {
  let code: string;
  if (error instanceof ChainError) code = `CHAIN_${error.code}`;
  else if (error instanceof AllowanceError) code = `ALLOWANCE_${error.code}`;
  else if (error instanceof RefillError) code = `REFILL_${error.code}`;
  else if (error instanceof MemoryError) code = `MEMORY_${error.code}`;
  else if (error instanceof MemoryServiceError) code = `MEMORY_SERVICE_${error.code}`;
  else return 'UNEXPECTED';
  return CODE.test(code) ? code : 'UNEXPECTED';
}

/** A summary with every count at zero and no errors. */
export function emptySummary(gasWalletLow: boolean | null): JobsTickSummary {
  return {
    owners: 0,
    memoriesSubmitted: 0,
    memoriesConfirmed: 0,
    memoriesFailed: 0,
    memoriesChainConfirmed: 0,
    memoriesChainExpired: 0,
    paymentsVerified: 0,
    paymentsNotLanded: 0,
    paymentsMismatched: 0,
    outcomesRecorded: 0,
    decisionsExpired: 0,
    questionsClosed: 0,
    refills: 0,
    rowsPruned: 0,
    gasWalletLow,
    timeBudgetReached: false,
    errors: [],
  };
}

/** The step every jobs run uses: a failure becomes one entry in summary.errors, with the owner, the step and errorCode's fixed code (C19). */
export function recordingStep(summary: JobsTickSummary): JobsStep {
  return async (ownerId, name, run) => {
    try {
      await run();
    } catch (error) {
      summary.errors.push({ ownerId, step: name, code: errorCode(error) });
    }
  };
}

/**
 * Owners with work, least recently visited first: never visited before any visited, then the
 * oldest visit, and among equals the oldest work. Work is only what needs the chain or the relayer
 * for this owner: pending memories (only for an owner with a Walrus Memory account, the only kind
 * the memory step can send), confirmed memories not yet found on chain that confirmBlobsOnChain
 * would check at `now` (awaitingChainCheck), memories found on chain before blob_end_epoch was
 * kept, which its scan fills in (lackingEndEpoch), pending payments, payments owed an outcome
 * memory (the memory the relayer is then sent), an allowance whose refill_not_before is unset or
 * past (refillMayStart), dated by when it was checked or, before that, when the owner joined,
 * a refill still pending, with or without an allowance recorded, but never one that ended
 * 'mismatch' (C38), and, when the tick holds a Walrus epoch reading, memories found on chain whose Blob that epoch
 * has reached (chainExpiring). Open and asked decisions are not work: expireDecisions closes them
 * for every owner in one statement, so free sign-ins with a question each cannot push a paying
 * owner's turn back (C28). Ordering by the visit and not by the work is what lets every owner take
 * a turn: an owner with an allowance always has work, so ordering by work alone served the same
 * LIMITS.jobsOwnersPerTick owners every tick (C21). Given `onlyOwnerId`, the same question is asked
 * of that one owner.
 */
async function ownersWithWork(db: Database, now: Date, walrusEpoch: number | null, onlyOwnerId?: string): Promise<string[]> {
  const memoryWork = db
    .select({ ownerId: memories.ownerId, at: sql<Date>`min(${memories.createdAt})`.as('at') })
    .from(memories)
    .innerJoin(owners, eq(owners.id, memories.ownerId))
    .where(and(eq(memories.status, 'pending'), isNotNull(owners.memwalAccountId)))
    .groupBy(memories.ownerId);
  const blobWork = db
    .select({ ownerId: memories.ownerId, at: sql<Date>`min(coalesce(${memories.confirmedAt}, ${memories.createdAt}))`.as('at') })
    .from(memories)
    .where(awaitingChainCheck(now))
    .groupBy(memories.ownerId);
  const backfillWork = db
    .select({ ownerId: memories.ownerId, at: sql<Date>`min(${memories.chainConfirmedAt})`.as('at') })
    .from(memories)
    .where(lackingEndEpoch)
    .groupBy(memories.ownerId);
  const paymentWork = db
    .select({ ownerId: payments.ownerId, at: sql<Date>`min(${payments.signedAt})`.as('at') })
    .from(payments)
    .where(eq(payments.settlement, 'pending'))
    .groupBy(payments.ownerId);
  const outcomeWork = db
    .select({ ownerId: payments.ownerId, at: sql<Date>`min(${payments.signedAt})`.as('at') })
    .from(payments)
    .where(owedOutcome(db))
    .groupBy(payments.ownerId);
  const allowanceWork = db
    .select({ ownerId: owners.id, at: sql<Date>`coalesce(${owners.allowanceCheckedAt}, ${owners.createdAt})`.as('at') })
    .from(owners)
    .where(and(isNotNull(owners.allowanceId), refillMayStart(now)));
  // A 'mismatch' refill is final and is never read again, so it is no work (C38).
  const refillWork = db
    .select({ ownerId: refills.ownerId, at: sql<Date>`min(${refills.sentAt})`.as('at') })
    .from(refills)
    .where(eq(refills.status, 'pending'))
    .groupBy(refills.ownerId);
  const expiryWork =
    walrusEpoch === null
      ? []
      : [
          db
            .select({ ownerId: memories.ownerId, at: sql<Date>`min(${memories.chainConfirmedAt})`.as('at') })
            .from(memories)
            .where(chainExpiring(walrusEpoch))
            .groupBy(memories.ownerId),
        ];
  const work = unionAll(memoryWork, blobWork, backfillWork, paymentWork, outcomeWork, allowanceWork, refillWork, ...expiryWork).as('work');
  const rows = await db
    .select({ ownerId: owners.id })
    .from(work)
    .innerJoin(owners, eq(owners.id, work.ownerId))
    .where(onlyOwnerId === undefined ? undefined : eq(owners.id, onlyOwnerId))
    .groupBy(owners.id)
    .orderBy(sql`${owners.lastTickedAt} asc nulls first`, sql`min(${work.at})`, owners.id)
    .limit(LIMITS.jobsOwnersPerTick);
  return rows.map((row) => row.ownerId);
}

/**
 * Whether this owner has work the jobs tick would visit it for at `now`, by the tick's own
 * question (ownersWithWork). Memories whose Blob Walrus may have stopped storing are left out,
 * since telling them needs the tick's Walrus epoch reading. Reads only the database.
 */
export async function hasVisitWork(db: Database, ownerId: string, now: Date): Promise<boolean> {
  return (await ownersWithWork(db, now, null, ownerId)).length > 0;
}

/**
 * One visit's work for one owner: the payments, outcomes, refill and memory steps, in the order
 * and with the rules runJobsTick lists, each handed `canStart` and recorded through `step`, with
 * counts added to `summary`. Every Tatum request of the visit is charged to this owner's jobs
 * share, except the refill step's, which runs in the refills scope (C22, C28). Neither stamps
 * last_ticked_at nor takes the owner's lease; its caller does both. Never throws for a step's
 * failure.
 */
export async function visitOwner(v: OwnerVisitArgs): Promise<void> {
  const { db, chain, masterSecretHex, gasKeypair, now, sleep, ownerId, canStart, readEpoch, summary, step } = v;
  // Every Tatum request of the visit, its steps' own included, is charged to this owner's jobs share; the refill step enters a scope of its own (C22, C28).
  await withTatumScope({ kind: 'jobs', ownerId }, () =>
    step(ownerId, 'owner', async () => {
      const [owner] = await db
        .select({ suiAddress: owners.suiAddress, memwalAccountId: owners.memwalAccountId, allowanceId: owners.allowanceId, refillNotBefore: owners.refillNotBefore })
        .from(owners)
        .where(eq(owners.id, ownerId));
      if (owner === undefined) return;

      await step(ownerId, 'payments', async () => {
        const pending = await db
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.ownerId, ownerId), eq(payments.settlement, 'pending')))
          .orderBy(asc(payments.signedAt), asc(payments.id))
          .limit(PAYMENTS_PER_OWNER);
        for (const payment of pending) {
          // Each settlement pass is a unit of its own, so the deadline is asked between them.
          if (!canStart()) break;
          await step(ownerId, 'payment', async () => {
            const settled = await settlePayment({ db, ownerId, paymentId: payment.id, chain, tries: 1, intervalMs: LIMITS.settlementPollIntervalMs, sleep, now, readEpoch, paced: true });
            if (settled === 'verified') summary.paymentsVerified += 1;
            else if (settled === 'not_landed') summary.paymentsNotLanded += 1;
            else if (settled === 'mismatch') summary.paymentsMismatched += 1;
          });
        }
      });

      await step(ownerId, 'outcomes', async () => {
        const owed = await db
          .select({ decisionId: payments.decisionId })
          .from(payments)
          .where(and(eq(payments.ownerId, ownerId), owedOutcome(db)))
          .orderBy(asc(payments.signedAt), asc(payments.id))
          .limit(PAYMENTS_PER_OWNER);
        if (owed.length === 0) return;
        const { publicKeyHex } = ownerDelegate(masterSecretHex, owner.suiAddress);
        for (const payment of owed) {
          await step(ownerId, 'outcome', async () => {
            await recordOutcome({ db, ownerId, decisionId: payment.decisionId, delivered: false, delegatePublicKeyHex: publicKeyHex, now: now() });
            summary.outcomesRecorded += 1;
          });
        }
      });

      if (owner.allowanceId !== null && (owner.refillNotBefore === null || owner.refillNotBefore.getTime() <= now().getTime())) {
        await step(ownerId, 'refill', async () => {
          // A pool of its own, so this owner's payments, or every owner's, spending the jobs day cannot stop the refill (C23, C28).
          const outcome = await withTatumScope({ kind: 'refills' }, () =>
            // The tick's own clock, so the day's refill count and sent_at are read under the lock, after the reads before them (C26).
            refillIfNeeded({ db, chain, ownerId, masterSecretHex, gasKeypair, now: now(), clock: now, canStart }),
          );
          if (outcome === 'refilled') summary.refills += 1;
        });
      } else {
        // A refill sent before the allowance was forgotten, or waited out, still holds money the ledger cannot count until it is final (C38).
        await step(ownerId, 'refill', async () => {
          await withTatumScope({ kind: 'refills' }, () => resolvePendingRefill({ db, chain, ownerId, gasKeypair, clock: now, canStart }));
        });
      }

      if (owner.memwalAccountId !== null) {
        let keyRefused = false;
        await step(ownerId, 'memory_submit', async () => {
          try {
            summary.memoriesSubmitted += (await submitPendingMemories({ db, ownerId, masterSecretHex, now: now(), canStart })).submitted;
          } catch (error) {
            keyRefused = isKeyRefused(error);
            throw error;
          }
        });
        // The relayer would refuse the same key again, so the confirm step would only record the code twice.
        if (!keyRefused) {
          await step(ownerId, 'memory_confirm', async () => {
            const confirmed = await confirmMemoryJobs({ db, ownerId, masterSecretHex, now: now(), canStart });
            summary.memoriesConfirmed += confirmed.confirmed;
            summary.memoriesFailed += confirmed.failed;
          });
        }
      }
      await step(ownerId, 'blobs', async () => {
        summary.memoriesChainConfirmed += (await confirmBlobsOnChain({ db, chain, ownerId, now: now(), canStart })).confirmed;
      });
      await step(ownerId, 'blob_expiry', async () => {
        summary.memoriesChainExpired += (await expireBlobsOnChain({ db, chain, ownerId, now: now(), canStart })).expired;
      });
    }),
  );
}

/**
 * One pass of Ellai's background work, bounded and safe to repeat. Its deadline is
 * LIMITS.tickTimeBudgetMs after it begins, on `now`: past it no owner is started and no step
 * starts a new external call, so the longest unit begun just before it (the gas wallet's balance
 * pages; jobs.test.ts works out every unit from LIMITS) still ends inside LIMITS.tickEndByMs, under
 * the route's limit (C21, C28). Database work goes on.
 * First pruneExpiredRows deletes dead rows, old rate counters first, in batches of
 * LIMITS.pruneBatch for at most LIMITS.pruneTimeSliceMs on this tick's clock, before any owner's
 * work (C22, C34). Then expireDecisions closes stale open decisions and unanswered questions past
 * their time for every owner in one bounded statement, and failAgedMemories fails every owner's
 * pending memory past its age, whatever the owner's account or key, counted in memoriesFailed;
 * both run whatever the deadline, since they read nothing outside the database (C28, C33). Then,
 * before the deadline, the gas
 * wallet's SUI is read, but only by the first tick in each fixed LIMITS.gasWalletCheckIntervalMs
 * window, counted through consumeShared so every instance shares it (C21, C22): below
 * LIMITS.gasWalletLowMist, unreadable or not read sets gasWalletLow, a later tick in the same
 * window leaves it null. Then, before the deadline, the Walrus epoch is read through the hourly
 * reading the blob steps share, only when some memory is stored on chain (walrusEpochForExpiry);
 * a failed reading is recorded as the step 'walrus_epoch' and no expiry work is found this tick.
 * Then it handles at most LIMITS.jobsOwnersPerTick owners with work, least recently
 * visited first (ownersWithWork). Each visit first takes the owner's visit lease
 * (acquireVisitLease); an owner whose lease another visit holds, one the owner's own request
 * started, is skipped, neither counted nor stamped, and a lease that cannot be read is recorded as
 * the step 'lease' and the owner skipped (C40). The lease is released when the visit ends,
 * however it ends. Each owner's last_ticked_at is set to `now` as its visit
 * starts, so an owner whose visit fails or is cut off goes to the back of the line like any
 * other. The visit runs in the Tatum scope { kind: 'jobs', ownerId }, so every request it makes is
 * charged to that owner's jobs share before the shared jobs day (C22, C28), except the refill
 * step's, which runs in { kind: 'refills' } and is charged to LIMITS.tatumCallsRefillsPerDay alone,
 * so payments spending the jobs day and every owner's share leave refills able to run (C23, C28).
 * Then, in order, each
 * step handed the deadline as `canStart`, the money steps first, so a slow relayer or a hung SEAL
 * read in the memory steps can never use up the time this owner's payments and refill need (C28):
 * 1. payments: every payment still 'pending', oldest first, until the deadline, is read once by settlePayment
 *    (tries 1; later ticks are the patience), which checks it against Ellai's own digest (C8)
 *    and counts a failed read past the payment's window in payments.settlement_failed_reads;
 *    every pass in the tick, for every owner, shares one epoch reading (oneEpochReading). The
 *    passes are paced: a payment whose window is still open is read at most once per
 *    LIMITS.pendingPaymentReadIntervalMs, by payments.last_read_at, and one whose window has
 *    closed on every visit, so the two-pass release keeps its timing (C22, C4);
 * 2. outcomes: every 'verified' payment stored as delivered false (never null) whose decision has
 *    no outcome memory yet, oldest first, becomes a delivered=false outcome memory through
 *    recordOutcome, idempotent per decision. That takes in a payment step 1 has just verified
 *    and one whose outcome the paid call itself failed to record;
 * 3. refillIfNeeded (only with an allowance, and not before its refill_not_before), reading this
 *    tick's clock after its reads: C7 and C23 at refill time. A lost refill is failed only by a
 *    later tick, so no tick waits on one. Any other owner gets resolvePendingRefill instead, the
 *    same digest and epoch reads in the same refills scope under the same deadline, so a refill
 *    pending when the allowance was forgotten still reaches its final state (C38). A refill that
 *    landed as anything but the refill ends 'mismatch' and pauses the owner, with the step's
 *    error REFILL_MISMATCH once; after that neither job reads it again, and it holds back every
 *    later refill for that owner before any chain read;
 * 4. memory (only with a Walrus Memory account): submitPendingMemories, then confirmMemoryJobs,
 *    which is skipped when the submit ended with core's DELEGATE refusal, so that code is
 *    recorded once per owner per tick; then, for every owner, confirmBlobsOnChain checks
 *    confirmed memories against the owner's Walrus Blob objects on chain, and expireBlobsOnChain
 *    marks those whose Blob Walrus no longer stores, in a step of its own (C18).
 * timeBudgetReached is set when the deadline has passed by the end.
 * Every owner and every step is wrapped: a failure is recorded with the owner, the step and a
 * fixed code from errorCode, and the tick moves on. Never throws for a step's failure; throws
 * only when the owner list itself cannot be read.
 */
export async function runJobsTick(args: JobsTickArgs): Promise<JobsTickSummary> {
  const { db, chain, gasKeypair, now } = args;
  const summary = emptySummary(true);
  const step = recordingStep(summary);
  const startedMs = now().getTime();
  const deadlineMs = startedMs + LIMITS.tickTimeBudgetMs;
  const canStart = () => now().getTime() < deadlineMs;
  const readEpoch = oneEpochReading(chain);

  await step('', 'prune', async () => {
    const pruned = await pruneExpiredRows({ db, now: now(), clock: now });
    summary.rowsPruned += pruned.rateCounters + pruned.signinNonces + pruned.stepUps + pruned.sellerSales + pruned.sessions + pruned.decisions + pruned.owners;
  });

  await step('', 'expire', async () => {
    const expired = await expireDecisions({ db, now: now() });
    summary.decisionsExpired += expired.decisionsExpired;
    summary.questionsClosed += expired.questionsClosed;
  });

  await step('', 'memory_age', async () => {
    summary.memoriesFailed += await failAgedMemories({ db, now: now() });
  });

  if (canStart()) {
    try {
      const turn = await consumeShared(db, GAS_WALLET_CHECK, 1, LIMITS.gasWalletCheckIntervalMs, now());
      if (turn.allowed) {
        const { suiTotal } = await chain.getBalances(gasKeypair.toSuiAddress());
        summary.gasWalletLow = suiTotal < BigInt(LIMITS.gasWalletLowMist);
      } else {
        summary.gasWalletLow = null;
      }
    } catch (error) {
      // Left true: a gas wallet that cannot be read is treated as one that needs looking at.
      summary.errors.push({ ownerId: '', step: 'gas_wallet', code: errorCode(error) });
    }
  }

  // One hourly Walrus epoch reading, and only once some memory is stored on chain, tells which
  // owners have a memory Walrus no longer stores; a failed reading leaves that work for a later tick.
  const walrusEpoch = canStart()
    ? await walrusEpochForExpiry(db, chain, now()).catch((error: unknown) => {
        summary.errors.push({ ownerId: '', step: 'walrus_epoch', code: errorCode(error) });
        return null;
      })
    : null;

  for (const ownerId of await ownersWithWork(db, new Date(startedMs), walrusEpoch)) {
    if (!canStart()) break;
    const until = await acquireVisitLease(db, ownerId, now()).catch((error: unknown) => {
      summary.errors.push({ ownerId, step: 'lease', code: errorCode(error) });
      return null;
    });
    // A visit this owner's own request started is doing this owner's work now (C40).
    if (until === null) continue;
    summary.owners += 1;
    try {
      // Stamped first, so a visit the deadline or the route limit cuts off still sends this owner to the back of the line.
      await step(ownerId, 'visited', async () => {
        await db.update(owners).set({ lastTickedAt: now() }).where(eq(owners.id, ownerId));
      });
      await visitOwner({ ...args, ownerId, canStart, readEpoch, summary, step });
    } finally {
      // A lease left behind ends by itself at `until`, so a failed release is only recorded.
      await step(ownerId, 'lease', () => releaseVisitLease(db, ownerId, until));
    }
  }
  summary.timeBudgetReached = !canStart();
  return summary;
}
