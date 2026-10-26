import { STEP_UP_REQUEST_MAX_BYTES, issueStepUp, limitStepUps, stepUpRequest } from '../../../../server/auth/stepup.js';
import { scoped } from '../../../../server/http/context.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Asks the owner's wallet to confirm one loosening change, so a stolen session alone can never
 * make one (C36): { action, change } in, action being create_agent with change { label } as
 * POST /api/owner/agents takes it, or loosen_settings with change as PATCH /api/owner/settings
 * takes it; { nonce, message, expiresAt } out. The wallet signs the message as a Sui personal
 * message, and the route that applies the change takes { nonce, signature } as its stepUp, once,
 * within LIMITS.stepUpTtlMs, for exactly that change (issueStepUp, claimStepUp). Each call counts
 * toward the owner's LIMITS.stepUpsPerOwnerPerHour before the body is read (C22). The owner comes
 * from the session alone (C13) and the request must come from the app (C14). 403 cross_origin,
 * 401 signed_out, 429 too_many_step_ups, 400 for a bad body or label, 400 out_of_bounds for a
 * setting outside its bounds, 400 step_up_not_needed for a settings change that loosens nothing.
 */
export const POST = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const now = ctx.now();
  await limitStepUps(ctx.db, ownerId, now);
  const asked = await readJson(request, stepUpRequest, STEP_UP_REQUEST_MAX_BYTES);
  return jsonResponse(await issueStepUp({ db: ctx.db, ownerId, appOrigin: ctx.env.APP_ORIGIN, request: asked, now }));
});
