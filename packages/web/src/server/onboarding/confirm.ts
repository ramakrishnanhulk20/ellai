import { type AllowanceState, type Chain, ChainError, classifyChainError } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { findMemoryAccount, MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { GrpcTypes } from '@mysten/sui/grpc';
import { isValidTransactionDigest, normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners } from '../db/schema.js';
import { ownerDelegate } from '../memory/delegate.js';
import {
  ACCOUNT_STEPS,
  type AccountStep,
  ALLOWANCE_INDEX_LAG_MESSAGE,
  allowanceGone,
  checkConfirmStep,
  checkNow,
  checkStep,
  type ConfirmStep,
  END_ALLOWANCE_STEP,
  forgetAllowance,
  loadOwner,
  OnboardingError,
  type OnboardingStep,
  type OwnerRow,
} from './state.js';

/**
 * The Tatum calls confirmOnboardingTx's success path makes for each step, which the confirm route
 * counts against the day's budgets before any of them (C22): the transaction's result and its
 * facts, then findMemoryAccount's registry, registry entry and account, or the allowance itself
 * (one GraphQL call). Ending the allowance reads the allowance on the owner row, and once that read
 * misses it, as it does when the end succeeded, checks it is gone through gRPC: two calls.
 */
export const CONFIRM_CHAIN_CALLS: Readonly<Record<ConfirmStep, number>> = { memory_account: 5, add_delegate: 5, allowance: 3, end_allowance: 2 };

/** What confirm answers for end_allowance: Sui no longer has the owner's allowance, and Ellai has forgotten it. */
export const ENDED_RECORD = 'ended';

/** The Tatum calls confirmExistingStep makes: findMemoryAccount's registry, registry entry and account. */
export const CONFIRM_EXISTING_CHAIN_CALLS: Readonly<Record<AccountStep, number>> = { memory_account: 3, add_delegate: 3 };

const { ChangedObject_IdOperation: IdOperation } = GrpcTypes;
const FRAMEWORK_ADDRESS = normalizeSuiAddress('0x2');
// The Chain interface reads a transaction's status and balance changes but not its sender or
// the objects it created, so those two come from one direct read of the same transaction.
const FACT_PATHS = [
  'digest',
  'transaction.sender',
  'effects.changed_objects.object_id',
  'effects.changed_objects.object_type',
  'effects.changed_objects.id_operation',
];

interface TransactionFacts {
  sender: string;
  created: Array<{ objectId: string; type: string }>;
}

function refuse(message: string): never {
  throw new OnboardingError('REFUSED', message);
}

function badResponse(what: string): ChainError {
  return new ChainError('BAD_RESPONSE', `unexpected response from Tatum: ${what}`);
}

function notLanded(error: unknown, message: string): never {
  if (error instanceof ChainError && error.code === 'NOT_FOUND') throw new OnboardingError('NOT_LANDED', message);
  throw error;
}

/** One read through Tatum, bounded by LIMITS.tatumTimeoutMs and the gRPC message cap, not retried. */
async function readTransactionFacts(chain: Chain, digest: string): Promise<TransactionFacts> {
  let transaction: GrpcTypes.ExecutedTransaction | undefined;
  try {
    const { response } = await chain.grpc.ledgerService.getTransaction(
      { digest, readMask: { paths: FACT_PATHS } },
      { timeout: LIMITS.tatumTimeoutMs },
    );
    transaction = response.transaction;
  } catch (error) {
    const failure = classifyChainError(error);
    if (failure.code === 'NOT_FOUND') throw new OnboardingError('NOT_LANDED', `Sui does not show transaction ${digest} yet`);
    throw new ChainError(failure.code, `Tatum getTransaction: ${failure.message}`, failure.retryable);
  }
  if (!transaction) throw new OnboardingError('NOT_LANDED', `Sui does not show transaction ${digest} yet`);
  if (transaction.digest !== digest) throw badResponse('the transaction read names another digest');
  let sender: string;
  try {
    sender = canonicalSuiAddress(transaction.transaction?.sender ?? '');
  } catch {
    throw badResponse('the transaction has no readable sender');
  }
  const created = (transaction.effects?.changedObjects ?? [])
    .filter((change) => change.idOperation === IdOperation.CREATED)
    .map((change) => {
      try {
        return { objectId: canonicalSuiAddress(change.objectId ?? ''), type: normalizeStructTag(change.objectType ?? '') };
      } catch {
        throw badResponse('a created object has no readable id or type');
      }
    });
  return { sender, created };
}

/** Read by the SDK's own type parser, so any coin type counts and a second allowance cannot hide behind another one. */
function isAllowance(type: string): boolean {
  try {
    const tag = parseStructTag(type);
    return normalizeSuiAddress(tag.address) === FRAMEWORK_ADDRESS && tag.module === 'allowance' && tag.name === 'Allowance';
  } catch {
    return false;
  }
}

/** findMemoryAccount, with its refusals of what Sui shows (another owner's account, a frozen one) turned into REFUSED. */
async function accountOf(chain: Chain, ownerAddress: string): Promise<{ accountId: string; delegates: string[] } | null> {
  try {
    return await findMemoryAccount(chain, ownerAddress);
  } catch (error) {
    if (error instanceof MemoryError && (error.code === 'ACCOUNT' || error.code === 'DELEGATE')) refuse(error.message);
    throw error;
  }
}

async function confirmAccount(db: Database, owner: OwnerRow, chain: Chain, ownerAddress: string): Promise<string> {
  const account = await accountOf(chain, ownerAddress);
  if (account === null) refuse('Sui shows no Walrus Memory account for this owner');
  const accountId = canonicalSuiAddress(account.accountId);
  if (owner.memwalAccountId !== null && owner.memwalAccountId !== accountId) {
    refuse('another Walrus Memory account is already recorded for this owner');
  }
  const unchangedOrEmpty = or(isNull(owners.memwalAccountId), eq(owners.memwalAccountId, accountId));
  const updated = await db
    .update(owners)
    .set({ memwalAccountId: accountId })
    .where(and(eq(owners.id, owner.id), unchangedOrEmpty))
    .returning({ id: owners.id });
  if (updated.length !== 1) refuse('another Walrus Memory account is already recorded for this owner');
  return accountId;
}

async function confirmDelegate(
  db: Database,
  owner: OwnerRow,
  chain: Chain,
  ownerAddress: string,
  masterSecretHex: string,
  now: Date,
): Promise<string> {
  const recordedAccount = owner.memwalAccountId;
  if (recordedAccount === null) throw new OnboardingError('NOT_READY', 'confirm the Walrus Memory account first');
  const account = await accountOf(chain, ownerAddress);
  if (account === null || canonicalSuiAddress(account.accountId) !== recordedAccount) {
    refuse('Sui does not show the recorded Walrus Memory account for this owner');
  }
  // Both sides are lowercase hex from the same SDK encoder.
  const { publicKeyHex } = ownerDelegate(masterSecretHex, ownerAddress);
  if (!account.delegates.includes(publicKeyHex)) refuse("Ellai's key for this owner is not on the Walrus Memory account");
  if (owner.delegateRegisteredAt === null) {
    await db
      .update(owners)
      .set({ delegateRegisteredAt: now })
      .where(and(eq(owners.id, owner.id), eq(owners.memwalAccountId, recordedAccount), isNull(owners.delegateRegisteredAt)));
  }
  return publicKeyHex;
}

/** An allowance's limits, as getAllowance reads them from chain or submit reads them from the signed bytes. */
export type AllowanceLimits = Pick<AllowanceState, 'lifetimeCap' | 'periodMs' | 'periodLimit' | 'expirationMs'>;

/** Names the first way the allowance falls outside what onboarding lets an owner set up, or null. */
function allowanceProblem(state: AllowanceState, ownerAddress: string, purseAddress: string, now: Date): string | null {
  if (canonicalSuiAddress(state.funder) !== ownerAddress) return "the allowance does not draw from the owner's address";
  if (canonicalSuiAddress(state.spender) !== purseAddress) return "the allowance's spender is not the owner's purse";
  if (state.coinType !== USDC_TYPE_MAINNET) return 'the allowance is not over Sui Mainnet USDC';
  return allowanceLimitsProblem(state, now);
}

/**
 * Names the first way an allowance's cap, window, daily limit or end falls outside what onboarding
 * lets an owner set up, or null. The one rule for these, so what submit relays is held to exactly
 * what confirm would record.
 */
export function allowanceLimitsProblem(state: AllowanceLimits, now: Date): string | null {
  const capMax = BigInt(LIMITS.onboardingLifetimeCapMaxAtomic);
  if (state.lifetimeCap === null || state.lifetimeCap <= 0n || state.lifetimeCap > capMax) return 'the total cap is missing or over the onboarding maximum';
  if (state.periodMs !== BigInt(LIMITS.allowancePeriodMs)) return 'the rate-limit window is not one day';
  const dailyMax = BigInt(LIMITS.onboardingDailyLimitMaxAtomic);
  if (state.periodLimit === null || state.periodLimit <= 0n || state.periodLimit > dailyMax || state.periodLimit > state.lifetimeCap) {
    return 'the daily limit is missing, over the onboarding maximum, or over the total cap';
  }
  const nowMs = BigInt(now.getTime());
  if (state.expirationMs === null || state.expirationMs <= nowMs) return 'the allowance has no end date or has ended';
  if (state.expirationMs > nowMs + BigInt(LIMITS.onboardingAllowanceMaxMs)) return 'the allowance runs longer than the onboarding maximum';
  return null;
}

async function confirmAllowance(
  db: Database,
  owner: OwnerRow,
  chain: Chain,
  ownerAddress: string,
  createdObjects: TransactionFacts['created'],
  now: Date,
): Promise<string> {
  const allowances = createdObjects.filter((object) => isAllowance(object.type));
  const [created] = allowances;
  if (allowances.length > 1) refuse('the transaction created more than one allowance');
  if (created === undefined) refuse('the transaction created no allowance');
  const state = await chain.getAllowance(created.objectId).catch((error: unknown) => notLanded(error, `Sui does not show allowance ${created.objectId} yet`));
  const problem = allowanceProblem(state, ownerAddress, canonicalSuiAddress(owner.purseAddress), now);
  if (problem !== null) refuse(problem);
  // A wait set for the allowance this one replaces says nothing about this one's rate window.
  await db.update(owners).set({ allowanceId: created.objectId, allowanceCheckedAt: now, refillNotBefore: null }).where(eq(owners.id, owner.id));
  return created.objectId;
}

/**
 * Records that the owner's allowance has ended, from what Sui shows for the allowance on the owner
 * row, never an id the caller names (C7): when getAllowance (GraphQL) answers NOT_FOUND and
 * allowanceGone (one gRPC read) agrees, it is forgotten (forgetAllowance). A row with no allowance
 * has nothing left to forget.
 * Throws OnboardingError NOT_LANDED while GraphQL still shows the allowance; ChainError UPSTREAM with
 * ALLOWANCE_INDEX_LAG_MESSAGE, the allowance kept, while only GraphQL misses it; ChainError from the reads.
 */
async function confirmEnded(db: Database, owner: OwnerRow, chain: Chain): Promise<string> {
  const recordedId = owner.allowanceId;
  if (recordedId === null) return ENDED_RECORD;
  const allowanceId = canonicalSuiAddress(recordedId);
  try {
    await chain.getAllowance(allowanceId);
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') {
      if (!(await allowanceGone(chain, allowanceId))) throw new ChainError('UPSTREAM', ALLOWANCE_INDEX_LAG_MESSAGE, true);
      await forgetAllowance(db, owner.id, recordedId);
      return ENDED_RECORD;
    }
    throw error;
  }
  throw new OnboardingError('NOT_LANDED', `Sui still shows allowance ${allowanceId}; ask again shortly`);
}

