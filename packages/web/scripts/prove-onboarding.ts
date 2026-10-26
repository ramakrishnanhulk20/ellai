// Proves owner onboarding against Sui Mainnet through Tatum, read only: nothing is signed or
// sent. The test owner's three onboarding transactions from WO-3a and WO-3b (the Walrus Memory
// account, Ellai's delegate key, the purse allowance) are confirmed the way the app will
// confirm a new owner's, so each value is recorded only after Ellai read it from chain itself.
// Then a new allowance is built for the owner's wallet to sign, its summary printed, and the
// unsigned bytes dry run. Every run uses a fresh PGlite file database under
// scratchpad/onboarding-db. Tatum reads are spaced at least a second apart and a rate limit is
// waited out once, as another job may be using the same key. Prints ids, amounts and gas,
// never a key, a signature or the transaction bytes.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AllowanceError } from '@ellai/core/allowance';
import { type Chain, ChainError, classifyChainError, createChain } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, normalizeStructTag, SUI_TYPE_ARG } from '@mysten/sui/utils';
import { z } from 'zod';
import { createDb, migrate } from '../src/server/db/client.js';
import { owners } from '../src/server/db/schema.js';
import { formatUsdc } from '../src/server/decide/sentences.js';
import { withTatumScope } from '../src/server/http/tatum-meter.js';
import { ownerDelegate } from '../src/server/memory/delegate.js';
import { buildOnboardingTx } from '../src/server/onboarding/build.js';
import { confirmOnboardingTx } from '../src/server/onboarding/confirm.js';
import { type OnboardingStep, OnboardingError, onboardingState } from '../src/server/onboarding/state.js';

const DB_ROOT = fileURLToPath(new URL('../../../scratchpad/onboarding-db', import.meta.url));
// The test owner's own onboarding transactions, landed in WO-3a and WO-3b (DECISIONS.md).
const STEPS: Array<{ step: OnboardingStep; digest: string }> = [
  { step: 'memory_account', digest: 'AQ2cfEAh3AiC1SBMkH64f4MP4QsvTettKfhLXErgNcFh' },
  { step: 'add_delegate', digest: '5tqzSZDCVKcADCDnwq5Qr2QHUXbycSfwpyGgk8Ncc1nU' },
  { step: 'allowance', digest: '2fbeMFCXrpijXzbBv1rPHBpZBBQdNt6y7ujfiwpePkyo' },
];
const EXPECTED_ACCOUNT_ID = '0x98a4e7a42754de51dd86bf5b8a06e6caaa2e4dcc8bc08f630952ce291ee91121';
const EXPECTED_ALLOWANCE_ID = '0xd2b941082590b7d9d0a04482109670f94c290714889b67e8ef2c60ec6d9699c8';
const NEW_ALLOWANCE = { dailyLimitAtomic: 500_000n, lifetimeCapAtomic: 1_000_000n, days: 30 };
const TATUM_SPACING_MS = 1_000;
const RATE_LIMIT_WAIT_MS = 10_000;
const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);
const MIST_PER_SUI = 1_000_000_000n;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A refusal written by this script. Its message is fixed text and validated ids only. */
class ProofError extends Error {}

const blankIsMissing = (value: unknown): unknown => (value === '' ? undefined : value);

function isEd25519SuiKey(value: string): boolean {
  try {
    const { scheme, secretKey } = decodeSuiPrivateKey(value);
    return scheme === 'ED25519' && secretKey.length === 32;
  } catch {
    return false;
  }
}

const configSchema = z.object({
  ELLAI_MASTER_SECRET: z.preprocess(blankIsMissing, z.string().regex(/^[0-9a-f]{64}$/i)),
  OWNER_TEST_PRIVATE_KEY: z.preprocess(blankIsMissing, z.string().startsWith('suiprivkey').refine(isEd25519SuiKey)),
  TATUM_API_KEY: z.preprocess(blankIsMissing, z.string().optional()),
});

