import { LIMITS } from '@ellai/core/limits';
import { z } from 'zod';
import { sessionCookie } from '../../../../server/auth/sessions.js';
import { completeSignIn } from '../../../../server/auth/signin.js';
import { clientKey } from '../../../../server/http/client.js';
import { scoped, withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../server/http/origin.js';
import { limitSignIn } from '../../../../server/http/ratelimit.js';
import { cookieIsSecure } from '../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// completeSignIn refuses any message longer than the ones it issues; these bounds only keep
// a hostile body from reaching it at all.
const body = z.strictObject({ message: z.string().max(LIMITS.signinMessageMaxChars), signature: z.string().max(LIMITS.signinSignatureMaxChars) });

/**
 * Finishes a wallet sign-in: { message, signature } in, { ownerId } out, with the session
 * cookie set HttpOnly and SameSite=Strict, and on https Secure under the name
 * __Host-ellai_session (C14). The session token goes only into the cookie, never the body.
 * Same origin only, and rate-limited like the nonce step.
 * A zkLogin proof can only be checked by Sui itself, so a zkLogin signature, alone or as
 * multisig members, is checked through the context chain's gRPC client: one Tatum read for each
 * zkLogin member that signed, within that client's timeout (C21). The nonce is used up first, so
 * a replay or a refused signature can never be tried again on it. A signature with more than
 * LIMITS.zkLoginMembersMax zkLogin members is refused before anything is counted. The reads are
 * then counted against this client, keyed on the platform's verified address, up to
 * LIMITS.zkLoginChecksPerClientPerMinute and LIMITS.zkLoginChecksPerClientPerDay, and only then
 * against LIMITS.zkLoginChecksPerMinute and LIMITS.zkLoginChecksPerDay, shared by every caller;
 * past any of them nothing is read (C22, C34). Every other kind is checked offline and reads nothing.
 * Answers: 403 cross_origin; 429 rate_limited past this client's or every client's sign-in
 * requests in the minute, or this client's zkLogin checks in the minute; 429 rate_limited_today
 * past this client's zkLogin checks or completed sign-ins in the UTC day; 400 for a bad body or
 * message; 401 for a signature or nonce that does not hold up; 503 chain_unavailable when a
 * zkLogin proof cannot be checked against the chain right now or the shared zkLogin minute is
 * spent; 503 chain_unavailable_today once the shared zkLogin checks or every client's completed
 * sign-ins for the UTC day are spent, or when Ellai's Tatum budget refuses the zkLogin check,
 * which is counted as this client (C22).
 */
export const POST = scoped('anyone', async (request: Request): Promise<Response> => {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const now = ctx.now();
      await limitSignIn(ctx.db, request, 'verify', now);
      const { message, signature } = await readJson(request, body, LIMITS.signinVerifyBodyMaxBytes);
      const signedIn = await completeSignIn({
        db: ctx.db,
        message,
        signature,
        appOrigin: ctx.env.APP_ORIGIN,
        masterSecretHex: ctx.env.ELLAI_MASTER_SECRET,
        sessionSecretHex: ctx.env.SESSION_SECRET,
        now,
        zkLoginClient: ctx.chain.grpc,
        clientKey: clientKey(request),
      });
      const cookie = sessionCookie(signedIn.sessionToken, signedIn.expiresAt, cookieIsSecure(ctx.env.APP_ORIGIN));
      return jsonResponse({ ownerId: signedIn.ownerId }, { headers: { 'set-cookie': cookie } });
    }),
  );
});
