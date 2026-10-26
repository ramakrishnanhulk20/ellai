import { randomInt } from 'node:crypto';
import { type RefillArgs, type RefillFacts, assertRefill, buildRefill, refillDecision } from '@ellai/core/allowance';
import { type AllowanceReading, type Chain, ChainError, type ExecutionResult, type SimulationResult, type TransactionResult } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { bcs } from '@mysten/sui/bcs';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { SUI_TYPE_ARG, normalizeStructTag } from '@mysten/sui/utils';
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners, payments, refills } from '../db/schema.js';
import type { DbHandle } from '../pay/sign.js';

export interface RefillJobArgs {
  db: Database;
  chain: Chain;
  ownerId: string;
  masterSecretHex: string;
  /** The gas wallet, which sponsors the refill's gas from its SUI address balance. */
  gasKeypair: Ed25519Keypair;
  now: Date;
  /** Waits between the reads that confirm a lost refill. A real timer when not given. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Asked before each chain read up to the moment the refill row is written: false once the jobs
   * tick's deadline has passed, and the call then answers 'deferred'. Always true when left out.
   */
  canStart?: () => boolean;
}

/**
 * 'resolved_pending': a refill pending from an earlier call was found landed in this call, and
 * this call stops there, so the next refill is decided on a balance read made after it landed.
 * 'deferred': the tick's deadline came before a read this call needed, so it stopped with nothing
 * built or sent.
 */
export type RefillOutcome = 'refilled' | 'not_needed' | 'skipped_pending' | 'resolved_pending' | 'refused' | 'deferred';

export type RefillErrorCode = 'FAILED' | 'MISMATCH' | 'DRY_RUN_FAILED';

/** A refill that did not, or would not, do what it was built to do. The message is fixed text. */
export class RefillError extends Error {
  readonly code: RefillErrorCode;

  constructor(code: RefillErrorCode, message: string) {
    super(message);
    this.name = 'RefillError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const U32_LIMIT = 2 ** 32;
const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);

const timerSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface OwnerFacts {
  suiAddress: string;
  purseAddress: string;
  allowanceId: string | null;
}

interface Parties {
  purse: string;
  funder: string;
  gasOwner: string;
}

// Every address on both sides of a comparison goes through core's one parser (standard 2),
// and anything it cannot read compares unequal.
function canonicalOrNull(address: unknown): string | null {
  try {
    return typeof address === 'string' ? canonicalSuiAddress(address) : null;
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  const left = canonicalOrNull(a);
  return left !== null && left === canonicalOrNull(b);
}

function coinOrNull(type: unknown): string | null {
  try {
    return typeof type === 'string' ? normalizeStructTag(type) : null;
  } catch {
    return null;
  }
}

async function readOwner(db: DbHandle, ownerId: string, lock: boolean): Promise<OwnerFacts | undefined> {
  const query = db
    .select({ suiAddress: owners.suiAddress, purseAddress: owners.purseAddress, allowanceId: owners.allowanceId })
    .from(owners)
    .where(eq(owners.id, ownerId));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

interface Ledger {
  pending: boolean;
  inWindow: number;
  /**
   * What Ellai's own records say the purse holds: every verified refill in, minus every signed
   * payment out that has not been released. A payment counts as gone until the chain shows it
   * never landed, so this is the least the purse can hold from Ellai's own doing.
   */
  balanceAtomic: bigint;
}

/**
 * Whether a refill is still pending, every refill sent in the LIMITS.purseRefillWindowMs before
 * `now` (landed, failed, or not yet known), and the purse balance by Ellai's own records.
 * Payments are counted by owner, since each owner has exactly one purse and pays only from it (C7).
 */
async function refillLedger(db: DbHandle, ownerId: string, now: Date): Promise<Ledger> {
  const [pending] = await db
    .select({ id: refills.id })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'pending')))
    .limit(1);
  const [sent] = await db
    .select({ n: count() })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), gte(refills.sentAt, new Date(now.getTime() - LIMITS.purseRefillWindowMs))));
  const [refilled] = await db
    .select({ total: sql<string>`coalesce(sum(${refills.amountAtomic}), 0)::text` })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'verified')));
  const [paid] = await db
    .select({ total: sql<string>`coalesce(sum(${payments.amountAtomic}), 0)::text` })
    .from(payments)
    .where(and(eq(payments.ownerId, ownerId), isNull(payments.releasedAt)));
  return { pending: pending !== undefined, inWindow: sent?.n ?? 0, balanceAtomic: BigInt(refilled?.total ?? '0') - BigInt(paid?.total ?? '0') };
}

