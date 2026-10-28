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
import { and, asc, count, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners, payments, refills } from '../db/schema.js';
import { allowanceGone, forgetAllowance } from '../onboarding/state.js';
import type { DbHandle } from '../pay/sign.js';

export interface RefillJobArgs {
  db: Database;
  chain: Chain;
  ownerId: string;
  masterSecretHex: string;
  /** The gas wallet, which sponsors the refill's gas from its SUI address balance. */
  gasKeypair: Ed25519Keypair;
  now: Date;
  /**
   * The clock read after the reads it follows: under the owner lock for the day's
   * refill count and the row's sent_at, and for every later stamp, so time the pending refill's
   * reads took is counted (C26). Returns `now` when left out.
   */
  clock?: () => Date;
  /**
   * Not used: a lost refill is now released over two calls, not by reads with waits between them
   * in one. Accepted so callers that still pass it keep compiling.
   */
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
 * What Ellai's own records say the owner's purse holds (Ledger.balanceAtomic): every verified
 * refill in, minus every signed payment out that has not been released. Payments are counted by
 * owner, since each owner has exactly one purse and pays only from it (C7). Below zero when
 * payments outran the refills Ellai recorded.
 */
export async function ledgerBalanceAtomic(db: DbHandle, ownerId: string): Promise<bigint> {
  const [refilled] = await db
    .select({ total: sql<string>`coalesce(sum(${refills.amountAtomic}), 0)::text` })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'verified')));
  const [paid] = await db
    .select({ total: sql<string>`coalesce(sum(${payments.amountAtomic}), 0)::text` })
    .from(payments)
    .where(and(eq(payments.ownerId, ownerId), isNull(payments.releasedAt)));
  return BigInt(refilled?.total ?? '0') - BigInt(paid?.total ?? '0');
}

/**
 * Whether a refill is still pending, every refill sent in the LIMITS.purseRefillWindowMs before
 * `now` (landed, failed, or not yet known), and the purse balance by Ellai's own records
 * (ledgerBalanceAtomic).
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
  return { pending: pending !== undefined, inWindow: sent?.n ?? 0, balanceAtomic: await ledgerBalanceAtomic(db, ownerId) };
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

// The latest time a JavaScript Date can hold. A window ending after it never ends for Ellai.
const LAST_DATE_MS = 8_640_000_000_000_000n;

/**
 * C7: whether the allowance as the chain holds it now can pay one whole refill. 'serves' when it
 * debits this owner, pays only this owner's purse, is over Sui Mainnet USDC, does not expire
 * within LIMITS.allowanceExpiryMarginMs of `now`, and has room for the refill under its lifetime
 * cap and in its current rate window, since a spend past any of those aborts on chain and the gas
 * wallet pays for nothing. The margin covers the dry run, the send and its retries, so a refill
 * whose dry run passed cannot reach the chain after the allowance has expired (C30).
 *
 * 'never' when no later reading can change that (C22): another funder or spender, another coin,
 * expiring within the margin, a lifetime cap with less than a refill left, or a rate limit
 * smaller than one refill. Each of those is fixed when the allowance is made or only moves the
 * wrong way. Otherwise only the current window is short, and the answer is the time it ends: one
 * period from `now` when the reading cannot place the window, and 'never' when the allowance
 * expires within the margin of that time.
 */
