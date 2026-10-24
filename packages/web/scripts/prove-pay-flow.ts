// Proves Ellai's pay flow live on Sui Mainnet for the test owner. An agent asks for a JMPR
// hotel search; Ellai fetches the seller's price itself, approves it on its own from the
// owner's two earlier approvals (B3b), checks the daily budget at the moment of signing, pays
// 0.01 USDC from the owner's purse with a gasless send, hands back the seller's answer and
// verifies the payment on chain by the digest it computed. If the seller took the money and
// returned nothing, that outcome goes to the owner's Walrus Memory and the next request to the
// same seller is asked instead of paid. Reuses the PGlite file database at scratchpad/loop-db.
// At most 0.02 USDC can leave the purse in this order: one paid call, and one more only after
// the first provably never landed. Prints ids, digests and links, never a key, a signature or
// a payment header.
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type Chain, ChainError, createChain } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { NetError, safeFetch } from '@ellai/core/net';
import { KNOWN_SELLERS } from '@ellai/core/sellers';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, memories, owners, payments } from '../src/server/db/schema.js';
import { DecideError } from '../src/server/decide/decide.js';
import { formatUsdc } from '../src/server/decide/sentences.js';
import { MemoryServiceError, ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { recordOutcome } from '../src/server/memory/outcome.js';
import { makeRecall } from '../src/server/memory/recall.js';
import { confirmMemoryJobs, submitPendingMemories } from '../src/server/memory/writer.js';
import { paidFetch } from '../src/server/pay/flow.js';
import type { PaidFetchResult } from '../src/server/pay/result.js';
import { settlePayment } from '../src/server/pay/settle.js';

const DB_DIR = fileURLToPath(new URL('../../../scratchpad/loop-db', import.meta.url));
// Created for the test owner in WO-3a, with Ellai's derived delegate key already on it.
const ACCOUNT_ID = '0x98a4e7a42754de51dd86bf5b8a06e6caaa2e4dcc8bc08f630952ce291ee91121';
const SELLER_URL = 'https://suimpp.jmpr.world/v1/hotels/search-flexible';
const DAILY_BUDGET_ATOMIC = 50_000n;
const ORDER_CAP_ATOMIC = 20_000n;
const MAX_SIGNED_PAYMENTS = 2;
const EXCERPT_CHARS = 300;
// Longer than any word in a hotel listing, shorter than a signature (132) or a payment header.
const LONG_TOKEN = /[A-Za-z0-9+/=_-]{80,}/g;
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const CONFIRM_TRIES = 40;
const CONFIRM_DELAY_MS = 5_000;
const SUISCAN_TX = 'https://suiscan.xyz/mainnet/tx/';

// The seller's documented request schema (llms.txt: POST {request, adults, rooms}), worded for
// each purpose; the same wording B3b used, so the bodies hash as B3b's requests did.
const LISBON = {
  purpose: 'search hotels in Lisbon for 20 November under 120 euros',
  body: JSON.stringify({ request: 'One night in Lisbon on 20 November, under 120 euros', adults: 1, rooms: 1 }),
};
const PORTO = {
  purpose: 'search hotels in Porto for 22 November under 100 euros',
  body: JSON.stringify({ request: 'One night in Porto on 22 November, under 100 euros', adults: 1, rooms: 1 }),
};

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
  if (error instanceof MemoryError || error instanceof MemoryServiceError || error instanceof DecideError || error instanceof NetError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof ProofError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

/** The seller's words as inert text: control characters blanked, any long token removed, cut short. */
function plainExcerpt(text: string): string {
  return Array.from(text).slice(0, EXCERPT_CHARS).join('').replace(UNSAFE_CHARACTERS, ' ').replace(LONG_TOKEN, '[long token removed]');
}

async function ensureOwnerAndAgent(db: Database, ownerAddress: string, purseAddress: string): Promise<{ ownerId: string; agentId: string }> {
  const byAddress = eq(owners.suiAddress, ownerAddress);
  const [existing] = await db.select().from(owners).where(byAddress);
  if (existing === undefined) {
    await db.insert(owners).values({ suiAddress: ownerAddress, purseAddress, memwalAccountId: ACCOUNT_ID });
  }
  const [owner] = await db.select().from(owners).where(byAddress);
  if (owner === undefined || owner.purseAddress !== purseAddress || owner.memwalAccountId !== ACCOUNT_ID) {
    throw new ProofError('the owner row in scratchpad/loop-db does not match this owner, purse and account; nothing was sent');
  }
  console.log(`  Owner ${owner.id}: ${existing === undefined ? 'CREATED in this run' : 'already in the database, reused'}`);
  const builtin = and(eq(agents.ownerId, owner.id), eq(agents.kind, 'builtin'));
  const [earlier] = await db.select({ id: agents.id }).from(agents).where(builtin).orderBy(asc(agents.createdAt)).limit(1);
  if (earlier !== undefined) {
    console.log(`  Built-in agent ${earlier.id}: already in the database, reused`);
    return { ownerId: owner.id, agentId: earlier.id };
  }
  // This proof never calls the agent endpoint, so the token is thrown away and only its hash kept.
  const token = randomBytes(LIMITS.bearerTokenBytes).toString('hex');
  const [agent] = await db
    .insert(agents)
    .values({ ownerId: owner.id, label: 'Ellai demo agent', kind: 'builtin', tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'), tokenPrefix: 'ellai_demo' })
    .returning({ id: agents.id });
  if (agent === undefined) throw new ProofError('the agent insert returned no row');
  console.log(`  Built-in agent ${agent.id}: CREATED in this run`);
  return { ownerId: owner.id, agentId: agent.id };
}

type PaymentRow = typeof payments.$inferSelect;

/**
 * The order's money rule, from the payments this owner has in the database: a payment that
 * landed is reused and nothing new is paid; one that can still land stops the run; a new one
 * is allowed only for the first payment, or after every earlier one provably never landed.
 */
async function moneyGate(db: Database, ownerId: string, chain: Chain): Promise<{ pay: true } | { pay: false; landed: PaymentRow }> {
  const rows = await db.select().from(payments).where(eq(payments.ownerId, ownerId)).orderBy(asc(payments.signedAt));
  for (const row of rows.filter((r) => r.settlement === 'pending')) {
    console.log(`  Payment ${row.digest} from an earlier run is pending; reading the chain again`);
    await settlePayment({ db, ownerId, paymentId: row.id, chain, tries: LIMITS.settlementPollTries, intervalMs: LIMITS.settlementPollIntervalMs, sleep });
  }
  const current = await db.select().from(payments).where(eq(payments.ownerId, ownerId)).orderBy(asc(payments.signedAt));
  const landed = current.filter((row) => row.settlement === 'verified' || row.settlement === 'mismatch').at(-1);
  if (landed !== undefined) return { pay: false, landed };
  if (current.some((row) => row.settlement === 'pending')) throw new ProofError('a payment from an earlier run can still land, so nothing new is paid');
  const signed = current.reduce((sum, row) => sum + row.amountAtomic, 0n);
  if (current.length >= MAX_SIGNED_PAYMENTS || signed + BigInt(LIMITS.minPaymentAtomic) > ORDER_CAP_ATOMIC) {
    throw new ProofError(`this order has already signed ${current.length} payments (${usdc(signed)}); nothing new is paid`);
  }
  console.log(`  Payments already signed for this owner: ${current.length}${current.length > 0 ? ', none of them landed and every window has closed' : ''}`);
  return { pay: true };
}

function printResult(result: PaidFetchResult): void {
  console.log(`  outcome: ${result.outcome}, rule: ${result.rule ?? 'none'}, decision ${result.decisionId ?? 'none'}`);
  console.log(`  reason: "${result.reason}"`);
  for (const memory of result.citedMemories) console.log(`  cites memory ${memory.memoryId} (blob ${memory.blobId ?? 'not confirmed yet'})`);
  if (result.seller === null) {
    console.log('  seller answer: none');
  } else {
    console.log(`  seller answered HTTP ${result.seller.status}, ${result.seller.contentType ?? 'no content type'}${result.seller.truncated ? ', cut to the answer cap' : ''}`);
    console.log(`  answer, first ${EXCERPT_CHARS} characters as plain text: ${plainExcerpt(result.seller.body)}`);
  }
  if (result.payment !== null) {
    console.log(`  payment ${usdc(BigInt(result.payment.amountAtomic))} to ${result.payment.recipient}`);
    console.log(`  digest ${result.payment.digest}, settlement: ${result.payment.settlement}`);
    console.log(`  ${SUISCAN_TX}${result.payment.digest}`);
  }
}

async function waitForConfirmation(db: Database, ownerId: string, memoryId: string, masterSecretHex: string): Promise<string | null> {
  for (let attempt = 1; attempt <= CONFIRM_TRIES; attempt++) {
    const [row] = await db.select({ status: memories.status, blobId: memories.blobId }).from(memories).where(and(eq(memories.ownerId, ownerId), eq(memories.id, memoryId)));
    if (row?.status === 'confirmed') return row.blobId;
    if (row?.status === 'failed') throw new ProofError('the relayer reported the outcome memory as failed');
    if (attempt > 1) await sleep(CONFIRM_DELAY_MS);
    try {
      const pass = await confirmMemoryJobs({ db, ownerId, masterSecretHex, now: new Date() });
      console.log(`  check ${attempt}: ${pass.confirmed} confirmed, ${pass.pending} still working, ${pass.failed} failed`);
    } catch (error) {
      if (!(error instanceof MemoryError && ['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM'].includes(error.code))) throw error;
      console.log(`  check ${attempt}: ${failureLabel(error)}`);
    }
  }
  return null;
}

async function purseUsdc(chain: Chain, purse: string): Promise<bigint> {
  return (await chain.getBalances(purse)).usdcAddressBalance;
}

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const masterSecretHex = config.ELLAI_MASTER_SECRET;
  const ownerAddress = canonicalSuiAddress(Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress());
  const purse = canonicalSuiAddress(derivePurseKeypair(masterSecretHex, ownerAddress).toSuiAddress());
  const seller = KNOWN_SELLERS.find((known) => known.url === SELLER_URL);
  if (seller === undefined || seller.method !== 'POST') throw new ProofError('JMPR hotel search is not in KNOWN_SELLERS as a POST route');

  console.log('Ellai pay flow on Sui Mainnet. Real USDC, at most 0.02 in this order.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
  console.log(`Test owner ${ownerAddress}, purse ${purse} (derived), database scratchpad/loop-db`);

  const handle = await createDb(`pglite:${DB_DIR}`);
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const problems: string[] = [];
  let learnedFromBadOutcome = false;
  try {
    const { db } = handle;
    await migrate(db);
    console.log('\n0. Owner, agent and limits');
    const { ownerId, agentId } = await ensureOwnerAndAgent(db, ownerAddress, purse);
    await db.update(owners).set({ dailyBudgetAtomic: DAILY_BUDGET_ATOMIC }).where(eq(owners.id, ownerId));
    const [settings] = await db.select().from(owners).where(eq(owners.id, ownerId));
    if (settings === undefined) throw new ProofError('the owner row disappeared');
    console.log(`  Daily budget ${usdc(settings.dailyBudgetAtomic)}, per payment ${usdc(settings.perPaymentMaxAtomic)}, ${settings.approvalsNeeded} approvals needed, distance cutoff ${settings.distanceCutoff}`);
    console.log(`  Automatic payments ${settings.paused || settings.autoPausedReason !== null ? 'PAUSED' : 'on'}`);
    const before = await purseUsdc(chain, purse);
    console.log(`  Purse USDC before: ${usdc(before)}`);

    const deps = {
      fetch: safeFetch,
      chain,
      recallFor: (owner: { suiAddress: string; memwalAccountId: string | null }) => makeRecall({ owner, masterSecretHex, namespace: MEMORY_NAMESPACE }),
      now: () => new Date(),
      sleep,
    };
    const ask = (request: typeof LISBON, chainFor: Chain) =>
      paidFetch({
        db,
        ownerId,
        agentId,
        url: seller.url,
        method: seller.method,
        body: request.body,
        contentType: seller.contentType ?? null,
        purpose: request.purpose,
        secrets: { masterSecretHex },
        deps: { ...deps, chain: chainFor },
      });

    console.log(`\n1. The agent asks: POST ${seller.url} for "${LISBON.purpose}"`);
    const gate = await moneyGate(db, ownerId, chain);
    let paidRow: PaymentRow;
    if (gate.pay) {
      const first = await ask(LISBON, chain);
      printResult(first);
      if (first.outcome !== 'paid' || first.rule !== 'learned') problems.push(`step 1 was ${first.outcome} (${first.rule}), not paid on a learned approval`);
      const [row] =
        first.decisionId === null ? [] : await db.select().from(payments).where(and(eq(payments.ownerId, ownerId), eq(payments.decisionId, first.decisionId)));
      if (row === undefined) throw new ProofError(`nothing was paid in step 1${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`);
      paidRow = row;
    } else {
      paidRow = gate.landed;
      console.log(`  Already paid in an earlier run, nothing sent: ${paidRow.digest}, settlement ${paidRow.settlement}, seller HTTP ${paidRow.sellerStatus ?? 'no answer'}`);
      console.log(`  ${SUISCAN_TX}${paidRow.digest}`);
    }

    console.log('\n2. If the seller took the money and returned nothing, the next request to it is asked');
    if (paidRow.settlement === 'pending') {
      console.log('  Settlement job: the inline reads did not find the payment yet; reading again');
      const settled = await settlePayment({ db, ownerId, paymentId: paidRow.id, chain, tries: LIMITS.settlementPollTries, intervalMs: LIMITS.settlementPollIntervalMs, sleep });
      console.log(`  settlement: ${settled}`);
    }
    const [latest] = await db.select().from(payments).where(eq(payments.id, paidRow.id));
    if (latest === undefined) throw new ProofError('the payment row disappeared');
    if (latest.settlement !== 'verified') {
      problems.push(`the payment's settlement is ${latest.settlement}, not verified`);
      console.log(`  Not run: settlement is ${latest.settlement}`);
    } else if (latest.delivered === true) {
      console.log(`  Not run: the seller answered HTTP ${latest.sellerStatus}, so there is no bad outcome to learn from`);
    } else {
      const { publicKeyHex } = ownerDelegate(masterSecretHex, ownerAddress);
      const outcome = await recordOutcome({ db, ownerId, decisionId: latest.decisionId, delivered: false, delegatePublicKeyHex: publicKeyHex, now: new Date() });
      console.log(`  Outcome memory ${outcome.memoryId} for decision ${latest.decisionId}`);
      const sent = await submitPendingMemories({ db, ownerId, masterSecretHex, now: new Date() });
      console.log(`  Outcome job: ${sent.submitted} memories sent to Walrus Memory in one bulk write`);
      const blobId = await waitForConfirmation(db, ownerId, outcome.memoryId, masterSecretHex);
      console.log(`  Outcome memory ${blobId === null ? `not confirmed within ${CONFIRM_TRIES} checks` : `confirmed as blob ${blobId}`}`);

      // This chain cannot read the epoch, which signing needs first, so even a wrong approval
      // here could not sign: the order's money cap holds whatever decide answers.
      const cannotSign: Chain = {
        ...chain,
        getCurrentEpoch: async () => {
          throw new ChainError('UNAUTHORIZED', 'this proof step never signs');
        },
      };
      console.log(`  The agent asks the same seller again: "${PORTO.purpose}"`);
      const second = await ask(PORTO, cannotSign);
      printResult(second);
      const citesOutcome = second.citedMemories.some((memory) => memory.memoryId === outcome.memoryId);
      if (second.outcome !== 'asked' || second.rule !== 'bad_outcome' || !citesOutcome) {
        problems.push(`step 2 was ${second.outcome} (${second.rule}), ${citesOutcome ? 'citing' : 'not citing'} the outcome memory; expected asked by bad_outcome`);
      } else {
        learnedFromBadOutcome = true;
      }
    }

    console.log('\n3. The purse');
    const after = await purseUsdc(chain, purse);
    const all = await db.select().from(payments).where(eq(payments.ownerId, ownerId));
    const landedTotal = all.filter((row) => row.settlement === 'verified').reduce((sum, row) => sum + row.amountAtomic, 0n);
    const left = before >= after ? usdc(before - after) : `minus ${usdc(after - before)}`;
    console.log(`  Purse USDC before ${usdc(before)}, after ${usdc(after)}: ${left} left as read from chain`);
    console.log(`  Realised: ${usdc(landedTotal)} in payments verified on chain; ${all.length} payments signed for this owner in total`);
    if (before - after > ORDER_CAP_ATOMIC || landedTotal > ORDER_CAP_ATOMIC) problems.push('more than 0.02 USDC left the purse');
  } finally {
    await handle.close();
    chain.close();
  }

  if (problems.length > 0) {
    console.log(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    const lesson = learnedFromBadOutcome
      ? ', and then asked instead of paying a seller that took money and returned nothing'
      : '; the seller answered, so there was no bad outcome to learn from';
    console.log(
      `\nPROVEN: Ellai fetched the price itself, approved it from the owner's own past answers, signed within the daily budget, paid from the owner's purse and verified the payment on chain by its own digest${lesson}.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
