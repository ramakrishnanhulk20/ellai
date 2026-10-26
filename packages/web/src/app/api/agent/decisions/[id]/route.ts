import { scoped } from '../../../../../server/http/context.js';
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
 * agent_unauthorized without a valid token, 429 too_many_requests past
 * LIMITS.agentDecisionReadsPerMinute for this agent, shared with check_decision.
 */
export const GET = scoped('agent', async (_request, ctx, agent, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
  const { id } = await params;
  return jsonResponse(await agentDecision(ctx, agent, id));
});
