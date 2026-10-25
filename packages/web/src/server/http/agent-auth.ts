import { LIMITS } from '@ellai/core/limits';
import { authenticateAgent } from '../auth/agents.js';
import type { Database } from '../db/client.js';
import type { ServerContext } from './context.js';
import { HttpError, TOO_MANY_REQUESTS, toErrorResponse, tooManyRequestsResponse } from './errors.js';
import { consume } from './ratelimit.js';

// RFC 6750's credentials: the scheme, which RFC 9110 makes case-insensitive, one or more
// spaces, then one token with no spaces in it. Two Authorization headers arrive joined by a
// comma and a space, so they never match and the request is refused.
const BEARER = /^bearer +(\S+)$/i;

/**
 * An agent, or the owner it acts for, is past one of its per-minute limits (C22). The message
 * is fixed text. respondToAgent answers it with agentLimitResponse; the MCP tools and the
 * built-in agent catch it themselves.
 */
export class AgentLimitError extends Error {
  constructor() {
    super(TOO_MANY_REQUESTS.message);
    this.name = 'AgentLimitError';
  }
}

/** The answer to an AgentLimitError: errors.ts's 429 with its one too_many_requests body. */
export function agentLimitResponse(): Response {
  return tooManyRequestsResponse();
}

/**
 * The credential in a request's `Authorization: Bearer <value>` header, or undefined when the
 * header is missing, uses another scheme, or is not exactly one bearer value. Never throws.
 */
export function readBearer(request: Request): string | undefined {
  return BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
}

/**
 * The agent a request acts for, and that agent's owner, from its bearer token alone (C13).
 * authenticateAgent accepts only an active agent token and reads the owner from the agent's
 * own row, so nothing in the path, query or body can name another owner. A missing header,
 * another scheme, a session token, an unknown or a revoked token are all the same 401
 * agent_unauthorized, so the answer says nothing about which it was.
 */
export async function requireAgent(request: Request, ctx: ServerContext): Promise<{ ownerId: string; agentId: string }> {
  const agent = await authenticateAgent({ db: ctx.db, token: readBearer(request), sessionSecretHex: ctx.env.SESSION_SECRET });
  if (agent === null) throw new HttpError(401, 'agent_unauthorized');
  return agent;
}

// A request over the limit still counts, so hammering does not reset anything.
async function withinLimit(db: Database, key: string, perMinute: number, now: Date, logName: string): Promise<void> {
  if (await consume(db, key, perMinute, now)) return;
  console.warn(`[ellai http] ${logName} too_many_requests`);
  throw new AgentLimitError();
}

/**
 * Counts one paid fetch for this agent and for its owner in the fixed minute that holds `now`,
 * keyed on the ids authentication gave, which the caller cannot choose (C22). Every agent of
 * the owner shares the owner's count, whether it calls over HTTP, MCP or is the built-in agent
 * (C16). The agent's own LIMITS.agentCallsPerMinute is counted first, so an agent already past
 * it cannot spend the LIMITS.ownerPayRequestsPerMinute its siblings share.
 * Throws AgentLimitError past either.
 */
export async function limitAgentFetch(db: Database, agent: { ownerId: string; agentId: string }, now: Date): Promise<void> {
  await withinLimit(db, `agent:paid-fetch:${agent.agentId.toLowerCase()}`, LIMITS.agentCallsPerMinute, now, 'agent_pay');
  await withinLimit(db, `owner-pay:${agent.ownerId.toLowerCase()}`, LIMITS.ownerPayRequestsPerMinute, now, 'owner_pay');
}

/**
 * Counts one decision read for this agent in the fixed minute that holds `now`, over HTTP and
 * MCP together, keyed on the authenticated agent id (C22). Throws AgentLimitError past
 * LIMITS.agentDecisionReadsPerMinute.
 */
export async function limitDecisionRead(db: Database, agentId: string, now: Date): Promise<void> {
  await withinLimit(db, `agent:decision-read:${agentId.toLowerCase()}`, LIMITS.agentDecisionReadsPerMinute, now, 'decision_reads');
}

/**
 * respond, for the routes an agent calls with its token: an AgentLimitError is the fixed 429
 * too_many_requests. Anything else is toErrorResponse's answer, whose 401 agent_unauthorized
 * carries `WWW-Authenticate: Bearer realm="ellai"`. Never throws.
 */
export async function respondToAgent(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgentLimitError) return agentLimitResponse();
    return toErrorResponse(error);
  }
}
