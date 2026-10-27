// The learning test from Ram's answers in LABELS.md, live on Sui Mainnet and Walrus Memory, run on
// scratchpad/dev-db after copying it to scratchpad/dev-db-before-eval (a copy already there is kept,
// never overwritten). Every row's request is a real 402 from a real seller, read the way
// pay/flow.ts reads it up to decide. Ellai's own wallet check is issued in process at
// https://ellai.invalid, standing in for the deployed seller: parseChallenge reads only https
// sellers, and the recipient and price are the same. Learn rows are decided and, when Ellai asks,
// answered as Ram's label says through answerQuestion; those answers are written to the test
// owner's Walrus Memory account and confirmed. Test rows are decided only, once every grant the
// learn answers left has expired, and scored against the labels. Nothing is retried with a grant,
// signed or paid, no jobs tick runs, and the run fails unless the payments and refills tables end
// as they started. Writes LABELS-RESULTS.md at the repo root. Run from packages/web:
//   npx tsx --env-file-if-exists=../../.env scripts/learning-eval.ts
// Prints ids, distances and links, never a key, a token, a signature or a memory sentence.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllowanceError } from '@ellai/core/allowance';
import { type BeforeTatumRequest, type Chain, ChainError, type WalrusBlob, createChain } from '@ellai/core/chain';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '@ellai/core/challenge';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { NetError, type SafeResponse, safeFetch } from '@ellai/core/net';
import { PaymentError, checkPayable } from '@ellai/core/payment';
import { KNOWN_SELLERS, type Seller } from '@ellai/core/sellers';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import { agentCatalog } from '../src/server/agent/catalog.js';
import { AgentError, createAgentToken } from '../src/server/auth/agents.js';
import { SignInError } from '../src/server/auth/signin.js';
import { agentCreate, agentLabel, claimStepUp, issueStepUp, stepUpRequest } from '../src/server/auth/stepup.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, decisionCitations, decisions, grantUses, grants, memories, owners, payments, questions, refills } from '../src/server/db/schema.js';
import { AnswerError, answerQuestion } from '../src/server/decide/answer.js';
import { DecideError, type Recall, decide } from '../src/server/decide/decide.js';
import { formatUsdc, requestKey } from '../src/server/decide/sentences.js';
import { HttpError } from '../src/server/http/errors.js';
import { tatumMeter, withTatumScope } from '../src/server/http/tatum-meter.js';
import { confirmBlobsOnChain } from '../src/server/jobs/blobs.js';
import { MemoryServiceError, ownerDelegate } from '../src/server/memory/delegate.js';
import { MEMORY_NAMESPACE } from '../src/server/memory/namespace.js';
import { makeRecall } from '../src/server/memory/recall.js';
import { confirmMemoryJobs, submitPendingMemories } from '../src/server/memory/writer.js';
import { paymentInFlight } from '../src/server/pay/sign.js';
import { readMemoryMap } from '../src/server/public/proof.js';
import { handleWalletCheck, sellerPayTo } from '../src/server/seller/handler.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DB_DIR = join(REPO, 'scratchpad', 'dev-db');
const BACKUP_DIR = join(REPO, 'scratchpad', 'dev-db-before-eval');
const LOOP_DB_DIR = join(REPO, 'scratchpad', 'loop-db');
const LABELS_PATH = join(REPO, 'LABELS.md');
const RESULTS_PATH = join(REPO, 'LABELS-RESULTS.md');

// The origin the step-up message names, as dev-data.ts signs it for Ram's dev server.
const DEV_ORIGIN = 'http://localhost:3000';
// The reserved .invalid domain, as prove-seller.ts uses: no one can fetch it.
const WALLET_CHECK_ORIGIN = 'https://ellai.invalid';
const CALLER_KEY = 'learning-eval';
const AGENT_LABEL_PREFIX = 'Learning test agent';
// One under the agents' max_pending of 5, so the queue cap never turns an ask into a refusal.
const MAX_OPEN_PER_AGENT = 4;
// The Tatum key answers about 3 requests a second; one request every 400 ms stays under it.
const TATUM_GAP_MS = 400;
const NET_RETRY_DELAY_MS = 5_000;
const SUBMIT_RETRIES = 2;
const CONFIRM_DELAY_MS = 5_000;
const CONFIRM_CEILING_MS = 15 * 60_000;
const INDEX_WAIT_MS = 90_000;
const GRANT_CLEAR_MS = LIMITS.grantTtlMs + 60_000;
const BLOB_RECHECK_DELAY_MS = 120_000;
const BLOB_RECHECKS = 3;
const SUISCAN_OBJECT = 'https://suiscan.xyz/mainnet/object/';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A refusal written by this script. Its message is fixed text and validated ids only. */
class EvalError extends Error {}

const printed: string[] = [];
function say(line = ''): void {
  printed.push(line);
  console.log(line);
}

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
  ELLAI_SELLER_PAYTO: z.preprocess(blankIsMissing, z.string().optional()),
  SESSION_SECRET: z.preprocess(blankIsMissing, z.string().regex(/^(?:[0-9a-f]{2}){32,}$/i).optional()),
});

/** The variables this script reads. The message names bad variables and never a value. */
function loadConfig(env: Record<string, string | undefined>): z.infer<typeof configSchema> {
  const names = Object.keys(configSchema.shape);
  const result = configSchema.safeParse(Object.fromEntries(names.map((name) => [name, env[name]])));
  if (result.success) return result.data;
  const bad = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  throw new EvalError(`root .env is missing or has malformed: ${bad.join(', ')}`);
}

