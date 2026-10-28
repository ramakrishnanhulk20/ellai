// Covers: owner onboarding on PGlite against a stand-in chain. confirmOnboardingTx records each
// step only from what the chain shows, and refuses, recording nothing: a failed transaction,
// another sender's transaction, an allowance whose funder, spender or coin differs or that is
// over the onboarding maxima, a transaction that created no allowance or two, an account owned
// by someone else, a delegate list without Ellai's key, and add_delegate before the account; a new
// allowance clears the refill wait the one it replaces left.
// buildOnboardingTx refuses allowance terms outside the maxima and add_delegate before the
// account, takes owner, purse and account from the owner row, reads what Sui shows before an
// account step, and its summaries hold only validated values. confirmExistingStep takes account
// steps only, needs the account before the key, and refuses Ellai's key on another account and a
// frozen account. onboardingState follows the row. Every fee is paid from the owner's SUI address
// balance when it covers the budget, otherwise with the fewest of the owner's SUI coins that do, and
// NOT_ENOUGH_SUI when neither does. The USDC move builds from the coins Sui lists for the owner with
// its exact summary, NOTHING_TO_MOVE coming before any gas read; ownerWallet reads the owner's own
// address and splits USDC and SUI. Ending the allowance, through the build, submit and confirm
// routes: no allowance recorded is 409 not_ready and the body cannot name one; an allowance both
// getAllowance and objectExists say is gone is forgotten and 409 already_done at build and submit; one
// only getAllowance misses is kept, with build, submit and confirm answering 503 chain_unavailable
// and the steps below them ChainError UPSTREAM; no cap in the owner's wallet is 409 not_ready; the
// build is one revoke of the recorded allowance with the listed cap, summarised from the row and
// fixed text, at its pinned chain-call counts; signed bytes naming another allowance or cap are 400
// bad_transaction with nothing sent; a landed revoke is 200 ended and forgets the allowance; a
// refused one keeps it; confirm records the end only once Sui no longer has the allowance; and the
// jobs tick stops visiting the owner once the revoke lands.
// Does NOT cover: the live chain (proven read only by `npm run prove:onboarding`, and the revoke by
// `npm run prove:end -w packages/proof`), core's own registry and account reads (core's memory
// tests), or a real wallet signing the built bytes.
import { randomBytes } from 'node:crypto';
import { buildRevokeAllowance } from '@ellai/core/allowance';
import type { AllowanceCapRef, AllowanceState, Chain, OwnedCoin, WalletBalances } from '@ellai/core/chain';
import { ChainError } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { buildAddDelegateTx, buildCreateAccountTx, findMemoryAccount, MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, toBase58, toBase64, toHex } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as buildRoute from '../src/app/api/owner/onboarding/build/route.js';
import * as confirmRoute from '../src/app/api/owner/onboarding/confirm/route.js';
import * as submitRoute from '../src/app/api/owner/onboarding/submit/route.js';
import { completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { owners } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { setServerContextFactory } from '../src/server/http/context.js';
import { runJobsTick } from '../src/server/jobs/tick.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { BUILD_CHAIN_CALLS, buildOnboardingTx } from '../src/server/onboarding/build.js';
import { CONFIRM_CHAIN_CALLS, confirmExistingStep, confirmOnboardingTx } from '../src/server/onboarding/confirm.js';
import { fewestCovering, ownerWallet } from '../src/server/onboarding/funds.js';
import {
  ALLOWANCE_ENDED_MESSAGE,
  ALLOWANCE_INDEX_LAG_MESSAGE,
  type BuildStep,
  NO_ALLOWANCE_CAP_MESSAGE,
  NO_ALLOWANCE_MESSAGE,
  type OnboardingStep,
  OnboardingError,
  onboardingState,
} from '../src/server/onboarding/state.js';
import { SUBMIT_CHAIN_CALLS, submitOnboardingTx } from '../src/server/onboarding/submit.js';

const DAY_MS = 86_400_000;

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
    periodMs: BigInt(LIMITS.allowancePeriodMs),
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
  wallet?: Partial<WalletBalances>;
  suiCoins?: OwnedCoin[];
  usdcCoins?: OwnedCoin[];
  /** getAllowance answers NOT_FOUND and objectExists false, as both do once the allowance is revoked. */
  allowanceGone?: boolean;
  /** getAllowance answers NOT_FOUND while objectExists still answers true, as during a GraphQL index stall. */
  indexLag?: boolean;
  /** What findAllowanceCap answers; OWNER_CAP unless a test says otherwise. */
  cap?: AllowanceCapRef | null;
  /** How a relayed transaction ends on chain. */
  execution?: 'success' | 'failure';
}

