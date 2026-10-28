export type CitedMemory = { memoryId: string; blobId: string | null };

export type OnboardingStep = 'missing' | 'present';

export type Overview = {
  owner: {
    suiAddress: string;
    purseAddress: string;
    paused: boolean;
    autoPausedReason: string | null;
    perPaymentMaxAtomic: string;
    dailyBudgetAtomic: string;
    approvalsNeeded: number;
    distanceCutoff: number;
    publicProof: boolean;
  };
  onboarding: {
    memoryAccount: OnboardingStep;
    delegate: OnboardingStep;
    allowance: OnboardingStep;
    purseAddress: string;
  };
  purse: { usdcAtomic: string } | null;
  counts: { asked: number; approved: number; refused: number; paid: number };
  questionsPer20: { asked: number; window: number };
};

export type Question = {
  decisionId: string;
  askedAt: string;
  payment: { recipient: string; amountAtomic: string; asset: string; network: string; sellerHost: string };
  agent: { id: string; label: string };
  purpose: string;
  rule: 'bad_outcome' | 'recall_unavailable' | 'no_match';
  reason: string;
  citedMemories: CitedMemory[];
};

export type Settlement = 'pending' | 'verified' | 'mismatch' | 'not_landed';

export type DecisionStatus = 'open' | 'paid' | 'asked' | 'answered' | 'refused' | 'expired' | 'failed';

export type Decision = {
  decisionId: string;
  createdAt: string;
  agent: { id: string; label: string };
  payment: { recipient: string; amountAtomic: string; sellerHost: string };
  purpose: string;
  outcome: 'approved' | 'refused' | 'asked';
  rule: string;
  reason: string;
  status: DecisionStatus;
  answer?: 'approve' | 'refuse' | null;
  answeredAt?: string | null;
  citedMemories: CitedMemory[];
  paid: null | { digest: string; settlement: Settlement; explorerUrl: string };
};

export type MemoryRow = {
  memoryId: string;
  kind: 'owner_decision' | 'outcome';
  verdict: 'approve' | 'refuse' | null;
  recipient: string | null;
  amountAtomic: string | null;
  sellerHost: string | null;
  sentence: string;
  status: 'pending' | 'confirmed' | 'failed';
  blobId: string | null;
  createdAt: string;
  confirmedAt: string | null;
};

export type Page<Key extends string, Row> = { [K in Key]: Row[] } & { nextBefore: string | null };

/** Carries the server's error code, which is what screens branch on: one status serves several codes. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isSignedOut(value: unknown): boolean {
  return isApiError(value) && value.code === 'signed_out';
}

const NETWORK_MESSAGE = 'Ellai could not be reached. Check your connection and try again.';
const FALLBACK_MESSAGE = "Something went wrong on Ellai's side. Try again in a minute.";

// One listener is enough: the providers register it once for the whole /app tree.
let signedOutListener: (() => void) | null = null;

export function onSignedOut(listener: () => void): () => void {
  signedOutListener = listener;
  return () => {
    if (signedOutListener === listener) signedOutListener = null;
  };
}

type RequestOptions = { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * The one way the screens call Ellai's own API. Same origin, cookie included. A failed answer
 * becomes an ApiError with the server's code and message; a server fault carries no message,
 * so the fallback text stands in. A signed_out answer also tells the app the session is over.
 */
export async function ownerFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', NETWORK_MESSAGE);
  }
  const parsed = await readJson(response);
  if (response.ok) return parsed as T;
  const code = field(parsed, 'error');
  const message = field(parsed, 'message');
  const error = new ApiError(
    response.status,
    typeof code === 'string' ? code : 'unknown',
    typeof message === 'string' && message !== '' ? message : FALLBACK_MESSAGE,
  );
  if (error.code === 'signed_out') signedOutListener?.();
  throw error;
}

export const fetchOverview = (signal?: AbortSignal) => ownerFetch<Overview>('/api/owner/overview', { signal });

export const fetchQuestions = (signal?: AbortSignal) =>
  ownerFetch<{ questions: Question[] }>('/api/owner/questions', { signal });

function pagePath(base: string, before: string | null): string {
  return before === null ? base : `${base}?before=${encodeURIComponent(before)}`;
}

export const fetchDecisions = (before: string | null, signal?: AbortSignal) =>
  ownerFetch<Page<'decisions', Decision>>(pagePath('/api/owner/decisions', before), { signal });

export const fetchMemories = (before: string | null, signal?: AbortSignal) =>
  ownerFetch<Page<'memories', MemoryRow>>(pagePath('/api/owner/memories', before), { signal });

export const postAnswer = (decisionId: string, answer: 'approve' | 'refuse', reason: string) =>
  ownerFetch<{ memoryId: string; grantId: string | null }>(
    `/api/owner/questions/${encodeURIComponent(decisionId)}/answer`,
    { method: 'POST', body: reason.trim() === '' ? { answer } : { answer, reason } },
  );

export const requestNonce = (address: string) =>
  ownerFetch<{ message: string; expiresAt: string }>('/api/auth/nonce', { method: 'POST', body: { address } });

export const verifySignIn = (message: string, signature: string) =>
  ownerFetch<{ ownerId: string }>('/api/auth/verify', { method: 'POST', body: { message, signature } });

export const logout = () => ownerFetch<{ signedOut: true }>('/api/auth/logout', { method: 'POST' });
