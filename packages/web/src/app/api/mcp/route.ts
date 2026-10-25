import { requireAgent, respondToAgent } from '../../../server/http/agent-auth.js';
import { withServerContext } from '../../../server/http/context.js';
import { API_RESPONSE_HEADERS } from '../../../server/http/errors.js';
import { handleMcpRequest } from '../../../server/mcp/server.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Seconds this route may run, so the ceiling is Ellai's choice and not the platform's default.
// Next.js reads this export without running the module, so it is written as the literal value of
// LIMITS.slowRouteMaxDurationS, and a test holds the two equal. paid_fetch answers by
// LIMITS.paidFetchDeadlineMs, inside this ceiling.
export const maxDuration = 300;

/**
 * Ellai as an MCP server over Streamable HTTP, stateless: each POST carries one JSON-RPC
 * message or batch and gets plain JSON back. Tools: paid_fetch and check_decision, the same
 * as POST /api/agent/fetch and GET /api/agent/decisions/[id]. The bearer agent token is
 * checked before anything is read (C13); 401 agent_unauthorized without a valid one. A tool
 * failure is a tool result with isError and the same fixed JSON the HTTP routes send, the
 * per-minute limits' too_many_requests included.
 */
export async function POST(request: Request): Promise<Response> {
  return respondToAgent(() =>
    withServerContext(async (ctx) => {
      const agent = await requireAgent(request, ctx);
      return handleMcpRequest(request, ctx, agent);
    }),
  );
}

// A stateless server keeps no session to stream to or to end, so GET's event stream and
// DELETE's session end do not exist here. The body is the JSON-RPC error the SDK itself sends.
function methodNotAllowed(): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  return new Response(body, { status: 405, headers: { ...API_RESPONSE_HEADERS, allow: 'POST', 'content-type': 'application/json' } });
}

/** 405: this server is stateless, so there is no event stream to open. */
export function GET(): Response {
  return methodNotAllowed();
}

/** 405: this server is stateless, so there is no session to end. */
export function DELETE(): Response {
  return methodNotAllowed();
}
