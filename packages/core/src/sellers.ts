import { LIMITS } from './limits.js';

export interface Seller {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  /** How long the paid request may run. A t2000 seller settles only after its handler answers. */
  paidTimeoutMs: number;
  note: string;
}

const JSON_TYPE = 'application/json';

/**
 * Real Sui Mainnet sellers, in the order Ellai tries to pay them: answers that are a
 * deterministic check or lookup first, then answers a language model plans, then sellers
 * whose price is above 0.01 USDC, which are only ever probed. Every method, body and content type comes from
 * that seller's own published docs, saved under reference/payments/live/seller-docs/ on
 * 2026-10-20 and fetched again on 2026-10-24 with the same request schemas. Every route is
 * POST with a JSON body; an unpaid GET answers 402 too, but the paid handler then fails
 * for want of a body and the seller never settles. Prices in the notes are the docs'
 * claim; the probe reads the real one from the 402.
 */
export const KNOWN_SELLERS: ReadonlyArray<Seller> = [
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/v1/preflight',
    method: 'POST',
    body: JSON.stringify({ target: { url: 'https://suimpp.dev/llms.txt' } }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerLookupPaidTimeoutMs,
    note: 'AgentProof endpoint preflight, 0.01 USDC, a deterministic check (llms.txt: POST, body {target: {url}})',
  },
  {
    url: 'https://sui-inspector-x402.vercel.app/inspect',
    method: 'POST',
    body: JSON.stringify({ address: '0x0000000000000000000000000000000000000000000000000000000000000002' }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerLookupPaidTimeoutMs,
    // On 2026-10-24 its 402 carried a WWW-Authenticate header with currency="[object Object]",
    // which parseChallenge refuses as MALFORMED, so it is tried but cannot be paid until fixed.
    note: 'Sui address inspector, 0.01 USDC, a chain lookup (llms.txt and openapi.json: POST, body {address})',
  },
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/mcp',
    method: 'POST',
    // The docs accept any JSON object and call the route MCP JSON-RPC; tools/list is the
    // MCP specification's own request for a server's tools.
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerLookupPaidTimeoutMs,
    note: 'AgentProof MCP endpoint, 0.01 USDC, lists its tools (llms.txt: POST, any JSON object)',
  },
  {
    url: 'https://suimpp.jmpr.world/v1/hotels/search-flexible',
    method: 'POST',
    body: JSON.stringify({ request: 'Two nights in Singapore next month, mid-range, near the river', adults: 1, rooms: 1 }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerSlowPaidTimeoutMs,
    note: 'JMPR hotel search in plain words, 0.01 USDC, LLM-planned with up to 3 searches (llms.txt: POST, body {request, adults, rooms})',
  },
  {
    url: 'https://suimpp.jmpr.world/v1/flights/search-flexible',
    method: 'POST',
    body: JSON.stringify({
      request: 'One way from Singapore to Kuala Lumpur next Friday morning',
      adults: 1,
      children: 0,
      infants: 0,
      cabin_class: 'economy',
    }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerSlowPaidTimeoutMs,
    note: 'JMPR flight search in plain words, 0.01 USDC, LLM-planned with up to 10 searches (llms.txt: POST, body {request, adults, children, infants, cabin_class})',
  },
  {
    url: 'https://jp-task-policy-evidence.rev72258.workers.dev/classify',
    method: 'POST',
    body: JSON.stringify({ text: 'アンケートに回答してください。所要時間は約5分です。' }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerSlowPaidTimeoutMs,
    note: 'Japanese task page classifier, 0.02 USDC, does not say how it classifies (openapi.json: POST, body {url, text}; its llms.txt is a 404)',
  },
  {
    url: 'https://piptradedex.xyz/markets',
    method: 'POST',
    body: JSON.stringify({ asset: 'SUI' }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerSlowPaidTimeoutMs,
    note: 'PipTradeDex market snapshot with a short read, 0.02 USDC, does not say how the read is written (x402/llms.txt and openapi.json: POST, body {asset})',
  },
  {
    url: 'https://funkii-ai.vercel.app/palette',
    method: 'POST',
    body: JSON.stringify({ mood: 'calm, premium, technical', industry: 'AI agents' }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerSlowPaidTimeoutMs,
    // Same broken currency header as the inspector on 2026-10-24, so parseChallenge refuses it.
    note: 'Funkii brand palette from a mood, 0.02 USDC, generated (llms.txt and openapi.json: POST, body {mood, industry})',
  },
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/v1/mcp-verify',
    method: 'POST',
    body: JSON.stringify({ target: { url: 'https://mcp.t2000.ai/mcp' } }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerLookupPaidTimeoutMs,
    note: 'AgentProof MCP server check, 0.05 USDC, deterministic (llms.txt: POST, body {target: {url}})',
  },
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/v1/deep-verify',
    method: 'POST',
    body: JSON.stringify({ mode: 'http', target: { target: { url: 'https://suimpp.dev/llms.txt' } } }),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerSlowPaidTimeoutMs,
    note: 'AgentProof deep verification, 0.25 USDC, adds Workers AI analysis (llms.txt: POST, body {mode, target: {target: {url}}})',
  },
  {
    url: 'https://t2000-bot-x402.vercel.app/subscribe',
    method: 'POST',
    body: JSON.stringify({}),
    contentType: JSON_TYPE,
    paidTimeoutMs: LIMITS.sellerLookupPaidTimeoutMs,
    note: 't2000 alert bot subscription, 1.00 USDC, exactly the per-payment hard limit (llms.txt and openapi.json: POST, empty object)',
  },
];
