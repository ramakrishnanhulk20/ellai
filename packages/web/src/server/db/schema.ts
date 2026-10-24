import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
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

/**
 * Longest text, in characters, the database accepts in each column that an agent, a
 * seller, an owner or an upstream service can influence. Code should refuse longer input
 * before it gets here; these checks are the backstop that holds if it does not.
 */
export const TEXT_CAPS = {
  autoPausedReason: 200,
  agentLabel: 60,
  tokenPrefix: 12,
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
    createdAt: createdAt(),
  },
  (t) => [
    check('owners_approvals_needed_range', sql`${t.approvalsNeeded} between 1 and 10`),
    check('owners_distance_cutoff_range', sql`${t.distanceCutoff} > 0 and ${t.distanceCutoff} <= 2`),
    maxLength('owners_sui_address_length', t.suiAddress, TEXT_CAPS.suiId),
    maxLength('owners_memwal_account_id_length', t.memwalAccountId, TEXT_CAPS.suiId),
    maxLength('owners_allowance_id_length', t.allowanceId, TEXT_CAPS.suiId),
    maxLength('owners_auto_paused_reason_length', t.autoPausedReason, TEXT_CAPS.autoPausedReason),
  ],
);

export const signinNonces = pgTable('signin_nonces', {
  nonce: text('nonce').primaryKey(),
  createdAt: createdAt(),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => owners.id, RESTRICT),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  expiresAt: at('expires_at').notNull(),
  revokedAt: at('revoked_at'),
});

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
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, RESTRICT),
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
    decisionId: uuid('decision_id').references(() => decisions.id, RESTRICT),
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
    createdAt: createdAt(),
    confirmedAt: at('confirmed_at'),
  },
  (t) => [
    // The refusal check (C11) and the learned approval (C10) read these structured
    // facts, never the sentence, so an owner decision without them could never be
    // matched and a refusal would silently stop counting.
    check(
      'memories_owner_decision_facts',
      sql`${t.kind} <> 'owner_decision' or (${t.verdict} is not null and ${t.recipient} is not null and ${t.amountAtomic} is not null)`,
    ),
    index('memories_refusal_lookup_idx').on(t.ownerId, t.recipient, t.verdict),
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
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisions.id, RESTRICT),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, RESTRICT),
  },
  (t) => [primaryKey({ columns: [t.decisionId, t.memoryId] })],
);

export const questions = pgTable(
  'questions',
  {
    decisionId: uuid('decision_id')
      .primaryKey()
      .references(() => decisions.id, RESTRICT),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, RESTRICT),
    createdAt: createdAt(),
    answeredAt: at('answered_at'),
    answer: text('answer', { enum: VERDICTS }),
    reason: text('reason'),
    memoryId: uuid('memory_id').references(() => memories.id, RESTRICT),
  },
  (t) => [
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
    decisionId: uuid('decision_id')
      .notNull()
      .unique()
      .references(() => decisions.id, RESTRICT),
    recipient: text('recipient').notNull(),
    maxAmountAtomic: atomic('max_amount_atomic').notNull(),
    sellerUrl: text('seller_url').notNull(),
    sellerMethod: text('seller_method', { enum: SELLER_METHODS }).notNull(),
    bodyHash: text('body_hash').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    usedByDecisionId: uuid('used_by_decision_id')
      .unique()
      .references(() => decisions.id, RESTRICT),
  },
  (t) => [
    positive('grants_max_amount_positive', t.maxAmountAtomic),
    // Code claims a grant with "where used_at is null"; keeping the two columns in step
    // means that guard and the unique decision column can never disagree.
    check('grants_used_together', sql`(${t.usedAt} is null) = (${t.usedByDecisionId} is null)`),
    oneOf('grants_seller_method_known', t.sellerMethod, SELLER_METHODS),
    maxLength('grants_recipient_length', t.recipient, TEXT_CAPS.suiId),
    maxLength('grants_seller_url_length', t.sellerUrl, TEXT_CAPS.sellerUrl),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    decisionId: uuid('decision_id')
      .notNull()
      .unique()
      .references(() => decisions.id, RESTRICT),
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
  },
  (t) => [
    index('payments_owner_signed_at_idx').on(t.ownerId, t.signedAt),
    positive('payments_amount_positive', t.amountAtomic),
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
    status: text('status', { enum: REFILL_STATUSES }).notNull().default('pending'),
    verifiedAt: at('verified_at'),
  },
  (t) => [
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
    maxLength('rate_counters_key_length', t.key, TEXT_CAPS.rateKey),
  ],
);
