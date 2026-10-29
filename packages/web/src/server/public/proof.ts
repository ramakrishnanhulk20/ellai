import { LIMITS } from '@ellai/core/limits';
import { isValidTransactionDigest } from '@mysten/sui/utils';
import { and, asc, count, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { type DECISION_OUTCOMES, type DECISION_RULES, type MEMORY_KINDS, type VERDICTS, decisionCitations, decisions, memories, owners, payments } from '../db/schema.js';
import { formatUsdc, hostLabel } from '../decide/sentences.js';

/** The public proof could not be read and there is no earlier copy to show. The message is fixed text. */
export class ProofUnavailableError extends Error {
  constructor() {
    super('the public proof could not be read');
    this.name = 'ProofUnavailableError';
  }
}

/**
 * What /proof shows, every entry from Ellai's own records and only for owners who chose to be
 * shown (owners.public_proof), since each digest leads on chain to an owner's purse and wallet
 * (C18): payments Ellai verified on chain by its own digest, and memory writes Walrus Memory
 * confirmed whose blob the jobs tick then found on chain and has not since seen Walrus stop
 * storing. The totals count those owners only. approvedByLearning counts decisions approved by
 * learned trust whose payment Ellai verified, and askedDecisions the questions asked of owners
 * the page shows, those with a verified payment or an on-chain memory, and only questions Sui or
 * Walrus backs: one that cites an owner answer on chain given about its own host, or whose own
 * answer is one (C37). So neither grows from requests that never paid or questions never answered
 * about that host on Walrus.
 * It holds no memory sentence, no purpose, no reason, no agent label and no owner or purse
 * address, so nothing an owner or an agent wrote is public. A seller host is shown only as the
 * sentences show it, or as the learning test's stand-in by name (publicHost). Atomic amounts are
 * decimal strings and times ISO strings; a memory's confirmedAt is when Walrus Memory confirmed it.
 */
export interface PublicProof {
  totals: {
    verifiedPayments: number;
    verifiedUsdcAtomic: string;
    confirmedOwnerAnswers: number;
    approvedByLearning: number;
    askedDecisions: number;
  };
  payments: Array<{ digest: string; amountAtomic: string; sellerHost: string; signedAt: string; explorerUrl: string }>;
  memories: Array<{ blobId: string; kind: (typeof MEMORY_KINDS)[number]; verdict: (typeof VERDICTS)[number] | null; host: string | null; confirmedAt: string }>;
}

const EXPLORER_TX = 'https://suiscan.xyz/mainnet/tx/';
// The shape core's memory client already demands of every blob id it accepts from the relayer,
// checked again on the way out because this page is where a stranger will read it.
const BLOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_STAND_IN_LABEL = 'Ellai wallet check (learning test)';

// The learning test reached Ellai's own wallet-check seller under ellai.invalid (docs/learning-results), and .invalid is a reserved name no real seller can use.
function publicHost(host: string): string {
  return host === 'ellai.invalid' ? PUBLIC_STAND_IN_LABEL : hostLabel(host);
}

// Built in one place so /proof and the memory map can never disagree on which owners, payments,
// memories and decisions a stranger may see.
function publicRules(db: Database) {
  const shown = eq(owners.publicProof, true);
  const verified = eq(payments.settlement, 'verified');
  const onChain = and(eq(memories.status, 'confirmed'), isNotNull(memories.blobId), isNotNull(memories.chainConfirmedAt), isNull(memories.chainExpiredAt));
  const ownerAnswer = and(eq(memories.kind, 'owner_decision'), onChain);
  const onPage = or(
    exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.ownerId, owners.id), verified))),
    exists(db.select({ one: sql`1` }).from(memories).where(and(eq(memories.ownerId, owners.id), onChain))),
  );
  // C37: opting in must not let an owner put any host they like on the landing page. A decision is
  // public only when Sui or Walrus backs it: a payment Ellai verified, a citation of an owner answer
  // on chain given about the decision's own host, or the owner's own answer to its question on
  // chain (the answer memory names its decision through memories.decision_id). Refusals and learned
  // approvals match on the recipient alone, so one answer is cited by requests to that recipient at
  // every host; only the host the answer named is backed by it. Both hosts are the stored
  // decisions.seller_host text, which answerQuestion copies into the memory unchanged, so the
  // comparison is exact. Limit refusals, unanswered questions, unpaid grants and decisions citing
  // only answers about another host match none of the three.
  const backed = or(
    exists(db.select({ one: sql`1` }).from(payments).where(and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId), verified))),
    exists(
      db
        .select({ one: sql`1` })
        .from(decisionCitations)
        .innerJoin(memories, and(eq(memories.id, decisionCitations.memoryId), eq(memories.ownerId, decisionCitations.ownerId)))
        .where(and(eq(decisionCitations.decisionId, decisions.id), eq(decisionCitations.ownerId, decisions.ownerId), ownerAnswer, eq(memories.sellerHost, decisions.sellerHost))),
    ),
    exists(db.select({ one: sql`1` }).from(memories).where(and(eq(memories.decisionId, decisions.id), eq(memories.ownerId, decisions.ownerId), ownerAnswer))),
  );
  return { shown, verified, onChain, ownerAnswer, onPage, backed };
}

