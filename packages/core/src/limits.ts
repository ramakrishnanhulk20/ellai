/**
 * Every numeric bound Ellai uses lives here, so a reviewer can see
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
  /**
   * Hits one decision asks recall for. A result this long whose farthest hit is inside the
   * owner's cutoff may have cut off closer approvals, never a refusal or a bad outcome, which
   * are exact lookups (C11). So Ellai approves only when the approvals it can see already
   * reach the owner's number, and otherwise asks (C12).
   */
  decideRecallLimit: 20,
  /** Longest wait for recall during a decision. Past it, the recall counts as failed and Ellai asks. */
  decideRecallTimeoutMs: 15_000,
  /** Memories one decision cites. Bounds the rows written per decision whatever the history holds. */
  decideMaxCitedMemories: 20,
  /** How long an owner's yes stays usable as a one-time grant: 10 minutes. */
  grantTtlMs: 600_000,
  /** Longest purpose an agent may give, in characters. Equal to the database cap. */
  purposeMaxChars: 500,
  /** Longest reason an owner may give with an answer, in characters. Equal to the database cap. */
  reasonMaxChars: 300,
  /** Longest stretch of purpose text copied into a memory sentence, in characters. */
  sentencePurposeMaxChars: 200,
  /** How long a sign-in message may be signed and sent back: five minutes (C14). */
  signinNonceTtlMs: 300_000,
  /** How long an owner session lasts before signing in again: seven days. */
  sessionTtlMs: 604_800_000,
  /** Random bytes in a session token and an agent token. */
  bearerTokenBytes: 32,
  /** Pending memories submitted to Walrus Memory in one bulk write, the relayer's per-call maximum. */
  pendingMemoryWriteBatch: 20,
  /**
   * Memory write jobs checked per owner in one confirmation pass, all in one status call. The
   * relayer refuses more than 20 job ids per call (MAX_BULK_ITEMS in its services/server/src/types.rs).
   */
  memoryJobConfirmBatch: 20,
  /** Patience for a paid call to a seller Ellai has no recorded patience for. */
  netPaidTimeoutDefaultMs: 30_000,
  /** Characters of a seller's answer handed back to the agent; the rest is cut and marked as cut. */
  sellerAnswerMaxChars: 20_000,
  /** Settlement reads right after a paid call, before leaving the rest to the jobs tick. */
  settlementInlineTries: 8,
  /** Wait between those settlement reads. */
  settlementInlineIntervalMs: 3_000,
  /** Largest daily limit an owner may set on their allowance at onboarding: 5 USDC. */
  onboardingDailyLimitMaxAtomic: 5_000_000,
  /** Largest lifetime cap an owner may set on their allowance at onboarding: 50 USDC. */
  onboardingLifetimeCapMaxAtomic: 50_000_000,
  /** Longest an allowance may run before the owner renews it: 90 days. */
  onboardingAllowanceMaxMs: 7_776_000_000,
  /** Price of Ellai's own wallet check, in atomic USDC: 0.01 USDC, the gasless minimum. */
  sellerPriceAtomic: 10_000,
  /** How long a wallet check challenge may be paid after Ellai issues it. */
  sellerChallengeTtlMs: 60_000,
  /** Challenges Ellai's seller issues per caller address per minute (C22). */
  sellerChallengesPerMinute: 10,
  /** Owners whose background work one jobs tick handles. */
  jobsOwnersPerTick: 25,
  /** An approved decision with no payment after this long was abandoned by a crash: five minutes. */
  staleOpenDecisionMs: 300_000,
  /** A question the owner has not answered after a day is closed. */
  questionTtlMs: 86_400_000,
  /** Gas wallet SUI below which the jobs tick warns: 0.1 SUI in MIST. */
  gasWalletLowMist: 100_000_000,
  /** Paid-fetch calls one agent may make per minute through the agent API or MCP (C22). */
  agentCallsPerMinute: 30,
  /** Reads one owner may make per minute on owner routes that touch Tatum (C22). */
  ownerChainReadsPerMinute: 30,
  /** How long the public proof page's answer is reused before it is read again (C22). */
  publicProofCacheMs: 60_000,
  /** Built-in agent runs one owner may start per hour, so a public demo cannot burn the Claude credit. */
  agentRunsPerOwnerPerHour: 10,
  /** Built-in agent runs across all owners per day. */
  agentRunsPerDay: 200,
  /** Tool calls the built-in agent may make in one run. */
  agentMaxToolCalls: 6,
  /** Output token ceiling for one built-in agent request. */
  agentMaxTokens: 4_000,
  /** Longest task text an owner may give the built-in agent, in characters. */
  agentTaskMaxChars: 1_000,
  /** Longest wait for one model request from the built-in agent, per try; the run deadline shortens it and drops the retry when two tries would not fit. */
  agentModelTimeoutMs: 60_000,
  /** Paid-fetch calls one owner's agents together may make per minute (C22). */
  ownerPayRequestsPerMinute: 60,
  /** Decision status reads one agent may make per minute (C22). */
  agentDecisionReadsPerMinute: 120,
  /** Agent keys one owner may hold at once, revoked ones not counted. */
  agentsPerOwnerMax: 20,
  /** Agent keys one owner may create per hour. */
  agentCreatesPerHour: 10,
  /** Rate counter rows are kept this long, longer than the longest window that reads them (a day). */
  rateCounterRetentionMs: 90_000_000,
  /** A paid call stops waiting for settlement after this long and answers 'paid', settlement pending; under Vercel's 300 s function limit. */
  paidFetchDeadlineMs: 240_000,
  /** Function duration requested by the slow routes, Vercel's maximum on every plan with Fluid compute. */
  slowRouteMaxDurationS: 300,
  /** Failed settlement reads tolerated after a payment's window closes before it is treated as unverifiable and the owner paused (C8). */
  settlementUnverifiableReads: 6,
  /** How long signed payment material may land on chain, when the network accepts a timestamp bound on a gasless send. */
  paymentMaterialTtlMs: 120_000,
  /** Time one jobs tick may spend before it stops starting new owners, under the route's 300 s limit. */
  tickTimeBudgetMs: 240_000,
  /** Submit attempts a pending memory gets before it is marked failed. */
  memoryWriteMaxAttempts: 5,
  /** A memory write job still not done after this long is marked failed: six hours. */
  memoryJobMaxAgeMs: 21_600_000,
  /** Memory blob ids checked against the chain per owner per tick. */
  blobConfirmBatch: 50,
  /**
   * How long after Walrus Memory confirms a memory the tick keeps looking for its blob on chain:
   * three days. Each look is a Tatum GraphQL listing that costs credits, and a blob still missing
   * after this long is never shown on /proof (C18, C21).
   */
  blobChainCheckMaxAgeMs: 259_200_000,
  /** How long after Walrus Memory confirms a memory before its blob is first looked for, since a blob that new may not be listed yet. */
  blobChainCheckMinAgeMs: 60_000,
  /** Expired rows deleted per table per tick. */
  pruneBatch: 1_000,
  /** How long the seller reuses one current-epoch read for its challenges. */
  epochCacheMs: 60_000,
  /**
   * The fixed window in which one sale waiting on the chain may be read again, at most once:
   * each recheck costs up to chainReadAfterWriteTries Tatum reads, and anyone holding the bytes
   * can ask (C21, C22).
   */
  sellerRecheckIntervalMs: 30_000,
  /** Unpaid seller challenges issued per minute across every caller (C22). */
  sellerChallengesPerMinuteGlobal: 300,
  /** zkLogin sign-in checks against the chain per minute across every caller (C22). */
  zkLoginChecksPerMinute: 30,
  /** zkLogin sign-in checks against the chain per day across every caller (C22). */
  zkLoginChecksPerDay: 2_000,
  /** The fixed window every count above named per minute is measured over (C22). */
  rateWindowMinuteMs: 60_000,
  /** The fixed window every count above named per hour is measured over (C22). */
  rateWindowHourMs: 3_600_000,
  /** The fixed window every count above named per day is measured over, except refills (purseRefillWindowMs). */
  rateWindowDayMs: 86_400_000,
  /** Sign-in requests one client may make in a minute, for the nonce and verify steps separately (C22). */
  signInRequestsPerMinute: 10,
  /** Sign-in requests every client together may make in a minute, for each step separately (C22). */
  signInRequestsPerMinuteGlobal: 300,
  /** Random bytes in a sign-in nonce: 128 bits, so a nonce cannot be guessed before it expires (C14). */
  signinNonceBytes: 16,
  /** Longest address the sign-in nonce step reads. A Sui address is 66 characters. */
  signinAddressMaxChars: 128,
  /** Longest sign-in message the verify step reads; completeSignIn refuses any longer than it issues. */
  signinMessageMaxChars: 1_024,
  /** Longest signature the verify step reads. A multisig with zkLogin members can reach 16 KiB. */
  signinSignatureMaxChars: 16_384,
  /** Largest sign-in nonce request body, in bytes: { address } is under 100. */
  signinNonceBodyMaxBytes: 1_024,
  /** Largest sign-in verify request body, in bytes: the longest message and signature it reads come to 17 KiB. */
  signinVerifyBodyMaxBytes: 32_768,
  /** Largest answer body, in bytes: { answer, reason } with reasonMaxChars code points at up to 12 bytes each once escaped as JSON. */
  answerBodyMaxBytes: 8_192,
  /** Largest new agent key body, in bytes: { label } of 60 code points at up to 12 bytes each once escaped. */
  agentLabelBodyMaxBytes: 1_024,
  /** Largest onboarding build body, in bytes: a step, two amounts of at most 19 digits and a day count. */
  onboardingBuildBodyMaxBytes: 1_024,
  /** Largest onboarding confirm body, in bytes: a step and a digest of at most 44 characters. */
  onboardingConfirmBodyMaxBytes: 1_024,
  /** Largest settings body, in bytes: seven settings, each a short number, amount or boolean. */
  settingsBodyMaxBytes: 1_024,
  /**
   * Largest agent request body, in bytes. A seller body of challengeMaxBytes at up to 6 bytes a byte
   * once escaped (196,608), a purpose (6,000), a URL (12,288) and a content type stay under 220,000.
   */
  agentBodyMaxBytes: 262_144,
  /** Largest built-in agent task body, in bytes: agentTaskMaxChars code points at up to 12 bytes each, plus 1 KiB for the key. */
  agentTaskBodyMaxBytes: 13_024,
  /** Longest content type an agent may ask Ellai to forward; paidFetch then allows only a plain media type. */
  agentContentTypeMaxChars: 512,
  /** Longest decision id check_decision reads. A real one is a 36-character uuid. */
  decisionIdMaxChars: 64,
  /** Characters of a token's random part shown to tell keys apart: 36 of its 256 bits, far from guessable. */
  tokenDisplayChars: 6,
  /** Longest error sentence passed to a caller; a longer one is replaced by fixed text (C17). */
  errorMessageMaxChars: 300,
  /** Rows on one page of an owner's history when the query names no limit. */
  ownerPageDefault: 20,
  /** Most rows on one page of an owner's history; a larger limit is cut to this. */
  ownerPageMax: 50,
  /** Unanswered questions listed at once, so one page reads at most this times decideMaxCitedMemories citations. */
  questionsPerPage: 50,
  /** Latest verified payments and latest on-chain memories /proof lists (C22: it is one cached read). */
  publicProofLatest: 20,
  /** The span the overview counts decisions and verified payments over: 30 days. */
  overviewCountWindowMs: 2_592_000_000,
  /** Latest approved or asked decisions the overview's question rate is taken over; its questionsPer20 field is named for it. */
  overviewQuestionWindow: 20,
  /** Fewest approvals an owner may require before Ellai pays on its own; the owners table allows the same. */
  approvalsNeededMin: 1,
  /** Most approvals an owner may require; the owners table allows the same. */
  approvalsNeededMax: 10,
  /** Widest distance cutoff an owner may set: cosine distance 1 is unrelated, so a wider one would count opposites as alike. */
  distanceCutoffMax: 1,
  /** The per-payment maximum every owner starts with: 0.05 USDC, the owners table's default. Sellers priced above it are not offered to the built-in agent. */
  defaultPerPaymentMaxAtomic: 50_000,
  /** The span the daily budget counts signed payments over: any 24 hours (C4). */
  dailyBudgetWindowMs: 86_400_000,
  /** The span purseMaxRefillsPerDay is counted over: the 24 hours before now, every refill sent whatever its status. */
  purseRefillWindowMs: 86_400_000,
  /** The allowance's on-chain rate window: its daily limit is what the purse may draw in one fixed day. */
  allowancePeriodMs: 86_400_000,
  /**
   * The fixed window a payment's failed settlement reads are counted in, shorter than
   * rateCounterRetentionMs so pruning never deletes a count in use; a count cut by a window
   * boundary starts again, which can delay the verdict but never hasten it.
   */
  settlementUnreadableWindowMs: 86_400_000,
  /** How long an ended session row is kept, so a sign-out or a revoke can still be looked into. */
  endedSessionKeepMs: 86_400_000,
  /** A paid request ends at least this long before its call's deadline, so storing what the seller did and answering still fit. */
  paidRequestMarginMs: 10_000,
  /** Less of a built-in agent run than this left, and no model request or paid call is started. */
  agentRunMinLeftMs: 20_000,
  /** Every built-in agent model request ends at least this long before the run's deadline, so the answer still reaches the owner. */
  agentModelMarginMs: 10_000,
  /**
   * Retries the model client makes after a failed request: one, not the SDK's two, since the owner
   * is waiting on the page and a second failure in a row is reported rather than waited out.
   */
  agentModelRetries: 1,
  /** Bulk writes one memory pass makes: what memwalPointsPerMinute holds at memwalBulkPoints each, since a pass holds its rows locked while core paces. */
  memoryWritesPerPass: 3,
} as const;
