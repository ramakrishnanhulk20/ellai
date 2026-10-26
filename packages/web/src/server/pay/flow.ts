import { createHash } from 'node:crypto';
import { type Chain, ChainError } from '@ellai/core/chain';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { NetError, type SafeRequest, type SafeResponse, type safeFetch } from '@ellai/core/net';
import { PaymentError, checkPayable, paymentHeader } from '@ellai/core/payment';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { SELLER_METHODS, TEXT_CAPS, agents, decisions, memories, owners, payments } from '../db/schema.js';
import { DecideError, type DecideErrorCode, type DecideResult, type Recall, decide } from '../decide/decide.js';
import { formatUsdc, hostLabel, requestKey } from '../decide/sentences.js';
import { ownerDelegate } from '../memory/delegate.js';
import { MEMORY_NAMESPACE } from '../memory/namespace.js';
import { recordOutcome } from '../memory/outcome.js';
import { type PaidFetchResult, bare, isPlainContentType, sellerAnswer } from './result.js';
import { settlePayment } from './settle.js';
import { type SignRefusal, type SignResult, paidTimeoutMs, paymentInFlight, signForDecision } from './sign.js';

export type RecallFn = Recall;

/** The owner fields a recall needs: the owner's own Walrus Memory account and address. */
export interface RecallOwner {
  suiAddress: string;
  memwalAccountId: string | null;
}

export interface PaidFetchArgs {
  db: Database;
  ownerId: string;
  agentId: string;
  url: string;
  method: 'GET' | 'POST';
  body: string | null;
  contentType: string | null;
  purpose: string;
  /** An absolute time in epoch ms the call's own deadline may not pass, for a caller with a deadline of its own. */
  deadlineAt?: number;
  secrets: { masterSecretHex: string };
  deps: {
    fetch: typeof safeFetch;
    chain: Chain;
    recallFor: (owner: RecallOwner) => RecallFn;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
  };
}

const HTTP_PAYMENT_REQUIRED = 402;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASONS = {
  notAllowed: 'This agent is not allowed to pay for this account.',
  method: 'Ellai sends only GET and POST requests to sellers.',
  url: `The seller URL must be text of at most ${TEXT_CAPS.sellerUrl} characters.`,
  getWithBody: 'A GET request to a seller cannot carry a body.',
  body: `The request body must be text of at most ${LIMITS.challengeMaxBytes} bytes.`,
  contentType: 'Ellai forwards only a plain content type, such as application/json.',
  purpose: `The purpose must be 1 to ${LIMITS.purposeMaxChars} characters.`,
  free: 'This seller answered without asking for payment.',
  dialect: "Ellai cannot pay this seller's payment format yet.",
  inProgress: 'A payment for this same request is already in progress.',
  requestMismatch: 'An earlier decision under this request key is for a different request, so Ellai did not pay.',
  chain: 'Ellai could not read Sui just now, so it did not pay.',
  deadline: 'Too little time was left to pay this seller and still answer in time, so Ellai did not pay.',
} as const;

interface SignRefusalAnswer {
  outcome: 'refused' | 'failed';
  status: 'refused' | 'failed';
  reason: string;
}

const SIGN_REFUSALS: Record<Exclude<SignRefusal, 'over_payment_max' | 'refused_recipient'>, SignRefusalAnswer> = {
  // The same answer loadParty gives a revoked agent, so it learns nothing from when it was revoked (C13).
  agent_revoked: { outcome: 'refused', status: 'refused', reason: REASONS.notAllowed },
  // decide's own sentence for its paused rule, so the agent reads one reason whichever check caught it.
  paused: { outcome: 'refused', status: 'refused', reason: 'Automatic payments are paused for this account.' },
  over_daily_budget: { outcome: 'refused', status: 'refused', reason: 'This payment would take the last 24 hours past your daily budget.' },
  purse_short: { outcome: 'failed', status: 'failed', reason: "This account's purse does not hold enough USDC for this payment right now." },
  expired: { outcome: 'failed', status: 'failed', reason: "The seller's price expired before Ellai could pay it." },
  wrong_epoch: { outcome: 'failed', status: 'failed', reason: "The seller's price is not valid on Sui right now, so Ellai did not pay it." },
  not_open: { outcome: 'failed', status: 'failed', reason: 'This decision can no longer be paid.' },
  in_flight: { outcome: 'failed', status: 'failed', reason: REASONS.inProgress },
};