/**
 * The balance a refill is decided on (C23): the larger of the chain read and Ellai's ledger. A
 * read that comes back too low, as a missing balance entry does, would otherwise refill a purse
 * that already holds money, so the purse is refilled only when both say it is low. Money that
 * reached the purse some other way shows in the read, which is why the read is kept.
 */
function purseForDecision(readAtomic: bigint, ledger: Ledger): bigint {
  return readAtomic > ledger.balanceAtomic ? readAtomic : ledger.balanceAtomic;
}

/**
 * True when Ellai's ledger alone already rules a refill out, so the chain has nothing to tell
 * (C22, C23). A read is never below zero, so purseForDecision is never below the ledger floored
 * at zero, and refillDecision never refills a fuller purse than one it turns down: its no on that
 * floor, at or above the threshold or past the day's refills, is its answer for any read.
 */
function ledgerRulesOut(ledger: Ledger): boolean {
  const floor = ledger.balanceAtomic > 0n ? ledger.balanceAtomic : 0n;
  return !refillDecision({ purseUsdcAtomic: floor, refillsInWindow: ledger.inWindow }).refill;
}

/**
 * What the allowance's rate limit still lets a spend take at `now`, or null with no rate limit.
 * A window whose end has passed counts as empty, because the module opens a new one at the next
 * spend. A window that cannot be placed counts as full.
 */
function windowRoom(allowance: AllowanceReading, now: Date): bigint | null {
  if (allowance.periodLimit === null) return null;
  if (typeof allowance.periodSpent !== 'bigint') return 0n;
  const ended = typeof allowance.periodEndMs === 'bigint' && allowance.periodEndMs <= BigInt(now.getTime());
  return allowance.periodLimit - (ended ? 0n : allowance.periodSpent);
}

/**
 * C7: the allowance as the chain holds it now debits this owner, pays only this owner's purse,
 * is over Sui Mainnet USDC, has not expired, and still has room for one whole refill under its
 * lifetime cap and in its current rate window, since a spend past either aborts on chain and
 * the gas wallet pays for nothing.
 */
function allowanceServes(allowance: AllowanceReading, owner: OwnerFacts, now: Date): boolean {
  if (!sameAddress(allowance.funder, owner.suiAddress) || !sameAddress(allowance.spender, owner.purseAddress)) return false;
  if (coinOrNull(allowance.coinType) !== USDC_TYPE_MAINNET) return false;
  if (allowance.expirationMs !== null && allowance.expirationMs <= BigInt(now.getTime())) return false;
  const refill = BigInt(LIMITS.purseRefillAtomic);
  if (allowance.lifetimeCap !== null && allowance.lifetimeCap - allowance.spentTotal < refill) return false;
  const room = windowRoom(allowance, now);
  return room === null || room >= refill;
}

/**
 * True only when the landed transaction moved exactly the refill: plus `amount` USDC to the
 * purse, minus `amount` USDC from the funder, and at most a gas debit within the refill budget
 * from the gas wallet. Any other change, or an unreadable one, is not a refill.
 */
function movedExactly(result: TransactionResult, parties: Parties, amount: bigint): boolean {
  let credits = 0;
  let debits = 0;
  for (const change of result.balanceChanges) {
    const address = canonicalOrNull(change.address);
    const coin = coinOrNull(change.coinType);
    if (address === null || coin === null || typeof change.amount !== 'bigint') return false;
    if (coin === USDC_TYPE_MAINNET) {
      if (address === parties.purse && change.amount === amount) credits += 1;
      else if (address === parties.funder && change.amount === -amount) debits += 1;
      else return false;
    } else if (coin !== SUI_TYPE || address !== parties.gasOwner || change.amount >= 0n || -change.amount > BigInt(LIMITS.refillGasBudgetMist)) {
      return false;
    }
  }
  return credits === 1 && debits === 1;
}

async function markFailed(db: Database, refillId: string): Promise<void> {
  await db
    .update(refills)
    .set({ status: 'failed' })
    .where(and(eq(refills.id, refillId), eq(refills.status, 'pending')));
}

/**
 * Records what the chain says a sent refill did: a failed transaction is 'failed'; a success
 * that moved exactly the refill is 'verified'. A success that moved anything else stays
 * 'pending', which blocks every later refill for this owner until a person looks, and throws.
 */
