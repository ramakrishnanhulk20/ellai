import { LIMITS } from '@ellai/core/limits';
import { MemoryError, checkJobs, submitSentences } from '@ellai/core/memory';
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
// The bulk writes one pacing window holds. Core paces each client by sleeping, and a pass holds
// its rows locked while it writes, so a pass never makes more writes than fit without a wait.
const WRITES_PER_PASS = Math.max(1, Math.floor(LIMITS.memwalPointsPerMinute / LIMITS.memwalBulkPoints));
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
 * Watches each bulk write made on this client, from `start` to the next `start`. From the
 * moment the SDK call starts the relayer may store the sentences, unless it answers with a
 * status that it only ever gives before creating a job: any 4xx (validation, auth, rate limit)
 * or a 503 (writes paused, or the auth layer unable to reach Sui), per remember_bulk in
 * services/server/src/routes/remember.rs. A 500, 502 or 504, a timeout, a dropped connection
 * or an accepted write with unusable job ids may all have stored something.
 */
function watchBulkWrites(client: MemoryClient): { start: () => void; state: () => SendState } {
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
  return {
    start: () => {
      state = 'not_sent';
    },
    state: () => state,
  };
}

type Attempt =
  | { kind: 'accepted'; jobIds: string[] }
  /** Nothing was stored. `aboutTheRows` when core or the relayer refused what was sent (core's WRITE), not the moment. */
  | { kind: 'refused'; error: unknown; aboutTheRows: boolean }
  /** The relayer refused Ellai's delegate key (core's DELEGATE, for a 401 or 403): the owner removed it from the account. */
  | { kind: 'key_refused'; error: MemoryError }
  | { kind: 'uncertain' };

async function attemptWrite(client: MemoryClient, watch: ReturnType<typeof watchBulkWrites>, rows: Array<{ sentence: string }>): Promise<Attempt> {
  watch.start();
  try {
    return {
      kind: 'accepted',
      jobIds: await submitSentences(
        client,
        MEMORY_NAMESPACE,
        rows.map((row) => row.sentence),
      ),
    };
  } catch (error) {
    if (watch.state() === 'maybe_stored') return { kind: 'uncertain' };
    if (error instanceof MemoryError && error.code === 'DELEGATE') return { kind: 'key_refused', error };
    return { kind: 'refused', error, aboutTheRows: error instanceof MemoryError && error.code === 'WRITE' };
  }
}

const unsent = (ids: string[]) => and(inArray(memories.id, ids), eq(memories.status, 'pending'), isNull(memories.jobId));

/**
 * Every attempt counts against its rows, except one the relayer refused at the key: that says
 * nothing about the rows, and counting it would fail them while the owner has Ellai's key off.
 */
