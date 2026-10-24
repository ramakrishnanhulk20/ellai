import { normalizeStructTag } from '@mysten/sui/utils';

/** Circle's native USDC on Sui Mainnet, in the SDK's canonical form so string comparisons are exact. */
export const USDC_TYPE_MAINNET = normalizeStructTag(
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
);

/** One USDC is 10^6 atomic units. */
export const USDC_DECIMALS = 6;
