// Covers: the recovery purse address (the same for the same keys, Ellai first and owner
// second, another address when the order is swapped); buildInternalSend being byte for
// byte the gasless send payment.ts builds for the same terms, repeatable, and refusing
// arguments outside its limits; assertInternalSend refusing every hand-built variant the
// work order names; signAsMultisigMember refusing bytes that fail the assert and keys
// outside the multisig; and the SDK's own verifier accepting a combined signature from
// either member alone and refusing one from an outside key.
// Does NOT cover: whether Sui Mainnet runs a gasless send from a multisig, or any read
// through Tatum (prove:multisig does both); owners with zkLogin or passkey keys; other
// weights or thresholds.
import { readFileSync } from 'node:fs';
import { parseSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519Keypair, type Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, toBase58, toBase64 } from '@mysten/sui/utils';
import { isValidTransactionSignature, verifyTransactionSignature } from '@mysten/sui/verify';
import { describe, expect, it } from 'vitest';
import { parseChallenge } from '../src/challenge.js';
import type { SafeResponse } from '../src/net.js';
import {
  assertInternalSend,
  buildInternalSend,
  type InternalSendArgs,
  MultisigError,
  recoveryPurse,
  signAsMultisigMember,
} from '../src/multisig.js';
import { buildPaymentBytes } from '../src/payment.js';
import { USDC_TYPE_MAINNET } from '../src/usdc.js';

// Fixed seeds, so every run sees the same keys and the same multisig address.
const ellai = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
const owner = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(2));
const outsider = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3));
const { address: MULTISIG, multisig } = recoveryPurse(ellai.getPublicKey(), owner.getPublicKey());
const OWNER = owner.toSuiAddress();
const ATTACKER = `0x${'a7'.repeat(32)}`;
const SUI = normalizeStructTag('0x2::sui::SUI');
const SWEEP: InternalSendArgs = { from: MULTISIG, to: OWNER, amountAtomic: 20_000n, epoch: 1300n, nonce: 424_242 };

async function refusalOf(call: Promise<unknown>): Promise<MultisigError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof MultisigError) return error;
    throw error;
  }
  throw new Error('expected a MultisigError');
}

interface Tamper {
  from?: string;
  to?: string;
  amount?: bigint;
  coinType?: string;
  extraCommand?: boolean;
  gasPrice?: number;
  gasCoin?: boolean;
  nonce?: number;
  epochShift?: bigint;
}

/** The same build as Ellai's, by hand, with one thing changed: what a caller could hand in. */
async function handBuilt(tamper: Tamper): Promise<Uint8Array> {
  const coinType = tamper.coinType ?? USDC_TYPE_MAINNET;
  const epoch = SWEEP.epoch + (tamper.epochShift ?? 0n);
  const tx = new Transaction();
  tx.setSender(tamper.from ?? SWEEP.from);
  const [balance] = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [coinType],
    arguments: [tx.withdrawal({ amount: tamper.amount ?? SWEEP.amountAtomic, type: coinType })],
  });
  if (balance === undefined) throw new Error('redeem_funds returned nothing');
  tx.moveCall({
    target: '0x2::balance::send_funds',
    typeArguments: [coinType],
    arguments: [balance, tx.pure.address(tamper.to ?? SWEEP.to)],
  });
  if (tamper.extraCommand) tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinType] });
  tx.setGasPrice(tamper.gasPrice ?? 0);
  tx.setGasBudget(0);
  tx.setGasPayment(
    tamper.gasCoin ? [{ objectId: `0x${'0b'.repeat(32)}`, version: '7', digest: toBase58(new Uint8Array(32).fill(9)) }] : [],
  );
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
      nonce: tamper.nonce ?? SWEEP.nonce,
    },
  });
  return tx.build();
}

