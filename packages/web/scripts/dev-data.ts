// Readies scratchpad/dev-db, a copy of the live proofs' scratchpad/loop-db, as the database behind
// /lab on the dev server, so the memory map draws the test owner's real mainnet rows. It opts the
// test owner into the public proof through the real step-up path (Ram's call of 2026-10-25), then
// runs one jobs tick against Sui Mainnet so the blob scan marks the memories it finds on chain, and
// prints what readMemoryMap returns. It never opens loop-db. Run from packages/web:
//   npx tsx --env-file-if-exists=../../.env scripts/dev-data.ts
// Live calls are the tick's own (Tatum reads, the Walrus Memory relayer, and a refill only if the
// purse is below its threshold); the step-up signature is an Ed25519 one, checked offline.
// Prints counts, fixed codes and digests, never a key, a signature or a memory sentence.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AllowanceError } from '@ellai/core/allowance';
import { type BeforeTatumRequest, ChainError, createChain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { MemoryError } from '@ellai/core/memory';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { asc, count, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { OWNER_AUTO_PAUSE, OWNER_SETTINGS, autoPauseOf, claimStepUp, issueStepUp, sameAutoPause, settingsBoundsProblem, settingsLoosen, settingsPatch, stepUpRequest } from '../src/server/auth/stepup.js';
import { SignInError } from '../src/server/auth/signin.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { decisionCitations, decisions, memories, owners, payments, refills } from '../src/server/db/schema.js';
import { formatUsdc } from '../src/server/decide/sentences.js';
import { HttpError } from '../src/server/http/errors.js';
import { tatumMeter, withTatumScope } from '../src/server/http/tatum-meter.js';
import { type JobsTickSummary, runJobsTick } from '../src/server/jobs/tick.js';
import { MemoryServiceError } from '../src/server/memory/delegate.js';
import { readMemoryMap } from '../src/server/public/proof.js';

const DB_DIR = fileURLToPath(new URL('../../../scratchpad/dev-db', import.meta.url));
// The origin Ram's dev server serves /lab from; the step-up message names its host.
const DEV_ORIGIN = 'http://localhost:3000';
// The Tatum key answers about 3 requests a second; one request every 400 ms stays under it.
const TATUM_GAP_MS = 400;
const SUISCAN_TX = 'https://suiscan.xyz/mainnet/tx/';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A refusal written by this script. Its message is fixed text only. */
class DevDataError extends Error {}

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
  TATUM_API_KEY: z.preprocess(blankIsMissing, z.string().min(1)),
});

/** The four variables this script reads. The message names bad variables and never a value. */
function loadConfig(env: Record<string, string | undefined>): z.infer<typeof configSchema> {
  const names = Object.keys(configSchema.shape);
  const result = configSchema.safeParse(Object.fromEntries(names.map((name) => [name, env[name]])));
  if (result.success) return result.data;
  const bad = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  throw new DevDataError(`root .env is missing or has malformed: ${bad.join(', ')}`);
}