function signRefusal(refused: Exclude<SignResult, { signed: unknown }>, payment: CanonicalPayment): SignRefusalAnswer {
  // decide's own sentence for its refusal rule, naming the seller as decide names it.
  if (refused.refusal === 'refused_recipient') {
    return { outcome: 'refused', status: 'refused', reason: `You refused payments to ${hostLabel(payment.sellerHost)} before.` };
  }
  if (refused.refusal !== 'over_payment_max') return SIGN_REFUSALS[refused.refusal];
  // decide's own sentence for its per-payment maximum rule, naming the maximum checked at signing.
  const reason = `This payment of ${formatUsdc(payment.amount)} USDC is over your limit of ${formatUsdc(refused.perPaymentMaxAtomic)} USDC per payment.`;
  return { outcome: 'refused', status: 'refused', reason };
}

const DECIDE_REFUSALS: Partial<Record<DecideErrorCode, string>> = {
  OWNER: REASONS.notAllowed,
  AGENT: REASONS.notAllowed,
  BAD_PURPOSE: REASONS.purpose,
  REQUEST_MISMATCH: REASONS.requestMismatch,
};

interface Party {
  ownerId: string;
  agentId: string;
  suiAddress: string;
  memwalAccountId: string | null;
}

interface Checked {
  url: string;
  method: 'GET' | 'POST';
  body: string | null;
  contentType: string | null;
}

// One answer for an unknown owner, an unknown agent, another owner's agent and a revoked one,
// so a caller learns nothing about records it does not hold (C13).
async function loadParty(db: Database, ownerIdRaw: unknown, agentIdRaw: unknown): Promise<Party | null> {
  if (typeof ownerIdRaw !== 'string' || !UUID.test(ownerIdRaw) || typeof agentIdRaw !== 'string' || !UUID.test(agentIdRaw)) return null;
  const ownerId = ownerIdRaw.toLowerCase();
  const agentId = agentIdRaw.toLowerCase();
  const [row] = await db
    .select({ suiAddress: owners.suiAddress, memwalAccountId: owners.memwalAccountId })
    .from(owners)
    .innerJoin(agents, and(eq(agents.ownerId, owners.id), eq(agents.id, agentId), isNull(agents.revokedAt)))
    .where(eq(owners.id, ownerId));
  return row === undefined ? null : { ownerId, agentId, ...row };
}

function checkRequest(args: PaidFetchArgs): Checked | string {
  const { url, method, body, contentType, purpose } = args;
  if (!(SELLER_METHODS as readonly string[]).includes(method)) return REASONS.method;
  if (typeof url !== 'string' || url.length > TEXT_CAPS.sellerUrl) return REASONS.url;
  if (body !== null && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > LIMITS.challengeMaxBytes)) return REASONS.body;
  if (method === 'GET' && body !== null) return REASONS.getWithBody;
  if (contentType !== null && (typeof contentType !== 'string' || !isPlainContentType(contentType))) return REASONS.contentType;
  // Counted as decide counts it: trimmed, in code points.
  const length = typeof purpose === 'string' ? Array.from(purpose.trim()).length : 0;
  if (length === 0 || length > LIMITS.purposeMaxChars) return REASONS.purpose;
  return { url, method, body, contentType };
}

