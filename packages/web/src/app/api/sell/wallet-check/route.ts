import { LIMITS } from '@ellai/core/limits';
import { clientKey } from '../../../../server/http/client.js';
import { withServerContext } from '../../../../server/http/context.js';
import { API_RESPONSE_HEADERS, respond } from '../../../../server/http/errors.js';
import { HANDLER_MESSAGES, handleWalletCheck, sellerPayTo } from '../../../../server/seller/handler.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESOURCE_PATH = '/api/sell/wallet-check';

// handleWalletCheck refuses a body over LIMITS.challengeMaxBytes; this stops reading as soon as
// the cap is passed, because Content-Length can be missing or lie. Null for a body over the cap,
// one that fails to arrive, or bytes that are not UTF-8.
async function readBodyText(request: Request): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > LIMITS.challengeMaxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
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
 * handleWalletCheck). The challenge is bound to APP_ORIGIN plus this path, never to the Host
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
