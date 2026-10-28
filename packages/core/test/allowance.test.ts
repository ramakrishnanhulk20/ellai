// Covers, offline: the owner's issue transaction decoding with the exact terms, gas and
// epoch window; refusal of bad issue terms; the refill build being repeatable, decoding
// as the sponsored allowance spend, and passing assertRefill; assertRefill refusing every
// hand-built tampering the work order names (amount, allowance, recipient, sender, gas
// owner, an extra command) plus the funder, the coin, the gas budget, attached gas coins,
// the nonce and garbage bytes; and refillDecision's three bounds, swept and fuzzed over
// purse values around them. The owner's move of USDC coins into the address balance: its commands
// and gas, the same bytes for the same coins in any order, the coin cap, an empty list refused as
// NOTHING_TO_MOVE, bad coin refs refused, and assertUsdcToAddress refusing another recipient,
// another coin type, a third party's coin in place of or beside the owner's, another sender or gas
// payer, an extra command, a bigger budget and attached gas coins. An owner paying gas with SUI
// coins: the coins as gas payment in order with no expiration for both builds, bad gas coin lists
// refused, and the move's byte check refusing gas paid another way than the facts say. The owner's
// revoke: one revoke call typed in the Balance of USDC with the cap owned and the allowance shared
// and mutable, paid either way, and assertRevokeAllowance refusing another allowance, another cap or
// cap version, the allowance read-only, an extra command, another sender and another gas payer.
// Does NOT cover: whether Sui accepts these transactions (prove:pay and prove:end send real ones),
// whether the allowance on chain belongs to this owner and purse (getAllowance in
// chain.test.ts reads that), whether the coins named are the owner's own at their current
// versions (listUsdcCoins reads that), whether the cap is the owner's (findAllowanceCap reads
// that), or signing.
import { randomInt } from 'node:crypto';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  type AllowanceTerms,
  AllowanceError,
  assertRefill,
  assertRevokeAllowance,
  assertUsdcToAddress,
  buildIssueAllowance,
  buildRefill,
  buildRevokeAllowance,
  buildUsdcToAddress,
  type ChainFacts,
  type CoinGasFacts,
  type RefillArgs,
  type RefillFacts,
  refillDecision,
  type CoinRef,
  type RevokeArgs,
  type UsdcMoveArgs,
} from '../src/allowance.js';
import type { CanonicalPayment } from '../src/challenge.js';
import { LIMITS } from '../src/limits.js';
import { buildPaymentBytes } from '../src/payment.js';
import { USDC_TYPE_MAINNET } from '../src/usdc.js';

const OWNER = normalizeSuiAddress(`0x${'0a'.repeat(32)}`);
const PURSE = normalizeSuiAddress(`0x${'0b'.repeat(32)}`);
const GAS_WALLET = normalizeSuiAddress(`0x${'0c'.repeat(32)}`);
const ALLOWANCE_ID = normalizeSuiAddress(`0x${'0d'.repeat(32)}`);
const ATTACKER = normalizeSuiAddress(`0x${'a7'.repeat(32)}`);
const SUI = normalizeStructTag('0x2::sui::SUI');
const MAINNET_CHAIN = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

const FACTS: ChainFacts = { epoch: 1_290n, referenceGasPrice: 100n, nonce: 4_242_424_242 };
const REFILL_FACTS: RefillFacts = { ...FACTS, allowanceInitialSharedVersion: 1_050_464_896n };
const TERMS: AllowanceTerms = {
  lifetimeCapAtomic: 1_000_000n,
  periodMs: 86_400_000n,
  periodLimitAtomic: 500_000n,
  expirationMs: 1_800_000_000_000n,
};
const REFILL: RefillArgs = {
  spender: PURSE,
  funder: OWNER,
  allowanceId: ALLOWANCE_ID,
  amountAtomic: BigInt(LIMITS.purseRefillAtomic),
  gasOwner: GAS_WALLET,
};

function decoded(bytes: Uint8Array) {
  const parsed = bcs.TransactionData.parse(bytes);
  if (parsed.$kind !== 'V1' || parsed.V1.kind.$kind !== 'ProgrammableTransaction') throw new Error('not a programmable transaction');
  return { v1: parsed.V1, ptb: parsed.V1.kind.ProgrammableTransaction };
}

type Ptb = ReturnType<typeof decoded>['ptb'];

function pureBytes(ptb: Ptb, argument: unknown): Uint8Array {
  const index = (argument as { Input?: number }).Input;
  const input = index === undefined ? undefined : ptb.inputs[index];
  if (input?.$kind !== 'Pure') throw new Error('argument is not a pure input');
  return fromBase64(input.Pure.bytes);
}

async function refusalOf(call: Promise<unknown>): Promise<AllowanceError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof AllowanceError) return error;
    throw error;
  }
  throw new Error('expected an AllowanceError');
}

