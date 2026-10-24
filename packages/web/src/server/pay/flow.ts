import { createHash } from 'node:crypto';
import { type Chain, ChainError } from '@ellai/core/chain';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '@ellai/core/challenge';
import { LIMITS } from '@ellai/core/limits';
import { NetError, type SafeRequest, type SafeResponse, type safeFetch } from '@ellai/core/net';
import { PaymentError, paymentHeader } from '@ellai/core/payment';
import { KNOWN_SELLERS } from '@ellai/core/sellers';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { SELLER_METHODS, TEXT_CAPS, agents, decisions, memories, owners, payments } from '../db/schema.js';
import { DecideError, type DecideErrorCode, type DecideResult, type Recall, decide } from '../decide/decide.js';
import { hostLabel } from '../decide/sentences.js';
import { ownerDelegate } from '../memory/delegate.js';
import { MEMORY_NAMESPACE } from '../memory/namespace.js';
import { recordOutcome } from '../memory/outcome.js';
import { type PaidFetchResult, bare, isPlainContentType, sellerAnswer, shortUsdc } from './result.js';
import { settlePayment } from './settle.js';
import { type SignRefusal, signForDecision } from './sign.js';

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
  inProgress: 'A payment for this same request is already in progress.',
  requestMismatch: 'An earlier decision under this request key is for a different request, so Ellai did not pay.',
  chain: 'Ellai could not read Sui just now, so it did not pay.',
} as const;

const SIGN_REFUSALS: Record<SignRefusal, { outcome: 'refused' | 'failed'; status: 'refused' | 'failed'; reason: string }> = {
  over_daily_budget: { outcome: 'refused', status: 'refused', reason: 'This payment would take the last 24 hours past your daily budget.' },
  purse_short: { outcome: 'failed', status: 'failed', reason: "This account's purse does not hold enough USDC for this payment right now." },
  expired: { outcome: 'failed', status: 'failed', reason: "The seller's price expired before Ellai could pay it." },
  wrong_epoch: { outcome: 'failed', status: 'failed', reason: "The seller's price is not valid on Sui right now, so Ellai did not pay it." },
  not_open: { outcome: 'failed', status: 'failed', reason: 'This decision can no longer be paid.' },
};

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

function normalizedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** How long a paid request may run: the recorded patience of a known seller, else the default (C21). */
function paidTimeoutMs(sellerUrl: string): number {
  const target = normalizedUrl(sellerUrl);
  const known = KNOWN_SELLERS.find((seller) => target !== null && normalizedUrl(seller.url) === target);
  return known?.paidTimeoutMs ?? LIMITS.netPaidTimeoutDefaultMs;
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

async function closeDecision(db: Database, ownerId: string, decisionId: string, status: 'failed' | 'refused'): Promise<void> {
  await db
    .update(decisions)
    .set({ status })
    .where(and(eq(decisions.id, decisionId), eq(decisions.ownerId, ownerId), eq(decisions.status, 'open')));
}

/**
 * Fetches a seller URL for an agent and, when the seller asks for payment and Ellai's rules
 * allow it, pays from the owner's purse and hands back the seller's answer.
 *
 * 1. The agent must be an active agent of this owner, else 'refused'. The method must be GET
 *    or POST, the URL at most TEXT_CAPS.sellerUrl characters, the body at most
 *    LIMITS.challengeMaxBytes bytes (and absent on GET), the content type a plain media type,
 *    and the purpose 1 to LIMITS.purposeMaxChars characters once trimmed, else 'refused'.
 * 2. The unpaid request goes through deps.fetch (safeFetch, C20). A NetError is 'failed'.
 * 3. Any answer but 402 is 'free': the answer goes back and no decision is recorded.
 * 4. parseChallenge reads the 402 into one canonical payment; a ChallengeError is 'refused'
 *    with no decision recorded (C1, C3).
 * 5, 6. decide runs on the payment, the method, the SHA-256 of the body and the purpose, with
 *    the owner's derived delegate key and recall. Refused and asked come back as decided. A
 *    live decision reused for the same request never pays: an asked one comes back as asked,
 *    an approved one is 'failed' because its payment is already under way (C5).
 * 7. signForDecision checks the budget and signs at that moment (C4, C6, C7). A refusal there,
 *    or a chain or build failure, is 'refused' (over the daily budget) or 'failed', and the
 *    decision is closed as 'refused' or 'failed' so the request can be decided again.
 * 8. The paid request is the same request plus the payment header, with the seller's own
 *    patience. Its status, or null when it never answered, is stored with the payment.
 * 9. settlePayment reads the chain by Ellai's digest, LIMITS.settlementInlineTries times (C8).
 * 10. A verified payment the seller answered with anything but 2xx becomes an outcome memory.
 *    Once signed material has left, the result is 'paid' whatever the seller did.
 *
 * Every reason is Ellai's own fixed text (C17). Throws only for failures that are not about
 * this request: a database error, a master secret that is not 64 hex characters.
 */
export async function paidFetch(args: PaidFetchArgs): Promise<PaidFetchResult> {
  const { db, deps } = args;
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
  const bodyHash = createHash('sha256')
    .update(request.body ?? '', 'utf8')
    .digest('hex');

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

  let signing: Awaited<ReturnType<typeof signForDecision>>;
  try {
    signing = await signForDecision({ db, ownerId, decisionId, payment, masterSecretHex: args.secrets.masterSecretHex, chain: deps.chain, now: deps.now() });
  } catch (error) {
    // A throw means the signing transaction never committed, so no payment exists and the
    // decision can be closed. A failure to close it must not hide the first error.
    await closeDecision(db, ownerId, decisionId, 'failed').catch(() => undefined);
    if (error instanceof PaymentError) return { ...bare('failed', `Ellai cannot pay this kind of payment request (${error.code}).`), ...recorded };
    if (error instanceof ChainError) return { ...bare('failed', REASONS.chain), ...recorded };
    throw error;
  }
  if ('refusal' in signing) {
    const refusal = SIGN_REFUSALS[signing.refusal];
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
    answer = await deps.fetch(payment.sellerUrl, sellerRequest(request, { [header.name]: header.value }, paidTimeoutMs(payment.sellerUrl)));
  } catch {
    // Once the header has left, the seller may settle whatever this request did, so every
    // failure here is "no answer" and the flow still goes on to read the chain.
  }
  const delivered = answer !== null && answer.status >= 200 && answer.status < 300;
  await db
    .update(payments)
    .set({ sellerStatus: answer?.status ?? null, delivered })
    .where(and(eq(payments.id, paymentRow.id), eq(payments.ownerId, ownerId)));

  const settlement = await settlePayment({
    db,
    ownerId,
    paymentId: paymentRow.id,
    chain: deps.chain,
    tries: LIMITS.settlementInlineTries,
    intervalMs: LIMITS.settlementInlineIntervalMs,
    sleep: deps.sleep,
  });
  // A normal paid call is already on chain and in payments; only a bad one becomes a memory,
  // so outcomes never crowd the owner's own answers out of recall.
  if (settlement === 'verified' && !delivered) {
    await recordOutcome({ db, ownerId, decisionId, delivered: false, delegatePublicKeyHex: delegate.publicKeyHex, now: deps.now() });
  }

  const paidText = `Paid ${shortUsdc(payment.amount)} USDC to ${hostLabel(payment.sellerHost)}`;
  return {
    outcome: 'paid',
    ...recorded,
    reason: delivered ? `${paidText}.` : `${paidText}; the seller returned no answer.`,
    seller: answer === null ? null : sellerAnswer(answer),
    payment: { digest: signed.digest, amountAtomic: payment.amount.toString(10), recipient: payment.recipient, settlement },
  };
}
