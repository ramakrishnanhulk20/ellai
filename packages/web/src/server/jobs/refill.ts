import { randomInt } from 'node:crypto';
import { type RefillArgs, type RefillFacts, assertRefill, buildRefill, refillDecision } from '@ellai/core/allowance';
import { type AllowanceState, type Chain, ChainError, type ExecutionResult, type TransactionResult } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { SUI_TYPE_ARG, normalizeStructTag } from '@mysten/sui/utils';
import { and, asc, count, eq, gte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners, refills } from '../db/schema.js';
import type { DbHandle } from '../pay/sign.js';

export interface RefillJobArgs {
  db: Database;
  chain: Chain;
  ownerId: string;
  masterSecretHex: string;
  /** The gas wallet, which sponsors the refill's gas from its SUI address balance. */
  gasKeypair: Ed25519Keypair;
  now: Date;
}

export type RefillOutcome = 'refilled' | 'not_needed' | 'skipped_pending' | 'refused';

export type RefillErrorCode = 'FAILED' | 'MISMATCH';

/** A refill that went out and did not do what it was built to do. The message is fixed text. */
export class RefillError extends Error {
  readonly code: RefillErrorCode;

  constructor(code: RefillErrorCode, message: string) {
    super(message);
    this.name = 'RefillError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
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

/** Whether a refill is still pending, and every refill sent in the 24 hours before `now`, landed, failed or not yet known. */
async function refillLedger(db: DbHandle, ownerId: string, now: Date): Promise<{ pending: boolean; inWindow: number }> {
  const [pending] = await db
    .select({ id: refills.id })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'pending')))
    .limit(1);
  const [sent] = await db
    .select({ n: count() })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), gte(refills.sentAt, new Date(now.getTime() - DAY_MS))));
  return { pending: pending !== undefined, inWindow: sent?.n ?? 0 };
}

/**
 * C7: the allowance as the chain holds it now debits this owner, pays only this owner's purse,
 * is over Sui Mainnet USDC, has not expired, and still has room for one whole refill under its
 * lifetime cap, since a spend past the cap aborts on chain and the gas wallet pays for nothing.
 */