type PublicRules = ReturnType<typeof publicRules>;

// The three totals both public reads show, from the same queries, so the landing page's numbers
// always match /proof's.
async function learningTotals(db: Database, { shown, verified, onChain, onPage, backed }: PublicRules) {
  const [answers, learned, asked] = await Promise.all([
    db
      .select({ n: count() })
      .from(memories)
      .innerJoin(owners, eq(owners.id, memories.ownerId))
      .where(and(eq(memories.kind, 'owner_decision'), onChain, shown)),
    db
      .select({ n: count() })
      .from(decisions)
      .innerJoin(payments, and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId)))
      .innerJoin(owners, eq(owners.id, decisions.ownerId))
      .where(and(eq(decisions.outcome, 'approved'), eq(decisions.rule, 'learned'), verified, shown)),
    db
      .select({ n: count() })
      .from(decisions)
      .innerJoin(owners, eq(owners.id, decisions.ownerId))
      .where(and(eq(decisions.outcome, 'asked'), shown, onPage, backed)),
  ]);
  return { ownerAnswers: answers[0]?.n ?? 0, learnedApprovals: learned[0]?.n ?? 0, questionsAsked: asked[0]?.n ?? 0 };
}

/**
 * Reads the public proof from the database: six reads, no chain call, each joined to its
 * owner and kept to owners with public_proof true. The latest LIMITS.publicProofLatest verified
 * payments, newest first, each with its explorer link and its seller host through publicHost; the
 * latest LIMITS.publicProofLatest memories confirmed by Walrus Memory, found on chain
 * (chain_confirmed_at set) and not expired there (chain_expired_at unset), newest first, by blob
 * id, kind, verdict and host; and the totals, over the same owners, with an owner answer counted
 * only while it is so, a learned approval only once its payment is verified, and a question only
 * for an owner with a verified payment or an on-chain memory, and only when it cites an owner
 * answer on chain given about its own host or its own answer is one (C37). A memory's verdict and host come from
 * its own columns alone (C37): the verdict only for an owner answer and only when it is exactly
 * approve or refuse, else null, and the host through publicHost, or null when it names none. A
 * digest that is not a Sui transaction digest, or a blob id that is not plain base64url, is left
 * out rather than linked or shown.
 */