/** The owner's AllowanceCap as findAllowanceCap reads one. */
const OWNER_CAP: AllowanceCapRef = { objectId: `0x${'ca'.repeat(32)}`, version: 7n, digest: toBase58(new Uint8Array(32).fill(7)) };

/** A coin as listUsdcCoins and listSuiCoins give it, numbered so each is its own. */
function ownedCoin(n: number, balance: bigint): OwnedCoin {
  return { objectId: `0x${n.toString(16).padStart(64, '0')}`, version: BigInt(n), digest: toBase58(new Uint8Array(32).fill(n)), balance };
}

/** A chain that answers only the reads confirm and build make, and the send submit makes. Anything else fails the test. */
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
  const getAllowance = vi.fn(async (_id: string) => {
    if (setup.allowanceGone || setup.indexLag) throw new ChainError('NOT_FOUND', 'stand-in not found');
    return { ...goodAllowance(owner), ...setup.allowance };
  });
  const objectExists = vi.fn(async (_id: string) => !setup.allowanceGone);
  const findAllowanceCap = vi.fn(async (_owner: string, _allowanceId: string) => (setup.cap === undefined ? OWNER_CAP : setup.cap));
  // One SUI in the address balance unless a test says otherwise, so a fee is paid from it.
  const getWalletBalances = vi.fn(async () => ({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiAddressBalance: 1_000_000_000n, suiCoinBalance: 0n, ...setup.wallet }));
  const listSuiCoins = vi.fn(async () => ({ coins: setup.suiCoins ?? [], more: false }));
  const listUsdcCoins = vi.fn(async () => ({ coins: setup.usdcCoins ?? [], more: false }));
  const executeTransaction = vi.fn(async (bytes: Uint8Array, _signatures: string[]) => ({
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    status: setup.execution ?? 'success',
    errorCode: setup.execution === 'failure' ? 'MOVE_ABORT' : null,
    balanceChanges: [],
    createdObjects: [],
  }));
  const chain = {
    usesApiKey: true,
    getTransactionResult,
    getAllowance,
    objectExists,
    findAllowanceCap,
    getWalletBalances,
    listSuiCoins,
    listUsdcCoins,
    executeTransaction,
    getCurrentEpoch: async () => 900n,
    getReferenceGasPrice: async () => 100n,
    grpc: { ledgerService: { getTransaction } },
  } as unknown as Chain;
  return { chain, getTransactionResult, getTransaction, getAllowance, objectExists, findAllowanceCap, getWalletBalances, listSuiCoins, listUsdcCoins, executeTransaction };
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

  it("clears a refill wait left by the allowance it replaces, so the tick reads the new one at once", async () => {
    const owner = await newOwner({ allowanceId: address(), allowanceCheckedAt: new Date(NOW.getTime() - DAY_MS), refillNotBefore: new Date(NOW.getTime() + DAY_MS) });
    const replacement = `0x${'e7'.repeat(32)}`;
    expect(await confirm(owner, 'allowance', stubChain(owner, { created: [{ objectId: replacement, type: ALLOWANCE_TYPE }] }).chain)).toEqual({ recorded: replacement });
    expect(await reread(owner)).toMatchObject({ allowanceId: replacement, allowanceCheckedAt: NOW, refillNotBefore: null });
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
      { periodMs: BigInt(LIMITS.allowancePeriodMs) * 7n },
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

describe('confirmExistingStep', () => {
  const existing = (owner: Owner, step: string, chain: Chain) =>
    confirmExistingStep({ db, ownerId: owner.id, step: step as 'memory_account', chain, masterSecretHex: MASTER, now: NOW });

  it("takes account steps only, the account before the key, and refuses Ellai's key on another account or a frozen account, recording nothing", async () => {
    const recordedAccount = address();
    const owner = await newOwner({ memwalAccountId: recordedAccount });
    const delegateHex = ownerDelegate(MASTER, owner.suiAddress).publicKeyHex;
    const { chain, getTransactionResult } = stubChain(owner);
    expect((await refusal(existing(owner, 'allowance', untouchable))).code).toBe('BAD_INPUT');
    expect((await refusal(existing(await newOwner(), 'add_delegate', untouchable))).code).toBe('NOT_READY');

    vi.mocked(findMemoryAccount).mockResolvedValueOnce({ accountId: address(), delegates: [delegateHex] });
    const elsewhere = await refusal(existing(owner, 'add_delegate', chain));
    expect([elsewhere.code, elsewhere.message]).toEqual(['REFUSED', 'Sui does not show the recorded Walrus Memory account for this owner']);
    vi.mocked(findMemoryAccount).mockRejectedValueOnce(new MemoryError('ACCOUNT', 'the Walrus Memory account is frozen'));
    const frozen = await refusal(existing(owner, 'add_delegate', chain));
    expect([frozen.code, frozen.message]).toEqual(['REFUSED', 'the Walrus Memory account is frozen']);
    expect(getTransactionResult).not.toHaveBeenCalled();
    expect((await reread(owner)).delegateRegisteredAt).toBeNull();

    vi.mocked(findMemoryAccount).mockResolvedValueOnce({ accountId: recordedAccount, delegates: [delegateHex] });
    expect(await existing(owner, 'add_delegate', chain)).toEqual({ recorded: delegateHex });
    expect((await reread(owner)).delegateRegisteredAt).toEqual(NOW);
  });
});

describe('buildOnboardingTx', () => {
  const build = (owner: Owner, step: BuildStep, chain: Chain, allowance?: unknown) =>
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
    // Sui shows no account yet, and on the recorded one no key of Ellai's.
    vi.mocked(findMemoryAccount).mockResolvedValueOnce(null).mockResolvedValueOnce({ accountId, delegates: [] });
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
    expect(vi.mocked(findMemoryAccount).mock.calls).toEqual([
      [marker, owner.suiAddress],
      [marker, owner.suiAddress],
    ]);
  });
});