/** The agent's request as it goes to the seller: only its own content type and body, and Ellai's payment header when paying (C20). */
function sellerRequest(request: Checked, extraHeaders: Record<string, string>, timeoutMs?: number): SafeRequest {
  return {
    method: request.method,
    headers: { ...(request.contentType === null ? {} : { 'content-type': request.contentType }), ...extraHeaders },
    ...(request.body === null ? {} : { body: request.body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** The cited memories with their Walrus blob ids, in the order decide cited them, owner-scoped. */
async function citations(db: Database, ownerId: string, ids: string[]): Promise<PaidFetchResult['citedMemories']> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: memories.id, blobId: memories.blobId })
    .from(memories)
    .where(and(eq(memories.ownerId, ownerId), inArray(memories.id, ids)));
  const blobs = new Map(rows.map((row) => [row.id, row.blobId]));
  return ids.flatMap((id) => (blobs.has(id) ? [{ memoryId: id, blobId: blobs.get(id) ?? null }] : []));
}

// The seller may already hold a payment once its header has left, so a failure in a step after
// that is no reason to tell the agent anything but 'paid'. The step is left undone, and only its
// name is logged, since an error's text can carry SQL and bound values (C19).
async function afterPayment<T>(step: 'seller_status' | 'settlement' | 'outcome', run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    console.error(`[ellai pay] after_payment_failed ${step}`);
    return undefined;
  }
}

/**
 * How long the paid request may wait: the seller's patience, cut so the request ends
 * LIMITS.paidRequestMarginMs before the deadline. Null when that leaves less than safeFetch's
 * shortest wait, or the clock cannot be read, because then the payment must not be signed.
 */
function paidWaitMs(sellerUrl: string, deadlineMs: number, now: Date): number | null {
  const wait = Math.min(paidTimeoutMs(sellerUrl), deadlineMs - now.getTime() - LIMITS.paidRequestMarginMs);
  // Written so NaN fails the comparison.
  return wait >= LIMITS.netTimeoutMinMs ? wait : null;
}

/**
 * The wait the paid request is sent with, measured again once signing, which reads Sui, is done.
 * It never drops below safeFetch's shortest wait: the payment is signed by then, and one never
 * sent would hold the daily budget until its epoch window closed.
 */
function sendWaitMs(plannedMs: number, deadlineMs: number, now: Date): number {
  const left = deadlineMs - now.getTime() - LIMITS.paidRequestMarginMs;
  if (!(left >= LIMITS.netTimeoutMinMs)) return LIMITS.netTimeoutMinMs;
  return Math.min(plannedMs, left);
}

/**
 * The chain and the wait settlePayment gets inside a paid call, which reads the chain through
 * these two calls only. No read starts once the deadline has passed, and a wait that would end
 * at or past it is not taken, which stops every read after it. settlePayment counts a read that
 * was not made as one that failed and answers 'pending', which the jobs tick reads again.
 */
function untilDeadline(chain: Chain, now: () => Date, sleep: (ms: number) => Promise<void>, deadlineMs: number): { chain: Chain; sleep: (ms: number) => Promise<void> } {
  let stopped = false;
  const open = () => !stopped && now().getTime() < deadlineMs;
  const closed = () => Promise.reject(new ChainError('TIMEOUT', 'the paid call deadline has passed'));
  return {
    chain: {
      ...chain,
      getTransactionResult: (digest: string) => (open() ? chain.getTransactionResult(digest) : closed()),
      getCurrentEpoch: () => (open() ? chain.getCurrentEpoch() : closed()),
    },
    sleep: async (ms: number) => {
      if (now().getTime() + ms >= deadlineMs) stopped = true;
      else await sleep(ms);
    },
  };
}

async function closeDecision(db: Database, ownerId: string, decisionId: string, status: 'failed' | 'refused'): Promise<void> {
  await db
    .update(decisions)
    .set({ status })
    .where(and(eq(decisions.id, decisionId), eq(decisions.ownerId, ownerId), eq(decisions.status, 'open')));
}

