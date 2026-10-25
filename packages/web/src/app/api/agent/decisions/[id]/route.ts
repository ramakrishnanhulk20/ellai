import { requireAgent } from '../../../../../server/http/agent-auth.js';
import { withServerContext } from '../../../../../server/http/context.js';
import { respond } from '../../../../../server/http/errors.js';
import { jsonResponse } from '../../../../../server/http/json.js';
import { agentDecision } from '../../../../../server/mcp/server.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One decision Ellai made for this agent: { decisionId, status, outcome, rule, reason,
 * retryAllowed }, the same as the check_decision tool on /api/mcp. retryAllowed is true when
 * the owner approved and an unused, unexpired grant for this agent exists: fetch again with the
 * same request, and the grant pays once.
 * Only the agent that made the decision can read it (C13): another agent's decision, even the
 * same owner's, a missing one and a malformed id are the same 404 not_found. 401
 * agent_unauthorized without a valid token.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const agent = await requireAgent(request, ctx);
      const { id } = await params;
      return jsonResponse(await agentDecision(ctx, agent, id));
    }),
  );
}