export async function readPublicProof(db: Database): Promise<PublicProof> {
  const rules = publicRules(db);
  const { shown, verified, onChain } = rules;
  const [paid, learning, latestPayments, latestMemories] = await Promise.all([
    db
      .select({ n: count(), total: sql<string>`coalesce(sum(${payments.amountAtomic}), 0)::text` })
      .from(payments)
      .innerJoin(owners, eq(owners.id, payments.ownerId))
      .where(and(eq(payments.settlement, 'verified'), shown)),
    learningTotals(db, rules),
    db
      .select({ digest: payments.digest, amountAtomic: payments.amountAtomic, sellerHost: decisions.sellerHost, signedAt: payments.signedAt })
      .from(payments)
      .innerJoin(decisions, and(eq(decisions.id, payments.decisionId), eq(decisions.ownerId, payments.ownerId)))
      .innerJoin(owners, eq(owners.id, payments.ownerId))
      .where(and(verified, shown))
      .orderBy(desc(payments.signedAt), desc(payments.id))
      .limit(LIMITS.publicProofLatest),
    db
      .select({ blobId: memories.blobId, kind: memories.kind, verdict: memories.verdict, sellerHost: memories.sellerHost, confirmedAt: memories.confirmedAt })
      .from(memories)
      .innerJoin(owners, eq(owners.id, memories.ownerId))
      .where(and(onChain, isNotNull(memories.confirmedAt), shown))
      .orderBy(desc(memories.confirmedAt), desc(memories.id))
      .limit(LIMITS.publicProofLatest),
  ]);
  return {
    totals: {
      verifiedPayments: paid[0]?.n ?? 0,
      verifiedUsdcAtomic: paid[0]?.total ?? '0',
      confirmedOwnerAnswers: learning.ownerAnswers,
      approvedByLearning: learning.learnedApprovals,
      askedDecisions: learning.questionsAsked,
    },
    payments: latestPayments.flatMap((row) =>
      isValidTransactionDigest(row.digest)
        ? [{ digest: row.digest, amountAtomic: row.amountAtomic.toString(10), sellerHost: publicHost(row.sellerHost), signedAt: row.signedAt.toISOString(), explorerUrl: `${EXPLORER_TX}${row.digest}` }]
        : [],
    ),
    memories: latestMemories.flatMap((row) =>
      row.blobId !== null && BLOB_ID.test(row.blobId) && row.confirmedAt !== null
        ? [
            {
              blobId: row.blobId,
              kind: row.kind,
              verdict: row.kind === 'owner_decision' && (row.verdict === 'approve' || row.verdict === 'refuse') ? row.verdict : null,
              host: typeof row.sellerHost === 'string' && row.sellerHost !== '' ? publicHost(row.sellerHost) : null,
              confirmedAt: row.confirmedAt.toISOString(),
            },
          ]
        : [],
    ),
  };
}

/**
 * What the landing page's memory map draws, from Ellai's own records and only for owners who
 * opted in (owners.public_proof): owner answers confirmed by Walrus Memory, found on chain and
 * not expired there, and recent decisions Sui or Walrus backs (C37): those with a payment Ellai
 * verified, those citing an owner answer on chain given about the decision's own host, and
 * questions whose own answer is an owner answer on chain. Limit refusals, unanswered questions,
 * unpaid grants and decisions citing only answers about another host are never listed. Each
 * decision carries the shown answers it cited and how close recall found each one (null when the
 * citation came from an exact lookup, or was written before distances were kept). A decision's id
 * is its place in this answer, never its database id, and its digest is set only for a payment
 * Ellai verified. The totals are /proof's: owner answers on chain, learned approvals whose payment
 * Ellai verified, and questions asked of owners the page shows that pass the same decision rule.
 * It holds no memory sentence, purpose, reason, agent, owner id or address (C17, C18, C19). Hosts
 * are written as /proof writes them (publicHost), amounts as decimal USDC (formatUsdc), times
 * as ISO strings; a memory's `at` is when Walrus Memory confirmed it.
 */
export interface MemoryMap {
  generatedAt: string;
  memories: Array<{ blobId: string; verdict: (typeof VERDICTS)[number]; host: string; amountUsdc: string; at: string }>;
  decisions: Array<{
    id: string;
    at: string;
    outcome: (typeof DECISION_OUTCOMES)[number];
    rule: (typeof DECISION_RULES)[number];
    host: string;
    amountUsdc: string;
    digest: string | null;
    citations: Array<{ blobId: string; distance: number | null }>;
  }>;
  totals: { memories: number; learnedApprovals: number; questionsAsked: number };
}