async function recordAttempt(tx: Pick<Database, 'update'>, rows: Array<{ id: string }>, sent: Attempt, now: Date): Promise<void> {
  if (sent.kind === 'key_refused') return;
  const ids = rows.map((row) => row.id);
  const counted = { submitAttempts: sql`${memories.submitAttempts} + 1`, submittedAt: now };
  if (sent.kind === 'accepted') {
    await tx
      .update(memories)
      .set({ ...counted, jobId: perRow(rows.map((row, index) => ({ id: row.id, value: sent.jobIds[index] ?? '' }))) })
      .where(unsent(ids));
  } else if (sent.kind === 'uncertain') {
    await tx
      .update(memories)
      .set({ ...counted, status: 'failed' })
      .where(unsent(ids));
  } else {
    const ceiling = sql`case when ${memories.submitAttempts} + 1 >= ${LIMITS.memoryWriteMaxAttempts} then 'failed' else ${memories.status} end`;
    await tx
      .update(memories)
      .set({ ...counted, status: ceiling })
      .where(unsent(ids));
  }
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
 * sentences signed by that same delegate on the owner's own account; and stores each job id on
 * its row. A row with a job id is never claimed again, because the relayer has no idempotency
 * on SDK 0.1.8's bulk writes.
 *
 * A row that has never been tried goes in one bulk write with the other untried rows. A row
 * that was in a refused write goes alone, so one row the relayer will never take cannot keep
 * refusing the rest. Rows tried before go first, oldest first, and a pass makes at most as
 * many writes as one relayer pacing window holds. Every attempt adds one to submit_attempts
 * and sets submitted_at to `now`.
 *
 * - Accepted: the job ids are stored.
 * - Refused before it can have stored anything (refused before sending, or a relayer answer
 *   it gives only before creating jobs): the rows stay pending with no job id, and a row whose
 *   attempt reaches LIMITS.memoryWriteMaxAttempts is marked 'failed'. The pass goes on to the
 *   next write only when the refusal was about what was sent (core's WRITE); a rate limit or
 *   a 503 ends it. When nothing was accepted, the MemoryError from core is thrown.
 * - May have stored something (a timeout after sending, a 5xx other than 503, a dropped
 *   connection, an unusable acceptance): the rows are marked 'failed' rather than risk a
 *   second copy, the pass ends, and MemoryServiceError SEND_UNCERTAIN is thrown.
 * - Refused at the delegate key (core's DELEGATE, a 401 or 403: the owner removed Ellai's
 *   key): nothing is counted or failed, the pass ends, and that MemoryError is thrown, which
 *   the jobs tick records as MEMORY_DELEGATE.
 * Whatever is thrown, everything before it in the pass is committed first. A row already at
 * the attempt ceiling when claimed is marked 'failed' and not sent. A failed refusal still
 * blocks its recipient, because the refusal check reads the database whatever the memory's
 * status (C11).
 *
 * Throws MemoryServiceError: BAD_INPUT, OWNER, NO_ACCOUNT (before touching any row),
 * SEND_UNCERTAIN; MemoryError from core.
 */
export async function submitPendingMemories(args: WriterArgs): Promise<{ submitted: number }> {
  const { ownerId } = checkArgs(args);
  const { db, now } = args;
  const { client, publicKeyHex } = await ownerClient(db, ownerId, args.masterSecretHex);
  const watch = watchBulkWrites(client);
  try {
    const pass = await db.transaction(async (tx) => {
      const claimed = await tx
        .select({ id: memories.id, sentence: memories.sentence, submitAttempts: memories.submitAttempts })
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
      const spent = claimed.filter((row) => row.submitAttempts >= LIMITS.memoryWriteMaxAttempts);
      if (spent.length > 0) {
        await tx
          .update(memories)
          .set({ status: 'failed' })
          .where(unsent(spent.map((row) => row.id)));
      }
      const live = claimed.filter((row) => row.submitAttempts < LIMITS.memoryWriteMaxAttempts);
      const writes = [...live.filter((row) => row.submitAttempts > 0).map((row) => [row]), firstOfEachSentence(live.filter((row) => row.submitAttempts === 0))]
        .filter((rows) => rows.length > 0)
        .slice(0, WRITES_PER_PASS);

      let submitted = 0;
      let uncertain = 0;
      let refusal: { error: unknown } | undefined;
      let keyRefused: MemoryError | undefined;
      for (const rows of writes) {
        const sent = await attemptWrite(client, watch, rows);
        await recordAttempt(tx, rows, sent, now);
        if (sent.kind === 'accepted') submitted += rows.length;
        else if (sent.kind === 'uncertain') uncertain += rows.length;
        else if (sent.kind === 'key_refused') keyRefused = sent.error;
        else refusal = { error: sent.error };
        if (sent.kind !== 'accepted' && !(sent.kind === 'refused' && sent.aboutTheRows)) break;
      }
      return { submitted, uncertain, refusal, keyRefused };
    });
    if (pass.keyRefused !== undefined) throw pass.keyRefused;
    if (pass.uncertain > 0) {
      throw new MemoryServiceError(
        'SEND_UNCERTAIN',
        `the bulk write may have reached the relayer, so ${pass.uncertain} memories were marked failed rather than sent twice`,
      );
    }
    if (pass.submitted === 0 && pass.refusal !== undefined) throw pass.refusal.error;
    return { submitted: pass.submitted };
  } finally {
    client.destroy();
  }
}

type JobRead = { state: 'done'; blobId: string } | { state: 'failed' | 'pending' | 'invalid' | 'unread' };

const UNREAD: JobRead = { state: 'unread' };

function readOf(job: Awaited<ReturnType<typeof checkJobs>>[number] | undefined, jobId: string): JobRead {
  if (job === undefined || job.jobId !== jobId) return { state: 'invalid' };
  if (job.state === 'done') return job.blobId === null ? { state: 'invalid' } : { state: 'done', blobId: job.blobId };
  return { state: job.state };
}

const refusedAnswer = (error: unknown) => error instanceof MemoryError && error.code === 'WRITE';

/**
 * Core refuses a whole status answer when one entry in it fails its checks, so after that
 * refusal each job is read on its own, and a job whose own answer still fails is 'invalid'
 * instead of holding up the others. Any other failure leaves every job not yet read 'unread'
 * and is handed back. Reading alone costs one relayer point per job, at most the relayer's
 * 20 per call, which fits one pacing window with the first read.
 */
async function readJobs(client: MemoryClient, jobIds: string[]): Promise<{ reads: JobRead[]; error?: unknown }> {
  try {
    const states = await checkJobs(client, jobIds);
    return { reads: jobIds.map((jobId, index) => readOf(states[index], jobId)) };
  } catch (error) {
    if (!refusedAnswer(error)) return { reads: jobIds.map(() => UNREAD), error };
  }
  const reads: JobRead[] = [];
  for (const jobId of jobIds) {
    try {
      const [state] = await checkJobs(client, [jobId]);
      reads.push(readOf(state, jobId));
    } catch (error) {
      if (!refusedAnswer(error)) return { reads: [...reads, ...jobIds.slice(reads.length).map(() => UNREAD)], error };
      reads.push({ state: 'invalid' });
    }
  }
  return { reads };
}

/**
 * Confirms the owner's sent memories: in one transaction, claims up to CONFIRM_BATCH rows
 * (LIMITS.memoryJobConfirmBatch, held to the relayer's 20 job ids per status call) of this
 * owner that are pending and have a job id, oldest first, with FOR UPDATE SKIP LOCKED, and
 * reads them with one checkJobs call, or one per job when core refuses that answer.
 *
 * - A done job sets the row's blob id, status 'confirmed' and confirmed_at `now`, unless its
 *   blob id is already on a row or another job in the answer reports it too: then the row is
 *   'failed', as one blob tied to two records could hand a recall hit the wrong facts (C10).
 * - A failed or unknown job, or a job whose own answer fails core's checks (a done job without
 *   a usable blob id), sets status 'failed' on that row only.
 * - A job still working, or one not read, stays as it is until LIMITS.memoryJobMaxAgeMs after
 *   its submitted_at (created_at for a row sent before that was kept), then is 'failed'.
 * Only a confirmed row has a blob id, so only it can be matched to a recall hit.
 *
 * When the relayer refuses Ellai's delegate key (core's DELEGATE: the owner removed it),
 * nothing is changed and that MemoryError is thrown. Any other MemoryError from a read is
 * thrown after the rows it does not touch are settled as above.
 *
 * Throws MemoryServiceError: BAD_INPUT, OWNER, NO_ACCOUNT (before touching any row);
 * MemoryError from core.
 */
export async function confirmMemoryJobs(args: WriterArgs): Promise<{ confirmed: number; failed: number; pending: number }> {
  const { ownerId } = checkArgs(args);
  const { db, now } = args;
  const { client } = await ownerClient(db, ownerId, args.masterSecretHex);
  try {
    const pass = await db.transaction(async (tx) => {
      const sent = await tx
        .select({ id: memories.id, jobId: memories.jobId, submittedAt: memories.submittedAt, createdAt: memories.createdAt })
        .from(memories)
        .where(and(eq(memories.ownerId, ownerId), eq(memories.status, 'pending'), isNotNull(memories.jobId)))
        .orderBy(asc(memories.createdAt), asc(memories.id))
        .limit(CONFIRM_BATCH)
        .for('update', { skipLocked: true });
      const rows = sent.flatMap((row) => (row.jobId === null ? [] : [{ ...row, jobId: row.jobId }]));
      if (rows.length === 0) return { counts: { confirmed: 0, failed: 0, pending: 0 } };

      const { reads, error } = await readJobs(
        client,
        rows.map((row) => row.jobId),
      );
      if (error instanceof MemoryError && error.code === 'DELEGATE') throw error;

      const pastAge = (row: (typeof rows)[number]) => now.getTime() - (row.submittedAt ?? row.createdAt).getTime() >= LIMITS.memoryJobMaxAgeMs;
      const done: Array<{ id: string; blobId: string }> = [];
      const failed: string[] = [];
      rows.forEach((row, index) => {
        const read = reads[index] ?? UNREAD;
        if (read.state === 'done') done.push({ id: row.id, blobId: read.blobId });
        else if (read.state === 'failed' || read.state === 'invalid' || pastAge(row)) failed.push(row.id);
      });

      const reported = new Map<string, number>();
      for (const job of done) reported.set(job.blobId, (reported.get(job.blobId) ?? 0) + 1);
      const held =
        done.length === 0
          ? []
          : await tx
              .select({ blobId: memories.blobId })
              .from(memories)
              .where(
                inArray(
                  memories.blobId,
                  done.map((job) => job.blobId),
                ),
              );
      const taken = new Set(held.map((row) => row.blobId));
      const confirmed = done.filter((job) => !taken.has(job.blobId) && reported.get(job.blobId) === 1);
      for (const job of done) if (!confirmed.includes(job)) failed.push(job.id);

      const unconfirmed = (ids: string[]) => and(inArray(memories.id, ids), eq(memories.status, 'pending'), isNotNull(memories.jobId));
      if (confirmed.length > 0) {
        await tx
          .update(memories)
          .set({ blobId: perRow(confirmed.map((job) => ({ id: job.id, value: job.blobId }))), status: 'confirmed', confirmedAt: now })
          .where(unconfirmed(confirmed.map((job) => job.id)));
      }
      if (failed.length > 0) await tx.update(memories).set({ status: 'failed' }).where(unconfirmed(failed));
      return { counts: { confirmed: confirmed.length, failed: failed.length, pending: rows.length - confirmed.length - failed.length }, error };
    });
    if (pass.error !== undefined) throw pass.error;
    return pass.counts;
  } finally {
    client.destroy();
  }
}
