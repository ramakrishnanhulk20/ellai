import { isDeepStrictEqual } from 'node:util';
import { AllowanceError, type AllowanceTerms, type ChainFacts, buildIssueAllowance } from '@ellai/core/allowance';
import { type Chain, ChainError, type ExecutionResult } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { bcs } from '@mysten/sui/bcs';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import type { Database } from '../db/client.js';
import { buildAccountStep } from './build.js';
import { allowanceLimitsProblem, recordRelayedStep } from './confirm.js';
import { type AccountStep, checkNow, checkStep, loadOwner, OnboardingError, type OnboardingStep, type OwnerRow } from './state.js';

/**
 * The Tatum calls submitOnboardingTx's success path makes for each step, which the submit route
 * counts against the day's budgets before any of them (C22): for an account step, the fresh build
 * the signed bytes are compared with (BUILD_CHAIN_CALLS, 5 and 7), the one send, and
 * findMemoryAccount's three reads to record the result; for an allowance, which is rebuilt
 * offline, the send and the one read of the allowance it created.
 */
export const SUBMIT_CHAIN_CALLS: Readonly<Record<OnboardingStep, number>> = { memory_account: 9, add_delegate: 11, allowance: 2 };

/**
 * How a relayed transaction ended. `recorded`: it succeeded and the step is recorded. `sent`: it
 * went out but Ellai has not recorded the step, either because the outcome is unknown or because
 * Sui does not show its result yet; the client confirms it later with the digest. `refused`: the
 * network refused it or it ran and failed, which is definite, and nothing is recorded.
 */
export type SubmitOutcome =
  | { status: 'recorded'; recorded: string; digest: string }
  | { status: 'sent'; digest: string }
  | { status: 'refused'; digest: string };

type DecodedTransaction = ReturnType<typeof bcs.TransactionData.parse>;
type DecodedV1 = Extract<DecodedTransaction, { $kind: 'V1' }>['V1'];
type DecodedPtb = Extract<DecodedV1['kind'], { $kind: 'ProgrammableTransaction' }>['ProgrammableTransaction'];
type DecodedArgument = Extract<DecodedPtb['commands'][number], { $kind: 'MoveCall' }>['MoveCall']['arguments'][number];
interface Decoded {
  v1: DecodedV1;
  ptb: DecodedPtb;
}

const NOT_THIS_STEP = 'it is not the transaction Ellai builds for this step';

function badTransaction(message: string): never {
  throw new OnboardingError('BAD_TRANSACTION', message);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function sameAddress(value: string, expected: string): boolean {
  try {
    return canonicalSuiAddress(value) === expected;
  } catch {
    return false;
  }
}

/** One programmable transaction, version 1, or null; bytes past the end of one are refused rather than ignored, as bcs would. */
function decode(bytes: Uint8Array): Decoded | null {
  try {
    const parsed = bcs.TransactionData.parse(bytes);
    if (!sameBytes(bcs.TransactionData.serialize(parsed as never).toBytes(), bytes)) return null;
    if (parsed.$kind !== 'V1' || parsed.V1.kind.$kind !== 'ProgrammableTransaction') return null;
    return { v1: parsed.V1, ptb: parsed.V1.kind.ProgrammableTransaction };
  } catch {
    return null;
  }
}

function readSigned(text: string): { bytes: Uint8Array; decoded: Decoded } {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(text);
  } catch {
    return badTransaction('the transaction bytes are not base64');
  }
  // atob takes spaces and missing padding, so only the one canonical spelling is read: the bytes
  // relayed and hashed are then exactly the bytes checked.
  if (bytes.length === 0 || toBase64(bytes) !== text) badTransaction('the transaction bytes are not base64');
  if (bytes.length > LIMITS.onboardingSubmitTxMaxBytes) badTransaction('the transaction is larger than any Ellai builds');
  const decoded = decode(bytes);
  if (decoded === null) badTransaction('the transaction bytes are not one Sui transaction');
  return { bytes, decoded };
}

