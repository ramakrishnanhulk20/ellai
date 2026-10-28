import { randomInt } from 'node:crypto';
import { AllowanceError, assertUsdcToAddress, buildUsdcToAddress, type CoinRef, type OwnerGasFacts } from '@ellai/core/allowance';
import { type Chain, ChainError, type OwnedCoin } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import type { Database } from '../db/client.js';
import { formatUsdc } from '../decide/sentences.js';
import { loadOwner, NOT_ENOUGH_SUI_MESSAGE, NOTHING_TO_MOVE_MESSAGE, OnboardingError } from './state.js';

/**
 * The Tatum calls ownerWallet's success path makes, which the wallet route counts against the day's
 * budgets before it (C22): one ListBalances page. An address sent more than LIMITS.balancePageSize
 * coin types reads more pages, as the overview's purse read does.
 */
export const WALLET_CHAIN_CALLS = 1;

// The nonce field of a ValidDuring expiration is a u32.
const NONCE_RANGE = 2 ** 32;

/**
 * Where a setup transaction's fee comes from: the SUI address balance, the owner's SUI coins, or
 * null when neither covers the budget on its own, since Ellai never combines the two.
 */
export type FeeSource = 'address_balance' | 'coins' | null;

/** Atomic amounts as decimal strings, since JSON numbers lose precision past 2^53. */
export interface OwnerWallet {
  /** USDC in the owner's address balance, the only part an allowance can draw from. */
  usdcAddressAtomic: string;
  /** USDC the owner holds as Coin objects, which the usdc_to_address step moves into the address balance. */
  usdcCoinAtomic: string;
  /** SUI in the owner's address balance, in MIST. It pays a setup transaction's gas only when it covers the whole budget. */
  suiAddressMist: string;
  /** SUI the owner holds as Coin objects, in MIST, which pays the gas when the address balance falls short. */
  suiCoinMist: string;
  /** How the allowance step's fee (LIMITS.issueGasBudgetMist) would be paid from these balances, by chooseOwnerGas's rule (feeSourceFor). */
  feeSource: FeeSource;
}

// The one comparison every fee choice here makes, so the wallet route can never promise a fee
// source the build would then refuse.
function coversGas(heldMist: bigint, budgetMist: bigint): boolean {
  return heldMist >= budgetMist;
}

/**
 * The fee source chooseOwnerGas would pick for `budgetMist` from balances already read: the SUI
 * address balance when it alone covers the budget, else the SUI coins when together they do, else
 * null. Not covered: an owner with more than LIMITS.ownedCoinsMax SUI coins whose listed ones fall
 * short while all of them would not, which chooseOwnerGas then refuses with NOT_ENOUGH_SUI.
 */
export function feeSourceFor(suiAddressMist: bigint, suiCoinMist: bigint, budgetMist: bigint): FeeSource {
  if (coversGas(suiAddressMist, budgetMist)) return 'address_balance';
  return coversGas(suiCoinMist, budgetMist) ? 'coins' : null;
}

function amountText(value: unknown): string {
  // getWalletBalances promises non-negative bigints; anything else is refused rather than passed on (standard 3).
  if (typeof value !== 'bigint' || value < 0n) throw new ChainError('BAD_RESPONSE', 'a wallet balance is not a whole non-negative amount');
  return value.toString(10);
}

/**
 * Where the owner's own USDC and SUI sit, so the allowance step can show whether an allowance would
 * have anything to draw and whether the owner can pay the fee: one read of Sui Mainnet through Tatum
 * (getWalletBalances) for the address on the owner row, never one the caller names (C13). feeSource
 * comes from that same read (feeSourceFor at LIMITS.issueGasBudgetMist), with no further call.
 * Nothing is recorded.
 * Throws OnboardingError: BAD_INPUT for an owner id that is not a uuid, NO_OWNER. Throws ChainError
 * when Tatum cannot answer or Ellai's Tatum budget refuses the read (BUDGET, nothing sent).
 */
