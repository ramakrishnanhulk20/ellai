// Proves the jobs tick live on Sui Mainnet for the test owner in the PGlite file database at
// scratchpad/loop-db: one tick sends and confirms pending memories, settles pending payments by
// Ellai's own digests, expires stale decisions and, if the purse is below its threshold, pulls one
// 0.10 USDC refill through the owner's allowance with the gas wallet paying the gas. A second
// tick right after must not refill again. Run from packages/web with `npx tsx scripts/prove-jobs.ts`;
// it reads the root .env itself. At most one refill (0.10 USDC) can leave the owner in a run.
// Prints counts, fixed error codes, digests, addresses and links, never a key or a signature.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AllowanceError } from '@ellai/core/allowance';
import { type Chain, ChainError, createChain } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { MemoryError } from '@ellai/core/memory';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { LIVE_DECISION_STATUSES, decisions, memories, owners, payments, refills } from '../src/server/db/schema.js';
import { formatUsdc } from '../src/server/decide/sentences.js';
import { type JobsTickSummary, runJobsTick } from '../src/server/jobs/tick.js';
import { MemoryServiceError } from '../src/server/memory/delegate.js';

const ROOT_ENV = fileURLToPath(new URL('../../../.env', import.meta.url));
const DB_DIR = fileURLToPath(new URL('../../../scratchpad/loop-db', import.meta.url));
// Issued by the test owner to its derived purse in WO-3b and read back from chain there.
const TEST_ALLOWANCE_ID = '0xd2b941082590b7d9d0a04482109670f94c290714889b67e8ef2c60ec6d9699c8';
// The Tatum key answers about 3 requests a second; one request every 400 ms stays under it.
const TATUM_GAP_MS = 400;
const SUISCAN_TX = 'https://suiscan.xyz/mainnet/tx/';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const usdc = (atomic: bigint) => `${formatUsdc(atomic)} USDC`;

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

const suiKey = z.preprocess(blankIsMissing, z.string().startsWith('suiprivkey').refine(isEd25519SuiKey));
const configSchema = z.object({
  ELLAI_MASTER_SECRET: z.preprocess(blankIsMissing, z.string().regex(/^[0-9a-f]{64}$/i)),
  OWNER_TEST_PRIVATE_KEY: suiKey,
  GAS_PRIVATE_KEY: suiKey,
  TATUM_API_KEY: z.preprocess(blankIsMissing, z.string().optional()),
});

/** The four variables this proof reads. The message names bad variables and never a value. */
function loadConfig(env: Record<string, string | undefined>): z.infer<typeof configSchema> {
  const names = Object.keys(configSchema.shape);
  const result = configSchema.safeParse(Object.fromEntries(names.map((name) => [name, env[name]])));
  if (result.success) return result.data;
  const bad = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  throw new ProofError(`root .env is missing or has malformed: ${bad.join(', ')}`);
}

function failureLabel(error: unknown): string {
  if (error instanceof MemoryError || error instanceof MemoryServiceError || error instanceof AllowanceError) return `${error.code}: ${error.message}`;
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof ProofError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

/** The same chain, with every call started at least TATUM_GAP_MS after the one before. */
function paced(chain: Chain): Chain {
  let nextAt = 0;
  const wait = async () => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + TATUM_GAP_MS;
    if (at > now) await sleep(at - now);
  };
  const gate =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await wait();
      return run(...args);
    };
  return {
    ...chain,
    getReferenceGasPrice: gate(chain.getReferenceGasPrice),
    getBalances: gate(chain.getBalances),
    getTransactionBalanceChanges: gate(chain.getTransactionBalanceChanges),
    getTransactionResult: gate(chain.getTransactionResult),
    getCurrentEpoch: gate(chain.getCurrentEpoch),
    simulate: gate(chain.simulate),
    listOwnedWalrusBlobs: gate(chain.listOwnedWalrusBlobs),
    executeTransaction: gate(chain.executeTransaction),
    getAllowance: gate(chain.getAllowance),
  };
}

async function testOwner(db: Database, ownerAddress: string, purseAddress: string): Promise<string> {
  const [owner] = await db.select().from(owners).where(eq(owners.suiAddress, ownerAddress));
  if (owner === undefined || owner.purseAddress !== purseAddress) {
    throw new ProofError('the test owner is not in scratchpad/loop-db with its derived purse; run npm run prove:loop first. Nothing was sent.');
  }
  console.log(`  Owner ${owner.id}, purse ${owner.purseAddress} (derived)`);
  if (owner.allowanceId === null) {
    await db.update(owners).set({ allowanceId: TEST_ALLOWANCE_ID }).where(eq(owners.id, owner.id));
    console.log(`  Allowance id was missing; set to ${TEST_ALLOWANCE_ID}`);
  } else {
    console.log(`  Allowance ${owner.allowanceId}${owner.allowanceId === TEST_ALLOWANCE_ID ? '' : ' (not the WO-3b allowance, kept as it is)'}`);
  }
  return owner.id;
}

