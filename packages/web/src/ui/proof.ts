export type ProofPayment = {
  digest: string;
  amountAtomic: string;
  sellerHost: string;
  signedAt: string;
  explorerUrl: string;
};

export type ProofMemory = {
  blobId: string;
  kind: 'owner_decision' | 'outcome';
  /** The owner's answer on an owner_decision memory. Null on an outcome, or when the server did not say. */
  verdict: 'approve' | 'refuse' | null;
  /** The seller the memory is about. Null when the server did not say. */
  host: string | null;
  confirmedAt: string;
};

export type Proof = {
  totals: {
    verifiedPayments: number;
    verifiedUsdcAtomic: string;
    confirmedOwnerAnswers: number;
    approvedByLearning: number;
    askedDecisions: number;
  };
  payments: ProofPayment[];
  memories: ProofMemory[];
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parsePayment(value: unknown): ProofPayment | null {
  if (!isRecord(value)) return null;
  const { digest, amountAtomic, sellerHost, signedAt, explorerUrl } = value;
  if (typeof digest !== 'string' || digest === '') return null;
  if (typeof amountAtomic !== 'string' || !/^\d+$/.test(amountAtomic)) return null;
  if (typeof sellerHost !== 'string' || !isTime(signedAt)) return null;
  // The explorer link is the one address on this page taken from the server, so it must be a plain web address.
  if (typeof explorerUrl !== 'string' || !explorerUrl.startsWith('https://')) return null;
  return { digest, amountAtomic, sellerHost, signedAt, explorerUrl };
}

function parseMemory(value: unknown): ProofMemory | null {
  if (!isRecord(value)) return null;
  const { blobId, kind, verdict, host, confirmedAt } = value;
  if (typeof blobId !== 'string' || blobId === '') return null;
  if (kind !== 'owner_decision' && kind !== 'outcome') return null;
  if (!isTime(confirmedAt)) return null;
  // A missing or odd verdict or host is not a reason to drop the row: the row is still a real memory.
  return {
    blobId,
    kind,
    verdict: verdict === 'approve' || verdict === 'refuse' ? verdict : null,
    host: typeof host === 'string' && host !== '' ? host : null,
    confirmedAt,
  };
}

function parseAll<T>(entries: unknown[], parseOne: (entry: unknown) => T | null): T[] | null {
  const parsed: T[] = [];
  for (const entry of entries) {
    const item = parseOne(entry);
    if (!item) return null;
    parsed.push(item);
  }
  return parsed;
}

/**
 * Checks a response body against the proof contract. Any mismatch returns null so the page shows
 * its empty state instead of drawing half-understood data.
 */
export function parseProof(value: unknown): Proof | null {
  if (!isRecord(value)) return null;
  const { totals, payments, memories } = value;
  if (!isRecord(totals) || !Array.isArray(payments) || !Array.isArray(memories)) return null;

  const { verifiedPayments, verifiedUsdcAtomic, confirmedOwnerAnswers, approvedByLearning, askedDecisions } = totals;
  if (
    typeof verifiedPayments !== 'number' ||
    typeof verifiedUsdcAtomic !== 'string' ||
    !/^\d+$/.test(verifiedUsdcAtomic) ||
    typeof confirmedOwnerAnswers !== 'number' ||
    typeof approvedByLearning !== 'number' ||
    typeof askedDecisions !== 'number'
  ) {
    return null;
  }

  const parsedPayments = parseAll(payments, parsePayment);
  const parsedMemories = parseAll(memories, parseMemory);
  if (!parsedPayments || !parsedMemories) return null;

  return {
    totals: { verifiedPayments, verifiedUsdcAtomic, confirmedOwnerAnswers, approvedByLearning, askedDecisions },
    payments: parsedPayments,
    memories: parsedMemories,
  };
}
