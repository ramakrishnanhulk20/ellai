import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const AGENT_KINDS = ['external', 'builtin'] as const;
export const SELLER_METHODS = ['GET', 'POST'] as const;
export const DECISION_OUTCOMES = ['approved', 'refused', 'asked'] as const;
export const DECISION_RULES = [
  'paused',
  'over_payment_max',
  'over_daily_budget',
  'refused_recipient',
  'bad_outcome',
  'grant',
  'learned',
  'recall_unavailable',
  'no_match',
  'too_many_pending',
] as const;
export const DECISION_STATUSES = ['open', 'paid', 'asked', 'answered', 'refused', 'expired', 'failed'] as const;
/** Statuses in which a decision can still lead to a payment, so only one may exist per request. */
export const LIVE_DECISION_STATUSES = ['open', 'asked'] as const;
export const VERDICTS = ['approve', 'refuse'] as const;
export const MEMORY_KINDS = ['owner_decision', 'outcome'] as const;
export const MEMORY_STATUSES = ['pending', 'confirmed', 'failed'] as const;
export const SETTLEMENTS = ['pending', 'verified', 'mismatch', 'not_landed'] as const;
export const REFILL_STATUSES = ['pending', 'verified', 'failed'] as const;
export const SALE_STATUSES = ['issued', 'settled', 'rejected'] as const;
/** Owner actions that loosen what Ellai may do, and so need a fresh wallet signature on top of the session. */
export const STEP_UP_ACTIONS = ['create_agent', 'loosen_settings'] as const;

/**
 * Longest text, in characters, the database accepts in each column that an agent, a
 * seller, an owner or an upstream service can influence. Code should refuse longer input
 * before it gets here; these checks are the backstop that holds if it does not.
 */
export const TEXT_CAPS = {
  autoPausedReason: 200,
  agentLabel: 60,
  /** The longer token prefix (14 characters) and 6 characters of the random part, with room. */
  tokenPrefix: 24,
  sellerUrl: 2_048,
  sellerHost: 253,
  purpose: 500,
  decisionReason: 400,
  answerReason: 300,
  mismatchReason: 200,
  sentence: 1_000,
  /** A normalised Sui address or object id: 0x and 64 hex characters. */
  suiId: 66,
  requestKey: 128,
  /** Matches LIMITS.challengeIdMaxLength in core. */
  challengeField: 128,
  asset: 256,
  network: 32,
  /** A base58 transaction digest is at most 44 characters. */
  digest: 64,
  /** Matches LIMITS.memwalNamespaceMaxLength in core. */
  namespace: 64,
  relayerId: 128,
  rateKey: 200,
  /** A GraphQL page cursor is opaque; Sui's are base64 well under this. */
  pageCursor: 512,
  /** A step-up message: Ellai's domain, the address, one line per changed setting, nonce and times. */
  stepUpMessage: 2_000,
} as const;

const RESTRICT = { onDelete: 'restrict' } as const;

const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at('created_at').notNull().defaultNow();
const atomic = (name: string) => bigint(name, { mode: 'bigint' });

// The values are the constant arrays and numbers in this file, never input, so
// inlining them is safe and keeps the generated DDL free of bind parameters, which a
// CHECK or an index predicate cannot hold.
function literals(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${literals(values)})`);
}

function maxLength(name: string, column: AnyPgColumn, max: number) {
  return check(name, sql`char_length(${column}) <= ${sql.raw(String(max))}`);
}

function positive(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} > 0`);
}

// A child row carries its own owner_id, and this key makes (parent id, owner_id) name one
// parent row of that same owner, so no row can tie one owner's records to another's,
// whatever a later query gets wrong. Postgres's default MATCH SIMPLE skips the check when
// the parent id is null, which is how an optional link stays optional.
function sameOwner(name: string, columns: [AnyPgColumn, AnyPgColumn], foreignColumns: [AnyPgColumn, AnyPgColumn]) {
  return foreignKey({ name, columns, foreignColumns }).onDelete('restrict');
}