async function printWork(db: Database, ownerId: string): Promise<void> {
  const [pendingMemories] = await db.select({ n: count() }).from(memories).where(and(eq(memories.ownerId, ownerId), eq(memories.status, 'pending')));
  const [pendingPayments] = await db.select({ n: count() }).from(payments).where(and(eq(payments.ownerId, ownerId), eq(payments.settlement, 'pending')));
  const [liveDecisions] = await db
    .select({ n: count() })
    .from(decisions)
    .where(and(eq(decisions.ownerId, ownerId), inArray(decisions.status, LIVE_DECISION_STATUSES)));
  console.log(`  Waiting: ${pendingMemories?.n ?? 0} memories, ${pendingPayments?.n ?? 0} payments, ${liveDecisions?.n ?? 0} open or asked decisions`);
}

function printSummary(summary: JobsTickSummary): void {
  console.log(`  owners handled ${summary.owners}`);
  console.log(`  memories: ${summary.memoriesSubmitted} submitted, ${summary.memoriesConfirmed} confirmed, ${summary.memoriesFailed} failed`);
  console.log(`  payments: ${summary.paymentsVerified} verified, ${summary.paymentsNotLanded} released as never landed, ${summary.paymentsMismatched} mismatched`);
  console.log(`  outcome memories recorded ${summary.outcomesRecorded}`);
  console.log(`  decisions expired ${summary.decisionsExpired}, questions closed ${summary.questionsClosed}`);
  console.log(`  refills sent ${summary.refills}`);
  console.log(`  gas wallet low: ${summary.gasWalletLow ? 'YES' : 'no'}`);
  if (summary.errors.length === 0) console.log('  step errors: none');
  for (const error of summary.errors) console.log(`  step error: owner ${error.ownerId || 'none (gas wallet)'}, step ${error.step}, code ${error.code}`);
}

async function refillRows(db: Database, ownerId: string) {
  return db.select().from(refills).where(eq(refills.ownerId, ownerId)).orderBy(asc(refills.sentAt), asc(refills.id));
}

async function main(): Promise<void> {
  if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const masterSecretHex = config.ELLAI_MASTER_SECRET;
  const ownerAddress = canonicalSuiAddress(Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress());
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(masterSecretHex, ownerAddress).toSuiAddress());
  const gasKeypair = Ed25519Keypair.fromSecretKey(config.GAS_PRIVATE_KEY);

  console.log('Ellai jobs tick on Sui Mainnet. At most one 0.10 USDC refill can leave the test owner.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}, one request every ${TATUM_GAP_MS} ms at most`);
  console.log(`Test owner ${ownerAddress}, gas wallet ${canonicalSuiAddress(gasKeypair.toSuiAddress())}, database scratchpad/loop-db`);

  const handle = await createDb(`pglite:${DB_DIR}`);
  const raw = createChain({ apiKey: config.TATUM_API_KEY });
  const chain = paced(raw);
  const problems: string[] = [];
  try {
    const { db } = handle;
    await migrate(db);
    console.log('\n0. Test owner');
    const ownerId = await testOwner(db, ownerAddress, purseAddress);
    await printWork(db, ownerId);
    const before = await refillRows(db, ownerId);
    const purseBefore = (await chain.getBalances(purseAddress)).usdcAddressBalance;
    console.log(`  Purse USDC before: ${usdc(purseBefore)}; refills on record: ${before.length}`);

    const tick = () => runJobsTick({ db, chain, masterSecretHex, gasKeypair, now: () => new Date(), sleep });
    console.log('\n1. First tick');
    const first = await tick();
    printSummary(first);
    console.log('\n2. Second tick, right after');
    const second = await tick();
    printSummary(second);

    console.log('\n3. Refills and the purse');
    const after = await refillRows(db, ownerId);
    const sentNow = after.filter((row) => !before.some((earlier) => earlier.id === row.id));
    for (const row of after) {
      const label = sentNow.includes(row) ? 'sent in this run' : 'from an earlier run';
      console.log(`  refill ${usdc(row.amountAtomic)}, ${row.status}, ${label}: ${row.digest}`);
      console.log(`    ${SUISCAN_TX}${row.digest}`);
    }
    const purseAfter = (await chain.getBalances(purseAddress)).usdcAddressBalance;
    console.log(`  Purse USDC after: ${usdc(purseAfter)}, read from chain`);
    await printWork(db, ownerId);

    if (second.refills !== 0) problems.push(`the second tick sent ${second.refills} refills`);
    if (sentNow.length > 1) problems.push(`${sentNow.length} refills were sent in one run`);
  } finally {
    await handle.close();
    raw.close();
  }

  if (problems.length > 0) {
    console.log(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROVEN: two ticks ran against live data and the second sent no second refill. Any step errors are listed above by code.');
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