/**
 * Records one onboarding step for the owner, but only what Ellai itself reads from Sui
 * Mainnet through Tatum about the transaction `digest` (C7, C8). The transaction must have
 * succeeded and been sent from the owner's own address. Then:
 * - memory_account: the registry must name an account for the owner whose own owner field
 *   is the owner (findMemoryAccount); its id is recorded as memwal_account_id. A different
 *   account already recorded is refused.
 * - add_delegate: needs the account recorded; Sui must show that same account holding
 *   Ellai's derived delegate key for this owner; delegate_registered_at is recorded once.
 * - allowance: exactly one allowance must have been created by the transaction, and getAllowance
 *   must show it drawing USDC from the owner's address, spent only by the owner's purse,
 *   with a total cap, a one-day window and limit, and an end date within the onboarding
 *   maxima; allowance_id and allowance_checked_at are recorded and refill_not_before is
 *   cleared, so the jobs tick reads the new allowance at its next visit. The allowance id comes
 *   from the transaction's effects, never from the caller.
 * - end_allowance: the digest is only checked for its form and is not read. What is recorded is
 *   what Sui shows for the allowance on the owner row (confirmEnded): gone by both of Tatum's views,
 *   and then forgotten, so the tick stops visiting the owner for refills; still there is
 *   NOT_LANDED; gone only from GraphQL is ChainError UPSTREAM, the allowance kept. At most two reads.
 * Anything else refuses and records nothing. Idempotent: confirming the same step again
 * records the same values.
 * Returns what was recorded: the account id, the delegate public key as hex, the allowance id, or
 * ENDED_RECORD for end_allowance.
 * Throws OnboardingError: BAD_INPUT for a bad step, digest, date or owner id; NO_OWNER;
 * NOT_READY for add_delegate before the account; NOT_LANDED while Sui does not show the
 * transaction or the allowance, or for end_allowance still shows the allowance; REFUSED for
 * anything the chain shows that the step does not accept. Throws ChainError or MemoryError (fixed
 * text) when Tatum cannot answer; nothing is recorded then and the call can be made again.
 */
