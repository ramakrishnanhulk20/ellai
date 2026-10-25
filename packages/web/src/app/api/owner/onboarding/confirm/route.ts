import { z } from 'zod';
import { TEXT_CAPS } from '../../../../../server/db/schema.js';
import { withServerContext } from '../../../../../server/http/context.js';
import { respond } from '../../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { OWNER_BODY_CAPS, limitOwnerChainReads, onboardingChainFailure } from '../../../../../server/http/owner-limits.js';
import { requireSameOrigin } from '../../../../../server/http/origin.js';
import { requireOwner } from '../../../../../server/http/session.js';
import { confirmOnboardingTx } from '../../../../../server/onboarding/confirm.js';
import { ONBOARDING_STEPS } from '../../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// confirmOnboardingTx decides whether the digest is a Sui digest; this only bounds its length.
const body = z.strictObject({ step: z.enum(ONBOARDING_STEPS), digest: z.string().max(TEXT_CAPS.digest) });

/**
 * Records one onboarding step once Sui shows the owner's transaction did it: { step, digest }
 * in, { recorded } out, recorded being the account id, Ellai's delegate key as hex, or the
 * allowance id, all read from chain by confirmOnboardingTx and never taken from the caller
 * (C7, C8). The owner comes from the session alone (C13), the request must come from the app
 * (C14), and each call counts toward the owner's LIMITS.ownerChainReadsPerMinute (C22). 403
 * cross_origin, 401 signed_out, 429 too_many_requests, 400 for a bad body or digest, 409
 * not_ready or not_landed (ask again shortly), 422 refused when the chain shows something the
 * step does not accept, 503 chain_unavailable when Sui cannot be read.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const { ownerId } = await requireOwner(request, ctx);
      const limited = await limitOwnerChainReads(ctx, ownerId);
      if (limited !== null) return limited;
      const { step, digest } = await readJson(request, body, OWNER_BODY_CAPS.onboardingConfirm);
      try {
        const { recorded } = await confirmOnboardingTx({ db: ctx.db, ownerId, step, digest, chain: ctx.chain, masterSecretHex: ctx.env.ELLAI_MASTER_SECRET, now: ctx.now() });
        return jsonResponse({ recorded });
      } catch (error) {
        const answer = onboardingChainFailure(error);
        if (answer === null) throw error;
        return answer;
      }
    }),
  );
}
