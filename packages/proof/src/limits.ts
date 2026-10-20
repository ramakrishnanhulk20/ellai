/**
 * Every numeric bound used by the proof package lives here, so a reviewer can see
 * all of them in one place and no call can quietly run without one.
 */
export const LIMITS = {
  /** Hard ceiling on one Tatum request, gRPC or GraphQL, before it is abandoned. */
  tatumTimeoutMs: 10_000,
  /** Extra attempts after the first one, and only for errors that may clear on their own. */
  tatumRetries: 2,
  /** Wait before the first retry; doubles on each later retry. */
  tatumRetryDelayMs: 1_000,
  /** Objects per GraphQL page when listing Walrus blobs. */
  graphqlPageSize: 50,
  /** Pages read before giving up, so a hostile or huge owner cannot keep us looping. */
  graphqlMaxPages: 20,
  /** Coin types per gRPC ListBalances page. The service caps this at 1000. */
  balancePageSize: 1_000,
  /** ListBalances pages read before giving up on finding USDC and SUI. */
  balanceMaxPages: 5,
  /** Ceiling on one request to a seller, from DNS lookup to the last body byte. */
  netTimeoutMs: 10_000,
  /** Bytes read from a seller's response before the request is abandoned. */
  netMaxResponseBytes: 262_144,
  /** Largest challenge body or header that is parsed. Live 402 bodies are under 1 KB. */
  challengeMaxBytes: 32_768,
  /** Deepest JSON nesting accepted in a challenge. Live 402 bodies nest 5 levels. */
  challengeMaxDepth: 20,
  /** Longest challengeId or nonce kept. Live challenge ids are 36-character UUIDs. */
  challengeIdMaxLength: 128,
  /** Longest resource URL kept from a challenge. It is shown, never fetched. */
  resourceMaxLength: 2_048,
  /** Smallest payment in atomic USDC: 0.01 USDC, the floor for a gasless send. */
  minPaymentAtomic: 10_000,
  /** Largest single payment in atomic USDC: 1 USDC. */
  maxPaymentAtomic: 1_000_000,
  /** How long a parsed payment stays usable, whatever expiry the seller asks for. */
  paymentValidityMs: 60_000,
} as const;