describe('buildIssueAllowance', () => {
  it('decodes with the exact terms, the owner paying gas from its address balance', async () => {
    const { v1, ptb } = decoded(await buildIssueAllowance({ owner: OWNER, spender: PURSE, terms: TERMS }, FACTS));
    expect(v1.sender).toBe(OWNER);
    expect(v1.gasData).toEqual({ payment: [], owner: OWNER, price: '100', budget: String(LIMITS.issueGasBudgetMist) });
    expect(v1.expiration).toEqual({
      $kind: 'ValidDuring',
      ValidDuring: { minEpoch: '1290', maxEpoch: '1291', minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: FACTS.nonce },
    });

    const [rateLimit, some, issue, extra] = ptb.commands;
    expect(extra).toBeUndefined();
    if (rateLimit?.$kind !== 'MoveCall' || some?.$kind !== 'MoveCall' || issue?.$kind !== 'MoveCall') throw new Error('expected three Move calls');
    const framework = normalizeSuiAddress('0x2');
    expect([rateLimit.MoveCall.package, rateLimit.MoveCall.module, rateLimit.MoveCall.function]).toEqual([framework, 'allowance', 'periodic_rate_limit']);
    expect(bcs.u64().parse(pureBytes(ptb, rateLimit.MoveCall.arguments[0]))).toBe('86400000');
    expect(bcs.u256().parse(pureBytes(ptb, rateLimit.MoveCall.arguments[1]))).toBe('500000');

    expect([some.MoveCall.package, some.MoveCall.module, some.MoveCall.function]).toEqual([normalizeSuiAddress('0x1'), 'option', 'some']);
    expect(some.MoveCall.typeArguments).toEqual([normalizeStructTag('0x2::allowance::RateLimit')]);
    expect(some.MoveCall.arguments).toEqual([{ $kind: 'Result', Result: 0 }]);

    expect([issue.MoveCall.package, issue.MoveCall.module, issue.MoveCall.function]).toEqual([framework, 'allowance', 'new']);
    expect(issue.MoveCall.typeArguments).toEqual([normalizeStructTag(`0x2::balance::Balance<${USDC_TYPE_MAINNET}>`)]);
    const [name, spender, cap, start, expiration, rate] = issue.MoveCall.arguments;
    expect(bcs.string().parse(pureBytes(ptb, name))).toBe('Ellai purse refills');
    expect(normalizeSuiAddress(bcs.Address.parse(pureBytes(ptb, spender)))).toBe(PURSE);
    expect(bcs.option(bcs.u256()).parse(pureBytes(ptb, cap))).toBe('1000000');
    expect(bcs.option(bcs.u64()).parse(pureBytes(ptb, start))).toBeNull();
    expect(bcs.option(bcs.u64()).parse(pureBytes(ptb, expiration))).toBe('1800000000000');
    expect(rate).toEqual({ $kind: 'Result', Result: 1 });
  });

  it('refuses bad terms, bad addresses and facts out of range', async () => {
    const issue = (terms: Partial<AllowanceTerms>, change: Partial<{ owner: string; spender: string }> = {}, facts = FACTS) =>
      refusalOf(buildIssueAllowance({ owner: OWNER, spender: PURSE, ...change, terms: { ...TERMS, ...terms } }, facts));
    expect((await issue({ lifetimeCapAtomic: 0n })).code).toBe('BAD_TERMS');
    expect((await issue({ periodLimitAtomic: TERMS.lifetimeCapAtomic + 1n })).code).toBe('BAD_TERMS');
    expect((await issue({ periodLimitAtomic: 0n })).code).toBe('BAD_TERMS');
    expect((await issue({ periodMs: 0n })).code).toBe('BAD_TERMS');
    expect((await issue({ expirationMs: 0n })).code).toBe('BAD_TERMS');
    expect((await issue({}, { spender: OWNER })).code).toBe('BAD_ARGS');
    expect((await issue({}, { spender: '0x0' })).code).toBe('BAD_ARGS');
    expect((await issue({}, { owner: 'not an address' })).code).toBe('BAD_ARGS');
    expect((await issue({}, {}, { ...FACTS, referenceGasPrice: BigInt(LIMITS.maxGasPriceMist) + 1n })).code).toBe('BAD_ARGS');
    expect((await issue({}, {}, { ...FACTS, nonce: 2 ** 32 })).code).toBe('BAD_ARGS');
  });
});

interface Tamper {
  sender?: string;
  gasOwner?: string;
  amount?: bigint;
  allowanceId?: string;
  sharedObjectId?: string;
  funder?: string;
  coinType?: string;
  recipient?: string;
  drainGasCoin?: boolean;
  budget?: number;
  gasCoin?: boolean;
}

/** The same refill as Ellai's, by hand, with one thing changed: what an attacker would hand the gas wallet. */
async function handBuiltRefill(tamper: Tamper = {}): Promise<Uint8Array> {
  const coinType = tamper.coinType ?? USDC_TYPE_MAINNET;
  const allowanceId = tamper.allowanceId ?? ALLOWANCE_ID;
  const tx = new Transaction();
  tx.setSender(tamper.sender ?? PURSE);
  const withdrawal = tx.withdrawal({
    amount: tamper.amount ?? REFILL.amountAtomic,
    type: coinType,
    from: 'allowance',
    allowance: allowanceId,
    funder: tamper.funder ?? OWNER,
  });
  const allowance = tx.sharedObjectRef({
    objectId: tamper.sharedObjectId ?? allowanceId,
    initialSharedVersion: String(REFILL_FACTS.allowanceInitialSharedVersion),
    mutable: true,
  });
  const [balance] = tx.moveCall({
    target: '0x2::allowance::balance_spend',
    typeArguments: [coinType],
    arguments: [allowance, withdrawal, tx.object.clock()],
  });
  if (balance === undefined) throw new Error('balance_spend returned nothing');
  tx.moveCall({ target: '0x2::balance::send_funds', typeArguments: [coinType], arguments: [balance, tx.pure.address(tamper.recipient ?? PURSE)] });
  if (tamper.drainGasCoin) {
    const [stolen] = tx.splitCoins(tx.gas, [1_000_000]);
    if (stolen === undefined) throw new Error('splitCoins returned nothing');
    tx.transferObjects([stolen], ATTACKER);
  }
  tx.setGasOwner(tamper.gasOwner ?? GAS_WALLET);
  tx.setGasPrice(REFILL_FACTS.referenceGasPrice);
  tx.setGasBudget(tamper.budget ?? LIMITS.refillGasBudgetMist);
  tx.setGasPayment(
    tamper.gasCoin ? [{ objectId: `0x${'0e'.repeat(32)}`, version: '7', digest: toBase58(new Uint8Array(32).fill(9)) }] : [],
  );
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(REFILL_FACTS.epoch),
      maxEpoch: String(REFILL_FACTS.epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: MAINNET_CHAIN,
      nonce: REFILL_FACTS.nonce,
    },
  });
  return tx.build();
}

