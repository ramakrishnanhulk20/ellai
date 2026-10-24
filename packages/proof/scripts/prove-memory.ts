// Proves Ellai's Walrus Memory slice on Sui Mainnet for the test owner: makes sure the owner
// has a Walrus Memory account with Ellai's derived delegate key on it (the owner signs and
// pays gas, sent through Tatum), writes 10 true sentences about the test setup once, recalls
// one by meaning, and reads the owner's Walrus Blob objects back from chain through Tatum.
// A second run creates, adds and writes nothing: the chain answers the account questions and
// scratchpad/slice-state-memory.json records the write. Moves no USDC. Prints ids, digests,
// the delegate public key and links, never a secret key, a signature or relayer error text.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import type { MemWal } from '@mysten-incubation/memwal';
import { z } from 'zod';
import { type Chain, ChainError, createChain, type WalrusBlob } from '../src/chain.js';
import { config } from '../src/config.js';
import { deriveMemwalDelegateKeypair, derivePurseKeypair } from '../src/keys.js';
import { LIMITS } from '../src/limits.js';
import { createMemoryClient, ensureMemoryAccount, MemoryError, recallSentences, rememberSentences } from '../src/memory.js';

const NAMESPACE = 'ellai-test-v1';
const SENTENCE_COUNT = 10;
const QUERY = 'Which seller does the test pay first, and how much does it cost?';
const STATE_PATH = fileURLToPath(new URL('../../../scratchpad/slice-state-memory.json', import.meta.url));
const SUISCAN_OBJECT = 'https://suiscan.xyz/mainnet/object/';
const SUISCAN_TX = 'https://suiscan.xyz/mainnet/tx/';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A refusal written by this script. Its message is fixed text and validated ids only. */
class ProofError extends Error {}

const relayerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const writeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent'), namespace: z.literal(NAMESPACE), sentAt: z.iso.datetime() }),
  z.object({
    status: z.literal('done'),
    namespace: z.literal(NAMESPACE),
    sentAt: z.iso.datetime(),
    durationMs: z.number().int().min(0),
    memories: z
      .array(z.object({ text: z.string().min(1).max(LIMITS.memwalSentenceMaxBytes), blobId: relayerId, jobId: relayerId }))
      .length(SENTENCE_COUNT),
  }),
]);
// Read back from disk, so it is checked like any other input before anything acts on it.
const stateSchema = z.object({
  owner: z.string().regex(/^0x[0-9a-f]{64}$/),
  accountId: z.string().regex(/^0x[0-9a-f]{64}$/),
  delegatePublicKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  accountDigests: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)).max(2),
  accountCreatedAt: z.iso.datetime().nullable(),
  write: writeSchema.nullable(),
});
type ProofState = z.infer<typeof stateSchema>;

