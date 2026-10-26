import { endOwnerSessions } from '../../../../server/auth/sessions.js';
import { scoped } from '../../../../server/http/context.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { clearedSessionCookie, cookieIsSecure } from '../../../../server/http/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Signs the owner out everywhere: ends every live session of the signed-in owner, this one
 * included, so a session token copied from any browser stops working at once, and clears this
 * browser's cookie under the name cookieIsSecure gives for APP_ORIGIN (endOwnerSessions; C13,
 * C14). It only takes power away, so the session is enough and no wallet signature is asked for
 * (C36). The owner comes from the session alone and the request must come from the app.
 * { signedOut: true, sessionsEnded } out. 403 cross_origin, 401 signed_out.
 */
export const DELETE = scoped('owner', async (_request, ctx, { ownerId }): Promise<Response> => {
  const sessionsEnded = await endOwnerSessions({ db: ctx.db, ownerId, now: ctx.now() });
  return jsonResponse({ signedOut: true, sessionsEnded }, { headers: { 'set-cookie': clearedSessionCookie(cookieIsSecure(ctx.env.APP_ORIGIN)) } });
});