async function recordLanded(db: Database, refill: { id: string; amountAtomic: bigint }, result: TransactionResult, parties: Parties, now: Date): Promise<'verified' | 'failed'> {
  if (result.status !== 'success') {
    await markFailed(db, refill.id);
    return 'failed';
  }
  if (!movedExactly(result, parties, refill.amountAtomic)) throw new RefillError('MISMATCH', 'a refill landed but did not move exactly the refill');
  await db
    .update(refills)
    .set({ status: 'verified', verifiedAt: now })
    .where(and(eq(refills.id, refill.id), eq(refills.status, 'pending')));
  return 'verified';
}

/** What the chain has for a digest, or null when it does not have it. Any other failure throws. */
async function readLanded(chain: Chain, digest: string): Promise<TransactionResult | null> {
  try {
    return await chain.getTransactionResult(digest);
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

// The window is read from the bytes that were signed, the one place it cannot differ from what
// the chain enforces; assertRefill has already held it to the window the refill was built for.
function maxEpochOf(txBytes: Uint8Array): bigint {
  const expiration = bcs.TransactionData.parse(txBytes).V1?.expiration;
  if (expiration?.$kind !== 'ValidDuring' || expiration.ValidDuring.maxEpoch === null) throw new Error('the refill has no epoch window');
  return BigInt(expiration.ValidDuring.maxEpoch);
}

/**
 * Reads the oldest pending refill's digest and records the outcome: 'blocked' while it still
 * blocks the next refill, because the chain does not have it and cannot yet be shown never to;
 * 'verified' when it landed and moved exactly the refill; 'clear' when there was none, or it
 * is now 'failed'.
 *
 * A refill missing once the chain's epoch is past its valid_until_epoch can no longer land, but
 * one lagging node must not release a refill that landed in the last moments of its window, so,
 * as C4 releases a payment, LIMITS.paymentReleaseReads further reads LIMITS.settlementPollIntervalMs
 * apart must all miss it too. Then it is 'failed' and no longer blocks; it still counts toward the
 * day's refills. A row with no valid_until_epoch, written before it was kept, waits as before.
 */
async function resolvePending(
  db: Database,
  chain: Chain,
  ownerId: string,
  parties: Parties,
  now: Date,
  sleep: (ms: number) => Promise<void>,
  canStart: () => boolean,
): Promise<'blocked' | 'verified' | 'clear' | 'deferred'> {
  const [pending] = await db
    .select({ id: refills.id, digest: refills.digest, amountAtomic: refills.amountAtomic, validUntilEpoch: refills.validUntilEpoch })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'pending')))
    .orderBy(asc(refills.sentAt), asc(refills.id))
    .limit(1);
  if (pending === undefined) return 'clear';
  if (!canStart()) return 'deferred';
  const landed = await readLanded(chain, pending.digest);
  if (landed !== null) return (await recordLanded(db, pending, landed, parties, now)) === 'verified' ? 'verified' : 'clear';
  if (pending.validUntilEpoch === null) return 'blocked';
  if (!canStart()) return 'deferred';
  if ((await chain.getCurrentEpoch()) <= pending.validUntilEpoch) return 'blocked';
  for (let read = 0; read < LIMITS.paymentReleaseReads; read++) {
    if (!canStart()) return 'deferred';
    await sleep(LIMITS.settlementPollIntervalMs);
    const late = await readLanded(chain, pending.digest);
    if (late !== null) return (await recordLanded(db, pending, late, parties, now)) === 'verified' ? 'verified' : 'clear';
  }
  await markFailed(db, pending.id);
  return 'clear';
}

