import { LIMITS } from '@ellai/core/limits';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agents,
  decisionCitations,
  decisions,
  grantUses,
  grants,
  memories,
  owners,
  payments,
  questions,
  refills,
  sellerSales,
  sessions,
  signinNonces,
  stepUps,
} from '../db/schema.js';
import { pruneRateCounterBatch } from '../http/ratelimit.js';

export interface PruneArgs {
  db: Database;
  /** The time every expiry is judged against. */
  now: Date;
  /**
   * Read before each repeat, to stop repeating once LIMITS.pruneTimeSliceMs has passed since the
   * first batch. The jobs tick passes its own clock; the wall clock otherwise.
   */
  clock?: () => Date;
}

export interface PruneSummary {
  rateCounters: number;
  signinNonces: number;
  stepUps: number;
  sellerSales: number;
  sessions: number;
  /** Closed decisions only; the citations, grant uses and questions that went with them are not counted. */
  decisions: number;
  owners: number;
}

type Table = keyof PruneSummary;

interface Batch {
  table: Table;
  /** Deletes at most LIMITS.pruneBatch rows of `table`: how many went, and whether the batch was full, so another may follow. */
  run: () => Promise<{ deleted: number; full: boolean }>;
}

const counted = (deleted: number) => ({ deleted, full: deleted >= LIMITS.pruneBatch });

/**
 * An owner row that sign-in made and nothing else ever used: created more than
 * LIMITS.emptyOwnerKeepMs before `now`, with no allowance, no Walrus Memory account and no
 * delegate registration on the row itself, no live session, and no agent, decision, memory,
 * refill or step-up. Each of those is found through an index that leads with owner_id:
 * sessions_owner_expires_at_idx, agents_owner_idx, decisions_owner_created_at_idx,
 * memories_owner_created_at_idx, refills_owner_idx and step_ups_owner_idx, so the check costs a
 * few index probes per owner however large those tables grow (C34). A step-up outlives the
 * session that asked for it when the owner signs out within LIMITS.stepUpTtlMs, so an owner with
 * no live session can still hold an unexpired one; it is kept until the step-ups rule deletes it.
 *
 * The other tables that name an owner need no check of their own, because none of their rows can
 * exist for an owner without a decision: a question, a grant, a grant use, a decision citation
 * and a payment each carry a not-null decision_id, and its foreign key
 * (questions_decision_same_owner_fk, grants_decision_same_owner_fk,
 * grant_uses_decision_same_owner_fk, decision_citations_decision_same_owner_fk,
 * payments_decision_same_owner_fk) names a decision of that same owner.
 *
 * The purse and the delegate key are derived from the owner's address, not this row, so signing
 * in again rebuilds both.
 */
function emptyOwner(tx: Pick<Database, 'select'>, now: Date) {
  const one = { one: sql`1` };
  return and(
    lt(owners.createdAt, new Date(now.getTime() - LIMITS.emptyOwnerKeepMs)),
    isNull(owners.allowanceId),
    isNull(owners.memwalAccountId),
    isNull(owners.delegateRegisteredAt),
    notExists(tx.select(one).from(sessions).where(and(eq(sessions.ownerId, owners.id), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)))),
    notExists(tx.select(one).from(agents).where(eq(agents.ownerId, owners.id))),
    notExists(tx.select(one).from(decisions).where(eq(decisions.ownerId, owners.id))),
    notExists(tx.select(one).from(memories).where(eq(memories.ownerId, owners.id))),
    notExists(tx.select(one).from(refills).where(eq(refills.ownerId, owners.id))),
    notExists(tx.select(one).from(stepUps).where(eq(stepUps.ownerId, owners.id))),
  );
}

