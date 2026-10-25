import { LIMITS } from '@ellai/core/limits';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { agents, decisionCitations, decisions, memories, questions } from '../../../../server/db/schema.js';
import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { requireOwner } from '../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in owner's unanswered questions whose decisions are still 'asked', newest first,
 * at most LIMITS.questionsPerPage, as { questions }. Each decision cites at most
 * LIMITS.decideMaxCitedMemories memories, so a page reads a bounded number of citation rows.
 * Each question keeps what Ellai checked apart from what the agent wrote (C15, C17): `payment`
 * holds the canonical recipient, amount, asset, network and host Ellai parsed; `agent` holds the agent's id and the label the owner gave it; `purpose` is the
 * agent's own text and must be shown as quoted text; `rule` and `reason` are Ellai's; and
 * `citedMemories` names the memories the decision cited. Only this owner's rows are read
 * (C13); 401 signed_out without a session.
 */
export async function GET(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const { ownerId } = await requireOwner(request, ctx);
      const rows = await ctx.db
        .select({
          decisionId: decisions.id,
          askedAt: questions.createdAt,
          recipient: decisions.recipient,
          amountAtomic: decisions.amountAtomic,
          asset: decisions.asset,
          network: decisions.network,
          sellerHost: decisions.sellerHost,
          agentId: agents.id,
          agentLabel: agents.label,
          purpose: decisions.purpose,
          rule: decisions.rule,
          reason: decisions.reason,
        })
        .from(questions)
        .innerJoin(decisions, and(eq(decisions.id, questions.decisionId), eq(decisions.ownerId, questions.ownerId)))
        .innerJoin(agents, and(eq(agents.id, decisions.agentId), eq(agents.ownerId, decisions.ownerId)))
        .where(and(eq(questions.ownerId, ownerId), isNull(questions.answeredAt), eq(decisions.status, 'asked')))
        .orderBy(desc(questions.createdAt), desc(questions.decisionId))
        .limit(LIMITS.questionsPerPage);

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

      return jsonResponse({
        questions: rows.map((row) => ({
          decisionId: row.decisionId,
          askedAt: row.askedAt,
          payment: { recipient: row.recipient, amountAtomic: row.amountAtomic, asset: row.asset, network: row.network, sellerHost: row.sellerHost },
          agent: { id: row.agentId, label: row.agentLabel },
          purpose: row.purpose,
          rule: row.rule,
          reason: row.reason,
          citedMemories: citedBy.get(row.decisionId) ?? [],
        })),
      });
    }),
  );
}
