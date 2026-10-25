import { AllowanceError } from '@ellai/core/allowance';
import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, asc, eq, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { LIVE_DECISION_STATUSES, decisions, memories, owners, payments } from '../db/schema.js';
import { MemoryServiceError, ownerDelegate } from '../memory/delegate.js';
import { recordOutcome } from '../memory/outcome.js';
import { confirmMemoryJobs, submitPendingMemories } from '../memory/writer.js';
import { settlePayment } from '../pay/settle.js';
import { expireDecisions } from './expire.js';
import { RefillError, refillIfNeeded } from './refill.js';

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
  paymentsVerified: number;
  paymentsNotLanded: number;
  paymentsMismatched: number;
  outcomesRecorded: number;
  decisionsExpired: number;
  questionsClosed: number;
  refills: number;
  gasWalletLow: boolean;
  errors: JobsTickError[];
}

// The most payments one owner can sign in a day at the largest budget onboarding allows, so a
// full day's backlog fits in one pass and an owner's pending payments, or its payments still
// owed an outcome, are still a bounded loop.
const PAYMENTS_PER_OWNER = Math.ceil(LIMITS.onboardingDailyLimitMaxAtomic / LIMITS.minPaymentAtomic);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

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

/**
 * Owners with work, oldest work first: pending memories (only for an owner with a Walrus Memory
 * account, the only kind the memory step can send), pending payments, payments owed an outcome
 * memory, open or asked decisions, and an allowance, dated by when it was checked or, before
 * that, when the owner joined.
 */
async function ownersWithWork(db: Database): Promise<string[]> {
  const memoryWork = db
    .select({ ownerId: memories.ownerId, at: sql<Date>`min(${memories.createdAt})`.as('at') })
    .from(memories)
    .innerJoin(owners, eq(owners.id, memories.ownerId))
    .where(and(eq(memories.status, 'pending'), isNotNull(owners.memwalAccountId)))
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
  const decisionWork = db
    .select({ ownerId: decisions.ownerId, at: sql<Date>`min(${decisions.createdAt})`.as('at') })
    .from(decisions)
    .where(inArray(decisions.status, LIVE_DECISION_STATUSES))
    .groupBy(decisions.ownerId);
  const allowanceWork = db
    .select({ ownerId: owners.id, at: sql<Date>`coalesce(${owners.allowanceCheckedAt}, ${owners.createdAt})`.as('at') })
    .from(owners)
    .where(isNotNull(owners.allowanceId));
  const work = unionAll(memoryWork, paymentWork, outcomeWork, decisionWork, allowanceWork).as('work');
  const rows = await db
    .select({ ownerId: work.ownerId })
    .from(work)
    .groupBy(work.ownerId)
    .orderBy(sql`min(${work.at})`, work.ownerId)
    .limit(LIMITS.jobsOwnersPerTick);
  return rows.map((row) => row.ownerId);
}

/**
 * One pass of Ellai's background work, bounded and safe to repeat. Handles at most
 * LIMITS.jobsOwnersPerTick owners with work, oldest work first. For each owner, in order:
 * 1. memory (only with a Walrus Memory account): submitPendingMemories, then confirmMemoryJobs;
 * 2. payments: every payment still 'pending', oldest first, is read once by settlePayment
 *    (tries 1; later ticks are the patience), which checks it against Ellai's own digest (C8);
 * 3. outcomes: every 'verified' payment stored as delivered false (never null) whose decision has
 *    no outcome memory yet, oldest first, becomes a delivered=false outcome memory through
 *    recordOutcome, idempotent per decision. That takes in a payment step 2 has just verified
 *    and one whose outcome the paid call itself failed to record;
 * 4. expireDecisions: stale open decisions and unanswered questions past their time;
 * 5. refillIfNeeded (only with an allowance), waiting with this tick's `sleep`: C7 and C23 at
 *    refill time.
 * Then the gas wallet's SUI is read once; below LIMITS.gasWalletLowMist, or unreadable, sets
 * gasWalletLow.
 * Every owner and every step is wrapped: a failure is recorded with the owner, the step and a
 * fixed code from errorCode, and the tick moves on. Never throws for a step's failure; throws
 * only when the owner list itself cannot be read.
 */
export async function runJobsTick(args: JobsTickArgs): Promise<JobsTickSummary> {
  const { db, chain, masterSecretHex, gasKeypair, now, sleep } = args;
  const summary: JobsTickSummary = {
    owners: 0,
    memoriesSubmitted: 0,
    memoriesConfirmed: 0,
    memoriesFailed: 0,
    paymentsVerified: 0,
    paymentsNotLanded: 0,
    paymentsMismatched: 0,
    outcomesRecorded: 0,
    decisionsExpired: 0,
    questionsClosed: 0,
    refills: 0,
    gasWalletLow: true,
    errors: [],
  };
  const step = async (ownerId: string, name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      summary.errors.push({ ownerId, step: name, code: errorCode(error) });
    }
  };

  for (const ownerId of await ownersWithWork(db)) {
    summary.owners += 1;
    await step(ownerId, 'owner', async () => {
      const [owner] = await db
        .select({ suiAddress: owners.suiAddress, memwalAccountId: owners.memwalAccountId, allowanceId: owners.allowanceId })
        .from(owners)
        .where(eq(owners.id, ownerId));
      if (owner === undefined) return;

      if (owner.memwalAccountId !== null) {
        await step(ownerId, 'memory_submit', async () => {
          summary.memoriesSubmitted += (await submitPendingMemories({ db, ownerId, masterSecretHex, now: now() })).submitted;
        });
        await step(ownerId, 'memory_confirm', async () => {
          const confirmed = await confirmMemoryJobs({ db, ownerId, masterSecretHex, now: now() });
          summary.memoriesConfirmed += confirmed.confirmed;
          summary.memoriesFailed += confirmed.failed;
        });
      }

      await step(ownerId, 'payments', async () => {
        const pending = await db
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.ownerId, ownerId), eq(payments.settlement, 'pending')))
          .orderBy(asc(payments.signedAt), asc(payments.id))
          .limit(PAYMENTS_PER_OWNER);
        for (const payment of pending) {
          await step(ownerId, 'payment', async () => {
            const settled = await settlePayment({ db, ownerId, paymentId: payment.id, chain, tries: 1, intervalMs: LIMITS.settlementPollIntervalMs, sleep });
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

      await step(ownerId, 'expire', async () => {
        const expired = await expireDecisions({ db, ownerId, now: now() });
        summary.decisionsExpired += expired.decisionsExpired;
        summary.questionsClosed += expired.questionsClosed;
      });

      if (owner.allowanceId !== null) {
        await step(ownerId, 'refill', async () => {
          if ((await refillIfNeeded({ db, chain, ownerId, masterSecretHex, gasKeypair, now: now(), sleep })) === 'refilled') summary.refills += 1;
        });
      }
    });
  }

  try {
    const { suiTotal } = await chain.getBalances(gasKeypair.toSuiAddress());
    summary.gasWalletLow = suiTotal < BigInt(LIMITS.gasWalletLowMist);
  } catch (error) {
    // Left true: a gas wallet that cannot be read is treated as one that needs looking at.
    summary.errors.push({ ownerId: '', step: 'gas_wallet', code: errorCode(error) });
  }
  return summary;
}