/**
 * A decision that closed without a payment, created more than LIMITS.closedDecisionKeepMs before
 * `now`: refused, expired or failed (C34). The status test is written exactly as the predicate of
 * decisions_closed_created_at_idx, so the planner can walk that partial index in created_at order.
 *
 * Six foreign keys name a decision (schema.ts, migrations 0000 to 0007). A payment
 * (payments_decision_same_owner_fk) means money moved or may have, so such a decision is never
 * closed-without-payment and is kept. A memory (memories_decision_same_owner_fk) is the owner's
 * own record of an answer or an outcome, so a decision a memory names is kept. A grant
 * (grants_decision_same_owner_fk) belongs only to a decision its owner answered, which is
 * 'answered', never closed; one that somehow did would carry another decision's grant use, so it
 * is kept as well. The other three are this decision's own rows, deleted with it: its citations
 * (decision_citations_decision_same_owner_fk), its use of an earlier decision's grant
 * (grant_uses_decision_same_owner_fk; that grant expired LIMITS.grantTtlMs after it was made,
 * long before the keep time, and decide never takes an expired grant, so the use can never be
 * spent again) and its question (questions_decision_same_owner_fk).
 */
function closedDecision(tx: Pick<Database, 'select'>, now: Date) {
  const one = { one: sql`1` };
  return and(
    sql`${decisions.status} in ('refused', 'expired', 'failed')`,
    lt(decisions.createdAt, new Date(now.getTime() - LIMITS.closedDecisionKeepMs)),
    notExists(tx.select(one).from(payments).where(and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId)))),
    notExists(tx.select(one).from(memories).where(and(eq(memories.decisionId, decisions.id), eq(memories.ownerId, decisions.ownerId)))),
    notExists(tx.select(one).from(grants).where(and(eq(grants.decisionId, decisions.id), eq(grants.ownerId, decisions.ownerId)))),
  );
}

/**
 * Deletes rows that can never be used again, in batches of LIMITS.pruneBatch per table, so
 * cleanup keeps ahead of the global caps on anonymous work however many strangers ask for a
 * sign-in or a challenge (C22, C34):
 * - rate counters whose window started more than LIMITS.rateCounterRetentionMs before `now`
 *   (pruneRateCounterBatch), first, since per-client counters arrive at request rate and every
 *   count still inside its window is kept;
 * - sign-in nonces whose expiry is before `now`, used or not: completeSignIn refuses an
 *   expired nonce, so the row decides nothing any more;
 * - step-ups whose expiry is before `now`, used or not: claimStepUp refuses an expired one, so the
 *   row decides nothing any more. They go before empty owners, whose step-ups hold them back;
 * - Ellai's seller sales with no digest and no settled_at whose expiry is before `now`, either
 *   still 'issued' or 'rejected': a sale is claimed by leaving 'issued' while unexpired, so an
 *   issued one was never paid, and a rejected one was refused, or turned away by a cap on sends,
 *   before its bytes were recorded or sent, so nothing can ever pick it up again;
 * - Ellai's seller sales 'rejected' and either still waiting on the chain (a digest, no
 *   settled_at) or closed for good (settled_at set), whose expiry is more than
 *   LIMITS.sellerWaitingSaleKeepMs before `now`: the payment's epoch window closed long before,
 *   so a recheck can only ever close them, and a closed one decides nothing;
 * - sessions that expired more than LIMITS.endedSessionKeepMs before `now`. A revoked session
 *   goes when it expires, since revoked_at has no index to find it by;
 * - decisions that closed without a payment more than LIMITS.closedDecisionKeepMs ago
 *   (closedDecision), oldest first through decisions_closed_created_at_idx, in one transaction per
 *   batch that locks each decision row first (FOR UPDATE SKIP LOCKED), checks it again under the
 *   lock, then deletes its citations, its grant use and its question before the decision itself,
 *   since every one of those foreign keys is ON DELETE RESTRICT. Free wallets can make a decision
 *   on every pay-request, so this is what keeps the table from growing without bound (C34). They
 *   go before empty owners, whose decisions hold them back;
 * - empty owners (emptyOwner), LIMITS.pruneBatch at a time, oldest first through
 *   owners_created_at_idx, each batch of a call starting where the one before it stopped, with
 *   their ended sessions, in one transaction that locks each owner row first (FOR UPDATE SKIP
 *   LOCKED) and checks it again under the lock, since sign-in can create a row anyone's wallet
 *   can make.
 *   The lock is what holds: a new session or any other row pointing at the owner must wait for
 *   it, and every such reference is ON DELETE RESTRICT, so a row that slipped past the check
 *   fails the delete and keeps the owner.
 * Each rule but the owners', the decisions' (created_at) and the rate counters' (window_start)
 * deletes through the expires_at index, oldest first. Every rule runs
 * one batch; a rule whose batch came back full runs again, round by round, until each comes back
 * short or LIMITS.pruneTimeSliceMs has passed on `clock` since the first batch, so one busy table
 * cannot starve the others of their first batch. Returns how many rows each table lost, an
 * owner's sessions counted under sessions. Throws for a time that is not a date.
 */
