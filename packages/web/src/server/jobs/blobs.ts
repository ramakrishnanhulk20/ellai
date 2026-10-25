import type { Chain } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { type SQL, and, asc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { memories, owners } from '../db/schema.js';

export interface BlobConfirmArgs {
  db: Database;
  chain: Chain;
  ownerId: string;
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * once their blob id is among the Walrus Blob objects the chain shows at the owner's address,
 * so /proof never vouches for a write on the relayer's word alone. Checks at most
 * LIMITS.blobConfirmBatch memories still without chain_confirmed_at, oldest confirmation
 * first, and only those confirmed between LIMITS.blobChainCheckMinAgeMs and
 * LIMITS.blobChainCheckMaxAgeMs before `now` (awaitingChainCheck), against one listing through
 * chain.listOwnedWalrusBlobs (Tatum GraphQL), made only when there is a memory to check, so an
 * owner with none in that range costs no Tatum credit (C21). A blob id not found leaves its
 * memory for a later call until it passes the maximum age; after that it is never checked
 * again and never shown on /proof.
 * Blob ids are compared as exact text: the relayer and core's listing write the same
 * base64url form of the u256, and any other spelling does not match, which fails closed.
 * Returns how many memories were checked and how many were found. Throws for an owner id
 * that is not a uuid or a time that is not a date, and ChainError from the listing.
 */
export async function confirmBlobsOnChain(args: BlobConfirmArgs): Promise<{ checked: number; confirmed: number }> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new Error('the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, chain, now } = args;
  const ownerId = args.ownerId.toLowerCase();

  const [owner] = await db.select({ suiAddress: owners.suiAddress }).from(owners).where(eq(owners.id, ownerId));
  if (owner === undefined) return { checked: 0, confirmed: 0 };
  const waiting = await db
    .select({ id: memories.id, blobId: memories.blobId })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), awaitingChainCheck(now)))
    .orderBy(asc(memories.confirmedAt), asc(memories.id))
    .limit(LIMITS.blobConfirmBatch);
  if (waiting.length === 0) return { checked: 0, confirmed: 0 };

  const onChain = new Set((await chain.listOwnedWalrusBlobs(owner.suiAddress)).map((blob) => blob.blobId));
  const found = waiting.flatMap((row) => (row.blobId !== null && onChain.has(row.blobId) ? [row.id] : []));
  if (found.length === 0) return { checked: waiting.length, confirmed: 0 };
  const marked = await db
    .update(memories)
    .set({ chainConfirmedAt: now })
    .where(and(eq(memories.ownerId, ownerId), inArray(memories.id, found), isNull(memories.chainConfirmedAt)))
    .returning({ id: memories.id });
  return { checked: waiting.length, confirmed: marked.length };
}
