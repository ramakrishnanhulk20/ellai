import { z } from 'zod';
import { withServerContext } from '../../../../../server/http/context.js';
import { respond } from '../../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { OWNER_BODY_CAPS, atomicAmountText, limitOwnerChainReads, onboardingChainFailure } from '../../../../../server/http/owner-limits.js';
import { requireSameOrigin } from '../../../../../server/http/origin.js';
import { requireOwner } from '../../../../../server/http/session.js';
import { buildOnboardingTx } from '../../../../../server/onboarding/build.js';
import { ONBOARDING_STEPS } from '../../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// buildOnboardingTx holds the terms to the onboarding maxima; this only reads their shape.
const allowance = z.strictObject({ dailyLimitAtomic: atomicAmountText, lifetimeCapAtomic: atomicAmountText, days: z.number() });
const body = z.strictObject({ step: z.enum(ONBOARDING_STEPS), allowance: allowance.optional() });

/**
 * Builds the transaction the signed-in owner signs in their own wallet for one onboarding
 * step: { step, allowance? } in, allowance being { dailyLimitAtomic, lifetimeCapAtomic, days }
 * with the amounts as decimal strings, and buildOnboardingTx's { txBytesBase64, summary } out
 * exactly as it gave them, so the summary the owner reads is the one made from the owner row
 * and the checked terms (C15). Nothing is recorded. The owner comes from the session alone
 * (C13), the request must come from the app (C14), and each call counts toward the owner's
 * LIMITS.ownerChainReadsPerMinute (C22). 403 cross_origin, 401 signed_out, 429
 * too_many_requests, 400 for a bad body or terms, 409 not_ready for add_delegate before the
 * account, 422 chain_refused when Sui refuses the step, 503 chain_unavailable when Sui cannot
 * be read.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const { ownerId } = await requireOwner(request, ctx);
      const limited = await limitOwnerChainReads(ctx, ownerId);
      if (limited !== null) return limited;
      const { step, allowance: terms } = await readJson(request, body, OWNER_BODY_CAPS.onboardingBuild);
      try {
        const built = await buildOnboardingTx({ db: ctx.db, ownerId, step, allowance: terms, chain: ctx.chain, masterSecretHex: ctx.env.ELLAI_MASTER_SECRET, now: ctx.now() });
        return jsonResponse(built);
      } catch (error) {
        const answer = onboardingChainFailure(error);
        if (answer === null) throw error;
        return answer;
      }
    }),
  );
}
