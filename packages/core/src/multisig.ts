import { isDeepStrictEqual } from 'node:util';
import { bcs } from '@mysten/sui/bcs';
import type { PublicKey } from '@mysten/sui/cryptography';
import { type Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { MultiSigPublicKey, type MultiSigSigner } from '@mysten/sui/multisig';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, SUI_ADDRESS_LENGTH } from '@mysten/sui/utils';
import { isValidTransactionSignature } from '@mysten/sui/verify';
import { canonicalSuiAddress } from './keys.js';
import { LIMITS } from './limits.js';
import { SUI_MAINNET_CHAIN_ID } from './network.js';
import { USDC_TYPE_MAINNET } from './usdc.js';

/** A gasless USDC send between Ellai's purses and the owner. Every field is checked before a build. */
export interface InternalSendArgs {
  /** The sender: a recovery purse, or Ellai's single-key purse when it funds one. */
  from: string;
  to: string;
  amountAtomic: bigint;
  /** The epoch the chain is in now. The send is valid in it and in the next one. */
  epoch: bigint;
  /** A random u32, so two otherwise equal sends get different digests. */
  nonce: number;
}

export type MultisigErrorCode = 'BAD_KEYS' | 'BAD_ARGS' | 'BUILD_FAILED' | 'MISMATCH' | 'NOT_A_MEMBER' | 'SIGN_FAILED';

/**
 * Every refusal from this module. The message is fixed text plus counts, never a value
 * from the arguments or the bytes, because these messages reach logs.
 */
export class MultisigError extends Error {
  readonly code: MultisigErrorCode;

  constructor(code: MultisigErrorCode, message: string) {
    super(message);
    this.name = 'MultisigError';
    this.code = code;
  }
}

// A test pins this send to the bytes payment.ts makes for the same terms.
const REDEEM_FUNDS = '0x2::balance::redeem_funds';
const SEND_FUNDS = '0x2::balance::send_funds';

// Either key alone reaches the threshold. That is the recovery promise: the owner never
// needs Ellai to take the float back, and Ellai never needs the owner to pay.
const MEMBER_WEIGHT = 1;
const THRESHOLD = 1;

const U32_MAX = 0xffff_ffff;
const U64_MAX = 2n ** 64n - 1n;
const ZERO_ADDRESS = normalizeSuiAddress('0x0');

interface SendTerms {
  from: string;
  to: string;
  amount: bigint;
  minEpoch: bigint;
  maxEpoch: bigint;
  nonce: number;
}

function fail(code: MultisigErrorCode, message: string): never {
  throw new MultisigError(code, message);
}

function addressOrFail(value: unknown, what: string): string {
  let address: string;
  try {
    if (typeof value !== 'string') throw new Error('not text');
    address = canonicalSuiAddress(value);
  } catch {
    return fail('BAD_ARGS', `${what} is not a Sui address`);
  }
  if (address === ZERO_ADDRESS) fail('BAD_ARGS', `${what} is the zero address`);
  return address;
}

/**
 * The owner's recovery purse: a Sui multisig of Ellai's purse key and the owner's own key,
 * weight 1 each, threshold 1, so either key alone can move the purse's USDC. The members
 * are always in the order Ellai, then owner, because the address is a hash over the
 * ordered member list and any other order is another address.
 * Which keys may be members, and that they differ, is judged by the SDK's own
 * MultiSigPublicKey, the same code that parses a multisig signature on the way in.
 * Throws MultisigError BAD_KEYS when Ellai's key is not an Ed25519 public key or the SDK
 * refuses the pair (the same key twice, or an owner key that is itself a multisig).
 */
export function recoveryPurse(ellaiPurse: Ed25519PublicKey, owner: PublicKey): { address: string; multisig: MultiSigPublicKey } {
  if (!(ellaiPurse instanceof Ed25519PublicKey)) fail('BAD_KEYS', "Ellai's purse key is not an Ed25519 public key");
  let multisig: MultiSigPublicKey;
  try {
    multisig = MultiSigPublicKey.fromPublicKeys({
      threshold: THRESHOLD,
      publicKeys: [
        { publicKey: ellaiPurse, weight: MEMBER_WEIGHT },
        { publicKey: owner, weight: MEMBER_WEIGHT },
      ],
    });
  } catch {
    return fail('BAD_KEYS', 'the SDK refused these two keys as members of one multisig');
  }
  return { address: canonicalSuiAddress(multisig.toSuiAddress()), multisig };
}

