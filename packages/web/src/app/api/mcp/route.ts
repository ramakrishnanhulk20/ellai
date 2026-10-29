import { scoped } from '../../../server/http/context.js';
import { API_RESPONSE_HEADERS } from '../../../server/http/errors.js';
import { scheduleOwnerVisit } from '../../../server/jobs/visit.js';
import { type AgentFetchAnswer, handleMcpRequest } from '../../../server/mcp/server.js';

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
 * per-minute limits' too_many_requests included. A request in which paid_fetch answered,
 * whatever its outcome, schedules one visit for the agent's owner after the response, as POST
 * /api/agent/fetch does (scheduleOwnerVisit, C40); it never changes the response.
 */
export const POST = scoped('agent', async (request, ctx, agent): Promise<Response> => {
  const requestStartedMs = Date.now();
  const answered = await handleMcpRequest(request, ctx, agent);
  if (await paidFetchAnswered(answered)) scheduleOwnerVisit(agent.ownerId, 'agent', requestStartedMs);
  return answered;
});

const PAID_FETCH_MARK: keyof AgentFetchAnswer = 'sellerBodyIsUntrusted';

// The route sees only the JSON-RPC answer. A tool's result is its answer as JSON text, and of the
// two tools only paid_fetch's answer carries sellerBodyIsUntrusted: true (C17), at its top level,
// where a seller's text cannot reach, and only when the pay flow returned; its failures are
// results with isError. That is the same test POST /api/agent/fetch makes. Anything that does not
// parse is no answer.
async function paidFetchAnswered(answered: Response): Promise<boolean> {
  if (answered.status !== 200) return false;
  let body: unknown;
  try {
    body = await answered.clone().json();
  } catch {
    return false;
  }
  return (Array.isArray(body) ? body : [body]).some((message: unknown) => {
    const result = (message as { result?: { isError?: unknown; content?: unknown } } | null)?.result;
    if (result === undefined || result.isError === true || !Array.isArray(result.content)) return false;
    return result.content.some((part: unknown) => {
      const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
      if (type !== 'text' || typeof text !== 'string') return false;
      try {
        return (JSON.parse(text) as Record<string, unknown> | null)?.[PAID_FETCH_MARK] === true;
      } catch {
        return false;
      }
    });
  });
}

// A stateless server keeps no session to stream to or to end, so GET's event stream and
// DELETE's session end do not exist here. The body is the JSON-RPC error the SDK itself sends.
function methodNotAllowed(): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  return new Response(body, { status: 405, headers: { ...API_RESPONSE_HEADERS, allow: 'POST', 'content-type': 'application/json' } });
}

/** 405: this server is stateless, so there is no event stream to open. */
export const GET = scoped('anyone', (): Response => methodNotAllowed());

/** 405: this server is stateless, so there is no session to end. */
export const DELETE = scoped('anyone', (): Response => methodNotAllowed());