export const owners = pgTable(
  'owners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    suiAddress: text('sui_address').notNull().unique(),
    purseAddress: text('purse_address').notNull().unique(),
    memwalAccountId: text('memwal_account_id').unique(),
    delegateRegisteredAt: at('delegate_registered_at'),
    allowanceId: text('allowance_id').unique(),
    allowanceCheckedAt: at('allowance_checked_at'),
    // drizzle-kit 0.31 cannot serialise a BigInt default, so these two are SQL literals.
    perPaymentMaxAtomic: atomic('per_payment_max_atomic').notNull().default(sql`50000`),
    dailyBudgetAtomic: atomic('daily_budget_atomic').notNull().default(sql`500000`),
    approvalsNeeded: integer('approvals_needed').notNull().default(2),
    distanceCutoff: real('distance_cutoff').notNull().default(0.5),
    paused: boolean('paused').notNull().default(false),
    autoPausedReason: text('auto_paused_reason'),
    // The proof page names an owner's payments only with their say, since each digest leads to their wallet.
    publicProof: boolean('public_proof').notNull().default(false),
    // The jobs tick visits owners least recently visited first, so no owner waits behind the earliest ones.
    lastTickedAt: at('last_ticked_at'),
    // Where the chain check of this owner's Walrus Blob objects stopped, since one tick reads a
    // bounded number of pages and anyone can send Blob objects to an address.
    blobScanCursor: text('blob_scan_cursor'),
    // An allowance whose rate window has no room for a refill cannot change before the window
    // ends, so the tick does not ask the chain again until then (C22).
    refillNotBefore: at('refill_not_before'),
    createdAt: createdAt(),
  },
  (t) => [
    // Sign-in creates an owner row for any wallet, so pruning finds old empty ones through this.
    index('owners_created_at_idx').on(t.createdAt),
    check('owners_approvals_needed_range', sql`${t.approvalsNeeded} between 1 and 10`),
    maxLength('owners_blob_scan_cursor_length', t.blobScanCursor, TEXT_CAPS.pageCursor),
    check('owners_distance_cutoff_range', sql`${t.distanceCutoff} > 0 and ${t.distanceCutoff} <= 2`),
    maxLength('owners_sui_address_length', t.suiAddress, TEXT_CAPS.suiId),
    maxLength('owners_memwal_account_id_length', t.memwalAccountId, TEXT_CAPS.suiId),
    maxLength('owners_allowance_id_length', t.allowanceId, TEXT_CAPS.suiId),
    maxLength('owners_auto_paused_reason_length', t.autoPausedReason, TEXT_CAPS.autoPausedReason),
  ],
);

