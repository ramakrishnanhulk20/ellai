import { LIMITS } from '@ellai/core/limits';
import { isValidTransactionDigest } from '@mysten/sui/utils';
import { and, count, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { type MEMORY_KINDS, decisions, memories, payments } from '../db/schema.js';

/** The public proof could not be read and there is no earlier copy to show. The message is fixed text. */
export class ProofUnavailableError extends Error {
  constructor() {
    super('the public proof could not be read');
    this.name = 'ProofUnavailableError';
  }
}

/**
 * What /proof shows, every entry from Ellai's own records (C18): payments Ellai verified on
 * chain by its own digest, and memory writes Walrus Memory confirmed. It holds no memory
 * sentence, no purpose, no reason, no agent label and no owner or purse address, so nothing an
 * owner or an agent wrote is public. Atomic amounts are decimal strings and times ISO strings.
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
  memories: Array<{ blobId: string; kind: (typeof MEMORY_KINDS)[number]; confirmedAt: string }>;
}

const LATEST = 20;
const EXPLORER_TX = 'https://suiscan.xyz/mainnet/tx/';
// The shape core's memory client already demands of every blob id it accepts from the relayer,
// checked again on the way out because this page is where a stranger will read it.
const BLOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Reads the public proof from the database: five reads, no chain call. The 20 latest verified
 * payments, newest first, each with its explorer link; the 20 latest confirmed memories,
 * newest first, by blob id and kind only; and the totals. A digest that is not a Sui
 * transaction digest, or a blob id that is not plain base64url, is left out rather than
 * linked or shown.
 */
export async function readPublicProof(db: Database): Promise<PublicProof> {
  const decidedCount = (outcome: 'approved' | 'asked', rule?: 'learned') =>
    sql`count(*) filter (where ${rule === undefined ? eq(decisions.outcome, outcome) : and(eq(decisions.outcome, outcome), eq(decisions.rule, rule))})`.mapWith(Number);
  const [paid, answers, decided, latestPayments, latestMemories] = await Promise.all([
    db
      .select({ n: count(), total: sql<string>`coalesce(sum(${payments.amountAtomic}), 0)::text` })
      .from(payments)
      .where(eq(payments.settlement, 'verified')),
    db
      .select({ n: count() })
      .from(memories)
      .where(and(eq(memories.kind, 'owner_decision'), eq(memories.status, 'confirmed'))),
    db.select({ learned: decidedCount('approved', 'learned'), asked: decidedCount('asked') }).from(decisions),
    db
      .select({ digest: payments.digest, amountAtomic: payments.amountAtomic, sellerHost: decisions.sellerHost, signedAt: payments.signedAt })
      .from(payments)
      .innerJoin(decisions, and(eq(decisions.id, payments.decisionId), eq(decisions.ownerId, payments.ownerId)))
      .where(eq(payments.settlement, 'verified'))
      .orderBy(desc(payments.signedAt), desc(payments.id))
      .limit(LATEST),
    db
      .select({ blobId: memories.blobId, kind: memories.kind, confirmedAt: memories.confirmedAt })
      .from(memories)
      .where(and(eq(memories.status, 'confirmed'), isNotNull(memories.blobId), isNotNull(memories.confirmedAt)))
      .orderBy(desc(memories.confirmedAt), desc(memories.id))
      .limit(LATEST),
  ]);
  return {
    totals: {
      verifiedPayments: paid[0]?.n ?? 0,
      verifiedUsdcAtomic: paid[0]?.total ?? '0',
      confirmedOwnerAnswers: answers[0]?.n ?? 0,
      approvedByLearning: decided[0]?.learned ?? 0,
      askedDecisions: decided[0]?.asked ?? 0,
    },
    payments: latestPayments.flatMap((row) =>
      isValidTransactionDigest(row.digest)
        ? [{ digest: row.digest, amountAtomic: row.amountAtomic.toString(10), sellerHost: row.sellerHost, signedAt: row.signedAt.toISOString(), explorerUrl: `${EXPLORER_TX}${row.digest}` }]
        : [],
    ),
    memories: latestMemories.flatMap((row) =>
      row.blobId !== null && BLOB_ID.test(row.blobId) && row.confirmedAt !== null ? [{ blobId: row.blobId, kind: row.kind, confirmedAt: row.confirmedAt.toISOString() }] : [],
    ),
  };
}

interface ProofCache {
  value: PublicProof | null;
  refreshStartedAtMs: number | null;
  refreshing: Promise<PublicProof> | null;
}

// Kept on globalThis, as the server context is, because the Next dev server can load this
// module more than once and two caches would mean two refreshes per window.
const CACHE_KEY = '__ellaiPublicProof';

function proofCache(): ProofCache {
  const holder = globalThis as unknown as Record<string, ProofCache | undefined>;
  holder[CACHE_KEY] ??= { value: null, refreshStartedAtMs: null, refreshing: null };
  return holder[CACHE_KEY];
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
  if (!Number.isFinite(nowMs)) throw new Error('The current time is not a number');
  const cache = proofCache();
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
        console.error('[ellai proof] refresh_failed');
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
