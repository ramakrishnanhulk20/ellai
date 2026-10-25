import { z } from 'zod';
import { sessionCookie } from '../../../../server/auth/sessions.js';
import { completeSignIn } from '../../../../server/auth/signin.js';
import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { BODY_CAPS, jsonResponse, readJson } from '../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../server/http/origin.js';
import { limitSignIn } from '../../../../server/http/ratelimit.js';
import { cookieIsSecure } from '../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// completeSignIn refuses any message longer than the ones it issues; these bounds only keep
// a hostile body from reaching it at all.
const body = z.strictObject({ message: z.string().max(1_024), signature: z.string().max(16_384) });

/**
 * Finishes a wallet sign-in: { message, signature } in, { ownerId } out, with the session
 * cookie set HttpOnly and SameSite=Strict, and on https Secure under the name
 * __Host-ellai_session (C14). The session token goes only into the cookie, never the body.
 * Same origin only, and rate-limited like the nonce step.
 * A zkLogin proof can only be checked by Sui itself, so a zkLogin signature, alone or as
 * multisig members, is checked through the context chain's gRPC client: one Tatum read for each
 * zkLogin member that signed, within that client's timeout (C21). Those reads are counted first
 * against LIMITS.zkLoginChecksPerMinute and LIMITS.zkLoginChecksPerDay, shared by every caller,
 * and past either nothing is read (C22). The nonce is used up before the read, so a refused
 * signature cannot be tried again on it. Every other kind is checked offline and reads nothing.
 * 403 cross_origin, 429 rate_limited, 400 for a bad body or message, 401 for a signature or
 * nonce that does not hold up, 503 chain_unavailable when a zkLogin proof cannot be checked
 * against the chain right now or the shared zkLogin quota is spent.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const now = ctx.now();
      await limitSignIn(ctx.db, request, 'verify', now);
      const { message, signature } = await readJson(request, body, BODY_CAPS.verify);
      const signedIn = await completeSignIn({
        db: ctx.db,
        message,
        signature,
        appOrigin: ctx.env.APP_ORIGIN,
        masterSecretHex: ctx.env.ELLAI_MASTER_SECRET,
        sessionSecretHex: ctx.env.SESSION_SECRET,
        now,
        zkLoginClient: ctx.chain.grpc,
      });
      const cookie = sessionCookie(signedIn.sessionToken, signedIn.expiresAt, cookieIsSecure(ctx.env.APP_ORIGIN));
      return jsonResponse({ ownerId: signedIn.ownerId }, { headers: { 'set-cookie': cookie } });
    }),
  );
}
