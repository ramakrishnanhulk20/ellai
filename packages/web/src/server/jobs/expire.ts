import { LIMITS } from '@ellai/core/limits';
import { and, asc, eq, exists, inArray, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, owners, payments, questions } from '../db/schema.js';

export interface ExpireArgs {
  db: Database;
  now: Date;
}

/**
 * Closes decisions that can no longer lead anywhere, for every owner at once, so their request
 * keys are free to be decided afresh:
 * - an 'open' decision with no payment row, created more than LIMITS.staleOpenDecisionMs
 *   before `now`, was abandoned between approval and signing and becomes 'expired';
 * - an 'asked' decision whose question is still unanswered and was asked more than
 *   LIMITS.questionTtlMs before `now` becomes 'expired'. answerQuestion refuses a decision
 *   that is not 'asked', so a late answer cannot revive it.
 * This is database work alone, so the jobs tick runs it once per tick for everyone instead of
 * visiting each owner for it, and an owner whose only work is a question costs no visit (C28).
 *
 * One statement, at most LIMITS.pruneBatch decisions, oldest first. Live decisions are found
 * through decisions_live_request_unique, whose predicate the status test repeats. At even one tick
 * an hour that is 24,000 a day, more than the LIMITS.agentFetchesPerDayGlobal decisions agents can
 * open, so a backlog cannot build up. Each decision is taken with its owner row and its own row
 * locked FOR UPDATE SKIP LOCKED: signing, answering and decide take that owner lock first, so a
 * decision being signed or answered right now is left for a later tick, and one this statement
 * expires is seen as 'expired' by them and refused. Locks never wait, so this cannot deadlock with
 * them.
 *
 * Returns how many of each kind were expired: a decision's outcome is 'asked' exactly when it was
 * asked, since decide sets the status from the outcome. Throws for a time that is not a date.
 */
export async function expireDecisions(args: ExpireArgs): Promise<{ decisionsExpired: number; questionsClosed: number }> {
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, now } = args;
  const staleBefore = new Date(now.getTime() - LIMITS.staleOpenDecisionMs);
  const askedBefore = new Date(now.getTime() - LIMITS.questionTtlMs);

  const paymentFor = db
    .select({ one: sql`1` })
    .from(payments)
    .where(and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId)));
  const unansweredQuestion = db
    .select({ one: sql`1` })
    .from(questions)
    .where(
      and(
        eq(questions.decisionId, decisions.id),
        eq(questions.ownerId, decisions.ownerId),
        isNull(questions.answeredAt),
        lt(questions.createdAt, askedBefore),
      ),
    );
  const closable = and(
    sql`${decisions.status} in ('open', 'asked')`,
    or(
      and(eq(decisions.status, 'open'), lt(decisions.createdAt, staleBefore), notExists(paymentFor)),
      and(eq(decisions.status, 'asked'), exists(unansweredQuestion)),
    ),
  );
  // A WITH query, because PostgreSQL runs a locking WITH query exactly once, while a locking
  // subquery inside the UPDATE may be run again as rows change under it and pass its LIMIT.
  const picked = db.$with('expiring').as(
    db
      .select({ id: decisions.id })
      .from(decisions)
      .innerJoin(owners, eq(owners.id, decisions.ownerId))
      .where(closable)
      .orderBy(asc(decisions.createdAt), asc(decisions.id))
      .limit(LIMITS.pruneBatch)
      .for('update', { of: [decisions, owners], skipLocked: true }),
  );

  const expired = await db
    .with(picked)
    .update(decisions)
    .set({ status: 'expired' })
    .where(and(closable, inArray(decisions.id, db.select({ id: picked.id }).from(picked))))
    .returning({ outcome: decisions.outcome });
  const questionsClosed = expired.filter((row) => row.outcome === 'asked').length;
  return { decisionsExpired: expired.length - questionsClosed, questionsClosed };
}