function readState(): ProofState | null {
  let raw: string;
  try {
    raw = readFileSync(STATE_PATH, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw new ProofError('scratchpad/slice-state-memory.json cannot be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProofError('scratchpad/slice-state-memory.json is not JSON; nothing was sent. Fix or remove it.');
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) throw new ProofError('scratchpad/slice-state-memory.json is not in the expected shape; nothing was sent. Fix or remove it.');
  return result.data;
}

function saveState(state: ProofState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Ten true statements about this test setup. Addresses are public on chain already; nothing here is secret. */
function setupSentences(facts: { accountDate: string; createdByEllai: boolean; owner: string; purse: string; gas: string }): string[] {
  return [
    facts.createdByEllai
      ? `Ellai created this Walrus Memory account for its test owner on ${facts.accountDate} (UTC) to prove Ellai's core loop on Sui Mainnet.`
      : `Ellai began writing to this Walrus Memory account for its test owner on ${facts.accountDate} (UTC) to prove Ellai's core loop on Sui Mainnet.`,
    `The test owner's Sui Mainnet address is ${facts.owner}.`,
    `For the test owner, Ellai pays sellers from the purse address ${facts.purse}.`,
    `The gas wallet that sponsors purse refills for the test owner is ${facts.gas}.`,
    'The test allowance from the owner to the purse allows at most 1.00 USDC in total and 0.50 USDC per day, for 30 days.',
    'The first seller the test pays is agentproof.vegagaminginc.workers.dev /v1/preflight, for 0.01 USDC.',
    "Only the owner's own answers teach Ellai which payments to approve.",
    'When the owner has refused a seller, that refusal always wins over any approval.',
    'Ellai never lets an AI model approve a payment.',
    'Every payment Ellai makes is a plain gasless USDC send, checked byte for byte before signing.',
  ];
}

function failureLabel(error: unknown): string {
  if (error instanceof MemoryError) return `${error.code}: ${error.message}`;
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof ProofError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

/**
 * One cheap signed recall before anything is written, retried while the relayer's view of
 * the chain catches up with a delegate key added moments ago. A write is never sent on a
 * key the relayer does not yet accept.
 */
async function relayerAcceptsKey(client: MemWal): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await recallSentences(client, NAMESPACE, QUERY, { limit: 1, maxDistance: LIMITS.memwalProofMaxDistance });
      return;
    } catch (error) {
      const waitable = error instanceof MemoryError && ['DELEGATE', 'TIMEOUT', 'UPSTREAM', 'RATE_LIMITED'].includes(error.code);
      if (!waitable || attempt >= LIMITS.memwalProofRecallAttempts) throw error;
      console.log(`  relayer check ${attempt}: ${failureLabel(error)}; waiting ${LIMITS.memwalProofRecallDelayMs / 1000} s`);
      await sleep(LIMITS.memwalProofRecallDelayMs);
    }
  }
}

/** Recalls, waiting for the search index to catch up after a write, at most LIMITS.memwalProofRecallAttempts times. */
async function recallWithIndexWait(client: MemWal): Promise<Awaited<ReturnType<typeof recallSentences>>> {
  for (let attempt = 1; ; attempt++) {
    let outcome: string;
    try {
      const hits = await recallSentences(client, NAMESPACE, QUERY, {
        limit: LIMITS.memwalProofRecallLimit,
        maxDistance: LIMITS.memwalProofMaxDistance,
      });
      if (hits.length > 0 || attempt >= LIMITS.memwalProofRecallAttempts) return hits;
      outcome = 'no hit yet (the index can lag a fresh write)';
    } catch (error) {
      const waitable = error instanceof MemoryError && ['TIMEOUT', 'UPSTREAM', 'RATE_LIMITED'].includes(error.code);
      if (!waitable || attempt >= LIMITS.memwalProofRecallAttempts) throw error;
      outcome = failureLabel(error);
    }
    console.log(`  recall ${attempt}: ${outcome}; waiting ${LIMITS.memwalProofRecallDelayMs / 1000} s`);
    await sleep(LIMITS.memwalProofRecallDelayMs);
  }
}

/** Lists the owner's blobs through Tatum until every written blob shows, within fixed ceilings. */
async function listBlobs(chain: Chain, owner: string, written: Set<string>): Promise<WalrusBlob[]> {
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
    if ([...written].every((blobId) => listed.has(blobId)) || attempt >= LIMITS.memwalReadAfterWriteAttempts) return blobs;
    console.log(`  listing ${attempt}: not every written blob shows yet; waiting ${LIMITS.memwalReadAfterWriteDelayMs / 1000} s`);
    await sleep(LIMITS.memwalReadAfterWriteDelayMs);
  }
}

