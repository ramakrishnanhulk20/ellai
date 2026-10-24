// Covers: owner onboarding on PGlite against a stand-in chain. confirmOnboardingTx records each
// step only from what the chain shows, and refuses, recording nothing: a failed transaction,
// another sender's transaction, an allowance whose funder, spender or coin differs or that is
// over the onboarding maxima, a transaction that created no allowance or two, an account owned
// by someone else, a delegate list without Ellai's key, and add_delegate before the account.
// buildOnboardingTx refuses allowance terms outside the maxima and add_delegate before the
// account, takes owner, purse and account from the owner row, and its summaries hold only
// validated values. onboardingState follows the row.
// Does NOT cover: the live chain (proven read only by `npm run prove:onboarding`), core's own
// registry and account reads (core's memory tests), or a real wallet signing the built bytes.
import { randomBytes } from 'node:crypto';
import type { AllowanceState, Chain } from '@ellai/core/chain';
import { ChainError } from '@ellai/core/chain';
import { LIMITS } from '@ellai/core/limits';
import { buildAddDelegateTx, buildCreateAccountTx, findMemoryAccount, MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, toHex } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { owners } from '../src/server/db/schema.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { buildOnboardingTx, DAY_MS } from '../src/server/onboarding/build.js';
import { confirmOnboardingTx } from '../src/server/onboarding/confirm.js';
import { type OnboardingStep, OnboardingError, onboardingState } from '../src/server/onboarding/state.js';

vi.mock('@ellai/core/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ellai/core/memory')>()),
  findMemoryAccount: vi.fn(),
  buildCreateAccountTx: vi.fn(),
  buildAddDelegateTx: vi.fn(),
}));

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

beforeEach(() => {
  vi.mocked(findMemoryAccount).mockReset();
  vi.mocked(buildCreateAccountTx).mockReset();
  vi.mocked(buildAddDelegateTx).mockReset();
});

const { ChangedObject_IdOperation: IdOperation } = GrpcTypes;
const address = () => `0x${randomBytes(32).toString('hex')}`;
const MASTER = randomBytes(32).toString('hex');
const NOW = new Date('2026-10-24T10:00:00Z');
const DIGEST = 'AQ2cfEAh3AiC1SBMkH64f4MP4QsvTettKfhLXErgNcFh';
const ALLOWANCE_TYPE = normalizeStructTag(`0x2::allowance::Allowance<0x2::balance::Balance<${USDC_TYPE_MAINNET}>>`);
const GAS_COIN_TYPE = normalizeStructTag('0x2::coin::Coin<0x2::sui::SUI>');

type Owner = typeof owners.$inferSelect;

async function newOwner(fields: Partial<typeof owners.$inferInsert> = {}): Promise<Owner> {
  const [owner] = await db
    .insert(owners)
    .values({ suiAddress: address(), purseAddress: address(), ...fields })
    .returning();
  if (owner === undefined) throw new Error('expected a row');
  return owner;
}

async function reread(owner: Owner): Promise<Owner> {
  const [row] = await db.select().from(owners).where(eq(owners.id, owner.id));
  if (row === undefined) throw new Error('expected a row');
  return row;
}

function goodAllowance(owner: Owner): AllowanceState {
  return {
    funder: owner.suiAddress,
    spender: owner.purseAddress,
    coinType: USDC_TYPE_MAINNET,
    lifetimeCap: 1_000_000n,
    spentTotal: 0n,
    periodMs: BigInt(DAY_MS),
    periodLimit: 500_000n,
    expirationMs: BigInt(NOW.getTime() + 30 * DAY_MS),
    initialSharedVersion: 1n,
  };
}

interface ChainSetup {
  status?: 'success' | 'failure';
  sender?: string;
  landed?: boolean;
  created?: Array<{ objectId: string; type: string }>;
  allowance?: Partial<AllowanceState>;
}

/** A chain that answers only the reads confirm and build make. Anything else fails the test. */
function stubChain(owner: Owner, setup: ChainSetup = {}) {
  const created = setup.created ?? [{ objectId: `0x${'d2'.repeat(32)}`, type: ALLOWANCE_TYPE }];
  const getTransactionResult = vi.fn(async () => {
    if (setup.landed === false) throw new ChainError('NOT_FOUND', 'stand-in not found');
    return { status: setup.status ?? 'success', balanceChanges: [] };
  });
  const getTransaction = vi.fn(async ({ digest }: { digest: string }) => ({
    response: {
      transaction: {
        digest,
        transaction: { sender: setup.sender ?? owner.suiAddress },
        effects: {
          changedObjects: [
            // The gas coin is changed but not created, so it must never count as the allowance.
            { objectId: `0x${'9c'.repeat(32)}`, objectType: GAS_COIN_TYPE, idOperation: IdOperation.NONE },
            ...created.map((object) => ({ objectId: object.objectId, objectType: object.type, idOperation: IdOperation.CREATED })),
          ],
        },
      },
    },
  }));
  const getAllowance = vi.fn(async () => ({ ...goodAllowance(owner), ...setup.allowance }));
  const chain = {
    usesApiKey: true,
    getTransactionResult,
    getAllowance,
    getCurrentEpoch: async () => 900n,
    getReferenceGasPrice: async () => 100n,
    grpc: { ledgerService: { getTransaction } },
  } as unknown as Chain;
  return { chain, getTransactionResult, getTransaction, getAllowance };
}