describe('buildRefill and assertRefill', () => {
  it('builds the same bytes for the same args and facts, and other bytes for another nonce', async () => {
    const first = await buildRefill(REFILL, REFILL_FACTS);
    expect(await buildRefill(REFILL, REFILL_FACTS)).toEqual(first);
    expect(await buildRefill(REFILL, { ...REFILL_FACTS, nonce: REFILL_FACTS.nonce + 1 })).not.toEqual(first);
    await expect(assertRefill(first, REFILL, REFILL_FACTS)).resolves.toBeUndefined();
  });

  it('decodes as one allowance spend sent to the purse, sponsored by the gas wallet', async () => {
    const { v1, ptb } = decoded(await buildRefill(REFILL, REFILL_FACTS));
    expect(v1.sender).toBe(PURSE);
    expect(v1.gasData).toEqual({ payment: [], owner: GAS_WALLET, price: '100', budget: String(LIMITS.refillGasBudgetMist) });
    expect(ptb.inputs[0]).toEqual({
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '100000' },
        typeArg: { $kind: 'Balance', Balance: USDC_TYPE_MAINNET },
        withdrawFrom: { $kind: 'SenderAllowance', SenderAllowance: { funder: OWNER, allowance: ALLOWANCE_ID } },
      },
    });
    expect(ptb.inputs[1]).toEqual({
      $kind: 'Object',
      Object: { $kind: 'SharedObject', SharedObject: { objectId: ALLOWANCE_ID, initialSharedVersion: '1050464896', mutable: true } },
    });
    const [spend, send] = ptb.commands;
    if (spend?.$kind !== 'MoveCall' || send?.$kind !== 'MoveCall') throw new Error('expected two Move calls');
    expect(ptb.commands).toHaveLength(2);
    expect([spend.MoveCall.module, spend.MoveCall.function, spend.MoveCall.typeArguments]).toEqual(['allowance', 'balance_spend', [USDC_TYPE_MAINNET]]);
    expect([send.MoveCall.module, send.MoveCall.function]).toEqual(['balance', 'send_funds']);
    expect(normalizeSuiAddress(bcs.Address.parse(pureBytes(ptb, send.MoveCall.arguments[1])))).toBe(PURSE);
  });

  it('accepts the hand-built control, so each tampering below changes one thing only', async () => {
    expect(await handBuiltRefill()).toEqual(await buildRefill(REFILL, REFILL_FACTS));
  });

  const tamperings: Array<[string, Tamper, string]> = [
    ['another amount', { amount: 150_000n }, 'the spend amount is not the refill amount'],
    ['another allowance', { allowanceId: normalizeSuiAddress(`0x${'5e'.repeat(32)}`) }, 'the spend is not through the allowance named'],
    ['another recipient', { recipient: ATTACKER }, 'the refill is not sent to the purse'],
    ['another sender', { sender: ATTACKER }, 'the sender is not the purse'],
    ['another gas owner', { gasOwner: ATTACKER }, 'the gas owner is not the gas wallet'],
    ['an extra command that drains the gas coin', { drainGasCoin: true }, 'the transaction has 4 commands, a refill has 2'],
    ['another funder', { funder: ATTACKER }, 'the spend does not debit the funder named'],
    ['another coin', { coinType: SUI }, 'the spend is not in Sui Mainnet USDC'],
    ['a bigger gas budget', { budget: LIMITS.refillGasBudgetMist * 10 }, 'the gas budget is not the refill budget'],
    ['an attached gas coin', { gasCoin: true }, 'the transaction carries gas coins'],
    ['a shared object that is not the allowance spent', { sharedObjectId: ATTACKER }, 'input 1 is not the expected input'],
  ];
  for (const [what, tamper, reason] of tamperings) {
    it(`refuses ${what}`, async () => {
      const refusal = await refusalOf(assertRefill(await handBuiltRefill(tamper), REFILL, REFILL_FACTS));
      expect(refusal.code).toBe('MISMATCH');
      expect(refusal.message).toBe(reason);
    });
  }

  it('refuses bytes built for another nonce, garbage, and args it would never build', async () => {
    const built = await buildRefill(REFILL, REFILL_FACTS);
    expect((await refusalOf(assertRefill(built, REFILL, { ...REFILL_FACTS, nonce: 1 }))).message).toBe('the nonce is not the one built with');
    expect((await refusalOf(assertRefill(Uint8Array.from([1, 2, 3]), REFILL, REFILL_FACTS))).message).toBe('the bytes do not decode as a Sui transaction');
    const tooMuch = { ...REFILL, amountAtomic: BigInt(LIMITS.purseRefillAtomic) + 1n };
    expect((await refusalOf(buildRefill(tooMuch, REFILL_FACTS))).code).toBe('BAD_ARGS');
    expect((await refusalOf(buildRefill({ ...REFILL, amountAtomic: 0n }, REFILL_FACTS))).code).toBe('BAD_ARGS');
    expect((await refusalOf(buildRefill({ ...REFILL, gasOwner: PURSE }, REFILL_FACTS))).code).toBe('BAD_ARGS');
    expect((await refusalOf(buildRefill({ ...REFILL, funder: PURSE }, REFILL_FACTS))).code).toBe('BAD_ARGS');
    expect((await refusalOf(buildRefill(REFILL, { ...REFILL_FACTS, allowanceInitialSharedVersion: 0n }))).code).toBe('BAD_ARGS');
  });

  it('builds on the same Sui Mainnet chain id as the payment builder', async () => {
    const payment: CanonicalPayment = {
      dialect: 'x402-v1-t2000',
      sellerUrl: 'https://seller.example/',
      sellerHost: 'seller.example',
      recipient: ATTACKER,
      amount: 10_000n,
      asset: USDC_TYPE_MAINNET,
      network: 'sui:mainnet',
      expiresAtMs: Date.now() + 60_000,
      challengeId: 'challenge-1',
      nonce: '1',
      minEpoch: REFILL_FACTS.epoch,
      maxEpoch: REFILL_FACTS.epoch + 1n,
      resource: null,
    };
    const paymentWindow = decoded(await buildPaymentBytes(payment, PURSE)).v1.expiration;
    const refillWindow = decoded(await buildRefill(REFILL, REFILL_FACTS)).v1.expiration;
    if (paymentWindow.$kind !== 'ValidDuring' || refillWindow.$kind !== 'ValidDuring') throw new Error('expected ValidDuring windows');
    expect(refillWindow.ValidDuring.chain).toBe(paymentWindow.ValidDuring.chain);
  });
});

