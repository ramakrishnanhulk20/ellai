import { LIMITS } from '@ellai/core/limits';
import { eq } from 'drizzle-orm';
import {
  type AutoPause,
  OWNER_AUTO_PAUSE,
  OWNER_SETTINGS,
  STEP_UP_PROOF_MAX_BYTES,
  autoPauseOf,
  claimStepUp,
  sameAutoPause,
  settingsBoundsProblem,
  settingsLoosen,
  settingsPatch,
} from '../../../../server/auth/stepup.js';
import { owners } from '../../../../server/db/schema.js';
import { scoped } from '../../../../server/http/context.js';
import { HttpError } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in owner's settings, { paused, autoPausedReason, perPaymentMaxAtomic,
 * dailyBudgetAtomic, approvalsNeeded, distanceCutoff, publicProof }, in exactly the shape and
 * formats PATCH answers with and the overview's owner object carries, amounts as decimal strings.
 * Read from the owner row alone, so a settings screen costs no chain read, unlike the overview.
 * The owner comes from the session alone (C13); 401 signed_out without one.
 */
export const GET = scoped('owner', async (_request, ctx, { ownerId }): Promise<Response> => {
  const [settings] = await ctx.db.select(OWNER_SETTINGS).from(owners).where(eq(owners.id, ownerId));
  // The jobs tick prunes an owner only once it has no live session, so the row can be gone only
  // if the session ended after the cookie was checked; that is treated as no session at all.
  if (settings === undefined) throw new HttpError(401, 'signed_out');
  return jsonResponse(settings);
});

/**
 * Changes the signed-in owner's own limits: any of { paused, perPaymentMaxAtomic,
 * dailyBudgetAtomic, approvalsNeeded, distanceCutoff, clearAutoPause, publicProof } in, at
 * least one, the amounts as decimal strings, with an optional stepUp; the owner's settings after
 * the change out, the fields the overview shows plus publicProof. publicProof true lists this
 * owner's verified payments and on-chain memories on the public /proof page, and false takes them
 * off at the page's next refresh; owners start with false. The bounds are settingsBoundsProblem's.
 * Unpausing leaves an auto pause in place: only clearAutoPause: true clears it, reason and time
 * both, so an owner must acknowledge a settlement mismatch on purpose.
 * A change that lets Ellai do more than the owner's row does now (settingsLoosen) needs stepUp:
 * { nonce, signature } from POST /api/owner/step-up for loosen_settings with exactly this change,
 * signed by the owner's wallet (C36). It is spent before the owner row is locked (claimStepUp), so a
 * zkLogin check waiting on Sui never holds the lock signing takes. A stepUp that clears the
 * automatic pause names the pause it was issued for, and the pause is cleared only while the row
 * still holds exactly that one, so a pause set after the owner read the message stays (C8, C36).
 * A change that only tightens needs none. The owner row is locked FOR UPDATE for the read, the
 * checks and the one update, so a change cannot interleave with signing or with settlement setting
 * a pause, which take the same lock, and whether it loosens is judged against the row as it is
 * then. The owner comes from the session alone (C13) and the request must come from the app
 * (C14). 403 cross_origin, 401 signed_out, 400 bad_body for a malformed body, 400 out_of_bounds
 * for a value outside its bounds, 403 step_up_required for a loosening change with no stepUp, 401
 * step_up_rejected for a stepUp that is unknown, used, expired, another owner's, for another
 * change or badly signed, 409 pause_changed for one that clears a pause no longer the one set,
 * each with nothing changed.
 */
export const PATCH = scoped('owner', async (request, ctx, { ownerId }): Promise<Response> => {
  const { stepUp, ...change } = await readJson(request, settingsPatch, LIMITS.settingsBodyMaxBytes + STEP_UP_PROOF_MAX_BYTES);
  let signedPause: AutoPause | undefined;
  if (stepUp !== undefined) {
    signedPause = await claimStepUp({ db: ctx.db, ownerId, request: { action: 'loosen_settings', change }, proof: stepUp, zkLoginClient: ctx.chain.grpc, now: ctx.now() });
  }
  const clearing = change.clearAutoPause === true;

  const outcome = await ctx.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ ...OWNER_SETTINGS, ...OWNER_AUTO_PAUSE })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .for('update');
    // The jobs tick deletes an owner only once nothing points at it, a live session included, so
    // the row can be gone only if the session ended after the cookie was checked; that is
    // treated as no session at all.
    if (current === undefined) throw new HttpError(401, 'signed_out');
    const problem = settingsBoundsProblem(current, change);
    if (problem !== null) return { problem };
    if (stepUp === undefined && settingsLoosen(current, change)) throw new HttpError(403, 'step_up_required');
    // Settlement can set a newer pause between the claim and this lock.
    if (clearing && signedPause !== undefined && !sameAutoPause(signedPause, autoPauseOf(current))) throw new HttpError(409, 'pause_changed');
    const [updated] = await tx
      .update(owners)
      .set({
        paused: change.paused,
        perPaymentMaxAtomic: change.perPaymentMaxAtomic,
        dailyBudgetAtomic: change.dailyBudgetAtomic,
        approvalsNeeded: change.approvalsNeeded,
        distanceCutoff: change.distanceCutoff === undefined ? undefined : Math.fround(change.distanceCutoff),
        autoPausedReason: clearing ? null : undefined,
        autoPausedAt: clearing ? null : undefined,
        publicProof: change.publicProof,
      })
      .where(eq(owners.id, ownerId))
      .returning(OWNER_SETTINGS);
    if (updated === undefined) throw new Error('the settings update returned no row');
    return { settings: updated };
  });

  if (outcome.problem !== undefined) throw new HttpError(400, 'out_of_bounds', outcome.problem);
  return jsonResponse(outcome.settings);
});