/**
 * Tops up one owner's purse from the owner's own allowance when the purse runs low, within
 * C23's bounds, with the gas wallet sponsoring the gas (C6, C7, C23, O6).
 *
 * 1. A refill still pending from an earlier call is read by its stored digest first, before
 *    anything else is read or built: landed and exact is 'verified' and this call returns
 *    'resolved_pending' without refilling again; failed is 'failed'; not on chain yet is
 *    'skipped_pending', unless the chain's epoch is past the refill's valid_until_epoch and
 *    LIMITS.paymentReleaseReads more reads, `sleep`ing LIMITS.settlementPollIntervalMs before
 *    each, still miss it: then it is 'failed', the same release rule as a payment's (C4), and
 *    this call goes on as if nothing were pending.
 * 2. The owner's recorded purse must be the purse derived from the master secret; otherwise
 *    'refused' and nothing is read.
 * 3. Ellai's ledger comes before any other chain read (C22, C23): with a refill still pending the
 *    answer is 'skipped_pending', and when the ledger alone rules a refill out (ledgerRulesOut: a
 *    balance at or above LIMITS.purseRefillBelowAtomic, or LIMITS.purseMaxRefillsPerDay already
 *    sent) it is 'not_needed' with nothing read from chain. That answer is exact, since step 4
 *    decides on the larger of the read and the ledger, so an idle owner costs no Tatum call.
 * 4. Otherwise the purse's USDC address balance is read, and the answer is 'not_needed' when
 *    core's refillDecision on the larger of that read and the ledger (purseForDecision) says no.
 * 5. Only for a refill that will be built is the allowance at the owner's stored allowance_id
 *    read, and it must pass C7 (funder is the owner, spender is the purse, USDC, not expired,
 *    room for one refill under the lifetime cap and in the current rate window); otherwise
 *    'refused' and nothing is built or sent. Then the chain facts (epoch, gas price, the
 *    allowance's initial shared version, a random nonce) are read, all before any lock.
 * 6. In one transaction holding the owner row FOR UPDATE: any refill still pending is
 *    'skipped_pending', so two calls can never refill twice; every refill sent in the last
 *    LIMITS.purseRefillWindowMs is counted, and core's refillDecision decides again on the larger of the balance read and
 *    Ellai's ledger (purseForDecision), 'not_needed' when it says no (C23). The refill is
 *    built with buildRefill, checked with assertRefill, signed by the derived purse and by the
 *    gas wallet as sponsor, and its row is written with the digest of the signed bytes, their
 *    maxEpoch as valid_until_epoch, status 'pending', before anything leaves Ellai.
 * 7. After commit the signed bytes are dry-run with chain.simulate. Unless the dry run
 *    succeeds and moves exactly the refill, the row is 'failed', nothing is sent, and the
 *    call throws: RefillError DRY_RUN_FAILED, or the dry run's own ChainError (C6).
 * 8. Then the bytes are sent. A failure the chain reports is 'failed' and throws RefillError
 *    FAILED. A success is read back by its digest: exactly the refill is 'verified'; not
 *    readable yet stays 'pending' for the next call. Either way 'refilled'. An unknown send
 *    outcome stays 'pending' and the ChainError is thrown.
 *
 * The ledger counts this purse's money in as its 'verified' refills, and this function is the
 * only way Ellai puts money in: the first refill after onboarding is this call's too, made by the
 * first tick once confirmOnboardingTx has recorded the allowance, and it is 'verified' once it
 * lands. Money anyone else sends shows only in the read, which can only raise the decision.
 *
 * `canStart` is asked before every chain read in steps 1 to 5 and once more before step 6; when
 * it says no the call answers 'deferred' with nothing built, written or sent. Steps 7 and 8 are
 * never cut short, since bytes whose row is written but which were never sent would hold up
 * refills until their epoch window closed and still count toward the day's refills. Together
 * they take at most three bounded Tatum calls.
 *
 * Throws for an owner id that is not a uuid or a time that is not a date; ChainError from
 * the reads; AllowanceError from the build; RefillError MISMATCH when a refill landed and
 * moved anything but the refill.
 */
