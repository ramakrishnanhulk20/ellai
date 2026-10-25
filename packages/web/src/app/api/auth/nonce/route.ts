import { LIMITS } from '@ellai/core/limits';
import { z } from 'zod';
import { issueSignIn } from '../../../../server/auth/signin.js';
import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../server/http/origin.js';
import { limitSignIn } from '../../../../server/http/ratelimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.strictObject({ address: z.string().max(LIMITS.signinAddressMaxChars) });

/**
 * Starts a wallet sign-in: { address } in, { message, expiresAt } out, the message being what
 * the wallet signs. Same origin only, and held to LIMITS.signInRequestsPerMinute per client and
 * LIMITS.signInRequestsPerMinuteGlobal overall, since every call stores a nonce. 403 cross_origin, 429 rate_limited, 400 for a bad body or
 * an address that is not a Sui address.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const now = ctx.now();
      await limitSignIn(ctx.db, request, 'nonce', now);
      const { address } = await readJson(request, body, LIMITS.signinNonceBodyMaxBytes);
      const issued = await issueSignIn({ db: ctx.db, address, appOrigin: ctx.env.APP_ORIGIN, now });
      return jsonResponse({ message: issued.message, expiresAt: issued.expiresAt });
    }),
  );
}