describe('the fee on a setup transaction', () => {
  const TERMS = { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 1_000_000n, days: 30 };
  const buildAllowance = (owner: Owner, chain: Chain) =>
    buildOnboardingTx({ db, ownerId: owner.id, step: 'allowance', allowance: TERMS, chain, masterSecretHex: MASTER, now: NOW });
  const budget = BigInt(LIMITS.issueGasBudgetMist);

  it("is paid from the owner's SUI address balance when it covers the budget, valid this epoch and the next", async () => {
    const owner = await newOwner();
    const stub = stubChain(owner, { wallet: { suiAddressBalance: budget }, suiCoins: [ownedCoin(1, budget * 10n)] });
    const data = Transaction.from(fromBase64((await buildAllowance(owner, stub.chain)).txBytesBase64)).getData();
    expect(data.gasData.payment).toEqual([]);
    expect(data.expiration).toMatchObject({ $kind: 'ValidDuring', ValidDuring: { minEpoch: '900', maxEpoch: '901' } });
    expect(stub.getWalletBalances.mock.calls).toEqual([[owner.suiAddress]]);
    expect(stub.listSuiCoins).not.toHaveBeenCalled();
  });

  it("is paid with the fewest of the owner's SUI coins that cover it when the address balance falls short, with no expiration", async () => {
    const owner = await newOwner();
    const coins = [ownedCoin(1, budget / 4n), ownedCoin(2, budget / 2n), ownedCoin(3, budget / 2n + 1n), ownedCoin(4, 7n)];
    const stub = stubChain(owner, { wallet: { suiAddressBalance: budget - 1n }, suiCoins: coins });
    const data = Transaction.from(fromBase64((await buildAllowance(owner, stub.chain)).txBytesBase64)).getData();
    expect(data.gasData.payment?.map((ref) => ref.objectId)).toEqual([coins[2]?.objectId, coins[1]?.objectId]);
    expect(data.gasData.owner).toBe(owner.suiAddress);
    expect(data.expiration).toEqual({ $kind: 'None', None: true });
    expect(stub.listSuiCoins.mock.calls).toEqual([[owner.suiAddress]]);
  });

  it('is refused NOT_ENOUGH_SUI when neither the address balance nor all the coins cover it', async () => {
    const owner = await newOwner();
    const stub = stubChain(owner, { wallet: { suiAddressBalance: budget - 1n }, suiCoins: [ownedCoin(1, budget / 2n), ownedCoin(2, budget / 2n - 1n)] });
    const refused = await refusal(buildAllowance(owner, stub.chain));
    expect([refused.code, refused.message]).toEqual(['NOT_ENOUGH_SUI', "Your wallet needs a little SUI to pay this transaction's fee."]);
  });

  it('takes the largest coins first, ties by object id, and nothing when they fall short', () => {
    const [small, big, tieLow, tieHigh] = [ownedCoin(1, 1n), ownedCoin(2, 9n), ownedCoin(3, 5n), ownedCoin(4, 5n)];
    if (!small || !big || !tieLow || !tieHigh) throw new Error('expected four coins');
    const ids = (picked: ReturnType<typeof fewestCovering>) => picked?.map((coin) => coin.objectId) ?? null;
    expect(ids(fewestCovering([small, tieHigh, big, tieLow], 9n))).toEqual([big.objectId]);
    expect(ids(fewestCovering([small, tieHigh, big, tieLow], 14n))).toEqual([big.objectId, tieLow.objectId]);
    expect(ids(fewestCovering([small, tieHigh, big, tieLow], 21n))).toBeNull();
    expect(ids(fewestCovering([], 1n))).toBeNull();
  });
});

