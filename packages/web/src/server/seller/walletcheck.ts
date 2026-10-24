import { type Chain, ChainError } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { findMemoryAccount } from '@ellai/core/memory';
import { USDC_DECIMALS } from '@ellai/core/usdc';
import { SUI_DECIMALS } from '@mysten/sui/utils';
import { decimalAmount } from './challenge.js';

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
 * Throws an Error for an address that is not a Sui address, before any read; ChainError or
 * MemoryError when Tatum cannot answer or the memory account is not readable.
 */
export async function walletCheck(args: { chain: Chain; address: string }): Promise<WalletCheck> {
  const { chain } = args;
  const address = canonicalSuiAddress(args.address);
  const balances = await chain.getBalances(address);
  const account = await findMemoryAccount(chain, address);
  const walrusBlobs = await walrusBlobCount(chain, address);
  return {
    address,
    sui: `${decimalAmount(balances.suiTotal, SUI_DECIMALS)} SUI`,
    usdcAddressBalance: `${decimalAmount(balances.usdcAddressBalance, USDC_DECIMALS)} USDC`,
    usdcCoins: `${decimalAmount(balances.usdcCoinBalance, USDC_DECIMALS)} USDC`,
    hasWalrusMemoryAccount: account !== null,
    walrusBlobs,
    checkedAt: new Date().toISOString(),
  };
}
