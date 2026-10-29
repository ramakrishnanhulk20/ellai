import { LIMITS } from '@ellai/core/limits';
import { z } from 'zod';
import { TEXT_CAPS } from '../../../../../server/db/schema.js';
import { scoped } from '../../../../../server/http/context.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { limitOwnerChainCalls, onboardingChainFailure } from '../../../../../server/http/owner-limits.js';
import { scheduleOwnerVisit } from '../../../../../server/jobs/visit.js';
import { CONFIRM_CHAIN_CALLS, CONFIRM_EXISTING_CHAIN_CALLS, confirmExistingStep, confirmOnboardingTx } from '../../../../../server/onboarding/confirm.js';
import { ACCOUNT_STEPS, CONFIRM_STEPS } from '../../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Seconds this route may run, so the ceiling is Ellai's choice and not the platform's default.
// Next.js reads this export without running the module, so it is written as the literal value of
// LIMITS.slowRouteMaxDurationS, and a test holds the two equal. The owner's visit this route
// starts runs after the answer is sent, inside this ceiling (C40).
export const maxDuration = 300;

// confirmOnboardingTx decides whether the digest is a Sui digest; this only bounds its length.
const byDigest = z.strictObject({ step: z.enum(CONFIRM_STEPS), digest: z.string().max(TEXT_CAPS.digest) });
// Strict on both sides, so a body naming a digest and existing together, or any id, is refused.
const existing = z.strictObject({ step: z.enum(ACCOUNT_STEPS), existing: z.literal(true) });
const body = z.union([byDigest, existing]);

/**
 * Records one onboarding step once Sui shows it done, in one of two ways:
 * - { step, digest }: the owner's transaction did it. { recorded } out, recorded being the
 *   account id, Ellai's delegate key as hex, or the allowance id, all read from chain by
 *   confirmOnboardingTx and never taken from the caller (C7, C8), counted at the step's
 *   CONFIRM_CHAIN_CALLS. For end_allowance recorded is 'ended' once Sui no longer has the
 *   allowance on the owner row, which is then forgotten; 409 not_landed while Sui still shows it.
 * - { step: 'memory_account' | 'add_delegate', existing: true }: Sui already showed the step done
 *   when the owner asked to build it (409 already_done there), so there is no transaction. The
 *   account is read from Sui by the owner's address alone (confirmExistingStep) and recorded the
 *   same way, counted at CONFIRM_EXISTING_CHAIN_CALLS.
 * The owner comes from the session alone (C13), the request must come from the app (C14), and once
 * its body is read each request counts toward limitOwnerChainCalls's budgets (C22): this owner's
 * requests a minute, and calls a day for this owner, for this client and for every owner. 403
 * cross_origin, 401 signed_out, 429 past this owner's or this client's caps, 400 for a bad body or
 * digest, 409 not_ready or not_landed (ask again shortly), 422 refused when the chain shows
 * something the step does not accept, 503 chain_unavailable when Sui cannot be read, 503
 * chain_unavailable_today once every owner's day is spent. Once a step is recorded, a visit for
 * this owner is scheduled after the response, so a new allowance's first refill does not wait for
 * the scheduled tick (scheduleOwnerVisit, C40); it never changes the response.
 */
export const POST = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const requestStartedMs = Date.now();
  // Read first, so the calls counted are the ones this step makes; the body is capped at 1 KiB.
  const sent = await readJson(request, body, LIMITS.onboardingConfirmBodyMaxBytes);
  const calls = 'existing' in sent ? CONFIRM_EXISTING_CHAIN_CALLS[sent.step] : CONFIRM_CHAIN_CALLS[sent.step];
  const limited = await limitOwnerChainCalls(ctx, request, ownerId, calls);
  if (limited !== null) return limited;
  const common = { db: ctx.db, ownerId, chain: ctx.chain, masterSecretHex: ctx.env.ELLAI_MASTER_SECRET, now: ctx.now() };
  try {
    const { recorded } = 'existing' in sent ? await confirmExistingStep({ ...common, step: sent.step }) : await confirmOnboardingTx({ ...common, step: sent.step, digest: sent.digest });
    scheduleOwnerVisit(ownerId, 'onboarding', requestStartedMs);
    return jsonResponse({ recorded });
  } catch (error) {
    const answer = onboardingChainFailure(error);
    if (answer === null) throw error;
    return answer;
  }
});