function allowanceVerdict(allowance: AllowanceReading, owner: OwnerFacts, now: Date): 'serves' | 'never' | Date {
  if (!sameAddress(allowance.funder, owner.suiAddress) || !sameAddress(allowance.spender, owner.purseAddress)) return 'never';
  if (coinOrNull(allowance.coinType) !== USDC_TYPE_MAINNET) return 'never';
  const nowMs = BigInt(now.getTime());
  const margin = BigInt(LIMITS.allowanceExpiryMarginMs);
  if (allowance.expirationMs !== null && allowance.expirationMs < nowMs + margin) return 'never';
  const refill = BigInt(LIMITS.purseRefillAtomic);
  if (allowance.lifetimeCap !== null && allowance.lifetimeCap - allowance.spentTotal < refill) return 'never';
  if (allowance.periodLimit !== null && allowance.periodLimit < refill) return 'never';
  const room = windowRoom(allowance, now);
  if (room === null || room >= refill) return 'serves';
  const { periodEndMs, periodMs } = allowance;
  let endMs: bigint | null = null;
  if (typeof allowance.periodSpent === 'bigint' && typeof periodEndMs === 'bigint' && periodEndMs > nowMs) endMs = periodEndMs;
  else if (typeof periodMs === 'bigint' && periodMs > 0n) endMs = nowMs + periodMs;
  if (endMs === null || endMs > LAST_DATE_MS) return 'never';
  if (allowance.expirationMs !== null && allowance.expirationMs < endMs + margin) return 'never';
  return new Date(Number(endMs));
}

/**
 * Records the time before which the tick asks the chain nothing for this owner's refill (C22): a
 * full rate window's end, or a set wait after a failed dry run or a purse read at or above the
 * threshold. Only while the owner still holds this allowance.
 */
async function waitForWindow(db: Database, ownerId: string, allowanceId: string, notBefore: Date): Promise<void> {
  await db
    .update(owners)
    .set({ refillNotBefore: notBefore })
    .where(and(eq(owners.id, ownerId), eq(owners.allowanceId, allowanceId)));
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
 * one lagging node must not release a refill that landed in the last moments of its window, so
 * a refill is released as a payment is (C4, C27): the first call that sees the window closed and
 * the digest missing only stamps missing_since, and a call at least LIMITS.paymentReleaseGapMs
 * later whose read misses too marks it 'failed', when it no longer blocks; it still counts
 * toward the day's refills. That later read comes after missing_since, which was stamped after
 * an epoch reading showed the window closed, so it is a read made after the window. A refill
 * found at any call is recorded as it landed. A row with no valid_until_epoch, written before it
 * was kept, waits as before.
 */
async function resolvePending(
  db: Database,
  chain: Chain,
  ownerId: string,
  parties: Parties,
  clock: () => Date,
  canStart: () => boolean,
): Promise<'blocked' | 'verified' | 'clear' | 'deferred'> {
  const [pending] = await db
    .select({
      id: refills.id,
      digest: refills.digest,
      amountAtomic: refills.amountAtomic,
      validUntilEpoch: refills.validUntilEpoch,
      missingSince: refills.missingSince,
    })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'pending')))
    .orderBy(asc(refills.sentAt), asc(refills.id))
    .limit(1);
  if (pending === undefined) return 'clear';
  if (!canStart()) return 'deferred';
  const landed = await readLanded(chain, pending.digest);
  if (landed !== null) return (await recordLanded(db, pending, landed, parties, clock())) === 'verified' ? 'verified' : 'clear';
  if (pending.validUntilEpoch === null) return 'blocked';
  if (!canStart()) return 'deferred';
  if ((await chain.getCurrentEpoch()) <= pending.validUntilEpoch) return 'blocked';

  const at = clock();
  const stillPending = and(eq(refills.id, pending.id), eq(refills.status, 'pending'));
  if (pending.missingSince === null) {
    await db.update(refills).set({ missingSince: at }).where(and(stillPending, isNull(refills.missingSince)));
    return 'blocked';
  }
  const releaseFrom = new Date(at.getTime() - LIMITS.paymentReleaseGapMs);
  if (pending.missingSince.getTime() > releaseFrom.getTime()) return 'blocked';
  const failed = await db
    .update(refills)
    .set({ status: 'failed' })
    .where(and(stillPending, lte(refills.missingSince, releaseFrom)))
    .returning({ id: refills.id });
  return failed.length > 0 ? 'clear' : 'blocked';
}

