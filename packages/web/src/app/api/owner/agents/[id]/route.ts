import { revokeAgent } from '../../../../../server/auth/agents.js';
import { scoped } from '../../../../../server/http/context.js';
import { jsonResponse } from '../../../../../server/http/json.js';

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
export const DELETE = scoped('owner', async (_request, ctx, { ownerId }, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
  const { id } = await params;
  await revokeAgent({ db: ctx.db, ownerId, agentId: id, now: ctx.now() });
  return jsonResponse({ revoked: true });
});