/**
 * Fetches a seller URL for an agent and, when the seller asks for payment and Ellai's rules
 * allow it, pays from the owner's purse and hands back the seller's answer. Every call has a
 * deadline LIMITS.paidFetchDeadlineMs after it starts, or `deadlineAt` when that is earlier, so
 * it answers inside the route's time and inside a caller's own deadline.
 *
 * 1. The agent must be an active agent of this owner, else 'refused'. The method must be GET
 *    or POST, the URL at most TEXT_CAPS.sellerUrl characters, the body at most
 *    LIMITS.challengeMaxBytes bytes (and absent on GET), the content type a plain media type,
 *    and the purpose 1 to LIMITS.purposeMaxChars characters once trimmed, else 'refused'.
 * 2. The unpaid request goes through deps.fetch (safeFetch, C20). A NetError is 'failed'.
 * 3. Any answer but 402 is 'free': the answer goes back and no decision is recorded.
 * 4. parseChallenge reads the 402 into one canonical payment; a ChallengeError is 'refused'
 *    with no decision recorded (C1, C3). So is a payment core's checkPayable refuses: any
 *    dialect but x402-v1-t2000, the only one Ellai can sign, or a payment that lacks the t2000
 *    binding fields or carries an epoch window Sui would refuse, so the owner is never asked
 *    about a payment Ellai would then refuse to sign.
 * 5. When this owner already signed the same request (same request key) and that payment may
 *    still be under way (see paymentInFlight), the result is 'failed' and neither decide nor
 *    signing runs (C5).
 * 6. decide runs on the payment, the method, the SHA-256 of the body and the purpose, with
 *    the owner's derived delegate key and recall. Refused and asked come back as decided. A
 *    live decision reused for the same request never pays: an asked one comes back as asked,
 *    an approved one is 'failed' because its payment is already under way (C5).
 * 7. The paid request may wait the seller's own patience (paidTimeoutMs), cut so it ends
 *    LIMITS.paidRequestMarginMs (10 s) before the deadline. When that leaves less than
 *    LIMITS.netTimeoutMinMs, the result is 'failed' with a fixed reason and the decision is
 *    closed as 'failed' before anything is signed or sent (C21).
 * 8. signForDecision checks the agent is still active, the pause, the per-payment maximum, an
 *    owner refusal of the recipient, a payment already under way for the same request (step 5's
 *    check again), the budget and the purse under the owner lock and signs at that moment (C4,
 *    C5, C6, C7, C8, C11, C13). A refusal there, or a chain or build failure, is 'refused' (a
 *    revoked agent, with step 1's reason; paused, over the maximum or a refused recipient, with
 *    decide's own reasons for those rules; or over the daily budget) or
 *    'failed' (a payment already in progress gets step 5's reason), and the decision is closed
 *    as 'refused' or 'failed' so the request can be decided again.
 * 9. The paid request is the same request plus the payment header, with step 7's wait measured
 *    again after signing and never below LIMITS.netTimeoutMinMs. Its status, or null when it
 *    never answered, is stored with the payment, and so is delivered: true for a 2xx answer,
 *    false for any other answer or none, with outcome_at set to the time of that write, read
 *    while the write holds the owner row FOR UPDATE (C26, C32). delivered stays null only when
 *    that write fails.
 * 10. settlePayment reads the chain by Ellai's digest, up to LIMITS.settlementInlineTries times
 *    (C8), as an inline pass: it verifies or records a mismatch, and never releases a payment,
 *    which only the jobs tick's passes may do (C4, C27). No read starts once the deadline has
 *    passed, and no wait runs past it; the payment is then reported 'pending', and the jobs tick
 *    reads it again.
 * 11. A verified payment stored as delivered false becomes an outcome memory. One whose delivered
 *    could not be stored does not; the jobs tick redoes an outcome that failed here.
 *    Once signed material has left, the result is 'paid' with its payment block whatever the
 *    seller did, and whatever fails after it: a failed status write, settlement read or outcome
 *    memory is logged by step name and left undone, and a settlement that was not read is
 *    reported as 'pending'.
 *
 * Every reason is Ellai's own fixed text (C17). Throws only for failures that are not about
 * this request, and only before the payment header leaves: a database error, a master secret
 * that is not 64 hex characters.
 */