export async function confirmOnboardingTx(args: {
  db: Database;
  ownerId: string;
  step: ConfirmStep;
  digest: string;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<{ recorded: string }> {
  const step = checkConfirmStep(args.step);
  if (typeof args.digest !== 'string' || !isValidTransactionDigest(args.digest)) {
    throw new OnboardingError('BAD_INPUT', 'the digest is not a Sui transaction digest');
  }
  const { digest, db, chain } = args;
  const now = checkNow(args.now);
  const owner = await loadOwner(db, args.ownerId);
  if (step === END_ALLOWANCE_STEP) return { recorded: await confirmEnded(db, owner, chain) };
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);
  if (step === 'add_delegate' && owner.memwalAccountId === null) throw new OnboardingError('NOT_READY', 'confirm the Walrus Memory account first');

  const result = await chain.getTransactionResult(digest).catch((error: unknown) => notLanded(error, `Sui does not show transaction ${digest} yet`));
  if (result.status !== 'success') refuse('the transaction failed on chain');
  const facts = await readTransactionFacts(chain, digest);
  if (facts.sender !== ownerAddress) refuse("the transaction was not sent from the owner's address");
  return { recorded: await recordStep(db, owner, chain, step, facts.created, args.masterSecretHex, now) };
}

/** What each step records once its transaction is known to have succeeded from the owner's address. */
async function recordStep(
  db: Database,
  owner: OwnerRow,
  chain: Chain,
  step: OnboardingStep,
  created: TransactionFacts['created'],
  masterSecretHex: string,
  now: Date,
): Promise<string> {
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);
  if (step === 'memory_account') return confirmAccount(db, owner, chain, ownerAddress);
  if (step === 'add_delegate') return confirmDelegate(db, owner, chain, ownerAddress, masterSecretHex, now);
  return confirmAllowance(db, owner, chain, ownerAddress, created, now);
}

