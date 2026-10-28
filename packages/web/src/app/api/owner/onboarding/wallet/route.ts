import { scoped } from '../../../../../server/http/context.js';
import { jsonResponse } from '../../../../../server/http/json.js';
import { limitOwnerChainCalls, onboardingChainFailure } from '../../../../../server/http/owner-limits.js';
import { ownerWallet, WALLET_CHAIN_CALLS } from '../../../../../server/onboarding/funds.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where the signed-in owner's own USDC and SUI sit, read from Sui for the address on the owner row:
 * { usdcAddressAtomic, usdcCoinAtomic, suiAddressMist, suiCoinMist }, each a decimal string, and
 * feeSource. An allowance draws only from the address balance, so USDC held as coins has to be
 * moved there first (the usdc_to_address step); a setup fee is paid from the SUI address balance
 * when it covers the budget, otherwise with SUI coins. feeSource says which would pay the allowance
 * step's fee, 'address_balance', 'coins', or null when neither covers it alone (Ellai never combines
 * them), from the same read with no further call. The owner comes from the session alone (C13), and each request counts
 * toward limitOwnerChainCalls's budgets at WALLET_CHAIN_CALLS (C22), so screens read it on
 * demand, never on a timer. 401 signed_out, 404 no_owner, 429 past this owner's or this client's
 * caps, 503 chain_unavailable when Sui cannot be read, 503 chain_unavailable_today once the day's
 * budget is spent. Nothing is recorded.
 */
export const GET = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const limited = await limitOwnerChainCalls(ctx, request, ownerId, WALLET_CHAIN_CALLS);
  if (limited !== null) return limited;
  try {
    return jsonResponse(await ownerWallet({ db: ctx.db, ownerId, chain: ctx.chain }));
  } catch (error) {
    const answer = onboardingChainFailure(error);
    if (answer === null) throw error;
    return answer;
  }
});