/** The three variables this proof reads. The message names bad variables and never a value. */
function loadConfig(env: Record<string, string | undefined>): z.infer<typeof configSchema> {
  const names = Object.keys(configSchema.shape);
  const result = configSchema.safeParse(Object.fromEntries(names.map((name) => [name, env[name]])));
  if (result.success) return result.data;
  const bad = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  throw new ProofError(`root .env is missing or has malformed: ${bad.join(', ')}`);
}

function failureLabel(error: unknown): string {
  if (error instanceof OnboardingError || error instanceof MemoryError || error instanceof AllowanceError) return `${error.code}: ${error.message}`;
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof ProofError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * The same chain, with every Tatum read this proof makes spaced at least TATUM_SPACING_MS
 * apart and a rate-limited read tried once more after RATE_LIMIT_WAIT_MS. Covers the Chain
 * methods confirm and build call and the two raw gRPC reads under them: getObjects for the
 * Walrus Memory registry and account, and getTransaction for the sender and created objects.
 */
function pacedChain(chain: Chain): Chain {
  let lastCall = 0;
  const paced = async <T>(run: () => PromiseLike<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + TATUM_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        return await run();
      } catch (error) {
        if (attempt > 0 || classifyChainError(error).code !== 'RATE_LIMITED') throw error;
        console.log(`  Tatum rate limited a read; waiting ${RATE_LIMIT_WAIT_MS / 1000} s and trying it once more`);
        await sleep(RATE_LIMIT_WAIT_MS);
      }
    }
  };
  const passThrough = (target: object, property: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? (value as AnyFunction).bind(target) : value;
  };
  const ledger = new Proxy(chain.grpc.ledgerService, {
    get(target, property) {
      if (property !== 'getTransaction') return passThrough(target, property);
      return (...args: Parameters<typeof target.getTransaction>) => paced(() => target.getTransaction(...args));
    },
  });
  const grpc = new Proxy(chain.grpc, {
    get(target, property) {
      if (property === 'ledgerService') return ledger;
      if (property !== 'getObjects') return passThrough(target, property);
      return (...args: Parameters<typeof target.getObjects>) => paced(() => target.getObjects(...args));
    },
  });
  return {
    ...chain,
    grpc,
    getTransactionResult: (digest) => paced(() => chain.getTransactionResult(digest)),
    getAllowance: (objectId) => paced(() => chain.getAllowance(objectId)),
    getCurrentEpoch: () => paced(() => chain.getCurrentEpoch()),
    getReferenceGasPrice: () => paced(() => chain.getReferenceGasPrice()),
    simulate: (txBytes) => paced(() => chain.simulate(txBytes)),
  };
}

