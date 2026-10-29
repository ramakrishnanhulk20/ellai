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
  /**
   * Longest GraphQL page cursor taken in or handed back. Sui's are base64 well under this, and
   * the web app keeps the blob scan's in owners.blob_scan_cursor, which holds 512 characters.
   */
  graphqlCursorMaxChars: 512,
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
  /**
   * How long a gRPC connection carries calls before grpc-js pings it to check the far end is still
   * there; pings go out only while a call is open. grpc-js sends none by default, so a connection
   * the network dropped without a word (a NAT that forgot it, a serverless instance thawing) failed
   * every call at tatumTimeoutMs. With grpcKeepaliveTimeoutMs this notices a dead connection inside
   * one call's deadline, so bounded() sends its retry on a fresh one.
   */
  grpcKeepaliveTimeMs: 5_000,
  /** How long grpc-js waits for a keepalive ping's answer before it drops the connection. Tatum answers in about 0.3 s. */
  grpcKeepaliveTimeoutMs: 3_000,
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
  /**
   * Coins of one type a listing of an owner's coins returns, and so the most USDC coins one move into
   * the address balance takes and the most SUI coins one owner transaction names as gas. Each is an
   * owned object reference of about 75 bytes, so 50 of each come to about 7.5 KB, far inside
   * onboardingSubmitTxMaxBytes, Sui's 2,048 input objects and its 256 gas coins a transaction, and
   * gas grows with every coin loaded. An owner holding more USDC coins signs the move again.
   */
  ownedCoinsMax: 50,
  /** Pages one listing of an owner's coins reads, each asking for ownedCoinsMax, since the service may answer with fewer a page. */
  ownedCoinsMaxPages: 3,
  /**
   * Gas budget the owner signs for when moving USDC coins into the address balance: 0.05 SUI, the
   * allowance step's own budget, so an owner who can pay for one can pay for the other. A one-coin
   * move simulated on mainnet on 2026-10-28 charged about 0.0011 SUI and returned 0.0023 SUI of
   * storage; a move of ownedCoinsMax coins has not been measured.
   */
  usdcMoveGasBudgetMist: 50_000_000,
  /**
   * AllowanceCap objects per GraphQL page when looking for the one that ends an owner's allowance.
   * Each allowance an owner issues leaves one cap in their wallet, so an owner has a handful at most.
   */
  allowanceCapPageSize: 50,
  /** Pages of caps read before giving up on finding the one for an allowance, so a wallet sent many objects cannot keep us looping. */
  allowanceCapMaxPages: 2,
  /**
   * Gas budget the owner signs for when ending their allowance: 0.003 SUI. The revoke's computation
   * charge is a fixed 1,000 gas units (DECISIONS.md, 2026-10-28), so at maxGasPriceMist, the highest
   * price Ellai builds with, it is 1,000,000 MIST, and this leaves room beside it for the storage the
   * transaction writes. Deleting the allowance and its cap returns more storage rebate than the
   * revoke costs, so the owner pays far less than this.
   */
  revokeGasBudgetMist: 3_000_000,
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
  /**
   * Wait after the anonymous gateway answers "rate limited" before the same step is tried again.
   * Longer than one pacing window. With a key the limit is per second, so a Walrus Memory account
   * step waits tatumRetryDelayMs, doubling, instead.
   */
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
  /**
   * Ceiling on one whole SDK call to the relayer (C21). Before its request the SDK may check the
   * relayer's version, then its health, and fetch its config, each up to memwalRequestTimeoutMs,
   * and build a SEAL session whose read of Sui has no limit of its own. Four requests at the
   * request ceiling is the slowest call that is still working.
   */
  memwalCallTimeoutMs: 120_000,
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
  /**
   * How often the gas wallet's SUI is read, across every jobs tick and server instance: once an
   * hour, not every tick (C21, C22). It falls only by sponsored refill gas, at most
   * LIMITS.refillGasBudgetMist a refill, so a reading an hour old is close enough to warn on.
   */
  gasWalletCheckIntervalMs: 3_600_000,
  /** Paid-fetch calls one agent may make per minute through the agent API or MCP (C22). */
  agentCallsPerMinute: 30,
  /** Reads one owner may make per minute on owner routes that touch Tatum (C22). */
  ownerChainReadsPerMinute: 30,
  /**
   * Tatum calls, not requests, one owner's requests to owner routes may make in a day (C22). Each
   * request is counted at the calls its success path makes for what it asked (the overview 1,
   * onboarding 2 to 5 by step), since the minute's cap alone would let one owner spend 43,200.
   */
  ownerChainReadsPerDay: 200,
  /**
   * Tatum calls, not requests, owner routes may make in a day across every owner together, counted
   * the same way (C22). Any wallet signs in for free, so per-owner caps alone bound nothing; this is
   * at most 2,000 of the 100,000 lifetime credits a day.
   */
  ownerChainReadsPerDayGlobal: 1_000,
  /**
   * Tatum calls owner routes may make in a day for requests from one client, keyed on the address
   * the platform vouches for, however many free wallets it signs in (C34). Spending
   * LIMITS.ownerChainReadsPerDayGlobal then takes at least 4 clients.
   */
  ownerChainCallsPerClientPerDay: 300,
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
  /**
   * The jobs tick's deadline, from its start: past it no owner is started and no step starts a
   * new external call (C21, C28). The longest single unit that may begin just before it is the
   * gas wallet's balance pages at about 165 s (balanceMaxPages reads, each three tries of
   * tatumTimeoutMs plus the retry waits), so 100 s plus 165 s still ends inside tickEndByMs. A
   * settlement pass is now one digest read and one epoch read, since a release takes two passes.
   * jobs.test.ts works this out from these numbers.
   */
  tickTimeBudgetMs: 100_000,
  /** The latest a jobs tick may still be working: 20 s under the jobs route's 300 s, left for its last database writes and its reply. */
  tickEndByMs: 280_000,
  /** Submit attempts a pending memory gets before it is marked failed. */
  memoryWriteMaxAttempts: 5,
  /** A memory write job still not done after this long is marked failed: six hours. */
  memoryJobMaxAgeMs: 21_600_000,
  /** Memories marked expired per owner per tick once the Walrus epoch passes their Blob's end; the rest wait for the next tick. */
  blobConfirmBatch: 50,
  /**
   * How long after Walrus Memory confirms a memory the tick keeps looking for its blob on chain:
   * three days. Each look is a Tatum GraphQL listing that costs credits, and a blob still missing
   * after this long is never shown on /proof (C18, C21).
   */
  blobChainCheckMaxAgeMs: 259_200_000,
  /** How long after Walrus Memory confirms a memory before its blob is first looked for, since a blob that new may not be listed yet. */
  blobChainCheckMinAgeMs: 60_000,
  /** Expired rows deleted per table in one delete; prune repeats it until a batch comes back short. */
  pruneBatch: 1_000,
  /**
   * Longest one tick spends pruning, so cleanup cannot eat the owners' time budget. At pruneBatch
   * rows a delete this still outpaces every global cap on anonymous rows (C22, C34).
   */
  pruneTimeSliceMs: 5_000,
  /** How long a seller sale still waiting on the chain is kept for its buyer to present again: 30 days. */
  sellerWaitingSaleKeepMs: 2_592_000_000,
  /** How long an owner row with nothing but expired sessions is kept: a day. Sign-in creates one for any wallet. */
  emptyOwnerKeepMs: 86_400_000,
  /**
   * How long a memory may wait on refusals that are not about it (rate limits, an outage) before
   * it is marked failed: three days. Only refusals about the rows spend memoryWriteMaxAttempts (C33).
   */
  memoryWriteMaxAgeMs: 259_200_000,
  /** GraphQL pages of an owner's Walrus Blob objects read per tick; the next tick resumes where this one stopped. */
  blobScanPagesPerTick: 20,
  /** How long one read of the current Walrus epoch is reused in a process: an hour, since a Walrus Mainnet epoch lasts about two weeks. */
  walrusEpochCacheMs: 3_600_000,
  /**
   * How long the seller reuses one current-epoch read for its challenges: an hour. A challenge
   * names the window [E, E + 1], and a reading under an epoch's length old (about a day on
   * mainnet) means the chain is in E or E + 1, so the window is still open when issued.
   */
  epochCacheMs: 3_600_000,
  /**
   * The fixed window in which one sale waiting on the chain may be read again, at most once:
   * each recheck costs up to chainReadAfterWriteTries Tatum reads, and anyone holding the bytes
   * can ask (C21, C22).
   */
  sellerRecheckIntervalMs: 30_000,
  /**
   * Rechecks of waiting sales and redeliveries of paid, undelivered checks a day across every sale
   * together (C22). A recheck costs up to 10 gRPC calls and a redelivery about 3 (up to 25 for an
   * address with many blobs), and anyone holding a sale's bytes may ask once every
   * LIMITS.sellerRecheckIntervalMs, so this holds all of them to about 2,500 calls a day at worst.
   */
  sellerRechecksPerDayGlobal: 100,
  /** Redeliveries one paid sale may ask for in its lifetime, so one address whose check keeps failing cannot spend the day's rechecks for every buyer (C22, C29). */
  sellerRedeliveriesPerSale: 5,
  /** Unpaid seller challenges issued per minute across every caller (C22). */
  sellerChallengesPerMinuteGlobal: 300,
  /**
   * Payments one client may have the seller send through Tatum in a minute (C22). A send is a paid
   * call that goes out even for bytes an empty wallet signed, so it is counted only once every
   * offline check has passed, just before the call.
   */
  sellerExecutesPerClientPerMinute: 3,
  /** Payments one client may have the seller send in a day, so one caller cannot spend the shared day alone (C34). */
  sellerExecutesPerClientPerDay: 20,
  /**
   * Payments the seller sends for every caller together in a day (C22). A send is 1 to 2 gRPC calls
   * when Tatum answers, so strangers can spend at most about 600 of the 100,000 lifetime credits a
   * day this way, and a sale that settles pays 0.01 USDC for its wallet check's reads.
   */
  sellerExecutesPerDayGlobal: 150,
  /** zkLogin sign-in checks against the chain per minute across every caller (C22). */
  zkLoginChecksPerMinute: 30,
  /**
   * zkLogin sign-in checks against the chain per day across every caller (C22). Each is a paid
   * Tatum read from a lifetime credit pool, so this is sized to the credit budget, not to demand.
   */
  zkLoginChecksPerDay: 300,
  /** zkLogin sign-in checks against the chain per minute from one client, so one caller cannot take the shared quota alone (C34). */
  zkLoginChecksPerClientPerMinute: 3,
  /** zkLogin sign-in checks against the chain per day from one client, so one caller cannot spend the shared day quota alone; it takes LIMITS.zkLoginChecksPerDay / 20 clients (C34). */
  zkLoginChecksPerClientPerDay: 20,
  /** zkLogin members a multisig sign-in may carry; each costs its own chain check. */
  zkLoginMembersMax: 2,
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
  /** How long an owner has to sign a step-up message for a loosening change: five minutes, long enough to read it in a wallet (C36). */
  stepUpTtlMs: 300_000,
  /** Step-up messages one owner may ask for in an hour; each is a stored row and a possible chain check (C22). */
  stepUpsPerOwnerPerHour: 20,
  /** Sign-ins one client may complete in a day. Each can create an owner row and a session for any wallet (C22, C34). */
  signInsPerClientPerDay: 30,
  /** Sign-ins every client together may complete in a day, so owner and session rows standing stay small (C34). */
  signInsPerDayGlobal: 2_000,
  /**
   * Requests to Tatum (each page and each retry counts) that everything a person can start may
   * make in a day: anonymous callers, owners and their agents together. Tatum's free plan is a
   * lifetime pool, so this is sized to the credit budget; past it those paths answer
   * chain_unavailable_today and never call Tatum (C22).
   */
  tatumCallsPerDayGlobal: 1_500,
  /** Requests to Tatum the jobs tick may make in a day, apart from the global count so strangers cannot starve settlement and refills. */
  tatumCallsJobsPerDay: 1_500,
  /** Requests to Tatum one owner and that owner's agents may cause in a day. */
  tatumCallsPerOwnerPerDay: 300,
  /**
   * Requests to Tatum the jobs tick may make for one owner in a day, counted before the shared
   * jobs day, so owners who cost the tick reads without paying cannot starve everyone else's
   * settlement (C22, C28). Refills draw from tatumCallsRefillsPerDay instead.
   */
  tatumCallsJobsPerOwnerPerDay: 200,
  /**
   * Requests to Tatum the refill step may make in a day, a pool of its own that the payments step
   * cannot spend, so owners holding many unsettled payments cannot stop other owners' purses
   * being refilled (C22, C23, C28).
   */
  tatumCallsRefillsPerDay: 500,
  /**
   * The least time between two tick reads of one pending payment whose window is still open: an
   * hour. The paid call read it already, and a payment the seller is holding back costs a read
   * per tick otherwise (C22).
   */
  pendingPaymentReadIntervalMs: 3_600_000,
  /** How long the refill step waits after a failed dry run before trying again: an hour, since the owner may top up their wallet at any time and failed rows already count toward purseMaxRefillsPerDay. */
  refillDryRunWaitMs: 3_600_000,
  /**
   * Requests to Tatum callers with no owner (strangers buying a wallet check, sign-in) may cause
   * in a day, counted inside tatumCallsPerDayGlobal, so they can never take the share owners need
   * to pay (C22).
   */
  tatumCallsAnonymousPerDay: 500,
  /** Pay-requests one client may send through every agent token it holds in a day (C22, C34). */
  agentFetchesPerClientPerDay: 2_000,
  /** Pay-requests every agent together may send in a day; each one writes a decision row (C34). */
  agentFetchesPerDayGlobal: 20_000,
  /** How long a decision that closed without a payment (refused, expired, failed) is kept: 30 days (C34). */
  closedDecisionKeepMs: 2_592_000_000,
  /**
   * The least time between the two tick passes that must both see a payment's window closed and
   * its digest missing before it is released: 30 minutes, so one lagging node read can never free
   * the budget (C4, C27).
   */
  paymentReleaseGapMs: 1_800_000,
  /** An allowance that expires sooner than this is treated as unable to pay a refill: 10 minutes, so a send cannot abort after its dry run (C30). */
  allowanceExpiryMarginMs: 600_000,
  /** How long the seller remembers a failed epoch read before trying again, so an outage does not start a read per challenge (C22). */
  epochFailureCacheMs: 30_000,
  /** Largest distance a recall hit can honestly carry (cosine distance runs from 0 to 2); anything outside asks (C12). */
  recallDistanceMax: 2,
  /** Step-up messages one session may ask for in an hour, so a stolen session cannot use up the owner's allowance (C36). */
  stepUpsPerSessionPerHour: 10,
  /** Agent creates one session may attempt in an hour, so a stolen session cannot use up the owner's allowance (C36). */
  agentCreatesPerSessionPerHour: 5,
  /** Requests to Tatum one client may cause in a day, across every owner it signs in as (C34). */
  tatumCallsPerClientPerDay: 300,
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
  /**
   * Largest signed onboarding transaction the submit route relays, in bytes. Ellai's own builds are
   * under 1 KiB apart from the gas coins Tatum picks for an account step, and the SDK picks at most
   * 256 of those at 73 bytes each (about 19 KiB), so every build fits and nothing much larger is decoded.
   */
  onboardingSubmitTxMaxBytes: 32_768,
  /** Longest signature the submit route relays. A multisig with zkLogin members can reach 16 KiB, and core's executeTransaction refuses longer. */
  onboardingSubmitSignatureMaxChars: 16_384,
  /**
   * Largest onboarding submit body, in bytes: the largest transaction as base64 (43,692 characters),
   * the longest signature (16,384) and the keys come to under 60,200.
   */
  onboardingSubmitBodyMaxBytes: 61_440,
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
  /**
   * Latest on-chain owner answers the public memory map lists. The map is one cached read a
   * window (C22), and this keeps that read and its answer small however long the history grows.
   */
  memoryMapMemories: 200,
  /**
   * Latest decisions the public memory map lists. Each cites at most decideMaxCitedMemories
   * memories, so the map's citation read is bounded at 50 times that, 1,000 rows.
   */
  memoryMapDecisions: 50,
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
  /** Bulk writes one memory pass makes: what memwalPointsPerMinute holds at memwalBulkPoints each, so core never has to pause a pass to pace it. */
  memoryWritesPerPass: 3,
  /**
   * How long a memory handed to the relayer stays claimed by that pass, counted from the pass's
   * start, before another pass may send it: six minutes (C33). Each SDK call is cut off at
   * memwalCallTimeoutMs, but a request already signed inside it may still go out, and the hard
   * bound on a pass is its route's slowRouteMaxDurationS (the jobs route's 300 s). Past that the
   * pass has recorded its job ids or been killed. Under the 10-minute jobs tick, so a row a rate
   * limit turned away goes again at the next tick.
   */
  memoryWriteLeaseMs: 360_000,
  /**
   * How long one visit holds an owner, the scheduled tick's included: slowRouteMaxDurationS, the
   * ceiling of every route a visit runs under, so a lease outlives any run that holds it and frees
   * itself if the function is killed. A test holds the two equal.
   */
  ownerVisitLeaseMs: 300_000,
  /** Wait between two passes of one owner's visit while a relayer write is awaiting confirmation. */
  ownerVisitPassGapMs: 10_000,
  /** Passes in one owner's visit: the seven waits between eight passes fit inside the visit's time budget, tickTimeBudgetMs. */
  ownerVisitMaxPasses: 8,
  /** The overview starts a visit only when the owner's last visit is older than this, since screens load it after every action. */
  ownerVisitMinGapMs: 60_000,
} as const;
