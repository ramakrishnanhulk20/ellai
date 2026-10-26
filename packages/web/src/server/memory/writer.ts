import { LIMITS } from '@ellai/core/limits';
import { MemoryError, checkJobs, submitSentences } from '@ellai/core/memory';
import { type SQL, and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { memories, owners } from '../db/schema.js';
import { MemoryServiceError, ownerMemoryClient } from './delegate.js';
import { MEMORY_NAMESPACE } from './namespace.js';

export interface WriterArgs {
  db: Database;
  ownerId: string;
  masterSecretHex: string;
  now: Date;
  /** Asked before each relayer call: false once the jobs tick's deadline has passed. Always true when left out. */
  canStart?: () => boolean;
}

type MemoryClient = ReturnType<typeof ownerMemoryClient>['client'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_SERVICE_UNAVAILABLE = 503;
// Coarser than the repeat check in core: everything core folds into one space is dropped
// here, so two sentences core calls repeats always share a key and are never sent together.
const IGNORED_IN_KEY = /[\s\p{Cc}\p{Cf}]/gu;

/**
 * True for core's DELEGATE refusal (a 401 or 403 from the relayer): the owner removed Ellai's
 * delegate key from their account, so every relayer call for them fails the same way until
 * they add it back.
 */
export function isKeyRefused(error: unknown): error is MemoryError {
  return error instanceof MemoryError && error.code === 'DELEGATE';
}

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

type SendState = 'not_sent' | 'sending' | 'unsent' | 'refused' | 'answered';

// The steps SDK 0.1.8 takes inside a signed request before the request itself goes out: the
// relayer's version check, and the SEAL session, which reads GET /config and then Sui.
const SETUP_STEPS = ['ensureCompatibleRelayer', 'buildSealSession'] as const;

/**
 * Counts the failures of this client's setup steps (SETUP_STEPS). A call during which the count
 * rose failed before its request went out, so the relayer never saw it and the failure says
 * nothing about the rows, the jobs or the key. SDK 0.1.8's own setup errors (GET /version,
 * /health, /config) carry their status only in the message, but the SEAL session reads Sui
 * through @mysten/sui's JSON-RPC client, whose SuiHTTPStatusError carries the fullnode's HTTP
 * status, which core would otherwise read as the relayer refusing the request.
 */
function watchSetupSteps(client: MemoryClient): () => number {
  let failures = 0;
  const steps = client as unknown as Record<(typeof SETUP_STEPS)[number], unknown>;
  for (const name of SETUP_STEPS) {
    const step = steps[name];
    if (typeof step !== 'function') continue;
    const run = step.bind(client) as () => Promise<unknown>;
    steps[name] = async () => {
      try {
        return await run();
      } catch (error) {
        failures += 1;
        throw error;
      }
    };
  }
  return () => failures;
}

/**
 * Watches each bulk write made on this client, from `start` to the next `start`. 'refused' is
 * an answer the relayer only ever gives before creating a job: any 4xx (validation, auth, rate
 * limit) or a 503 (writes paused, or the auth layer unable to reach Sui), per remember_bulk in
 * services/server/src/routes/remember.rs. 'answered' is a 2xx: the relayer took the write.
 * 'unsent' is a setup step that failed before the request went out (watchSetupSteps), whatever
 * status its error carries. 'sending' left is no answer at all, a 500, 502 or 504, or a timeout,
 * any of which may or may not have stored something.
 */
function watchBulkWrites(client: MemoryClient): { start: () => void; state: () => SendState } {
  let state: SendState = 'not_sent';
  const setupFailures = watchSetupSteps(client);
  const send = client.rememberBulk.bind(client);
  client.rememberBulk = async (items) => {
    const before = setupFailures();
    state = 'sending';
    try {
      const accepted = await send(items);
      state = 'answered';
      return accepted;
    } catch (error) {
      const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
      if (setupFailures() > before) state = 'unsent';
      else if (typeof status === 'number' && ((status >= 400 && status < 500) || status === HTTP_SERVICE_UNAVAILABLE)) state = 'refused';
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
  /** Nothing was stored, because what was sent was refused: core's WRITE, from its own checks or for the relayer's 4xx. */
  | { kind: 'refused_rows'; error: MemoryError }
  /**
   * Nothing about the rows: a rate limit, an outage or a timeout. The relayer may have stored a
   * write that timed out or got no answer; sending it again can leave an orphan blob, which no
   * row names and so never counts (C9), where failing it would throw the owner's answer away.
   */
  | { kind: 'transient'; error: unknown }
  /** The relayer refused Ellai's delegate key (core's DELEGATE, for a 401 or 403): the owner removed it from the account. */
  | { kind: 'key_refused'; error: MemoryError }
  /** The relayer answered the write, so it took the rows, but not with one usable job id each, so they cannot be followed. */
  | { kind: 'untrackable' };

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
    if (watch.state() === 'answered') return { kind: 'untrackable' };
    // Nothing reached the relayer, so the failure says nothing about the rows or the key.
    if (watch.state() === 'unsent') return { kind: 'transient', error };
    if (isKeyRefused(error)) return { kind: 'key_refused', error };
    // Core gives WRITE only for its own checks or a 4xx, so 'sending' with WRITE cannot happen; it is excluded so it could never fail a row.
    if (error instanceof MemoryError && error.code === 'WRITE' && watch.state() !== 'sending') return { kind: 'refused_rows', error };
    return { kind: 'transient', error };
  }
}

const unsent = (ids: string[]) => and(inArray(memories.id, ids), eq(memories.status, 'pending'), isNull(memories.jobId));

/**
 * Only a refusal about the rows spends one of their LIMITS.memoryWriteMaxAttempts (C33): a rate
 * limit, an outage or a timeout says nothing about them, changes nothing here, and the age
 * ceiling bounds it. A refused delegate key is not recorded either; its caller releases the lease.
 * Returns how many accepted rows took their job id: none when another pass got there first.
 */
async function recordAttempt(tx: Pick<Database, 'update'>, rows: Array<{ id: string }>, sent: Attempt): Promise<number> {
  const ids = rows.map((row) => row.id);
  if (sent.kind === 'accepted') {
    const recorded = await tx
      .update(memories)
      .set({ jobId: perRow(rows.map((row, index) => ({ id: row.id, value: sent.jobIds[index] ?? '' }))) })
      .where(unsent(ids))
      .returning({ id: memories.id });
    return recorded.length;
  }
  if (sent.kind === 'untrackable') {
    await tx.update(memories).set({ status: 'failed' }).where(unsent(ids));
  } else if (sent.kind === 'refused_rows') {
    const ceiling = sql`case when ${memories.submitAttempts} + 1 >= ${LIMITS.memoryWriteMaxAttempts} then 'failed' else ${memories.status} end`;
    await tx
      .update(memories)
      .set({ submitAttempts: sql`${memories.submitAttempts} + 1`, status: ceiling })
      .where(unsent(ids));
  }
  return 0;
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

type Claimed = { id: string; sentence: string; submitAttempts: number; submittedAt: Date | null };

/**
 * The rows of this pass's next write, claimed in one short transaction that commits before the
 * relayer is called, so no lock is ever held across a relayer call. Fails, unsent, every row past
 * LIMITS.memoryWriteMaxAgeMs since created_at and every candidate already at the attempt ceiling;
 * then takes the oldest free row tried before, alone, or else every free untried row up to
 * LIMITS.pendingMemoryWriteBatch, one copy of each sentence. A row is free when no pass handed it
 * to the relayer within LIMITS.memoryWriteLeaseMs before `now`, and taking it sets its
 * submitted_at to `now`: that is the lease, and it is what keeps a concurrent pass off it.
 */
async function claimWrite(db: Database, ours: SQL | undefined, now: Date): Promise<{ rows: Claimed[]; bulk: boolean }> {
  return db.transaction(async (tx) => {
    const free = and(ours, or(isNull(memories.submittedAt), lte(memories.submittedAt, new Date(now.getTime() - LIMITS.memoryWriteLeaseMs))));
    await tx
      .update(memories)
      .set({ status: 'failed' })
      .where(and(free, lte(memories.createdAt, new Date(now.getTime() - LIMITS.memoryWriteMaxAgeMs))));
    const candidates = await tx
      .select({ id: memories.id, sentence: memories.sentence, submitAttempts: memories.submitAttempts, submittedAt: memories.submittedAt })
      .from(memories)
      .where(free)
      .orderBy(asc(memories.createdAt), asc(memories.id))
      .limit(LIMITS.pendingMemoryWriteBatch)
      .for('update', { skipLocked: true });
    const spent = candidates.filter((row) => row.submitAttempts >= LIMITS.memoryWriteMaxAttempts);
    if (spent.length > 0) {
      await tx
        .update(memories)
        .set({ status: 'failed' })
        .where(unsent(spent.map((row) => row.id)));
    }
    const live = candidates.filter((row) => row.submitAttempts < LIMITS.memoryWriteMaxAttempts);
    const tried = live.find((row) => row.submitAttempts > 0);
    const rows = tried === undefined ? firstOfEachSentence(live) : [tried];
    if (rows.length > 0) {
      await tx
        .update(memories)
        .set({ submittedAt: now })
        .where(unsent(rows.map((row) => row.id)));
    }
    return { rows, bulk: tried === undefined };
  });
}

/** Puts back the submitted_at each row had before this pass leased it, for a write that changed nothing. */
async function releaseLease(tx: Pick<Database, 'update'>, rows: Claimed[], now: Date): Promise<void> {
  const before = rows.map((row) => sql`when ${row.id}::uuid then ${row.submittedAt === null ? null : row.submittedAt.toISOString()}::timestamptz`);
  await tx
    .update(memories)
    .set({ submittedAt: sql`case ${memories.id} ${sql.join(before, sql` `)} end` })
    .where(and(unsent(rows.map((row) => row.id)), eq(memories.submittedAt, now)));
}

/**
 * Sends the owner's pending memories to Walrus Memory: rows of this owner that are pending, have
 * no job id, sit in MEMORY_NAMESPACE and were recorded with this owner's derived delegate as their
 * writer, oldest first, signed by that same delegate on the owner's own account. Each write
 * claims its rows in a short committed transaction (claimWrite: SELECT ... FOR UPDATE SKIP
 * LOCKED, then submitted_at set to `now` as a lease of LIMITS.memoryWriteLeaseMs), calls the
 * relayer with no transaction open, and records the outcome in a new short transaction. A row
 * with a job id is never claimed again, because the relayer has no idempotency on SDK 0.1.8's
 * bulk writes; the record only touches rows still pending with no job id, so a late record can
 * never overwrite another pass's.
 *
 * A row that has never been refused goes in one bulk write with the other such rows. A row that
 * was in a write refused as written goes alone, so one row the relayer will never take cannot
 * keep refusing the rest. Rows refused before go first, oldest first, the bulk write ends the
 * pass, and a pass makes at most LIMITS.memoryWritesPerPass writes, what one relayer pacing
 * window holds, so core never pauses a pass to pace it. `canStart` is asked before each write,
 * and once it says no the pass claims and sends nothing more.
 *
 * - Accepted: the job ids are stored.
 * - Refused as written (core's WRITE, from its own checks or for the relayer's 4xx): the rows stay
 *   pending with no job id, each spends one of LIMITS.memoryWriteMaxAttempts, a row that reaches
 *   it is 'failed', and the pass goes on to its next write.
 * - A rate limit, an outage or a timeout (core's RATE_LIMITED, UPSTREAM or TIMEOUT: a 429, any
 *   5xx, no answer), or a setup step that failed before the request went out, whatever status it
 *   carries (watchBulkWrites): nothing is spent, the rows stay pending under their lease, and the pass ends.
 *   A row still unsent LIMITS.memoryWriteMaxAgeMs after created_at is 'failed' (C33). A timeout or
 *   a lost answer may have stored the write; sending it again then leaves an orphan blob.
 * - Answered without one usable job id per row: the relayer took them and they cannot be followed,
 *   so they are 'failed' rather than sent twice, the pass ends, and MemoryServiceError
 *   SEND_UNCERTAIN is thrown.
 * - Refused at the delegate key (core's DELEGATE, a 401 or 403: the owner removed Ellai's key):
 *   nothing is counted or failed, the lease is released, the pass ends, and that MemoryError is
 *   thrown, which the jobs tick records as MEMORY_DELEGATE.
 * When nothing was accepted, the last MemoryError from core is thrown. Whatever is thrown, every
 * write before it is recorded first. A failed refusal still blocks its recipient, because the
 * refusal check reads the database whatever the memory's status (C11).
 *
 * A write the relayer accepted whose job ids were never recorded (the function was killed after
 * the answer, or the record failed) keeps its lease and no job id, so once the lease has passed a
 * later pass sends it again. The first copy is then an orphan blob that no row names: decide maps
 * recall hits to Ellai's rows by blob id, so it never counts (C9), and only takes a recall slot.
 *
 * Throws MemoryServiceError: BAD_INPUT, OWNER, NO_ACCOUNT (before touching any row),
 * SEND_UNCERTAIN; MemoryError from core.
 */
export async function submitPendingMemories(args: WriterArgs): Promise<{ submitted: number }> {
  const { ownerId } = checkArgs(args);
  const { db, now } = args;
  const { client, publicKeyHex } = await ownerClient(db, ownerId, args.masterSecretHex);
  const watch = watchBulkWrites(client);
  const canStart = args.canStart ?? (() => true);
  const ours = and(
    eq(memories.ownerId, ownerId),
    eq(memories.status, 'pending'),
    isNull(memories.jobId),
    eq(memories.namespace, MEMORY_NAMESPACE),
    eq(memories.writerPublicKey, publicKeyHex),
  );
  let submitted = 0;
  let untrackable = 0;
  let refusal: { error: unknown } | undefined;
  let keyRefused: MemoryError | undefined;
  try {
    for (let write = 0; write < LIMITS.memoryWritesPerPass && canStart(); write++) {
      const { rows, bulk } = await claimWrite(db, ours, now);
      if (rows.length === 0) break;
      const sent = await attemptWrite(client, watch, rows);
      let recorded = 0;
      if (sent.kind !== 'transient') {
        recorded = await db.transaction(async (tx) => {
          if (sent.kind !== 'key_refused') return recordAttempt(tx, rows, sent);
          await releaseLease(tx, rows, now);
          return 0;
        });
      }
      if (sent.kind === 'accepted') submitted += recorded;
      else if (sent.kind === 'untrackable') untrackable += rows.length;
      else if (sent.kind === 'key_refused') keyRefused = sent.error;
      else refusal = { error: sent.error };
      if (bulk || (sent.kind !== 'accepted' && sent.kind !== 'refused_rows')) break;
    }
  } finally {
    client.destroy();
  }
  if (keyRefused !== undefined) throw keyRefused;
  if (untrackable > 0) {
    throw new MemoryServiceError(
      'SEND_UNCERTAIN',
      `the relayer took a bulk write without usable job ids, so ${untrackable} memories were marked failed rather than sent twice`,
    );
  }
  if (submitted === 0 && refusal !== undefined) throw refusal.error;
  return { submitted };
}

type JobRead = { state: 'done'; blobId: string } | { state: 'failed' | 'pending' | 'invalid' | 'unread' };

const UNREAD: JobRead = { state: 'unread' };

function readOf(job: Awaited<ReturnType<typeof checkJobs>>[number] | undefined, jobId: string): JobRead {
  if (job === undefined || job.jobId !== jobId) return { state: 'invalid' };
  if (job.state === 'done') return job.blobId === null ? { state: 'invalid' } : { state: 'done', blobId: job.blobId };
  return { state: job.state };
}

const refusedAnswer = (error: unknown) => error instanceof MemoryError && error.code === 'WRITE';

interface JobReads {
  reads: JobRead[];
  error?: unknown;
  /** True when `error` came from a setup step, before any request went out (watchSetupSteps). */
  unsent?: boolean;
}

/**
 * Core refuses a whole status answer when one entry in it fails its checks, so after that
 * refusal each job is read on its own, and a job whose own answer still fails is 'invalid'
 * instead of holding up the others. A failure in a setup step (`setupFailures` rose during the
 * read) never reached the relayer, so it is never a refused answer, whatever status it carries.
 * It, and any other failure, leaves every job not yet read 'unread' and is handed back. Reading
 * alone costs one relayer point per job, at most LIMITS.memoryJobConfirmBatch, which fits one
 * pacing window with the first read. `canStart` is asked before every read, and once it says no
 * the jobs not yet read are left 'unread'.
 */
async function readJobs(client: MemoryClient, jobIds: string[], canStart: () => boolean, setupFailures: () => number): Promise<JobReads> {
  if (!canStart()) return { reads: jobIds.map(() => UNREAD) };
  const stopped = (reads: JobRead[], error: unknown, before: number): JobReads => ({
    reads: [...reads, ...jobIds.slice(reads.length).map(() => UNREAD)],
    error,
    unsent: setupFailures() > before,
  });
  let before = setupFailures();
  try {
    const states = await checkJobs(client, jobIds);
    return { reads: jobIds.map((jobId, index) => readOf(states[index], jobId)) };
  } catch (error) {
    if (setupFailures() > before || !refusedAnswer(error)) return stopped([], error, before);
  }
  const reads: JobRead[] = [];
  for (const jobId of jobIds) {
    if (!canStart()) return { reads: [...reads, ...jobIds.slice(reads.length).map(() => UNREAD)] };
    before = setupFailures();
    try {
      const [state] = await checkJobs(client, [jobId]);
      reads.push(readOf(state, jobId));
    } catch (error) {
      if (setupFailures() > before || !refusedAnswer(error)) return stopped(reads, error, before);
      reads.push({ state: 'invalid' });
    }
  }
  return { reads };
}

/**
 * Confirms the owner's sent memories: reads, without locking, up to LIMITS.memoryJobConfirmBatch
 * rows (the relayer's limit of job ids per status call) of this owner that are pending and have a
 * job id, oldest first; reads their jobs with one checkJobs call, or one per job when core refuses
 * that answer, with no transaction open, asking `canStart` before each read; then settles the rows
 * in one short transaction. A job id never changes once stored, and every write there touches only
 * rows still pending, so a pass that ran meanwhile can only make this one's write a no-op.
 *
 * - A done job sets the row's blob id, status 'confirmed' and confirmed_at `now`, unless its
 *   blob id is already on a row or another job in the answer reports it too: then the row is
 *   'failed', as one blob tied to two records could hand a recall hit the wrong facts (C10).
 * - A failed or unknown job, or a job whose own answer fails core's checks (a done job without
 *   a usable blob id), sets status 'failed' on that row only.
 * - A job still working, or one not read, stays as it is until LIMITS.memoryJobMaxAgeMs after
 *   its submitted_at (created_at for a row sent before that was kept), then is 'failed'.
 * Only a confirmed row has a blob id, so only it can be matched to a recall hit. When `canStart`
 * says no before the first read, nothing is read or changed.
 *
 * When the relayer refuses Ellai's delegate key (core's DELEGATE: the owner removed it),
 * nothing is changed and that MemoryError is thrown. A setup step that fails before a read's
 * request goes out, whatever status it carries, is no answer from the relayer: it fails no job,
 * and like any other MemoryError from a read it is thrown after the rows it does not touch are
 * settled as above.
 *
 * Throws MemoryServiceError: BAD_INPUT, OWNER, NO_ACCOUNT (before touching any row);
 * MemoryError from core.
 */
export async function confirmMemoryJobs(args: WriterArgs): Promise<{ confirmed: number; failed: number; pending: number }> {
  const { ownerId } = checkArgs(args);
  const { db, now } = args;
  const canStart = args.canStart ?? (() => true);
  const { client } = await ownerClient(db, ownerId, args.masterSecretHex);
  const setupFailures = watchSetupSteps(client);
  try {
    const sent = await db
      .select({ id: memories.id, jobId: memories.jobId, submittedAt: memories.submittedAt, createdAt: memories.createdAt })
      .from(memories)
      .where(and(eq(memories.ownerId, ownerId), eq(memories.status, 'pending'), isNotNull(memories.jobId)))
      .orderBy(asc(memories.createdAt), asc(memories.id))
      .limit(LIMITS.memoryJobConfirmBatch);
    const rows = sent.flatMap((row) => (row.jobId === null ? [] : [{ ...row, jobId: row.jobId }]));
    if (rows.length === 0) return { confirmed: 0, failed: 0, pending: 0 };
    if (!canStart()) return { confirmed: 0, failed: 0, pending: rows.length };

    const { reads, error, unsent } = await readJobs(
      client,
      rows.map((row) => row.jobId),
      canStart,
      setupFailures,
    );
    if (isKeyRefused(error) && unsent !== true) throw error;

    const pastAge = (row: (typeof rows)[number]) => now.getTime() - (row.submittedAt ?? row.createdAt).getTime() >= LIMITS.memoryJobMaxAgeMs;
    const done: Array<{ id: string; blobId: string }> = [];
    const failed: string[] = [];
    rows.forEach((row, index) => {
      const read = reads[index] ?? UNREAD;
      if (read.state === 'done') done.push({ id: row.id, blobId: read.blobId });
      else if (read.state === 'failed' || read.state === 'invalid' || pastAge(row)) failed.push(row.id);
    });

    const counts = await db.transaction(async (tx) => {
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
      const refused = [...failed, ...done.filter((job) => !confirmed.includes(job)).map((job) => job.id)];

      const unconfirmed = (ids: string[]) => and(inArray(memories.id, ids), eq(memories.status, 'pending'), isNotNull(memories.jobId));
      if (confirmed.length > 0) {
        await tx
          .update(memories)
          .set({ blobId: perRow(confirmed.map((job) => ({ id: job.id, value: job.blobId }))), status: 'confirmed', confirmedAt: now })
          .where(unconfirmed(confirmed.map((job) => job.id)));
      }
      if (refused.length > 0) await tx.update(memories).set({ status: 'failed' }).where(unconfirmed(refused));
      return { confirmed: confirmed.length, failed: refused.length, pending: rows.length - confirmed.length - refused.length };
    });
    if (error !== undefined) throw error;
    return counts;
  } finally {
    client.destroy();
  }
}
