// Proves live, on Sui Mainnet and the hosted Walrus Memory relayer, that an owner's answer becomes a
// confirmed memory through the visit the answer route schedules, without waiting for the jobs tick
// (C40). The test owner is seeded the way scripts/prove-memory-loop.ts seeds it: the same owner,
// Walrus Memory account and derived delegate, with a built-in agent. A new request is asked about
// and approved, with the run's time in its purpose so its sentence is new, then runOwnerVisit runs
// with trigger 'answer', the real chain and relayer and a real sleep. Every run starts from an
// empty PGlite database at scratchpad/visit-db, which only this script writes. Moves no USDC: the
// seeded owner has no allowance, so no refill can be built, and the gas wallet is a throwaway key.
// With --twice it makes two requests with one purpose, approved with no reason, inside one
// 30-minute window: two answers with one identical sentence, which must end as two confirmed
// memories with two blobs (C46). A third request like them must then be approved on its own,
// citing both. That decide is the last step: nothing is signed or paid.
// Prints ids, times and a link, never a secret key, a signature or relayer error text.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ChainError, createChain } from '@ellai/core/chain';
import type { CanonicalPayment } from '@ellai/core/challenge';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, migrate } from '../src/server/db/client.js';
import { agents, memories, owners, questions } from '../src/server/db/schema.js';
import { AnswerError, answerQuestion } from '../src/server/decide/answer.js';
import { DecideError, decide } from '../src/server/decide/decide.js';
import { withTatumScope } from '../src/server/http/tatum-meter.js';
import { runOwnerVisit } from '../src/server/jobs/visit.js';
import { MemoryServiceError, ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { makeRecall } from '../src/server/memory/recall.js';

const DB_DIR = fileURLToPath(new URL('../../../scratchpad/visit-db', import.meta.url));
// Created for the test owner in WO-3a, with Ellai's derived delegate key already on it.
const ACCOUNT_ID = '0x98a4e7a42754de51dd86bf5b8a06e6caaa2e4dcc8bc08f630952ce291ee91121';
// JMPR's hotel search, the recipient scripts/prove-memory-loop.ts approves.
const SELLER_URL = 'https://suimpp.jmpr.world/v1/hotels/search-flexible';
const SELLER_HOST = 'suimpp.jmpr.world';
const JMPR_RECIPIENT = canonicalSuiAddress('0x9549bff7412d028e936f3b4525c986c3165273cf363db0a72337da54e001391c');
const AMOUNT_ATOMIC = 10_000n;
// This payment is never signed, so it only needs to outlive this run.
const PAYMENT_LIFETIME_MS = 3_600_000;
const APPROVAL_REASON = 'fine for hotel searches';
const WALRUSCAN_BLOB = 'https://walruscan.com/mainnet/blob/';
const TWICE = process.argv.includes('--twice');
// The window the SDK's own bulk key is built over (IDEMPOTENCY_BUCKET_MS). A run that crossed its
// edge would give two keys whatever the code does, and so prove nothing.
const KEY_WINDOW_MS = 1_800_000;
const KEY_WINDOW_MARGIN_MS = 300_000;

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

/** A canonical payment built by hand, in the shape parseChallenge gives for JMPR's live 402. */
function hotelPayment(now: Date): CanonicalPayment {
  return {
    dialect: 'x402-v1-t2000',
    sellerUrl: SELLER_URL,
    sellerHost: SELLER_HOST,
    recipient: JMPR_RECIPIENT,
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

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const ownerAddress = canonicalSuiAddress(Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress());
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).toSuiAddress());
  const { publicKeyHex: delegateHex } = ownerDelegate(config.ELLAI_MASTER_SECRET, ownerAddress);
  const runAt = new Date();

  console.log('Ellai owner visit on Sui Mainnet and Walrus Memory. Moves no USDC.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
  console.log(`Test owner ${ownerAddress}, namespace ${MEMORY_NAMESPACE}, a new database at scratchpad/visit-db`);

  await rm(DB_DIR, { recursive: true, force: true });
  const handle = await createDb(`pglite:${DB_DIR}`);
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const problems: string[] = [];
  try {
    const { db } = handle;
    await migrate(db);

    console.log('\n1. Owner, Walrus Memory account and built-in agent, as prove-memory-loop seeds them');
    const [owner] = await db.insert(owners).values({ suiAddress: ownerAddress, purseAddress, memwalAccountId: ACCOUNT_ID }).returning({ id: owners.id });
    if (owner === undefined) throw new ProofError('the owner insert returned no row');
    // This proof never calls the agent endpoint, so the token itself is thrown away and only its hash is stored.
    const token = randomBytes(LIMITS.bearerTokenBytes).toString('hex');
    const [agent] = await db
      .insert(agents)
      .values({ ownerId: owner.id, label: 'Ellai demo agent', kind: 'builtin', tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'), tokenPrefix: 'ellai_demo' })
      .returning({ id: agents.id });
    if (agent === undefined) throw new ProofError('the agent insert returned no row');
    console.log(`  Owner ${owner.id}, Walrus Memory account ${ACCOUNT_ID}, built-in agent ${agent.id}`);

    const purpose = `search hotels in Lisbon for one night, asked at ${runAt.toISOString()}`;
    if (TWICE) {
      const left = KEY_WINDOW_MS - (Date.now() % KEY_WINDOW_MS);
      if (left < KEY_WINDOW_MARGIN_MS) {
        console.log(`\nWaiting ${Math.ceil(left / 1_000)} s for the next 30-minute window, so both writes fall inside one`);
        await sleep(left);
      }
    }
    // Only the body tells the two requests apart, so C5 sees two requests and their sentences match.
    const decideRequest = async (adults: number) => {
      const decided = await decide({
        db,
        ownerId: owner.id,
        agentId: agent.id,
        payment: hotelPayment(new Date()),
        method: 'POST',
        bodyHash: createHash('sha256').update(JSON.stringify({ request: purpose, adults, rooms: 1 }), 'utf8').digest('hex'),
        purpose,
        recall: makeRecall({ owner: { suiAddress: ownerAddress, memwalAccountId: ACCOUNT_ID }, masterSecretHex: config.ELLAI_MASTER_SECRET, namespace: MEMORY_NAMESPACE }),
        delegatePublicKeyHex: delegateHex,
        namespace: MEMORY_NAMESPACE,
        now: new Date(),
      });
      console.log(`  decide: ${decided.outcome} (${decided.rule}). Reason: "${decided.reason}"`);
      return decided;
    };
    const askAndApprove = async (adults: number, reason: string | null) => {
      const decided = await decideRequest(adults);
      if (decided.outcome !== 'asked') throw new ProofError(`expected the request to be asked, got ${decided.outcome}`);
      console.log('\n3. The owner approves, as the answer route records it');
      const answered = await answerQuestion({
        db,
        ownerId: owner.id,
        decisionId: decided.decisionId,
        answer: 'approve',
        reason,
        delegatePublicKeyHex: delegateHex,
        namespace: MEMORY_NAMESPACE,
        now: new Date(),
      });
      console.log(`  Approval recorded as memory ${answered.memoryId}, status pending`);
      return { decisionId: decided.decisionId, memoryId: answered.memoryId };
    };

    console.log(`\n2. ${TWICE ? 'Two new requests' : 'A new request'}, ${AMOUNT_ATOMIC} atomic USDC (0.01) to JMPR ${JMPR_RECIPIENT}: "${purpose}"`);
    const first = await askAndApprove(1, TWICE ? null : APPROVAL_REASON);
    const second = TWICE ? await askAndApprove(2, null) : null;
    const memoryIds = second === null ? [first.memoryId] : [first.memoryId, second.memoryId];
    const readMemories = async () => {
      const rows = await db.select().from(memories).where(inArray(memories.id, memoryIds));
      return memoryIds.flatMap((id) => rows.filter((row) => row.id === id));
    };
    if (second !== null) {
      const sentences = new Set((await readMemories()).map((row) => row.sentence));
      if (sentences.size !== 1) throw new ProofError('the two answers did not give one identical sentence');
      console.log(`  Both memories hold one sentence: ${[...sentences].join('')}`);
    }

    // Each answer starts a visit of its own; one visit holds the owner at a time, so here they run in turn.
    const codes = new Set<string>();
    for (const _ of memoryIds) {
      console.log("\n4. The visit the answer route schedules: trigger 'answer', the real chain and relayer, a real sleep");
      const startedMs = Date.now();
      let waits = 0;
      const visit = await runOwnerVisit({
        db,
        chain,
        masterSecretHex: config.ELLAI_MASTER_SECRET,
        gasKeypair: Ed25519Keypair.generate(),
        now: () => new Date(),
        sleep: async (ms) => {
          waits += 1;
          console.log(`  pass ${waits} done, the memory is still waiting; next pass in ${ms / 1_000} s`);
          await sleep(ms);
        },
        ownerId: owner.id,
        trigger: 'answer',
        deadlineMs: startedMs + LIMITS.tickTimeBudgetMs,
      });
      for (const error of visit.summary.errors) codes.add(`${error.step} ${error.code}`);
      console.log(`  started ${visit.started}, passes ${visit.passes}, submitted ${visit.summary.memoriesSubmitted}, confirmed ${visit.summary.memoriesConfirmed}, errors ${[...codes].join(', ') || 'none'}`);
      console.log(`  The visit took ${((Date.now() - startedMs) / 1_000).toFixed(1)} s`);
    }

    const stored = await readMemories();
    if (TWICE) {
      console.log('\n5. The two approval memories');
      for (const row of stored) console.log(`  memory ${row.id}: status ${row.status}, job ${row.jobId ?? 'none'}, blob ${row.blobId ?? 'none'}`);
      const windows = new Set(stored.map((row) => Math.floor((row.submittedAt?.getTime() ?? 0) / KEY_WINDOW_MS)));
      console.log(`  Sent in ${windows.size} 30-minute window${windows.size === 1 ? '' : 's'}`);
      const blobs = new Set(stored.flatMap((row) => (row.blobId === null ? [] : [row.blobId])));
      for (const blobId of blobs) console.log(`  ${WALRUSCAN_BLOB}${encodeURIComponent(blobId)}`);
      if (windows.size !== 1) problems.push('the two writes were not sent inside one 30-minute window');
      if (stored.some((row) => row.status !== 'confirmed') || blobs.size !== 2) {
        problems.push(`the two answers ended ${stored.map((row) => row.status).join(' and ')} with ${blobs.size} blob(s), not two confirmed memories with two blobs`);
      }
      if (problems.length === 0) {
        await sleep(LIMITS.memwalReadAfterWriteDelayMs);
        console.log('\n6. One more request with the same purpose, amount and recipient, decided with no question');
        // A new body, because each yes leaves a one-time grant for its own body, and a grant answers before recall is asked.
        const third = await decideRequest(3);
        console.log(`  Cites ${third.citedMemoryIds.join(', ') || 'no memory'}`);
        const citesBoth = memoryIds.every((id) => third.citedMemoryIds.includes(id));
        if (third.outcome !== 'approved' || third.rule !== 'learned' || !citesBoth) {
          problems.push(`the third decide returned ${third.outcome} (${third.rule}) citing ${third.citedMemoryIds.length} memories, not approved (learned) citing both`);
        }
      }
    } else {
      const [memory] = stored;
      const [question] = await db.select({ answeredAt: questions.answeredAt }).from(questions).where(eq(questions.decisionId, first.decisionId));
      console.log('\n5. The approval memory');
      console.log(`  status ${memory?.status ?? 'missing'}, job ${memory?.jobId ?? 'none'}`);
      if (memory?.status === 'confirmed' && memory.blobId !== null && memory.confirmedAt !== null && question !== undefined && question.answeredAt !== null) {
        const seconds = (memory.confirmedAt.getTime() - question.answeredAt.getTime()) / 1_000;
        console.log(`  Answer to confirmed: ${seconds.toFixed(1)} s (answered_at to confirmed_at, both written by Ellai)`);
        console.log(`  Blob ${memory.blobId}`);
        console.log(`  ${WALRUSCAN_BLOB}${encodeURIComponent(memory.blobId)}`);
      } else {
        problems.push(`the approval memory is ${memory?.status ?? 'missing'}, not confirmed, after the visit`);
      }
    }
    if (codes.size > 0) problems.push(`the visit recorded errors: ${[...codes].join(', ')}`);
  } finally {
    await handle.close();
    chain.close();
  }

  if (problems.length > 0) {
    console.log(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      TWICE
        ? '\nPROVEN: two identical answers inside one 30-minute window became two confirmed memories with two blobs on Walrus Memory, and a third request like them was approved on its own, citing both.'
        : "\nPROVEN: the owner's approval was written to Walrus Memory and confirmed by the visit its own answer starts, with no jobs tick.",
    );
  }
}

// Ellai's own work, as the tick is, so it runs in the jobs scope like the tick.
withTatumScope({ kind: 'jobs' }, main).catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
