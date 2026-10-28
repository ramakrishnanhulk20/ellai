import { isDeepStrictEqual } from 'node:util';
import { AllowanceError, type AllowanceTerms, assertRevokeAllowance, buildIssueAllowance, type OwnerGasFacts } from '@ellai/core/allowance';
import { type Chain, ChainError, type ExecutionResult } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { bcs } from '@mysten/sui/bcs';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import type { Database } from '../db/client.js';
import { buildAccountStep, readAllowanceToEnd } from './build.js';
import { allowanceLimitsProblem, recordRelayedStep } from './confirm.js';
import { checkUsdcMoveStep, requireOwnersGasCoins } from './funds.js';
import {
  type AccountStep,
  type BuildStep,
  checkBuildStep,
  checkNow,
  END_ALLOWANCE_STEP,
  forgetAllowance,
  loadOwner,
  OnboardingError,
  type OwnerRow,
  USDC_MOVE_STEP,
} from './state.js';

/**
 * The Tatum calls submitOnboardingTx's success path makes for each step, which the submit route
 * counts against the day's budgets before any of them (C22): for an account step, the fresh build
 * the signed bytes are compared with (BUILD_CHAIN_CALLS, 5 and 7), the one send, and
 * findMemoryAccount's three reads to record the result; for an allowance, which is rebuilt
 * offline, the re-read of the owner's SUI coins when it pays its fee with them, the send and the
 * one read of the allowance it created; for the USDC move, the re-read of the owner's USDC coins,
 * that same SUI coin re-read, and the send; for ending the allowance, the re-read of the allowance,
 * its cap (at most LIMITS.allowanceCapMaxPages pages, counted at that most), that same SUI coin
 * re-read, and the send. An allowance the re-read misses costs one gRPC check more (allowanceGone)
 * and stops there at two calls, so five is still the most.
 */
export const SUBMIT_CHAIN_CALLS: Readonly<Record<BuildStep, number>> = {
  memory_account: 9,
  add_delegate: 11,
  allowance: 3,
  usdc_to_address: 3,
  end_allowance: 1 + LIMITS.allowanceCapMaxPages + 1 + 1,
};

/**
 * How a relayed transaction ended. `recorded`: it succeeded and the step is recorded. `sent`: it
 * went out but Ellai has not recorded the step, either because the outcome is unknown or because
 * Sui does not show its result yet; the client confirms it later with the digest. `refused`: the
 * network refused it or it ran and failed, which is definite, and nothing is recorded. `moved`:
 * the USDC move succeeded, putting movedAtomic, what the coins held as read just before the send,
 * in the owner's address balance; nothing is recorded for it. `ended`: the revoke of the owner's
 * allowance succeeded, so Sui deleted it, and Ellai has forgotten it.
 */
export type SubmitOutcome =
  | { status: 'recorded'; recorded: string; digest: string }
  | { status: 'moved'; movedAtomic: string; digest: string }
  | { status: 'ended'; digest: string }
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
 * How the bytes pay their fee, read from where core's builders put it: the gas coins named when
 * there are any, otherwise the epoch window of an address-balance payment. The bytes are then
 * compared with a fresh build from this, so a wrong reading can only refuse, never let other bytes
 * through; gas coins read here are re-read from chain as the owner's before anything is sent.
 */
function gasFactsOf(v1: DecodedV1): OwnerGasFacts | null {
  try {
    const referenceGasPrice = BigInt(v1.gasData.price);
    if (v1.gasData.payment.length > 0) {
      return { referenceGasPrice, gasCoins: v1.gasData.payment.map((coin) => ({ objectId: coin.objectId, version: BigInt(coin.version), digest: coin.digest })) };
    }
    if (v1.expiration.$kind !== 'ValidDuring' || v1.expiration.ValidDuring.minEpoch === null) return null;
    return { epoch: BigInt(v1.expiration.ValidDuring.minEpoch), referenceGasPrice, nonce: v1.expiration.ValidDuring.nonce };
  } catch {
    return null;
  }
}

/**
 * The allowance terms read from the places buildIssueAllowance puts them: the rate limit call
 * first, allowance::new third; the gas facts as gasFactsOf reads them. The bytes are then compared
 * with a fresh build from these, so a wrong reading can only refuse, never let other bytes through.
 */
function allowanceOf(decoded: Decoded): { terms: AllowanceTerms; facts: OwnerGasFacts } | null {
  const { v1, ptb } = decoded;
  const pure = (argument: DecodedArgument | undefined): Uint8Array => {
    const input = argument?.$kind === 'Input' ? ptb.inputs[argument.Input] : undefined;
    if (input?.$kind !== 'Pure') throw new TypeError('not a pure input');
    return fromBase64(input.Pure.bytes);
  };
  try {
    const [rateLimit, , issue] = ptb.commands;
    const facts = gasFactsOf(v1);
    if (rateLimit?.$kind !== 'MoveCall' || issue?.$kind !== 'MoveCall' || facts === null) return null;
    const periodMs = BigInt(bcs.u64().parse(pure(rateLimit.MoveCall.arguments[0])));
    const periodLimitAtomic = BigInt(bcs.u256().parse(pure(rateLimit.MoveCall.arguments[1])));
    const cap = bcs.option(bcs.u256()).parse(pure(issue.MoveCall.arguments[2]));
    const expiration = bcs.option(bcs.u64()).parse(pure(issue.MoveCall.arguments[4]));
    if (cap === null || expiration === null) return null;
    return { terms: { lifetimeCapAtomic: BigInt(cap), periodMs, periodLimitAtomic, expirationMs: BigInt(expiration) }, facts };
  } catch {
    return null;
  }
}

