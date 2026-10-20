/**
 * Real Sui Mainnet sellers to probe with unpaid requests. The first five answered a
 * plain GET with a 402 on 2026-10-20 (reference/payments/BRIEF.md section 6). The POST
 * sellers come from the t2000 listing (api.t2000.ai/v1/services?rail=api); each body
 * matches the request schema in that seller's own openapi.json, saved under
 * reference/payments/live/seller-docs/. Prices in the notes are the listing's claim;
 * the probe reads the real one from the 402.
 */
export const KNOWN_SELLERS: ReadonlyArray<{ url: string; method: 'GET' | 'POST'; body?: string; note: string }> = [
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/v1/preflight',
    method: 'GET',
    note: 'AgentProof endpoint preflight check, listed at 0.01 USDC',
  },
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/v1/mcp-verify',
    method: 'GET',
    note: 'AgentProof MCP server check, listed at 0.05 USDC',
  },
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/v1/deep-verify',
    method: 'GET',
    note: 'AgentProof deep verification, listed at 0.25 USDC',
  },
  {
    url: 'https://agentproof.vegagaminginc.workers.dev/mcp',
    method: 'GET',
    note: 'AgentProof MCP endpoint, listed at 0.01 USDC',
  },
  {
    url: 'https://jp-task-policy-evidence.rev72258.workers.dev/classify',
    method: 'GET',
    note: 'Task policy classifier, listed at 0.02 USDC',
  },
  {
    url: 'https://suimpp.jmpr.world/v1/hotels/search-flexible',
    method: 'POST',
    body: JSON.stringify({ request: 'Two nights in Singapore next month, mid-range, near the river', adults: 1, rooms: 1 }),
    note: 'JMPR hotel search in plain words, listed at 0.01 USDC, the most used seller on the listing',
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
    note: 'JMPR flight search in plain words, listed at 0.01 USDC',
  },
  {
    url: 'https://sui-inspector-x402.vercel.app/inspect',
    method: 'POST',
    body: JSON.stringify({ address: '0x0000000000000000000000000000000000000000000000000000000000000002' }),
    note: 'Sui address inspector, listed at 0.01 USDC',
  },
  {
    url: 'https://piptradedex.xyz/markets',
    method: 'POST',
    body: JSON.stringify({ asset: 'SUI' }),
    note: 'PipTradeDex market lookup, listed at 0.02 USDC',
  },
  {
    url: 'https://funkii-ai.vercel.app/palette',
    method: 'POST',
    body: JSON.stringify({ mood: 'calm, premium, technical', industry: 'AI agents' }),
    note: 'Funkii brand colour palette, listed at 0.02 USDC',
  },
  {
    url: 'https://t2000-bot-x402.vercel.app/subscribe',
    method: 'POST',
    body: JSON.stringify({}),
    note: 'BadLabs subscription, listed at 1.00 USDC, exactly the per-payment hard limit',
  },
];
