export type MapMemory = {
  blobId: string;
  verdict: 'approve' | 'refuse';
  host: string;
  amountUsdc: string;
  at: string;
};

export type MapCitation = {
  blobId: string;
  distance: number | null;
};

export type MapDecision = {
  id: string;
  at: string;
  outcome: 'approved' | 'asked' | 'refused';
  rule: string;
  host: string;
  amountUsdc: string;
  digest: string | null;
  citations: MapCitation[];
};

export type MemoryMap = {
  generatedAt: string;
  memories: MapMemory[];
  decisions: MapDecision[];
  totals: {
    memories: number;
    learnedApprovals: number;
    questionsAsked: number;
  };
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMemory(value: unknown): MapMemory | null {
  if (!isRecord(value)) return null;
  const { blobId, verdict, host, amountUsdc, at } = value;
  if (typeof blobId !== 'string' || blobId === '') return null;
  if (verdict !== 'approve' && verdict !== 'refuse') return null;
  if (typeof host !== 'string' || typeof amountUsdc !== 'string' || typeof at !== 'string') {
    return null;
  }
  return { blobId, verdict, host, amountUsdc, at };
}

function parseCitation(value: unknown): MapCitation | null {
  if (!isRecord(value)) return null;
  const { blobId, distance } = value;
  if (typeof blobId !== 'string') return null;
  if (distance === null) return { blobId, distance: null };
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return null;
  return { blobId, distance };
}

function parseDecision(value: unknown): MapDecision | null {
  if (!isRecord(value)) return null;
  const { id, at, outcome, rule, host, amountUsdc, digest, citations } = value;
  if (typeof id !== 'string' || typeof at !== 'string') return null;
  if (outcome !== 'approved' && outcome !== 'asked' && outcome !== 'refused') return null;
  if (typeof rule !== 'string' || typeof host !== 'string' || typeof amountUsdc !== 'string') {
    return null;
  }
  if (digest !== null && typeof digest !== 'string') return null;
  if (!Array.isArray(citations)) return null;
  const parsed: MapCitation[] = [];
  for (const entry of citations) {
    const citation = parseCitation(entry);
    if (!citation) return null;
    parsed.push(citation);
  }
  return { id, at, outcome, rule, host, amountUsdc, digest, citations: parsed };
}

/**
 * Checks a response body against the memory-map contract. Any mismatch returns null so the
 * screen shows its empty state instead of drawing half-understood data.
 */
export function parseMemoryMap(value: unknown): MemoryMap | null {
  if (!isRecord(value)) return null;
  const { generatedAt, memories, decisions, totals } = value;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) return null;
  if (!Array.isArray(memories) || !Array.isArray(decisions) || !isRecord(totals)) return null;

  const parsedMemories: MapMemory[] = [];
  for (const entry of memories) {
    const memory = parseMemory(entry);
    if (!memory) return null;
    parsedMemories.push(memory);
  }
  const parsedDecisions: MapDecision[] = [];
  for (const entry of decisions) {
    const decision = parseDecision(entry);
    if (!decision) return null;
    parsedDecisions.push(decision);
  }

  const { memories: memoryCount, learnedApprovals, questionsAsked } = totals;
  if (
    typeof memoryCount !== 'number' ||
    typeof learnedApprovals !== 'number' ||
    typeof questionsAsked !== 'number'
  ) {
    return null;
  }

  return {
    generatedAt,
    memories: parsedMemories,
    decisions: parsedDecisions,
    totals: { memories: memoryCount, learnedApprovals, questionsAsked },
  };
}
