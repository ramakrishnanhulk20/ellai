import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { agents, decisionCitations, decisions, memories, payments } from '../../../../server/db/schema.js';
import { scoped } from '../../../../server/http/context.js';
import { HttpError } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { PAGE_READ, cutPage, readPageQuery } from '../../../../server/http/owner-limits.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Every digest here is one Ellai computed from bytes it signed (C8). It is still encoded, so
// the link can only ever name a transaction page on the explorer.
const EXPLORER_TX = 'https://suiscan.xyz/mainnet/tx/';

/**
 * The signed-in owner's decisions, newest first, as { decisions, nextBefore }. ?before=<ISO
 * time> keeps those created strictly before it and ?limit= sets the page size, 20 unless
 * given and never more than 50 (see cutPage for how a page ends). nextBefore is the before
 * for the next page, or null on the last. Each decision keeps Ellai's facts apart from the
 * agent's words (C15, C17): `payment` is the canonical recipient, amount and host Ellai
 * parsed; `agent` is the agent's id and the label the owner gave it; `purpose` is the
 * agent's own text and must be shown as quoted text; `outcome`, `rule`, `reason` and
 * `status` are Ellai's; `answer` ('approve' or 'refuse') and `answeredAt` say what the owner
 * said to Ellai's question and when, from the owner_decision memory Ellai wrote for this
 * decision, or both null when there is none, and never the owner's reason or the memory
 * sentence (C17); `citedMemories` names the memories it cited; and `paid` is the
 * payment Ellai signed for it, with its settlement and an explorer link, or null when there
 * is none. Only this owner's rows are read (C13). 401 signed_out without a session, 400
 * bad_query for a query readPageQuery refuses. Atomic amounts are decimal strings.
 */
export const GET = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const query = readPageQuery(request);
  if (query === null) throw new HttpError(400, 'bad_query');

  const ownRows = eq(decisions.ownerId, ownerId);
  const read = await ctx.db
    .select({
      decisionId: decisions.id,
      createdAt: decisions.createdAt,
      agentId: agents.id,
      agentLabel: agents.label,
      recipient: decisions.recipient,
      amountAtomic: decisions.amountAtomic,
      sellerHost: decisions.sellerHost,
      purpose: decisions.purpose,
      outcome: decisions.outcome,
      rule: decisions.rule,
      reason: decisions.reason,
      status: decisions.status,
      digest: payments.digest,
      settlement: payments.settlement,
    })
    .from(decisions)
    .innerJoin(agents, and(eq(agents.id, decisions.agentId), eq(agents.ownerId, decisions.ownerId)))
    .leftJoin(payments, and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId)))
    .where(query.before === null ? ownRows : and(ownRows, lt(decisions.createdAt, query.before)))
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(PAGE_READ);
  const { rows, nextBefore } = cutPage(read, query.limit);

  // Each decision cites at most LIMITS.decideMaxCitedMemories memories, so one page reads
  // at most LIMITS.ownerPageMax times that many citation rows.
  const decisionIds = rows.map((row) => row.decisionId);
  const cited =
    decisionIds.length === 0
      ? []
      : await ctx.db
          .select({ decisionId: decisionCitations.decisionId, memoryId: memories.id, blobId: memories.blobId })
          .from(decisionCitations)
          .innerJoin(memories, and(eq(memories.id, decisionCitations.memoryId), eq(memories.ownerId, decisionCitations.ownerId)))
          .where(and(eq(decisionCitations.ownerId, ownerId), inArray(decisionCitations.decisionId, decisionIds)))
          .orderBy(asc(memories.createdAt), asc(memories.id));
  const citedBy = new Map<string, Array<{ memoryId: string; blobId: string | null }>>();
  for (const { decisionId, memoryId, blobId } of cited) {
    const list = citedBy.get(decisionId) ?? [];
    list.push({ memoryId, blobId });
    citedBy.set(decisionId, list);
  }

  // answerQuestion writes one owner_decision memory per decision, under the question's lock and
  // only while it is unanswered, so this reads at most one row per decision on the page. Only the
  // verdict and its time are read: the sentence holds the owner's reason and the agent's purpose
  // in Ellai's own words, which stay on the memories route (C17).
  const answered =
    decisionIds.length === 0
      ? []
      : await ctx.db
          .select({ decisionId: memories.decisionId, verdict: memories.verdict, createdAt: memories.createdAt })
          .from(memories)
          .where(and(eq(memories.ownerId, ownerId), eq(memories.kind, 'owner_decision'), inArray(memories.decisionId, decisionIds)))
          .orderBy(asc(memories.createdAt), asc(memories.id));
  const answerOf = new Map<string, { answer: 'approve' | 'refuse'; answeredAt: Date }>();
  for (const { decisionId, verdict, createdAt } of answered) {
    // The first answer is the one that bound the decision, should a second ever exist.
    if (decisionId !== null && verdict !== null && !answerOf.has(decisionId)) answerOf.set(decisionId, { answer: verdict, answeredAt: createdAt });
  }

  return jsonResponse({
    decisions: rows.map((row) => ({
      decisionId: row.decisionId,
      createdAt: row.createdAt,
      agent: { id: row.agentId, label: row.agentLabel },
      payment: { recipient: row.recipient, amountAtomic: row.amountAtomic, sellerHost: row.sellerHost },
      purpose: row.purpose,
      outcome: row.outcome,
      rule: row.rule,
      reason: row.reason,
      status: row.status,
      answer: answerOf.get(row.decisionId)?.answer ?? null,
      answeredAt: answerOf.get(row.decisionId)?.answeredAt ?? null,
      citedMemories: citedBy.get(row.decisionId) ?? [],
      paid:
        row.digest === null || row.settlement === null
          ? null
          : { digest: row.digest, settlement: row.settlement, explorerUrl: `${EXPLORER_TX}${encodeURIComponent(row.digest)}` },
    })),
    nextBefore,
  });
});