export async function paidFetch(args: PaidFetchArgs): Promise<PaidFetchResult> {
  const { db, deps } = args;
  const ownDeadlineMs = deps.now().getTime() + LIMITS.paidFetchDeadlineMs;
  // Math.min passes NaN on, so a deadlineAt that is not a number leaves too little time and nothing is signed.
  const deadlineMs = args.deadlineAt === undefined ? ownDeadlineMs : Math.min(ownDeadlineMs, args.deadlineAt);
  const party = await loadParty(db, args.ownerId, args.agentId);
  if (party === null) return bare('refused', REASONS.notAllowed);
  const request = checkRequest(args);
  if (typeof request === 'string') return bare('refused', request);
  const { ownerId } = party;

  let unpaid: SafeResponse;
  try {
    unpaid = await deps.fetch(request.url, sellerRequest(request, {}));
  } catch (error) {
    if (error instanceof NetError) return bare('failed', `Ellai could not reach this seller safely (${error.code}).`);
    throw error;
  }
  if (unpaid.status !== HTTP_PAYMENT_REQUIRED) return { ...bare('free', REASONS.free), seller: sellerAnswer(unpaid) };

  let payment: CanonicalPayment;
  try {
    payment = parseChallenge(unpaid, deps.now().getTime());
  } catch (error) {
    if (error instanceof ChallengeError) return bare('refused', `Ellai could not read this seller's price safely (${error.code}).`);
    throw error;
  }
  try {
    checkPayable(payment);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    return bare('refused', error.code === 'UNSUPPORTED_DIALECT' ? REASONS.dialect : `Ellai cannot pay this kind of payment request (${error.code}).`);
  }
  const bodyHash = createHash('sha256')
    .update(request.body ?? '', 'utf8')
    .digest('hex');
  // Built from the same normalised parts decide builds it from (the lowercased agent id, the
  // trimmed purpose), so this finds exactly the decisions decide would match.
  const key = requestKey({ agentId: party.agentId, payment, method: request.method, bodyHash, purpose: args.purpose.trim() });
  if (await paymentInFlight(db, ownerId, key, payment.sellerUrl, deps.now())) return bare('failed', REASONS.inProgress);

  const delegate = ownerDelegate(args.secrets.masterSecretHex, party.suiAddress);
  let decided: DecideResult;
  try {
    decided = await decide({
      db,
      ownerId,
      agentId: party.agentId,
      payment,
      method: request.method,
      bodyHash,
      purpose: args.purpose,
      recall: deps.recallFor({ suiAddress: party.suiAddress, memwalAccountId: party.memwalAccountId }),
      delegatePublicKeyHex: delegate.publicKeyHex,
      namespace: MEMORY_NAMESPACE,
      now: deps.now(),
      clock: deps.now,
    });
  } catch (error) {
    const reason = error instanceof DecideError ? DECIDE_REFUSALS[error.code] : undefined;
    if (reason === undefined) throw error;
    return bare('refused', reason);
  }
  const { decisionId } = decided;
  const recorded = { decisionId, rule: decided.rule, citedMemories: await citations(db, ownerId, decided.citedMemoryIds) };
  if (decided.reused && decided.outcome === 'approved') return { ...bare('failed', REASONS.inProgress), ...recorded };
  if (decided.outcome !== 'approved') return { ...bare(decided.outcome, decided.reason), ...recorded };

  const plannedWaitMs = paidWaitMs(payment.sellerUrl, deadlineMs, deps.now());
  if (plannedWaitMs === null) {
    await closeDecision(db, ownerId, decisionId, 'failed');
    return { ...bare('failed', REASONS.deadline), ...recorded };
  }

  let signing: SignResult;
  try {
    signing = await signForDecision({ db, ownerId, decisionId, payment, masterSecretHex: args.secrets.masterSecretHex, chain: deps.chain, now: deps.now });
  } catch (error) {
    // A throw means the signing transaction never committed, so no payment exists and the
    // decision can be closed. A failure to close it must not hide the first error.
    await closeDecision(db, ownerId, decisionId, 'failed').catch(() => undefined);
    if (error instanceof PaymentError) return { ...bare('failed', `Ellai cannot pay this kind of payment request (${error.code}).`), ...recorded };
    if (error instanceof ChainError) return { ...bare('failed', REASONS.chain), ...recorded };
    throw error;
  }
  if ('refusal' in signing) {
    const refusal = signRefusal(signing, payment);
    await closeDecision(db, ownerId, decisionId, refusal.status);
    return { ...bare(refusal.outcome, refusal.reason), ...recorded };
  }
  const { signed } = signing;
  const [paymentRow] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.decisionId, decisionId), eq(payments.ownerId, ownerId)));
  if (paymentRow === undefined) throw new Error('the signed payment has no row');

  const header = paymentHeader(payment, signed);
  let answer: SafeResponse | null = null;
  try {
    answer = await deps.fetch(payment.sellerUrl, sellerRequest(request, { [header.name]: header.value }, sendWaitMs(plannedWaitMs, deadlineMs, deps.now())));
  } catch {
    // Once the header has left, the seller may settle whatever this request did, so every
    // failure here is "no answer" and the flow still goes on to read the chain.
  }
  const delivered = answer !== null && answer.status >= 200 && answer.status < 300;
  // undefined when the write failed, which leaves the column null: then Ellai does not know
  // what the seller did, and no outcome is made from it here or by the jobs tick.
  const storedDelivered = await afterPayment('seller_status', async () => {
    const written = await db.transaction(async (tx) => {
      // decide dates a question under this lock, so the two stamps are ordered by it: a question
      // committed before this write is dated earlier, and one after it is dated later (C26, C32).
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
      return tx
        .update(payments)
        .set({ sellerStatus: answer?.status ?? null, delivered, outcomeAt: deps.now() })
        .where(and(eq(payments.id, paymentRow.id), eq(payments.ownerId, ownerId)))
        .returning({ id: payments.id });
    });
    return written.length === 1 ? delivered : undefined;
  });

  // A settlement that could not be read stays 'pending' in payments, which the jobs tick reads again.
  const bounded = untilDeadline(deps.chain, deps.now, deps.sleep, deadlineMs);
  const settlement =
    (await afterPayment('settlement', () =>
      settlePayment({
        db,
        ownerId,
        paymentId: paymentRow.id,
        chain: bounded.chain,
        tries: LIMITS.settlementInlineTries,
        intervalMs: LIMITS.settlementInlineIntervalMs,
        sleep: bounded.sleep,
        now: deps.now,
        inline: true,
      }),
    )) ?? 'pending';
  // A normal paid call is already on chain and in payments; only a bad one becomes a memory,
  // so outcomes never crowd the owner's own answers out of recall. Only a stored false counts,
  // so the memory always agrees with payments.delivered, which decide's bad-outcome rule reads.
  if (settlement === 'verified' && storedDelivered === false) {
    await afterPayment('outcome', () =>
      recordOutcome({ db, ownerId, decisionId, delivered: false, delegatePublicKeyHex: delegate.publicKeyHex, now: deps.now() }),
    );
  }

  const paidText = `Paid ${formatUsdc(payment.amount)} USDC to ${hostLabel(payment.sellerHost)}`;
  return {
    outcome: 'paid',
    ...recorded,
    reason: delivered ? `${paidText}.` : `${paidText}; the seller returned no answer.`,
    seller: answer === null ? null : sellerAnswer(answer),
    payment: { digest: signed.digest, amountAtomic: payment.amount.toString(10), recipient: payment.recipient, settlement },
  };
}