async function main(): Promise<void> {
  const owner = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY);
  const ownerAddress = owner.toSuiAddress();
  const purseAddress = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).toSuiAddress();
  const gasAddress = Ed25519Keypair.fromSecretKey(config.GAS_PRIVATE_KEY).toSuiAddress();
  const delegate = deriveMemwalDelegateKeypair(config.ELLAI_MASTER_SECRET, ownerAddress);
  const delegatePublicKey = delegate.getPublicKey().toRawBytes();
  const delegateHex = toHex(delegatePublicKey);

  const previous = readState();
  if (previous && (previous.owner !== ownerAddress || previous.delegatePublicKeyHex !== delegateHex)) {
    throw new ProofError('scratchpad/slice-state-memory.json belongs to another owner or delegate key; nothing was sent.');
  }

  console.log('Walrus Memory proof on Sui Mainnet. Moves no USDC.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : `no (anonymous, account steps paced to ${LIMITS.tatumAnonymousRequestsPerMinute} a minute)`}`);
  console.log(`Test owner ${ownerAddress}`);

  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  let client: MemWal | undefined;
  const problems: string[] = [];
  try {
    console.log('\n1. Account (read through Tatum; created and keyed by the owner only if missing)');
    const accountStarted = Date.now();
    const account = await ensureMemoryAccount({ chain, owner, delegatePublicKey });
    if (previous && previous.accountId !== account.accountId) {
      throw new ProofError('the account on chain differs from the one recorded in scratchpad/slice-state-memory.json');
    }
    const state: ProofState = {
      owner: ownerAddress,
      accountId: account.accountId,
      delegatePublicKeyHex: delegateHex,
      accountDigests: account.digests.length > 0 ? account.digests : (previous?.accountDigests ?? []),
      accountCreatedAt: account.created ? new Date().toISOString() : (previous?.accountCreatedAt ?? null),
      write: previous?.write ?? null,
    };
    saveState(state);
    const digestSource = account.digests.length > 0 ? 'sent in this run' : 'recorded on the first run';
    console.log(`  Account ${account.accountId}: ${account.created ? 'CREATED in this run' : 'already existed, reused'}`);
    console.log(`  Delegate key: ${account.delegateAdded ? 'ADDED in this run' : 'already registered, nothing added'}`);
    console.log(`  Account steps took ${((Date.now() - accountStarted) / 1000).toFixed(1)} s`);
    for (const digest of state.accountDigests) console.log(`  Digest ${digest} (${digestSource}) ${SUISCAN_TX}${digest}`);

    client = createMemoryClient({ delegate, accountId: account.accountId });

    console.log(`\n2. Write ${SENTENCE_COUNT} memories in namespace ${NAMESPACE}`);
    let write = state.write;
    const writtenThisRun = write === null;
    if (write?.status === 'sent') {
      throw new ProofError(
        `an earlier run sent the write at ${write.sentAt} and never saw it finish. Nothing was sent again, because a resent ` +
          'bulk write stores every sentence twice. Check the owner blobs on chain, then remove "write" from ' +
          'scratchpad/slice-state-memory.json only if nothing was stored.',
      );
    }
    if (write?.status === 'done') {
      console.log(`  Already written at ${write.sentAt}: nothing written in this run.`);
    } else {
      await relayerAcceptsKey(client);
      const sentences = setupSentences({
        accountDate: (state.accountCreatedAt ?? new Date().toISOString()).slice(0, 10),
        createdByEllai: state.accountCreatedAt !== null,
        owner: ownerAddress,
        purse: purseAddress,
        gas: gasAddress,
      });
      const sentAt = new Date().toISOString();
      state.write = { status: 'sent', namespace: NAMESPACE, sentAt };
      saveState(state);
      const started = Date.now();
      let memories: Awaited<ReturnType<typeof rememberSentences>>;
      try {
        memories = await rememberSentences(client, NAMESPACE, sentences);
      } catch (error) {
        // A refused key is turned away before the relayer stores anything, so the write can be tried again.
        if (error instanceof MemoryError && error.code === 'DELEGATE') {
          state.write = null;
          saveState(state);
        }
        throw error;
      }
      write = { status: 'done', namespace: NAMESPACE, sentAt, durationMs: Date.now() - started, memories };
      state.write = write;
      saveState(state);
      console.log('  Written in this run.');
    }
    for (const [index, memory] of write.memories.entries()) {
      console.log(`  ${String(index + 1).padStart(2)}. blob ${memory.blobId}  job ${memory.jobId}`);
    }
    console.log(`  Bulk write took ${(write.durationMs / 1000).toFixed(1)} s from send to the last job done (${writtenThisRun ? 'this run' : 'first run'})`);

    console.log(`\n3. Recall by meaning: "${QUERY}"`);
    const hits = await recallWithIndexWait(client);
    for (const hit of hits) console.log(`  distance ${hit.distance.toFixed(4)}  blob ${hit.blobId}  "${hit.text}"`);
    if (hits.length === 0) problems.push('recall found no hit under the distance cutoff');

    console.log('\n4. Walrus Blob objects owned by the test owner, read from Sui Mainnet through Tatum');
    const written = new Set(write.memories.map((memory) => memory.blobId));
    const blobs = await listBlobs(chain, ownerAddress, written);
    const epochSpans = new Set<number>();
    for (const blob of blobs) {
      const span = blob.endEpoch - blob.registeredEpoch;
      epochSpans.add(span);
      const mark = written.has(blob.blobId) ? 'written by this proof' : 'not from this proof';
      console.log(`  ${blob.blobId}  registered epoch ${blob.registeredEpoch}, ends epoch ${blob.endEpoch} (${span} epochs), ${mark}`);
      console.log(`    ${SUISCAN_OBJECT}${blob.objectId}`);
    }
    const found = [...written].filter((blobId) => blobs.some((blob) => blob.blobId === blobId)).length;
    console.log(`  ${blobs.length} Walrus Blob objects listed; ${found} of ${written.size} written blob ids found on chain.`);
    if (blobs.length < SENTENCE_COUNT) problems.push(`only ${blobs.length} Walrus Blob objects on chain`);
    if (found < written.size) problems.push(`${written.size - found} written blob ids are not on chain`);

    console.log('\nFor the hackathon form');
    console.log(`  Account ID (SUI):  ${account.accountId}`);
    console.log(`    ${SUISCAN_OBJECT}${account.accountId}`);
    console.log(`  MEMWAL_AGENT_ID (Ellai's delegate public key, hex):  ${delegateHex}`);
    console.log(`  Each memory is stored for ${[...epochSpans].join(', ') || 'no'} epochs (end epoch minus registered epoch).`);
  } finally {
    client?.destroy();
    chain.close();
  }

  if (problems.length > 0) {
    console.log(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROVEN: account and delegate key on chain, 10 memories written, recalled by meaning, and every blob read back through Tatum.');
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
