import type { AllowanceTerms, Settings, SettingsChange } from './api.js';

const ATOMIC_PER_USDC = 1_000_000n;

/** "0.5" or "5" or "5.00" to atomic USDC. Nothing else is accepted, so no rounding can happen. */
export function parseUsdc(text: string): bigint | null {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  return whole * ATOMIC_PER_USDC + fraction;
}

/** Atomic USDC to the text an input shows, at least two decimals: 50000n becomes "0.05". */
export function usdcInputText(atomic: string): string {
  const padded = atomic.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction}`;
}

// The same bounds the server holds the onboarding allowance to (core limits).
const DAILY_MIN = 100_000n;
const DAILY_MAX = 5_000_000n;
const CAP_MAX = 50_000_000n;
const DAYS_MIN = 1;
const DAYS_MAX = 90;

export const ALLOWANCE_HINTS = {
  daily: '0.10 to 5.00',
  cap: 'At least the daily limit, up to 50.00',
  days: '1 to 90',
} as const;

export type AllowanceInput = { daily: string; cap: string; days: string };

export type AllowanceCheck = {
  terms: AllowanceTerms | null;
  /** Which fields are outside their bounds. */
  bad: { daily: boolean; cap: boolean; days: boolean };
};

export function checkAllowance(input: AllowanceInput): AllowanceCheck {
  const daily = parseUsdc(input.daily);
  const cap = parseUsdc(input.cap);
  const days = /^\d{1,3}$/.test(input.days.trim()) ? Number(input.days.trim()) : null;
  const bad = {
    daily: daily === null || daily < DAILY_MIN || daily > DAILY_MAX,
    cap: cap === null || cap > CAP_MAX || (daily !== null && cap < daily),
    days: days === null || days < DAYS_MIN || days > DAYS_MAX,
  };
  if (bad.daily || bad.cap || bad.days || daily === null || cap === null || days === null) return { terms: null, bad };
  return { terms: { dailyLimitAtomic: daily.toString(), lifetimeCapAtomic: cap.toString(), days }, bad };
}

const PER_PAYMENT_MIN = 10_000n;
const PER_PAYMENT_MAX = 1_000_000n;
const DAILY_BUDGET_MAX = 5_000_000n;

export const SPENDING_HINTS = {
  perPayment: '0.01 to 1.00',
  daily: 'Up to 5.00, at least the per-payment amount',
} as const;

export type SpendingCheck = { perPayment: string | null; daily: string | null; bad: { perPayment: boolean; daily: boolean } };

export function checkSpending(input: { perPayment: string; daily: string }): SpendingCheck {
  const perPayment = parseUsdc(input.perPayment);
  const daily = parseUsdc(input.daily);
  const bad = {
    perPayment: perPayment === null || perPayment < PER_PAYMENT_MIN || perPayment > PER_PAYMENT_MAX,
    daily: daily === null || daily > DAILY_BUDGET_MAX || (perPayment !== null && daily < perPayment),
  };
  return {
    perPayment: perPayment === null || bad.perPayment ? null : perPayment.toString(),
    daily: daily === null || bad.daily ? null : daily.toString(),
    bad,
  };
}

/**
 * Whether a settings change lets Ellai do more than it does now, by the rules the server uses
 * (contract 4.3): higher amounts, fewer approvals, a higher cutoff, resuming, clearing a pause,
 * turning the public proof page on. The server decides in the end; this only picks the route.
 */
export function loosens(current: Settings, change: SettingsChange): boolean {
  if (change.perPaymentMaxAtomic !== undefined && BigInt(change.perPaymentMaxAtomic) > BigInt(current.perPaymentMaxAtomic)) {
    return true;
  }
  if (change.dailyBudgetAtomic !== undefined && BigInt(change.dailyBudgetAtomic) > BigInt(current.dailyBudgetAtomic)) {
    return true;
  }
  if (change.approvalsNeeded !== undefined && change.approvalsNeeded < current.approvalsNeeded) return true;
  // The server stores the cutoff as a 32-bit float, so both sides are compared that way.
  if (change.distanceCutoff !== undefined && Math.fround(change.distanceCutoff) > Math.fround(current.distanceCutoff)) {
    return true;
  }
  if (change.paused === false && current.paused) return true;
  if (change.clearAutoPause === true && current.autoPausedReason !== null) return true;
  if (change.publicProof === true && !current.publicProof) return true;
  return false;
}

/** The cutoff the way the slider and the overview show it: two decimals. */
export function cutoffText(value: number): string {
  return value.toFixed(2);
}

export function sameCutoff(a: number, b: number): boolean {
  return Math.fround(a) === Math.fround(b);
}
