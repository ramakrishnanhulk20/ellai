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
  /**
   * Largest GraphQL response body read from Tatum. A full page of Walrus blobs is
   * about 25 KB, so 1 MiB leaves room without letting a broken gateway fill memory.
   */
  graphqlMaxResponseBytes: 1_048_576,
  /**
   * Largest single gRPC message accepted from Tatum. A full ListBalances page of 1,000
   * coin types is about 250 KB; grpc-js would otherwise allow 4 MiB.
   */
  grpcMaxReceiveBytes: 1_048_576,
  /** Requests a minute Tatum allows without an API key. The probes and live tests pace themselves to it. */
  tatumAnonymousRequestsPerMinute: 5,
  /** Ceiling on one request to a seller, from DNS lookup to the last body byte. */
  netTimeoutMs: 10_000,
  /** Shortest wait a caller may ask safeFetch for. Anything shorter cannot finish a TLS handshake reliably. */
  netTimeoutMinMs: 1_000,
  /**
   * Longest wait a caller may ask safeFetch for. A t2000 seller runs its handler before it
   * settles, so cutting a paid request short means the seller never takes the payment.
   */
  netPaidTimeoutMaxMs: 60_000,
  /** Wait on a paid request to a seller whose answer is a lookup. */
  sellerLookupPaidTimeoutMs: 15_000,
  /** Wait on a paid request to a seller that plans its answer with a language model, or does not say how it answers. */
  sellerSlowPaidTimeoutMs: 60_000,
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
  /**
   * Largest send between Ellai's own purses and the owner, in atomic USDC: 0.05 USDC. Kept
   * well under the purse float, so a bug in a funding or recovery send can only move pennies.
   */
  internalSendMaxAtomic: 50_000,
  /** How long a parsed payment stays usable, whatever expiry the seller asks for. */
  paymentValidityMs: 60_000,
  /**
   * Widest epoch window a signed payment may carry. Sui refuses a payment with no gas
   * coins unless maxEpoch is at most minEpoch + 1, so a wider window is never valid.
   */
  paymentMaxEpochSpan: 1,
  /** The purse is refilled only while its USDC is below this: 0.05 USDC. */
  purseRefillBelowAtomic: 50_000,
  /** Every refill is exactly this much: 0.10 USDC. */
  purseRefillAtomic: 100_000,
  /**
   * The most the purse may hold right after a refill: 0.20 USDC. A plain send has no cap
   * of its own on chain, so this float is the real per-payment ceiling (C23).
   */
  purseMaxFloatAtomic: 200_000,
  /** Refills allowed for one purse in any 24 hours. */
  purseMaxRefillsPerDay: 3,
  /**
   * Gas budget on a sponsored refill, so the most the gas wallet can lose on one: 0.02 SUI.
   * An allowance spend measured about 0.002 SUI on testnet at ten times mainnet's gas price.
   */
  refillGasBudgetMist: 20_000_000,
  /** Gas budget the owner signs for when issuing an allowance, which creates two objects: 0.05 SUI. */
  issueGasBudgetMist: 50_000_000,
  /** Highest gas price Ellai builds with, in MIST per unit. Mainnet's reference price was 100 on 2026-10-20. */
  maxGasPriceMist: 1_000,
  /** Settlement reads for one payment before it is reported unsettled. */
  settlementPollTries: 20,
  /** Wait between settlement reads. */
  settlementPollIntervalMs: 3_000,
  /**
   * Reads, settlementPollIntervalMs apart, that must all miss a signed payment after its
   * epoch window has closed before it is released, so one lagging node cannot release a
   * payment that landed at the very end of its window.
   */
  paymentReleaseReads: 3,
  /** Reads of an object or a balance after a transaction lands, while Tatum's nodes catch up, before it counts as missing. */
  chainReadAfterWriteTries: 6,
  /** Wait between those reads. */
  chainReadAfterWriteDelayMs: 3_000,
  /** The span the anonymous Tatum allowance is counted over: one minute plus two seconds of slack. */
  tatumPacingWindowMs: 62_000,
  /** Wait after Tatum answers "rate limited" before the same step is tried again. Longer than one pacing window. */
  tatumRateLimitWaitMs: 65_000,
  /** Further tries of one Walrus Memory account step after a Tatum rate limit. */
  tatumRateLimitRetries: 2,
  /**
   * Most gas one Walrus Memory account transaction may reserve, in MIST: 0.05 SUI. The
   * budget is the most the transaction can ever cost, so a larger one is refused before
   * signing. Creating an account reserved about 0.004 SUI when measured.
   */
  memwalAccountTxMaxGasMist: 50_000_000,
  /** Tatum requests set aside for the account helper's own wait for a transaction it sent. */
  memwalHelperWaitRequests: 2,
  /** Reads of an account after a write, while Tatum's nodes catch up, before the write counts as missing. */
  memwalReadAfterWriteAttempts: 4,
  /** Wait between those reads. */
  memwalReadAfterWriteDelayMs: 3_000,
  /** Delegate keys one Walrus Memory account can hold. The contract refuses the 21st. */
  memwalMaxDelegateKeys: 20,
  /** Ceiling on one relayer request. The SDK's own recall deadline is 15 seconds and stays below it. */
  memwalRequestTimeoutMs: 30_000,
  /** Largest relayer response body read. Ellai's sentences are at most 4 KiB, so 20 recall hits fit with room. */
  memwalMaxResponseBytes: 2_097_152,
  /** Most sentences in one bulk write. The SDK and the relayer refuse more. */
  memwalBulkMaxItems: 20,
  /**
   * Longest sentence stored, in UTF-8 bytes. The relayer embeds a summary instead of the
   * text above 8 KiB, which would make search miss words the sentence contains.
   */
  memwalSentenceMaxBytes: 4_096,
  /** Longest namespace label. Labels are public on chain and carry nothing but a name. */
  memwalNamespaceMaxLength: 64,
  /**
   * Relayer rate-limit points one delegate key spends in a pacing window. 30 a minute is
   * the lowest published per-key figure; builders report 60, so this stays under both.
   */
  memwalPointsPerMinute: 30,
  /** The span relayer points are counted over: one minute plus two seconds of slack. */
  memwalPacingWindowMs: 62_000,
  /** Points one bulk write costs on the relayer. */
  memwalBulkPoints: 10,
  /** Points one recall or one status poll costs on the relayer. */
  memwalRequestPoints: 1,
  /** Wait before each status poll of a bulk write. 15 polls a minute plus one bulk write stays under 30 points. */
  memwalPollIntervalMs: 4_000,
  /** Status polls of one bulk write before it is declared timed out. */
  memwalPollMaxAttempts: 150,
  /** Total time one bulk write may take, from sending it to the last job finishing. */
  memwalWaitTimeoutMs: 600_000,
  /** Longest wait taken from a relayer's retry-after during polling. */
  memwalRetryAfterMaxMs: 60_000,
  /** Highest recall limit accepted. The relayer caps recall at 100 hits. */
  memwalRecallMaxLimit: 100,
  /** Hits the memory proof asks for. */
  memwalProofRecallLimit: 5,
  /** The memory proof's distance cutoff. Cosine distance below 0.8 is at least weakly related. */
  memwalProofMaxDistance: 0.8,
  /** Recalls the memory proof tries while the index catches up after a write. */
  memwalProofRecallAttempts: 5,
  /** Wait between those recalls. */
  memwalProofRecallDelayMs: 15_000,
} as const;