export async function ownerWallet(args: { db: Database; ownerId: string; chain: Chain }): Promise<OwnerWallet> {
  const owner = await loadOwner(args.db, args.ownerId);
  const balances = await args.chain.getWalletBalances(canonicalSuiAddress(owner.suiAddress));
  const wallet = {
    usdcAddressAtomic: amountText(balances.usdcAddressBalance),
    usdcCoinAtomic: amountText(balances.usdcCoinBalance),
    suiAddressMist: amountText(balances.suiAddressBalance),
    suiCoinMist: amountText(balances.suiCoinBalance),
  };
  // amountText has refused anything but a whole non-negative amount before the balances are compared.
  return { ...wallet, feeSource: feeSourceFor(balances.suiAddressBalance, balances.suiCoinBalance, BigInt(LIMITS.issueGasBudgetMist)) };
}

const asRef = (coin: OwnedCoin): CoinRef => ({ objectId: coin.objectId, version: coin.version, digest: coin.digest });

/**
 * The fewest of `coins` whose balances reach `budget`, largest first (ties by object id, so one
 * listing always gives one answer), or null when all of them together fall short.
 */
export function fewestCovering(coins: readonly OwnedCoin[], budget: bigint): CoinRef[] | null {
  const largestFirst = [...coins].sort((a, b) => (a.balance === b.balance ? (a.objectId < b.objectId ? -1 : 1) : a.balance > b.balance ? -1 : 1));
  const picked: CoinRef[] = [];
  let held = 0n;
  for (const coin of largestFirst) {
    picked.push(asRef(coin));
    held += coin.balance;
    if (coversGas(held, budget)) return picked;
  }
  return null;
}

/**
 * How the owner pays `budgetMist` of gas on a setup transaction Ellai builds for them, chosen from a
 * live read through Tatum of the owner's own address: their SUI address balance when it covers the
 * whole budget (getWalletBalances, one call), otherwise the fewest of their SUI coins that do
 * (listSuiCoins, one more call, at most LIMITS.ownedCoinsMax coins read). Then the gas price, and
 * for the address balance the epoch, which its ValidDuring window needs (one call each).
 * Not covered: SUI coins past the first LIMITS.ownedCoinsMax listed, and the address balance and
 * coins together, which Ellai never combines.
 * Throws OnboardingError NOT_ENOUGH_SUI when neither covers the budget, and ChainError when Tatum
 * cannot answer.
 */
export async function chooseOwnerGas(chain: Chain, ownerAddress: string, budgetMist: number): Promise<OwnerGasFacts> {
  const budget = BigInt(budgetMist);
  const { suiAddressBalance } = await chain.getWalletBalances(ownerAddress);
  if (coversGas(suiAddressBalance, budget)) {
    const referenceGasPrice = await chain.getReferenceGasPrice();
    return { epoch: await chain.getCurrentEpoch(), referenceGasPrice, nonce: randomInt(0, NONCE_RANGE) };
  }
  const gasCoins = fewestCovering((await chain.listSuiCoins(ownerAddress)).coins, budget);
  if (gasCoins === null) throw new OnboardingError('NOT_ENOUGH_SUI', NOT_ENOUGH_SUI_MESSAGE);
  return { referenceGasPrice: await chain.getReferenceGasPrice(), gasCoins };
}

/**
 * Holds signed bytes' gas coins to the owner's own SUI coins as Sui shows them now, re-read through
 * Tatum (listSuiCoins, one call): each must be listed at the same version and digest. A coin of
 * someone else's, or one spent since the build, is refused before anything is sent (C7).
 * Throws OnboardingError BAD_TRANSACTION, and ChainError when Tatum cannot answer.
 */
export async function requireOwnersGasCoins(chain: Chain, ownerAddress: string, gasCoins: readonly CoinRef[]): Promise<void> {
  const { coins } = await chain.listSuiCoins(ownerAddress);
  const current = new Map(coins.map((coin) => [coin.objectId, coin]));
  for (const gasCoin of gasCoins) {
    const listed = current.get(canonicalSuiAddress(gasCoin.objectId));
    if (listed === undefined || listed.version !== gasCoin.version || listed.digest !== gasCoin.digest) {
      throw new OnboardingError('BAD_TRANSACTION', 'the SUI coins it pays its fee with are not yours as Sui shows them now; build it again');
    }
  }
}

