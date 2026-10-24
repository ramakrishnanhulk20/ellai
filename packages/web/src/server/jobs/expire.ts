import { LIMITS } from '@ellai/core/limits';
import { and, eq, exists, isNull, lt, notExists, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, owners, payments, questions } from '../db/schema.js';

export interface ExpireArgs {
  db: Database;
  ownerId: string;
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Closes one owner's decisions that can no longer lead anywhere, so their request keys are
 * free to be decided afresh:
 * - an 'open' decision with no payment row, created more than LIMITS.staleOpenDecisionMs
 *   before `now`, was abandoned between approval and signing and becomes 'expired';
 * - an 'asked' decision whose question is still unanswered and was asked more than
 *   LIMITS.questionTtlMs before `now` becomes 'expired'. answerQuestion refuses a decision
 *   that is not 'asked', so a late answer cannot revive it.
 * Runs in one transaction that locks the owner row FOR UPDATE first, the order signing,
 * answering and outcome recording take it, so a decision being signed or answered right now
 * is either finished before this reads it or sees 'expired' and refuses.
 * Returns how many of each kind were expired. Throws for an owner id that is not a uuid or a
 * time that is not a date; an unknown owner expires nothing.
 */
export async function expireDecisions(args: ExpireArgs): Promise<{ decisionsExpired: number; questionsClosed: number }> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new Error('the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const ownerId = args.ownerId.toLowerCase();
  const staleBefore = new Date(args.now.getTime() - LIMITS.staleOpenDecisionMs);
  const askedBefore = new Date(args.now.getTime() - LIMITS.questionTtlMs);

  return args.db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
    if (owner === undefined) return { decisionsExpired: 0, questionsClosed: 0 };

    const paymentFor = tx
      .select({ one: sql`1` })
      .from(payments)
      .where(and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId)));
    const stale = await tx
      .update(decisions)
      .set({ status: 'expired' })
      .where(and(eq(decisions.ownerId, ownerId), eq(decisions.status, 'open'), lt(decisions.createdAt, staleBefore), notExists(paymentFor)))
      .returning({ id: decisions.id });

    const unansweredQuestion = tx
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
    const unanswered = await tx
      .update(decisions)
      .set({ status: 'expired' })
      .where(and(eq(decisions.ownerId, ownerId), eq(decisions.status, 'asked'), exists(unansweredQuestion)))
      .returning({ id: decisions.id });

    return { decisionsExpired: stale.length, questionsClosed: unanswered.length };
  });
}
