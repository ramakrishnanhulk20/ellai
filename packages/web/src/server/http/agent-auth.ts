import { LIMITS } from '@ellai/core/limits';
import { authenticateAgent } from '../auth/agents.js';
import type { Database } from '../db/client.js';
import { clientKey } from './client.js';
import type { ServerContext } from './context.js';
import { HttpError, TOO_MANY_REQUESTS, toErrorResponse, tooManyRequestsResponse } from './errors.js';
import { consume, consumeShared, consumeWindow } from './ratelimit.js';
import { currentTatumScope } from './tatum-meter.js';

// RFC 6750's credentials: the scheme, which RFC 9110 makes case-insensitive, one or more
// spaces, then one token with no spaces in it. Two Authorization headers arrive joined by a
// comma and a space, so they never match and the request is refused.
const BEARER = /^bearer +(\S+)$/i;
const AGENT_PAY_CLIENT_DAY_PREFIX = 'agent-pay-client-day:';
const AGENT_PAY_QUOTA = 'agent-pay:day';

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
 * Counts one paid fetch, each of which writes a decision row, against four limits, in this order,
 * stopping at the first one passed so a caller past its own limit spends nothing after it (C22,
 * C34):
 * - LIMITS.agentCallsPerMinute for this agent, then LIMITS.ownerPayRequestsPerMinute for its
 *   owner, in the fixed minute that holds `now`, keyed on the ids authentication gave, which the
 *   caller cannot choose. Every agent of the owner shares the owner's count, whether it calls over
 *   HTTP, MCP or is the built-in agent (C16). Past either: AgentLimitError.
 * - LIMITS.agentFetchesPerClientPerDay for the client, in the fixed UTC day that holds `now`,
 *   however many free wallets and agent tokens it holds. The client is the key of the Tatum person
 *   scope the request runs in, which every agent route and the built-in agent's owner route enter
 *   with the address the platform vouches for (clientKey); outside such a scope it is the key of a
 *   client the platform did not vouch for, so such calls share one count. Past it: HttpError 429
 *   rate_limited_today.
 * - LIMITS.agentFetchesPerDayGlobal for every agent together in that day, so standing decision
 *   rows stay a bounded number however many clients ask. Past it: HttpError 503
 *   busy_today, Ellai's own day being spent rather than the caller's.
 * A request over a limit still counts toward it. Each day refusal logs a fixed code; the shared
 * day logs its name once, at its first refusal in a day.
 */
export async function limitAgentFetch(db: Database, agent: { ownerId: string; agentId: string }, now: Date): Promise<void> {
  await withinLimit(db, `agent:paid-fetch:${agent.agentId.toLowerCase()}`, LIMITS.agentCallsPerMinute, now, 'agent_pay');
  await withinLimit(db, `owner-pay:${agent.ownerId.toLowerCase()}`, LIMITS.ownerPayRequestsPerMinute, now, 'owner_pay');
  const scope = currentTatumScope();
  const client = scope?.kind === 'person' ? scope.clientKey : clientKey(undefined);
  if (!(await consumeWindow(db, `${AGENT_PAY_CLIENT_DAY_PREFIX}${client}`, LIMITS.agentFetchesPerClientPerDay, LIMITS.rateWindowDayMs, now))) {
    console.warn('[ellai http] agent_pay_client rate_limited_today');
    throw new HttpError(429, 'rate_limited_today');
  }
  const turn = await consumeShared(db, AGENT_PAY_QUOTA, LIMITS.agentFetchesPerDayGlobal, LIMITS.rateWindowDayMs, now);
  if (turn.allowed) return;
  if (turn.firstRefusal) console.error(`[ellai http] quota_spent ${AGENT_PAY_QUOTA}`);
  throw new HttpError(503, 'busy_today');
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