const coinRef = (byte: string, version: bigint): CoinRef => ({
  objectId: normalizeSuiAddress(`0x${byte.repeat(32)}`),
  version,
  digest: toBase58(new Uint8Array(32).fill(Number.parseInt(byte, 16))),
});
const COIN_A = coinRef('c1', 11n);
const COIN_B = coinRef('c2', 22n);
const COIN_C = coinRef('c3', 33n);
const THEIR_COIN = coinRef('c4', 44n);
// Out of order on purpose: the build sorts by object id.
const MOVE: UsdcMoveArgs = { owner: OWNER, coins: [COIN_B, COIN_C, COIN_A] };
const byId = (a: CoinRef, b: CoinRef) => (a.objectId < b.objectId ? -1 : 1);

describe('buildUsdcToAddress', () => {
  it("merges every coin into the lowest id and sends that coin to the owner's own address balance, the owner paying gas from its address balance", async () => {
    const { v1, ptb } = decoded(await buildUsdcToAddress(MOVE, FACTS));
    expect(v1.sender).toBe(OWNER);
    expect(v1.gasData).toEqual({ payment: [], owner: OWNER, price: '100', budget: String(LIMITS.usdcMoveGasBudgetMist) });
    expect(v1.expiration).toEqual({
      $kind: 'ValidDuring',
      ValidDuring: { minEpoch: '1290', maxEpoch: '1291', minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: FACTS.nonce },
    });
    expect(ptb.inputs.slice(0, 3)).toEqual(
      [COIN_A, COIN_B, COIN_C].map((coin) => ({
        $kind: 'Object',
        Object: { $kind: 'ImmOrOwnedObject', ImmOrOwnedObject: { objectId: coin.objectId, version: String(coin.version), digest: coin.digest } },
      })),
    );
    expect(normalizeSuiAddress(bcs.Address.parse(pureBytes(ptb, { Input: 3 })))).toBe(OWNER);
    expect(ptb.inputs).toHaveLength(4);

    const [merge, send, extra] = ptb.commands;
    expect(extra).toBeUndefined();
    if (merge?.$kind !== 'MergeCoins' || send?.$kind !== 'MoveCall') throw new Error('expected MergeCoins then a Move call');
    expect(merge.MergeCoins.destination).toMatchObject({ $kind: 'Input', Input: 0 });
    expect(merge.MergeCoins.sources).toMatchObject([{ $kind: 'Input', Input: 1 }, { $kind: 'Input', Input: 2 }]);
    expect([send.MoveCall.package, send.MoveCall.module, send.MoveCall.function]).toEqual([normalizeSuiAddress('0x2'), 'coin', 'send_funds']);
    expect(send.MoveCall.typeArguments).toEqual([USDC_TYPE_MAINNET]);
    expect(send.MoveCall.arguments).toMatchObject([{ $kind: 'Input', Input: 0 }, { $kind: 'Input', Input: 3 }]);
  });

  it('sends a single coin with no merge, and builds the same bytes for the same coins in any order', async () => {
    const single = decoded(await buildUsdcToAddress({ owner: OWNER, coins: [COIN_B] }, FACTS));
    expect(single.ptb.commands.map((command) => command.$kind)).toEqual(['MoveCall']);
    const sorted = await buildUsdcToAddress({ owner: OWNER, coins: [COIN_A, COIN_B, COIN_C] }, FACTS);
    expect(await buildUsdcToAddress(MOVE, FACTS)).toEqual(sorted);
    expect(await buildUsdcToAddress({ owner: OWNER, coins: [COIN_C, COIN_A, COIN_B] }, FACTS)).toEqual(sorted);
    expect(await buildUsdcToAddress(MOVE, { ...FACTS, nonce: FACTS.nonce + 1 })).not.toEqual(sorted);
  });

  it('takes up to LIMITS.ownedCoinsMax coins, refuses one more, and refuses no coins at all as NOTHING_TO_MOVE', async () => {
    const many = Array.from({ length: LIMITS.ownedCoinsMax + 1 }, (_, i) => ({
      objectId: normalizeSuiAddress(`0x${(i + 1).toString(16).padStart(4, '0')}${'ee'.repeat(30)}`),
      version: BigInt(i + 1),
      digest: toBase58(new Uint8Array(32).fill(i + 1)),
    }));
    const atCap = decoded(await buildUsdcToAddress({ owner: OWNER, coins: many.slice(0, LIMITS.ownedCoinsMax) }, FACTS));
    expect(atCap.ptb.inputs).toHaveLength(LIMITS.ownedCoinsMax + 1);
    expect(atCap.ptb.commands.map((command) => command.$kind)).toEqual(['MergeCoins', 'MoveCall']);
    const overCap = await refusalOf(buildUsdcToAddress({ owner: OWNER, coins: many }, FACTS));
    expect([overCap.code, overCap.message]).toEqual(['BAD_ARGS', `a transaction names at most ${LIMITS.ownedCoinsMax} USDC coins`]);
    const none = await refusalOf(buildUsdcToAddress({ owner: OWNER, coins: [] }, FACTS));
    expect([none.code, none.message]).toEqual(['NOTHING_TO_MOVE', 'there are no USDC coins to move']);
    expect((await refusalOf(assertUsdcToAddress(new Uint8Array([1]), { owner: OWNER, coins: [] }, FACTS))).code).toBe('NOTHING_TO_MOVE');
  });

  it('refuses a coin named twice, a version or digest out of form, a bad owner and facts out of range', async () => {
    const move = (coins: unknown[], owner = OWNER, facts = FACTS) => refusalOf(buildUsdcToAddress({ owner, coins: coins as CoinRef[] }, facts));
    expect((await move([COIN_A, { ...COIN_B, objectId: COIN_A.objectId }])).message).toBe('one of the USDC coins is named twice');
    expect((await move([{ ...COIN_A, version: 0n }])).message).toBe('a version among the USDC coins is not a positive u64');
    expect((await move([{ ...COIN_A, version: 11 }])).message).toBe('a version among the USDC coins is not a positive u64');
    expect((await move([{ ...COIN_A, digest: toBase58(new Uint8Array(31)) }])).message).toBe('a digest among the USDC coins is not 32 bytes of base58');
    expect((await move([{ ...COIN_A, objectId: '0x0' }])).message).toBe('an id among the USDC coins is the zero address');
    expect((await move([null])).code).toBe('BAD_ARGS');
    expect((await move([COIN_A], 'not an address')).message).toBe('the owner is not a Sui address');
    expect((await move([COIN_A], OWNER, { ...FACTS, referenceGasPrice: BigInt(LIMITS.maxGasPriceMist) + 1n })).code).toBe('BAD_ARGS');
    expect((await refusalOf(buildUsdcToAddress({ owner: OWNER, coins: 'all' as never }, FACTS))).message).toBe('the USDC coins are not a list');
  });
});