describe('the USDC move', () => {
  const buildMove = (owner: Owner, chain: Chain) => buildOnboardingTx({ db, ownerId: owner.id, step: 'usdc_to_address', chain, masterSecretHex: MASTER, now: NOW });

  it("moves every USDC coin Sui lists for the owner into the owner's own address balance, and says so in plain words", async () => {
    const owner = await newOwner();
    const coins = [ownedCoin(9, 1_500_000n), ownedCoin(5, 250_000n)];
    const stub = stubChain(owner, { usdcCoins: coins });
    const built = await buildMove(owner, stub.chain);
    const data = Transaction.from(fromBase64(built.txBytesBase64)).getData();
    expect(data.sender).toBe(owner.suiAddress);
    expect(data.commands.map((command) => command.$kind)).toEqual(['MergeCoins', 'MoveCall']);
    expect(data.commands[1]?.MoveCall).toMatchObject({ module: 'coin', function: 'send_funds', typeArguments: [USDC_TYPE_MAINNET] });
    expect(data.inputs.flatMap((input) => (input.Object?.ImmOrOwnedObject ? [input.Object.ImmOrOwnedObject.objectId] : []))).toEqual([coins[1]?.objectId, coins[0]?.objectId]);
    expect(built.summary).toEqual([
      { label: 'Action', value: 'Move your USDC into your address balance' },
      { label: 'Amount', value: '1.750000 USDC' },
      { label: 'From', value: '2 coins in your wallet' },
      { label: 'To', value: `your address balance at ${owner.suiAddress}` },
    ]);
    expect(stub.listUsdcCoins.mock.calls).toEqual([[owner.suiAddress]]);
    const one = await buildMove(owner, stubChain(owner, { usdcCoins: [ownedCoin(3, 10_000n)] }).chain);
    expect(one.summary[2]).toEqual({ label: 'From', value: '1 coin in your wallet' });
  });

  it('answers NOTHING_TO_MOVE for an owner with no USDC coins, or only empty ones, before reading anything about gas', async () => {
    const owner = await newOwner();
    for (const usdcCoins of [[], [ownedCoin(2, 0n)]]) {
      const stub = stubChain(owner, { usdcCoins });
      const refused = await refusal(buildMove(owner, stub.chain));
      expect([refused.code, refused.message]).toEqual(['NOTHING_TO_MOVE', 'Your wallet holds no USDC coins to move. Any USDC it has is already in its address balance.']);
      expect(stub.getWalletBalances).not.toHaveBeenCalled();
    }
  });
});