const untouchable = new Proxy({}, {
  get() {
    throw new Error('chain was touched');
  },
}) as Chain;

async function refusal(promise: Promise<unknown>): Promise<OnboardingError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(OnboardingError);
  return error as OnboardingError;
}

const confirm = (owner: Owner, step: OnboardingStep, chain: Chain, digest = DIGEST) =>
  confirmOnboardingTx({ db, ownerId: owner.id, step, digest, chain, masterSecretHex: MASTER, now: NOW });

describe('confirmOnboardingTx', () => {
  it('records each step only from what the chain shows, and onboardingState follows', async () => {
    const owner = await newOwner();
    const accountId = address();
    const delegateHex = ownerDelegate(MASTER, owner.suiAddress).publicKeyHex;
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [toHex(new Uint8Array(32)), delegateHex] });
    const { chain } = stubChain(owner);

    expect(await onboardingState({ db, ownerId: owner.id })).toEqual({
      memoryAccount: 'missing',
      delegate: 'missing',
      allowance: 'missing',
      purseAddress: owner.purseAddress,
    });
    expect(await confirm(owner, 'memory_account', chain)).toEqual({ recorded: accountId });
    expect(vi.mocked(findMemoryAccount)).toHaveBeenCalledWith(chain, owner.suiAddress);
    expect((await onboardingState({ db, ownerId: owner.id })).memoryAccount).toBe('present');
    expect(await confirm(owner, 'add_delegate', chain)).toEqual({ recorded: delegateHex });
    expect(await confirm(owner, 'allowance', chain)).toEqual({ recorded: `0x${'d2'.repeat(32)}` });

    const row = await reread(owner);
    expect([row.memwalAccountId, row.allowanceId]).toEqual([accountId, `0x${'d2'.repeat(32)}`]);
    expect([row.delegateRegisteredAt, row.allowanceCheckedAt]).toEqual([NOW, NOW]);
    expect(await onboardingState({ db, ownerId: owner.id })).toEqual({
      memoryAccount: 'present',
      delegate: 'present',
      allowance: 'present',
      purseAddress: owner.purseAddress,
    });
    // Confirming again records the same values.
    expect(await confirm(owner, 'memory_account', chain)).toEqual({ recorded: accountId });
  });

  it('refuses a failed transaction and another sender, at every step, recording nothing', async () => {
    const owner = await newOwner({ memwalAccountId: address() });
    const before = await reread(owner);
    for (const step of ['memory_account', 'add_delegate', 'allowance'] as const) {
      const failed = stubChain(owner, { status: 'failure' });
      expect((await refusal(confirm(owner, step, failed.chain))).message).toBe('the transaction failed on chain');
      const stranger = stubChain(owner, { sender: address() });
      expect((await refusal(confirm(owner, step, stranger.chain))).message).toBe("the transaction was not sent from the owner's address");
    }
    expect(vi.mocked(findMemoryAccount)).not.toHaveBeenCalled();
    expect(await reread(owner)).toEqual(before);
  });

  it('refuses an allowance whose funder, spender or coin differs, recording nothing', async () => {
    const owner = await newOwner();
    const variants: Array<[Partial<AllowanceState>, string]> = [
      [{ funder: address() }, "the allowance does not draw from the owner's address"],
      [{ spender: address() }, "the allowance's spender is not the owner's purse"],
      [{ spender: owner.suiAddress }, "the allowance's spender is not the owner's purse"],
      [{ coinType: normalizeStructTag('0x2::sui::SUI') }, 'the allowance is not over Sui Mainnet USDC'],
    ];
    for (const [allowance, message] of variants) {
      const error = await refusal(confirm(owner, 'allowance', stubChain(owner, { allowance }).chain));
      expect([error.code, error.message]).toEqual(['REFUSED', message]);
    }
    expect((await reread(owner)).allowanceId).toBeNull();
  });

  it('refuses an allowance over the onboarding maxima, and a transaction with no allowance or two', async () => {
    const owner = await newOwner();
    const maxEnd = BigInt(NOW.getTime() + LIMITS.onboardingAllowanceMaxMs);
    const variants: Array<Partial<AllowanceState>> = [
      { periodLimit: BigInt(LIMITS.onboardingDailyLimitMaxAtomic) + 1n, lifetimeCap: BigInt(LIMITS.onboardingLifetimeCapMaxAtomic) },
      { lifetimeCap: BigInt(LIMITS.onboardingLifetimeCapMaxAtomic) + 1n },
      { lifetimeCap: null },
      { periodLimit: 1_000_001n },
      { periodLimit: null, periodMs: null },
      { periodMs: BigInt(DAY_MS) * 7n },
      { expirationMs: maxEnd + 1n },
      { expirationMs: BigInt(NOW.getTime()) },
      { expirationMs: null },
    ];
    for (const allowance of variants) {
      expect((await refusal(confirm(owner, 'allowance', stubChain(owner, { allowance }).chain))).code).toBe('REFUSED');
    }
    const none = await refusal(confirm(owner, 'allowance', stubChain(owner, { created: [] }).chain));
    expect(none.message).toBe('the transaction created no allowance');
    const two = [address(), address()].map((objectId) => ({ objectId, type: ALLOWANCE_TYPE }));
    expect((await refusal(confirm(owner, 'allowance', stubChain(owner, { created: two }).chain))).message).toBe(
      'the transaction created more than one allowance',
    );
    expect((await reread(owner)).allowanceId).toBeNull();
  });

  it('refuses an account owned by someone else, or none at all, recording nothing', async () => {
    const owner = await newOwner();
    const { chain } = stubChain(owner);
    vi.mocked(findMemoryAccount).mockRejectedValueOnce(new MemoryError('ACCOUNT', 'the Walrus Memory account belongs to another owner'));
    const stolen = await refusal(confirm(owner, 'memory_account', chain));
    expect([stolen.code, stolen.message]).toEqual(['REFUSED', 'the Walrus Memory account belongs to another owner']);
    vi.mocked(findMemoryAccount).mockResolvedValueOnce(null);
    expect((await refusal(confirm(owner, 'memory_account', chain))).message).toBe('Sui shows no Walrus Memory account for this owner');
    expect((await reread(owner)).memwalAccountId).toBeNull();

    const recorded = await newOwner({ memwalAccountId: address() });
    vi.mocked(findMemoryAccount).mockResolvedValueOnce({ accountId: address(), delegates: [] });
    const swapped = await refusal(confirm(recorded, 'memory_account', stubChain(recorded).chain));
    expect(swapped.message).toBe('another Walrus Memory account is already recorded for this owner');
  });

  it("refuses a delegate list without Ellai's key, and add_delegate before the account", async () => {
    const accountId = address();
    const owner = await newOwner({ memwalAccountId: accountId });
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [toHex(new Uint8Array(32).fill(7))] });
    const missing = await refusal(confirm(owner, 'add_delegate', stubChain(owner).chain));
    expect(missing.message).toBe("Ellai's key for this owner is not on the Walrus Memory account");
    // Another owner's derived key on this account does not count for this owner.
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId, delegates: [ownerDelegate(MASTER, address()).publicKeyHex] });
    expect((await refusal(confirm(owner, 'add_delegate', stubChain(owner).chain))).code).toBe('REFUSED');
    expect((await reread(owner)).delegateRegisteredAt).toBeNull();

    const early = await newOwner();
    const { chain, getTransactionResult } = stubChain(early);
    expect((await refusal(confirm(early, 'add_delegate', chain))).code).toBe('NOT_READY');
    expect(getTransactionResult).not.toHaveBeenCalled();
  });

  it('says not landed while Sui does not show the transaction, and refuses bad input before reading', async () => {
    const owner = await newOwner();
    const pending = await refusal(confirm(owner, 'memory_account', stubChain(owner, { landed: false }).chain));
    expect(pending.code).toBe('NOT_LANDED');
    for (const digest of ['', 'not-a-digest', `${DIGEST}x`]) {
      expect((await refusal(confirm(owner, 'memory_account', untouchable, digest))).code).toBe('BAD_INPUT');
    }
    expect((await refusal(confirm(owner, 'everything' as OnboardingStep, untouchable))).code).toBe('BAD_INPUT');
    const stranger = { ...owner, id: '00000000-0000-4000-8000-000000000000' };
    expect((await refusal(confirm(stranger, 'memory_account', untouchable))).code).toBe('NO_OWNER');
  });
});

