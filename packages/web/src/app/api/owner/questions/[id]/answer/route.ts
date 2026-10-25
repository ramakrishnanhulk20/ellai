import { LIMITS } from '@ellai/core/limits';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { VERDICTS, owners } from '../../../../../../server/db/schema.js';
import { answerQuestion } from '../../../../../../server/decide/answer.js';
import { withServerContext } from '../../../../../../server/http/context.js';
import { HttpError, respond } from '../../../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../../../server/http/origin.js';
import { requireOwner } from '../../../../../../server/http/session.js';
import { ownerDelegate } from '../../../../../../server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../../../../../../server/memory/namespace.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// answerQuestion trims the reason and enforces its length in code points, the way the column
// counts it; the body cap bounds everything before that.
const body = z.strictObject({ answer: z.enum(VERDICTS), reason: z.string().optional() });

/**
 * The owner answers one question: { answer: 'approve' | 'refuse', reason? } in, { memoryId,
 * grantId } out, grantId being null for a refusal. The answer is recorded as an owner
 * decision written by this owner's delegate key in MEMORY_NAMESPACE, and a yes grants exactly
 * the payment that was asked about. The owner comes from the session alone (C13) and the
 * request must come from the app (C14). Another owner's question and a missing one are the
 * same 404 not_found, so a response never shows that an id exists. 403 cross_origin, 401
 * signed_out, 400 for a bad body or id, 409 when already answered or no longer asked.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const { ownerId } = await requireOwner(request, ctx);
      const { id } = await params;
      const { answer, reason } = await readJson(request, body, LIMITS.answerBodyMaxBytes);
      const [owner] = await ctx.db.select({ suiAddress: owners.suiAddress }).from(owners).where(eq(owners.id, ownerId));
      if (owner === undefined) throw new HttpError(401, 'signed_out');
      const { publicKeyHex } = ownerDelegate(ctx.env.ELLAI_MASTER_SECRET, owner.suiAddress);
      const answered = await answerQuestion({
        db: ctx.db,
        ownerId,
        decisionId: id,
        answer,
        reason: reason ?? null,
        delegatePublicKeyHex: publicKeyHex,
        namespace: MEMORY_NAMESPACE,
        now: ctx.now(),
      });
      return jsonResponse(answered);
    }),
  );
}