function sendTerms(args: InternalSendArgs): SendTerms {
  const from = addressOrFail(args?.from, 'the sender');
  const to = addressOrFail(args.to, 'the recipient');
  if (from === to) fail('BAD_ARGS', 'the sender and the recipient are the same address');
  const amount = args.amountAtomic;
  if (typeof amount !== 'bigint' || amount < BigInt(LIMITS.minPaymentAtomic) || amount > BigInt(LIMITS.internalSendMaxAtomic)) {
    fail('BAD_ARGS', 'the amount is outside the internal send limits');
  }
  const span = BigInt(LIMITS.paymentMaxEpochSpan);
  if (typeof args.epoch !== 'bigint' || args.epoch < 0n || args.epoch > U64_MAX - span) {
    fail('BAD_ARGS', 'the epoch is not a u64 with room for the next one');
  }
  if (!Number.isSafeInteger(args.nonce) || args.nonce < 0 || args.nonce > U32_MAX) fail('BAD_ARGS', 'the nonce is not a u32');
  return { from, to, amount, minEpoch: args.epoch, maxEpoch: args.epoch + span, nonce: args.nonce };
}

/** The same calls, in the same order, with the same gas and window, as payment.ts's buildSend. */
async function buildSend(terms: SendTerms): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(terms.from);
  const [balance] = tx.moveCall({
    target: REDEEM_FUNDS,
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [tx.withdrawal({ amount: terms.amount, type: USDC_TYPE_MAINNET })],
  });
  if (balance === undefined) fail('BUILD_FAILED', 'redeem_funds returned nothing');
  tx.moveCall({
    target: SEND_FUNDS,
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [balance, tx.pure.address(terms.to)],
  });
  // Gas price 0, budget 0 and no gas coins are what make the send gasless on Sui.
  tx.setGasPrice(0);
  tx.setGasBudget(0);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(terms.minEpoch),
      maxEpoch: String(terms.maxEpoch),
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_MAINNET_CHAIN_ID,
      nonce: terms.nonce,
    },
  });
  try {
    // No client: every input is a pure value or a withdrawal, so the build is offline
    // and the same arguments always give the same bytes.
    return await tx.build();
  } catch {
    return fail('BUILD_FAILED', 'the SDK could not build the send');
  }
}

/**
 * Builds the unsigned bytes of a plain gasless USDC send, the shape payment.ts pays sellers
 * with: redeem exactly amountAtomic of Sui Mainnet USDC from the sender's address balance
 * and send it to one recipient, gas price 0, budget 0, no gas coins, valid only in epochs
 * epoch and epoch + 1 on Sui Mainnet, with the given nonce. Offline and deterministic.
 * The sender pays nothing but the amount, so a recovery purse needs no SUI.
 * Throws MultisigError: BAD_ARGS for an address that is not a Sui address, the zero address,
 * a recipient equal to the sender, an amount below LIMITS.minPaymentAtomic (the gasless
 * minimum) or above LIMITS.internalSendMaxAtomic, an epoch with no next one, or a nonce that
 * is not a u32; BUILD_FAILED.
 */
export async function buildInternalSend(args: InternalSendArgs): Promise<Uint8Array> {
  return buildSend(sendTerms(args));
}

type DecodedTransaction = ReturnType<typeof bcs.TransactionData.parse>;
type DecodedV1 = Extract<DecodedTransaction, { $kind: 'V1' }>['V1'];
type DecodedPtb = Extract<DecodedV1['kind'], { $kind: 'ProgrammableTransaction' }>['ProgrammableTransaction'];
interface Decoded {
  v1: DecodedV1;
  ptb: DecodedPtb;
}

function decode(bytes: Uint8Array): Decoded {
  let parsed: DecodedTransaction;
  try {
    parsed = bcs.TransactionData.parse(bytes);
  } catch {
    return fail('MISMATCH', 'the bytes do not decode as a Sui transaction');
  }
  if (parsed.$kind !== 'V1') fail('MISMATCH', 'the transaction is not version 1 transaction data');
  const v1 = parsed.V1;
  if (v1.kind.$kind !== 'ProgrammableTransaction') fail('MISMATCH', 'the transaction is not a programmable transaction');
  return { v1, ptb: v1.kind.ProgrammableTransaction };
}

function sameAddress(value: string, expected: string): boolean {
  return normalizeSuiAddress(value) === expected;
}