/** The owner's USDC coins as listUsdcCoins reads them, and what they hold together; NOTHING_TO_MOVE when that is nothing. */
async function coinsToMove(chain: Chain, ownerAddress: string): Promise<{ coins: OwnedCoin[]; totalAtomic: bigint }> {
  const { coins } = await chain.listUsdcCoins(ownerAddress);
  const totalAtomic = coins.reduce((sum, coin) => sum + coin.balance, 0n);
  if (coins.length === 0 || totalAtomic === 0n) throw new OnboardingError('NOTHING_TO_MOVE', NOTHING_TO_MOVE_MESSAGE);
  return { coins, totalAtomic };
}

/**
 * Builds the owner's own transaction that moves every USDC coin of theirs listUsdcCoins reads (at
 * most LIMITS.ownedCoinsMax) into their own address balance (core buildUsdcToAddress), with the gas
 * source chooseOwnerGas picks, and a plain summary of it. The owner's address comes from the owner
 * row and the coins from Sui, never from the caller (C7, C13), and every summary value is one of
 * those or an amount Ellai added up itself (C15). An owner holding more coins runs it again.
 * Throws OnboardingError NOTHING_TO_MOVE before any gas read when the owner holds no USDC coins
 * (or only empty ones), NOT_ENOUGH_SUI; AllowanceError or ChainError from core.
 */
export async function buildUsdcMoveStep(chain: Chain, ownerAddress: string): Promise<{ bytes: Uint8Array; summary: Array<{ label: string; value: string }> }> {
  const { coins, totalAtomic } = await coinsToMove(chain, ownerAddress);
  const facts = await chooseOwnerGas(chain, ownerAddress, LIMITS.usdcMoveGasBudgetMist);
  const bytes = await buildUsdcToAddress({ owner: ownerAddress, coins }, facts);
  return {
    bytes,
    summary: [
      { label: 'Action', value: 'Move your USDC into your address balance' },
      { label: 'Amount', value: `${formatUsdc(totalAtomic)} USDC` },
      { label: 'From', value: `${coins.length} ${coins.length === 1 ? 'coin' : 'coins'} in your wallet` },
      { label: 'To', value: `your address balance at ${ownerAddress}` },
    ],
  };
}

/**
 * Holds signed bytes to the USDC move: byte for byte a fresh buildUsdcToAddress for the owner, with
 * the owner's USDC coins re-read now through Tatum (listUsdcCoins) and the gas source the bytes carry
 * (`facts`, read from them); then, when the bytes pay with SUI coins, those coins re-read as the
 * owner's own (requireOwnersGasCoins). So another recipient, another coin type, a third party's coin
 * or an extra command is refused before anything is sent (C6, C7).
 * Returns what the coins hold together, as just read: what the move puts in the address balance.
 * Throws OnboardingError NOTHING_TO_MOVE when the owner holds no USDC coins now, BAD_TRANSACTION
 * for bytes that are not the move; ChainError when Tatum cannot answer.
 */
export async function checkUsdcMoveStep(chain: Chain, ownerAddress: string, bytes: Uint8Array, facts: OwnerGasFacts): Promise<{ movedAtomic: bigint }> {
  const { coins, totalAtomic } = await coinsToMove(chain, ownerAddress);
  try {
    await assertUsdcToAddress(bytes, { owner: ownerAddress, coins }, facts);
  } catch (error) {
    if (error instanceof AllowanceError) throw new OnboardingError('BAD_TRANSACTION', 'it is not the transaction Ellai builds for this step');
    throw error;
  }
  if ('gasCoins' in facts) await requireOwnersGasCoins(chain, ownerAddress, facts.gasCoins);
  return { movedAtomic: totalAtomic };
}
