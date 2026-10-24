// Covers, offline: the owner's issue transaction decoding with the exact terms, gas and
// epoch window; refusal of bad issue terms; the refill build being repeatable, decoding
// as the sponsored allowance spend, and passing assertRefill; assertRefill refusing every
// hand-built tampering the work order names (amount, allowance, recipient, sender, gas
// owner, an extra command) plus the funder, the coin, the gas budget, attached gas coins,
// the nonce and garbage bytes; and refillDecision's three bounds, swept and fuzzed over
// purse values around them.
// Does NOT cover: whether Sui accepts these transactions (prove:pay sends real ones),
// whether the allowance on chain belongs to this owner and purse (getAllowance in
// chain.test.ts reads that), or signing.
import { randomInt } from 'node:crypto';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  type AllowanceTerms,
  AllowanceError,
  assertRefill,
  buildIssueAllowance,
  buildRefill,
  type ChainFacts,
  type RefillArgs,
  type RefillFacts,
  refillDecision,
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