const GAS_COIN_1 = coinRef('d1', 101n);
const GAS_COIN_2 = coinRef('d2', 102n);
// Not sorted: gas coins stay in the order given, the first being the one Sui merges the rest into.
const COIN_GAS: CoinGasFacts = { referenceGasPrice: 100n, gasCoins: [GAS_COIN_2, GAS_COIN_1] };
const asPayment = (coins: CoinRef[]) => coins.map((coin) => ({ objectId: coin.objectId, version: String(coin.version), digest: coin.digest }));

describe('an owner paying gas with SUI coins', () => {
  it('names the coins as gas payment in the order given, with no expiration, for the allowance and for the move', async () => {
    const issue = decoded(await buildIssueAllowance({ owner: OWNER, spender: PURSE, terms: TERMS }, COIN_GAS));
    expect(issue.v1.gasData).toEqual({ payment: asPayment([GAS_COIN_2, GAS_COIN_1]), owner: OWNER, price: '100', budget: String(LIMITS.issueGasBudgetMist) });
    expect(issue.v1.expiration).toEqual({ $kind: 'None', None: true });
    const fromBalance = decoded(await buildIssueAllowance({ owner: OWNER, spender: PURSE, terms: TERMS }, FACTS));
    expect(issue.ptb).toEqual(fromBalance.ptb);

    const built = await buildUsdcToAddress(MOVE, COIN_GAS);
    const move = decoded(built);
    expect(move.v1.gasData).toEqual({ payment: asPayment([GAS_COIN_2, GAS_COIN_1]), owner: OWNER, price: '100', budget: String(LIMITS.usdcMoveGasBudgetMist) });
    expect(move.v1.expiration).toEqual({ $kind: 'None', None: true });
    expect(move.ptb).toEqual(decoded(await buildUsdcToAddress(MOVE, FACTS)).ptb);
    await expect(assertUsdcToAddress(built, MOVE, COIN_GAS)).resolves.toBeUndefined();
  });

  it('refuses no gas coins, too many, one named twice, and a gas coin that is also a USDC coin moved', async () => {
    const issue = (gasCoins: CoinRef[]) => refusalOf(buildIssueAllowance({ owner: OWNER, spender: PURSE, terms: TERMS }, { referenceGasPrice: 100n, gasCoins }));
    expect((await issue([])).message).toBe('a coin-paid transaction names no gas coins');
    const many = Array.from({ length: LIMITS.ownedCoinsMax + 1 }, (_, i) => coinRef((i + 16).toString(16), 1n));
    expect((await issue(many)).message).toBe(`a transaction names at most ${LIMITS.ownedCoinsMax} gas coins`);
    expect((await issue([GAS_COIN_1, GAS_COIN_1])).message).toBe('one of the gas coins is named twice');
    expect((await refusalOf(buildIssueAllowance({ owner: OWNER, spender: PURSE, terms: TERMS }, { ...COIN_GAS, referenceGasPrice: 0n }))).message).toBe('the gas price is outside the limits');
    const overlap = await refusalOf(buildUsdcToAddress(MOVE, { referenceGasPrice: 100n, gasCoins: [COIN_A] }));
    expect([overlap.code, overlap.message]).toEqual(['BAD_ARGS', 'a gas coin is also one of the USDC coins moved']);
  });

  it('refuses a move whose gas is paid another way than the facts say', async () => {
    const coinPaid = await buildUsdcToAddress(MOVE, COIN_GAS);
    const balancePaid = await buildUsdcToAddress(MOVE, FACTS);
    const refusals: Array<[Uint8Array, CoinGasFacts | ChainFacts, string]> = [
      [coinPaid, FACTS, 'the transaction carries gas coins'],
      [balancePaid, COIN_GAS, 'the gas coins are not the ones built with'],
      [coinPaid, { ...COIN_GAS, gasCoins: [GAS_COIN_1, GAS_COIN_2] }, 'the gas coins are not the ones built with'],
      [coinPaid, { ...COIN_GAS, gasCoins: [GAS_COIN_2, { ...GAS_COIN_1, version: 103n }] }, 'the gas coins are not the ones built with'],
      [coinPaid, { ...COIN_GAS, referenceGasPrice: 101n }, 'the gas price is not the price built with'],
    ];
    for (const [bytes, facts, reason] of refusals) {
      const refusal = await refusalOf(assertUsdcToAddress(bytes, MOVE, facts));
      expect([refusal.code, refusal.message]).toEqual(['MISMATCH', reason]);
    }
    const withWindow = Transaction.from(coinPaid);
    withWindow.setExpiration({ ValidDuring: { minEpoch: '1290', maxEpoch: '1291', minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: 1 } });
    const windowed = await refusalOf(assertUsdcToAddress(await withWindow.build(), MOVE, COIN_GAS));
    expect(windowed.message).toBe('a coin-paid transaction carries an expiration');
  });
});