/**
 * No checker for account-step bytes is exported from core, so the rule here is "the same calls on
 * the same inputs as a fresh build of this step", and that build passed core's own checks: one
 * call to the Walrus Memory account function, the owner as sender and gas payer. Gas coins, price
 * and expiry are Tatum's pick at build time and are not compared; the gas budget is held to the
 * same cap core builds under.
 */
async function checkAccountStep(decoded: Decoded, step: AccountStep, owner: OwnerRow, chain: Chain, masterSecretHex: string): Promise<void> {
  const budget = BigInt(decoded.v1.gasData.budget);
  if (budget > BigInt(LIMITS.memwalAccountTxMaxGasMist)) badTransaction('its gas budget is over the most Ellai builds with');
  const fresh = decode((await buildAccountStep({ chain, owner, step, masterSecretHex })).bytes);
  if (fresh === null) throw new Error('a fresh build of the account step does not decode');
  if (!isDeepStrictEqual(decoded.ptb.commands, fresh.ptb.commands) || !isDeepStrictEqual(decoded.ptb.inputs, fresh.ptb.inputs)) {
    badTransaction(NOT_THIS_STEP);
  }
}

/**
 * The allowance terms and chain facts read from the places buildIssueAllowance puts them: the rate
 * limit call first, allowance::new third, and the epoch window. The bytes are then compared with a
 * fresh build from these, so a wrong reading can only refuse, never let other bytes through.
 */
function allowanceOf(decoded: Decoded): { terms: AllowanceTerms; facts: ChainFacts } | null {
  const { v1, ptb } = decoded;
  const pure = (argument: DecodedArgument | undefined): Uint8Array => {
    const input = argument?.$kind === 'Input' ? ptb.inputs[argument.Input] : undefined;
    if (input?.$kind !== 'Pure') throw new TypeError('not a pure input');
    return fromBase64(input.Pure.bytes);
  };
  try {
    const [rateLimit, , issue] = ptb.commands;
    if (rateLimit?.$kind !== 'MoveCall' || issue?.$kind !== 'MoveCall' || v1.expiration.$kind !== 'ValidDuring') return null;
    const periodMs = BigInt(bcs.u64().parse(pure(rateLimit.MoveCall.arguments[0])));
    const periodLimitAtomic = BigInt(bcs.u256().parse(pure(rateLimit.MoveCall.arguments[1])));
    const cap = bcs.option(bcs.u256()).parse(pure(issue.MoveCall.arguments[2]));
    const expiration = bcs.option(bcs.u64()).parse(pure(issue.MoveCall.arguments[4]));
    const { minEpoch, nonce } = v1.expiration.ValidDuring;
    if (cap === null || expiration === null || minEpoch === null) return null;
    return {
      terms: { lifetimeCapAtomic: BigInt(cap), periodMs, periodLimitAtomic, expirationMs: BigInt(expiration) },
      facts: { epoch: BigInt(minEpoch), referenceGasPrice: BigInt(v1.gasData.price), nonce },
    };
  } catch {
    return null;
  }
}

/**
 * core has no assertIssueAllowance, so the rule is assertRefill's: the bytes must equal, byte for
 * byte, a fresh buildIssueAllowance with the owner and purse from the owner row and the terms and
 * facts the bytes carry. The terms are then held to allowanceLimitsProblem, the rule confirm
 * records under, so nothing is relayed that confirm would refuse.
 */
async function checkAllowanceStep(bytes: Uint8Array, decoded: Decoded, owner: OwnerRow, now: Date): Promise<void> {
  const read = allowanceOf(decoded);
  if (read === null) badTransaction(NOT_THIS_STEP);
  let expected: Uint8Array;
  try {
    expected = await buildIssueAllowance({ owner: canonicalSuiAddress(owner.suiAddress), spender: canonicalSuiAddress(owner.purseAddress), terms: read.terms }, read.facts);
  } catch (error) {
    if (error instanceof AllowanceError) badTransaction(NOT_THIS_STEP);
    throw error;
  }
  if (!sameBytes(bytes, expected)) badTransaction(NOT_THIS_STEP);
  const { terms } = read;
  const problem = allowanceLimitsProblem(
    { lifetimeCap: terms.lifetimeCapAtomic, periodMs: terms.periodMs, periodLimit: terms.periodLimitAtomic, expirationMs: terms.expirationMs },
    now,
  );
  if (problem !== null) badTransaction(problem);
}

