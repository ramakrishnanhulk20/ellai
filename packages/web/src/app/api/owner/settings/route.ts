import { LIMITS } from '@ellai/core/limits';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { owners } from '../../../../server/db/schema.js';
import { formatUsdc } from '../../../../server/decide/sentences.js';
import { scoped } from '../../../../server/http/context.js';
import { HttpError } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';
import { atomicAmountText } from '../../../../server/http/owner-limits.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIN_PAYMENT = BigInt(LIMITS.minPaymentAtomic);
const MAX_PAYMENT = BigInt(LIMITS.maxPaymentAtomic);
const MAX_DAILY_BUDGET = BigInt(LIMITS.onboardingDailyLimitMaxAtomic);

const body = z
  .strictObject({
    paused: z.boolean().optional(),
    perPaymentMaxAtomic: atomicAmountText.optional(),
    dailyBudgetAtomic: atomicAmountText.optional(),
    approvalsNeeded: z.number().optional(),
    distanceCutoff: z.number().optional(),
    clearAutoPause: z.literal(true).optional(),
    publicProof: z.boolean().optional(),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined));

type Change = z.output<typeof body>;

const SETTINGS = {
  paused: owners.paused,
  autoPausedReason: owners.autoPausedReason,
  perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
  dailyBudgetAtomic: owners.dailyBudgetAtomic,
  approvalsNeeded: owners.approvalsNeeded,
  distanceCutoff: owners.distanceCutoff,
  publicProof: owners.publicProof,
};

interface Settings {
  paused: boolean;
  autoPausedReason: string | null;
  perPaymentMaxAtomic: bigint;
  dailyBudgetAtomic: bigint;
  approvalsNeeded: number;
  distanceCutoff: number;
  publicProof: boolean;
}

// Only what the change touches is checked, so a value stored before these bounds existed can
// never stop an owner from pausing. Every message is fixed text and LIMITS, never the input.
function boundsProblem(current: Settings, change: Change): string | null {
  const perPaymentMax = change.perPaymentMaxAtomic ?? current.perPaymentMaxAtomic;
  if (change.perPaymentMaxAtomic !== undefined && (perPaymentMax < MIN_PAYMENT || perPaymentMax > MAX_PAYMENT)) {
    return `The per-payment maximum must be from ${formatUsdc(MIN_PAYMENT)} to ${formatUsdc(MAX_PAYMENT)} USDC.`;
  }
  if (change.dailyBudgetAtomic !== undefined && change.dailyBudgetAtomic > MAX_DAILY_BUDGET) {
    return `The daily budget must be at most ${formatUsdc(MAX_DAILY_BUDGET)} USDC.`;
  }
  const amountsChange = change.perPaymentMaxAtomic !== undefined || change.dailyBudgetAtomic !== undefined;
  if (amountsChange && (change.dailyBudgetAtomic ?? current.dailyBudgetAtomic) < perPaymentMax) {
    return 'The daily budget must be at least the per-payment maximum.';
  }
  const approvals = change.approvalsNeeded;
  if (approvals !== undefined && (!Number.isSafeInteger(approvals) || approvals < LIMITS.approvalsNeededMin || approvals > LIMITS.approvalsNeededMax)) {
    return `Approvals needed must be a whole number from ${LIMITS.approvalsNeededMin} to ${LIMITS.approvalsNeededMax}.`;
  }
  // Checked as the real column will hold it, so a value that rounds to 0 there is refused
  // and what was checked is exactly what is stored.
  const cutoff = change.distanceCutoff === undefined ? undefined : Math.fround(change.distanceCutoff);
  if (cutoff !== undefined && !(cutoff > 0 && cutoff <= LIMITS.distanceCutoffMax)) return `The distance cutoff must be above 0 and at most ${LIMITS.distanceCutoffMax}.`;
  return null;
}

/**
 * Changes the signed-in owner's own limits: any of { paused, perPaymentMaxAtomic,
 * dailyBudgetAtomic, approvalsNeeded, distanceCutoff, clearAutoPause, publicProof } in, at
 * least one, the amounts as decimal strings; the owner's settings after the change out, the
 * fields the overview shows plus publicProof. publicProof true lists this owner's verified
 * payments and on-chain memories on the public /proof page, and false takes them off at the
 * page's next refresh; owners start with false. The per-payment maximum must be within
 * [LIMITS.minPaymentAtomic, LIMITS.maxPaymentAtomic]; the daily budget within [the per-payment
 * maximum after the change, LIMITS.onboardingDailyLimitMaxAtomic]; approvals needed a whole
 * number from LIMITS.approvalsNeededMin to LIMITS.approvalsNeededMax; the distance cutoff above 0
 * and at most LIMITS.distanceCutoffMax. Unpausing leaves an auto pause in place: only
 * clearAutoPause: true clears it, so an owner must acknowledge a settlement mismatch on purpose.
 * The owner row is locked FOR UPDATE for the read, the checks and the one update, so a change
 * cannot interleave with signing, which takes the same lock. The owner comes from the session
 * alone (C13) and the request must come from the app (C14). 403 cross_origin, 401 signed_out,
 * 400 bad_body for a malformed body, 400 out_of_bounds for a value outside its bounds, with
 * nothing changed.
 */
export const PATCH = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const change = await readJson(request, body, LIMITS.settingsBodyMaxBytes);

  const outcome = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select(SETTINGS).from(owners).where(eq(owners.id, ownerId)).for('update');
    // Owners are never deleted, so a session without one is treated as no session at all.
    if (current === undefined) throw new HttpError(401, 'signed_out');
    const problem = boundsProblem(current, change);
    if (problem !== null) return { problem };
    const [updated] = await tx
      .update(owners)
      .set({
        paused: change.paused,
        perPaymentMaxAtomic: change.perPaymentMaxAtomic,
        dailyBudgetAtomic: change.dailyBudgetAtomic,
        approvalsNeeded: change.approvalsNeeded,
        distanceCutoff: change.distanceCutoff === undefined ? undefined : Math.fround(change.distanceCutoff),
        autoPausedReason: change.clearAutoPause === true ? null : undefined,
        publicProof: change.publicProof,
      })
      .where(eq(owners.id, ownerId))
      .returning(SETTINGS);
    if (updated === undefined) throw new Error('the settings update returned no row');
    return { settings: updated };
  });

  if (outcome.problem !== undefined) throw new HttpError(400, 'out_of_bounds', outcome.problem);
  return jsonResponse(outcome.settings);
});
