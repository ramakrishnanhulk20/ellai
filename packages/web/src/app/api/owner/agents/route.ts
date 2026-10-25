import { z } from 'zod';
import { createAgentToken, listAgents } from '../../../../server/auth/agents.js';
import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';
import { OWNER_BODY_CAPS, limitAgentCreates } from '../../../../server/http/owner-limits.js';
import { requireSameOrigin } from '../../../../server/http/origin.js';
import { requireOwner } from '../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// createAgentToken trims the label and counts its length in code points, the way the column
// does; the body cap bounds everything before that.
const body = z.strictObject({ label: z.string() });

/**
 * The signed-in owner's agents, revoked ones included, oldest first, as { agents }: each
 * one's id, label, kind, display prefix, and when it was made and revoked. Neither a token
 * nor its hash is ever read here (C13, C19). 401 signed_out without a session.
 */
export async function GET(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const { ownerId } = await requireOwner(request, ctx);
      return jsonResponse({ agents: await listAgents({ db: ctx.db, ownerId }) });
    }),
  );
}

/**
 * Makes an external agent for the signed-in owner: { label } in, 1 to 60 characters with no
 * control characters, { agentId, token, displayPrefix } out. This response is the only place
 * the token ever appears: Ellai keeps only its hash, so it cannot be shown again. The owner
 * comes from the session alone (C13) and the request must come from the app (C14). Each call
 * counts toward the owner's LIMITS.agentCreatesPerHour before the body is read (C22), and an
 * owner holds at most LIMITS.agentsPerOwnerMax agents that are not revoked. 403 cross_origin,
 * 401 signed_out, 429 too_many_agent_creates, 400 for a bad body or label, 409
 * too_many_agents.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const { ownerId } = await requireOwner(request, ctx);
      await limitAgentCreates(ctx, ownerId);
      const { label } = await readJson(request, body, OWNER_BODY_CAPS.agent);
      const created = await createAgentToken({ db: ctx.db, ownerId, label, kind: 'external', sessionSecretHex: ctx.env.SESSION_SECRET, now: ctx.now() });
      // Named here as well as in the shared headers, so the one response holding a bearer
      // token stays out of every cache even if those defaults ever change.
      return jsonResponse(created, { headers: { 'cache-control': 'no-store' } });
    }),
  );
}
