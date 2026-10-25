import { revokeAgent } from '../../../../../server/auth/agents.js';
import { withServerContext } from '../../../../../server/http/context.js';
import { respond } from '../../../../../server/http/errors.js';
import { jsonResponse } from '../../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../../server/http/origin.js';
import { requireOwner } from '../../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Revokes one of the signed-in owner's agents, answering { revoked: true }. From that moment
 * authenticateAgent refuses its token, so no route that takes agent tokens accepts it (C13).
 * Revoking an agent already revoked succeeds and keeps the first time.
 * Another owner's agent and a missing one are the same 404 not_found, so the answer never
 * shows that an id exists. The request must come from the app (C14). 403 cross_origin, 401
 * signed_out, 400 bad_input for an id that is not a uuid.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const { ownerId } = await requireOwner(request, ctx);
      const { id } = await params;
      await revokeAgent({ db: ctx.db, ownerId, agentId: id, now: ctx.now() });
      return jsonResponse({ revoked: true });
    }),
  );
}
