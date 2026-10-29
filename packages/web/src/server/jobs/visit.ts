import { LIMITS } from '@ellai/core/limits';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, eq, exists, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
// The file next/server names: the strict Node module rules this package uses cannot find Next's extensionless entry points.
import { after } from 'next/server.js';
import type { Database } from '../db/client.js';
import { memories, owners, refills } from '../db/schema.js';
import { withServerContext } from '../http/context.js';
import { withTatumScope } from '../http/tatum-meter.js';
import { type JobsTickArgs, type JobsTickSummary, emptySummary, errorCode, hasVisitWork, oneEpochReading, recordingStep, visitOwner } from './tick.js';

/** The owner's own request a visit follows. */
export type VisitTrigger = 'answer' | 'onboarding' | 'overview' | 'agent';

export interface OwnerVisitResult {
  /** True when at least one pass ran. */
  started: boolean;
  passes: number;
  summary: JobsTickSummary;
}

/**
 * Takes the owner's visit lease when no visit holds it, or when the one that did has run past its
 * time (LIMITS.ownerVisitLeaseMs, the longest a route can run, so its holder is gone), in one
 * statement, so of two visits asking at once exactly one gets it (C40). Returns the time the
 * lease now ends, which releaseVisitLease needs, or null when another visit holds it or the owner
 * is gone. Throws only for a database failure.
 */
export async function acquireVisitLease(db: Database, ownerId: string, now: Date): Promise<Date | null> {
  const [taken] = await db
    .update(owners)
    .set({ visitLeaseUntil: new Date(now.getTime() + LIMITS.ownerVisitLeaseMs) })
    .where(and(eq(owners.id, ownerId), or(isNull(owners.visitLeaseUntil), lte(owners.visitLeaseUntil, now))))
    .returning({ until: owners.visitLeaseUntil });
  return taken?.until ?? null;
}

/**
 * Frees the lease acquireVisitLease returned `until` for, and only that one: a visit that ran
 * past its own lease never frees the lease another visit took after it. Throws only for a
 * database failure.
 */
export async function releaseVisitLease(db: Database, ownerId: string, until: Date): Promise<void> {
  await db
    .update(owners)
    .set({ visitLeaseUntil: null })
    .where(and(eq(owners.id, ownerId), eq(owners.visitLeaseUntil, until)));
}

/** A relayer write still to be confirmed (only for an owner with a Walrus Memory account, the only kind a pass can send) or a refill still pending. */
async function stillWaiting(db: Database, ownerId: string): Promise<boolean> {
  const memory = db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), eq(memories.status, 'pending')));
  const refill = db
    .select({ id: refills.id })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'pending')));
  const [row] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(and(eq(owners.id, ownerId), or(and(isNotNull(owners.memwalAccountId), exists(memory)), exists(refill))));
  return row !== undefined;
}