interface MoveTamper {
  sender?: string;
  gasOwner?: string;
  recipient?: string;
  coinType?: string;
  coins?: CoinRef[];
  budget?: number;
  gasCoin?: boolean;
  drainGasCoin?: boolean;
}

/** The same move as Ellai's, by hand, with one thing changed: what a tampered client would hand back. */
async function handBuiltMove(tamper: MoveTamper = {}): Promise<Uint8Array> {
  const coins = [...(tamper.coins ?? MOVE.coins)].sort(byId);
  const tx = new Transaction();
  tx.setSender(tamper.sender ?? OWNER);
  const [first, ...rest] = coins.map((coin) => tx.objectRef({ objectId: coin.objectId, version: String(coin.version), digest: coin.digest }));
  if (first === undefined) throw new Error('a move needs a coin');
  if (rest.length > 0) tx.mergeCoins(first, rest);
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [tamper.coinType ?? USDC_TYPE_MAINNET], arguments: [first, tx.pure.address(tamper.recipient ?? OWNER)] });
  if (tamper.drainGasCoin) {
    const [stolen] = tx.splitCoins(tx.gas, [1_000_000]);
    if (stolen === undefined) throw new Error('splitCoins returned nothing');
    tx.transferObjects([stolen], ATTACKER);
  }
  tx.setGasOwner(tamper.gasOwner ?? OWNER);
  tx.setGasPrice(FACTS.referenceGasPrice);
  tx.setGasBudget(tamper.budget ?? LIMITS.usdcMoveGasBudgetMist);
  tx.setGasPayment(tamper.gasCoin ? [{ objectId: `0x${'0e'.repeat(32)}`, version: '7', digest: toBase58(new Uint8Array(32).fill(9)) }] : []);
  tx.setExpiration({
    ValidDuring: { minEpoch: String(FACTS.epoch), maxEpoch: String(FACTS.epoch + 1n), minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: FACTS.nonce },
  });
  return tx.build();
}

