import { LIMITS } from '@ellai/core/limits';
import { z } from 'zod';
import { scoped } from '../../../../../server/http/context.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { atomicAmountText, limitOwnerChainCalls, onboardingChainFailure } from '../../../../../server/http/owner-limits.js';
import { BUILD_CHAIN_CALLS, buildOnboardingTx } from '../../../../../server/onboarding/build.js';
import { BUILD_STEPS } from '../../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// buildOnboardingTx holds the terms to the onboarding maxima; this only reads their shape.
const allowance = z.strictObject({ dailyLimitAtomic: atomicAmountText, lifetimeCapAtomic: atomicAmountText, days: z.number() });
const body = z.strictObject({ step: z.enum(BUILD_STEPS), allowance: allowance.optional() });

/**
 * Builds the transaction the signed-in owner signs in their own wallet for one onboarding
 * step or the USDC move: { step, allowance? } in, step one of memory_account, add_delegate,
 * allowance or usdc_to_address, allowance being { dailyLimitAtomic, lifetimeCapAtomic, days }
 * with the amounts as decimal strings, and buildOnboardingTx's { txBytesBase64, summary } out
 * exactly as it gave them, so the summary the owner reads is the one made from the owner row
 * and the checked terms (C15). Nothing is recorded. The owner comes from the session alone
 * (C13), the request must come from the app (C14), and once its body is read each request counts
 * toward limitOwnerChainCalls's budgets at its step's BUILD_CHAIN_CALLS (C22): this owner's
 * requests a minute, and calls a day for this owner, for this client and for every owner. 403
 * cross_origin, 401 signed_out, 429 past this owner's or this client's caps, 400 for a bad body or terms, 409
 * not_ready for add_delegate before the account, 409 nothing_to_move when the owner holds no USDC
 * coins, 409 not_enough_sui when the owner's SUI cannot pay the fee, 422 chain_refused when Sui refuses the step,
 * 503 chain_unavailable when Sui cannot be read, 503 chain_unavailable_today once every owner's
 * day is spent.
 */
export const POST = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  // Read first, so the calls counted are the ones this step makes; the body is capped at 1 KiB.
  const { step, allowance: terms } = await readJson(request, body, LIMITS.onboardingBuildBodyMaxBytes);
  const limited = await limitOwnerChainCalls(ctx, request, ownerId, BUILD_CHAIN_CALLS[step]);
  if (limited !== null) return limited;
  try {
    const built = await buildOnboardingTx({ db: ctx.db, ownerId, step, allowance: terms, chain: ctx.chain, masterSecretHex: ctx.env.ELLAI_MASTER_SECRET, now: ctx.now() });
    return jsonResponse(built);
  } catch (error) {
    const answer = onboardingChainFailure(error);
    if (answer === null) throw error;
    return answer;
  }
});