/**
 * Tops up one owner's purse from the owner's own allowance when the purse runs low, within
 * C23's bounds, with the gas wallet sponsoring the gas (C6, C7, C23, O6).
 *
 * 1. A refill still pending from an earlier call is read by its stored digest first, before
 *    anything else is read or built: landed and exact is 'verified' and this call returns
 *    'resolved_pending' without refilling again; failed is 'failed'; not on chain yet is
 *    'skipped_pending'. Once the chain's epoch is past the refill's valid_until_epoch, the first
 *    call that misses it stamps missing_since and is still 'skipped_pending'; a call at least
 *    LIMITS.paymentReleaseGapMs after that stamp that misses it too makes it 'failed', the same
 *    release rule as a payment's (C4, C27), and goes on as if nothing were pending.
 * 2. The owner's recorded purse must be the purse derived from the master secret; otherwise
 *    'refused' and nothing is read.
 * 3. Ellai's ledger comes before any other chain read (C22, C23): with a refill still pending the
 *    answer is 'skipped_pending', and when the ledger alone rules a refill out (ledgerRulesOut: a
 *    balance at or above LIMITS.purseRefillBelowAtomic, or LIMITS.purseMaxRefillsPerDay already
 *    sent) it is 'not_needed' with nothing read from chain. That answer is exact, since step 4
 *    decides on the larger of the read and the ledger, so an idle owner costs no Tatum call.
 * 4. Otherwise the purse's USDC address balance is read, and the answer is 'not_needed' when
 *    core's refillDecision on the larger of that read and the ledger (purseForDecision) says no.
 *    When that read is at or above LIMITS.purseRefillBelowAtomic, refill_not_before is also set
 *    LIMITS.pendingPaymentReadIntervalMs after the clock read that follows it, while the owner
 *    still holds this allowance, so a purse holding money Ellai's ledger does not know about costs
 *    one read an hour, not one a tick (C22).
 * 5. Only for a refill that will be built is the allowance at the owner's stored allowance_id
 *    read, and it must pass C7 (funder is the owner, spender is the purse, USDC, not expired,
 *    room for one refill under the lifetime cap and in the current rate window); otherwise
 *    'refused' and nothing is built or sent. The refusal is recorded so the chain is not asked
 *    the same question again (C22, allowanceVerdict): an allowance that is gone or can never pay
 *    again has allowance_id, allowance_checked_at and refill_not_before cleared in one update, and
 *    one whose current rate window alone is short sets refill_not_before to the window's end,
 *    which the jobs tick waits for. Either update touches the owner only while it still holds this
 *    allowance id. Gone means getAllowance (GraphQL) answers NOT_FOUND and allowanceGone (one gRPC
 *    read) agrees; while gRPC still holds it, nothing is written, one console.warn line
 *    allowance_index_lag is logged, and the next visit reads it again. Then the chain facts
 *    (epoch, gas price, the allowance's initial shared version, a random nonce) are read, all
 *    before any lock.
 * 6. In one transaction holding the owner row FOR UPDATE: any refill still pending is
 *    'skipped_pending', so two calls can never refill twice; `clock` is read, every refill sent
 *    in the LIMITS.purseRefillWindowMs before that reading is counted, and core's refillDecision
 *    decides again on the larger of the balance read and Ellai's ledger (purseForDecision),
 *    'not_needed' when it says no (C23, C26). The refill is
 *    built with buildRefill, checked with assertRefill, signed by the derived purse and by the
 *    gas wallet as sponsor, and its row is written with the digest of the signed bytes, their
 *    maxEpoch as valid_until_epoch, that same reading as sent_at, status 'pending', before
 *    anything leaves Ellai.
 * 7. After commit the signed bytes are dry-run with chain.simulate. Unless the dry run
 *    succeeds and moves exactly the refill, the row is 'failed', nothing is sent, and the
 *    call throws: RefillError DRY_RUN_FAILED, or the dry run's own ChainError (C6). A dry run
 *    that gave its verdict and failed also sets refill_not_before LIMITS.refillDryRunWaitMs (an
 *    hour) ahead, while the owner still holds this allowance, so the tick does not try again
 *    sooner (C22).
 * 8. Then the bytes are sent. A failure the chain reports is 'failed' and throws RefillError
 *    FAILED. A success is read back by its digest: exactly the refill is 'verified'; not
 *    readable yet stays 'pending' for the next call. Either way 'refilled'. An unknown send
 *    outcome stays 'pending' and the ChainError is thrown. A send core reports as never sent,
 *    INVALID_INPUT or BUDGET (Ellai's Tatum budget refused it), is 'failed' and its ChainError
 *    is thrown, so no refill waits on bytes that never left.
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
  const readClock = args.clock ?? (() => now);
  const clock = (): Date => {
    const at = readClock();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('the current time is not a date');
    return at;
  };
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
  const earlier = await resolvePending(db, chain, ownerId, parties, clock, canStart);
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
  const early = await refillLedger(db, ownerId, clock());
  if (early.pending) return 'skipped_pending';
  if (ledgerRulesOut(early)) return 'not_needed';

  if (!canStart()) return 'deferred';
  const purseReadAtomic = (await chain.getBalances(owner.purseAddress)).usdcAddressBalance;
  if (!refillDecision({ purseUsdcAtomic: purseForDecision(purseReadAtomic, early), refillsInWindow: early.inWindow }).refill) {
    // Money that reached the purse outside Ellai keeps the read above the ledger, which alone
    // would cost this read on every tick (C22).
    if (purseReadAtomic >= BigInt(LIMITS.purseRefillBelowAtomic)) {
      await waitForWindow(db, ownerId, allowanceId, new Date(clock().getTime() + LIMITS.pendingPaymentReadIntervalMs));
    }
    return 'not_needed';
  }

  if (!canStart()) return 'deferred';
  let allowance: AllowanceReading;
  try {
    allowance = await chain.getAllowance(allowanceId);
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') {
      if (!canStart()) return 'deferred';
      // GraphQL alone can miss a live allowance while its index lags, so gRPC must agree it is gone.
      if (!(await allowanceGone(chain, allowanceId))) {
        console.warn('[ellai refill] allowance_index_lag');
        return 'refused';
      }
      await forgetAllowance(db, ownerId, allowanceId);
      return 'refused';
    }
    throw error;
  }
  // Read after the allowance itself, so its expiry and window are judged at a time no earlier than the reading (C26).
  const verdict = allowanceVerdict(allowance, owner, clock());
  if (verdict === 'never') {
    await forgetAllowance(db, ownerId, allowanceId);
    return 'refused';
  }
  if (verdict !== 'serves') {
    await waitForWindow(db, ownerId, allowanceId, verdict);
    return 'refused';
  }
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
    // Read under the lock, after every chain read above, so the day's count and the new row's
    // sent_at both stand at the moment the refill is decided (C26).
    const lockedAt = clock();
    const ledger = await refillLedger(tx, ownerId, lockedAt);
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
      .values({ ownerId, allowanceId, amountAtomic: decision.amountAtomic, digest, sentAt: lockedAt, validUntilEpoch: maxEpochOf(txBytes), status: 'pending' })
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
    // An allowance whose funder holds no USDC passes every read but fails here, and would
    // otherwise cost a full set of reads and a dry run on every tick (C22, D-1). Only an hour,
    // since the owner can top up their wallet at any time.
    await waitForWindow(db, ownerId, allowanceId, new Date(clock().getTime() + LIMITS.refillDryRunWaitMs));
    throw new RefillError('DRY_RUN_FAILED', 'the refill dry run did not move exactly the refill, so nothing was sent');
  }

  let executed: ExecutionResult;
  try {
    executed = await chain.executeTransaction(prepared.txBytes, prepared.signatures);
  } catch (error) {
    // Core throws INVALID_INPUT and BUDGET only before anything is sent, and the signatures never
    // leave this call, so those bytes can never land. Every other error leaves the outcome
    // unknown, and the row stays pending for the next call.
    if (error instanceof ChainError && (error.code === 'INVALID_INPUT' || error.code === 'BUDGET')) await markFailed(db, prepared.row.id);
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
  if ((await recordLanded(db, prepared.row, landed, parties, clock())) === 'failed') throw new RefillError('FAILED', 'the refill did not land');
  return 'refilled';
}