/**
 * core has no assertIssueAllowance, so the rule is assertRefill's: the bytes must equal, byte for
 * byte, a fresh buildIssueAllowance with the owner and purse from the owner row and the terms and
 * facts the bytes carry. The terms are then held to allowanceLimitsProblem, the rule confirm
 * records under, so nothing is relayed that confirm would refuse, and gas coins the bytes pay with
 * to the owner's own SUI coins as Sui shows them now.
 */
async function checkAllowanceStep(bytes: Uint8Array, decoded: Decoded, owner: OwnerRow, now: Date, chain: Chain): Promise<void> {
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
  if ('gasCoins' in read.facts) await requireOwnersGasCoins(chain, canonicalSuiAddress(owner.suiAddress), read.facts.gasCoins);
}

/**
 * Holds signed bytes to ending the owner's allowance: byte for byte a fresh buildRevokeAllowance
 * (core assertRevokeAllowance) for the allowance on the owner row and the owner's cap for it, both
 * re-read now (readAllowanceToEnd), with the gas source the bytes carry; then, when the bytes pay
 * with SUI coins, those coins re-read as the owner's own. So another allowance, another cap, an
 * extra command or a third party's gas coin is refused before anything is sent (C6, C7). An
 * allowance the re-read misses is forgotten only when gRPC agrees it is gone (readAllowanceToEnd).
 * Returns the row's allowance id as stored, for forgetAllowance once the revoke lands.
 */
async function checkEndAllowanceStep(db: Database, owner: OwnerRow, bytes: Uint8Array, facts: OwnerGasFacts, chain: Chain): Promise<string> {
  const { args, recordedId } = await readAllowanceToEnd(db, owner, chain);
  try {
    await assertRevokeAllowance(bytes, args, facts);
  } catch (error) {
    if (error instanceof AllowanceError) badTransaction(NOT_THIS_STEP);
    throw error;
  }
  if ('gasCoins' in facts) await requireOwnersGasCoins(chain, args.owner, facts.gasCoins);
  return recordedId;
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
 *   the owner row, with the gas source the bytes carry, its terms within the onboarding maxima
 *   confirm records under.
 * - usdc_to_address: byte for byte a fresh buildUsdcToAddress for the owner with their USDC coins
 *   re-read now and the gas source the bytes carry (checkUsdcMoveStep).
 * - end_allowance: byte for byte a fresh buildRevokeAllowance for the allowance on the owner row and
 *   the owner's cap for it, both re-read now, with the gas source the bytes carry
 *   (checkEndAllowanceStep).
 * - for all three, gas coins the bytes pay with must be the owner's own SUI coins as Sui shows them now.
 * Then the bytes go to chain.executeTransaction once, metered on this owner's Tatum budget (C22),
 * with the digest Ellai computed from them. A step's success is recorded as confirm records it,
 * from the result's own effects (recordRelayedStep), never from anything the caller sends (C7, C8);
 * the move records nothing and answers what the coins held as read before the send; a revoke that
 * succeeded forgets the allowance it ended (forgetAllowance) and answers `ended`.
 * Returns SubmitOutcome. Throws OnboardingError: BAD_INPUT for a bad step, date or owner id;
 * NO_OWNER; BAD_TRANSACTION for bytes or a signature refused as above, nothing sent; NOT_READY and
 * ALREADY_DONE from the account build, and from end_allowance with no allowance recorded, no cap
 * for it, or an allowance Sui no longer has by both of Tatum's views (then forgotten); NOTHING_TO_MOVE
 * for the move when the owner holds no USDC coins now. Throws ChainError BUDGET when Ellai's Tatum
 * budget refused the send before it left, ChainError UPSTREAM with ALLOWANCE_INDEX_LAG_MESSAGE when
 * only GraphQL misses the allowance (kept, nothing sent), and MemoryError or ChainError when the
 * fresh build or a re-read cannot be made.
 */
export async function submitOnboardingTx(args: {
  db: Database;
  ownerId: string;
  step: BuildStep;
  txBytesBase64: string;
  signature: string;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<SubmitOutcome> {
  const step = checkBuildStep(args.step);
  const now = checkNow(args.now);
  if (typeof args.txBytesBase64 !== 'string' || typeof args.signature !== 'string') badTransaction('send the signed transaction bytes and the signature as text');
  const owner = await loadOwner(args.db, args.ownerId);
  const { bytes, decoded } = readSigned(args.txBytesBase64);
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);
  if (!sameAddress(decoded.v1.sender, ownerAddress)) badTransaction('the transaction is not sent from your own address');
  if (!sameAddress(decoded.v1.gasData.owner, ownerAddress)) badTransaction('someone other than you would pay its gas');
  let moved: bigint | null = null;
  let ending: string | null = null;
  if (step === USDC_MOVE_STEP || step === END_ALLOWANCE_STEP) {
    const facts = gasFactsOf(decoded.v1);
    if (facts === null) badTransaction(NOT_THIS_STEP);
    if (step === USDC_MOVE_STEP) moved = (await checkUsdcMoveStep(args.chain, ownerAddress, bytes, facts)).movedAtomic;
    else ending = await checkEndAllowanceStep(args.db, owner, bytes, facts, args.chain);
  } else if (step === 'allowance') await checkAllowanceStep(bytes, decoded, owner, now, args.chain);
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
  if (step === USDC_MOVE_STEP) return { status: 'moved', movedAtomic: String(moved), digest };
  if (step === END_ALLOWANCE_STEP) {
    // A revoke that succeeded deleted exactly the allowance its byte check named, so the success is the proof it is gone.
    if (ending === null) throw new Error('an ended allowance has no recorded id');
    await forgetAllowance(args.db, owner.id, ending);
    return { status: 'ended', digest };
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
