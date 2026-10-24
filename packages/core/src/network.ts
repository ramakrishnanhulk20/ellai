/**
 * The base58 digest of the Sui Mainnet genesis checkpoint, which Sui calls the chain
 * identifier. Every transaction Ellai builds names it in its ValidDuring window, and
 * t2000 challenges carry it as extra.suimpp.chain. Kept here once so no builder or
 * check can drift onto another chain.
 */
export const SUI_MAINNET_CHAIN_ID = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

/** The x402 network name of the only network Ellai pays on. */
export const DEPLOYMENT_NETWORK = 'sui:mainnet';