function formatSui(mist: bigint): string {
  const sign = mist < 0n ? '-' : '';
  const magnitude = mist < 0n ? -mist : mist;
  return `${sign}${magnitude / MIST_PER_SUI}.${(magnitude % MIST_PER_SUI).toString().padStart(9, '0')}`;
}

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const masterSecretHex = config.ELLAI_MASTER_SECRET;
  const ownerAddress = canonicalSuiAddress(Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress());
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(masterSecretHex, ownerAddress).toSuiAddress());
  const delegateHex = ownerDelegate(masterSecretHex, ownerAddress).publicKeyHex;
  const expected: Record<OnboardingStep, string> = {
    memory_account: EXPECTED_ACCOUNT_ID,
    add_delegate: delegateHex,
    allowance: EXPECTED_ALLOWANCE_ID,
  };

  const run = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(DB_ROOT, { recursive: true });
  console.log('Ellai owner onboarding on Sui Mainnet, read only. Nothing is signed or sent.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
  console.log(`Test owner ${ownerAddress}`);
  console.log(`Purse ${purseAddress} (derived), Ellai delegate key ${delegateHex} (derived)`);
  console.log(`Fresh database scratchpad/onboarding-db/${run}`);

  const handle = await createDb(`pglite:${DB_ROOT}/${run}`);
  const chain = pacedChain(createChain({ apiKey: config.TATUM_API_KEY }));
  const problems: string[] = [];
  try {
    const { db } = handle;
    await migrate(db);
    const [owner] = await db.insert(owners).values({ suiAddress: ownerAddress, purseAddress }).returning({ id: owners.id });
    if (owner === undefined) throw new ProofError('the owner insert returned no row');
    const ownerId = owner.id;
    const showState = async () => {
      const state = await onboardingState({ db, ownerId });
      console.log(`  onboardingState: memory account ${state.memoryAccount}, delegate ${state.delegate}, allowance ${state.allowance}, purse ${state.purseAddress}`);
      return state;
    };
    console.log(`\n1. Owner row ${ownerId} created from the test owner key, nothing else recorded`);
    await showState();

    for (const [index, { step, digest }] of STEPS.entries()) {
      console.log(`\n${index + 2}. Confirm ${step} with transaction ${digest}`);
      const { recorded } = await confirmOnboardingTx({ db, ownerId, step, digest, chain, masterSecretHex, now: new Date() });
      const matches = recorded === expected[step];
      console.log(`  recorded ${recorded}${matches ? '' : `, EXPECTED ${expected[step]}`}`);
      if (!matches) problems.push(`${step} recorded ${recorded}, not ${expected[step]}`);
      await showState();
    }
    const [row] = await db.select().from(owners);
    console.log(`  owner row: memwal_account_id ${row?.memwalAccountId}, allowance_id ${row?.allowanceId}`);
    console.log(`  delegate_registered_at ${row?.delegateRegisteredAt?.toISOString()}, allowance_checked_at ${row?.allowanceCheckedAt?.toISOString()}`);
    const finalState = await onboardingState({ db, ownerId });
    if (finalState.memoryAccount !== 'present' || finalState.delegate !== 'present' || finalState.allowance !== 'present') {
      problems.push('onboardingState is not present for every step');
    }

    const { dailyLimitAtomic, lifetimeCapAtomic, days } = NEW_ALLOWANCE;
    console.log(`\n5. Build, not sign, a new allowance: ${formatUsdc(dailyLimitAtomic)} USDC a day, ${formatUsdc(lifetimeCapAtomic)} USDC total, ${days} days`);
    const built = await buildOnboardingTx({ db, ownerId, step: 'allowance', allowance: NEW_ALLOWANCE, chain, masterSecretHex, now: new Date() });
    const bytes = fromBase64(built.txBytesBase64);
    console.log(`  unsigned transaction, ${bytes.length} bytes. What the owner would sign:`);
    for (const line of built.summary) console.log(`    ${line.label}: ${line.value}`);

    console.log('  Dry run through Tatum:');
    const simulation = await chain.simulate(bytes);
    console.log(`    status ${simulation.status}${simulation.errorCode === null ? '' : `, error ${simulation.errorCode}`}`);
    for (const change of simulation.balanceChanges) {
      const amount = change.coinType === SUI_TYPE ? `${formatSui(change.amount)} SUI` : change.coinType === USDC_TYPE_MAINNET ? `${change.amount} atomic USDC` : `${change.amount} of ${change.coinType}`;
      console.log(`    ${change.address === ownerAddress ? 'owner' : change.address}: ${amount}`);
    }
    if (simulation.status !== 'success') problems.push(`the allowance dry run did not succeed (${simulation.errorCode})`);
  } finally {
    await handle.close();
    chain.close();
  }

  if (problems.length > 0) {
    console.log(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROVEN: the account, the delegate key and the allowance were each recorded only after Ellai read them from Sui Mainnet itself, and a new allowance was built for the owner to sign and would succeed.');
  }
}

// Ellai's own work, as the tick is, so it runs in the jobs scope like the tick.
withTatumScope({ kind: 'jobs' }, main).catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
