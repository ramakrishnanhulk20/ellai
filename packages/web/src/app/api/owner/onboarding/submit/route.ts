import { LIMITS } from '@ellai/core/limits';
import { z } from 'zod';
import { scoped } from '../../../../../server/http/context.js';
import { HttpError } from '../../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { limitOwnerChainCalls, onboardingChainFailure } from '../../../../../server/http/owner-limits.js';
import { BUILD_STEPS } from '../../../../../server/onboarding/state.js';
import { SUBMIT_CHAIN_CALLS, submitOnboardingTx } from '../../../../../server/onboarding/submit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// submitOnboardingTx reads the bytes and holds them to the step; this only bounds what is read.
const body = z.strictObject({
  step: z.enum(BUILD_STEPS),
  txBytesBase64: z
    .string()
    .min(1)
    .max(Math.ceil(LIMITS.onboardingSubmitTxMaxBytes / 3) * 4),
  signature: z.string().min(1).max(LIMITS.onboardingSubmitSignatureMaxChars),
});

/**
 * Sends one onboarding transaction the signed-in owner signed in their own wallet to Sui through
 * Tatum, so the wallet only signs: { step, txBytesBase64, signature } in, txBytesBase64 being the
 * exact bytes the build route returned and signature the wallet's serialized signature over them.
 * submitOnboardingTx refuses, sending nothing, bytes that are not from the owner's own address or
 * not the transaction Ellai builds for that step; Ellai only relays the owner's signature and
 * signs nothing (C6). Answers:
 * - 200 { recorded, digest }: it succeeded on chain and the step is recorded as confirm records it.
 *   For usdc_to_address, which records nothing, recorded is { movedAtomic }: what the coins held,
 *   as Ellai read them just before the send, now in the owner's address balance.
 * - 200 { ended: true, digest }: for end_allowance, the revoke succeeded, Sui deleted the allowance
 *   and Ellai has forgotten it, so nothing more is drawn from the owner's wallet.
 * - 202 { digest }: it was sent, but the outcome is unknown or Sui does not show the result yet;
 *   call confirm with { step, digest } later to record it, or for usdc_to_address read the wallet
 *   route again.
 * - 422 chain_refused: the network refused it or it ran and failed. Nothing is recorded.
 * The owner comes from the session alone (C13), the request must come from the app (C14), and once
 * its body is read each request counts toward limitOwnerChainCalls's budgets at its step's
 * SUBMIT_CHAIN_CALLS (C22). 403 cross_origin, 401 signed_out, 429 past this owner's or this
 * client's caps, 400 for a bad body, 400 bad_transaction for refused bytes or signature, 409
 * not_ready or already_done for an account step or end_allowance, 409 nothing_to_move for the move
 * when the owner holds no USDC coins now, 503 chain_unavailable when Sui cannot be read
 * for the check, 503 chain_unavailable_today once the day's budget is spent, before anything is sent.
 */
export const POST = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  // Read first, so the calls counted are the ones this step makes.
  const { step, txBytesBase64, signature } = await readJson(request, body, LIMITS.onboardingSubmitBodyMaxBytes);
  const limited = await limitOwnerChainCalls(ctx, request, ownerId, SUBMIT_CHAIN_CALLS[step]);
  if (limited !== null) return limited;
  try {
    const outcome = await submitOnboardingTx({ db: ctx.db, ownerId, step, txBytesBase64, signature, chain: ctx.chain, masterSecretHex: ctx.env.ELLAI_MASTER_SECRET, now: ctx.now() });
    if (outcome.status === 'recorded') return jsonResponse({ recorded: outcome.recorded, digest: outcome.digest });
    if (outcome.status === 'moved') return jsonResponse({ recorded: { movedAtomic: outcome.movedAtomic }, digest: outcome.digest });
    if (outcome.status === 'ended') return jsonResponse({ ended: true, digest: outcome.digest });
    if (outcome.status === 'sent') return jsonResponse({ digest: outcome.digest }, { status: 202 });
    throw new HttpError(422, 'chain_refused');
  } catch (error) {
    const answer = onboardingChainFailure(error);
    if (answer === null) throw error;
    return answer;
  }
});