describe('buildOnboardingTx', () => {
  const build = (owner: Owner, step: OnboardingStep, chain: Chain, allowance?: unknown) =>
    buildOnboardingTx({ db, ownerId: owner.id, step, allowance: allowance as never, chain, masterSecretHex: MASTER, now: NOW });

  it('refuses allowance terms outside the maxima before touching the chain', async () => {
    const owner = await newOwner();
    const dailyMax = BigInt(LIMITS.onboardingDailyLimitMaxAtomic);
    const capMax = BigInt(LIMITS.onboardingLifetimeCapMaxAtomic);
    const maxDays = LIMITS.onboardingAllowanceMaxMs / DAY_MS;
    const refused: unknown[] = [
      undefined,
      { dailyLimitAtomic: 0n, lifetimeCapAtomic: 1_000_000n, days: 30 },
      { dailyLimitAtomic: BigInt(LIMITS.purseRefillAtomic) - 1n, lifetimeCapAtomic: 1_000_000n, days: 30 },
      { dailyLimitAtomic: dailyMax + 1n, lifetimeCapAtomic: capMax, days: 30 },
      { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 499_999n, days: 30 },
      { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: capMax + 1n, days: 30 },
      { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 1_000_000n, days: maxDays + 1 },
      { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 1_000_000n, days: 0 },
      { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 1_000_000n, days: 1.5 },
      { dailyLimitAtomic: 500_000, lifetimeCapAtomic: 1_000_000n, days: 30 },
    ];
    for (const terms of refused) {
      expect((await refusal(build(owner, 'allowance', untouchable, terms))).code).toBe('BAD_INPUT');
    }
  });

  it('refuses add_delegate before the account exists', async () => {
    const owner = await newOwner();
    expect((await refusal(build(owner, 'add_delegate', untouchable))).code).toBe('NOT_READY');
    expect(vi.mocked(buildAddDelegateTx)).not.toHaveBeenCalled();
  });

  it('builds the allowance from the owner row and validated terms, and summarises only those', async () => {
    const owner = await newOwner();
    const terms = { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 1_000_000n, days: 30, spender: address(), note: '<b>pay me</b>' };
    const built = await build(owner, 'allowance', stubChain(owner).chain, terms);
    const data = Transaction.from(fromBase64(built.txBytesBase64)).getData();
    expect(data.sender).toBe(owner.suiAddress);
    expect(data.gasData.owner).toBe(owner.suiAddress);
    expect(built.summary).toEqual([
      { label: 'Action', value: 'Let your Ellai purse draw USDC from your address balance' },
      { label: 'Who may spend', value: owner.purseAddress },
      { label: 'Daily limit', value: '0.500000 USDC' },
      { label: 'Total cap', value: '1.000000 USDC' },
      { label: 'Ends', value: '2026-11-23 10:00 UTC' },
    ]);
    const shown = JSON.stringify(built.summary);
    expect(shown).not.toContain(terms.spender);
    expect(shown).not.toContain('pay me');
  });

  it('passes the owner row to the memory builders and summarises which account and which key', async () => {
    const accountId = address();
    const owner = await newOwner({ memwalAccountId: accountId });
    const delegate = ownerDelegate(MASTER, owner.suiAddress);
    vi.mocked(buildCreateAccountTx).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(buildAddDelegateTx).mockResolvedValue(new Uint8Array([4, 5, 6]));
    // The builders are stand-ins, so the chain is only passed through; identity is what is checked.
    const marker = {} as Chain;

    const account = await build(owner, 'memory_account', marker);
    const [created] = vi.mocked(buildCreateAccountTx).mock.calls[0] ?? [];
    expect(created?.chain).toBe(marker);
    expect(created?.owner).toBe(owner.suiAddress);
    expect(account).toEqual({
      txBytesBase64: 'AQID',
      summary: [
        { label: 'Action', value: 'Create your Walrus Memory account' },
        { label: 'Account owner', value: owner.suiAddress },
      ],
    });

    const added = await build(owner, 'add_delegate', marker);
    const [call] = vi.mocked(buildAddDelegateTx).mock.calls[0] ?? [];
    expect(call?.chain).toBe(marker);
    expect(call?.owner).toBe(owner.suiAddress);
    expect(call?.accountId).toBe(accountId);
    expect(call?.label).toBe('Ellai');
    expect(toHex(call?.delegatePublicKey ?? new Uint8Array())).toBe(delegate.publicKeyHex);
    expect(added.summary).toEqual([
      { label: 'Action', value: "Add Ellai's key to your Walrus Memory account" },
      { label: 'Walrus Memory account', value: accountId },
      { label: 'Key added', value: delegate.publicKeyHex },
      { label: 'Key name', value: 'Ellai' },
    ]);
  });
});
