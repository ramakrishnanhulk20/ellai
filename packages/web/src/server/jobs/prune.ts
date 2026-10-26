import { LIMITS } from '@ellai/core/limits';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
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
} from '../db/schema.js';

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
  signinNonces: number;
  sellerSales: number;
  sessions: number;
  owners: number;
}

type Table = keyof PruneSummary;

interface Batch {
  table: Table;
  /** Deletes at most LIMITS.pruneBatch rows of `table` and returns how many went. */
  run: () => Promise<number>;
}

/**
 * An owner row that sign-in made and nothing else ever used: created more than
 * LIMITS.emptyOwnerKeepMs before `now`, with no allowance, no Walrus Memory account and no
 * delegate registration, no live session, and no row in any other table that names an owner.
 * Those tables are every one in schema.ts with an owner_id: agents, decisions, memories,
 * questions, grants, grant_uses, decision_citations, payments and refills. The purse and the
 * delegate key are derived from the owner's address, not this row, so signing in again
 * rebuilds both.
 */
function emptyOwner(tx: Pick<Database, 'select'>, now: Date) {
  const one = { one: sql`1` };
  return and(
    lt(owners.createdAt, new Date(now.getTime() - LIMITS.emptyOwnerKeepMs)),
    isNull(owners.allowanceId),
    isNull(owners.memwalAccountId),
    isNull(owners.delegateRegisteredAt),
    notExists(tx.select(one).from(agents).where(eq(agents.ownerId, owners.id))),
    notExists(tx.select(one).from(decisions).where(eq(decisions.ownerId, owners.id))),
    notExists(tx.select(one).from(memories).where(eq(memories.ownerId, owners.id))),
    notExists(tx.select(one).from(questions).where(eq(questions.ownerId, owners.id))),
    notExists(tx.select(one).from(grants).where(eq(grants.ownerId, owners.id))),
    notExists(tx.select(one).from(grantUses).where(eq(grantUses.ownerId, owners.id))),
    notExists(tx.select(one).from(decisionCitations).where(eq(decisionCitations.ownerId, owners.id))),
    notExists(tx.select(one).from(payments).where(eq(payments.ownerId, owners.id))),
    notExists(tx.select(one).from(refills).where(eq(refills.ownerId, owners.id))),
    notExists(tx.select(one).from(sessions).where(and(eq(sessions.ownerId, owners.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))),
  );
}

/**
 * Deletes rows that can never be used again, in batches of LIMITS.pruneBatch per table, so
 * cleanup keeps ahead of the global caps on anonymous work however many strangers ask for a
 * sign-in or a challenge (C22, C34):
 * - sign-in nonces whose expiry is before `now`, used or not: completeSignIn refuses an
 *   expired nonce, so the row decides nothing any more;
 * - Ellai's seller sales still 'issued' with no digest whose expiry is before `now`: a sale is
 *   claimed by leaving 'issued' while unexpired, so these were never paid;
 * - Ellai's seller sales 'rejected' and either still waiting on the chain (a digest, no
 *   settled_at) or closed for good (settled_at set), whose expiry is more than
 *   LIMITS.sellerWaitingSaleKeepMs before `now`: the payment's epoch window closed long before,
 *   so a recheck can only ever close them, and a closed one decides nothing;
 * - sessions that expired more than LIMITS.endedSessionKeepMs before `now`. A revoked session
 *   goes when it expires, since revoked_at has no index to find it by;
 * - empty owners (emptyOwner), LIMITS.pruneBatch at a time, oldest first, with their ended
 *   sessions, in one transaction that locks each owner row first (FOR UPDATE SKIP LOCKED) and
 *   checks it again under the lock, since sign-in can create a row anyone's wallet can make.
 *   The lock is what holds: a new session or any other row pointing at the owner must wait for
 *   it, and every such reference is ON DELETE RESTRICT, so a row that slipped past the check
 *   fails the delete and keeps the owner.
 * Each rule but the owners' deletes through the expires_at index, oldest first. Every rule runs
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
  const unpaidSale = and(lt(sellerSales.expiresAt, now), eq(sellerSales.status, 'issued'), isNull(sellerSales.digest));
  const oldRejectedSale = and(
    lt(sellerSales.expiresAt, waitingBefore),
    eq(sellerSales.status, 'rejected'),
    or(isNotNull(sellerSales.settledAt), isNotNull(sellerSales.digest)),
  );
  const expiredSession = lt(sessions.expiresAt, endedBefore);

  const sales = async (rule: ReturnType<typeof and>) =>
    (
      await db
        .delete(sellerSales)
        .where(and(rule, inArray(sellerSales.id, db.select({ id: sellerSales.id }).from(sellerSales).where(rule).orderBy(asc(sellerSales.expiresAt)).limit(LIMITS.pruneBatch))))
        .returning({ id: sellerSales.id })
    ).length;

  const summary: PruneSummary = { signinNonces: 0, sellerSales: 0, sessions: 0, owners: 0 };

  const emptyOwners = () =>
    db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: owners.id })
        .from(owners)
        .where(emptyOwner(tx, now))
        .orderBy(asc(owners.createdAt), asc(owners.id))
        .limit(LIMITS.pruneBatch)
        .for('update', { skipLocked: true });
      if (picked.length === 0) return 0;
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
      if (ids.length === 0) return 0;
      const ended = await tx
        .delete(sessions)
        .where(and(inArray(sessions.ownerId, ids), or(isNotNull(sessions.revokedAt), lte(sessions.expiresAt, now))))
        .returning({ id: sessions.id });
      summary.sessions += ended.length;
      return (await tx.delete(owners).where(inArray(owners.id, ids)).returning({ id: owners.id })).length;
    });

  const batches: Batch[] = [
    {
      table: 'signinNonces',
      run: async () =>
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
    },
    { table: 'sellerSales', run: () => sales(unpaidSale) },
    { table: 'sellerSales', run: () => sales(oldRejectedSale) },
    {
      table: 'sessions',
      run: async () =>
        (
          await db
            .delete(sessions)
            .where(and(expiredSession, inArray(sessions.id, db.select({ id: sessions.id }).from(sessions).where(expiredSession).orderBy(asc(sessions.expiresAt)).limit(LIMITS.pruneBatch))))
            .returning({ id: sessions.id })
        ).length,
    },
    { table: 'owners', run: emptyOwners },
  ];

  const startedMs = clock().getTime();
  let round = batches;
  for (let first = true; round.length > 0; first = false) {
    const again: Batch[] = [];
    for (const batch of round) {
      if (!first && clock().getTime() - startedMs >= LIMITS.pruneTimeSliceMs) return summary;
      const deleted = await batch.run();
      summary[batch.table] += deleted;
      if (deleted >= LIMITS.pruneBatch) again.push(batch);
    }
    round = again;
  }
  return summary;
}