export async function refillIfNeeded(args: RefillJobArgs): Promise<RefillOutcome> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new Error('the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, chain, gasKeypair, now } = args;
  const sleep = args.sleep ?? timerSleep;
  const canStart = args.canStart ?? (() => true);
  const ownerId = args.ownerId.toLowerCase();

  const owner = await readOwner(db, ownerId, false);
  if (owner === undefined || owner.allowanceId === null) return 'refused';
  const allowanceId = owner.allowanceId;
  const parties: Parties = {
    purse: canonicalSuiAddress(owner.purseAddress),
    funder: canonicalSuiAddress(owner.suiAddress),
    gasOwner: canonicalSuiAddress(gasKeypair.toSuiAddress()),
  };
  const earlier = await resolvePending(db, chain, ownerId, parties, now, sleep, canStart);
  if (earlier === 'deferred') return 'deferred';
  if (earlier === 'blocked') return 'skipped_pending';
  // Tatum's nodes can still report the purse without a refill that just landed, so the next
  // refill waits for a later call.
  if (earlier === 'verified') return 'resolved_pending';

  const purse = derivePurseKeypair(args.masterSecretHex, owner.suiAddress);
  if (!sameAddress(purse.toSuiAddress(), owner.purseAddress)) return 'refused';
  // The same checks run again under the lock below. These only spare the chain reads when no
  // refill can happen now; a payment signed before the lock can only lower the ledger, and the
  // next call sees that.
  const early = await refillLedger(db, ownerId, now);
  if (early.pending) return 'skipped_pending';
  if (ledgerRulesOut(early)) return 'not_needed';

  if (!canStart()) return 'deferred';
  const purseReadAtomic = (await chain.getBalances(owner.purseAddress)).usdcAddressBalance;
  if (!refillDecision({ purseUsdcAtomic: purseForDecision(purseReadAtomic, early), refillsInWindow: early.inWindow }).refill) return 'not_needed';

  if (!canStart()) return 'deferred';
  let allowance: AllowanceReading;
  try {
    allowance = await chain.getAllowance(allowanceId);
  } catch (error) {
    // Revoked, or never there: nothing to spend from.
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return 'refused';
    throw error;
  }
  if (!allowanceServes(allowance, owner, now)) return 'refused';
  if (!canStart()) return 'deferred';
  const epoch = await chain.getCurrentEpoch();
  if (!canStart()) return 'deferred';
  const facts: RefillFacts = {
    epoch,
    referenceGasPrice: await chain.getReferenceGasPrice(),
    nonce: randomInt(0, U32_LIMIT),
    allowanceInitialSharedVersion: allowance.initialSharedVersion,
  };

  // The last point to stop: once the row is written, the dry run, the send and the read back always run.
  if (!canStart()) return 'deferred';
  const prepared = await db.transaction(async (tx) => {
    const locked = await readOwner(tx, ownerId, true);
    if (
      locked === undefined ||
      locked.allowanceId !== allowanceId ||
      !sameAddress(locked.purseAddress, owner.purseAddress) ||
      !sameAddress(locked.suiAddress, owner.suiAddress)
    ) {
      return 'refused' as const;
    }
    const ledger = await refillLedger(tx, ownerId, now);
    if (ledger.pending) return 'skipped_pending' as const;
    const decision = refillDecision({ purseUsdcAtomic: purseForDecision(purseReadAtomic, ledger), refillsInWindow: ledger.inWindow });
    if (!decision.refill) return 'not_needed' as const;

    const refill: RefillArgs = {
      spender: parties.purse,
      funder: parties.funder,
      allowanceId,
      amountAtomic: decision.amountAtomic,
      gasOwner: parties.gasOwner,
    };
    const txBytes = await buildRefill(refill, facts);
    await assertRefill(txBytes, refill, facts);
    const signatures = [(await purse.signTransaction(txBytes)).signature, (await gasKeypair.signTransaction(txBytes)).signature];
    const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
    const [row] = await tx
      .insert(refills)
      .values({ ownerId, allowanceId, amountAtomic: decision.amountAtomic, digest, sentAt: now, validUntilEpoch: maxEpochOf(txBytes), status: 'pending' })
      .returning({ id: refills.id, amountAtomic: refills.amountAtomic });
    if (row === undefined) throw new Error('the refill insert returned no row');
    return { row, digest, txBytes, signatures };
  });
  if (typeof prepared === 'string') return prepared;

  let rehearsal: SimulationResult;
  try {
    rehearsal = await chain.simulate(prepared.txBytes);
  } catch (error) {
    // A dry run carries no signature and the signatures never leave this call, so with no
    // verdict these bytes are dropped and can never land.
    await markFailed(db, prepared.row.id);
    throw error;
  }
  if (rehearsal.status !== 'success' || !movedExactly(rehearsal, parties, prepared.row.amountAtomic)) {
    await markFailed(db, prepared.row.id);
    throw new RefillError('DRY_RUN_FAILED', 'the refill dry run did not move exactly the refill, so nothing was sent');
  }

  let executed: ExecutionResult;
  try {
    executed = await chain.executeTransaction(prepared.txBytes, prepared.signatures);
  } catch (error) {
    // INVALID_INPUT is thrown before anything is sent, so those bytes can never land. Every
    // other error leaves the outcome unknown, and the row stays pending for the next call.
    if (error instanceof ChainError && error.code === 'INVALID_INPUT') await markFailed(db, prepared.row.id);
    throw error;
  }
  if (executed.status !== 'success') {
    await markFailed(db, prepared.row.id);
    throw new RefillError('FAILED', 'the refill did not land');
  }
  let landed: TransactionResult;
  try {
    landed = await chain.getTransactionResult(prepared.digest);
  } catch {
    // Tatum's nodes can lag a moment behind the one that ran it; the next call reads it again.
    return 'refilled';
  }
  if ((await recordLanded(db, prepared.row, landed, parties, now)) === 'failed') throw new RefillError('FAILED', 'the refill did not land');
  return 'refilled';
}