export async function pruneExpiredRows(args: PruneArgs): Promise<PruneSummary> {
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, now } = args;
  const clock = args.clock ?? (() => new Date());
  const endedBefore = new Date(now.getTime() - LIMITS.endedSessionKeepMs);
  const waitingBefore = new Date(now.getTime() - LIMITS.sellerWaitingSaleKeepMs);

  const expiredNonce = lt(signinNonces.expiresAt, now);
  const expiredStepUp = lt(stepUps.expiresAt, now);
  const unsentSale = and(
    lt(sellerSales.expiresAt, now),
    inArray(sellerSales.status, ['issued', 'rejected']),
    isNull(sellerSales.digest),
    isNull(sellerSales.settledAt),
  );
  const oldRejectedSale = and(
    lt(sellerSales.expiresAt, waitingBefore),
    eq(sellerSales.status, 'rejected'),
    or(isNotNull(sellerSales.settledAt), isNotNull(sellerSales.digest)),
  );
  const expiredSession = lt(sessions.expiresAt, endedBefore);

  const sales = async (rule: ReturnType<typeof and>) =>
    counted(
      (
        await db
          .delete(sellerSales)
          .where(and(rule, inArray(sellerSales.id, db.select({ id: sellerSales.id }).from(sellerSales).where(rule).orderBy(asc(sellerSales.expiresAt)).limit(LIMITS.pruneBatch))))
          .returning({ id: sellerSales.id })
      ).length,
    );

  const summary: PruneSummary = { rateCounters: 0, signinNonces: 0, stepUps: 0, sellerSales: 0, sessions: 0, decisions: 0, owners: 0 };

  const closedDecisions = () =>
    db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: decisions.id })
        .from(decisions)
        .where(closedDecision(tx, now))
        .orderBy(asc(decisions.createdAt))
        .limit(LIMITS.pruneBatch)
        .for('update', { skipLocked: true });
      if (picked.length === 0) return counted(0);
      const full = picked.length >= LIMITS.pruneBatch;
      // The pick read rows as they stood when it began; this read starts after the locks are held.
      const ids = (
        await tx
          .select({ id: decisions.id })
          .from(decisions)
          .where(
            and(
              inArray(
                decisions.id,
                picked.map((row) => row.id),
              ),
              closedDecision(tx, now),
            ),
          )
      ).map((row) => row.id);
      if (ids.length === 0) return { deleted: 0, full };
      await tx.delete(decisionCitations).where(inArray(decisionCitations.decisionId, ids));
      await tx.delete(grantUses).where(inArray(grantUses.decisionId, ids));
      await tx.delete(questions).where(inArray(questions.decisionId, ids));
      return { deleted: (await tx.delete(decisions).where(inArray(decisions.id, ids)).returning({ id: decisions.id })).length, full };
    });

  // Where this call's walk through owners_created_at_idx has reached, so each batch after the
  // first starts past the owners in use that an earlier one already stepped over. A Date holds
  // milliseconds and created_at microseconds, so the bound can only take in a few owners again.
  let walked: { createdAt: Date; id: string } | null = null;
  const pastWalked = () => {
    const from = walked;
    return from === null ? undefined : and(gte(owners.createdAt, from.createdAt), or(gt(owners.createdAt, from.createdAt), gt(owners.id, from.id)));
  };

  const emptyOwners = () =>
    db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: owners.id, createdAt: owners.createdAt })
        .from(owners)
        .where(and(emptyOwner(tx, now), pastWalked()))
        .orderBy(asc(owners.createdAt), asc(owners.id))
        .limit(LIMITS.pruneBatch)
        .for('update', { skipLocked: true });
      const last = picked.at(-1);
      if (last === undefined) return counted(0);
      walked = { createdAt: last.createdAt, id: last.id };
      const full = picked.length >= LIMITS.pruneBatch;
      // The pick read rows as they stood when it began; this read starts after the locks are held.
      const ids = (
        await tx
          .select({ id: owners.id })
          .from(owners)
          .where(
            and(
              inArray(
                owners.id,
                picked.map((row) => row.id),
              ),
              emptyOwner(tx, now),
            ),
          )
      ).map((row) => row.id);
      if (ids.length === 0) return { deleted: 0, full };
      const ended = await tx
        .delete(sessions)
        .where(and(inArray(sessions.ownerId, ids), or(isNotNull(sessions.revokedAt), lte(sessions.expiresAt, now))))
        .returning({ id: sessions.id });
      summary.sessions += ended.length;
      return { deleted: (await tx.delete(owners).where(inArray(owners.id, ids)).returning({ id: owners.id })).length, full };
    });

  const batches: Batch[] = [
    { table: 'rateCounters', run: async () => counted(await pruneRateCounterBatch(db, now)) },
    {
      table: 'signinNonces',
      run: async () =>
        counted(
          (
            await db
              .delete(signinNonces)
              .where(
                and(
                  expiredNonce,
                  inArray(signinNonces.nonce, db.select({ nonce: signinNonces.nonce }).from(signinNonces).where(expiredNonce).orderBy(asc(signinNonces.expiresAt)).limit(LIMITS.pruneBatch)),
                ),
              )
              .returning({ nonce: signinNonces.nonce })
          ).length,
        ),
    },
    {
      table: 'stepUps',
      run: async () =>
        counted(
          (
            await db
              .delete(stepUps)
              .where(and(expiredStepUp, inArray(stepUps.nonce, db.select({ nonce: stepUps.nonce }).from(stepUps).where(expiredStepUp).orderBy(asc(stepUps.expiresAt)).limit(LIMITS.pruneBatch))))
              .returning({ nonce: stepUps.nonce })
          ).length,
        ),
    },
    { table: 'sellerSales', run: () => sales(unsentSale) },
    { table: 'sellerSales', run: () => sales(oldRejectedSale) },
    {
      table: 'sessions',
      run: async () =>
        counted(
          (
            await db
              .delete(sessions)
              .where(and(expiredSession, inArray(sessions.id, db.select({ id: sessions.id }).from(sessions).where(expiredSession).orderBy(asc(sessions.expiresAt)).limit(LIMITS.pruneBatch))))
              .returning({ id: sessions.id })
          ).length,
        ),
    },
    { table: 'decisions', run: closedDecisions },
    { table: 'owners', run: emptyOwners },
  ];

  const startedMs = clock().getTime();
  let round = batches;
  for (let first = true; round.length > 0; first = false) {
    const again: Batch[] = [];
    for (const batch of round) {
      if (!first && clock().getTime() - startedMs >= LIMITS.pruneTimeSliceMs) return summary;
      const { deleted, full } = await batch.run();
      summary[batch.table] += deleted;
      if (full) again.push(batch);
    }
    round = again;
  }
  return summary;
}
