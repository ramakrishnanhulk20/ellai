import { endSession, readSessionCookie } from '../../../../server/auth/sessions.js';
import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../server/http/origin.js';
import { clearedSessionCookie, cookieIsSecure } from '../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Signs out: ends the session the cookie names, so the token never works again even if it
 * was copied, and clears the cookie. The cookie is read and cleared under the name
 * cookieIsSecure gives for APP_ORIGIN, the same rule the verify route set it by. Same origin
 * only (403 cross_origin), so another site cannot sign the owner out. Answers
 * { signedOut: true } whether or not a session was open.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const secure = cookieIsSecure(ctx.env.APP_ORIGIN);
      const token = readSessionCookie(request.headers.get('cookie'), secure);
      await endSession({ db: ctx.db, token, sessionSecretHex: ctx.env.SESSION_SECRET, now: ctx.now() });
      return jsonResponse({ signedOut: true }, { headers: { 'set-cookie': clearedSessionCookie(secure) } });
    }),
  );
}
