import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../../../server/db/client.js';
import { decisions, owners, payments } from '../../../../server/db/schema.js';
import { scoped } from '../../../../server/http/context.js';
import { HttpError } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { limitOwnerChainCalls } from '../../../../server/http/owner-limits.js';
import { ledgerBalanceAtomic } from '../../../../server/jobs/refill.js';
import { onboardingState } from '../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One ListBalances page on the success path. A purse sent more than LIMITS.balancePageSize coin
// types reads more pages; scratchpad/tatum-budget.md counts that as the worst case.
const PURSE_READ_CALLS = 1;

const BUDGET_SPENT = Symbol('budget spent');

// The balance is shown, never acted on, so a chain that cannot be read blanks it rather than
// failing the whole page. Only the class and code of the failure are logged. A refusal by Ellai's
// own Tatum budget is not a blank purse: it holds until the UTC day ends, so the route says so.
async function purseBalance(chain: Chain, purseAddress: string): Promise<{ usdcAtomic: bigint } | null | typeof BUDGET_SPENT> {
  try {
    const { usdcAddressBalance } = await chain.getBalances(purseAddress);
    if (typeof usdcAddressBalance !== 'bigint' || usdcAddressBalance < 0n) throw new TypeError('the purse balance is not a USDC amount');
    return { usdcAtomic: usdcAddressBalance };
  } catch (error) {
    if (error instanceof ChainError && error.code === 'BUDGET') return BUDGET_SPENT;
    console.warn(`[ellai http] purse_balance_unavailable ${error instanceof ChainError ? error.code : 'UNEXPECTED'}`);
    return null;
  }
}

async function recentCounts(db: Database, ownerId: string, since: Date): Promise<{ asked: number; approved: number; refused: number; paid: number }> {
  const outcome = (value: 'asked' | 'approved' | 'refused') => sql`count(*) filter (where ${eq(decisions.outcome, value)})`.mapWith(Number);
  const [decided] = await db
    .select({ asked: outcome('asked'), approved: outcome('approved'), refused: outcome('refused') })
    .from(decisions)
    .where(and(eq(decisions.ownerId, ownerId), gte(decisions.createdAt, since)));
  // Paid means the chain showed the money arrive. A decision stays 'paid' even when its signed
  // payment never landed, so the decision status alone would overstate it.
  const [paid] = await db
    .select({ n: count() })
    .from(payments)
    .where(and(eq(payments.ownerId, ownerId), eq(payments.settlement, 'verified'), gte(payments.signedAt, since)));
  return { asked: decided?.asked ?? 0, approved: decided?.approved ?? 0, refused: decided?.refused ?? 0, paid: paid?.n ?? 0 };
}

// How often Ellai still has to ask: of the latest decisions that let money move or wanted to,
// how many needed the owner. Refusals are left out, since they never reach the owner.
async function questionRate(db: Database, ownerId: string): Promise<{ asked: number; window: number }> {
  const latest = await db
    .select({ outcome: decisions.outcome })
    .from(decisions)
    .where(and(eq(decisions.ownerId, ownerId), inArray(decisions.outcome, ['approved', 'asked'])))
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(LIMITS.overviewQuestionWindow);
  return { asked: latest.filter((row) => row.outcome === 'asked').length, window: latest.length };
}

/**
 * The signed-in owner's dashboard: their settings, including publicProof (whether /proof lists
 * their payments and memories, off until they opt in), onboarding progress, the purse's USDC read
 * from chain (purse is null when the purse is not read, see below, or the chain cannot be read), counts
 * of asked, approved and refused decisions and verified payments over the last
 * LIMITS.overviewCountWindowMs (30 days), and questionsPer20: of the latest
 * LIMITS.overviewQuestionWindow (20) approved or asked decisions, how many were asked, with
 * `window` saying how many there were, and builtinAgent: 'ready' when the server holds an
 * Anthropic key and 'needs_key' when it does not, never the key itself. The owner comes from
 * the session alone (C13); 401 signed_out without one.
 * The purse is read through Tatum only for an owner with an allowance, whose purse Ellai fills, or
 * one whose purse by Ellai's own ledger (ledgerBalanceAtomic: verified refills in, unreleased
 * payments out) may still hold USDC after the allowance was forgotten (C38). Only then does the
 * request count toward limitOwnerChainCalls's budgets at one call (C22), answering with its 429 or
 * 503 beyond them. Any other owner costs no chain read; onboarding.allowance says whether an
 * allowance is recorded. Because of that one call, screens load the overview on demand (page load, after an
 * action), never on a timer; GET /api/owner/settings reads the settings with no chain call.
 * The read is also counted by the Tatum meter, as this owner from this client; a refusal there
 * (ChainError BUDGET, nothing sent) is 503 chain_unavailable_today, not a blank purse, while any
 * other failed read blanks the purse. Atomic amounts are decimal strings.
 */
export const GET = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const now = ctx.now();
  const [row] = await ctx.db
    .select({
      suiAddress: owners.suiAddress,
      purseAddress: owners.purseAddress,
      paused: owners.paused,
      autoPausedReason: owners.autoPausedReason,
      perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
      dailyBudgetAtomic: owners.dailyBudgetAtomic,
      approvalsNeeded: owners.approvalsNeeded,
      distanceCutoff: owners.distanceCutoff,
      publicProof: owners.publicProof,
      allowanceId: owners.allowanceId,
    })
    .from(owners)
    .where(eq(owners.id, ownerId));
  // The jobs tick prunes an owner only once it has no live session, so the row can be gone only
  // if the session ended after the cookie was checked; that is treated as no session at all.
  if (row === undefined) throw new HttpError(401, 'signed_out');
  const { allowanceId, ...owner } = row;
  // C38: forgetting an allowance stops refills, not the money already in the purse, so the owner
  // still sees it while Ellai's own ledger says some may be there.
  const readsPurse = allowanceId !== null || (await ledgerBalanceAtomic(ctx.db, ownerId)) > 0n;
  if (readsPurse) {
    const limited = await limitOwnerChainCalls(ctx, request, ownerId, PURSE_READ_CALLS);
    if (limited !== null) return limited;
  }

  const since = new Date(now.getTime() - LIMITS.overviewCountWindowMs);
  const [onboarding, purse, counts, questionsPer20] = await Promise.all([
    onboardingState({ db: ctx.db, ownerId }),
    readsPurse ? purseBalance(ctx.chain, owner.purseAddress) : null,
    recentCounts(ctx.db, ownerId, since),
    questionRate(ctx.db, ownerId),
  ]);
  if (purse === BUDGET_SPENT) throw new HttpError(503, 'chain_unavailable_today');
  // The same test the run route makes before it builds a client, so the two can never disagree.
  const builtinAgent = ctx.env.ANTHROPIC_API_KEY === undefined ? 'needs_key' : 'ready';
  return jsonResponse({ owner, onboarding, purse, counts, questionsPer20, builtinAgent });
});
