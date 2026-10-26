import { scoped } from '../../../../server/http/context.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { onboardingState } from '../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How far the signed-in owner is through onboarding, as onboardingState gives it: { memoryAccount,
 * delegate, allowance } each 'missing' or 'present', and the purse address. Read from the owner
 * row alone, so it costs no chain read; a present step is what Ellai verified on chain when the
 * owner confirmed it. The owner comes from the session alone (C13); 401 signed_out without one.
 */
export const GET = scoped('owner', async (_request, ctx, { ownerId }): Promise<Response> => {
  return jsonResponse(await onboardingState({ db: ctx.db, ownerId }));
});
