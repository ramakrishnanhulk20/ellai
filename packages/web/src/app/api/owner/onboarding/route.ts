import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { requireOwner } from '../../../../server/http/session.js';
import { onboardingState } from '../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How far the signed-in owner is through onboarding, as onboardingState gives it: { memoryAccount,
 * delegate, allowance } each 'missing' or 'present', and the purse address. Read from the owner
 * row alone, so it costs no chain read; a present step is what Ellai verified on chain when the
 * owner confirmed it. The owner comes from the session alone (C13); 401 signed_out without one.
 */
export async function GET(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const { ownerId } = await requireOwner(request, ctx);
      return jsonResponse(await onboardingState({ db: ctx.db, ownerId }));
    }),
  );
}
