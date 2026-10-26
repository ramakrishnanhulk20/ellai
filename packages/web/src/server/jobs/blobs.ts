import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { type SQL, and, asc, count, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
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

function cachedWalrusEpoch(chain: Chain, now: Date): number | null {
  const kept = walrusEpochs.get(chain);
  const age = kept === undefined ? -1 : now.getTime() - kept.readAtMs;
  return kept !== undefined && age >= 0 && age < LIMITS.walrusEpochCacheMs ? kept.epoch : null;
}

async function currentWalrusEpoch(chain: Chain, now: Date): Promise<number> {
  const kept = cachedWalrusEpoch(chain, now);
  if (kept !== null) return kept;
  const epoch = await chain.getWalrusEpoch();
  walrusEpochs.set(chain, { epoch, readAtMs: now.getTime() });
  return epoch;
}

/** A memory found on chain, with the end epoch its Blob was stored until, that has not been seen to expire. */
const storedOnChain = and(isNotNull(memories.chainConfirmedAt), isNull(memories.chainExpiredAt), isNotNull(memories.blobEndEpoch));

/**
 * A memory found on chain whose Blob's end epoch is at or below `walrusEpoch`, and so no longer
 * stored by Walrus, not yet marked expired. The jobs tick reads the same condition to decide
 * whether an owner has expiry work.
 */
export function chainExpiring(walrusEpoch: number): SQL | undefined {
  return and(storedOnChain, lte(memories.blobEndEpoch, walrusEpoch));
}

/**
 * A memory found on chain before blob_end_epoch was kept (migration 0004), so it cannot expire
 * until a scan fills its end epoch in. The jobs tick reads the same condition to decide whether
 * an owner has backfill work.
 */
export const lackingEndEpoch = and(isNotNull(memories.chainConfirmedAt), isNull(memories.chainExpiredAt), isNull(memories.blobEndEpoch));

/**
 * The current Walrus epoch, through the same hourly reading confirmBlobsOnChain uses, when some
 * memory is stored on chain and could expire; null, with nothing read, when none is (C22). Throws
 * ChainError from the read.
 */
export async function walrusEpochForExpiry(db: Database, chain: Chain, now: Date): Promise<number | null> {
  const [stored] = await db.select({ id: memories.id }).from(memories).where(storedOnChain).limit(1);
  return stored === undefined ? null : currentWalrusEpoch(chain, now);
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
 * relayer's word alone, nor for one Walrus no longer keeps, and stores that end epoch, the latest
 * among the Blob objects read that carry the id, as blob_end_epoch for expireBlobsOnChain. Every
 * memory still without chain_confirmed_at and confirmed between LIMITS.blobChainCheckMinAgeMs and
 * LIMITS.blobChainCheckMaxAgeMs before `now` (awaitingChainCheck) is matched against every page
 * read, however many are waiting; the pages bound the work.
 *
 * The same pages fill blob_end_epoch in for this owner's memories found on chain before it was
 * kept (lackingEndEpoch), from the latest end among the certified Blob objects carrying the id,
 * expired or not, so expireBlobsOnChain can then retire them. When this one call read the whole
 * listing, from the top to its end with no failure, a memory still lacking an end epoch is on no
 * certified Blob object the owner holds, so Walrus stores nothing for the owner under that id:
 * chain_expired_at is set to `now` (C18). A listing read across calls proves no absence. With
 * nothing waiting and nothing to fill in, nothing is read from Tatum (C21).
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
 * Returns how many memories were waiting and how many were found. Throws for an owner id that is
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
  const waitingHere = and(eq(memories.ownerId, ownerId), awaitingChainCheck(now));
  const lackingHere = and(eq(memories.ownerId, ownerId), lackingEndEpoch);
  const [counted] = await db.select({ n: count() }).from(memories).where(waitingHere);
  const waiting = counted?.n ?? 0;
  const [lacking] = await db.select({ id: memories.id }).from(memories).where(lackingHere).limit(1);
  if ((waiting === 0 && lacking === undefined) || !canStart()) return { checked: 0, confirmed: 0 };

  const epoch = await currentWalrusEpoch(chain, now);
  // Blob id to the latest end epoch among the certified Blob objects that carry it, and among
  // those still unexpired, the only ones that can confirm a memory.
  const held = new Map<string, number>();
  const live = new Map<string, number>();
  const fromTop = owner.cursor === null || owner.cursor === '';
  let next = fromTop ? null : owner.cursor;
  let reachedEnd = false;
  let failure: unknown;
  try {
    for (let page = 0; page < LIMITS.blobScanPagesPerTick && canStart(); page++) {
      const scan = await chain.scanOwnedWalrusBlobs(owner.suiAddress, { after: next, maxPages: 1 });
      for (const blob of scan.blobs) {
        if (blob.certifiedEpoch === null) continue;
        held.set(blob.blobId, Math.max(blob.endEpoch, held.get(blob.blobId) ?? 0));
        if (blob.endEpoch > epoch) live.set(blob.blobId, Math.max(blob.endEpoch, live.get(blob.blobId) ?? 0));
      }
      next = scan.next;
      if (next === null) {
        reachedEnd = true;
        break;
      }
    }
  } catch (error) {
    failure = error;
    if (error instanceof ChainError && !error.retryable) next = null;
  }

  const endsOf = (ends: Map<string, number>) =>
    sql`case ${memories.blobId} ${sql.join(
      [...ends].map(([blobId, endEpoch]) => sql`when ${blobId} then ${endEpoch}::integer`),
      sql` `,
    )} end`;
  const confirmed = await db.transaction(async (tx) => {
    await tx.update(owners).set({ blobScanCursor: next }).where(eq(owners.id, ownerId));
    if (lacking !== undefined && held.size > 0) {
      await tx
        .update(memories)
        .set({ blobEndEpoch: endsOf(held) })
        .where(and(lackingHere, inArray(memories.blobId, [...held.keys()])));
    }
    if (lacking !== undefined && fromTop && reachedEnd) await tx.update(memories).set({ chainExpiredAt: now }).where(lackingHere);
    if (live.size === 0) return 0;
    const marked = await tx
      .update(memories)
      .set({ chainConfirmedAt: now, blobEndEpoch: endsOf(live) })
      .where(and(waitingHere, inArray(memories.blobId, [...live.keys()])))
      .returning({ id: memories.id });
    return marked.length;
  });
  if (failure !== undefined) throw failure;
  return { checked: waiting, confirmed };
}

/**
 * C18: sets chain_expired_at to `now` on this owner's memories found on chain whose Blob's end
 * epoch is at or below the current Walrus epoch (chainExpiring), at most LIMITS.blobConfirmBatch
 * per call, earliest end first, so /proof stops showing a memory Walrus no longer stores. The end
 * epoch is the one confirmBlobsOnChain saw; a Blob extended since then is counted expired early,
 * which can only hide a memory, never show one. Nothing is read unless the owner has a memory
 * stored on chain, and then only the Walrus epoch, through the hourly reading the jobs tick and
 * confirmBlobsOnChain share; with that reading stale, `canStart` is asked first. Returns how many
 * it marked. Throws for an owner id that is not a uuid or a time that is not a date, and
 * ChainError from the read.
 */
export async function expireBlobsOnChain(args: BlobConfirmArgs): Promise<{ expired: number }> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new Error('the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, chain, now } = args;
  const canStart = args.canStart ?? (() => true);
  const ownerId = args.ownerId.toLowerCase();

  const [stored] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), storedOnChain))
    .limit(1);
  if (stored === undefined) return { expired: 0 };
  const epoch = cachedWalrusEpoch(chain, now) ?? (canStart() ? await currentWalrusEpoch(chain, now) : null);
  if (epoch === null) return { expired: 0 };
  const expiringHere = and(eq(memories.ownerId, ownerId), chainExpiring(epoch));
  const due = db.select({ id: memories.id }).from(memories).where(expiringHere).orderBy(asc(memories.blobEndEpoch), asc(memories.id)).limit(LIMITS.blobConfirmBatch);
  const marked = await db
    .update(memories)
    .set({ chainExpiredAt: now })
    .where(and(expiringHere, inArray(memories.id, due)))
    .returning({ id: memories.id });
  return { expired: marked.length };
}