describe('ownerWallet', () => {
  it("reads the owner's own address and gives USDC and SUI each split into address balance and coins, as decimal strings", async () => {
    const owner = await newOwner();
    const stub = stubChain(owner, { wallet: { usdcAddressBalance: 2_830_000n, usdcCoinBalance: 9_007_199_254_740_993n, suiAddressBalance: 0n, suiCoinBalance: 51_000_000n } });
    expect(await ownerWallet({ db, ownerId: owner.id, chain: stub.chain })).toEqual({
      usdcAddressAtomic: '2830000',
      usdcCoinAtomic: '9007199254740993',
      suiAddressMist: '0',
      suiCoinMist: '51000000',
    });
    expect(stub.getWalletBalances.mock.calls).toEqual([[owner.suiAddress]]);
    expect((await refusal(ownerWallet({ db, ownerId: '00000000-0000-4000-8000-000000000000', chain: untouchable }))).code).toBe('NO_OWNER');
  });
});

describe('ending the allowance, through the build, submit and confirm routes', () => {
  const APP_ORIGIN = 'https://ellai.example';
  const SESSION_SECRET = randomBytes(32).toString('hex');
  const ENV: ServerEnv = {
    DATABASE_URL: 'pglite:memory',
    ELLAI_MASTER_SECRET: MASTER,
    GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
    SESSION_SECRET,
    JOBS_SECRET: randomBytes(32).toString('hex'),
    APP_ORIGIN,
  };
  // The routes read the chain from the context, so each test points it at its own stand-in.
  let routeChain: Chain = untouchable;

  beforeAll(() => setServerContextFactory(async () => ({ db, chain: routeChain, env: ENV, now: () => NOW })));
  afterAll(() => setServerContextFactory(null));

  interface SignedIn {
    row: Owner;
    cookie: string;
    signer: Ed25519Keypair;
  }

  /** An owner signed in as the app signs one in, with an allowance recorded as confirm records one unless told otherwise. */
  async function signedIn(allowanceId: string | null = address()): Promise<SignedIn> {
    const signer = Ed25519Keypair.generate();
    const { message } = await issueSignIn({ db, address: signer.toSuiAddress(), appOrigin: APP_ORIGIN, now: NOW });
    const signature = (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
    const done = await completeSignIn({ db, message, signature, appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SESSION_SECRET, now: NOW });
    if (allowanceId !== null) {
      await db.update(owners).set({ allowanceId: canonicalSuiAddress(allowanceId), allowanceCheckedAt: NOW, refillNotBefore: new Date(NOW.getTime() + DAY_MS) }).where(eq(owners.id, done.ownerId));
    }
    const [row] = await db.select().from(owners).where(eq(owners.id, done.ownerId));
    if (row === undefined) throw new Error('expected a row');
    return { row, cookie: `__Host-ellai_session=${done.sessionToken}`, signer };
  }

  const post = (route: { POST: (request: Request) => Promise<Response> }, path: string, body: unknown, cookie: string) =>
    route.POST(new Request(`${APP_ORIGIN}/api/owner/onboarding/${path}`, { method: 'POST', headers: { origin: APP_ORIGIN, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const build = (owner: SignedIn, body: unknown = { step: 'end_allowance' }) => post(buildRoute, 'build', body, owner.cookie);
  const submit = (owner: SignedIn, body: unknown) => post(submitRoute, 'submit', body, owner.cookie);
  const confirm = (owner: SignedIn, body: unknown = { step: 'end_allowance', digest: DIGEST }) => post(confirmRoute, 'confirm', body, owner.cookie);
  const answer = async (response: Response) => [response.status, await response.json()];
  const signed = async (owner: SignedIn, bytes: Uint8Array) => ({ step: 'end_allowance', txBytesBase64: toBase64(bytes), signature: (await owner.signer.signTransaction(bytes)).signature });
  /** A revoke as core builds it, for this owner's recorded allowance and OWNER_CAP unless one of them is swapped. */
  const revokeBytes = (owner: SignedIn, swap: { allowanceId?: string; cap?: AllowanceCapRef } = {}) =>
    buildRevokeAllowance(
      { owner: owner.row.suiAddress, allowance: { objectId: swap.allowanceId ?? owner.row.allowanceId ?? '', initialSharedVersion: 1n }, cap: swap.cap ?? OWNER_CAP },
      { epoch: 900n, referenceGasPrice: 100n, nonce: 7 },
    );

  it('answers 409 not_ready when the owner row records no allowance, reading nothing, and takes no allowance id from the body (C7)', async () => {
    const owner = await signedIn(null);
    routeChain = untouchable;
    expect(await answer(await build(owner))).toEqual([409, { error: 'not_ready', message: NO_ALLOWANCE_MESSAGE }]);
    expect((await build(owner, { step: 'end_allowance', allowanceId: address() })).status).toBe(400);
  });

  it("forgets an allowance both of Tatum's views say is gone and answers 409 already_done, at build and at submit, never looking for a cap or sending", async () => {
    const owner = await signedIn();
    const stub = stubChain(owner.row, { allowanceGone: true });
    routeChain = stub.chain;
    expect(await answer(await build(owner))).toEqual([409, { error: 'already_done', message: ALLOWANCE_ENDED_MESSAGE }]);
    expect(stub.getAllowance.mock.calls).toEqual([[owner.row.allowanceId]]);
    expect(stub.objectExists.mock.calls).toEqual([[owner.row.allowanceId]]);
    expect(stub.findAllowanceCap).not.toHaveBeenCalled();
    expect(await reread(owner.row)).toMatchObject({ allowanceId: null, allowanceCheckedAt: null, refillNotBefore: null });

    const other = await signedIn();
    const atSubmit = stubChain(other.row, { allowanceGone: true });
    routeChain = atSubmit.chain;
    expect(await answer(await submit(other, await signed(other, await revokeBytes(other))))).toEqual([409, { error: 'already_done', message: ALLOWANCE_ENDED_MESSAGE }]);
    expect(atSubmit.objectExists.mock.calls).toEqual([[other.row.allowanceId]]);
    expect(atSubmit.executeTransaction).not.toHaveBeenCalled();
    expect((await reread(other.row)).allowanceId).toBeNull();
  });

  it('keeps an allowance only GraphQL misses while gRPC still holds it: build, submit and confirm answer 503 chain_unavailable, forgetting and sending nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const owner = await signedIn();
      const stub = stubChain(owner.row, { indexLag: true });
      routeChain = stub.chain;
      const unavailable = [503, { error: 'chain_unavailable', message: 'Ellai could not read Sui just now. Try again in a minute.' }];
      expect(await answer(await build(owner))).toEqual(unavailable);
      expect(await answer(await submit(owner, await signed(owner, await revokeBytes(owner))))).toEqual(unavailable);
      expect(await answer(await confirm(owner))).toEqual(unavailable);
      expect(stub.objectExists.mock.calls).toEqual(Array.from({ length: 3 }, () => [owner.row.allowanceId]));
      expect(stub.findAllowanceCap).not.toHaveBeenCalled();
      expect(stub.executeTransaction).not.toHaveBeenCalled();
      expect(await reread(owner.row)).toMatchObject({ allowanceId: owner.row.allowanceId, allowanceCheckedAt: NOW, refillNotBefore: owner.row.refillNotBefore });

      // Below the routes, each step fails with the one sentence that says why.
      const lagging = { name: 'ChainError', code: 'UPSTREAM', message: ALLOWANCE_INDEX_LAG_MESSAGE };
      const common = { db, ownerId: owner.row.id, chain: stub.chain, masterSecretHex: MASTER, now: NOW };
      await expect(buildOnboardingTx({ ...common, step: 'end_allowance' })).rejects.toMatchObject(lagging);
      await expect(submitOnboardingTx({ ...common, step: 'end_allowance', txBytesBase64: toBase64(await revokeBytes(owner)), signature: 'AA==' })).rejects.toMatchObject(lagging);
      await expect(confirmOnboardingTx({ ...common, step: 'end_allowance', digest: DIGEST })).rejects.toMatchObject(lagging);
      expect((await reread(owner.row)).allowanceId).toBe(owner.row.allowanceId);
    } finally {
      warn.mockRestore();
    }
  });

  it("answers 409 not_ready when Sui shows no cap for the allowance in the owner's wallet, keeping the allowance", async () => {
    const owner = await signedIn();
    const stub = stubChain(owner.row, { cap: null });
    routeChain = stub.chain;
    expect(await answer(await build(owner))).toEqual([409, { error: 'not_ready', message: NO_ALLOWANCE_CAP_MESSAGE }]);
    expect(stub.findAllowanceCap.mock.calls).toEqual([[owner.row.suiAddress, owner.row.allowanceId]]);
    expect(stub.getWalletBalances).not.toHaveBeenCalled();
    expect((await reread(owner.row)).allowanceId).toBe(owner.row.allowanceId);
  });

  it('builds one revoke of the recorded allowance with the cap Sui lists, summarised from the owner row and fixed text, counted at its real chain calls', async () => {
    const owner = await signedIn();
    const stub = stubChain(owner.row);
    routeChain = stub.chain;
    const built = (await (await build(owner)).json()) as { txBytesBase64: string; summary: unknown };
    expect(built.summary).toEqual([
      { label: 'Action', value: 'End the allowance your Ellai purse draws from' },
      { label: 'Allowance', value: owner.row.allowanceId },
      { label: 'Purse', value: owner.row.purseAddress },
      { label: 'After this', value: 'Your purse can draw nothing more from your wallet.' },
    ]);
    const data = Transaction.from(fromBase64(built.txBytesBase64)).getData();
    expect([data.sender, data.gasData.owner, data.gasData.budget]).toEqual([owner.row.suiAddress, owner.row.suiAddress, String(LIMITS.revokeGasBudgetMist)]);
    expect(data.commands.map((command) => [command.MoveCall?.module, command.MoveCall?.function])).toEqual([['allowance', 'revoke']]);
    expect(data.inputs.map((input) => input.Object)).toEqual([
      { $kind: 'ImmOrOwnedObject', ImmOrOwnedObject: { objectId: OWNER_CAP.objectId, version: String(OWNER_CAP.version), digest: OWNER_CAP.digest } },
      { $kind: 'SharedObject', SharedObject: { objectId: owner.row.allowanceId, initialSharedVersion: '1', mutable: true } },
    ]);
    expect(stub.getAllowance.mock.calls).toEqual([[owner.row.allowanceId]]);
    expect(stub.findAllowanceCap.mock.calls).toEqual([[owner.row.suiAddress, owner.row.allowanceId]]);
    // Build: one allowance read, two cap pages at most, three gas reads. Submit: the same two re-reads, a SUI coin re-read, the send.
    // A missed allowance read stops either at the gRPC check, two calls. Confirm: the read, then that check once it misses.
    expect([BUILD_CHAIN_CALLS.end_allowance, SUBMIT_CHAIN_CALLS.end_allowance, CONFIRM_CHAIN_CALLS.end_allowance]).toEqual([6, 5, 2]);
  });

  it('refuses signed bytes naming another allowance or another cap with 400 bad_transaction, sending nothing (C6, C7)', async () => {
    const owner = await signedIn();
    const stub = stubChain(owner.row);
    routeChain = stub.chain;
    for (const swap of [{ allowanceId: address() }, { cap: { ...OWNER_CAP, objectId: address() } }, { cap: { ...OWNER_CAP, version: OWNER_CAP.version - 1n } }]) {
      const response = await submit(owner, await signed(owner, await revokeBytes(owner, swap)));
      expect(await answer(response)).toEqual([400, { error: 'bad_transaction', message: 'it is not the transaction Ellai builds for this step' }]);
    }
    expect(stub.executeTransaction).not.toHaveBeenCalled();
    expect((await reread(owner.row)).allowanceId).toBe(owner.row.allowanceId);
  });

  it('relays the revoke the build route made, answers 200 ended with its digest, and forgets the allowance', async () => {
    const owner = await signedIn();
    const stub = stubChain(owner.row);
    routeChain = stub.chain;
    const bytes = fromBase64(((await (await build(owner)).json()) as { txBytesBase64: string }).txBytesBase64);
    const body = await signed(owner, bytes);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    expect(await answer(await submit(owner, body))).toEqual([200, { ended: true, digest }]);
    expect(stub.executeTransaction.mock.calls).toEqual([[bytes, [body.signature]]]);
    expect(await reread(owner.row)).toMatchObject({ allowanceId: null, allowanceCheckedAt: null, refillNotBefore: null });
    expect((await onboardingState({ db, ownerId: owner.row.id })).allowance).toBe('missing');
  });

  it('keeps the allowance when the network refuses the revoke, answering 422 chain_refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const owner = await signedIn();
      const stub = stubChain(owner.row, { execution: 'failure' });
      routeChain = stub.chain;
      const response = await submit(owner, await signed(owner, await revokeBytes(owner)));
      expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([422, 'chain_refused']);
      expect(stub.executeTransaction).toHaveBeenCalledTimes(1);
      expect(await reread(owner.row)).toMatchObject({ allowanceId: owner.row.allowanceId, allowanceCheckedAt: NOW });
    } finally {
      warn.mockRestore();
    }
  });

  it("confirms an end from what Sui shows for the row's allowance: gone is recorded and forgotten, still there is 409 not_landed", async () => {
    const owner = await signedIn();
    routeChain = stubChain(owner.row).chain;
    const pending = await confirm(owner);
    expect([pending.status, ((await pending.json()) as { error: string }).error]).toEqual([409, 'not_landed']);
    expect((await reread(owner.row)).allowanceId).toBe(owner.row.allowanceId);

    const gone = stubChain(owner.row, { allowanceGone: true });
    routeChain = gone.chain;
    expect(await answer(await confirm(owner))).toEqual([200, { recorded: 'ended' }]);
    expect(gone.getAllowance.mock.calls).toEqual([[owner.row.allowanceId]]);
    expect(gone.objectExists.mock.calls).toEqual([[owner.row.allowanceId]]);
    expect((await reread(owner.row)).allowanceId).toBeNull();
    // Already forgotten: nothing is read, and the answer is the same.
    routeChain = untouchable;
    expect(await answer(await confirm(owner))).toEqual([200, { recorded: 'ended' }]);
  });

  it('no longer has the refill tick visit the owner once the revoke lands', async () => {
    const own = await createDb('pglite:memory');
    try {
      await migrate(own.db);
      // A purse not derived from the master secret makes the refill step refuse before any chain read, so a visit shows only in the count.
      const [row] = await own.db.insert(owners).values({ suiAddress: address(), purseAddress: address(), allowanceId: address(), allowanceCheckedAt: NOW }).returning();
      if (row === undefined) throw new Error('expected a row');
      const stub = stubChain(row);
      const getBalances = vi.fn(async () => ({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiTotal: 1_000_000_000n }));
      const tickChain = { ...(stub.chain as object), getBalances } as unknown as Chain;
      const tick = (at: Date) => runJobsTick({ db: own.db, chain: tickChain, masterSecretHex: MASTER, gasKeypair: Ed25519Keypair.generate(), now: () => at, sleep: async () => undefined });

      expect((await tick(NOW)).owners).toBe(1);
      const built = await buildOnboardingTx({ db: own.db, ownerId: row.id, step: 'end_allowance', chain: stub.chain, masterSecretHex: MASTER, now: NOW });
      const ended = await submitOnboardingTx({ db: own.db, ownerId: row.id, step: 'end_allowance', txBytesBase64: built.txBytesBase64, signature: 'AA==', chain: stub.chain, masterSecretHex: MASTER, now: NOW });
      expect(ended.status).toBe('ended');
      const reads = stub.getAllowance.mock.calls.length;
      const later = await tick(new Date(NOW.getTime() + DAY_MS));
      expect(later.owners).toBe(0);
      expect(later.errors.filter((error) => error.ownerId === row.id)).toEqual([]);
      expect(stub.getAllowance.mock.calls.length).toBe(reads);
    } finally {
      await own.close();
    }
  });
});
