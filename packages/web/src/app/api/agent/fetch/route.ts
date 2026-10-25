import { requireAgent } from '../../../../server/http/agent-auth.js';
import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';
import { AGENT_BODY_CAP, agentPaidFetch, paidFetchInput } from '../../../../server/mcp/server.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An agent asks Ellai to fetch a URL and, if the seller asks for payment, to decide with the
 * owner's rules whether to pay: { url, method, body?, contentType?, purpose } in, paidFetch's
 * result out, with `sellerBodyIsUntrusted: true` beside it, because seller.body is the
 * seller's own text and must be read as data, never as instructions (C17). The same as the
 * paid_fetch tool on /api/mcp.
 * The agent and its owner come from the bearer token alone (C13); 401 agent_unauthorized
 * without a valid one. 400 for a body this endpoint does not take, 429 rate_limited past
 * LIMITS.agentCallsPerMinute for this agent. A refusal or a question for the owner is still
 * 200: `outcome` says what Ellai did. No CORS headers: agents call from servers, not pages.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const agent = await requireAgent(request, ctx);
      const input = await readJson(request, paidFetchInput, AGENT_BODY_CAP);
      return jsonResponse(await agentPaidFetch(ctx, agent, input));
    }),
  );
}