/** A pending memory no pass holds, of an owner with a Walrus Memory account: never sent, and never handed to the relayer, or handed to it longer ago than submitPendingMemories's own lease. */
async function unsentMemory(db: Database, ownerId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .innerJoin(owners, eq(owners.id, memories.ownerId))
    .where(
      and(
        eq(memories.ownerId, ownerId),
        // As stillWaiting asks: only an owner with a Walrus Memory account has memories a pass can send.
        isNotNull(owners.memwalAccountId),
        eq(memories.status, 'pending'),
        isNull(memories.jobId),
        or(isNull(memories.submittedAt), lte(memories.submittedAt, new Date(now.getTime() - LIMITS.memoryWriteLeaseMs))),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function visitedSince(db: Database, ownerId: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(and(eq(owners.id, ownerId), gt(owners.lastTickedAt, since)));
  return row !== undefined;
}

/**
 * The background work one owner's own request starts, for that owner alone (C40): the work the
 * jobs tick does for this owner, in the same order and under the same rules (visitOwner),
 * repeated while a relayer write or a refill is still to finish, so an owner's yes becomes a
 * confirmed memory within about a minute instead of waiting for the scheduled tick.
 *
 * Not started (started false, nothing written) when the owner has no work the tick would visit it
 * for (hasVisitWork), and for 'overview' also when the owner's last visit, by the tick or by a
 * request, is newer than LIMITS.ownerVisitMinGapMs, since screens load the overview after every
 * action. Then, while `now` is before `deadlineMs` and fewer than LIMITS.ownerVisitMaxPasses passes
 * have run, it takes the owner's lease (acquireVisitLease; null, another visit holds the owner,
 * ends the visit) and makes passes under it: each stamps last_ticked_at and runs visitOwner once.
 * The passes stop when a pass recorded an error, when nothing is waiting (no pending memory for
 * an owner with a Walrus Memory account and no pending refill), at the pass ceiling, or at the
 * deadline; otherwise it sleeps LIMITS.ownerVisitPassGapMs and passes again, asking the deadline
 * once more after the sleep, so no pass starts at or past `deadlineMs` (C21). The lease is
 * released however the passes end. A memory a request recorded while this visit held the lease
 * found the lease taken, so its own visit did nothing: once released, a pending memory no pass
 * holds (no job id, and submitted_at null or at least LIMITS.memoryWriteLeaseMs old), of an owner
 * with a Walrus Memory account, takes the lease again and continues the passes, inside the same
 * ceilings. Passes that ended on a pass's recorded error never take the lease again, since the
 * failure would only repeat at once: the scheduled tick or the owner's next request retries it.
 *
 * Every pass shares one epoch reading (oneEpochReading). Each Tatum request is charged as the
 * tick's are: to this owner's jobs share, and the refill step's to the refills pool (C22, C28).
 * A failed step, a failed lease read or release ('lease') and a failed read of what is still
 * waiting ('waiting') are recorded with a fixed code (C19). Never throws for a step's failure;
 * throws only when the first check for work cannot be read, or when `sleep` throws, after
 * releasing the lease.
 */
export async function runOwnerVisit(args: JobsTickArgs & { ownerId: string; trigger: VisitTrigger; deadlineMs: number }): Promise<OwnerVisitResult> {
  const { db, chain, masterSecretHex, gasKeypair, now, sleep, ownerId, trigger, deadlineMs } = args;
  const summary = emptySummary(null);
  const step = recordingStep(summary);
  const result: OwnerVisitResult = { started: false, passes: 0, summary };
  const canStart = () => now().getTime() < deadlineMs;

  const gateAt = now();
  if (trigger === 'overview' && (await visitedSince(db, ownerId, new Date(gateAt.getTime() - LIMITS.ownerVisitMinGapMs)))) return result;
  if (!(await hasVisitWork(db, ownerId, gateAt))) return result;

  const visit = { db, chain, masterSecretHex, gasKeypair, now, sleep, ownerId, canStart, readEpoch: oneEpochReading(chain), summary, step };
  const recorded = (name: string) => (error: unknown) => {
    summary.errors.push({ ownerId, step: name, code: errorCode(error) });
    return null;
  };

  // True when the passes ended because a pass recorded an error.
  const passes = async (): Promise<boolean> => {
    for (let first = true; ; first = false) {
      if (!first) await sleep(LIMITS.ownerVisitPassGapMs);
      if (!canStart() || result.passes >= LIMITS.ownerVisitMaxPasses) return false;
      const errorsBefore = summary.errors.length;
      await step(ownerId, 'visited', async () => {
        await db.update(owners).set({ lastTickedAt: now() }).where(eq(owners.id, ownerId));
      });
      await visitOwner(visit);
      result.passes += 1;
      result.started = true;
      summary.owners = 1;
      if (summary.errors.length > errorsBefore) return true;
      if ((await stillWaiting(db, ownerId).catch(recorded('waiting'))) !== true) return false;
      if (result.passes >= LIMITS.ownerVisitMaxPasses || !canStart()) return false;
    }
  };

  while (canStart() && result.passes < LIMITS.ownerVisitMaxPasses) {
    const until = await acquireVisitLease(db, ownerId, now()).catch(recorded('lease'));
    if (until === null) break;
    let failedPass = false;
    try {
      failedPass = await passes();
    } finally {
      // A lease left behind ends by itself at `until`, so a failed release is only recorded.
      await step(ownerId, 'lease', () => releaseVisitLease(db, ownerId, until));
    }
    // Taking the lease again at once would only meet the same failure; the tick or the next request retries.
    if (failedPass) break;
    if ((await unsentMemory(db, ownerId, now()).catch(recorded('waiting'))) !== true) break;
  }
  summary.timeBudgetReached = !canStart();
  return result;
}

/** Runs a task once the response has been sent, inside the request's time limit. */
export type VisitScheduler = (task: () => Promise<void>) => void;

let scheduler: VisitScheduler | null = null;

/** Replaces how a visit's task is handed on, so a test can collect it and run it itself. Null restores Next's `after`. */
export function setVisitScheduler(next: VisitScheduler | null): void {
  scheduler = next;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A visit may start no unit that could still be running at the route's limit: the slowest unit
// the tick may start just before its deadline is held to tickEndByMs - tickTimeBudgetMs
// (jobs.test.ts works it out), so that much is kept clear of the limit (C21).
function visitDeadline(taskStartMs: number, requestStartedMs: number): number {
  return Math.min(taskStartMs + LIMITS.tickTimeBudgetMs, requestStartedMs + LIMITS.slowRouteMaxDurationS * 1_000 - (LIMITS.tickEndByMs - LIMITS.tickTimeBudgetMs));
}

// Counts and fixed codes only: never an id, an address, a message or a value (C19).
function logVisit(trigger: VisitTrigger, result: OwnerVisitResult | null, codes: string[]): void {
  const { summary } = result ?? { summary: emptySummary(null) };
  const unique = [...new Set(codes)];
  const line =
    `[ellai visit] trigger=${trigger} started=${result?.started ?? false} passes=${result?.passes ?? 0} ` +
    `submitted=${summary.memoriesSubmitted} confirmed=${summary.memoriesConfirmed} refills=${summary.refills} codes=${unique.length === 0 ? 'none' : unique.join(',')}`;
  if (unique.length === 0) console.log(line);
  else console.error(line);
}

/**
 * Hands one visit for this owner to the visit scheduler (Next's `after` by default), to run once
 * the route has answered (C40). The task opens a context of its own (withServerContext: a fresh
 * database handle and Tatum meter, never the request's, whose pool is closed by then), runs in the
 * jobs scope as the jobs route does, and calls runOwnerVisit with the jobs route's arguments and a
 * deadline of the visit's time budget (LIMITS.tickTimeBudgetMs) from when the task starts, cut
 * short so the slowest unit it may start still ends inside the route's own limit, counted from
 * `requestStartedMs` (C21). The task never throws: it writes exactly one console line,
 * `[ellai visit] trigger=... started=... passes=... submitted=... confirmed=... refills=... codes=...`,
 * with counts and fixed codes only (C19). A scheduler that refuses the task is logged as a fixed
 * code and never reaches the route's answer.
 */
export function scheduleOwnerVisit(ownerId: string, trigger: VisitTrigger, requestStartedMs: number): void {
  const task = async (): Promise<void> => {
    try {
      const result = await withServerContext((ctx) =>
        // As the jobs route runs its tick, so nothing a visit does is charged to the caller whose request started it (C22, C28).
        withTatumScope({ kind: 'jobs' }, () =>
          runOwnerVisit({
            db: ctx.db,
            chain: ctx.chain,
            masterSecretHex: ctx.env.ELLAI_MASTER_SECRET,
            gasKeypair: Ed25519Keypair.fromSecretKey(ctx.env.GAS_PRIVATE_KEY),
            now: ctx.now,
            sleep: realSleep,
            ownerId,
            trigger,
            deadlineMs: visitDeadline(ctx.now().getTime(), requestStartedMs),
          }),
        ),
      );
      logVisit(trigger, result, result.summary.errors.map((error) => error.code));
    } catch (error) {
      logVisit(trigger, null, [errorCode(error)]);
    }
  };
  try {
    (scheduler ?? after)(task);
  } catch {
    console.error(`[ellai visit] trigger=${trigger} schedule_failed`);
  }
}