describe('assertUsdcToAddress', () => {
  it('passes a fresh build, and the hand-built control is that build, so each tampering below changes one thing only', async () => {
    const built = await buildUsdcToAddress(MOVE, FACTS);
    await expect(assertUsdcToAddress(built, MOVE, FACTS)).resolves.toBeUndefined();
    expect(await handBuiltMove()).toEqual(built);
  });

  const tamperings: Array<[string, MoveTamper, string]> = [
    ['another recipient', { recipient: ATTACKER }, "the coins are not sent to the owner's own address balance"],
    ['another coin type', { coinType: SUI }, 'a call is not typed in Sui Mainnet USDC'],
    ["a third party's coin in place of one of the owner's", { coins: [COIN_A, COIN_B, THEIR_COIN] }, 'an object in the transaction is not one of the coins named'],
    ["a third party's coin beside the owner's", { coins: [...MOVE.coins, THEIR_COIN] }, 'the transaction has 5 inputs, this move has 4'],
    ['another sender', { sender: ATTACKER }, 'the sender is not the owner'],
    ['another gas payer', { gasOwner: ATTACKER }, 'the gas owner is not the owner'],
    ['an extra command that drains the gas coin', { drainGasCoin: true }, 'the transaction has 4 commands, this move has 2'],
    ['a bigger gas budget', { budget: LIMITS.usdcMoveGasBudgetMist * 10 }, 'the gas budget is not the move budget'],
    ['an attached gas coin', { gasCoin: true }, 'the transaction carries gas coins'],
  ];
  for (const [what, tamper, reason] of tamperings) {
    it(`refuses ${what}`, async () => {
      const refusal = await refusalOf(assertUsdcToAddress(await handBuiltMove(tamper), MOVE, FACTS));
      expect([refusal.code, refusal.message]).toEqual(['MISMATCH', reason]);
    });
  }

  it('refuses bytes built for another nonce, garbage, and a refill in place of the move', async () => {
    const built = await buildUsdcToAddress(MOVE, FACTS);
    expect((await refusalOf(assertUsdcToAddress(built, MOVE, { ...FACTS, nonce: 1 }))).message).toBe('the nonce is not the one built with');
    expect((await refusalOf(assertUsdcToAddress(Uint8Array.from([1, 2, 3]), MOVE, FACTS))).message).toBe('the bytes do not decode as a Sui transaction');
    expect((await refusalOf(assertUsdcToAddress(await buildRefill(REFILL, REFILL_FACTS), MOVE, FACTS))).code).toBe('MISMATCH');
  });
});

const CAP = coinRef('ca', 5n);
const REVOKE: RevokeArgs = { owner: OWNER, allowance: { objectId: ALLOWANCE_ID, initialSharedVersion: 1_050_464_896n }, cap: CAP };

interface RevokeTamper {
  sender?: string;
  gasOwner?: string;
  allowanceId?: string;
  cap?: CoinRef;
  mutable?: boolean;
  drainGasCoin?: boolean;
}

/** The same revoke as Ellai's, by hand, with one thing changed: what a tampered client would hand back. */
async function handBuiltRevoke(tamper: RevokeTamper = {}): Promise<Uint8Array> {
  const cap = tamper.cap ?? CAP;
  const tx = new Transaction();
  tx.setSender(tamper.sender ?? OWNER);
  const capRef = tx.objectRef({ objectId: cap.objectId, version: String(cap.version), digest: cap.digest });
  const allowance = tx.sharedObjectRef({
    objectId: tamper.allowanceId ?? ALLOWANCE_ID,
    initialSharedVersion: String(REVOKE.allowance.initialSharedVersion),
    mutable: tamper.mutable ?? true,
  });
  tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: [normalizeStructTag(`0x2::balance::Balance<${USDC_TYPE_MAINNET}>`)], arguments: [capRef, allowance] });
  if (tamper.drainGasCoin) {
    const [stolen] = tx.splitCoins(tx.gas, [1_000_000]);
    if (stolen === undefined) throw new Error('splitCoins returned nothing');
    tx.transferObjects([stolen], ATTACKER);
  }
  tx.setGasOwner(tamper.gasOwner ?? OWNER);
  tx.setGasPrice(FACTS.referenceGasPrice);
  tx.setGasBudget(LIMITS.revokeGasBudgetMist);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: { minEpoch: String(FACTS.epoch), maxEpoch: String(FACTS.epoch + 1n), minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: FACTS.nonce },
  });
  return tx.build();
}

describe('buildRevokeAllowance and assertRevokeAllowance', () => {
  it('holds exactly one revoke typed in the Balance of USDC, the cap as an owned ref and the allowance as a mutable shared ref, and passes its own check', async () => {
    const built = await buildRevokeAllowance(REVOKE, FACTS);
    const { v1, ptb } = decoded(built);
    expect(v1.sender).toBe(OWNER);
    expect(v1.gasData).toEqual({ payment: [], owner: OWNER, price: '100', budget: String(LIMITS.revokeGasBudgetMist) });
    expect(v1.expiration).toEqual({
      $kind: 'ValidDuring',
      ValidDuring: { minEpoch: '1290', maxEpoch: '1291', minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: FACTS.nonce },
    });
    expect(ptb.inputs).toEqual([
      { $kind: 'Object', Object: { $kind: 'ImmOrOwnedObject', ImmOrOwnedObject: { objectId: CAP.objectId, version: '5', digest: CAP.digest } } },
      { $kind: 'Object', Object: { $kind: 'SharedObject', SharedObject: { objectId: ALLOWANCE_ID, initialSharedVersion: '1050464896', mutable: true } } },
    ]);
    const [revoke, extra] = ptb.commands;
    expect(extra).toBeUndefined();
    if (revoke?.$kind !== 'MoveCall') throw new Error('expected one Move call');
    expect([revoke.MoveCall.package, revoke.MoveCall.module, revoke.MoveCall.function]).toEqual([normalizeSuiAddress('0x2'), 'allowance', 'revoke']);
    expect(revoke.MoveCall.typeArguments).toEqual([normalizeStructTag(`0x2::balance::Balance<${USDC_TYPE_MAINNET}>`)]);
    expect(revoke.MoveCall.arguments).toMatchObject([{ $kind: 'Input', Input: 0 }, { $kind: 'Input', Input: 1 }]);

    await expect(assertRevokeAllowance(built, REVOKE, FACTS)).resolves.toBeUndefined();
    expect(await handBuiltRevoke()).toEqual(built);
    const coinPaid = await buildRevokeAllowance(REVOKE, COIN_GAS);
    expect(decoded(coinPaid).ptb).toEqual(ptb);
    await expect(assertRevokeAllowance(coinPaid, REVOKE, COIN_GAS)).resolves.toBeUndefined();
  });

  const tamperings: Array<[string, RevokeTamper, string]> = [
    ['another allowance', { allowanceId: normalizeSuiAddress(`0x${'5e'.repeat(32)}`) }, 'the allowance is not the one named'],
    ['another cap', { cap: coinRef('cb', 5n) }, 'the cap is not the one named'],
    ['the cap at another version', { cap: { ...CAP, version: 6n } }, 'the cap is not the one named'],
    ['the allowance passed read-only', { mutable: false }, 'the allowance is not passed as mutable'],
    ['an extra command that drains the gas coin', { drainGasCoin: true }, 'the transaction has 3 commands, a revoke has 1'],
    ['another sender', { sender: ATTACKER }, 'the sender is not the owner'],
    ['another gas owner', { gasOwner: ATTACKER }, 'the gas owner is not the owner'],
  ];
  for (const [what, tamper, reason] of tamperings) {
    it(`refuses ${what}`, async () => {
      const refusal = await refusalOf(assertRevokeAllowance(await handBuiltRevoke(tamper), REVOKE, FACTS));
      expect([refusal.code, refusal.message]).toEqual(['MISMATCH', reason]);
    });
  }
});