describe('recoveryPurse', () => {
  it('gives the same address for the same two keys, Ellai first and the owner second, weight 1 each, threshold 1', () => {
    const again = recoveryPurse(
      Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1)).getPublicKey(),
      Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(2)).getPublicKey(),
    );
    expect(again.address).toBe(MULTISIG);
    expect(MULTISIG).toBe(multisig.toSuiAddress());
    expect(multisig.getThreshold()).toBe(1);
    expect(multisig.getPublicKeys().map(({ publicKey, weight }) => [publicKey.toSuiAddress(), weight])).toEqual([
      [ellai.toSuiAddress(), 1],
      [OWNER, 1],
    ]);
  });

  it('gives a different address when the members are swapped', () => {
    const swapped = MultiSigPublicKey.fromPublicKeys({
      threshold: 1,
      publicKeys: [
        { publicKey: owner.getPublicKey(), weight: 1 },
        { publicKey: ellai.getPublicKey(), weight: 1 },
      ],
    });
    expect(swapped.toSuiAddress()).not.toBe(MULTISIG);
    expect(recoveryPurse(owner.getPublicKey(), ellai.getPublicKey()).address).toBe(swapped.toSuiAddress());
  });

  it('refuses the same key as both members, and an owner key that is itself a multisig', async () => {
    const twice = Promise.resolve().then(() => recoveryPurse(ellai.getPublicKey(), ellai.getPublicKey()));
    expect((await refusalOf(twice)).code).toBe('BAD_KEYS');
    const nested = Promise.resolve().then(() => recoveryPurse(ellai.getPublicKey(), multisig));
    expect((await refusalOf(nested)).code).toBe('BAD_KEYS');
    const notEd25519 = Promise.resolve().then(() => recoveryPurse(multisig as unknown as Ed25519PublicKey, owner.getPublicKey()));
    expect((await refusalOf(notEd25519)).code).toBe('BAD_KEYS');
  });
});

describe('buildInternalSend', () => {
  it('builds byte for byte the gasless send payment.ts builds for the same terms', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/live/agentproof-preflight.json', import.meta.url), 'utf8')) as {
      url: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    };
    const response: SafeResponse = { ...fixture, bodyText: fixture.body, host: new URL(fixture.url).hostname };
    const sellerPayment = parseChallenge(response, Date.parse('2026-10-20T14:04:00Z'));
    const sameTerms = {
      ...sellerPayment,
      recipient: SWEEP.to,
      amount: SWEEP.amountAtomic,
      minEpoch: SWEEP.epoch,
      maxEpoch: SWEEP.epoch + 1n,
      nonce: String(SWEEP.nonce),
    };
    expect(toBase64(await buildInternalSend(SWEEP))).toBe(toBase64(await buildPaymentBytes(sameTerms, SWEEP.from)));
  });

  it('gives identical bytes for the same args, twice', async () => {
    expect(toBase64(await buildInternalSend({ ...SWEEP }))).toBe(toBase64(await buildInternalSend(SWEEP)));
  });

  it.each<[string, Partial<InternalSendArgs>, string]>([
    ['an amount under the 0.01 USDC gasless minimum', { amountAtomic: 9_999n }, 'the amount is outside the internal send limits'],
    ['an amount over the 0.05 USDC internal send limit', { amountAtomic: 50_001n }, 'the amount is outside the internal send limits'],
    ['a send to its own sender', { to: MULTISIG }, 'the sender and the recipient are the same address'],
    ['the zero address as recipient', { to: '0x0' }, 'the recipient is the zero address'],
    ['a nonce wider than a u32', { nonce: 2 ** 32 }, 'the nonce is not a u32'],
  ])('refuses %s', async (_name, change, message) => {
    const failure = await refusalOf(buildInternalSend({ ...SWEEP, ...change }));
    expect(failure.code).toBe('BAD_ARGS');
    expect(failure.message).toBe(message);
  });
});

