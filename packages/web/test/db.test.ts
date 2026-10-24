// Covers: the rules the database itself enforces, proven on PGlite in memory. One payment
// per decision and per digest, one live decision per identical request, one use per grant
// and one grant per deciding decision, unique refill digests and seller challenges, owners
// never deleted from under their records, no row linking one owner's records to another
// owner's, the answer and memory shape checks, the text caps, a row lock inside a
// transaction, and the refusal of an in-process database in production.
// Does NOT cover: Neon (nothing here opens a network connection); two connections racing
// for one row (PGlite serves a single connection, so no lock is ever waited on); the
// queries later modules write. The owner keys prove a row agrees with the records it links
// to, not that its owner is the signed-in one: a set of rows written wholly in the wrong
// owner's name is consistent and is accepted. Nor do they check that a grant's use matches
// the grant's recipient, amount or seller request.
import { randomBytes } from 'node:crypto';
import { type SQL, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import {
  agents,
  decisionCitations,
  decisions,
  grantUses,
  grants,
  memories,
  owners,
  payments,
  questions,
  refills,
  sellerSales,
} from '../src/server/db/schema.js';

type Owner = typeof owners.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Decision = typeof decisions.$inferSelect;
type Grant = typeof grants.$inferSelect;

const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  await handle.close();
});

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const suiAddress = () => `0x${hex(32)}`;
const digest = () => randomBytes(32).toString('base64url');
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

async function rows<T>(query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

interface PgFailure {
  code: string;
  constraint: string | undefined;
}

// drizzle wraps the driver's error, so walk the cause chain to the Postgres one.
async function refusal(query: PromiseLike<unknown>): Promise<PgFailure> {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const fields = current as Error & { code?: unknown; constraint?: unknown };
      if (typeof fields.code === 'string' && /^[0-9A-Z]{5}$/.test(fields.code)) {
        return { code: fields.code, constraint: typeof fields.constraint === 'string' ? fields.constraint : undefined };
      }
      current = current.cause;
    }
    throw new Error('the query failed without a Postgres error', { cause: error });
  }
  throw new Error('the database accepted a row it should have refused');
}

async function expectRefusedBy(query: PromiseLike<unknown>, constraint: string): Promise<void> {
  expect((await refusal(query)).constraint).toBe(constraint);
}

async function newOwner(): Promise<Owner> {
  return one(await db.insert(owners).values({ suiAddress: suiAddress(), purseAddress: suiAddress() }).returning());
}

