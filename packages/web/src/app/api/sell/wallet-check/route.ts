import { LIMITS } from '@ellai/core/limits';
import { clientKey } from '../../../../server/http/client.js';
import { withServerContext } from '../../../../server/http/context.js';
import { API_RESPONSE_HEADERS, respond } from '../../../../server/http/errors.js';
import { readCappedBody } from '../../../../server/http/json.js';
import { HANDLER_MESSAGES, handleWalletCheck, sellerPayTo } from '../../../../server/seller/handler.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESOURCE_PATH = '/api/sell/wallet-check';

// handleWalletCheck refuses a body over LIMITS.challengeMaxBytes; the reader stops at that cap.
// Null for a body over the cap, one that fails to arrive, or bytes that are not UTF-8, which the
// seller answers with its own 400 rather than the agent API's error codes.
async function readBodyText(request: Request): Promise<string | null> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await readCappedBody(request, LIMITS.challengeMaxBytes));
  } catch {
    return null;
  }
}

function sellerResponse(status: number, headers: Record<string, string>, body: string): Response {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(API_RESPONSE_HEADERS)) merged.set(name, value);
  return new Response(body, { status, headers: merged });
}

/**
 * Ellai's own paid service, sold over x402: POST { address } for a 0.01 USDC summary of that
 * Sui address. A public seller route: no session, no agent token. Without X-PAYMENT the answer
 * is a 402 challenge (429 past LIMITS.sellerChallengesPerMinute for the caller's verified
 * address, C22); with one, the payment is settled before the check is read (see
 * handleWalletCheck), and its bytes reach Tatum only within the caps on sends counted on that
 * same address: 429 past LIMITS.sellerExecutesPerClientPerMinute or
 * LIMITS.sellerExecutesPerClientPerDay, 503 past LIMITS.sellerExecutesPerDayGlobal for every
 * caller, each with Retry-After (C22). The challenge is bound to APP_ORIGIN plus this path, never to the Host
 * header, so a request sent under another name cannot move what a payment is for. 400 with the
 * seller's own message for a body over LIMITS.challengeMaxBytes or not UTF-8; 503
 * seller_unavailable when the pay-to address cannot be worked out.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      const payTo = sellerPayTo(ctx.env);
      const body = await readBodyText(request);
      if (body === null) return sellerResponse(400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: HANDLER_MESSAGES.body }));
      const answer = await handleWalletCheck({
        db: ctx.db,
        chain: ctx.chain,
        method: request.method,
        url: `${ctx.env.APP_ORIGIN}${RESOURCE_PATH}`,
        headers: Object.fromEntries(request.headers),
        body,
        payTo,
        callerKey: clientKey(request),
        now: ctx.now(),
      });
      return sellerResponse(answer.status, answer.headers, answer.body);
    }),
  );
}
