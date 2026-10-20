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
} as const;