function unknownOutcome(digest: string, why: string): SubmitOutcome {
  console.warn(`[ellai onboarding] submit_not_recorded ${why}`);
  return { status: 'sent', digest };
}

/**
 * Relays one onboarding transaction the owner signed in their own wallet to Sui Mainnet through
 * Tatum, so the wallet only signs and never has to send. Ellai signs nothing here and holds no key
 * to this transaction: it passes the owner's own signature with bytes it has checked are the
 * step it builds for this owner (C6). Before anything is sent:
 * - `txBytesBase64` must be canonical base64 of one version 1 programmable transaction, at most
 *   LIMITS.onboardingSubmitTxMaxBytes, sent from the owner's own address with the owner paying gas.
 * - account steps: the same Move call on the same inputs as a fresh buildAccountStep of the step,
 *   which also refuses with ALREADY_DONE when Sui already shows it done, and a gas budget at most
 *   LIMITS.memwalAccountTxMaxGasMist.
 * - allowance: byte for byte a fresh buildIssueAllowance for the owner and the owner's purse from
 *   the owner row, its terms within the onboarding maxima confirm records under.
 * Then the bytes go to chain.executeTransaction once, metered on this owner's Tatum budget (C22),
 * with the digest Ellai computed from them. A success is recorded as confirm records it, from the
 * result's own effects (recordRelayedStep), never from anything the caller sends (C7, C8).
 * Returns SubmitOutcome. Throws OnboardingError: BAD_INPUT for a bad step, date or owner id;
 * NO_OWNER; BAD_TRANSACTION for bytes or a signature refused as above, nothing sent; NOT_READY and
 * ALREADY_DONE from the account build. Throws ChainError BUDGET when Ellai's Tatum budget refused
 * the send before it left, and MemoryError or ChainError when the fresh build cannot be made.
 */
export async function submitOnboardingTx(args: {
  db: Database;
  ownerId: string;
  step: OnboardingStep;
  txBytesBase64: string;
  signature: string;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<SubmitOutcome> {
  const step = checkStep(args.step);
  const now = checkNow(args.now);
  if (typeof args.txBytesBase64 !== 'string' || typeof args.signature !== 'string') badTransaction('send the signed transaction bytes and the signature as text');
  const owner = await loadOwner(args.db, args.ownerId);
  const { bytes, decoded } = readSigned(args.txBytesBase64);
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);
  if (!sameAddress(decoded.v1.sender, ownerAddress)) badTransaction('the transaction is not sent from your own address');
  if (!sameAddress(decoded.v1.gasData.owner, ownerAddress)) badTransaction('someone other than you would pay its gas');
  if (step === 'allowance') await checkAllowanceStep(bytes, decoded, owner, now);
  else await checkAccountStep(decoded, step, owner, args.chain, args.masterSecretHex);

  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  let result: ExecutionResult;
  try {
    result = await args.chain.executeTransaction(bytes, [args.signature]);
  } catch (error) {
    // executeTransaction promises these two codes only for bytes that never left.
    if (error instanceof ChainError && error.code === 'INVALID_INPUT') badTransaction('the signature is not one Sui can read');
    if (error instanceof ChainError && error.code === 'BUDGET') throw error;
    return unknownOutcome(digest, error instanceof ChainError ? `ChainError ${error.code}` : 'UNEXPECTED');
  }
  if (result.status !== 'success') {
    console.warn(`[ellai onboarding] submit_refused ${result.errorCode ?? 'UNKNOWN'}`);
    return { status: 'refused', digest };
  }
  try {
    const { recorded } = await recordRelayedStep({ db: args.db, ownerId: owner.id, step, created: result.createdObjects, chain: args.chain, masterSecretHex: args.masterSecretHex, now });
    return { status: 'recorded', recorded, digest };
  } catch (error) {
    // The transaction landed; only the record waits. Confirm with the digest gives the final answer.
    if (error instanceof OnboardingError || error instanceof ChainError || error instanceof MemoryError) return unknownOutcome(digest, `${error.name} ${error.code}`);
    throw error;
  }
}