// A real column keeps about six significant digits, so the stored value is cut back to them
// rather than shown with the float's noise (0.1 reads back as 0.10000000149011612). Anything
// that is not a distance recall could honestly give is shown as no distance.
function shownDistance(distance: number | null): number | null {
  if (distance === null || !Number.isFinite(distance) || distance < 0 || distance > LIMITS.recallDistanceMax) return null;
  return Number(distance.toPrecision(6));
}

/**
 * Reads the memory map from the database, at `now`: the totals' three reads, the latest
 * LIMITS.memoryMapMemories owner answers on chain (the /proof rule) by Walrus Memory's
 * confirmation time, the latest LIMITS.memoryMapDecisions decisions Sui or Walrus backs (C37) by
 * creation time, both newest first and kept to owners with public_proof true, then one read of
 * those decisions' citations to
 * owner answers on chain, closest first. No chain or relayer call (C22). A citation to any other
 * memory (an outcome, one not yet found on chain, one Walrus no longer stores) is left out, as is
 * a blob id that is not plain base64url or a memory whose amount is not a whole number of atomic
 * units. A digest that is not a Sui transaction digest is shown as none. Throws Error when `now`
 * is not a valid date, which is a server bug.
 */
export async function readMemoryMap(db: Database, now: Date): Promise<MemoryMap> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  const rules = publicRules(db);
  const { shown, verified, ownerAnswer, onPage, backed } = rules;
  const [learning, latestMemories, latestDecisions] = await Promise.all([
    learningTotals(db, rules),
    db
      .select({ blobId: memories.blobId, verdict: memories.verdict, sellerHost: memories.sellerHost, amountAtomic: memories.amountAtomic, confirmedAt: memories.confirmedAt })
      .from(memories)
      .innerJoin(owners, eq(owners.id, memories.ownerId))
      .where(and(ownerAnswer, isNotNull(memories.confirmedAt), shown))
      .orderBy(desc(memories.confirmedAt), desc(memories.id))
      .limit(LIMITS.memoryMapMemories),
    db
      .select({
        id: decisions.id,
        createdAt: decisions.createdAt,
        outcome: decisions.outcome,
        rule: decisions.rule,
        sellerHost: decisions.sellerHost,
        amountAtomic: decisions.amountAtomic,
        digest: payments.digest,
      })
      .from(decisions)
      .innerJoin(owners, eq(owners.id, decisions.ownerId))
      .leftJoin(payments, and(eq(payments.decisionId, decisions.id), eq(payments.ownerId, decisions.ownerId), verified))
      // As on /proof: only owners with something on chain, and only decisions Sui or Walrus backs (C37).
      .where(and(shown, onPage, backed))
      .orderBy(desc(decisions.createdAt), desc(decisions.id))
      .limit(LIMITS.memoryMapDecisions),
  ]);

  const decisionIds = latestDecisions.map((row) => row.id);
  const cited =
    decisionIds.length === 0
      ? []
      : await db
          .select({ decisionId: decisionCitations.decisionId, blobId: memories.blobId, distance: decisionCitations.distance })
          .from(decisionCitations)
          .innerJoin(memories, and(eq(memories.id, decisionCitations.memoryId), eq(memories.ownerId, decisionCitations.ownerId)))
          .innerJoin(owners, eq(owners.id, decisionCitations.ownerId))
          .where(and(inArray(decisionCitations.decisionId, decisionIds), ownerAnswer, shown))
          // Ascending puts nulls last in Postgres, so exact-lookup citations follow the measured ones.
          .orderBy(asc(decisionCitations.decisionId), asc(decisionCitations.distance), asc(memories.blobId))
          .limit(LIMITS.memoryMapDecisions * LIMITS.decideMaxCitedMemories);
  const citations = new Map<string, Array<{ blobId: string; distance: number | null }>>();
  for (const row of cited) {
    if (row.blobId === null || !BLOB_ID.test(row.blobId)) continue;
    const list = citations.get(row.decisionId) ?? [];
    list.push({ blobId: row.blobId, distance: shownDistance(row.distance) });
    citations.set(row.decisionId, list);
  }

  return {
    generatedAt: now.toISOString(),
    memories: latestMemories.flatMap((row) =>
      row.blobId !== null && BLOB_ID.test(row.blobId) && row.verdict !== null && row.amountAtomic !== null && row.amountAtomic >= 0n && row.confirmedAt !== null
        ? [{ blobId: row.blobId, verdict: row.verdict, host: publicHost(row.sellerHost ?? ''), amountUsdc: formatUsdc(row.amountAtomic), at: row.confirmedAt.toISOString() }]
        : [],
    ),
    decisions: latestDecisions.map((row, index) => ({
      id: String(index),
      at: row.createdAt.toISOString(),
      outcome: row.outcome,
      rule: row.rule,
      host: publicHost(row.sellerHost),
      amountUsdc: formatUsdc(row.amountAtomic),
      digest: row.digest !== null && isValidTransactionDigest(row.digest) ? row.digest : null,
      citations: citations.get(row.id) ?? [],
    })),
    totals: { memories: learning.ownerAnswers, learnedApprovals: learning.learnedApprovals, questionsAsked: learning.questionsAsked },
  };
}

