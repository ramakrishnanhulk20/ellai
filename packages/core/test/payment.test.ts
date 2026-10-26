// Covers: building the t2000 gasless USDC send from a canonical payment parsed out of a
// saved live 402, offline and deterministically; checkPayable refusing what the build
// refuses, with the same code, a reserved Sui address as recipient included; assertPlainUsdcSend
// refusing every hand-built variant the work order names; signPayment's expiry and epoch
// refusals (a window already closed, while one ending in the current epoch is still signed) and
// what it signs; t2000's own seller verifier, run offline, accepting Ellai's header
// (byte for byte the header t2000's payer makes) and rejecting tampered bytes; and
// verifySettlement's rule on hand-made balance changes.
// Does NOT cover: the live epoch or a dry run through Tatum (probe:pay does both),
// reading a real settlement from chain (prove:pay does that), whether the seller is
// honest, multisig payers, or x402 v2 payments.
import { readFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase58, toBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import {
  buildX402SignedPayment,
  encodeX402Header,
  parseX402Header,
  USDC,
  verifyX402Payment,
  type X402Requirements,
} from '@t2000/sui-x402';
import { describe, expect, it } from 'vitest';
import type { BalanceChange } from '../src/chain.js';
import { type CanonicalPayment, parseChallenge } from '../src/challenge.js';
import type { SafeResponse } from '../src/net.js';
import {
  assertPlainUsdcSend,
  buildPaymentBytes,
  checkPayable,
  PaymentError,
  paymentHeader,
  signPayment,
  verifySettlement,
} from '../src/payment.js';
import { USDC_TYPE_MAINNET } from '../src/usdc.js';

interface Fixture {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const FIXTURES = new URL('./fixtures/', import.meta.url);
// The moment the live 402s were captured, so their epochs and timeouts read as fresh.
const NOW = Date.parse('2026-10-20T14:04:00Z');
const EPOCH_AT_CAPTURE = 1286n;

function load(dir: 'live' | 'adversarial', name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${dir}/${name}.json`, FIXTURES), 'utf8')) as Fixture;
}

function paymentFrom(dir: 'live' | 'adversarial', name: string): CanonicalPayment {
  const fixture = load(dir, name);
  const response: SafeResponse = {
    status: fixture.status,
    headers: fixture.headers,
    bodyText: fixture.body,
    url: fixture.url,
    host: new URL(fixture.url).hostname,
  };
  return parseChallenge(response, NOW);
}

function liveRequirements(name: string): X402Requirements {
  return (JSON.parse(load('live', name).body) as { accepts: [X402Requirements] }).accepts[0];
}

async function refusalOf(call: Promise<unknown>): Promise<PaymentError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof PaymentError) return error;
    throw error;
  }
  throw new Error('expected a PaymentError');
}

const LIVE = 'agentproof-preflight';
const payment = paymentFrom('live', LIVE);
const payer = Ed25519Keypair.generate();
const ATTACKER = `0x${'a7'.repeat(32)}`;
const SUI = normalizeStructTag('0x2::sui::SUI');

interface Tamper {
  sender?: string;
  recipient?: string;
  amount?: bigint;
  coinType?: string;
  extraCommand?: boolean;
  gasPrice?: number;
  gasCoin?: boolean;
  nonce?: number;
  epochShift?: bigint;
}

/** The same build as Ellai's, by hand, with one thing changed: what an attacker would hand in. */
async function handBuilt(tamper: Tamper): Promise<Uint8Array> {
  const coinType = tamper.coinType ?? USDC_TYPE_MAINNET;
  const shift = tamper.epochShift ?? 0n;
  const tx = new Transaction();
  tx.setSender(tamper.sender ?? payer.toSuiAddress());
  const [balance] = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [coinType],
    arguments: [tx.withdrawal({ amount: tamper.amount ?? payment.amount, type: coinType })],
  });
  if (balance === undefined) throw new Error('redeem_funds returned nothing');
  tx.moveCall({
    target: '0x2::balance::send_funds',
    typeArguments: [coinType],
    arguments: [balance, tx.pure.address(tamper.recipient ?? payment.recipient)],
  });
  if (tamper.extraCommand) tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinType] });
  tx.setGasPrice(tamper.gasPrice ?? 0);
  tx.setGasBudget(0);
  tx.setGasPayment(
    tamper.gasCoin ? [{ objectId: `0x${'0b'.repeat(32)}`, version: '7', digest: toBase58(new Uint8Array(32).fill(9)) }] : [],
  );
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String((payment.minEpoch ?? 0n) + shift),
      maxEpoch: String((payment.maxEpoch ?? 0n) + shift),
      minTimestamp: null,
      maxTimestamp: null,
      chain: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
      nonce: tamper.nonce ?? Number(payment.nonce),
    },
  });
  return tx.build();
}

describe('buildPaymentBytes', () => {
  it('gives identical bytes for the same canonical payment, twice', async () => {
    const first = await buildPaymentBytes(payment, payer.toSuiAddress());
    const second = await buildPaymentBytes(paymentFrom('live', LIVE), payer.toSuiAddress());
    expect(toBase64(second)).toBe(toBase64(first));
  });

  it("carries the live challenge's own chain id, epoch window and nonce", async () => {
    type Suimpp = { chain: string; nonce: number; minEpoch: string; maxEpoch: string };
    const suimpp = (liveRequirements(LIVE).extra as { suimpp: Suimpp }).suimpp;
    const data = TransactionDataBuilder.fromBytes(await buildPaymentBytes(payment, payer.toSuiAddress())).getData();
    expect(data.expiration).toMatchObject({
      ValidDuring: { chain: suimpp.chain, nonce: suimpp.nonce, minEpoch: suimpp.minEpoch, maxEpoch: suimpp.maxEpoch },
    });
  });

  it('refuses any dialect but t2000 x402 v1', async () => {
    const v2 = paymentFrom('adversarial', 'v2-mainnet');
    expect((await refusalOf(buildPaymentBytes(v2, payer.toSuiAddress()))).code).toBe('UNSUPPORTED_DIALECT');
  });
});

describe('checkPayable', () => {
  /** A live challenge with its t2000 extra.suimpp block taken out, as a plain x402 v1 seller sends it. */
  function withoutSuimpp(): CanonicalPayment {
    const fixture = load('live', LIVE);
    const body = JSON.parse(fixture.body) as { accepts: Array<{ extra: Record<string, unknown> }> };
    for (const option of body.accepts) delete option.extra.suimpp;
    const response: SafeResponse = { status: fixture.status, headers: fixture.headers, bodyText: JSON.stringify(body), url: fixture.url, host: new URL(fixture.url).hostname };
    return parseChallenge(response, NOW);
  }

  async function codeOf(run: () => unknown): Promise<string> {
    return (await refusalOf(Promise.resolve().then(run))).code;
  }

  it('passes a payment buildPaymentBytes can build', () => {
    expect(() => checkPayable(payment)).not.toThrow();
  });

  it('refuses a recipient Sui reserves for itself, as parseChallenge does, for a payment that did not come from it', async () => {
    for (const recipient of ['0x0', '0x2', '0xf', '0x403', '0xacc']) {
      const reserved = { ...payment, recipient: normalizeSuiAddress(recipient) };
      expect(await codeOf(() => checkPayable(reserved))).toBe('BUILD_FAILED');
      expect(await codeOf(() => buildPaymentBytes(reserved, payer.toSuiAddress()))).toBe('BUILD_FAILED');
    }
  });

  it('refuses, with the code buildPaymentBytes gives, a v2 payment and a v1 payment with no t2000 binding fields', async () => {
    const v2 = paymentFrom('adversarial', 'v2-mainnet');
    const plainV1 = withoutSuimpp();
    expect(plainV1).toMatchObject({ dialect: 'x402-v1-t2000', challengeId: null, nonce: null, minEpoch: null, maxEpoch: null });
    for (const [unpayable, code] of [
      [v2, 'UNSUPPORTED_DIALECT'],
      [plainV1, 'BUILD_FAILED'],
      [{ ...payment, maxEpoch: (payment.minEpoch ?? 0n) + 2n }, 'BUILD_FAILED'],
    ] as const) {
      expect(await codeOf(() => checkPayable(unpayable))).toBe(code);
      expect(await codeOf(() => buildPaymentBytes(unpayable, payer.toSuiAddress()))).toBe(code);
    }
  });
});

describe('assertPlainUsdcSend', () => {
  it('accepts the bytes buildPaymentBytes made', async () => {
    const bytes = await buildPaymentBytes(payment, payer.toSuiAddress());
    await expect(assertPlainUsdcSend(bytes, payment, payer.toSuiAddress())).resolves.toBeUndefined();
  });

  it.each<[string, Tamper, string]>([
    ['a different recipient', { recipient: ATTACKER }, 'the recipient is not the canonical payment recipient'],
    ['the amount plus one', { amount: payment.amount + 1n }, 'the amount is not the canonical payment amount'],
    ['a different coin type', { coinType: SUI }, 'a coin type is not Sui Mainnet USDC'],
    ['an extra command', { extraCommand: true }, 'the transaction has 3 commands, a plain USDC send has 2'],
    ['a non-zero gas price', { gasPrice: 1_000 }, 'the gas price is not zero'],
    ['a gas coin added', { gasCoin: true }, 'the transaction carries gas coins'],
    ['a different sender', { sender: Ed25519Keypair.generate().toSuiAddress() }, 'the sender is not the payer'],
    ['a different nonce', { nonce: Number(payment.nonce) + 1 }, "the nonce is not the challenge's"],
    ['a different epoch window', { epochShift: 1n }, "the epoch window is not the challenge's"],
  ])('refuses %s as MISMATCH and says what differs', async (_name, tamper, message) => {
    const failure = await refusalOf(assertPlainUsdcSend(await handBuilt(tamper), payment, payer.toSuiAddress()));
    expect(failure.code).toBe('MISMATCH');
    expect(failure.message).toBe(message);
  });
});

describe('signPayment', () => {
  it('signs exactly the asserted bytes and reports their own digest', async () => {
    const signed = await signPayment(payment, payer, NOW, EPOCH_AT_CAPTURE);
    const bytes = fromBase64(signed.txBytesBase64);
    expect(toBase64(bytes)).toBe(toBase64(await buildPaymentBytes(payment, payer.toSuiAddress())));
    expect(signed.payer).toBe(payer.toSuiAddress());
    expect(signed.digest).toBe(TransactionDataBuilder.getDigestFromBytes(bytes));
    const signer = await verifyTransactionSignature(bytes, signed.signature, { address: signed.payer });
    expect(signer.toSuiAddress()).toBe(payer.toSuiAddress());
  });

  it('refuses an expired payment', async () => {
    expect((await refusalOf(signPayment(payment, payer, payment.expiresAtMs, EPOCH_AT_CAPTURE))).code).toBe('EXPIRED');
    expect((await refusalOf(signPayment(payment, payer, Number.NaN, EPOCH_AT_CAPTURE))).code).toBe('EXPIRED');
  });

  it("refuses when the chain is outside the challenge's epoch window", async () => {
    expect((await refusalOf(signPayment(payment, payer, NOW, EPOCH_AT_CAPTURE - 1n))).code).toBe('WRONG_EPOCH');
    expect((await refusalOf(signPayment(payment, payer, NOW, EPOCH_AT_CAPTURE + 2n))).code).toBe('WRONG_EPOCH');
  });

  it('signs a window that ends in the current epoch, [E, E] or [E - 1, E], and refuses one that has already closed', async () => {
    const sameEpoch = { ...payment, maxEpoch: payment.minEpoch };
    expect(payment.maxEpoch).toBe(EPOCH_AT_CAPTURE + 1n);
    await expect(signPayment(sameEpoch, payer, NOW, EPOCH_AT_CAPTURE)).resolves.toHaveProperty('digest');
    await expect(signPayment(payment, payer, NOW, EPOCH_AT_CAPTURE + 1n)).resolves.toHaveProperty('digest');
    expect((await refusalOf(signPayment(sameEpoch, payer, NOW, EPOCH_AT_CAPTURE + 1n))).code).toBe('WRONG_EPOCH');
  });
});

// What a t2000 seller passes as "expected": its own terms, and the challenge id read back
// from the payment itself (serve route.ts, step 1).
function sellerExpects(challengeId: string) {
  return { challengeId, amount: '0.01', currency: USDC, recipient: payment.recipient, network: 'mainnet' as const };
}

describe("t2000's own seller verifier, run offline", () => {
  it('accepts the header for a payment built from a saved live challenge', async () => {
    const signed = await signPayment(payment, payer, NOW, EPOCH_AT_CAPTURE);
    const header = paymentHeader(payment, signed);
    expect(header.name).toBe('X-PAYMENT');

    const parsed = parseX402Header(header.value);
    expect(() => verifyX402Payment({ payment: parsed, expected: sellerExpects(parsed.payload.challengeId) })).not.toThrow();

    // Ed25519 signatures are deterministic, so t2000's own payer, given the same challenge
    // and key, must produce this exact header.
    const theirs = await buildX402SignedPayment({ requirements: liveRequirements(LIVE), signer: payer });
    expect(header.value).toBe(theirs.header);
  });

  it.each<[string, Tamper, RegExp]>([
    ['pay another recipient', { recipient: ATTACKER }, /does not pay the expected recipient/],
    ['carry another nonce', { nonce: Number(payment.nonce) + 1 }, /nonce does not bind/],
  ])('rejects a hand-built header whose bytes %s', async (_name, tamper, reason) => {
    const bytes = await handBuilt(tamper);
    const { signature } = await payer.signTransaction(bytes);
    const challengeId = payment.challengeId ?? '';
    const value = encodeX402Header({
      x402Version: 1,
      scheme: 'exact',
      network: 'sui:mainnet',
      payload: { senderAddress: payer.toSuiAddress(), txBytes: toBase64(bytes), senderSignature: signature, challengeId },
    });
    expect(() => verifyX402Payment({ payment: parseX402Header(value), expected: sellerExpects(challengeId) })).toThrow(reason);
  });
});

describe('paymentHeader', () => {
  it('refuses signed material whose digest is not the digest of its bytes', async () => {
    const signed = await signPayment(payment, payer, NOW, EPOCH_AT_CAPTURE);
    const other = await signPayment(paymentFrom('live', 'jp-task-policy-classify'), payer, NOW, EPOCH_AT_CAPTURE);
    const mixed = { ...signed, digest: other.digest };
    expect((await refusalOf(Promise.resolve().then(() => paymentHeader(payment, mixed)))).code).toBe('MISMATCH');
  });
});

describe('verifySettlement', () => {
  const PAYER = payer.toSuiAddress();
  const debit: BalanceChange = { address: PAYER, coinType: USDC_TYPE_MAINNET, amount: -payment.amount };
  const credit: BalanceChange = { address: payment.recipient, coinType: USDC_TYPE_MAINNET, amount: payment.amount };
  type Settled = Parameters<typeof verifySettlement>[0];
  const success = (balanceChanges: BalanceChange[]): Settled => ({ status: 'success', balanceChanges });

  it('verifies exactly one debit at the payer and one credit at the recipient, in USDC', () => {
    expect(verifySettlement(success([debit, credit]), payment, PAYER)).toEqual({ verified: true });
  });

  it.each<[string, Settled, string]>([
    ['a failed status', { status: 'failure', balanceChanges: [debit, credit] }, 'the transaction did not succeed on chain'],
    ['a missing payer debit', success([credit]), "the payer's USDC change is not minus the approved amount"],
    ['one unit too little taken from the payer', success([{ ...debit, amount: debit.amount + 1n }, credit]), "the payer's USDC change is not minus the approved amount"],
    ['one unit too much taken from the payer', success([{ ...debit, amount: debit.amount - 1n }, credit]), "the payer's USDC change is not minus the approved amount"],
    ['one unit too little credited to the recipient', success([debit, { ...credit, amount: credit.amount - 1n }]), "the recipient's USDC change is not plus the approved amount"],
    ['one unit too much credited to the recipient', success([debit, { ...credit, amount: credit.amount + 1n }]), "the recipient's USDC change is not plus the approved amount"],
    ['a third USDC change', success([debit, credit, { address: ATTACKER, coinType: USDC_TYPE_MAINNET, amount: 1n }]), 'another address has a USDC change'],
    ['the same amounts in a different coin', success([{ ...debit, coinType: SUI }, { ...credit, coinType: SUI }]), "the payer's USDC change is not minus the approved amount"],
  ])('refuses %s', (_name, result, reason) => {
    expect(verifySettlement(result, payment, PAYER)).toEqual({ verified: false, reason });
  });

  it('accepts the short and the long form of the same address, on either side', () => {
    const longPayer = `0x${'0'.repeat(58)}12abcd`;
    const longRecipient = `0x${'0'.repeat(60)}beef`;
    const usdcUpperCase = USDC_TYPE_MAINNET.replace(/^0x[0-9a-f]+/, (address) => `0x${address.slice(2).toUpperCase()}`);
    const longChanges = success([
      { address: longPayer, coinType: USDC_TYPE_MAINNET, amount: -payment.amount },
      { address: longRecipient, coinType: USDC_TYPE_MAINNET, amount: payment.amount },
    ]);
    const shortChanges = success([
      { address: '0x12ABCD', coinType: usdcUpperCase, amount: -payment.amount },
      { address: '0xbeef', coinType: usdcUpperCase, amount: payment.amount },
    ]);
    expect(verifySettlement(shortChanges, { ...payment, recipient: longRecipient }, longPayer)).toEqual({ verified: true });
    expect(verifySettlement(longChanges, { ...payment, recipient: '0xBEEF', asset: usdcUpperCase }, '0x12abcd')).toEqual({ verified: true });
  });
});
