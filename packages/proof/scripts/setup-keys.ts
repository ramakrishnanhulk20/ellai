// Creates the root .env secrets the proof package needs, without ever replacing one.
// Each missing variable is generated and appended as a new line; existing lines are
// never rewritten or reordered. A variable that is present but blank (copied from
// .env.example) counts as missing: the appended line wins because Node's .env parser
// keeps the last value of a repeated name. Prints only public values.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import { deriveMemwalDelegateKeypair, derivePurseKeypair } from '@ellai/core/keys';

const ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url));
const MASTER_SECRET_BYTES = 32;
const OWNER_ONLY_FILE_MODE = 0o600;

// SUI_NETWORK is not a secret, but config.ts refuses to start without it and this
// script is the only writer of .env.
const GENERATORS: ReadonlyArray<readonly [string, () => string]> = [
  ['SUI_NETWORK', () => 'mainnet'],
  ['ELLAI_MASTER_SECRET', () => randomBytes(MASTER_SECRET_BYTES).toString('hex')],
  ['OWNER_TEST_PRIVATE_KEY', () => Ed25519Keypair.generate().getSecretKey()],
  ['GAS_PRIVATE_KEY', () => Ed25519Keypair.generate().getSecretKey()],
];

function readEnvFile(): { text: string; values: Record<string, string> } {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  return { text, values: parseEnv(text) as Record<string, string> };
}

async function main(): Promise<void> {
  const before = readEnvFile();
  const missing = GENERATORS.filter(([name]) => !before.values[name]);
  if (missing.length > 0) {
    const separator = before.text === '' || before.text.endsWith('\n') ? '' : '\n';
    const lines = missing.map(([name, generate]) => `${name}=${generate()}\n`).join('');
    appendFileSync(ENV_PATH, `${separator}${lines}`, { encoding: 'utf8', mode: OWNER_ONLY_FILE_MODE });
  }

  // Re-read from disk so the printed values come from what was actually saved.
  const after = readEnvFile().values;
  for (const [name, value] of Object.entries(after)) process.env[name] = value;
  // Loaded late on purpose: config.ts validates process.env the moment it loads, and
  // the variables it needs may not have existed before the append above.
  const { config } = await import('../src/config.js');

  const ownerAddress = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress();
  const gasAddress = Ed25519Keypair.fromSecretKey(config.GAS_PRIVATE_KEY).toSuiAddress();
  const purseAddress = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).toSuiAddress();
  const delegatePublicKey = toHex(
    deriveMemwalDelegateKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).getPublicKey().toRawBytes(),
  );

  console.log(`Test owner address:          ${ownerAddress}`);
  console.log(`Gas wallet address:          ${gasAddress}`);
  console.log(`Test owner purse address:    ${purseAddress}`);
  console.log(`Walrus delegate public key:  ${delegatePublicKey}`);
}

main().catch((error: unknown) => {
  // Only the message: config.ts and keys.ts build theirs from variable names, never values.
  console.error(error instanceof Error ? error.message : 'setup failed');
  process.exitCode = 1;
});
