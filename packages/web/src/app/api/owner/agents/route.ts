import { LIMITS } from '@ellai/core/limits';
import { createAgentToken, listAgents } from '../../../../server/auth/agents.js';
import { STEP_UP_PROOF_MAX_BYTES, agentCreate, agentLabel, claimStepUp } from '../../../../server/auth/stepup.js';
import { scoped } from '../../../../server/http/context.js';
import { HttpError } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';
import { limitAgentCreates } from '../../../../server/http/owner-limits.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in owner's agents, revoked ones included, oldest first, as { agents }: each
 * one's id, label, kind, display prefix, and when it was made and revoked. Neither a token
 * nor its hash is ever read here (C13, C19). 401 signed_out without a session.
 */
export const GET = scoped('owner', async (_request, ctx, { ownerId }): Promise<Response> => {
  return jsonResponse({ agents: await listAgents({ db: ctx.db, ownerId }) });
});

/**
 * Makes an external agent for the signed-in owner: { label, stepUp } in, the label 1 to 60
 * characters with no control characters, { agentId, token, displayPrefix } out. This response is
 * the only place the token ever appears: Ellai keeps only its hash, so it cannot be shown again.
 * An agent key can spend up to the daily budget, so the session alone is not enough: stepUp is
 * { nonce, signature } from POST /api/owner/step-up for create_agent with this label, signed by the
 * owner's wallet, and it is spent before the agent is made (claimStepUp, C36). The owner comes from
 * the session alone (C13) and the request must come from the app (C14). Each call counts toward
 * the owner's LIMITS.agentCreatesPerHour before the body is read (C22), and an owner holds at
 * most LIMITS.agentsPerOwnerMax agents that are not revoked. 403 cross_origin, 401 signed_out,
 * 429 too_many_agent_creates, 400 for a bad body or label, 403 step_up_required with no stepUp,
 * 401 step_up_rejected for one that is unknown, used, expired, another owner's, for another
 * change or badly signed, 409 too_many_agents.
 */
export const POST = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  await limitAgentCreates(ctx, ownerId);
  const { label, stepUp } = await readJson(request, agentCreate, LIMITS.agentLabelBodyMaxBytes + STEP_UP_PROOF_MAX_BYTES);
  const change = { label: agentLabel(label) };
  if (stepUp === undefined) throw new HttpError(403, 'step_up_required');
  const now = ctx.now();
  await claimStepUp({ db: ctx.db, ownerId, request: { action: 'create_agent', change }, proof: stepUp, zkLoginClient: ctx.chain.grpc, now });
  const created = await createAgentToken({ db: ctx.db, ownerId, label: change.label, kind: 'external', sessionSecretHex: ctx.env.SESSION_SECRET, now });
  // Named here as well as in the shared headers, so the one response holding a bearer
  // token stays out of every cache even if those defaults ever change.
  return jsonResponse(created, { headers: { 'cache-control': 'no-store' } });
});
