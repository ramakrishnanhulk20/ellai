import { LIMITS } from '@ellai/core/limits';
import { checkJobs, submitSentences } from '@ellai/core/memory';
import { type SQL, and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { memories, owners } from '../db/schema.js';
import { MemoryServiceError, ownerMemoryClient } from './delegate.js';
import { MEMORY_NAMESPACE } from './namespace.js';

export interface WriterArgs {
  db: Database;
  ownerId: string;
  masterSecretHex: string;
  now: Date;
}

type MemoryClient = ReturnType<typeof ownerMemoryClient>['client'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The relayer refuses more than 20 job ids in one status call (MAX_BULK_ITEMS in its
// services/server/src/types.rs), so one confirmation pass can never check more than that.
const CONFIRM_BATCH = Math.min(LIMITS.memoryJobConfirmBatch, LIMITS.memwalBulkMaxItems);
const HTTP_SERVICE_UNAVAILABLE = 503;
// Coarser than the repeat check in core: everything core folds into one space is dropped
// here, so two sentences core calls repeats always share a key and are never sent together.
const IGNORED_IN_KEY = /[\s\p{Cc}\p{Cf}]/gu;

function checkArgs(args: WriterArgs): { ownerId: string } {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new MemoryServiceError('BAD_INPUT', 'the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new MemoryServiceError('BAD_INPUT', 'the current time is not a date');
  return { ownerId: args.ownerId.toLowerCase() };
}

async function ownerClient(db: Database, ownerId: string, masterSecretHex: string) {
  const [owner] = await db
    .select({ suiAddress: owners.suiAddress, memwalAccountId: owners.memwalAccountId })
    .from(owners)
    .where(eq(owners.id, ownerId));
  if (owner === undefined) throw new MemoryServiceError('OWNER', 'the owner was not found');
  return ownerMemoryClient(owner, masterSecretHex);
}

type SendState = 'not_sent' | 'refused' | 'maybe_stored';

/**
 * Watches the one bulk write made on this client. From the moment the SDK call starts the
 * relayer may store the sentences, unless it answers with a status that it only ever gives
 * before creating a job: any 4xx (validation, auth, rate limit) or a 503 (writes paused, or
 * the auth layer unable to reach Sui), per remember_bulk in services/server/src/routes/remember.rs.
 * A 500, 502 or 504, a timeout, a dropped connection or an accepted write with unusable job
 * ids may all have stored something.
 */
function watchBulkWrite(client: MemoryClient): () => SendState {
  let state: SendState = 'not_sent';
  const send = client.rememberBulk.bind(client);
  client.rememberBulk = async (items) => {
    state = 'maybe_stored';
    try {
      return await send(items);
    } catch (error) {
      const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
      if (typeof status === 'number' && ((status >= 400 && status < 500) || status === HTTP_SERVICE_UNAVAILABLE)) state = 'refused';
      throw error;
    }
  };
  return () => state;
}

/** `case id when ... then ... end` for a one-statement update of a value that differs per row. */
function perRow(rows: Array<{ id: string; value: string }>): SQL {
  const branches = rows.map((row) => sql`when ${row.id}::uuid then ${row.value}::text`);
  return sql`case ${memories.id} ${sql.join(branches, sql` `)} end`;
}

/**
 * Core refuses a bulk write holding a sentence twice, so a repeat would fail every pass and
 * hold up all of this owner's later answers. The first copy goes now; a later one stays
 * pending and goes in a later pass as its own memory, as it is its own owner answer.
 */
function firstOfEachSentence<T extends { sentence: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.sentence.normalize('NFKC').toLowerCase().replace(IGNORED_IN_KEY, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sends the owner's pending memories to Walrus Memory: in one transaction, claims up to
 * LIMITS.pendingMemoryWriteBatch rows of this owner that are pending, have no job id, sit in
 * MEMORY_NAMESPACE and were recorded with this owner's derived delegate as their writer, oldest
 * first, with SELECT ... FOR UPDATE SKIP LOCKED so two passes never claim one row; sends their
 * sentences in one bulk write signed by that same delegate on the owner's own account; and
 * stores each job id on its row. A row with a job id is never claimed again, because the
 * relayer has no idempotency on SDK 0.1.8's bulk writes.
 *
 * When the write fails before it can have stored anything (refused before sending, or a
 * relayer answer it gives only before creating jobs), the transaction rolls back: rows stay
 * pending with no job id, and the MemoryError from core is thrown. When it may have stored
 * something (a timeout after sending, a 5xx other than 503, a dropped connection, an unusable
 * acceptance), the rows are marked 'failed' and committed rather than risk a second copy, and
 * MemoryServiceError SEND_UNCERTAIN is thrown. A failed refusal still blocks its recipient,
 * because the refusal check reads the database whatever the memory's status (C11).
 *
 * Throws MemoryServiceError: BAD_INPUT, OWNER, NO_ACCOUNT (before touching any row),
 * SEND_UNCERTAIN; MemoryError from core.
 */
export async function submitPendingMemories(args: WriterArgs): Promise<{ submitted: number }> {
  const { ownerId } = checkArgs(args);
  const { db } = args;
  const { client, publicKeyHex } = await ownerClient(db, ownerId, args.masterSecretHex);
  const sendState = watchBulkWrite(client);
  try {
    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .select({ id: memories.id, sentence: memories.sentence })
        .from(memories)
        .where(
          and(
            eq(memories.ownerId, ownerId),
            eq(memories.status, 'pending'),
            isNull(memories.jobId),
            eq(memories.namespace, MEMORY_NAMESPACE),
            eq(memories.writerPublicKey, publicKeyHex),
          ),
        )
        .orderBy(asc(memories.createdAt), asc(memories.id))
        .limit(LIMITS.pendingMemoryWriteBatch)
        .for('update', { skipLocked: true });
      const batch = firstOfEachSentence(claimed);
      if (batch.length === 0) return { submitted: 0, uncertain: 0 };

      const ids = batch.map((row) => row.id);
      const stillUnsent = and(inArray(memories.id, ids), eq(memories.status, 'pending'), isNull(memories.jobId));
      let jobIds: string[];
      try {
        jobIds = await submitSentences(
          client,
          MEMORY_NAMESPACE,
          batch.map((row) => row.sentence),
        );
      } catch (error) {
        if (sendState() !== 'maybe_stored') throw error;
        await tx.update(memories).set({ status: 'failed' }).where(stillUnsent);
        return { submitted: 0, uncertain: batch.length };
      }
      await tx
        .update(memories)
        .set({ jobId: perRow(batch.map((row, index) => ({ id: row.id, value: jobIds[index] ?? '' }))) })
        .where(stillUnsent);
      return { submitted: batch.length, uncertain: 0 };
    });
    if (result.uncertain > 0) {
      throw new MemoryServiceError(
        'SEND_UNCERTAIN',
        `the bulk write may have reached the relayer, so ${result.uncertain} memories were marked failed rather than sent twice`,
      );
    }
    return { submitted: result.submitted };
  } finally {
    client.destroy();
  }
}

/**
 * Confirms the owner's sent memories: in one transaction, claims up to CONFIRM_BATCH rows
 * (LIMITS.memoryJobConfirmBatch, held to the relayer's 20 job ids per status call) of this
 * owner that are pending and have a job id, oldest first, with FOR UPDATE SKIP LOCKED, and
 * reads them all with one checkJobs call. A done job sets the row's blob id, status
 * 'confirmed' and confirmed_at `now`; a failed or unknown job sets status 'failed'; a job
 * still working leaves the row as it is. Only a confirmed row has a blob id, so only it can be
 * matched to a recall hit.
 *
 * Throws MemoryServiceError: BAD_INPUT, OWNER, NO_ACCOUNT (before touching any row);
 * MemoryError from core, in which case nothing is changed.
 */
export async function confirmMemoryJobs(args: WriterArgs): Promise<{ confirmed: number; failed: number; pending: number }> {
  const { ownerId } = checkArgs(args);
  const { db, now } = args;
  const { client } = await ownerClient(db, ownerId, args.masterSecretHex);
  try {
    return await db.transaction(async (tx) => {
      const sent = await tx
        .select({ id: memories.id, jobId: memories.jobId })
        .from(memories)
        .where(and(eq(memories.ownerId, ownerId), eq(memories.status, 'pending'), isNotNull(memories.jobId)))
        .orderBy(asc(memories.createdAt), asc(memories.id))
        .limit(CONFIRM_BATCH)
        .for('update', { skipLocked: true });
      const rows = sent.flatMap((row) => (row.jobId === null ? [] : [{ id: row.id, jobId: row.jobId }]));
      if (rows.length === 0) return { confirmed: 0, failed: 0, pending: 0 };

      const states = await checkJobs(
        client,
        rows.map((row) => row.jobId),
      );
      const done: Array<{ id: string; value: string }> = [];
      const failed: string[] = [];
      rows.forEach((row, index) => {
        const job = states[index];
        if (job === undefined || job.jobId !== row.jobId) throw new Error('the job states do not line up with the rows asked about');
        if (job.state === 'done' && job.blobId !== null) done.push({ id: row.id, value: job.blobId });
        else if (job.state === 'failed') failed.push(row.id);
      });

      const unconfirmed = (ids: string[]) => and(inArray(memories.id, ids), eq(memories.status, 'pending'), isNotNull(memories.jobId));
      if (done.length > 0) {
        await tx
          .update(memories)
          .set({ blobId: perRow(done), status: 'confirmed', confirmedAt: now })
          .where(unconfirmed(done.map((row) => row.id)));
      }
      if (failed.length > 0) await tx.update(memories).set({ status: 'failed' }).where(unconfirmed(failed));
      return { confirmed: done.length, failed: failed.length, pending: rows.length - done.length - failed.length };
    });
  } finally {
    client.destroy();
  }
}
