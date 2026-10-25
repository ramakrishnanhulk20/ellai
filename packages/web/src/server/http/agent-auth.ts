import { LIMITS } from '@ellai/core/limits';
import { authenticateAgent } from '../auth/agents.js';
import type { Database } from '../db/client.js';
import type { ServerContext } from './context.js';
import { HttpError } from './errors.js';
import { consume } from './ratelimit.js';

// RFC 6750's credentials: the scheme, which RFC 9110 makes case-insensitive, one or more
// spaces, then one token with no spaces in it. Two Authorization headers arrive joined by a
// comma and a space, so they never match and the request is refused.
const BEARER = /^bearer +(\S+)$/i;

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

/**
 * Counts one paid fetch for this agent in the fixed minute that holds `now`, over HTTP and MCP
 * together, keyed on the authenticated agent id, which the caller cannot choose (C22).
 * Throws HttpError 429 rate_limited past LIMITS.agentCallsPerMinute.
 */
export async function limitAgentFetch(db: Database, agentId: string, now: Date): Promise<void> {
  if (!(await consume(db, `agent:paid-fetch:${agentId}`, LIMITS.agentCallsPerMinute, now))) throw new HttpError(429, 'rate_limited');
}