/**
 * Records an account step Sui already shows done, with no transaction to read: for an owner who
 * made their Walrus Memory account, or added Ellai's key to it, before using Ellai, which the
 * build route answers with ALREADY_DONE. The account is read from Sui by the owner's own address
 * and recorded exactly as confirmOnboardingTx records it, with the same checks: the registry's
 * account for the owner, owned by the owner and not frozen, never one already recorded otherwise;
 * for add_delegate that recorded account holding Ellai's derived key for this owner. No id comes
 * from the caller (C7, C8). Idempotent like confirmOnboardingTx.
 * Returns the account id or the delegate public key as hex.
 * Throws OnboardingError: BAD_INPUT for a step that is not an account step, a bad date or owner
 * id; NO_OWNER; NOT_READY for add_delegate before the account is recorded; REFUSED when Sui does
 * not show the step done. Throws ChainError or MemoryError when Tatum cannot answer, recording nothing.
 */
export async function confirmExistingStep(args: {
  db: Database;
  ownerId: string;
  step: AccountStep;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<{ recorded: string }> {
  const step = checkStep(args.step);
  if (!(ACCOUNT_STEPS as readonly string[]).includes(step)) throw new OnboardingError('BAD_INPUT', `the step must be one of ${ACCOUNT_STEPS.join(', ')}`);
  const now = checkNow(args.now);
  const owner = await loadOwner(args.db, args.ownerId);
  if (step === 'add_delegate' && owner.memwalAccountId === null) throw new OnboardingError('NOT_READY', 'confirm the Walrus Memory account first');
  return { recorded: await recordStep(args.db, owner, args.chain, step, [], args.masterSecretHex, now) };
}

/**
 * Records a step whose transaction Ellai itself relayed (submitOnboardingTx) and saw succeed: the
 * bytes were checked to be sent from the owner's own address before they went out, and the result
 * names the digest Ellai computed from those bytes, so the success and the created objects are
 * Ellai's own facts (C8), and the step is recorded exactly as confirmOnboardingTx records it, the
 * owner row read again now. The allowance id comes from those created objects, never the caller.
 * Throws as confirmOnboardingTx does once the transaction is read: NOT_READY; NOT_LANDED while
 * Sui does not show the allowance yet; REFUSED for what the chain shows, which straight after a
 * send can also be a read that has not caught up with the account change; ChainError or MemoryError.
 */
export async function recordRelayedStep(args: {
  db: Database;
  ownerId: string;
  step: OnboardingStep;
  created: Array<{ objectId: string; type: string }>;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<{ recorded: string }> {
  const step = checkStep(args.step);
  const now = checkNow(args.now);
  const owner = await loadOwner(args.db, args.ownerId);
  if (step === 'add_delegate' && owner.memwalAccountId === null) throw new OnboardingError('NOT_READY', 'confirm the Walrus Memory account first');
  return { recorded: await recordStep(args.db, owner, args.chain, step, args.created, args.masterSecretHex, now) };
}