interface ReadCache<T> {
  value: T | null;
  refreshStartedAtMs: number | null;
  refreshing: Promise<T> | null;
}

// Kept on globalThis, as the server context is, because the Next dev server can load this
// module more than once and two caches would mean two refreshes per window.
const PROOF_CACHE_KEY = '__ellaiPublicProof';
const MEMORY_MAP_CACHE_KEY = '__ellaiMemoryMap';

function readCache<T>(key: string): ReadCache<T> {
  const holder = globalThis as unknown as Record<string, ReadCache<T> | undefined>;
  holder[key] ??= { value: null, refreshStartedAtMs: null, refreshing: null };
  return holder[key];
}

function cachedRead<T>(key: string, failedLog: string, load: () => Promise<T>, nowMs: number): Promise<T> {
  if (!Number.isFinite(nowMs)) throw new Error('The current time is not a number');
  const cache = readCache<T>(key);
  if (cache.refreshing !== null) return cache.refreshing;
  const started = cache.refreshStartedAtMs;
  if (started !== null && nowMs >= started && nowMs - started < LIMITS.publicProofCacheMs) {
    return cache.value === null ? Promise.reject(new ProofUnavailableError()) : Promise.resolve(cache.value);
  }

  cache.refreshStartedAtMs = nowMs;
  const refreshing = load()
    .then(
      (value) => {
        cache.value = value;
        return value;
      },
      () => {
        console.error(failedLog);
        if (cache.value === null) throw new ProofUnavailableError();
        return cache.value;
      },
    )
    .finally(() => {
      if (cache.refreshing === refreshing) cache.refreshing = null;
    });
  cache.refreshing = refreshing;
  return refreshing;
}

/**
 * The public proof as of the latest refresh, calling `load` at most once in any window of
 * LIMITS.publicProofCacheMs, so anonymous traffic, however heavy, reads the database at most
 * once a window (C22). Callers that arrive during a refresh wait for that one refresh. A failed
 * refresh still uses up its window: the last good copy is served until the next window, and
 * with no good copy yet ProofUnavailableError is thrown, logged as a fixed code only. A clock
 * that has gone back before the last refresh counts as a new window. Throws Error when `nowMs`
 * is not a finite number, which is a server bug.
 */
export function cachedPublicProof(load: () => Promise<PublicProof>, nowMs: number): Promise<PublicProof> {
  return cachedRead(PROOF_CACHE_KEY, '[ellai proof] refresh_failed', load, nowMs);
}

/**
 * The memory map as of its latest refresh, with a cache of its own under exactly the rules of
 * cachedPublicProof: `load` called at most once in any window of LIMITS.publicProofCacheMs (C22),
 * the last good copy served after a failed refresh, and ProofUnavailableError with none, since
 * the map is part of the public proof. Throws Error when `nowMs` is not a finite number.
 */
export function cachedMemoryMap(load: () => Promise<MemoryMap>, nowMs: number): Promise<MemoryMap> {
  return cachedRead(MEMORY_MAP_CACHE_KEY, '[ellai memory-map] refresh_failed', load, nowMs);
}