function failureLabel(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status} ${error.code}`;
  if (error instanceof SignInError) return `SIGN_IN ${error.code}`;
  if (error instanceof MemoryError || error instanceof MemoryServiceError || error instanceof AllowanceError) return `${error.code}: ${error.message}`;
  if (error instanceof DecideError || error instanceof AnswerError || error instanceof AgentError) return `${error.code}: ${error.message}`;
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof EvalError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

/** Relayer failures that say nothing about the memories themselves, so a bounded loop may look again. */
function isPassing(error: unknown): boolean {
  return error instanceof MemoryError && ['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM'].includes(error.code);
}

/** The meter, with every request to Tatum started at least TATUM_GAP_MS after the one before. */
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

/** Every file under `dir` by relative path, size and content hash, so two trees compare exactly. */
function treeFingerprint(dir: string): string {
  const hash = createHash('sha256');
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else hash.update(`${relative(dir, path)}\0${stat.size}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`);
    }
  };
  walk(dir);
  return hash.digest('hex');
}

type Verdict = 'approve' | 'refuse';

interface LabelRow {
  n: number;
  phase: 'Learn' | 'Test';
  seller: string;
  purpose: string;
  price: string;
  label: Verdict;
}

/** Ram's 24 rows, read from LABELS.md itself so the labels scored are exactly the ones he left. */
function readLabels(): LabelRow[] {
  const lines = readFileSync(LABELS_PATH, 'utf8').split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
  const rows = lines.map((line): LabelRow => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const [n, phase, seller, purpose, price, label] = cells;
    if (cells.length !== 6 || n === undefined || seller === undefined || purpose === undefined || price === undefined) throw new EvalError('a LABELS.md row does not have six cells');
    if (phase !== 'Learn' && phase !== 'Test') throw new EvalError(`LABELS.md row ${n} has a phase that is not Learn or Test`);
    if (label !== 'approve' && label !== 'refuse') throw new EvalError(`LABELS.md row ${n} has an answer that is not approve or refuse`);
    if (!/^[0-9]+\.[0-9]+ USDC$/.test(price)) throw new EvalError(`LABELS.md row ${n} has a price that is not "<amount> USDC"`);
    return { n: Number(n), phase, seller, purpose, price, label };
  });
  if (rows.length !== 24 || rows.some((row, index) => row.n !== index + 1)) throw new EvalError('LABELS.md does not hold rows 1 to 24 in order');
  if (rows.some((row) => (row.n <= 12) !== (row.phase === 'Learn'))) throw new EvalError('LABELS.md rows 1 to 12 must be Learn and 13 to 24 Test');
  return rows;
}

type Target = { kind: 'known'; name: string; seller: Seller & { body: string; contentType: string } } | { kind: 'wallet'; name: string; url: string; body: string; contentType: string };

function known(url: string, name: string): Target {
  const seller = KNOWN_SELLERS.find((candidate) => candidate.url === url);
  if (seller === undefined || seller.body === undefined || seller.contentType === undefined) throw new EvalError(`KNOWN_SELLERS has no documented request for ${url}`);
  return { kind: 'known', name, seller: { ...seller, body: seller.body, contentType: seller.contentType } };
}

/** The seller each LABELS.md row names, matched on its seller text and, for agentproof, its price. Fails closed on anything else. */
function targetFor(row: LabelRow): Target {
  const seller = row.seller.toLowerCase();
  if (seller.startsWith('ellai wallet check')) {
    const entry = agentCatalog(WALLET_CHECK_ORIGIN).find((candidate) => candidate.id === 'ellai-wallet-check');
    if (entry === undefined || entry.bodyExample === null || entry.contentType === null) throw new EvalError('the agent catalog has no wallet check entry');
    return { kind: 'wallet', name: "Ellai's wallet check (in process, https://ellai.invalid)", url: entry.url, body: entry.bodyExample, contentType: entry.contentType };
  }
  if (seller.startsWith('hotel search') && seller.includes('suimpp.jmpr.world')) return known('https://suimpp.jmpr.world/v1/hotels/search-flexible', 'JMPR hotel search');
  if (seller.includes('jp-task-policy-evidence')) return known('https://jp-task-policy-evidence.rev72258.workers.dev/classify', 'Task classifier');
  if (seller.includes('piptradedex.xyz')) return known('https://piptradedex.xyz/markets', 'PipTradeDex markets');
  if (seller.includes('agentproof') && seller.includes('deep')) return known('https://agentproof.vegagaminginc.workers.dev/v1/deep-verify', 'AgentProof deep-verify');
  if (seller.includes('agentproof') && row.price === '0.05 USDC') return known('https://agentproof.vegagaminginc.workers.dev/v1/mcp-verify', 'AgentProof mcp-verify');
  if (seller.includes('agentproof') && row.price === '0.01 USDC') return known('https://agentproof.vegagaminginc.workers.dev/v1/preflight', 'AgentProof preflight');
  // The head chef's pick for row 22: payable at 0.01 and used by no learn row.
  if (seller.startsWith('a seller ellai has never seen')) return known('https://agentproof.vegagaminginc.workers.dev/mcp', 'AgentProof /mcp');
  throw new EvalError(`no seller is mapped for LABELS.md row ${row.n}`);
}

const targetUrl = (target: Target) => new URL(target.kind === 'known' ? target.seller.url : target.url).href;

interface Context {
  db: Database;
  chain: Chain;
  ownerId: string;
  ownerAddress: string;
  ownerKeypair: Ed25519Keypair;
  masterSecretHex: string;
  delegateHex: string;
  sessionSecretHex: string;
  payTo: string;
  baseRecall: Recall;
  secrets: string[];
}

type Challenge = { ok: true; payment: CanonicalPayment; method: 'GET' | 'POST'; bodyHash: string } | { ok: false; reason: string };

/**
 * The seller's unpaid 402 read into one canonical payment the way paidFetch does: safeFetch with
 * only the documented content type and body, then parseChallenge and checkPayable. The wallet check
 * is asked in process through handleWalletCheck. A network failure is tried once more.
 */
async function readChallenge(ctx: Context, target: Target): Promise<Challenge> {
  let response: SafeResponse;
  const method = target.kind === 'known' ? target.seller.method : 'POST';
  const body = target.kind === 'known' ? target.seller.body : target.body;
  if (target.kind === 'known') {
    const { seller } = target;
    let fetched: SafeResponse | undefined;
    for (let attempt = 1; fetched === undefined; attempt++) {
      try {
        fetched = await safeFetch(seller.url, { method: seller.method, headers: { 'content-type': seller.contentType }, body: seller.body });
      } catch (error) {
        if (!(error instanceof NetError)) throw error;
        if (attempt >= 2) return { ok: false, reason: `the seller could not be reached twice (${error.code})` };
        await sleep(NET_RETRY_DELAY_MS);
      }
    }
    if (fetched.status !== 402) return { ok: false, reason: `the seller answered HTTP ${fetched.status}, not 402` };
    response = fetched;
  } else {
    const answer = await handleWalletCheck({
      db: ctx.db,
      chain: ctx.chain,
      method: 'POST',
      url: target.url,
      headers: { 'content-type': target.contentType },
      body: target.body,
      payTo: ctx.payTo,
      callerKey: CALLER_KEY,
      now: new Date(),
    });
    if (answer.status !== 402) return { ok: false, reason: `the in-process seller answered HTTP ${answer.status}, not 402` };
    response = { status: answer.status, headers: answer.headers, bodyText: answer.body, url: target.url, host: new URL(target.url).hostname };
  }
  let payment: CanonicalPayment;
  try {
    payment = parseChallenge(response, Date.now());
    checkPayable(payment);
  } catch (error) {
    if (error instanceof ChallengeError) return { ok: false, reason: `parseChallenge refused the 402 (${error.code})` };
    if (error instanceof PaymentError) return { ok: false, reason: `checkPayable refused the payment (${error.code})` };
    throw error;
  }
  return { ok: true, payment, method, bodyHash: createHash('sha256').update(body, 'utf8').digest('hex') };
}

interface AgentSlot {
  id: string;
  label: string;
  createdHere: boolean;
}

async function openQuestions(db: Database, ownerId: string, agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(questions)
    .innerJoin(decisions, and(eq(decisions.id, questions.decisionId), eq(decisions.ownerId, questions.ownerId)))
    .where(and(eq(questions.ownerId, ownerId), eq(decisions.agentId, agentId), eq(decisions.status, 'asked'), isNull(questions.answeredAt)));
  return row?.n ?? 0;
}

/** decide's own grant lookup (rule 6) for this agent, so a learn row is never approved by an earlier learn answer's grant. */
async function hasLiveGrant(db: Database, ownerId: string, agentId: string, challenge: Extract<Challenge, { ok: true }>, now: Date): Promise<boolean> {
  const { payment } = challenge;
  const [grant] = await db
    .select({ id: grants.id })
    .from(grants)
    .innerJoin(decisions, and(eq(decisions.id, grants.decisionId), eq(decisions.ownerId, grants.ownerId)))
    .leftJoin(grantUses, eq(grantUses.grantId, grants.id))
    .where(
      and(
        eq(grants.ownerId, ownerId),
        isNull(grantUses.grantId),
        gt(grants.expiresAt, now),
        eq(grants.recipient, payment.recipient),
        gte(grants.maxAmountAtomic, payment.amount),
        eq(grants.sellerUrl, payment.sellerUrl),
        eq(grants.sellerMethod, challenge.method),
        eq(grants.bodyHash, challenge.bodyHash),
        eq(decisions.agentId, agentId),
      ),
    )
    .limit(1);
  return grant !== undefined;
}

async function liveGrantsForOwner(db: Database, ownerId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(grants)
    .leftJoin(grantUses, eq(grantUses.grantId, grants.id))
    .where(and(eq(grants.ownerId, ownerId), isNull(grantUses.grantId), gt(grants.expiresAt, now)));
  return row?.n ?? 0;
}

/**
 * A new external agent made the way POST /api/owner/agents makes one: a create_agent step-up for
 * this label, signed by the owner's wallet as a Sui personal message, read by the route's parser,
 * spent by claimStepUp, then createAgentToken. The token is dropped unread: decide needs only the id.
 */
async function createAgent(ctx: Context, label: string): Promise<AgentSlot> {
  const { db, ownerId } = ctx;
  const change = { label: agentLabel(label) };
  const issued = await issueStepUp({ db, ownerId, appOrigin: DEV_ORIGIN, request: stepUpRequest.parse({ action: 'create_agent', change }), now: new Date() });
  const { signature } = await ctx.ownerKeypair.signPersonalMessage(new TextEncoder().encode(issued.message));
  ctx.secrets.push(signature);
  const { stepUp } = agentCreate.parse({ label: change.label, stepUp: { nonce: issued.nonce, signature } });
  if (stepUp === undefined) throw new EvalError('the agent body lost its step-up');
  await claimStepUp({ db, ownerId, request: { action: 'create_agent', change }, proof: stepUp, zkLoginClient: ctx.chain.grpc, now: new Date() });
  const created = await createAgentToken({ db, ownerId, label: change.label, kind: 'external', sessionSecretHex: ctx.sessionSecretHex, now: new Date() });
  ctx.secrets.push(created.token);
  say(`  Agent "${change.label}" ${created.agentId} created through a signed create_agent step-up (nonce spent by claimStepUp)`);
  return { id: created.agentId, label: change.label, createdHere: true };
}

/** The first agent in the pool that fits, or a new one made through the step-up path. */
async function pickAgent(ctx: Context, pool: AgentSlot[], fits: (agent: AgentSlot) => Promise<boolean>): Promise<AgentSlot> {
  for (const agent of pool) if (await fits(agent)) return agent;
  const agent = await createAgent(ctx, `${AGENT_LABEL_PREFIX} ${pool.length + 1}`);
  pool.push(agent);
  if (!(await fits(agent))) throw new EvalError('a new agent does not fit the row it was made for');
  return agent;
}

type Hits = Array<{ blobId: string; distance: number }>;

interface Citation {
  memoryId: string;
  blobId: string | null;
  distance: number | null;
}

interface RowResult {
  row: LabelRow;
  target: Target;
  unavailable?: string;
  agent?: string;
  decisionId?: string;
  outcome?: 'approved' | 'refused' | 'asked';
  rule?: string;
  reason?: string;
  amountAtomic?: bigint;
  recipient?: string;
  citations: Citation[];
  answerMemoryId?: string;
  earlierRun?: boolean;
  closest?: { approvals: number; nearest: number | null };
  decidedAt?: Date;
}

async function citationsOf(db: Database, ownerId: string, decisionId: string): Promise<Citation[]> {
  const rows = await db
    .select({ memoryId: decisionCitations.memoryId, distance: decisionCitations.distance, blobId: memories.blobId })
    .from(decisionCitations)
    .leftJoin(memories, and(eq(memories.id, decisionCitations.memoryId), eq(memories.ownerId, decisionCitations.ownerId)))
    .where(and(eq(decisionCitations.decisionId, decisionId), eq(decisionCitations.ownerId, ownerId)));
  return rows
    .map((row) => ({ memoryId: row.memoryId, blobId: row.blobId ?? null, distance: row.distance }))
    .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY));
}

/** Of the hits this decision's search returned, the owner approvals of this recipient Ellai wrote: how many sit inside the cutoff, and the nearest distance. */
async function closestApprovals(ctx: Context, hits: Hits, recipient: string, cutoff: number): Promise<{ approvals: number; nearest: number | null }> {
  const blobIds = [...new Set(hits.map((hit) => hit.blobId))];
  if (blobIds.length === 0) return { approvals: 0, nearest: null };
  const rows = await ctx.db
    .select({ blobId: memories.blobId })
    .from(memories)
    .where(
      and(
        eq(memories.ownerId, ctx.ownerId),
        eq(memories.namespace, MEMORY_NAMESPACE),
        eq(memories.kind, 'owner_decision'),
        eq(memories.verdict, 'approve'),
        eq(memories.recipient, recipient),
        eq(memories.writerPublicKey, ctx.delegateHex),
        inArray(memories.blobId, blobIds),
      ),
    );
  const ours = new Set(rows.map((row) => row.blobId));
  const distances = hits.filter((hit) => ours.has(hit.blobId)).map((hit) => hit.distance);
  return { approvals: distances.filter((distance) => distance < cutoff).length, nearest: distances.length === 0 ? null : Math.min(...distances) };
}

/** This row's decision from an earlier run of this script, found by seller URL and purpose among the test agents' decisions. */
async function earlierDecision(ctx: Context, url: string, purpose: string) {
  const [row] = await ctx.db
    .select({ decision: decisions, label: agents.label })
    .from(decisions)
    .innerJoin(agents, and(eq(agents.id, decisions.agentId), eq(agents.ownerId, decisions.ownerId)))
    .where(and(eq(decisions.ownerId, ctx.ownerId), eq(decisions.sellerUrl, url), eq(decisions.purpose, purpose), like(agents.label, `${AGENT_LABEL_PREFIX} %`)))
    .orderBy(desc(decisions.createdAt))
    .limit(1);
  return row;
}

interface Phase {
  pool: AgentSlot[];
  cutoff: number;
  lastAnswerAt: Date | null;
}

/** Steps 3 and 4 for one row: read the 402, pick an agent, decide, and for a learn row that is asked, answer as the label says. */
async function runRow(ctx: Context, phase: Phase, row: LabelRow): Promise<RowResult> {
  const target = targetFor(row);
  const result: RowResult = { row, target, citations: [] };
  const url = targetUrl(target);

  const earlier = await earlierDecision(ctx, url, row.purpose);
  if (earlier !== undefined) {
    const { decision } = earlier;
    Object.assign(result, {
      earlierRun: true,
      agent: earlier.label,
      decisionId: decision.id,
      outcome: decision.outcome,
      rule: decision.rule,
      reason: decision.reason,
      amountAtomic: decision.amountAtomic,
      recipient: decision.recipient,
      decidedAt: decision.createdAt,
    });
  } else {
    const challenge = await readChallenge(ctx, target);
    if (!challenge.ok) {
      result.unavailable = challenge.reason;
      say(`  row ${row.n}: seller unavailable: ${challenge.reason}`);
      return result;
    }
    const { payment } = challenge;
    const agent = await pickAgent(ctx, phase.pool, async (candidate) => {
      if ((await openQuestions(ctx.db, ctx.ownerId, candidate.id)) >= MAX_OPEN_PER_AGENT) return false;
      return row.phase === 'Test' || !(await hasLiveGrant(ctx.db, ctx.ownerId, candidate.id, challenge, new Date()));
    });
    const key = requestKey({ agentId: agent.id, payment, method: challenge.method, bodyHash: challenge.bodyHash, purpose: row.purpose });
    if (await paymentInFlight(ctx.db, ctx.ownerId, key, payment.sellerUrl, new Date())) throw new EvalError(`row ${row.n}: a payment for this request is already in flight`);
    const searches: Hits[] = [];
    const recall: Recall = async (query, limit) => {
      const hits = await ctx.baseRecall(query, limit);
      searches.push(hits);
      return hits;
    };
    const decided = await decide({
      db: ctx.db,
      ownerId: ctx.ownerId,
      agentId: agent.id,
      payment,
      method: challenge.method,
      bodyHash: challenge.bodyHash,
      purpose: row.purpose,
      recall,
      delegatePublicKeyHex: ctx.delegateHex,
      namespace: MEMORY_NAMESPACE,
      now: new Date(),
      clock: () => new Date(),
    });
    Object.assign(result, {
      agent: agent.label,
      decisionId: decided.decisionId,
      outcome: decided.outcome,
      rule: decided.rule,
      reason: decided.reason,
      amountAtomic: payment.amount,
      recipient: payment.recipient,
      earlierRun: decided.reused,
      decidedAt: new Date(),
    });
    const hits = searches.flat();
    if (searches.length > 0) result.closest = await closestApprovals(ctx, hits, payment.recipient, phase.cutoff);
  }
  if (result.decisionId === undefined) throw new EvalError('a decided row has no decision id');
  result.citations = await citationsOf(ctx.db, ctx.ownerId, result.decisionId);

  if (row.phase === 'Learn' && result.outcome === 'asked') {
    const [question] = await ctx.db
      .select({ answer: questions.answer, memoryId: questions.memoryId, answeredAt: questions.answeredAt })
      .from(questions)
      .where(and(eq(questions.decisionId, result.decisionId), eq(questions.ownerId, ctx.ownerId)));
    if (question !== undefined && question.answeredAt !== null && question.memoryId !== null) {
      if (question.answer !== row.label) throw new EvalError(`row ${row.n} was answered ${question.answer} in an earlier run, not as labelled`);
      result.answerMemoryId = question.memoryId;
      if (phase.lastAnswerAt === null || question.answeredAt > phase.lastAnswerAt) phase.lastAnswerAt = question.answeredAt;
    } else {
      const answeredAt = new Date();
      const answered = await answerQuestion({
        db: ctx.db,
        ownerId: ctx.ownerId,
        decisionId: result.decisionId,
        answer: row.label,
        reason: null,
        delegatePublicKeyHex: ctx.delegateHex,
        namespace: MEMORY_NAMESPACE,
        now: answeredAt,
      });
      result.answerMemoryId = answered.memoryId;
      phase.lastAnswerAt = answeredAt;
    }
  }
  const usdc = result.amountAtomic === undefined ? '' : ` ${formatUsdc(result.amountAtomic)} USDC`;
  const answered = result.answerMemoryId === undefined ? '' : `; answered ${row.label}, memory ${result.answerMemoryId}`;
  say(`  row ${row.n}${usdc} [${result.agent}]: ${result.outcome} (${result.rule})${result.earlierRun ? ', from an earlier run' : ''}${answered}`);
  return result;
}

/** Step 3's writes: every learn answer sent to Walrus Memory and confirmed, within fixed ceilings. Returns the seconds waited. */
async function writeAndConfirm(ctx: Context, ids: string[]): Promise<{ waitedS: number; notConfirmed: string[] }> {
  const started = Date.now();
  const { db, ownerId, masterSecretHex } = ctx;
  if (ids.length === 0) return { waitedS: 0, notConfirmed: [] };
  const unsent = async () => {
    const [row] = await db.select({ n: count() }).from(memories).where(and(eq(memories.ownerId, ownerId), inArray(memories.id, ids), eq(memories.status, 'pending'), isNull(memories.jobId)));
    return row?.n ?? 0;
  };
  for (let attempt = 0; (await unsent()) > 0; attempt++) {
    try {
      const sent = await submitPendingMemories({ db, ownerId, masterSecretHex, now: new Date() });
      say(`  submit ${attempt + 1}: ${sent.submitted} memories sent to the relayer`);
    } catch (error) {
      if (!isPassing(error)) throw error;
      say(`  submit ${attempt + 1}: ${failureLabel(error)}`);
    }
    if ((await unsent()) === 0) break;
    if (attempt >= SUBMIT_RETRIES) throw new EvalError(`the learn answers were not all sent after ${SUBMIT_RETRIES + 1} tries`);
    // A pass that failed in passing keeps its rows leased, so the next one waits the lease out.
    say(`  some answers are still unsent; waiting ${(LIMITS.memoryWriteLeaseMs + 10_000) / 1000} s for their lease`);
    await sleep(LIMITS.memoryWriteLeaseMs + 10_000);
  }
  for (let check = 1; ; check++) {
    const rows = await db.select({ id: memories.id, status: memories.status }).from(memories).where(and(eq(memories.ownerId, ownerId), inArray(memories.id, ids)));
    const waiting = rows.filter((row) => row.status === 'pending');
    if (waiting.length === 0 || Date.now() - started >= CONFIRM_CEILING_MS) {
      return { waitedS: Math.round((Date.now() - started) / 1000), notConfirmed: rows.filter((row) => row.status !== 'confirmed').map((row) => row.id) };
    }
    try {
      const pass = await confirmMemoryJobs({ db, ownerId, masterSecretHex, now: new Date() });
      if (pass.confirmed > 0 || pass.failed > 0 || check % 6 === 1) say(`  confirm check ${check}: ${pass.confirmed} confirmed, ${pass.pending} still working, ${pass.failed} failed`);
    } catch (error) {
      if (!isPassing(error)) throw error;
      say(`  confirm check ${check}: ${failureLabel(error)}`);
    }
    await sleep(CONFIRM_DELAY_MS);
  }
}

const cell = (text: string) => text.replace(/\|/g, '/').replace(/\r?\n/g, ' ');
const dist = (distance: number | null) => (distance === null ? 'none' : distance.toFixed(4));

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const startedAt = new Date();
  const labels = readLabels();
  if (!existsSync(DB_DIR)) throw new EvalError('scratchpad/dev-db is missing; nothing was opened');
  const loopBefore = existsSync(LOOP_DB_DIR) ? treeFingerprint(LOOP_DB_DIR) : 'absent';

  say('Ellai learning test from LABELS.md on Sui Mainnet and Walrus Memory. Decides only: nothing is signed or paid.');
  if (existsSync(BACKUP_DIR)) {
    say('Backup scratchpad/dev-db-before-eval is already there from an earlier run: kept as it is, not overwritten.');
  } else {
    cpSync(DB_DIR, BACKUP_DIR, { recursive: true });
    if (treeFingerprint(DB_DIR) !== treeFingerprint(BACKUP_DIR)) throw new EvalError('the backup of dev-db does not match it byte for byte; nothing was opened');
    say('Backup: scratchpad/dev-db copied to scratchpad/dev-db-before-eval and checked byte for byte.');
  }

  const ownerKeypair = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY);
  const ownerAddress = canonicalSuiAddress(ownerKeypair.toSuiAddress());
  const delegateHex = ownerDelegate(config.ELLAI_MASTER_SECRET, ownerAddress).publicKeyHex;
  const payTo = sellerPayTo({ ELLAI_SELLER_PAYTO: config.ELLAI_SELLER_PAYTO, GAS_PRIVATE_KEY: config.GAS_PRIVATE_KEY });
  // The root .env holds no SESSION_SECRET; agent tokens are dropped unread, so a run-only key only salts their stored hashes.
  const sessionSecretHex = config.SESSION_SECRET ?? randomBytes(32).toString('hex');
  const secrets = [config.ELLAI_MASTER_SECRET, config.OWNER_TEST_PRIVATE_KEY, config.GAS_PRIVATE_KEY, config.TATUM_API_KEY, sessionSecretHex, 'suiprivkey'];

  const handle = await createDb(`pglite:${DB_DIR}`);
  const chain = createChain({ apiKey: config.TATUM_API_KEY, beforeRequest: paced(tatumMeter(handle.db, () => new Date())) });
  const problems: string[] = [];
  let resultsText = '';
  try {
    const { db } = handle;
    await migrate(db);
    const [owner] = await db.select().from(owners).where(eq(owners.suiAddress, ownerAddress));
    if (owner === undefined) throw new EvalError('the test owner is not in scratchpad/dev-db');
    const ownerId = owner.id;
    const [paymentsBefore] = await db.select({ n: count() }).from(payments);
    const [refillsBefore] = await db.select({ n: count() }).from(refills);

    say('\n1. Owner, settings and agent');
    say(`  Test owner ${ownerAddress.slice(0, 10)}...${ownerAddress.slice(-3)}, Walrus Memory account ${owner.memwalAccountId}`);
    const settings = `approvals needed ${owner.approvalsNeeded}, distance cutoff ${owner.distanceCutoff}, per-payment max ${formatUsdc(owner.perPaymentMaxAtomic)} USDC, daily budget ${formatUsdc(owner.dailyBudgetAtomic)} USDC, paused ${owner.paused || owner.autoPausedReason !== null ? 'yes' : 'no'}`;
    say(`  Settings, left as they are: ${settings}`);
    const ctx: Context = {
      db,
      chain,
      ownerId,
      ownerAddress,
      ownerKeypair,
      masterSecretHex: config.ELLAI_MASTER_SECRET,
      delegateHex,
      sessionSecretHex,
      payTo,
      baseRecall: makeRecall({ owner: { suiAddress: ownerAddress, memwalAccountId: owner.memwalAccountId }, masterSecretHex: config.ELLAI_MASTER_SECRET, namespace: MEMORY_NAMESPACE }),
      secrets,
    };
    const live = await db
      .select({ id: agents.id, label: agents.label })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.kind, 'external'), isNull(agents.revokedAt)))
      .orderBy(asc(agents.createdAt));
    const phase: Phase = { pool: live.map((agent) => ({ ...agent, createdHere: false })), cutoff: owner.distanceCutoff, lastAnswerAt: null };
    say(`  Live external agents already there: ${live.length}`);
    if (phase.pool.length === 0) phase.pool.push(await createAgent(ctx, `${AGENT_LABEL_PREFIX} 1`));

    say('\n2 and 3. Learn rows 1 to 12: real 402, decide, and the owner answers as labelled when Ellai asks');
    const results: RowResult[] = [];
    for (const row of labels.filter((candidate) => candidate.phase === 'Learn')) results.push(await runRow(ctx, phase, row));

    say('\n3. The learn answers written to Walrus Memory and confirmed');
    const answerIds = results.flatMap((result) => (result.answerMemoryId === undefined ? [] : [result.answerMemoryId]));
    const written = await writeAndConfirm(ctx, answerIds);
    say(`  ${answerIds.length - written.notConfirmed.length} of ${answerIds.length} confirmed after ${written.waitedS} s`);
    if (written.notConfirmed.length > 0) problems.push(`${written.notConfirmed.length} learn answers were not confirmed within ${CONFIRM_CEILING_MS / 60_000} minutes`);
    say(`  Waiting ${INDEX_WAIT_MS / 1000} s for the relayer's search index`);
    await sleep(INDEX_WAIT_MS);
    const clearAt = phase.lastAnswerAt === null ? 0 : phase.lastAnswerAt.getTime() + GRANT_CLEAR_MS;
    if (clearAt > Date.now()) {
      say(`  Waiting ${Math.ceil((clearAt - Date.now()) / 1000)} s more, until ${GRANT_CLEAR_MS / 1000} s after the last learn answer, so no grant is left to approve a test row`);
      await sleep(clearAt - Date.now());
    }
    const testStartedAt = new Date();
    const grantsLeft = await liveGrantsForOwner(db, ownerId, testStartedAt);
    if (grantsLeft > 0) throw new EvalError(`${grantsLeft} grants are still live at the start of the test phase`);
    say(`  Test phase starts ${testStartedAt.toISOString()}; live grants for the owner: 0`);

    say('\n4. Test rows 13 to 24: decide only, never answered, never paid');
    for (const row of labels.filter((candidate) => candidate.phase === 'Test')) results.push(await runRow(ctx, phase, row));

    say('\n5. Blob scan for the test owner (confirmBlobsOnChain), in a jobs Tatum scope');
    const notOnChain = async () => {
      if (answerIds.length === 0) return [];
      const rows = await db
        .select({ id: memories.id })
        .from(memories)
        .where(and(eq(memories.ownerId, ownerId), inArray(memories.id, answerIds), eq(memories.status, 'confirmed'), isNull(memories.chainConfirmedAt)));
      return rows.map((row) => row.id);
    };
    const scans: string[] = [];
    for (let scan = 0; ; scan++) {
      try {
        const found = await withTatumScope({ kind: 'jobs', ownerId }, () => confirmBlobsOnChain({ db, chain, ownerId, now: new Date() }));
        scans.push(`scan ${scan + 1}: ${found.confirmed} of ${found.checked} waiting memories found on chain`);
      } catch (error) {
        scans.push(`scan ${scan + 1}: ${failureLabel(error)}`);
      }
      say(`  ${scans.at(-1)}`);
      const missing = await notOnChain();
      if (missing.length === 0 || scan >= BLOB_RECHECKS) {
        if (missing.length > 0) problems.push(`${missing.length} confirmed learn answers were not found on chain after ${scan + 1} scans`);
        break;
      }
      say(`  ${missing.length} not found yet; scanning again in ${BLOB_RECHECK_DELAY_MS / 1000} s`);
      await sleep(BLOB_RECHECK_DELAY_MS);
    }
    let blobObjects: WalrusBlob[] = [];
    try {
      blobObjects = await withTatumScope({ kind: 'jobs', ownerId }, () => chain.listOwnedWalrusBlobs(ownerAddress));
    } catch (error) {
      say(`  Blob objects for the links could not be listed: ${failureLabel(error)}`);
    }
    const objectOf = new Map(blobObjects.map((blob) => [blob.blobId, blob.objectId]));

    say('\n6. Score');
    const tests = results.filter((result) => result.row.phase === 'Test');
    const decided = tests.filter((result) => result.unavailable === undefined);
    const badPayments = decided.filter((result) => result.row.label === 'refuse' && result.outcome === 'approved');
    const approveRows = tests.filter((result) => result.row.label === 'approve');
    const saved = approveRows.filter((result) => result.outcome === 'approved' && result.rule === 'learned');
    const byGrant = decided.filter((result) => result.outcome === 'approved' && result.rule === 'grant');
    const asked = decided.filter((result) => result.outcome === 'asked');
    const refused = decided.filter((result) => result.outcome === 'refused');
    const unavailable = results.filter((result) => result.unavailable !== undefined);
    const learnNotAsked = results.filter((result) => result.row.phase === 'Learn' && result.unavailable === undefined && result.outcome !== 'asked');
    say(`  Bad payments let through: ${badPayments.length}`);
    say(`  Questions saved: ${saved.length} of ${approveRows.length} test rows labelled approve, approved by rule learned`);
    say(`  Test rows asked ${asked.length}, refused ${refused.length}, approved by grant (harness error) ${byGrant.length}; seller unavailable in any phase ${unavailable.length}`);
    if (badPayments.length > 0) problems.push(`${badPayments.length} bad payments let through`);
    if (byGrant.length > 0) problems.push(`${byGrant.length} test rows were approved by grant, a harness error`);

    const [paymentsAfter] = await db.select({ n: count() }).from(payments);
    const [refillsAfter] = await db.select({ n: count() }).from(refills);
    const paymentsLine = `payments rows ${paymentsBefore?.n ?? 0} before, ${paymentsAfter?.n ?? 0} after; refills rows ${refillsBefore?.n ?? 0} before, ${refillsAfter?.n ?? 0} after`;
    say(`  ${paymentsLine}`);
    if (paymentsAfter?.n !== paymentsBefore?.n) problems.push('a payments row was created by this run');
    if (refillsAfter?.n !== refillsBefore?.n) problems.push('a refills row was created by this run');

    const map = await readMemoryMap(db, new Date());
    const mapSummary = { generatedAt: map.generatedAt, memories: map.memories.length, decisions: map.decisions.length, totals: map.totals };
    say(`  readMemoryMap: ${JSON.stringify(mapSummary)}`);

    const memoryRows =
      answerIds.length === 0
        ? []
        : await db.select({ id: memories.id, blobId: memories.blobId, status: memories.status, onChain: memories.chainConfirmedAt }).from(memories).where(inArray(memories.id, answerIds));
    const memoryOf = new Map(memoryRows.map((row) => [row.id, row]));
    const blobLink = (blobId: string | null) => {
      if (blobId === null) return 'no blob';
      const objectId = objectOf.get(blobId);
      return objectId === undefined ? `blob ${blobId}` : `[blob ${blobId}](${SUISCAN_OBJECT}${objectId})`;
    };
    const agentsMade = phase.pool.filter((agent) => agent.createdHere).map((agent) => `${agent.label} (${agent.id})`);
    const testAgents = [...new Set(tests.flatMap((result) => (result.agent === undefined ? [] : [result.agent])))];
    const learnAgents = [...new Set(results.filter((result) => result.row.phase === 'Learn').flatMap((result) => (result.agent === undefined ? [] : [result.agent])))];
    const endedAt = new Date();
    const prediction: Record<number, string> = {
      18: 'Refused on the per-payment limit alone (0.25 USDC is over the 0.05 USDC default).',
      22: 'Asked, not approved: Ellai never trusts a seller it has not seen approved before.',
      24: 'Refused without asking, because the refusal in row 10 wins.',
    };
    const actual = (result: RowResult | undefined) =>
      result === undefined ? 'not run' : result.unavailable !== undefined ? `seller unavailable: ${result.unavailable}` : `${result.outcome} (${result.rule}): "${result.reason}"`;
    const rowFor = (n: number) => results.find((result) => result.row.n === n);

    const lines: string[] = [];
    lines.push('# Ellai learning test: results', '');
    lines.push(
      `Run from ${startedAt.toISOString()} to ${endedAt.toISOString()} by packages/web/scripts/learning-eval.ts, against Sui Mainnet and the hosted Walrus Memory relayer, on scratchpad/dev-db (backup in scratchpad/dev-db-before-eval). The answers are Ram's, read from LABELS.md at run time.`,
      '',
    );
    lines.push('## Scores', '');
    lines.push(`- **Bad payments let through: ${badPayments.length}.** Test rows labelled refuse that Ellai approved. The refuse rows were decided as: ${tests.filter((result) => result.row.label === 'refuse').map((result) => `row ${result.row.n} ${actual(result)}`).join('; ')}.`);
    lines.push(`- **Questions saved: ${saved.length} of ${approveRows.length}.** Test rows labelled approve that Ellai approved on its own by rule learned${saved.length > 0 ? ` (rows ${saved.map((result) => result.row.n).join(', ')})` : ''}.`);
    lines.push(`- Test rows asked: ${asked.length}${asked.length > 0 ? ` (rows ${asked.map((result) => result.row.n).join(', ')})` : ''}. Refused: ${refused.length}${refused.length > 0 ? ` (rows ${refused.map((result) => result.row.n).join(', ')})` : ''}. Approved by grant, a harness error: ${byGrant.length}. Seller unavailable: ${unavailable.length}.`);
    lines.push(`- No payment was signed and no money moved: ${paymentsLine}. Every decision here was decide only; no paid request was sent, and no jobs tick, settlement pass or refill ran.`, '');
    lines.push('## How it ran', '');
    lines.push(`- Test owner ${ownerAddress}, Walrus Memory account ${owner.memwalAccountId}. Settings left as they are: ${settings}.`);
    lines.push(`- Ellai's own wallet check was issued in process through handleWalletCheck at ${WALLET_CHECK_ORIGIN}/api/sell/wallet-check, standing in for the deployed seller, because parseChallenge reads only https sellers with no port. Same recipient (the gas wallet unless ELLAI_SELLER_PAYTO is set) and the same 0.01 USDC price. Its body is the agent catalog's documented example.`);
    lines.push('- Every other row used the URL, method and body KNOWN_SELLERS documents, fetched with safeFetch and read with parseChallenge and checkPayable, as pay/flow.ts does up to decide.');
    lines.push(`- Agents made through the signed create_agent step-up in this run: ${agentsMade.length === 0 ? 'none' : agentsMade.join(', ')}. Learn rows ran on ${learnAgents.join(', ')}: a learn row moved to another agent whenever its own agent held a live grant for the same seller URL, body and recipient, so every learn row was a fresh question and no earlier answer's grant could approve it. Test rows ran on ${testAgents.join(', ')}, moving to the next agent before any agent held ${MAX_OPEN_PER_AGENT} open questions. Learned trust is per owner, so the agent never changes a learned decision.`);
    lines.push(`- Learn answers: ${answerIds.length} written to Walrus Memory with the delegate key; ${answerIds.length - written.notConfirmed.length} confirmed after ${written.waitedS} s of waiting (ceiling ${CONFIRM_CEILING_MS / 60_000} minutes), then ${INDEX_WAIT_MS / 1000} s for the search index.`);
    lines.push(`- Last learn answer at ${phase.lastAnswerAt?.toISOString() ?? 'none'}; the test phase started at ${testStartedAt.toISOString()}, at least ${GRANT_CLEAR_MS / 1000} s later, with 0 live grants.`);
    lines.push(`- Blob scan (confirmBlobsOnChain, jobs Tatum scope): ${scans.join('; ')}.`, '');
    lines.push('## Rows', '');
    lines.push('| # | Phase | Seller | Label | Outcome | Rule | Reason | Citations (blob, distance) | Links and notes |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const result of results) {
      const { row } = result;
      const seller = `${result.target.name}, ${targetUrl(result.target)}${result.amountAtomic === undefined ? '' : `, ${formatUsdc(result.amountAtomic)} USDC`}`;
      const citations = result.citations.length === 0 ? 'none' : result.citations.map((citation) => `${citation.blobId ?? `memory ${citation.memoryId} (no blob)`} at ${dist(citation.distance)}`).join('; ');
      const notes: string[] = [];
      if (result.agent !== undefined) notes.push(result.agent);
      if (result.earlierRun) notes.push('decided in an earlier run');
      if (result.answerMemoryId !== undefined) {
        const memory = memoryOf.get(result.answerMemoryId);
        notes.push(`owner answered ${row.label}: ${blobLink(memory?.blobId ?? null)}, ${memory?.status ?? 'missing'}${memory?.onChain ? ', found on chain' : ', not found on chain'}`);
      }
      if (row.phase === 'Learn' && result.outcome === 'approved' && result.rule === 'learned') notes.push('already learned, no owner answer');
      if (result.citations.length > 0) notes.push(result.citations.map((citation) => blobLink(citation.blobId)).join(', '));
      if (result.outcome === 'asked' && result.closest !== undefined) notes.push(`same-recipient approvals in this search: ${result.closest.approvals} inside the cutoff, nearest ${dist(result.closest.nearest)}`);
      if (prediction[row.n] !== undefined) notes.push(`LABELS.md predicts: ${prediction[row.n]}`);
      const outcome = result.unavailable === undefined ? (result.outcome ?? '') : 'seller unavailable';
      const reason = result.unavailable ?? result.reason ?? '';
      lines.push(`| ${row.n} | ${row.phase} | ${cell(seller)} | ${row.label} | ${outcome} | ${result.rule ?? ''} | ${cell(reason)} | ${cell(citations)} | ${cell(notes.join('. '))} |`);
    }
    lines.push('', '## Honest notes', '');
    for (const n of [18, 22, 24]) lines.push(`- Row ${n}. LABELS.md predicts: ${prediction[n]} Actual: ${actual(rowFor(n))}.`);
    lines.push(
      '- Row 22 uses AgentProof /mcp. No live 0.01 USDC seller has a recipient Ellai has not seen: /mcp is paid to the same address as AgentProof preflight and mcp-verify (rows 8 and 9), and JMPR flights to the same address as JMPR hotels. So row 22 tests a new seller URL with a known recipient. Trust follows the recipient (C2), so an approval there is by design, not a learning error.',
    );
    lines.push(`- Seller unavailable: ${unavailable.length === 0 ? 'none' : unavailable.map((result) => `row ${result.row.n} (${result.unavailable})`).join('; ')}.`);
    lines.push(`- Learn rows that did not ask: ${learnNotAsked.length === 0 ? 'none' : learnNotAsked.map((result) => `row ${result.row.n} ${result.outcome} (${result.rule})${result.rule === 'learned' ? ', already learned' : ''}`).join('; ')}.`);
    const missedLearned = approveRows.filter((result) => result.unavailable === undefined && !(result.outcome === 'approved' && result.rule === 'learned'));
    lines.push(
      `- Test rows labelled approve that Ellai did not approve on its own: ${missedLearned.length === 0 ? 'none' : missedLearned.map((result) => `row ${result.row.n} ${result.outcome} (${result.rule})${result.closest === undefined ? '' : `, ${result.closest.approvals} same-recipient approvals inside the cutoff, nearest ${dist(result.closest.nearest)}`}`).join('; ')}.`,
    );
    if (problems.length > 0) lines.push(`- Problems found by the run: ${problems.join('; ')}.`);
    lines.push('', '## Memory map summary (readMemoryMap)', '', '```json', JSON.stringify(mapSummary, null, 2), '```', '');
    resultsText = lines.join('\n');
  } finally {
    await handle.close();
    chain.close();
  }

  const loopAfter = existsSync(LOOP_DB_DIR) ? treeFingerprint(LOOP_DB_DIR) : 'absent';
  say(`\nscratchpad/loop-db ${loopAfter === loopBefore ? 'untouched: the same bytes before and after' : 'CHANGED during the run'}`);
  if (loopAfter !== loopBefore) problems.push('scratchpad/loop-db changed during the run');
  if (!existsSync(BACKUP_DIR)) problems.push('scratchpad/dev-db-before-eval is missing');

  const leaked = secrets.filter((secret) => printed.join('\n').includes(secret) || resultsText.includes(secret)).length;
  say(`Leak check: ${leaked === 0 ? 'no key, token or signature in the output or the results file' : `${leaked} secret values found`}`);
  if (leaked > 0) {
    problems.push('a secret value appears in the output');
  } else {
    writeFileSync(RESULTS_PATH, resultsText, 'utf8');
    say(`Results written to LABELS-RESULTS.md (${resultsText.split('\n').length} lines)`);
  }

  if (problems.length > 0) {
    say(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    say('\nDONE: every row decided against real sellers, the learn answers confirmed on Walrus Memory, the test rows scored, and no payment or refill row created.');
  }
}

withTatumScope({ kind: 'jobs' }, main).catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
