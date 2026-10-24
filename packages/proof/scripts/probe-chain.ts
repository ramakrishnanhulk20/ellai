// Reads Sui Mainnet through Tatum for the three wallets setup created and prints what
// it sees. Reads only: it never signs or sends anything. Five gateway calls in total,
// which fits the anonymous allowance of 5 requests a minute.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SUI_DECIMALS } from '@mysten/sui/utils';
import { type Balances, createChain } from '@ellai/core/chain';
import { derivePurseKeypair } from '@ellai/core/keys';
import { USDC_DECIMALS } from '@ellai/core/usdc';
import { config } from '../src/config.js';

function inUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const sign = amount < 0n ? '-' : '';
  const magnitude = amount < 0n ? -amount : amount;
  return `${sign}${magnitude / base}.${(magnitude % base).toString().padStart(decimals, '0')}`;
}

function describeBalances(label: string, address: string, balances: Balances): string {
  return [
    `${label} ${address}`,
    `  USDC in address balance: ${inUnits(balances.usdcAddressBalance, USDC_DECIMALS)}`,
    `  USDC in coin objects:    ${inUnits(balances.usdcCoinBalance, USDC_DECIMALS)}`,
    `  SUI total:               ${inUnits(balances.suiTotal, SUI_DECIMALS)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const ownerAddress = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress();
  const gasAddress = Ed25519Keypair.fromSecretKey(config.GAS_PRIVATE_KEY).toSuiAddress();
  const purseAddress = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).toSuiAddress();

  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  try {
    console.log(`Tatum Sui Mainnet probe. Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
    console.log(`Reference gas price: ${await chain.getReferenceGasPrice()} MIST`);
    console.log(describeBalances('Test owner', ownerAddress, await chain.getBalances(ownerAddress)));
    console.log(describeBalances('Gas wallet', gasAddress, await chain.getBalances(gasAddress)));
    console.log(describeBalances('Test owner purse', purseAddress, await chain.getBalances(purseAddress)));
    const blobs = await chain.listOwnedWalrusBlobs(ownerAddress);
    console.log(`Walrus Blob objects owned by the test owner: ${blobs.length}`);
  } finally {
    chain.close();
  }
}

main().catch((error: unknown) => {
  // ChainError and config errors are built without secrets, so the message is safe to show.
  console.error(error instanceof Error ? error.message : 'probe failed');
  process.exitCode = 1;
});
