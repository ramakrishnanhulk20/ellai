import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { type SQL, and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { memories, owners } from '../db/schema.js';

export interface BlobConfirmArgs {
  db: Database;
  chain: Chain;
  ownerId: string;
  now: Date;
  /** Asked before each Tatum read: false once the jobs tick's deadline has passed. Always true when left out. */
  canStart?: () => boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kept per chain client, and the server shares one per process, so the epoch costs at most one
// pair of Tatum reads per LIMITS.walrusEpochCacheMs however many owners are checked.
const walrusEpochs = new WeakMap<Chain, { epoch: number; readAtMs: number }>();

async function currentWalrusEpoch(chain: Chain, now: Date): Promise<number> {
  const kept = walrusEpochs.get(chain);
  const age = kept === undefined ? -1 : now.getTime() - kept.readAtMs;
  if (kept !== undefined && age >= 0 && age < LIMITS.walrusEpochCacheMs) return kept.epoch;
  const epoch = await chain.getWalrusEpoch();
  walrusEpochs.set(chain, { epoch, readAtMs: now.getTime() });
  return epoch;
}

/**
 * A memory Walrus Memory confirmed, not yet found on chain, whose confirmed_at is at least
 * LIMITS.blobChainCheckMinAgeMs and at most LIMITS.blobChainCheckMaxAgeMs before `now`, both
 * ends included. The jobs tick reads the same condition to decide whether an owner has blob work.
 */
export function awaitingChainCheck(now: Date): SQL | undefined {
  return and(
    eq(memories.status, 'confirmed'),
    isNotNull(memories.blobId),
    isNull(memories.chainConfirmedAt),
    gte(memories.confirmedAt, new Date(now.getTime() - LIMITS.blobChainCheckMaxAgeMs)),
    lte(memories.confirmedAt, new Date(now.getTime() - LIMITS.blobChainCheckMinAgeMs)),
  );
}

/**
 * C18: sets chain_confirmed_at on this owner's memories that Walrus Memory reported confirmed,
 * once their blob id is on a Walrus Blob object at the owner's address that is certified and
 * whose end epoch is past the current Walrus epoch, so /proof never vouches for a write on the
 * relayer's word alone, nor for one Walrus no longer keeps. Checks at most LIMITS.blobConfirmBatch
 * memories still without chain_confirmed_at, oldest confirmation first, and only those confirmed
 * between LIMITS.blobChainCheckMinAgeMs and LIMITS.blobChainCheckMaxAgeMs before `now`
 * (awaitingChainCheck). With none, nothing is read from Tatum (C21).
 *
 * Anyone can send Blob objects to an address, so the owner's objects are read in stretches: from
 * owners.blob_scan_cursor, one page of chain.scanOwnedWalrusBlobs at a time, at most
 * LIMITS.blobScanPagesPerTick pages, asking `canStart` before each, and the cursor after the last
 * page read is stored, null once the listing ended so the next call starts from the top. A blob
 * id found is proof however many objects the owner holds; the page cap only defers the rest to a
 * later call. The Walrus epoch comes from chain.getWalrusEpoch, at most once per
 * LIMITS.walrusEpochCacheMs per chain client. A Tatum failure keeps what the pages before it found
 * and where they reached, and is then thrown; one that will not clear by itself (a refused
 * cursor, a page of the wrong shape) also sends the next call back to the top, so one bad cursor
 * cannot stop the check for good. A memory not found before the maximum age is never checked
 * again and never shown on /proof.
 *
 * Blob ids are compared as exact text: the relayer and core's scan write the same base64url form
 * of the u256, and any other spelling does not match, which fails closed.
 * Returns how many memories were checked and how many were found. Throws for an owner id that is
 * not a uuid or a time that is not a date, and ChainError from the reads.
 */
export async function confirmBlobsOnChain(args: BlobConfirmArgs): Promise<{ checked: number; confirmed: number }> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new Error('the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, chain, now } = args;
  const canStart = args.canStart ?? (() => true);
  const ownerId = args.ownerId.toLowerCase();

  const [owner] = await db.select({ suiAddress: owners.suiAddress, cursor: owners.blobScanCursor }).from(owners).where(eq(owners.id, ownerId));
  if (owner === undefined) return { checked: 0, confirmed: 0 };
  const waiting = await db
    .select({ id: memories.id, blobId: memories.blobId })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), awaitingChainCheck(now)))
    .orderBy(asc(memories.confirmedAt), asc(memories.id))
    .limit(LIMITS.blobConfirmBatch);
  if (waiting.length === 0 || !canStart()) return { checked: 0, confirmed: 0 };

  const epoch = await currentWalrusEpoch(chain, now);
  const live = new Set<string>();
  let next = owner.cursor === '' ? null : owner.cursor;
  let failure: unknown;
  try {
    for (let page = 0; page < LIMITS.blobScanPagesPerTick && canStart(); page++) {
      const scan = await chain.scanOwnedWalrusBlobs(owner.suiAddress, { after: next, maxPages: 1 });
      for (const blob of scan.blobs) if (blob.certifiedEpoch !== null && blob.endEpoch > epoch) live.add(blob.blobId);
      next = scan.next;
      if (next === null) break;
    }
  } catch (error) {
    failure = error;
    if (error instanceof ChainError && !error.retryable) next = null;
  }

  const found = waiting.flatMap((row) => (row.blobId !== null && live.has(row.blobId) ? [row.id] : []));
  const confirmed = await db.transaction(async (tx) => {
    await tx.update(owners).set({ blobScanCursor: next }).where(eq(owners.id, ownerId));
    if (found.length === 0) return 0;
    const marked = await tx
      .update(memories)
      .set({ chainConfirmedAt: now })
      .where(and(eq(memories.ownerId, ownerId), inArray(memories.id, found), isNull(memories.chainConfirmedAt)))
      .returning({ id: memories.id });
    return marked.length;
  });
  if (failure !== undefined) throw failure;
  return { checked: waiting.length, confirmed };
}
