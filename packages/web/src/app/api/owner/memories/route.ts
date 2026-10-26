import { and, desc, eq, lt } from 'drizzle-orm';
import { memories } from '../../../../server/db/schema.js';
import { scoped } from '../../../../server/http/context.js';
import { HttpError } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { PAGE_READ, cutPage, readPageQuery } from '../../../../server/http/owner-limits.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every memory Ellai holds for the signed-in owner, newest first, as { memories, nextBefore },
 * paged exactly as /api/owner/decisions is: ?before=<ISO time>, ?limit= from 1, 20 unless
 * given and never more than 50, and nextBefore null on the last page. Each memory gives its
 * kind ('owner_decision' or 'outcome'), the verdict, recipient, amount and host Ellai
 * recorded, the sentence written to Walrus, its write status, its blob id once Walrus has it,
 * and when it was made and confirmed. Sentences are the owner's own to read: this route is
 * for their session only and nothing here is public (C17, C18). Only this owner's rows are
 * read (C13). 401 signed_out without a session, 400 bad_query for a query readPageQuery
 * refuses. Atomic amounts are decimal strings.
 */
export const GET = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const query = readPageQuery(request);
  if (query === null) throw new HttpError(400, 'bad_query');

  const ownRows = eq(memories.ownerId, ownerId);
  const read = await ctx.db
    .select({
      memoryId: memories.id,
      kind: memories.kind,
      verdict: memories.verdict,
      recipient: memories.recipient,
      amountAtomic: memories.amountAtomic,
      sellerHost: memories.sellerHost,
      sentence: memories.sentence,
      status: memories.status,
      blobId: memories.blobId,
      createdAt: memories.createdAt,
      confirmedAt: memories.confirmedAt,
    })
    .from(memories)
    .where(query.before === null ? ownRows : and(ownRows, lt(memories.createdAt, query.before)))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(PAGE_READ);
  const { rows, nextBefore } = cutPage(read, query.limit);
  return jsonResponse({ memories: rows, nextBefore });
});