describe('assertInternalSend', () => {
  it('accepts the bytes buildInternalSend made, at both ends of the amount limits', async () => {
    for (const amountAtomic of [10_000n, 50_000n]) {
      const args = { ...SWEEP, amountAtomic };
      await expect(assertInternalSend(await buildInternalSend(args), args)).resolves.toBeUndefined();
    }
  });

  it.each<[string, Tamper, string]>([
    ['another recipient', { to: ATTACKER }, 'the recipient is not the one built for'],
    ['another amount', { amount: SWEEP.amountAtomic + 1n }, 'the amount is not the one built for'],
    ['an extra command', { extraCommand: true }, 'the transaction has 3 commands, an internal send has 2'],
    ['a gas coin', { gasCoin: true }, 'the transaction carries gas coins'],
    ['a non-zero gas price', { gasPrice: 1_000 }, 'the gas price is not zero'],
    ['another sender', { from: ellai.toSuiAddress() }, 'the sender is not the one built for'],
    ['another coin type', { coinType: SUI }, 'a coin type is not Sui Mainnet USDC'],
    ['another nonce', { nonce: SWEEP.nonce + 1 }, 'the nonce is not the one built with'],
    ['another epoch window', { epochShift: 1n }, 'the epoch window is not the one built for'],
  ])('refuses %s as MISMATCH and says what differs', async (_name, tamper, message) => {
    const failure = await refusalOf(assertInternalSend(await handBuilt(tamper), SWEEP));
    expect(failure.code).toBe('MISMATCH');
    expect(failure.message).toBe(message);
  });
});

describe('signAsMultisigMember', () => {
  it.each<[string, Tamper, string]>([
    ['an extra command', { extraCommand: true }, 'the transaction has 3 commands, an internal send has 2'],
    ['a gas coin', { gasCoin: true }, 'the transaction carries gas coins'],
    ['a non-zero gas price', { gasPrice: 1_000 }, 'the gas price is not zero'],
    ['an amount over the internal send limit', { amount: 50_001n }, 'the amount is outside the internal send limits'],
    ['a sender that is not the multisig', { from: ellai.toSuiAddress() }, 'the sender is not the multisig'],
  ])('refuses bytes with %s before any key signs', async (_name, tamper, message) => {
    const failure = await refusalOf(signAsMultisigMember(await handBuilt(tamper), ellai, multisig));
    expect(failure.message).toBe(message);
  });

  it('refuses a key that is not a member', async () => {
    const failure = await refusalOf(signAsMultisigMember(await buildInternalSend(SWEEP), outsider, multisig));
    expect(failure.code).toBe('NOT_A_MEMBER');
  });
});

describe('combined signatures, checked by the SDK verifier', () => {
  it.each<[string, Ed25519Keypair, number]>([
    ["Ellai's purse key", ellai, 0],
    ["the owner's key", owner, 1],
  ])('one from %s alone verifies against the multisig address', async (_name, member, index) => {
    const bytes = await buildInternalSend(SWEEP);
    const signature = await signAsMultisigMember(bytes, member, multisig);
    const signer = await verifyTransactionSignature(bytes, signature, { address: MULTISIG });
    expect(signer.toSuiAddress()).toBe(MULTISIG);
    const parsed = parseSerializedSignature(signature);
    if (parsed.signatureScheme !== 'MultiSig') throw new Error('not a multisig signature');
    expect(parsed.multisig.bitmap).toBe(1 << index);
    expect(parsed.multisig.sigs).toHaveLength(1);
  });

  it('one from an outside key does not, alone or in its own multisig with Ellai', async () => {
    const bytes = await buildInternalSend(SWEEP);
    const plain = (await outsider.signTransaction(bytes)).signature;
    expect(await isValidTransactionSignature(bytes, plain, { address: MULTISIG })).toBe(false);

    const lookalike = recoveryPurse(ellai.getPublicKey(), outsider.getPublicKey()).multisig;
    const combined = lookalike.combinePartialSignatures([plain]);
    expect(await isValidTransactionSignature(bytes, combined)).toBe(true);
    expect(await isValidTransactionSignature(bytes, combined, { address: MULTISIG })).toBe(false);
  });
});