function isUsdc(type: string): boolean {
  try {
    return normalizeStructTag(type) === USDC_TYPE_MAINNET;
  } catch {
    return false;
  }
}

function pureAddress(bytesBase64: string): string | null {
  try {
    const raw = fromBase64(bytesBase64);
    return raw.length === SUI_ADDRESS_LENGTH ? normalizeSuiAddress(bcs.Address.parse(raw)) : null;
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Names the first way the decoded transaction differs from the internal send these terms describe, or null. */
function firstDifference(actual: Decoded, expected: Decoded, terms: SendTerms): string | null {
  const { v1, ptb } = actual;
  if (!sameAddress(v1.sender, terms.from)) return 'the sender is not the one built for';
  if (BigInt(v1.gasData.price) !== 0n) return 'the gas price is not zero';
  if (v1.gasData.payment.length !== 0) return 'the transaction carries gas coins';
  if (BigInt(v1.gasData.budget) !== 0n) return 'the gas budget is not zero';
  if (!sameAddress(v1.gasData.owner, terms.from)) return 'the gas owner is not the sender';

  if (v1.expiration.$kind !== 'ValidDuring') return 'the expiration is not a ValidDuring window';
  const window = v1.expiration.ValidDuring;
  if (window.minEpoch === null || window.maxEpoch === null) return 'the epoch window is open';
  if (BigInt(window.minEpoch) !== terms.minEpoch || BigInt(window.maxEpoch) !== terms.maxEpoch) {
    return 'the epoch window is not the one built for';
  }
  if (window.minTimestamp !== null || window.maxTimestamp !== null) return 'the expiration carries a timestamp';
  if (window.chain !== SUI_MAINNET_CHAIN_ID) return 'the chain is not Sui Mainnet';
  if (window.nonce !== terms.nonce) return 'the nonce is not the one built with';

  if (ptb.commands.length !== expected.ptb.commands.length) {
    return `the transaction has ${ptb.commands.length} commands, an internal send has ${expected.ptb.commands.length}`;
  }
  if (ptb.inputs.length !== expected.ptb.inputs.length) {
    return `the transaction has ${ptb.inputs.length} inputs, an internal send has ${expected.ptb.inputs.length}`;
  }

  const coinTypes: string[] = [];
  for (const command of ptb.commands) if (command.$kind === 'MoveCall') coinTypes.push(...command.MoveCall.typeArguments);
  for (const input of ptb.inputs) if (input.$kind === 'FundsWithdrawal') coinTypes.push(input.FundsWithdrawal.typeArg.Balance);
  if (!coinTypes.every(isUsdc)) return 'a coin type is not Sui Mainnet USDC';

  const amounts = ptb.inputs.flatMap((input) =>
    input.$kind === 'FundsWithdrawal' && input.FundsWithdrawal.reservation.$kind === 'MaxAmountU64'
      ? [BigInt(input.FundsWithdrawal.reservation.MaxAmountU64)]
      : [],
  );
  if (amounts.length !== 1 || amounts[0] !== terms.amount) return 'the amount is not the one built for';

  const recipients = ptb.inputs.flatMap((input) => (input.$kind === 'Pure' ? [pureAddress(input.Pure.bytes)] : []));
  if (recipients.length !== 1 || recipients[0] !== terms.to) return 'the recipient is not the one built for';

  for (const [index, command] of ptb.commands.entries()) {
    if (!isDeepStrictEqual(command, expected.ptb.commands[index])) return `command ${index} is not the expected call`;
  }
  for (const [index, input] of ptb.inputs.entries()) {
    if (!isDeepStrictEqual(input, expected.ptb.inputs[index])) return `input ${index} is not the expected input`;
  }
  return null;
}

/**
 * Proves txBytes are the internal send these args describe and nothing else. The rule is
 * "equal to a fresh build from the same args", byte for byte (standard 1). Before that, both
 * sides are decoded by the same SDK parser and compared field by field, so a refusal names
 * the first difference: sender, gas price, gas coins, gas budget and owner, the epoch
 * window, chain and nonce, the command and input counts, the coin type, the amount, the
 * recipient, then each command and input in order.
 * Covers: extra commands, other recipients, other coins, other amounts, gas, expiry.
 * Does not cover: whether this send should be made at all; the caller decides that.
 * Throws MultisigError: MISMATCH for any difference, BAD_ARGS or BUILD_FAILED when the
 * expected send itself cannot be built.
 */
export async function assertInternalSend(txBytes: Uint8Array, args: InternalSendArgs): Promise<void> {
  if (!(txBytes instanceof Uint8Array)) fail('MISMATCH', 'the send bytes are missing');
  const terms = sendTerms(args);
  const expectedBytes = await buildSend(terms);
  const difference = firstDifference(decode(txBytes), decode(expectedBytes), terms);
  if (difference !== null) fail('MISMATCH', difference);
  if (!sameBytes(txBytes, expectedBytes)) fail('MISMATCH', 'the bytes differ from a fresh build of the internal send');
}

/**
 * Reads the send terms back out of bytes, refusing anything that does not name exactly one
 * sender, one amount, one recipient and one epoch window. The result is only ever used to
 * rebuild the bytes for assertInternalSend, so a value read here cannot widen what is signed.
 */
function argsFromBytes(txBytes: Uint8Array): InternalSendArgs {
  const { v1, ptb } = decode(txBytes);
  const withdrawals = ptb.inputs.flatMap((input) => (input.$kind === 'FundsWithdrawal' ? [input.FundsWithdrawal] : []));
  const [withdrawal] = withdrawals;
  if (withdrawals.length !== 1 || withdrawal === undefined) fail('MISMATCH', 'the transaction does not withdraw exactly once');
  if (withdrawal.reservation.$kind !== 'MaxAmountU64') fail('MISMATCH', 'the withdrawal has no fixed amount');
  const recipients = ptb.inputs.flatMap((input) => (input.$kind === 'Pure' ? [pureAddress(input.Pure.bytes)] : []));
  const [to] = recipients;
  if (recipients.length !== 1 || typeof to !== 'string') fail('MISMATCH', 'the transaction does not send to exactly one address');
  if (v1.expiration.$kind !== 'ValidDuring') fail('MISMATCH', 'the transaction has no epoch window');
  const { minEpoch, nonce } = v1.expiration.ValidDuring;
  if (minEpoch === null) fail('MISMATCH', 'the transaction has no epoch window');
  return {
    from: normalizeSuiAddress(v1.sender),
    to,
    amountAtomic: BigInt(withdrawal.reservation.MaxAmountU64),
    epoch: BigInt(minEpoch),
    nonce,
  };
}

/**
 * Signs txBytes with one member's key and combines that one signature into a multisig
 * signature for this multisig key, which is what the chain checks for a send from the
 * recovery purse. The bytes must be an internal send from this multisig's address that
 * passes assertInternalSend (C6): anything else is refused before the key signs.
 * The member's weight alone must reach the threshold, as the SDK's MultiSigSigner checks,
 * and the combined signature is verified against the multisig address before it is returned.
 * Covers: extra commands, gas, another sender, amounts outside the internal send limits.
 * Does not cover: which recipient is right. The bytes name it, so a caller that has its own
 * intended send runs assertInternalSend with its own args first, as prove:multisig does.
 * Returns the base64 multisig signature, a bearer value: never log it.
 * Throws MultisigError: MISMATCH or BAD_ARGS for bytes that are not such a send, BAD_KEYS
 * for a missing multisig key, NOT_A_MEMBER when the key is not a member or its weight is
 * under the threshold, SIGN_FAILED when the combined signature does not verify.
 */
export async function signAsMultisigMember(txBytes: Uint8Array, member: Ed25519Keypair, multisig: MultiSigPublicKey): Promise<string> {
  if (!(txBytes instanceof Uint8Array)) fail('MISMATCH', 'the send bytes are missing');
  if (!(multisig instanceof MultiSigPublicKey)) fail('BAD_KEYS', 'the multisig key is missing');
  const address = canonicalSuiAddress(multisig.toSuiAddress());
  const args = argsFromBytes(txBytes);
  if (args.from !== address) fail('MISMATCH', 'the sender is not the multisig');
  await assertInternalSend(txBytes, args);

  let signer: MultiSigSigner;
  try {
    signer = multisig.getSigner(member);
  } catch {
    return fail('NOT_A_MEMBER', 'the key is not a member of the multisig, or its weight alone is under the threshold');
  }
  let signature: string;
  try {
    signature = (await signer.signTransaction(txBytes)).signature;
  } catch {
    return fail('SIGN_FAILED', 'the SDK could not sign or combine the signature');
  }
  if (!(await isValidTransactionSignature(txBytes, signature, { address }))) {
    fail('SIGN_FAILED', 'the combined signature does not verify for the multisig address');
  }
  return signature;
}
