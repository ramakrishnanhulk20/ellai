// Proves Ellai's learning loop live on Sui Mainnet for the test owner. Two owner approvals
// leave the database as Walrus Memory writes in the owner's own account, signed by Ellai's
// derived delegate; they come back as confirmed blobs and are found again by meaning; a third
// similar request is then approved on its own, citing both, while the same request to another
// recipient is still asked (C2). Every step is recorded in a PGlite file database at
// scratchpad/loop-db, so a second run reuses it and writes no new memory. Moves no USDC, and
// memory writes are free on the hosted relayer. Prints ids, distances and links, never a
// secret key, a signature or relayer error text.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type Chain, ChainError, createChain, type WalrusBlob } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisions, memories, owners, questions } from '../src/server/db/schema.js';
import { AnswerError, answerQuestion } from '../src/server/decide/answer.js';
import { DecideError, type DecideResult, type Recall, decide } from '../src/server/decide/decide.js';
import { querySentence, requestKey } from '../src/server/decide/sentences.js';
import { MemoryServiceError, ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { makeRecall } from '../src/server/memory/recall.js';
import { confirmMemoryJobs, submitPendingMemories } from '../src/server/memory/writer.js';

const DB_DIR = fileURLToPath(new URL('../../../scratchpad/loop-db', import.meta.url));
// Created for the test owner in WO-3a, with Ellai's derived delegate key already on it.
const ACCOUNT_ID = '0x98a4e7a42754de51dd86bf5b8a06e6caaa2e4dcc8bc08f630952ce291ee91121';
// JMPR's hotel search, paid and verified on chain in WO-3c (scratchpad/slice-state-pay.json).
const SELLER_URL = 'https://suimpp.jmpr.world/v1/hotels/search-flexible';
const SELLER_HOST = 'suimpp.jmpr.world';
const JMPR_RECIPIENT = canonicalSuiAddress('0x9549bff7412d028e936f3b4525c986c3165273cf363db0a72337da54e001391c');
// The same seller asking to be paid at an address the owner never approved. Nothing is sent to it.
const ROTATED_RECIPIENT = canonicalSuiAddress(`0x${'e1'.repeat(32)}`);
const AMOUNT_ATOMIC = 10_000n;
// These payments are never signed, so they only need to outlive this run.
const PAYMENT_LIFETIME_MS = 3_600_000;
const APPROVAL_REASON = 'fine for hotel searches';
const CONFIRM_TRIES = 40;
const CONFIRM_DELAY_MS = 5_000;
const RECALL_TRIES = 20;
const RECALL_DELAY_MS = 6_000;
const SUISCAN_OBJECT = 'https://suiscan.xyz/mainnet/object/';

interface HotelSearch {
  purpose: string;
  /** The seller's own request field, so each search has its own body and its own body hash. */
  request: string;
}

const LISBON: HotelSearch = {
  purpose: 'search hotels in Lisbon for 20 November under 120 euros',
  request: 'One night in Lisbon on 20 November, under 120 euros',
};
const PORTO: HotelSearch = {
  purpose: 'search hotels in Porto for 22 November under 100 euros',
  request: 'One night in Porto on 22 November, under 100 euros',
};
const MADRID: HotelSearch = {
  purpose: 'search hotels in Madrid for 25 November under 110 euros',
  request: 'One night in Madrid on 25 November, under 110 euros',
};

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
  if (error instanceof MemoryError || error instanceof MemoryServiceError || error instanceof DecideError || error instanceof AnswerError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof ProofError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

/** Relayer failures that say nothing about the memories themselves, so a bounded loop may look again. */
function isPassing(error: unknown): boolean {
  return error instanceof MemoryError && ['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM'].includes(error.code);
}

/** The body JMPR's docs give for this route, so each search hashes like a real request would. */
function bodyHash(search: HotelSearch): string {
  const body = JSON.stringify({ request: search.request, adults: 1, rooms: 1 });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** A canonical payment built by hand, in the shape parseChallenge gives for JMPR's live 402. */
function hotelPayment(recipient: string, now: Date): CanonicalPayment {
  return {
    dialect: 'x402-v1-t2000',
    sellerUrl: SELLER_URL,
    sellerHost: SELLER_HOST,
    recipient,
    amount: AMOUNT_ATOMIC,
    asset: USDC_TYPE_MAINNET,
    network: 'sui:mainnet',
    expiresAtMs: now.getTime() + PAYMENT_LIFETIME_MS,
    challengeId: randomUUID(),
    nonce: randomBytes(16).toString('hex'),
    minEpoch: null,
    maxEpoch: null,
    resource: SELLER_URL,
  };
}

interface Context {
  db: Database;
  ownerId: string;
  agentId: string;
  masterSecretHex: string;
  delegateHex: string;
  recall: Recall;
}

function decideHotel(ctx: Context, search: HotelSearch, recipient: string, recall: Recall = ctx.recall): Promise<DecideResult> {
  const now = new Date();
  return decide({
    db: ctx.db,
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    payment: hotelPayment(recipient, now),
    method: 'POST',
    bodyHash: bodyHash(search),
    purpose: search.purpose,
    recall,
    delegatePublicKeyHex: ctx.delegateHex,
    namespace: MEMORY_NAMESPACE,
    now,
  });
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
  console.log(`  Purse ${owner.purseAddress} (derived), Walrus Memory account ${owner.memwalAccountId}`);

  const builtin = and(eq(agents.ownerId, owner.id), eq(agents.kind, 'builtin'));
  const [earlier] = await db.select({ id: agents.id }).from(agents).where(builtin).orderBy(asc(agents.createdAt)).limit(1);
  if (earlier !== undefined) {
    console.log(`  Built-in agent ${earlier.id}: already in the database, reused`);
    return { ownerId: owner.id, agentId: earlier.id };
  }
  // This proof never calls the agent endpoint, so the token itself is thrown away and only
  // its hash is stored, as for any agent token.
  const token = randomBytes(LIMITS.bearerTokenBytes).toString('hex');
  const [agent] = await db
    .insert(agents)
    .values({
      ownerId: owner.id,
      label: 'Ellai demo agent',
      kind: 'builtin',
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      tokenPrefix: 'ellai_demo',
    })
    .returning({ id: agents.id });
  if (agent === undefined) throw new ProofError('the agent insert returned no row');
  console.log(`  Built-in agent ${agent.id}: CREATED in this run`);
  return { ownerId: owner.id, agentId: agent.id };
}

/** Steps 3 and 4: the request must be asked, and the owner approves it. Picks up where an earlier run stopped. */
async function askThenApprove(ctx: Context, search: HotelSearch): Promise<string> {
  const { db, ownerId } = ctx;
  const probe = hotelPayment(JMPR_RECIPIENT, new Date());
  const key = requestKey({ agentId: ctx.agentId, payment: probe, method: 'POST', bodyHash: bodyHash(search), purpose: search.purpose });
  const [earlier] = await db
    .select({ id: decisions.id, outcome: decisions.outcome, rule: decisions.rule, status: decisions.status })
    .from(decisions)
    .where(and(eq(decisions.ownerId, ownerId), eq(decisions.requestKey, key)))
    .orderBy(asc(decisions.createdAt))
    .limit(1);

  let decisionId: string;
  if (earlier === undefined) {
    const decided = await decideHotel(ctx, search, JMPR_RECIPIENT);
    console.log(`  decide: ${decided.outcome} (${decided.rule}). Reason: "${decided.reason}"`);
    if (decided.outcome !== 'asked') throw new ProofError(`expected this first request to be asked, got ${decided.outcome}`);
    decisionId = decided.decisionId;
  } else {
    console.log(`  decide: ${earlier.outcome} (${earlier.rule}), recorded in an earlier run`);
    if (earlier.outcome !== 'asked') throw new ProofError(`the earlier decision for this request was ${earlier.outcome}, not asked`);
    decisionId = earlier.id;
  }

  if (earlier === undefined || earlier.status === 'asked') {
    const answered = await answerQuestion({
      db,
      ownerId,
      decisionId,
      answer: 'approve',
      reason: APPROVAL_REASON,
      delegatePublicKeyHex: ctx.delegateHex,
      namespace: MEMORY_NAMESPACE,
      now: new Date(),
    });
    console.log(`  owner: approve, reason "${APPROVAL_REASON}". Approval recorded as memory ${answered.memoryId}`);
    return answered.memoryId;
  }
  const [question] = await db
    .select({ answer: questions.answer, memoryId: questions.memoryId })
    .from(questions)
    .where(and(eq(questions.decisionId, decisionId), eq(questions.ownerId, ownerId)));
  if (question?.answer !== 'approve' || question.memoryId === null) {
    throw new ProofError('the earlier decision for this request was answered, but not with an approval');
  }
  console.log(`  owner: approve, recorded in an earlier run as memory ${question.memoryId}`);
  return question.memoryId;
}

interface ConfirmedMemory {
  id: string;
  jobId: string;
  blobId: string;
}

async function waitForConfirmation(ctx: Context, ids: string[]): Promise<ConfirmedMemory[]> {
  for (let attempt = 0; ; attempt++) {
    const rows = await ctx.db
      .select({ id: memories.id, status: memories.status, jobId: memories.jobId, blobId: memories.blobId })
      .from(memories)
      .where(and(eq(memories.ownerId, ctx.ownerId), inArray(memories.id, ids)));
    if (rows.length !== ids.length) throw new ProofError('an approval memory is missing from the database');
    const confirmed = new Map<string, ConfirmedMemory>();
    for (const row of rows) {
      if (row.status === 'confirmed' && row.jobId !== null && row.blobId !== null) confirmed.set(row.id, { id: row.id, jobId: row.jobId, blobId: row.blobId });
    }
    if (confirmed.size === ids.length) return ids.flatMap((id) => confirmed.get(id) ?? []);
    if (rows.some((row) => row.status === 'failed')) throw new ProofError('the relayer reported an approval memory as failed');
    if (rows.some((row) => row.jobId === null)) throw new ProofError('an approval memory was never sent; run again to send it');
    if (attempt >= CONFIRM_TRIES) throw new ProofError(`the approval memories were not all confirmed within ${CONFIRM_TRIES} checks`);
    if (attempt > 0) await sleep(CONFIRM_DELAY_MS);
    try {
      const pass = await confirmMemoryJobs({ db: ctx.db, ownerId: ctx.ownerId, masterSecretHex: ctx.masterSecretHex, now: new Date() });
      console.log(`  check ${attempt + 1}: ${pass.confirmed} confirmed, ${pass.pending} still working, ${pass.failed} failed`);
    } catch (error) {
      if (!isPassing(error)) throw error;
      console.log(`  check ${attempt + 1}: ${failureLabel(error)}`);
    }
  }
}

type Hits = Array<{ blobId: string; distance: number }>;

/** Fresh memories can take a minute to become searchable, so this looks again within a fixed ceiling. */
async function waitForRecall(recall: Recall, query: string, blobIds: string[]): Promise<Hits> {
  for (let attempt = 1; ; attempt++) {
    let note: string;
    try {
      const hits = await recall(query, LIMITS.decideRecallLimit);
      const found = blobIds.filter((blobId) => hits.some((hit) => hit.blobId === blobId)).length;
      if (found === blobIds.length) {
        console.log(`  recall ${attempt}: both approval blobs found among ${hits.length} hits`);
        return hits;
      }
      note = `${found} of ${blobIds.length} approval blobs found among ${hits.length} hits`;
    } catch (error) {
      if (!isPassing(error)) throw error;
      note = failureLabel(error);
    }
    if (attempt >= RECALL_TRIES) throw new ProofError(`search did not return both approvals within ${RECALL_TRIES} tries`);
    console.log(`  recall ${attempt}: ${note}; waiting ${RECALL_DELAY_MS / 1000} s`);
    await sleep(RECALL_DELAY_MS);
  }
}

/** Lists the owner's blobs through Tatum until every approval blob shows, within fixed ceilings. */
async function listBlobs(chain: Chain, owner: string, wanted: Set<string>): Promise<WalrusBlob[]> {
  let rateLimited = 0;
  for (let attempt = 1; ; attempt++) {
    let blobs: WalrusBlob[];
    try {
      blobs = await chain.listOwnedWalrusBlobs(owner);
    } catch (error) {
      if (!(error instanceof ChainError && error.code === 'RATE_LIMITED') || rateLimited >= LIMITS.tatumRateLimitRetries) throw error;
      rateLimited += 1;
      console.log(`  Tatum rate limited the blob listing; waiting ${LIMITS.tatumRateLimitWaitMs / 1000} s`);
      await sleep(LIMITS.tatumRateLimitWaitMs);
      continue;
    }
    const listed = new Set(blobs.map((blob) => blob.blobId));
    if ([...wanted].every((blobId) => listed.has(blobId)) || attempt >= LIMITS.memwalReadAfterWriteAttempts) return blobs;
    console.log(`  listing ${attempt}: not every approval blob shows yet; waiting ${LIMITS.memwalReadAfterWriteDelayMs / 1000} s`);
    await sleep(LIMITS.memwalReadAfterWriteDelayMs);
  }
}

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const ownerAddress = canonicalSuiAddress(Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress());
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).toSuiAddress());
  const { publicKeyHex: delegateHex } = ownerDelegate(config.ELLAI_MASTER_SECRET, ownerAddress);

  console.log('Ellai learning loop on Sui Mainnet. Moves no USDC.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
  console.log(`Test owner ${ownerAddress}, namespace ${MEMORY_NAMESPACE}, database scratchpad/loop-db`);

  const handle = await createDb(`pglite:${DB_DIR}`);
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const problems: string[] = [];
  try {
    const { db } = handle;
    await migrate(db);

    console.log('\n1. Owner and built-in agent');
    const { ownerId, agentId } = await ensureOwnerAndAgent(db, ownerAddress, purseAddress);
    const [settings] = await db.select({ cutoff: owners.distanceCutoff, needed: owners.approvalsNeeded }).from(owners).where(eq(owners.id, ownerId));
    const ctx: Context = {
      db,
      ownerId,
      agentId,
      masterSecretHex: config.ELLAI_MASTER_SECRET,
      delegateHex,
      recall: makeRecall({ owner: { suiAddress: ownerAddress, memwalAccountId: ACCOUNT_ID }, masterSecretHex: config.ELLAI_MASTER_SECRET, namespace: MEMORY_NAMESPACE }),
    };

    console.log(`\n2. Payments built by hand: ${AMOUNT_ATOMIC} atomic USDC (0.01) to JMPR ${JMPR_RECIPIENT} at ${SELLER_HOST}`);
    console.log(`  Owner settings: ${settings?.needed} approvals needed, distance cutoff ${settings?.cutoff}`);

    console.log(`\n3. First request: "${LISBON.purpose}"`);
    const lisbon = await askThenApprove(ctx, LISBON);
    console.log(`\n4. Second request: "${PORTO.purpose}"`);
    const porto = await askThenApprove(ctx, PORTO);
    const approvalIds = [lisbon, porto];

    console.log('\n5. Write both approvals to Walrus Memory, confirm them, and wait until search finds them');
    const sent = await submitPendingMemories({ db, ownerId, masterSecretHex: config.ELLAI_MASTER_SECRET, now: new Date() });
    console.log(`  Submitted ${sent.submitted} memories in this run${sent.submitted === 0 ? ': nothing was waiting to be sent' : ', in one bulk write'}`);
    const confirmed = await waitForConfirmation(ctx, approvalIds);
    for (const memory of confirmed) console.log(`  memory ${memory.id} confirmed: blob ${memory.blobId} (job ${memory.jobId})`);
    const madridQuery = querySentence({ payment: hotelPayment(JMPR_RECIPIENT, new Date()), purpose: MADRID.purpose });
    const stepFiveHits = await waitForRecall(
      ctx.recall,
      madridQuery,
      confirmed.map((memory) => memory.blobId),
    );

    console.log(`\n6. Third request, same recipient and amount: "${MADRID.purpose}"`);
    const seen: { hits: Hits | null } = { hits: null };
    const third = await decideHotel(ctx, MADRID, JMPR_RECIPIENT, async (query, limit) => {
      seen.hits = await ctx.recall(query, limit);
      return seen.hits;
    });
    console.log(`  decide: ${third.outcome} (${third.rule})${third.reused ? ', recorded in an earlier run' : ''}. Reason: "${third.reason}"`);
    console.log(`  cites memories ${third.citedMemoryIds.join(', ') || 'none'}`);
    const distanceSource = seen.hits === null ? 'the step 5 search, as this decision was made in an earlier run' : "this decision's own search";
    console.log(`  distances, from ${distanceSource}:`);
    for (const memory of confirmed) {
      const hit = (seen.hits ?? stepFiveHits).find((candidate) => candidate.blobId === memory.blobId);
      console.log(`    memory ${memory.id} (blob ${memory.blobId}): ${hit === undefined ? 'not returned' : hit.distance.toFixed(4)}`);
    }
    const citesBoth =
      third.citedMemoryIds.length === approvalIds.length && approvalIds.every((id) => third.citedMemoryIds.includes(id));
    if (third.outcome !== 'approved' || third.rule !== 'learned') problems.push(`the third request was ${third.outcome} (${third.rule}), not approved (learned)`);
    if (!citesBoth) problems.push('the third decision does not cite exactly the two approvals');

    console.log(`\n7. Fourth request, same purpose, to a recipient never approved: ${ROTATED_RECIPIENT}`);
    const fourth = await decideHotel(ctx, MADRID, ROTATED_RECIPIENT);
    console.log(`  decide: ${fourth.outcome} (${fourth.rule})${fourth.reused ? ', recorded in an earlier run' : ''}. Reason: "${fourth.reason}"`);
    if (fourth.outcome !== 'asked') problems.push(`the fourth request was ${fourth.outcome}, not asked`);

    console.log('\n8. The approval blobs as Walrus Blob objects owned by the test owner, read from Sui Mainnet through Tatum');
    const blobs = await listBlobs(chain, ownerAddress, new Set(confirmed.map((memory) => memory.blobId)));
    for (const memory of confirmed) {
      const blob = blobs.find((candidate) => candidate.blobId === memory.blobId);
      if (blob === undefined) {
        console.log(`  blob ${memory.blobId}: NOT FOUND among ${blobs.length} blobs owned by the test owner`);
        problems.push(`blob ${memory.blobId} is not on chain at the test owner`);
        continue;
      }
      console.log(`  blob ${blob.blobId}`);
      console.log(`    object ${blob.objectId}, registered epoch ${blob.registeredEpoch}, ends epoch ${blob.endEpoch}`);
      console.log(`    ${SUISCAN_OBJECT}${blob.objectId}`);
    }

    const [stored] = await db
      .select({ n: count() })
      .from(memories)
      .where(and(eq(memories.ownerId, ownerId), eq(memories.namespace, MEMORY_NAMESPACE)));
    console.log(`\nMemories in the database for this owner: ${stored?.n ?? 0}`);
  } finally {
    await handle.close();
    chain.close();
  }

  if (problems.length > 0) {
    console.log(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROVEN: two owner approvals written to Walrus Memory and confirmed on chain, found again by meaning, the third request approved on its own citing both, and the same request to a new recipient still asked.');
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