async function newAgent(owner: Owner): Promise<Agent> {
  const values = { ownerId: owner.id, label: 'Test agent', kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_ab12' } as const;
  return one(await db.insert(agents).values(values).returning());
}

async function ownerWithAgent(): Promise<{ owner: Owner; agent: Agent }> {
  const owner = await newOwner();
  return { owner, agent: await newAgent(owner) };
}

function decisionValues(owner: Owner, agent: Agent, overrides: Partial<typeof decisions.$inferInsert> = {}) {
  return {
    ownerId: owner.id,
    agentId: agent.id,
    requestKey: hex(32),
    sellerUrl: 'https://seller.example/v1/check',
    sellerMethod: 'GET',
    sellerHost: 'seller.example',
    bodyHash: hex(32),
    purpose: 'Check a wallet before the agent pays it',
    recipient: suiAddress(),
    amountAtomic: 10_000n,
    asset: USDC,
    network: 'sui:mainnet',
    expiresAt: minutesFromNow(1),
    outcome: 'approved',
    rule: 'learned',
    reason: 'Two of your own approvals match this recipient',
    status: 'open',
    ...overrides,
  } satisfies typeof decisions.$inferInsert;
}

async function newDecision(owner: Owner, agent: Agent, overrides: Partial<typeof decisions.$inferInsert> = {}): Promise<Decision> {
  return one(await db.insert(decisions).values(decisionValues(owner, agent, overrides)).returning());
}

function paymentValues(decision: Decision, overrides: Partial<typeof payments.$inferInsert> = {}) {
  return {
    decisionId: decision.id,
    ownerId: decision.ownerId,
    purseAddress: suiAddress(),
    recipient: decision.recipient,
    amountAtomic: decision.amountAtomic,
    digest: digest(),
    txBytesBase64: randomBytes(64).toString('base64'),
    signedAt: new Date(),
    validUntilEpoch: 900n,
    ...overrides,
  } satisfies typeof payments.$inferInsert;
}

function ownerDecisionMemory(owner: Owner, overrides: Partial<typeof memories.$inferInsert> = {}) {
  return {
    ownerId: owner.id,
    kind: 'owner_decision',
    recipient: suiAddress(),
    amountAtomic: 10_000n,
    verdict: 'approve',
    sellerHost: 'seller.example',
    sentence: 'The owner approved 0.01 USDC to this recipient for a wallet check.',
    namespace: 'ellai-test-v1',
    writerPublicKey: hex(32),
    ...overrides,
  } satisfies typeof memories.$inferInsert;
}

function grantValues(decision: Decision, overrides: Partial<typeof grants.$inferInsert> = {}) {
  return {
    ownerId: decision.ownerId,
    decisionId: decision.id,
    recipient: decision.recipient,
    maxAmountAtomic: decision.amountAtomic,
    sellerUrl: decision.sellerUrl,
    sellerMethod: decision.sellerMethod,
    bodyHash: decision.bodyHash,
    expiresAt: minutesFromNow(10),
    ...overrides,
  } satisfies typeof grants.$inferInsert;
}

function useGrant(grant: Grant, decision: Decision, ownerId: string = grant.ownerId) {
  return db.insert(grantUses).values({ grantId: grant.id, decisionId: decision.id, ownerId }).returning();
}

describe('migrations', () => {
  it('create every table, and running them again changes nothing', async () => {
    await migrate(db);
    const tables = await rows<{ name: string }>(
      sql`select table_name as name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(tables.map((table) => table.name)).toEqual([
      'agents',
      'decision_citations',
      'decisions',
      'grant_uses',
      'grants',
      'memories',
      'owners',
      'payments',
      'questions',
      'rate_counters',
      'refills',
      'seller_sales',
      'sessions',
      'signin_nonces',
    ]);
  });

  it('give every foreign key ON DELETE RESTRICT, so nothing ever cascades', async () => {
    const keys = await rows<{ source: string; target: string; on_delete: string }>(
      sql`select conrelid::regclass::text as source, confrelid::regclass::text as target, confdeltype::text as on_delete
          from pg_constraint where contype = 'f'`,
    );
    expect(keys.length).toBe(18);
    expect(keys.filter((key) => key.on_delete !== 'r')).toEqual([]);
    const pointingAtOwners = keys.filter((key) => key.target === 'owners').map((key) => key.source).sort();
    expect(pointingAtOwners).toEqual(['agents', 'decisions', 'grants', 'memories', 'payments', 'questions', 'refills', 'sessions']);
  });
});

describe('owners', () => {
  it('start with the safe defaults, with amounts read back as bigint', async () => {
    const owner = await newOwner();
    expect(owner.perPaymentMaxAtomic).toBe(50_000n);
    expect(owner.dailyBudgetAtomic).toBe(500_000n);
    expect(owner.approvalsNeeded).toBe(2);
    expect(owner.distanceCutoff).toBe(0.5);
    expect(owner.paused).toBe(false);
  });

  it('cannot be deleted while a decision points at them, and can be once nothing does', async () => {
    const { owner, agent } = await ownerWithAgent();
    const decision = await newDecision(owner, agent);

    // 23001 is restrict_violation, raised only by an ON DELETE RESTRICT key; a NO ACTION
    // key would report 23503 instead.
    const failure = await refusal(db.delete(owners).where(eq(owners.id, owner.id)));
    expect(failure.code).toBe('23001');
    expect(await db.select().from(owners).where(eq(owners.id, owner.id))).toHaveLength(1);
    expect(await db.select().from(decisions).where(eq(decisions.id, decision.id))).toHaveLength(1);

    const empty = await newOwner();
    expect(await db.delete(owners).where(eq(owners.id, empty.id)).returning()).toHaveLength(1);
  });

  it('can be locked with SELECT ... FOR UPDATE inside a transaction', async () => {
    const owner = await newOwner();
    const lockOwner = (tx: Pick<Database, 'select'>) =>
      tx.select().from(owners).where(eq(owners.id, owner.id)).for('update');
    expect(lockOwner(db).toSQL().sql).toMatch(/ for update$/);

    const heldLocks = await db.transaction(async (tx) => {
      const locked = one(await lockOwner(tx));
      expect(locked.id).toBe(owner.id);
      const locks = (await tx.execute(
        sql`select mode from pg_locks where relation = 'owners'::regclass and pid = pg_backend_pid()`,
      )) as unknown as { rows: { mode: string }[] };
      await tx.update(owners).set({ paused: true }).where(eq(owners.id, owner.id));
      return locks.rows.map((lock) => lock.mode);
    });

    expect(heldLocks).toContain('RowShareLock');
    expect(one(await db.select().from(owners).where(eq(owners.id, owner.id))).paused).toBe(true);
  });
});

describe('payments', () => {
  it('refuse a second payment with the same digest', async () => {
    const { owner, agent } = await ownerWithAgent();
    const first = await newDecision(owner, agent);
    const second = await newDecision(owner, agent);
    const shared = digest();
    await db.insert(payments).values(paymentValues(first, { digest: shared }));
    await expectRefusedBy(db.insert(payments).values(paymentValues(second, { digest: shared })), 'payments_digest_unique');
  });

  it('refuse a second payment for the same decision', async () => {
    const { owner, agent } = await ownerWithAgent();
    const decision = await newDecision(owner, agent);
    await db.insert(payments).values(paymentValues(decision));
    await expectRefusedBy(db.insert(payments).values(paymentValues(decision)), 'payments_decision_id_unique');
  });
});

describe('decisions', () => {
  it('allow one live decision per identical request, and the request again once the first is paid', async () => {
    const { owner, agent } = await ownerWithAgent();
    const requestKey = hex(32);
    const first = await newDecision(owner, agent, { requestKey, status: 'open' });

    await expectRefusedBy(
      db.insert(decisions).values(decisionValues(owner, agent, { requestKey, status: 'open' })),
      'decisions_live_request_unique',
    );

    await db.update(decisions).set({ status: 'asked', outcome: 'asked', rule: 'no_match' }).where(eq(decisions.id, first.id));
    for (const status of ['open', 'asked'] as const) {
      await expectRefusedBy(
        db.insert(decisions).values(decisionValues(owner, agent, { requestKey, status })),
        'decisions_live_request_unique',
      );
    }

    await db.update(decisions).set({ status: 'paid' }).where(eq(decisions.id, first.id));
    const again = await newDecision(owner, agent, { requestKey, status: 'open' });
    expect(again.id).not.toBe(first.id);

    const other = await ownerWithAgent();
    await newDecision(other.owner, other.agent, { requestKey, status: 'open' });
  });

  it('refuse a purpose of 501 characters and keep one of 500', async () => {
    const { owner, agent } = await ownerWithAgent();
    await expectRefusedBy(
      db.insert(decisions).values(decisionValues(owner, agent, { purpose: 'a'.repeat(501) })),
      'decisions_purpose_length',
    );
    expect((await newDecision(owner, agent, { purpose: 'a'.repeat(500) })).purpose).toHaveLength(500);
  });

  it('refuse values outside the fixed lists and ranges', async () => {
    const { owner, agent } = await ownerWithAgent();
    const badDecisions: [Partial<typeof decisions.$inferInsert>, string][] = [
      [{ status: 'approved_by_agent' as never }, 'decisions_status_known'],
      [{ outcome: 'maybe' as never }, 'decisions_outcome_known'],
      [{ rule: 'agent_said_so' as never }, 'decisions_rule_known'],
      [{ sellerMethod: 'DELETE' as never }, 'decisions_seller_method_known'],
      [{ amountAtomic: 0n }, 'decisions_amount_positive'],
      [{ amountAtomic: -1n }, 'decisions_amount_positive'],
    ];
    for (const [override, constraint] of badDecisions) {
      await expectRefusedBy(db.insert(decisions).values(decisionValues(owner, agent, override)), constraint);
    }

    await expectRefusedBy(
      db.insert(agents).values({ ownerId: owner.id, label: 'x', kind: 'admin' as never, tokenHash: hex(32), tokenPrefix: 'ellai_x' }),
      'agents_kind_known',
    );
    for (const approvalsNeeded of [0, 11]) {
      await expectRefusedBy(db.update(owners).set({ approvalsNeeded }).where(eq(owners.id, owner.id)), 'owners_approvals_needed_range');
    }
    for (const distanceCutoff of [0, 2.01]) {
      await expectRefusedBy(db.update(owners).set({ distanceCutoff }).where(eq(owners.id, owner.id)), 'owners_distance_cutoff_range');
    }
    const decision = await newDecision(owner, agent);
    await expectRefusedBy(
      db.insert(payments).values(paymentValues(decision, { settlement: 'done' as never })),
      'payments_settlement_known',
    );
  });

  it('cap every other column that carries agent, seller or upstream text', async () => {
    const { owner, agent } = await ownerWithAgent();
    const tooLong: [keyof typeof decisions.$inferInsert, number, string][] = [
      ['requestKey', 128, 'decisions_request_key_length'],
      ['sellerUrl', 2_048, 'decisions_seller_url_length'],
      ['sellerHost', 253, 'decisions_seller_host_length'],
      ['recipient', 66, 'decisions_recipient_length'],
      ['asset', 256, 'decisions_asset_length'],
      ['network', 32, 'decisions_network_length'],
      ['challengeId', 128, 'decisions_challenge_id_length'],
      ['nonce', 128, 'decisions_nonce_length'],
      ['reason', 400, 'decisions_reason_length'],
    ];
    for (const [column, cap, constraint] of tooLong) {
      await expectRefusedBy(
        db.insert(decisions).values(decisionValues(owner, agent, { [column]: 'x'.repeat(cap + 1) })),
        constraint,
      );
    }

    for (const label of ['', 'x'.repeat(61)]) {
      await expectRefusedBy(
        db.insert(agents).values({ ownerId: owner.id, label, kind: 'external', tokenHash: hex(32), tokenPrefix: 'ellai_x' }),
        'agents_label_length',
      );
    }
    await expectRefusedBy(
      db.update(agents).set({ tokenPrefix: 'x'.repeat(13) }).where(eq(agents.id, agent.id)),
      'agents_token_prefix_length',
    );
    await expectRefusedBy(
      db.update(owners).set({ autoPausedReason: 'x'.repeat(201) }).where(eq(owners.id, owner.id)),
      'owners_auto_paused_reason_length',
    );
    await expectRefusedBy(
      db.insert(memories).values(ownerDecisionMemory(owner, { sentence: 'x'.repeat(1_001) })),
      'memories_sentence_length',
    );
    const decision = await newDecision(owner, agent, { status: 'asked', outcome: 'asked', rule: 'no_match' });
    await db.insert(questions).values({ decisionId: decision.id, ownerId: owner.id });
    await expectRefusedBy(
      db.update(questions).set({ answer: 'refuse', answeredAt: new Date(), reason: 'x'.repeat(301) }).where(eq(questions.decisionId, decision.id)),
      'questions_reason_length',
    );
    await expectRefusedBy(
      db.insert(payments).values(paymentValues(decision, { mismatchReason: 'x'.repeat(201) })),
      'payments_mismatch_reason_length',
    );
  });
});

describe('questions', () => {
  it('refuse an answer without its time, and a time without an answer', async () => {
    const { owner, agent } = await ownerWithAgent();
    const decision = await newDecision(owner, agent, { status: 'asked', outcome: 'asked', rule: 'no_match' });
    await db.insert(questions).values({ decisionId: decision.id, ownerId: owner.id });
    const thisQuestion = eq(questions.decisionId, decision.id);

    await expectRefusedBy(db.update(questions).set({ answer: 'approve' }).where(thisQuestion), 'questions_answer_has_time');
    await expectRefusedBy(db.update(questions).set({ answeredAt: new Date() }).where(thisQuestion), 'questions_answer_has_time');

    const answered = one(
      await db.update(questions).set({ answer: 'approve', answeredAt: new Date(), reason: 'I use this seller' }).where(thisQuestion).returning(),
    );
    expect(answered.answer).toBe('approve');
  });
});

describe('memories', () => {
  it('refuse an owner decision without its verdict, recipient or amount, and allow an outcome without a verdict', async () => {
    const owner = await newOwner();
    for (const missing of ['verdict', 'recipient', 'amountAtomic'] as const) {
      await expectRefusedBy(
        db.insert(memories).values(ownerDecisionMemory(owner, { [missing]: null })),
        'memories_owner_decision_facts',
      );
    }
    const outcome = one(
      await db
        .insert(memories)
        .values(ownerDecisionMemory(owner, { kind: 'outcome', verdict: null, sentence: 'The seller returned nothing after payment.' }))
        .returning(),
    );
    expect(outcome.status).toBe('pending');
  });
});

describe('grants', () => {
  it('can be used by only one decision, and each decision uses at most one grant', async () => {
    const { owner, agent } = await ownerWithAgent();
    const asked = await newDecision(owner, agent, { status: 'answered', outcome: 'asked', rule: 'no_match' });
    const grant = one(await db.insert(grants).values(grantValues(asked)).returning());
    await expectRefusedBy(db.insert(grants).values(grantValues(asked)), 'grants_decision_id_unique');

    const firstUse = await newDecision(owner, agent, { rule: 'grant' });
    const secondUse = await newDecision(owner, agent, { rule: 'grant' });
    expect(one(await useGrant(grant, firstUse)).usedAt).toBeInstanceOf(Date);
    // 23505 is unique_violation: the second use collides with the first on the primary key.
    expect(await refusal(useGrant(grant, secondUse))).toEqual({ code: '23505', constraint: 'grant_uses_pkey' });
    const uses = await db.select().from(grantUses).where(eq(grantUses.grantId, grant.id));
    expect(uses.map((use) => use.decisionId)).toEqual([firstUse.id]);

    const askedAgain = await newDecision(owner, agent, { status: 'answered', outcome: 'asked', rule: 'no_match' });
    const otherGrant = one(await db.insert(grants).values(grantValues(askedAgain)).returning());
    await expectRefusedBy(useGrant(otherGrant, firstUse), 'grant_uses_decision_id_unique');
  });
});

describe('rows that mix owners', () => {
  // 23503 is foreign_key_violation. Each refused row is well formed and differs from an
  // accepted one only in naming the other owner's record.
  async function expectCrossOwnerRefusal(query: PromiseLike<unknown>, constraint: string): Promise<void> {
    expect(await refusal(query)).toEqual({ code: '23503', constraint });
  }

  async function twoOwners() {
    return { a: await ownerWithAgent(), b: await ownerWithAgent() };
  }

  it("refuse a decision for A that points at B's agent", async () => {
    const { a, b } = await twoOwners();
    await expectCrossOwnerRefusal(db.insert(decisions).values(decisionValues(a.owner, b.agent)), 'decisions_agent_same_owner_fk');
  });

  it("refuse a payment, a grant or a question in A's name on B's decision", async () => {
    const { a, b } = await twoOwners();
    const theirs = await newDecision(b.owner, b.agent, { status: 'asked', outcome: 'asked', rule: 'no_match' });
    await expectCrossOwnerRefusal(
      db.insert(payments).values(paymentValues(theirs, { ownerId: a.owner.id })),
      'payments_decision_same_owner_fk',
    );
    await expectCrossOwnerRefusal(
      db.insert(grants).values(grantValues(theirs, { ownerId: a.owner.id })),
      'grants_decision_same_owner_fk',
    );
    await expectCrossOwnerRefusal(
      db.insert(questions).values({ decisionId: theirs.id, ownerId: a.owner.id }),
      'questions_decision_same_owner_fk',
    );
  });

  it("refuse a memory for A that names B's decision, and keep one that names A's own", async () => {
    const { a, b } = await twoOwners();
    const theirs = await newDecision(b.owner, b.agent);
    await expectCrossOwnerRefusal(
      db.insert(memories).values(ownerDecisionMemory(a.owner, { decisionId: theirs.id })),
      'memories_decision_same_owner_fk',
    );
    const mine = await newDecision(a.owner, a.agent);
    const kept = one(await db.insert(memories).values(ownerDecisionMemory(a.owner, { decisionId: mine.id })).returning());
    expect(kept.decisionId).toBe(mine.id);
  });

  it("refuse a citation linking A's decision to B's memory under either owner, and keep A's own", async () => {
    const { a, b } = await twoOwners();
    const decision = await newDecision(a.owner, a.agent);
    const theirMemory = one(await db.insert(memories).values(ownerDecisionMemory(b.owner)).returning());
    const cite = (memoryId: string, ownerId: string) =>
      db.insert(decisionCitations).values({ decisionId: decision.id, memoryId, ownerId });

    await expectCrossOwnerRefusal(cite(theirMemory.id, a.owner.id), 'decision_citations_memory_same_owner_fk');
    await expectCrossOwnerRefusal(cite(theirMemory.id, b.owner.id), 'decision_citations_decision_same_owner_fk');

    const myMemory = one(await db.insert(memories).values(ownerDecisionMemory(a.owner)).returning());
    expect(await cite(myMemory.id, a.owner.id).returning()).toHaveLength(1);
  });

  it("refuse a question for A that points at B's memory, and keep one that points at A's", async () => {
    const { a, b } = await twoOwners();
    const decision = await newDecision(a.owner, a.agent, { status: 'asked', outcome: 'asked', rule: 'no_match' });
    const theirMemory = one(await db.insert(memories).values(ownerDecisionMemory(b.owner)).returning());
    await expectCrossOwnerRefusal(
      db.insert(questions).values({ decisionId: decision.id, ownerId: a.owner.id, memoryId: theirMemory.id }),
      'questions_memory_same_owner_fk',
    );

    await db.insert(questions).values({ decisionId: decision.id, ownerId: a.owner.id });
    const thisQuestion = eq(questions.decisionId, decision.id);
    await expectCrossOwnerRefusal(
      db.update(questions).set({ memoryId: theirMemory.id }).where(thisQuestion),
      'questions_memory_same_owner_fk',
    );
    const myMemory = one(await db.insert(memories).values(ownerDecisionMemory(a.owner)).returning());
    expect(one(await db.update(questions).set({ memoryId: myMemory.id }).where(thisQuestion).returning()).memoryId).toBe(
      myMemory.id,
    );
  });

  it("refuse a use that spends A's grant on B's decision under either owner", async () => {
    const { a, b } = await twoOwners();
    const asked = await newDecision(a.owner, a.agent, { status: 'answered', outcome: 'asked', rule: 'no_match' });
    const grant = one(await db.insert(grants).values(grantValues(asked)).returning());
    const theirs = await newDecision(b.owner, b.agent, { rule: 'grant' });

    await expectCrossOwnerRefusal(useGrant(grant, theirs, a.owner.id), 'grant_uses_decision_same_owner_fk');
    await expectCrossOwnerRefusal(useGrant(grant, theirs, b.owner.id), 'grant_uses_grant_same_owner_fk');
    expect(await db.select().from(grantUses).where(eq(grantUses.grantId, grant.id))).toEqual([]);
  });
});

describe('createDb', () => {
  it('refuses a pglite database when NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(createDb('pglite:memory')).rejects.toThrow(
        'Unsupported database URL: pglite: is for development and tests, not production',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('refills and seller sales', () => {
  it('refuse a refill with a duplicate digest', async () => {
    const owner = await newOwner();
    const refill = { ownerId: owner.id, allowanceId: suiAddress(), amountAtomic: 100_000n, digest: digest(), sentAt: new Date() };
    await db.insert(refills).values(refill);
    await expectRefusedBy(db.insert(refills).values(refill), 'refills_digest_unique');
  });

  it('refuse a seller sale that reuses a challenge id', async () => {
    const sale = {
      challengeId: hex(16),
      amountAtomic: 10_000n,
      recipient: suiAddress(),
      issuedAt: new Date(),
      expiresAt: minutesFromNow(1),
    };
    await db.insert(sellerSales).values(sale);
    await expectRefusedBy(db.insert(sellerSales).values({ ...sale, issuedAt: new Date() }), 'seller_sales_challenge_id_unique');
  });
});
