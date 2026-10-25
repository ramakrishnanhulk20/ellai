import { type Chain, ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../../../server/db/client.js';
import { decisions, owners, payments } from '../../../../server/db/schema.js';
import { withServerContext } from '../../../../server/http/context.js';
import { HttpError, respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { limitOwnerChainReads } from '../../../../server/http/owner-limits.js';
import { requireOwner } from '../../../../server/http/session.js';
import { onboardingState } from '../../../../server/onboarding/state.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The balance is shown, never acted on, so a chain that cannot be read blanks it rather than
// failing the whole page. Only the class and code of the failure are logged.
async function purseBalance(chain: Chain, purseAddress: string): Promise<{ usdcAtomic: bigint } | null> {
  try {
    const { usdcAddressBalance } = await chain.getBalances(purseAddress);
    if (typeof usdcAddressBalance !== 'bigint' || usdcAddressBalance < 0n) throw new TypeError('the purse balance is not a USDC amount');
    return { usdcAtomic: usdcAddressBalance };
  } catch (error) {
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
 * from chain (purse is null when the chain cannot be read), counts of asked, approved and
 * refused decisions and verified payments over the last LIMITS.overviewCountWindowMs (30 days),
 * and questionsPer20: of the latest LIMITS.overviewQuestionWindow (20) approved or asked
 * decisions, how many were asked, with `window` saying how many there were. The owner comes
 * from the session alone (C13); 401 signed_out without one.
 * Every call reads the purse through Tatum, so it counts toward the owner's
 * LIMITS.ownerChainReadsPerMinute (C22): 429 too_many_requests beyond it.
 * Atomic amounts are decimal strings.
 */
export async function GET(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const { ownerId } = await requireOwner(request, ctx);
      const limited = await limitOwnerChainReads(ctx, ownerId);
      if (limited !== null) return limited;
      const now = ctx.now();
      const [owner] = await ctx.db
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
        })
        .from(owners)
        .where(eq(owners.id, ownerId));
      // Owners are never deleted, so a session without one is treated as no session at all.
      if (owner === undefined) throw new HttpError(401, 'signed_out');

      const since = new Date(now.getTime() - LIMITS.overviewCountWindowMs);
      const [onboarding, purse, counts, questionsPer20] = await Promise.all([
        onboardingState({ db: ctx.db, ownerId }),
        purseBalance(ctx.chain, owner.purseAddress),
        recentCounts(ctx.db, ownerId, since),
        questionRate(ctx.db, ownerId),
      ]);
      return jsonResponse({ owner, onboarding, purse, counts, questionsPer20 });
    }),
  );
}
