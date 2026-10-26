import { type Chain, ChainError } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { findMemoryAccount } from '@ellai/core/memory';
import { USDC_DECIMALS } from '@ellai/core/usdc';
import { SUI_DECIMALS } from '@mysten/sui/utils';
import { decimalAmount } from './challenge.js';
import { type SellerDeadline, canStartRead, pastDeadline, withinDeadline } from './deadline.js';

export interface WalletCheck {
  address: string;
  sui: string;
  usdcAddressBalance: string;
  usdcCoins: string;
  hasWalrusMemoryAccount: boolean;
  walrusBlobs: number;
  checkedAt: string;
}

// listOwnedWalrusBlobs reads at most this many before refusing a partial list.
const BLOB_COUNT_CAP = LIMITS.graphqlMaxPages * LIMITS.graphqlPageSize;

async function walrusBlobCount(chain: Chain, address: string): Promise<number> {
  try {
    return (await chain.listOwnedWalrusBlobs(address)).length;
  } catch (error) {
    if (error instanceof ChainError && error.code === 'LIMIT_EXCEEDED') return BLOB_COUNT_CAP;
    throw error;
  }
}

/**
 * A plain summary of one Sui Mainnet address, read through Tatum only, one step after another
 * so a burst stays inside Tatum's pacing: all its SUI, its USDC split into the address balance
 * (what a gasless payment or an allowance can draw on) and Coin objects, whether it owns a
 * Walrus Memory account, and how many Walrus blobs it holds. Amounts are exact decimals with
 * their unit, for example "0.05 USDC". The blob count stops at the reader's own page limits:
 * an address with more than LIMITS.graphqlMaxPages times LIMITS.graphqlPageSize blobs, or a
 * page too large to read, counts as that many. checkedAt is when the last read finished.
 * Each of the three steps begins only before the deadline's readByMs, and the whole check is cut
 * off at its endByMs, since one step can page or wait inside core for longer than the route may
 * run (C21).
 * Throws an Error for an address that is not a Sui address, before any read; ChainError or
 * MemoryError when Tatum cannot answer or the memory account is not readable; ChainError TIMEOUT
 * (pastDeadline) when the deadline stops it.
 */
export async function walletCheck(args: { chain: Chain; address: string; deadline: SellerDeadline }): Promise<WalletCheck> {
  const { chain, deadline } = args;
  const address = canonicalSuiAddress(args.address);
  // Checked before each step, so once the check is cut off the steps still running start nothing more.
  const step = <T>(read: () => Promise<T>): Promise<T> => (canStartRead(deadline) ? read() : Promise.reject(pastDeadline()));
  return withinDeadline(deadline, async () => {
    const balances = await step(() => chain.getBalances(address));
    const account = await step(() => findMemoryAccount(chain, address));
    const walrusBlobs = await step(() => walrusBlobCount(chain, address));
    return {
      address,
      sui: `${decimalAmount(balances.suiTotal, SUI_DECIMALS)} SUI`,
      usdcAddressBalance: `${decimalAmount(balances.usdcAddressBalance, USDC_DECIMALS)} USDC`,
      usdcCoins: `${decimalAmount(balances.usdcCoinBalance, USDC_DECIMALS)} USDC`,
      hasWalrusMemoryAccount: account !== null,
      walrusBlobs,
      checkedAt: new Date().toISOString(),
    };
  });
}