const REFILL_SIZE = BigInt(LIMITS.purseRefillAtomic);
const BELOW = BigInt(LIMITS.purseRefillBelowAtomic);
const FLOAT = BigInt(LIMITS.purseMaxFloatAtomic);

describe('refillDecision', () => {
  it('refills exactly the refill size, and only while the purse is below the threshold', () => {
    expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: 0 })).toEqual({ refill: true, amountAtomic: REFILL_SIZE });
    expect(refillDecision({ purseUsdcAtomic: BELOW - 1n, refillsInWindow: 0 })).toEqual({ refill: true, amountAtomic: REFILL_SIZE });
    expect(refillDecision({ purseUsdcAtomic: BELOW, refillsInWindow: 0 })).toEqual({ refill: false, amountAtomic: 0n });
    expect(refillDecision({ purseUsdcAtomic: 10n ** 30n, refillsInWindow: 0 })).toEqual({ refill: false, amountAtomic: 0n });
  });

  it('never refills past the daily count', () => {
    for (let refills = 0; refills < LIMITS.purseMaxRefillsPerDay; refills++) {
      expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: refills }).refill).toBe(true);
    }
    expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: LIMITS.purseMaxRefillsPerDay }).refill).toBe(false);
    expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: LIMITS.purseMaxRefillsPerDay + 5 }).refill).toBe(false);
  });

  it('never refills past the float cap, even when the threshold leaves room to', async () => {
    // With today's numbers the threshold alone keeps the float in bounds, so the cap is
    // shown with a threshold set above float minus refill.
    vi.resetModules();
    vi.doMock('../src/limits.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/limits.js')>();
      return { LIMITS: { ...original.LIMITS, purseRefillBelowAtomic: 150_000, purseRefillAtomic: 100_000, purseMaxFloatAtomic: 200_000 } };
    });
    try {
      const { refillDecision: loose } = await import('../src/allowance.js');
      expect(loose({ purseUsdcAtomic: 100_000n, refillsInWindow: 0 })).toEqual({ refill: true, amountAtomic: 100_000n });
      expect(loose({ purseUsdcAtomic: 100_001n, refillsInWindow: 0 })).toEqual({ refill: false, amountAtomic: 0n });
      expect(loose({ purseUsdcAtomic: 149_999n, refillsInWindow: 0 })).toEqual({ refill: false, amountAtomic: 0n });
    } finally {
      vi.doUnmock('../src/limits.js');
      vi.resetModules();
    }
  });

  it('keeps every bound across a sweep and 5,000 random purses', () => {
    const purses: bigint[] = [];
    for (let atomic = 0n; atomic <= 3n * FLOAT; atomic += 1_000n) purses.push(atomic, atomic + 1n);
    for (let i = 0; i < 5_000; i++) purses.push(BigInt(randomInt(0, 2 ** 40)));
    for (const purse of purses) {
      for (let refills = 0; refills <= LIMITS.purseMaxRefillsPerDay + 1; refills++) {
        const { refill, amountAtomic } = refillDecision({ purseUsdcAtomic: purse, refillsInWindow: refills });
        if (refill) {
          expect(amountAtomic).toBe(REFILL_SIZE);
          expect(purse < BELOW && refills < LIMITS.purseMaxRefillsPerDay && purse + amountAtomic <= FLOAT).toBe(true);
        } else {
          expect(amountAtomic).toBe(0n);
          expect(purse >= BELOW || refills >= LIMITS.purseMaxRefillsPerDay).toBe(true);
        }
      }
    }
  });

  it('fails closed on input it cannot read', () => {
    const none = { refill: false, amountAtomic: 0n };
    expect(refillDecision({ purseUsdcAtomic: -1n, refillsInWindow: 0 })).toEqual(none);
    expect(refillDecision({ purseUsdcAtomic: 0 as unknown as bigint, refillsInWindow: 0 })).toEqual(none);
    expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: Number.NaN })).toEqual(none);
    expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: -1 })).toEqual(none);
    expect(refillDecision({ purseUsdcAtomic: 0n, refillsInWindow: 0.5 })).toEqual(none);
    expect(refillDecision(undefined as unknown as { purseUsdcAtomic: bigint; refillsInWindow: number })).toEqual(none);
  });
});