// Anonymous callers can fill these three tables up to the global caps, so pruning finds expired
// rows through an index instead of sorting the table.
export const signinNonces = pgTable(
  'signin_nonces',
  {
    nonce: text('nonce').primaryKey(),
    createdAt: createdAt(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
  },
  (t) => [index('signin_nonces_expires_at_idx').on(t.expiresAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: at('expires_at').notNull(),
    revokedAt: at('revoked_at'),
  },
  (t) => [index('sessions_expires_at_idx').on(t.expiresAt), index('sessions_owner_expires_at_idx').on(t.ownerId, t.expiresAt)],
);

// One row per change an owner was asked to sign: the exact message, and a hash of the exact
// change it names, so the signature authorises that change once and nothing else. They expire in
// minutes, and pruning removes expired ones before it removes empty owners.
export const stepUps = pgTable(
  'step_ups',
  {
    nonce: text('nonce').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    action: text('action', { enum: STEP_UP_ACTIONS }).notNull(),
    changeHash: text('change_hash').notNull(),
    message: text('message').notNull(),
    createdAt: createdAt(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
  },
  (t) => [
    index('step_ups_expires_at_idx').on(t.expiresAt),
    index('step_ups_owner_idx').on(t.ownerId),
    oneOf('step_ups_action_known', t.action, STEP_UP_ACTIONS),
    check('step_ups_change_hash_hex', sql`${t.changeHash} ~ '^[0-9a-f]{64}$'`),
    maxLength('step_ups_message_length', t.message, TEXT_CAPS.stepUpMessage),
  ],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    label: text('label').notNull(),
    kind: text('kind', { enum: AGENT_KINDS }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    maxPending: integer('max_pending').notNull().default(5),
    createdAt: createdAt(),
    revokedAt: at('revoked_at'),
  },
  (t) => [
    unique('agents_id_owner_id_unique').on(t.id, t.ownerId),
    index('agents_owner_idx').on(t.ownerId),
    // The built-in agent is found by kind, not by id, so a second live one for an owner would
    // leave which agent acts to row order. A revoked one no longer counts.
    uniqueIndex('agents_one_live_builtin_per_owner')
      .on(t.ownerId)
      .where(sql`${t.kind} = 'builtin' and ${t.revokedAt} is null`),
    check('agents_label_length', sql`char_length(${t.label}) between 1 and ${sql.raw(String(TEXT_CAPS.agentLabel))}`),
    oneOf('agents_kind_known', t.kind, AGENT_KINDS),
    maxLength('agents_token_prefix_length', t.tokenPrefix, TEXT_CAPS.tokenPrefix),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    agentId: uuid('agent_id').notNull(),
    requestKey: text('request_key').notNull(),
    sellerUrl: text('seller_url').notNull(),
    sellerMethod: text('seller_method', { enum: SELLER_METHODS }).notNull(),
    sellerHost: text('seller_host').notNull(),
    bodyHash: text('body_hash').notNull(),
    purpose: text('purpose').notNull(),
    recipient: text('recipient').notNull(),
    amountAtomic: atomic('amount_atomic').notNull(),
    asset: text('asset').notNull(),
    network: text('network').notNull(),
    challengeId: text('challenge_id'),
    nonce: text('nonce'),
    minEpoch: bigint('min_epoch', { mode: 'bigint' }),
    maxEpoch: bigint('max_epoch', { mode: 'bigint' }),
    expiresAt: at('expires_at').notNull(),
    outcome: text('outcome', { enum: DECISION_OUTCOMES }).notNull(),
    rule: text('rule', { enum: DECISION_RULES }).notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: DECISION_STATUSES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('decisions_id_owner_id_unique').on(t.id, t.ownerId),
    sameOwner('decisions_agent_same_owner_fk', [t.agentId, t.ownerId], [agents.id, agents.ownerId]),
    // The owner's history pages read newest first from a time, so a page costs an index range,
    // not a pass over every decision the owner ever had.
    index('decisions_owner_created_at_idx').on(t.ownerId, t.createdAt),
    // A retry of a request that is still open or asked must find the first decision,
    // never start a second one that could be paid as well (C5). Once the first has
    // reached any other status, the same request may be decided afresh.
    uniqueIndex('decisions_live_request_unique')
      .on(t.ownerId, t.requestKey)
      .where(sql`${t.status} in (${literals(LIVE_DECISION_STATUSES)})`),
    positive('decisions_amount_positive', t.amountAtomic),
    oneOf('decisions_seller_method_known', t.sellerMethod, SELLER_METHODS),
    oneOf('decisions_outcome_known', t.outcome, DECISION_OUTCOMES),
    oneOf('decisions_rule_known', t.rule, DECISION_RULES),
    oneOf('decisions_status_known', t.status, DECISION_STATUSES),
    maxLength('decisions_request_key_length', t.requestKey, TEXT_CAPS.requestKey),
    maxLength('decisions_seller_url_length', t.sellerUrl, TEXT_CAPS.sellerUrl),
    maxLength('decisions_seller_host_length', t.sellerHost, TEXT_CAPS.sellerHost),
    maxLength('decisions_purpose_length', t.purpose, TEXT_CAPS.purpose),
    maxLength('decisions_recipient_length', t.recipient, TEXT_CAPS.suiId),
    maxLength('decisions_asset_length', t.asset, TEXT_CAPS.asset),
    maxLength('decisions_network_length', t.network, TEXT_CAPS.network),
    maxLength('decisions_challenge_id_length', t.challengeId, TEXT_CAPS.challengeField),
    maxLength('decisions_nonce_length', t.nonce, TEXT_CAPS.challengeField),
    maxLength('decisions_reason_length', t.reason, TEXT_CAPS.decisionReason),
  ],
);

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    kind: text('kind', { enum: MEMORY_KINDS }).notNull(),
    decisionId: uuid('decision_id'),
    recipient: text('recipient'),
    amountAtomic: atomic('amount_atomic'),
    verdict: text('verdict', { enum: VERDICTS }),
    sellerHost: text('seller_host'),
    sentence: text('sentence').notNull(),
    namespace: text('namespace').notNull(),
    writerPublicKey: text('writer_public_key').notNull(),
    jobId: text('job_id'),
    blobId: text('blob_id').unique(),
    status: text('status', { enum: MEMORY_STATUSES }).notNull().default('pending'),
    submitAttempts: integer('submit_attempts').notNull().default(0),
    submittedAt: at('submitted_at'),
    createdAt: createdAt(),
    confirmedAt: at('confirmed_at'),
    // Set only after the blob id was found among the owner's Walrus Blob objects on chain.
    chainConfirmedAt: at('chain_confirmed_at'),
    // The Walrus epoch the confirmed Blob is stored until, and when the tick saw that epoch
    // arrive, so /proof stops showing a memory Walrus no longer keeps (C18).
    blobEndEpoch: integer('blob_end_epoch'),
    chainExpiredAt: at('chain_expired_at'),
  },
  (t) => [
    unique('memories_id_owner_id_unique').on(t.id, t.ownerId),
    sameOwner('memories_decision_same_owner_fk', [t.decisionId, t.ownerId], [decisions.id, decisions.ownerId]),
    // The refusal check (C11) and the learned approval (C10) read these structured
    // facts, never the sentence, so an owner decision without them could never be
    // matched and a refusal would silently stop counting.
    check(
      'memories_owner_decision_facts',
      sql`${t.kind} <> 'owner_decision' or (${t.verdict} is not null and ${t.recipient} is not null and ${t.amountAtomic} is not null)`,
    ),
    index('memories_refusal_lookup_idx').on(t.ownerId, t.recipient, t.verdict),
    index('memories_owner_created_at_idx').on(t.ownerId, t.createdAt),
    oneOf('memories_kind_known', t.kind, MEMORY_KINDS),
    oneOf('memories_verdict_known', t.verdict, VERDICTS),
    oneOf('memories_status_known', t.status, MEMORY_STATUSES),
    maxLength('memories_recipient_length', t.recipient, TEXT_CAPS.suiId),
    maxLength('memories_seller_host_length', t.sellerHost, TEXT_CAPS.sellerHost),
    maxLength('memories_sentence_length', t.sentence, TEXT_CAPS.sentence),
    maxLength('memories_namespace_length', t.namespace, TEXT_CAPS.namespace),
    maxLength('memories_job_id_length', t.jobId, TEXT_CAPS.relayerId),
    maxLength('memories_blob_id_length', t.blobId, TEXT_CAPS.relayerId),
  ],
);

export const decisionCitations = pgTable(
  'decision_citations',
  {
    decisionId: uuid('decision_id').notNull(),
    memoryId: uuid('memory_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.memoryId] }),
    sameOwner('decision_citations_decision_same_owner_fk', [t.decisionId, t.ownerId], [decisions.id, decisions.ownerId]),
    sameOwner('decision_citations_memory_same_owner_fk', [t.memoryId, t.ownerId], [memories.id, memories.ownerId]),
  ],
);

export const questions = pgTable(
  'questions',
  {
    decisionId: uuid('decision_id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    createdAt: createdAt(),
    answeredAt: at('answered_at'),
    answer: text('answer', { enum: VERDICTS }),
    reason: text('reason'),
    memoryId: uuid('memory_id'),
  },
  (t) => [
    // Deleting an owner checks this foreign key, so pruning empty owners needs it indexed.
    index('questions_owner_idx').on(t.ownerId),
    sameOwner('questions_decision_same_owner_fk', [t.decisionId, t.ownerId], [decisions.id, decisions.ownerId]),
    sameOwner('questions_memory_same_owner_fk', [t.memoryId, t.ownerId], [memories.id, memories.ownerId]),
    // An answer binds future decisions from the moment it is recorded (C12), so an
    // answer with no time, or a time with no answer, is a state nothing should read.
    check('questions_answer_has_time', sql`(${t.answer} is null) = (${t.answeredAt} is null)`),
    oneOf('questions_answer_known', t.answer, VERDICTS),
    maxLength('questions_reason_length', t.reason, TEXT_CAPS.answerReason),
  ],
);

export const grants = pgTable(
  'grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    decisionId: uuid('decision_id').notNull().unique(),
    recipient: text('recipient').notNull(),
    maxAmountAtomic: atomic('max_amount_atomic').notNull(),
    sellerUrl: text('seller_url').notNull(),
    sellerMethod: text('seller_method', { enum: SELLER_METHODS }).notNull(),
    bodyHash: text('body_hash').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [
    unique('grants_id_owner_id_unique').on(t.id, t.ownerId),
    // Deleting an owner checks this foreign key, so pruning empty owners needs it indexed.
    index('grants_owner_idx').on(t.ownerId),
    sameOwner('grants_decision_same_owner_fk', [t.decisionId, t.ownerId], [decisions.id, decisions.ownerId]),
    positive('grants_max_amount_positive', t.maxAmountAtomic),
    oneOf('grants_seller_method_known', t.sellerMethod, SELLER_METHODS),
    maxLength('grants_recipient_length', t.recipient, TEXT_CAPS.suiId),
    maxLength('grants_seller_url_length', t.sellerUrl, TEXT_CAPS.sellerUrl),
  ],
);

// A use is a row keyed by its grant, so a second use of one grant is a primary key
// violation whatever the claiming query looks like, and a decision spends at most one grant.
export const grantUses = pgTable(
  'grant_uses',
  {
    grantId: uuid('grant_id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    decisionId: uuid('decision_id').notNull().unique(),
    usedAt: at('used_at').notNull().defaultNow(),
  },
  (t) => [
    sameOwner('grant_uses_grant_same_owner_fk', [t.grantId, t.ownerId], [grants.id, grants.ownerId]),
    sameOwner('grant_uses_decision_same_owner_fk', [t.decisionId, t.ownerId], [decisions.id, decisions.ownerId]),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    decisionId: uuid('decision_id').notNull().unique(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    purseAddress: text('purse_address').notNull(),
    recipient: text('recipient').notNull(),
    amountAtomic: atomic('amount_atomic').notNull(),
    digest: text('digest').notNull().unique(),
    txBytesBase64: text('tx_bytes_base64').notNull(),
    signedAt: at('signed_at').notNull(),
    validUntilEpoch: bigint('valid_until_epoch', { mode: 'bigint' }).notNull(),
    releasedAt: at('released_at'),
    sellerStatus: integer('seller_status'),
    delivered: boolean('delivered'),
    settlement: text('settlement', { enum: SETTLEMENTS }).notNull().default('pending'),
    verifiedAt: at('verified_at'),
    mismatchReason: text('mismatch_reason'),
    // When this payment's delivery or settlement was last written, so an owner's yes clears a
    // bad outcome only if the question came after the owner could have seen it (C32).
    outcomeAt: at('outcome_at').notNull().defaultNow(),
    // Separate settlement passes whose read failed after the window closed; kept on the row so
    // the count outlives however long the tick takes to come back to this owner (C8, C21).
    settlementFailedReads: integer('settlement_failed_reads').notNull().default(0),
  },
  (t) => [
    sameOwner('payments_decision_same_owner_fk', [t.decisionId, t.ownerId], [decisions.id, decisions.ownerId]),
    index('payments_owner_signed_at_idx').on(t.ownerId, t.signedAt),
    positive('payments_amount_positive', t.amountAtomic),
    check('payments_settlement_failed_reads_nonnegative', sql`${t.settlementFailedReads} >= 0`),
    oneOf('payments_settlement_known', t.settlement, SETTLEMENTS),
    maxLength('payments_recipient_length', t.recipient, TEXT_CAPS.suiId),
    maxLength('payments_mismatch_reason_length', t.mismatchReason, TEXT_CAPS.mismatchReason),
  ],
);

export const refills = pgTable(
  'refills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    allowanceId: text('allowance_id').notNull(),
    amountAtomic: atomic('amount_atomic').notNull(),
    digest: text('digest').notNull().unique(),
    sentAt: at('sent_at').notNull(),
    // The signed bytes' maxEpoch. Null only on rows written before it was kept, which go on
    // waiting for their digest as they always did.
    validUntilEpoch: bigint('valid_until_epoch', { mode: 'bigint' }),
    status: text('status', { enum: REFILL_STATUSES }).notNull().default('pending'),
    verifiedAt: at('verified_at'),
  },
  (t) => [
    index('refills_owner_idx').on(t.ownerId),
    positive('refills_amount_positive', t.amountAtomic),
    oneOf('refills_status_known', t.status, REFILL_STATUSES),
    maxLength('refills_allowance_id_length', t.allowanceId, TEXT_CAPS.suiId),
  ],
);

export const sellerSales = pgTable(
  'seller_sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    challengeId: text('challenge_id').notNull().unique(),
    payer: text('payer'),
    amountAtomic: atomic('amount_atomic').notNull(),
    recipient: text('recipient').notNull(),
    issuedAt: at('issued_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    digest: text('digest').unique(),
    settledAt: at('settled_at'),
    status: text('status', { enum: SALE_STATUSES }).notNull().default('issued'),
  },
  (t) => [
    index('seller_sales_expires_at_idx').on(t.expiresAt),
    oneOf('seller_sales_status_known', t.status, SALE_STATUSES),
    maxLength('seller_sales_payer_length', t.payer, TEXT_CAPS.suiId),
    maxLength('seller_sales_digest_length', t.digest, TEXT_CAPS.digest),
  ],
);

export const rateCounters = pgTable(
  'rate_counters',
  {
    key: text('key').notNull(),
    windowStart: at('window_start').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    // Per-client rows arrive at request rate, so pruning old windows needs its own index.
    index('rate_counters_window_start_idx').on(t.windowStart),
    maxLength('rate_counters_key_length', t.key, TEXT_CAPS.rateKey),
  ],
);
