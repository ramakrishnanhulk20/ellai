import { isDeepStrictEqual } from 'node:util';
import { bcs } from '@mysten/sui/bcs';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { SUI_ADDRESS_LENGTH, fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';
import type { BalanceChange } from './chain.js';
import type { CanonicalPayment } from './challenge.js';
import { canonicalSuiAddress } from './keys.js';
import { LIMITS } from './limits.js';
import { DEPLOYMENT_NETWORK, SUI_MAINNET_CHAIN_ID } from './network.js';
import { USDC_TYPE_MAINNET } from './usdc.js';

export interface SignedPayment {
  /** The exact bytes that were signed, base64. */
  txBytesBase64: string;
  signature: string;
  /** Computed by the SDK from the signed bytes, never taken from a seller or an agent. */
  digest: string;
  payer: string;
}

export type PaymentErrorCode = 'UNSUPPORTED_DIALECT' | 'EXPIRED' | 'WRONG_EPOCH' | 'MISMATCH' | 'BUILD_FAILED';

/**
 * Every refusal from this module. The message is fixed text plus counts, never a value
 * from the challenge or the bytes, because these messages reach logs and agents.
 */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

// parseChallenge refuses any t2000 challenge whose extra.suimpp.chain is not
// SUI_MAINNET_CHAIN_ID, so building with it uses the challenge's own chain id.
const SUPPORTED_DIALECT = 'x402-v1-t2000';
const X402_VERSION = 1;
const X402_SCHEME = 'exact';
const X402_PAYMENT_HEADER = 'X-PAYMENT';
const REDEEM_FUNDS = '0x2::balance::redeem_funds';
const SEND_FUNDS = '0x2::balance::send_funds';

const U32_MAX = 0xffff_ffff;
const U64_MAX = 2n ** 64n - 1n;
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const ZERO_ADDRESS = normalizeSuiAddress('0x0');

/** The values a payment transaction is built from, each already checked. */
interface SendTerms {
  payer: string;
  recipient: string;
  amount: bigint;
  minEpoch: bigint;
  maxEpoch: bigint;
  nonce: number;
}

function fail(code: PaymentErrorCode, message: string): never {
  throw new PaymentError(code, message);
}

function addressOrFail(value: unknown, what: string): string {
  try {
    if (typeof value !== 'string') throw new Error('not text');
    return canonicalSuiAddress(value);
  } catch {
    return fail('BUILD_FAILED', `${what} is not a Sui address`);
  }
}

/**
 * Re-checks a canonical payment before anything is built from it, so a payment that
 * did not come from parseChallenge still cannot reach a signature outside the limits.
 */
function payableTerms(payment: CanonicalPayment): Omit<SendTerms, 'payer'> {
  if (payment?.dialect !== SUPPORTED_DIALECT) fail('UNSUPPORTED_DIALECT', 'only the t2000 x402 v1 dialect can be paid');
  if (payment.network !== DEPLOYMENT_NETWORK) fail('BUILD_FAILED', 'the payment is not on Sui Mainnet');
  let asset: string | null;
  try {
    asset = typeof payment.asset === 'string' ? normalizeStructTag(payment.asset) : null;
  } catch {
    asset = null;
  }
  if (asset !== USDC_TYPE_MAINNET) fail('BUILD_FAILED', 'the payment asset is not Sui Mainnet USDC');
  if (
    typeof payment.amount !== 'bigint' ||
    payment.amount < BigInt(LIMITS.minPaymentAtomic) ||
    payment.amount > BigInt(LIMITS.maxPaymentAtomic)
  ) {
    fail('BUILD_FAILED', 'the amount is outside the per-payment limits');
  }
  const recipient = addressOrFail(payment.recipient, 'the recipient');
  if (recipient === ZERO_ADDRESS) fail('BUILD_FAILED', 'the recipient is the zero address');
  if (typeof payment.challengeId !== 'string' || payment.challengeId === '') fail('BUILD_FAILED', 'the challenge id is missing');
  if (typeof payment.nonce !== 'string' || !UNSIGNED_INTEGER.test(payment.nonce) || Number(payment.nonce) > U32_MAX) {
    fail('BUILD_FAILED', 'the nonce is not a u32');
  }
  const { minEpoch, maxEpoch } = payment;
  if (typeof minEpoch !== 'bigint' || typeof maxEpoch !== 'bigint' || minEpoch < 0n || maxEpoch > U64_MAX) {
    fail('BUILD_FAILED', 'the epoch window is missing');
  }
  if (minEpoch > maxEpoch || maxEpoch - minEpoch > BigInt(LIMITS.paymentMaxEpochSpan)) {
    fail('BUILD_FAILED', 'the epoch window is not one Sui accepts');
  }
  return { recipient, amount: payment.amount, minEpoch, maxEpoch, nonce: Number(payment.nonce) };
}

function sendTerms(payment: CanonicalPayment, payer: string): SendTerms {
  const terms = payableTerms(payment);
  return { payer: addressOrFail(payer, 'the payer'), ...terms };
}

/**
 * Runs, on the payment alone, every check buildPaymentBytes and signPayment run before they
 * build: the dialect, network, asset, amount limits, recipient, the t2000 challenge id and
 * nonce, and an epoch window Sui accepts. A caller runs it before asking anyone to approve a
 * payment, so nobody is asked about one Ellai would then refuse to sign. Does not cover the
 * payer, expiry or the chain's current epoch, which are only known at signing.
 * Throws PaymentError: UNSUPPORTED_DIALECT for any dialect but x402-v1-t2000, BUILD_FAILED
 * for any other check.
 */
export function checkPayable(payment: CanonicalPayment): void {
  payableTerms(payment);
}

/** The same calls, in the same order, as t2000's own payer (buildX402SignedPayment). */
async function buildSend(terms: SendTerms): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(terms.payer);
  const [balance] = tx.moveCall({
    target: REDEEM_FUNDS,
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [tx.withdrawal({ amount: terms.amount, type: USDC_TYPE_MAINNET })],
  });
  if (balance === undefined) fail('BUILD_FAILED', 'redeem_funds returned nothing');
  tx.moveCall({
    target: SEND_FUNDS,
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [balance, tx.pure.address(terms.recipient)],
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
    // and the same terms always give the same bytes.
    return await tx.build();
  } catch {
    return fail('BUILD_FAILED', 'the SDK could not build the payment');
  }
}

/**
 * Builds the unsigned bytes of the plain gasless USDC send a t2000 seller accepts:
 * redeem exactly payment.amount of Sui Mainnet USDC from the payer's address balance and
 * send it to payment.recipient, gas price 0, no gas coins, valid only inside the
 * challenge's epoch window with the challenge's nonce. Offline and deterministic.
 * Throws PaymentError: UNSUPPORTED_DIALECT for any dialect but x402-v1-t2000, and
 * BUILD_FAILED when the payment is outside the limits, lacks the t2000 binding fields,
 * carries an epoch window wider than LIMITS.paymentMaxEpochSpan, or the payer is not an address.
 */
export async function buildPaymentBytes(payment: CanonicalPayment, payer: string): Promise<Uint8Array> {
  return buildSend(sendTerms(payment, payer));
}

type DecodedTransaction = ReturnType<typeof bcs.TransactionData.parse>;
type DecodedV1 = Extract<DecodedTransaction, { $kind: 'V1' }>['V1'];
type DecodedPtb = Extract<DecodedV1['kind'], { $kind: 'ProgrammableTransaction' }>['ProgrammableTransaction'];

function decode(bytes: Uint8Array): { v1: DecodedV1; ptb: DecodedPtb } {
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

/** Names the first way the decoded transaction differs from a plain USDC send, or null. */
function firstDifference(actual: ReturnType<typeof decode>, expected: ReturnType<typeof decode>, terms: SendTerms): string | null {
  const { v1, ptb } = actual;
  if (!sameAddress(v1.sender, terms.payer)) return 'the sender is not the payer';
  if (BigInt(v1.gasData.price) !== 0n) return 'the gas price is not zero';
  if (v1.gasData.payment.length !== 0) return 'the transaction carries gas coins';
  if (BigInt(v1.gasData.budget) !== 0n) return 'the gas budget is not zero';
  if (!sameAddress(v1.gasData.owner, terms.payer)) return 'the gas owner is not the payer';

  if (v1.expiration.$kind !== 'ValidDuring') return 'the expiration is not a ValidDuring window';
  const window = v1.expiration.ValidDuring;
  if (window.minEpoch === null || window.maxEpoch === null) return 'the epoch window is open';
  if (BigInt(window.minEpoch) !== terms.minEpoch || BigInt(window.maxEpoch) !== terms.maxEpoch) {
    return "the epoch window is not the challenge's";
  }
  if (window.minTimestamp !== null || window.maxTimestamp !== null) return 'the expiration carries a timestamp';
  if (window.chain !== SUI_MAINNET_CHAIN_ID) return 'the chain is not Sui Mainnet';
  if (window.nonce !== terms.nonce) return "the nonce is not the challenge's";

  if (ptb.commands.length !== expected.ptb.commands.length) {
    return `the transaction has ${ptb.commands.length} commands, a plain USDC send has ${expected.ptb.commands.length}`;
  }
  if (ptb.inputs.length !== expected.ptb.inputs.length) {
    return `the transaction has ${ptb.inputs.length} inputs, a plain USDC send has ${expected.ptb.inputs.length}`;
  }

  const coinTypes: string[] = [];
  for (const command of ptb.commands) if (command.$kind === 'MoveCall') coinTypes.push(...command.MoveCall.typeArguments);
  for (const input of ptb.inputs) if (input.$kind === 'FundsWithdrawal') coinTypes.push(input.FundsWithdrawal.typeArg.Balance);
  if (!coinTypes.every(isUsdc)) return 'a coin type is not Sui Mainnet USDC';

  const amounts = ptb.inputs.flatMap((input) =>
    input.$kind === 'FundsWithdrawal' ? [BigInt(input.FundsWithdrawal.reservation.MaxAmountU64)] : [],
  );
  if (amounts.length !== 1 || amounts[0] !== terms.amount) return 'the amount is not the canonical payment amount';

  const recipients = ptb.inputs.flatMap((input) => (input.$kind === 'Pure' ? [pureAddress(input.Pure.bytes)] : []));
  if (recipients.length !== 1 || recipients[0] !== terms.recipient) return 'the recipient is not the canonical payment recipient';

  for (const [index, command] of ptb.commands.entries()) {
    if (!isDeepStrictEqual(command, expected.ptb.commands[index])) return `command ${index} is not the expected call`;
  }
  for (const [index, input] of ptb.inputs.entries()) {
    if (!isDeepStrictEqual(input, expected.ptb.inputs[index])) return `input ${index} is not the expected input`;
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Proves txBytes are the plain USDC send for this canonical payment and nothing else.
 * The rule is "equal to a fresh build from the canonical payment", byte for byte. Before
 * that, both sides are decoded by the same SDK parser and compared field by field, so a
 * refusal says what differs: sender, gas price, gas coins, gas budget and owner, the
 * epoch window, chain and nonce, the command and input counts, the coin type, the
 * amount, the recipient, then each command and input in order.
 * Covers: extra commands, other recipients, other coins, other amounts, gas, expiry.
 * Does not cover: whether the payment should have been approved at all.
 * Throws PaymentError: MISMATCH for any difference, UNSUPPORTED_DIALECT or BUILD_FAILED
 * when the canonical payment itself cannot be built.
 */
export async function assertPlainUsdcSend(txBytes: Uint8Array, payment: CanonicalPayment, payer: string): Promise<void> {
  if (!(txBytes instanceof Uint8Array)) fail('MISMATCH', 'the payment bytes are missing');
  const terms = sendTerms(payment, payer);
  const expectedBytes = await buildSend(terms);
  const difference = firstDifference(decode(txBytes), decode(expectedBytes), terms);
  if (difference !== null) fail('MISMATCH', difference);
  if (!sameBytes(txBytes, expectedBytes)) fail('MISMATCH', 'the bytes differ from a fresh build of the canonical payment');
}

/**
 * The only function in Ellai that signs a payment. It takes no bytes from outside: it
 * builds them from the canonical payment, asserts them with assertPlainUsdcSend, then
 * signs with the payer's key. Nothing is sent anywhere.
 * Preconditions: nowMs is before payment.expiresAtMs, and currentEpoch, read from the
 * chain by the caller, is inside the challenge's [minEpoch, maxEpoch].
 * Throws PaymentError: UNSUPPORTED_DIALECT, BUILD_FAILED, EXPIRED (also for an unreadable
 * time), WRONG_EPOCH, or MISMATCH.
 */
export async function signPayment(
  payment: CanonicalPayment,
  payerKeypair: Ed25519Keypair,
  nowMs: number,
  currentEpoch: bigint,
): Promise<SignedPayment> {
  const payer = payerKeypair.toSuiAddress();
  const terms = sendTerms(payment, payer);
  // A NaN on either side would make the comparison false and let an expired payment through.
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(payment.expiresAtMs) || nowMs >= payment.expiresAtMs) {
    fail('EXPIRED', 'the payment has expired');
  }
  if (typeof currentEpoch !== 'bigint' || currentEpoch < terms.minEpoch || currentEpoch > terms.maxEpoch) {
    fail('WRONG_EPOCH', "the chain is outside the challenge's epoch window");
  }
  const txBytes = await buildSend(terms);
  await assertPlainUsdcSend(txBytes, payment, terms.payer);
  const { signature } = await payerKeypair.signTransaction(txBytes);
  return {
    txBytesBase64: toBase64(txBytes),
    signature,
    digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
    payer: terms.payer,
  };
}

/**
 * The X-PAYMENT header exactly as t2000's payer sends it: base64 of the JSON
 * { x402Version, scheme, network, payload: { senderAddress, txBytes, senderSignature,
 * challengeId } }, keys in that order. The value is a bearer payment: never log it.
 * Throws PaymentError: UNSUPPORTED_DIALECT, BUILD_FAILED without a challenge id, and
 * MISMATCH when the signed bytes do not match their digest or their payer.
 */
export function paymentHeader(payment: CanonicalPayment, signed: SignedPayment): { name: string; value: string } {
  if (payment?.dialect !== SUPPORTED_DIALECT) fail('UNSUPPORTED_DIALECT', 'only the t2000 x402 v1 dialect can be paid');
  if (typeof payment.challengeId !== 'string' || payment.challengeId === '') fail('BUILD_FAILED', 'the challenge id is missing');
  let txBytes: Uint8Array;
  try {
    txBytes = fromBase64(signed.txBytesBase64);
  } catch {
    return fail('MISMATCH', 'the signed bytes are not base64');
  }
  // Settlement is later checked against signed.digest, so it must be these bytes' digest.
  if (TransactionDataBuilder.getDigestFromBytes(txBytes) !== signed.digest) fail('MISMATCH', 'the digest is not the digest of the signed bytes');
  if (!sameAddress(decode(txBytes).v1.sender, addressOrFail(signed.payer, 'the payer'))) fail('MISMATCH', 'the signed bytes are not from the payer');

  const body = {
    x402Version: X402_VERSION,
    scheme: X402_SCHEME,
    network: payment.network,
    payload: {
      senderAddress: signed.payer,
      txBytes: signed.txBytesBase64,
      senderSignature: signed.signature,
      challengeId: payment.challengeId,
    },
  };
  return { name: X402_PAYMENT_HEADER, value: toBase64(new TextEncoder().encode(JSON.stringify(body))) };
}

/** canonicalSuiAddress, the address normaliser C3 uses everywhere, as null instead of a throw. */
function settlementAddress(value: unknown): string | null {
  try {
    return typeof value === 'string' ? canonicalSuiAddress(value) : null;
  } catch {
    return null;
  }
}

function settlementCoinType(value: unknown): string | null {
  try {
    return typeof value === 'string' ? normalizeStructTag(value) : null;
  } catch {
    return null;
  }
}

/**
 * C8: whether a transaction read from chain is exactly the approved payment. Verified only
 * when the status is success, the payer's USDC change is exactly minus payment.amount, the
 * recipient's is exactly plus payment.amount, and no other address has a USDC change.
 * The payment must itself be Sui Mainnet USDC with a positive amount. Every address and
 * coin type, on both sides, goes through the same SDK normalisers as C3, so the short and
 * long spellings of one address compare equal. Changes in other coins are not judged.
 * Pure and offline: the caller reads the result by the digest Ellai computed from the
 * bytes it signed, never a digest a seller or an agent reported.
 * Never throws. Each reason is fixed text with no value from the chain or the seller, so
 * it is safe to log and to store.
 */
export function verifySettlement(
  result: { status: 'success' | 'failure'; balanceChanges: BalanceChange[] },
  payment: CanonicalPayment,
  payer: string,
): { verified: true } | { verified: false; reason: string } {
  const refuse = (reason: string) => ({ verified: false as const, reason });
  if (result?.status !== 'success') return refuse('the transaction did not succeed on chain');
  if (!Array.isArray(result.balanceChanges)) return refuse('the balance changes are missing');
  const payerAddress = settlementAddress(payer);
  if (payerAddress === null) return refuse('the payer is not a Sui address');
  const recipient = settlementAddress(payment?.recipient);
  if (recipient === null) return refuse('the approved recipient is not a Sui address');
  const asset = settlementCoinType(payment.asset);
  if (asset !== USDC_TYPE_MAINNET) return refuse('the approved asset is not Sui Mainnet USDC');
  if (payment.network !== DEPLOYMENT_NETWORK) return refuse('the approved payment is not on Sui Mainnet');
  const amount = payment.amount;
  if (typeof amount !== 'bigint' || amount <= 0n) return refuse('the approved amount is not a positive integer');

  const moved: { address: string; amount: bigint }[] = [];
  for (const change of result.balanceChanges) {
    const coinType = settlementCoinType(change?.coinType);
    // An unreadable coin type could be the asset spelled some way the parser rejects, so it fails closed.
    if (coinType === null) return refuse('a balance change has an unreadable coin type');
    if (coinType !== asset) continue;
    const address = settlementAddress(change.address);
    if (address === null || typeof change.amount !== 'bigint') return refuse('a USDC balance change is unreadable');
    moved.push({ address, amount: change.amount });
  }
  const debits = moved.filter((change) => change.address === payerAddress);
  if (debits.length !== 1 || debits[0]?.amount !== -amount) return refuse("the payer's USDC change is not minus the approved amount");
  const credits = moved.filter((change) => change.address === recipient);
  if (credits.length !== 1 || credits[0]?.amount !== amount) {
    return refuse("the recipient's USDC change is not plus the approved amount");
  }
  if (moved.length !== 2) return refuse('another address has a USDC change');
  return { verified: true };
}