function allowanceServes(allowance: AllowanceState, owner: OwnerFacts, now: Date): boolean {
  if (!sameAddress(allowance.funder, owner.suiAddress) || !sameAddress(allowance.spender, owner.purseAddress)) return false;
  if (coinOrNull(allowance.coinType) !== USDC_TYPE_MAINNET) return false;
  if (allowance.expirationMs !== null && allowance.expirationMs <= BigInt(now.getTime())) return false;
  return allowance.lifetimeCap === null || allowance.lifetimeCap - allowance.spentTotal >= BigInt(LIMITS.purseRefillAtomic);
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

/** Reads the oldest pending refill's digest and records the outcome. True when the chain does not have it yet. */
async function resolvePending(db: Database, chain: Chain, ownerId: string, parties: Parties, now: Date): Promise<boolean> {
  const [pending] = await db
    .select({ id: refills.id, digest: refills.digest, amountAtomic: refills.amountAtomic })
    .from(refills)
    .where(and(eq(refills.ownerId, ownerId), eq(refills.status, 'pending')))
    .orderBy(asc(refills.sentAt), asc(refills.id))
    .limit(1);
  if (pending === undefined) return false;
  let result: TransactionResult;
  try {
    result = await chain.getTransactionResult(pending.digest);
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return true;
    throw error;
  }
  await recordLanded(db, pending, result, parties, now);
  return false;
}

/**
 * Tops up one owner's purse from the owner's own allowance when the purse runs low, within
 * C23's bounds, with the gas wallet sponsoring the gas (C6, C7, C23, O6).
 *
 * 1. A refill still pending from an earlier call is read by its stored digest first, before
 *    anything else is read or built: landed and exact is 'verified', failed is 'failed', not
 *    on chain yet is 'skipped_pending'.
 * 2. The owner's recorded purse must be the purse derived from the master secret, and the
 *    allowance at the owner's stored allowance_id, read from chain now, must pass C7 (funder
 *    is the owner, spender is the purse, USDC, not expired, room for one refill under the
 *    lifetime cap); otherwise 'refused' and nothing is built or sent.
 * 3. The purse's USDC address balance and the chain facts (epoch, gas price, the allowance's
 *    initial shared version, a random nonce) are read before any lock.
 * 4. In one transaction holding the owner row FOR UPDATE: any refill still pending is
 *    'skipped_pending', so two calls can never refill twice; every refill sent in the last 24
 *    hours is counted and core's refillDecision decides ('not_needed' when it says no). The
 *    refill is built with buildRefill, checked with assertRefill, signed by the derived purse
 *    and by the gas wallet as sponsor, and its row is written with the digest of the signed
 *    bytes, status 'pending', before anything is sent.
 * 5. After commit the bytes are sent. A failure the chain reports is 'failed' and throws
 *    RefillError FAILED. A success is read back by its digest: exactly the refill is
 *    'verified'; not readable yet stays 'pending' for the next call. Either way 'refilled'.
 *    An unknown send outcome stays 'pending' and the ChainError is thrown.
 *
 * Throws for an owner id that is not a uuid or a time that is not a date; ChainError from
 * the reads; AllowanceError from the build; RefillError MISMATCH when a refill landed and
 * moved anything but the refill.
 */
export async function refillIfNeeded(args: RefillJobArgs): Promise<RefillOutcome> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) throw new Error('the owner id is not a uuid');
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) throw new Error('the current time is not a date');
  const { db, chain, gasKeypair, now } = args;
  const ownerId = args.ownerId.toLowerCase();

  const owner = await readOwner(db, ownerId, false);
  if (owner === undefined || owner.allowanceId === null) return 'refused';
  const allowanceId = owner.allowanceId;
  const parties: Parties = {
    purse: canonicalSuiAddress(owner.purseAddress),
    funder: canonicalSuiAddress(owner.suiAddress),
    gasOwner: canonicalSuiAddress(gasKeypair.toSuiAddress()),
  };
  if (await resolvePending(db, chain, ownerId, parties, now)) return 'skipped_pending';

  const purse = derivePurseKeypair(args.masterSecretHex, owner.suiAddress);
  if (!sameAddress(purse.toSuiAddress(), owner.purseAddress)) return 'refused';
  let allowance: AllowanceState;
  try {
    allowance = await chain.getAllowance(allowanceId);
  } catch (error) {
    // Revoked, or never there: nothing to spend from.
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return 'refused';
    throw error;
  }
  if (!allowanceServes(allowance, owner, now)) return 'refused';

  const purseUsdcAtomic = (await chain.getBalances(owner.purseAddress)).usdcAddressBalance;
  // The same checks run again under the lock below. This pass only saves two chain reads when
  // no refill can happen: until the lock, the count can only grow and a pending row only
  // appear, so a no here is still a no there.
  const early = await refillLedger(db, ownerId, now);
  if (early.pending) return 'skipped_pending';
  if (!refillDecision({ purseUsdcAtomic, refillsInWindow: early.inWindow }).refill) return 'not_needed';
  const facts: RefillFacts = {
    epoch: await chain.getCurrentEpoch(),
    referenceGasPrice: await chain.getReferenceGasPrice(),
    nonce: randomInt(0, U32_LIMIT),
    allowanceInitialSharedVersion: allowance.initialSharedVersion,
  };

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
    const decision = refillDecision({ purseUsdcAtomic, refillsInWindow: ledger.inWindow });
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
      .values({ ownerId, allowanceId, amountAtomic: decision.amountAtomic, digest, sentAt: now, status: 'pending' })
      .returning({ id: refills.id, amountAtomic: refills.amountAtomic });
    if (row === undefined) throw new Error('the refill insert returned no row');
    return { row, digest, txBytes, signatures };
  });
  if (typeof prepared === 'string') return prepared;

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