function failureLabel(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status} ${error.code}`;
  if (error instanceof SignInError) return `SIGN_IN ${error.code}`;
  if (error instanceof MemoryError || error instanceof MemoryServiceError || error instanceof AllowanceError) return `${error.code}: ${error.message}`;
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof DevDataError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

/** The meter, with every request to Tatum, retries and SDK calls included, started at least TATUM_GAP_MS after the one before. */
function paced(meter: BeforeTatumRequest): BeforeTatumRequest {
  let nextAt = 0;
  return async (call) => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + TATUM_GAP_MS;
    if (at > now) await sleep(at - now);
    return meter(call);
  };
}

async function printCounts(db: Database, label: string): Promise<void> {
  const [ownerCount] = await db.select({ n: count() }).from(owners);
  const [shownOwners] = await db.select({ n: count() }).from(owners).where(eq(owners.publicProof, true));
  const byStatus = await db.select({ status: memories.status, n: count() }).from(memories).groupBy(memories.status).orderBy(asc(memories.status));
  const [onChain] = await db.select({ n: count() }).from(memories).where(isNotNull(memories.chainConfirmedAt));
  const byOutcome = await db.select({ outcome: decisions.outcome, n: count() }).from(decisions).groupBy(decisions.outcome).orderBy(asc(decisions.outcome));
  const [citationCount] = await db.select({ n: count() }).from(decisionCitations);
  const [verified] = await db.select({ n: count() }).from(payments).where(eq(payments.settlement, 'verified'));
  const list = (rows: Array<{ n: number } & Record<string, unknown>>, key: string) => rows.map((row) => `${String(row[key])} ${row.n}`).join(', ') || 'none';
  console.log(`\n${label}`);
  console.log(`  owners ${ownerCount?.n ?? 0} (public proof on: ${shownOwners?.n ?? 0})`);
  console.log(`  memories by status: ${list(byStatus, 'status')}`);
  console.log(`  memories found on chain (chain_confirmed_at set): ${onChain?.n ?? 0}`);
  console.log(`  decisions by outcome: ${list(byOutcome, 'outcome')}`);
  console.log(`  decision citations: ${citationCount?.n ?? 0}`);
  console.log(`  verified payments: ${verified?.n ?? 0}`);
}

/**
 * Turns the public proof on for the test owner as the app does: a step-up issued for exactly
 * { publicProof: true }, signed by the owner's wallet as a Sui personal message, spent by
 * claimStepUp, then the update PATCH /api/owner/settings makes, mirrored line for line under the
 * owner row lock. Both bodies go through the routes' own parsers. Does nothing when it is on.
 */
async function optIn(db: Database, ownerId: string, ownerKeypair: Ed25519Keypair, zkLoginClient: Parameters<typeof claimStepUp>[0]['zkLoginClient']): Promise<void> {
  const [row] = await db.select({ publicProof: owners.publicProof }).from(owners).where(eq(owners.id, ownerId));
  if (row?.publicProof === true) {
    console.log('  Public proof is already on; nothing to sign.');
    return;
  }
  const asked = stepUpRequest.parse({ action: 'loosen_settings', change: { publicProof: true } });
  const issued = await issueStepUp({ db, ownerId, appOrigin: DEV_ORIGIN, request: asked, now: new Date() });
  const changeLine = issued.message.split('\n').find((line) => line.startsWith('Public proof page:')) ?? 'no change line';
  console.log(`  Step-up issued, expires ${issued.expiresAt.toISOString()}; the message the wallet signs reads "${changeLine}"`);
  const { signature } = await ownerKeypair.signPersonalMessage(new TextEncoder().encode(issued.message));

  const { stepUp, ...change } = settingsPatch.parse({ publicProof: true, stepUp: { nonce: issued.nonce, signature } });
  let signedPause: ReturnType<typeof autoPauseOf> | undefined;
  if (stepUp !== undefined) {
    signedPause = await claimStepUp({ db, ownerId, request: { action: 'loosen_settings', change }, proof: stepUp, zkLoginClient, now: new Date() });
  }
  console.log('  Step-up claimed: the signature recovered to the test owner and the nonce is now spent.');
  const clearing = change.clearAutoPause === true;

  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ ...OWNER_SETTINGS, ...OWNER_AUTO_PAUSE })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .for('update');
    if (current === undefined) throw new HttpError(401, 'signed_out');
    const problem = settingsBoundsProblem(current, change);
    if (problem !== null) return { problem };
    if (stepUp === undefined && settingsLoosen(current, change)) throw new HttpError(403, 'step_up_required');
    if (clearing && signedPause !== undefined && !sameAutoPause(signedPause, autoPauseOf(current))) throw new HttpError(409, 'pause_changed');
    const [updated] = await tx
      .update(owners)
      .set({
        paused: change.paused,
        perPaymentMaxAtomic: change.perPaymentMaxAtomic,
        dailyBudgetAtomic: change.dailyBudgetAtomic,
        approvalsNeeded: change.approvalsNeeded,
        distanceCutoff: change.distanceCutoff === undefined ? undefined : Math.fround(change.distanceCutoff),
        autoPausedReason: clearing ? null : undefined,
        autoPausedAt: clearing ? null : undefined,
        publicProof: change.publicProof,
      })
      .where(eq(owners.id, ownerId))
      .returning(OWNER_SETTINGS);
    if (updated === undefined) throw new Error('the settings update returned no row');
    return { settings: updated };
  });
  if (outcome.problem !== undefined) throw new HttpError(400, 'out_of_bounds', outcome.problem);
  console.log(`  Settings applied under the owner lock: public proof ${outcome.settings.publicProof ? 'on' : 'off'}.`);
}

function printSummary(summary: JobsTickSummary, testOwnerId: string): void {
  console.log(`  owners visited ${summary.owners}, rows pruned ${summary.rowsPruned}, time budget reached: ${summary.timeBudgetReached ? 'YES' : 'no'}`);
  console.log(`  memories: ${summary.memoriesSubmitted} submitted, ${summary.memoriesConfirmed} confirmed, ${summary.memoriesFailed} failed`);
  console.log(`  memories found on chain ${summary.memoriesChainConfirmed}, seen expired on chain ${summary.memoriesChainExpired}`);
  console.log(`  payments: ${summary.paymentsVerified} verified, ${summary.paymentsNotLanded} released as never landed, ${summary.paymentsMismatched} mismatched`);
  console.log(`  outcome memories recorded ${summary.outcomesRecorded}`);
  console.log(`  decisions expired ${summary.decisionsExpired}, questions closed ${summary.questionsClosed}`);
  console.log(`  refills sent ${summary.refills}`);
  console.log(`  gas wallet low: ${summary.gasWalletLow === null ? 'not read this tick' : summary.gasWalletLow ? 'YES' : 'no'}`);
  if (summary.errors.length === 0) console.log('  step errors: none');
  for (const error of summary.errors) {
    const who = error.ownerId === '' ? 'no owner' : error.ownerId === testOwnerId ? 'test owner' : 'another owner';
    console.log(`  step error: ${who}, step ${error.step}, code ${error.code}`);
  }
}

async function refillRows(db: Database, ownerId: string) {
  return db.select().from(refills).where(eq(refills.ownerId, ownerId)).orderBy(asc(refills.sentAt), asc(refills.id));
}

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  // Without this check PGlite would quietly make an empty database at the path.
  if (!existsSync(DB_DIR)) throw new DevDataError('scratchpad/dev-db is missing: copy scratchpad/loop-db to it first. Nothing was opened.');
  const ownerKeypair = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY);
  const ownerAddress = canonicalSuiAddress(ownerKeypair.toSuiAddress());
  const gasKeypair = Ed25519Keypair.fromSecretKey(config.GAS_PRIVATE_KEY);

  console.log('Ellai dev data: scratchpad/dev-db for /lab, from the live proofs on Sui Mainnet.');
  console.log(`Test owner ${ownerAddress.slice(0, 10)}...${ownerAddress.slice(-3)}; Tatum requests metered in the jobs scope, one every ${TATUM_GAP_MS} ms at most`);

  const handle = await createDb(`pglite:${DB_DIR}`);
  const chain = createChain({ apiKey: config.TATUM_API_KEY, beforeRequest: paced(tatumMeter(handle.db, () => new Date())) });
  let mapHasData = false;
  try {
    const { db } = handle;
    await migrate(db);
    await printCounts(db, '1. Before');

    const [owner] = await db.select({ id: owners.id }).from(owners).where(eq(owners.suiAddress, ownerAddress));
    if (owner === undefined) throw new DevDataError('the test owner is not in scratchpad/dev-db; it must be a copy of the live proofs database');

    console.log('\n2. Public proof for the test owner, through the step-up');
    await optIn(db, owner.id, ownerKeypair, chain.grpc);

    console.log('\n3. One jobs tick against Sui Mainnet');
    const refillsBefore = await refillRows(db, owner.id);
    const summary = await runJobsTick({ db, chain, masterSecretHex: config.ELLAI_MASTER_SECRET, gasKeypair, now: () => new Date(), sleep });
    printSummary(summary, owner.id);
    const sentNow = (await refillRows(db, owner.id)).filter((row) => !refillsBefore.some((earlier) => earlier.id === row.id));
    for (const row of sentNow) console.log(`  refill sent by this tick: ${formatUsdc(row.amountAtomic)} USDC, ${row.status}, ${SUISCAN_TX}${row.digest}`);

    await printCounts(db, '4. After');

    console.log('\n5. readMemoryMap on dev-db, exactly as returned');
    const map = await readMemoryMap(db, new Date());
    console.log(JSON.stringify(map, null, 2));
    mapHasData = map.memories.length > 0 && map.decisions.length > 0;
  } finally {
    await handle.close();
    chain.close();
  }

  if (!mapHasData) {
    console.log('\nNOT READY: the memory map needs at least one memory and one decision.');
    process.exitCode = 1;
  } else {
    console.log('\nREADY: the memory map holds real memories and decisions from the live proofs.');
  }
}

withTatumScope({ kind: 'jobs' }, main).catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
