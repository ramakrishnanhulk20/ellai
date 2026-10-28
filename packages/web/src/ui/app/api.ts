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
  builtinAgent: 'ready' | 'needs_key';
};

export type OnboardingState = Overview['onboarding'];

export type OnboardingStepName = 'memory_account' | 'add_delegate' | 'allowance';

/**
 * The three steps plus two that record nothing new: the optional move of USDC coins into the address
 * balance, which has no confirm, and ending the allowance, which is confirmed by Sui no longer showing it.
 */
export type BuildStepName = OnboardingStepName | 'usdc_to_address' | 'end_allowance';

/** Allowance terms as the server takes them: amounts as atomic USDC text, the length in whole days. */
export type AllowanceTerms = { dailyLimitAtomic: string; lifetimeCapAtomic: string; days: number };

export type BuiltStep = { txBytesBase64: string; summary: Array<{ label: string; value: string }> };

export type Settings = Omit<Overview['owner'], 'suiAddress' | 'purseAddress'>;

/** A settings change as the server takes it. Only the fields that differ are sent. */
export type SettingsChange = Partial<{
  paused: boolean;
  perPaymentMaxAtomic: string;
  dailyBudgetAtomic: string;
  approvalsNeeded: number;
  distanceCutoff: number;
  clearAutoPause: true;
  publicProof: boolean;
}>;

export type StepUpRequest =
  | { action: 'create_agent'; change: { label: string } }
  | { action: 'loosen_settings'; change: SettingsChange };

export type StepUpProof = { nonce: string; signature: string };

export type StepUpIssued = { nonce: string; message: string; expiresAt: string };

export type Agent = {
  agentId: string;
  label: string;
  kind: 'external' | 'builtin';
  displayPrefix: string;
  createdAt: string;
  revokedAt: string | null;
};

export type RunStep = {
  sellerId: string;
  outcome: 'free' | 'paid' | 'asked' | 'refused' | 'failed';
  reason: string;
  digest: string | null;
};

export type RunResult = {
  status: 'done' | 'needs_key' | 'stopped' | 'limit' | 'refused';
  answer: string;
  steps: RunStep[];
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

type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal };

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

export const fetchOnboarding = () => ownerFetch<OnboardingState>('/api/owner/onboarding');

export const buildOnboardingStep = (step: BuildStepName, allowance?: AllowanceTerms) =>
  ownerFetch<BuiltStep>('/api/owner/onboarding/build', {
    method: 'POST',
    body: allowance === undefined ? { step } : { step, allowance },
  });

/**
 * 200 answers with `recorded` too (for the USDC move, { movedAtomic }), or with `ended` when the
 * allowance is gone; 202 answers with the digest alone, meaning Sui has not shown the result yet.
 */
export const submitOnboardingStep = (step: BuildStepName, txBytesBase64: string, signature: string) =>
  ownerFetch<{ recorded?: string | { movedAtomic: string }; ended?: true; digest: string }>(
    '/api/owner/onboarding/submit',
    {
      method: 'POST',
      body: { step, txBytesBase64, signature },
    },
  );

export const confirmOnboardingDigest = (step: OnboardingStepName | 'end_allowance', digest: string) =>
  ownerFetch<{ recorded: string }>('/api/owner/onboarding/confirm', { method: 'POST', body: { step, digest } });

export const confirmExistingStep = (step: 'memory_account' | 'add_delegate') =>
  ownerFetch<{ recorded: string }>('/api/owner/onboarding/confirm', { method: 'POST', body: { step, existing: true } });

export const requestStepUp = (request: StepUpRequest) =>
  ownerFetch<StepUpIssued>('/api/owner/step-up', { method: 'POST', body: request });

export const fetchAgents = () => ownerFetch<{ agents: Agent[] }>('/api/owner/agents');

export const createAgent = (label: string, stepUp: StepUpProof) =>
  ownerFetch<{ agentId: string; token: string; displayPrefix: string }>('/api/owner/agents', {
    method: 'POST',
    body: { label, stepUp },
  });

export const revokeAgent = (agentId: string) =>
  ownerFetch<{ revoked: true }>(`/api/owner/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });

export const fetchSettings = () => ownerFetch<Settings>('/api/owner/settings');

export const patchSettings = (change: SettingsChange, stepUp?: StepUpProof) =>
  ownerFetch<Settings>('/api/owner/settings', {
    method: 'PATCH',
    body: stepUp === undefined ? change : { ...change, stepUp },
  });

export const endEverySession = () =>
  ownerFetch<{ signedOut: true; sessionsEnded: number }>('/api/owner/sessions', { method: 'DELETE' });

export const runBuiltinAgent = (task: string, signal?: AbortSignal) =>
  ownerFetch<RunResult>('/api/owner/agent/run', { method: 'POST', body: { task }, signal });

/** Where the owner's own USDC and SUI sit. Reading it costs a Sui call, so it is read on demand only. */
export type WalletFunds = {
  usdcAddressAtomic: string;
  usdcCoinAtomic: string;
  suiAddressMist: string;
  suiCoinMist: string;
};

export const fetchWalletFunds = () => ownerFetch<WalletFunds>('/api/owner/onboarding/wallet');
