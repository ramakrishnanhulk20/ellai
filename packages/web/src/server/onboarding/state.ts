import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners } from '../db/schema.js';

export const ONBOARDING_STEPS = ['memory_account', 'add_delegate', 'allowance'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingErrorCode = 'BAD_INPUT' | 'NO_OWNER' | 'NOT_READY' | 'NOT_LANDED' | 'REFUSED';

/**
 * Every refusal from onboarding. The message is fixed text plus limits and ids Ellai read or
 * validated itself, never a value the caller sent or upstream text.
 * NOT_LANDED means Sui does not show the transaction or its object yet, so asking again
 * shortly can succeed. REFUSED means the chain shows something other than what the step needs.
 */
export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;

  constructor(code: OnboardingErrorCode, message: string) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
  }
}

export type OwnerRow = typeof owners.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkStep(step: unknown): OnboardingStep {
  if (typeof step !== 'string' || !(ONBOARDING_STEPS as readonly string[]).includes(step)) {
    throw new OnboardingError('BAD_INPUT', `the step must be one of ${ONBOARDING_STEPS.join(', ')}`);
  }
  return step as OnboardingStep;
}

export function checkNow(now: unknown): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new OnboardingError('BAD_INPUT', 'now must be a valid date');
  return now;
}

/** The owner's row. A malformed id is refused here, so it never reaches the uuid column as a database error. */
export async function loadOwner(db: Database, ownerId: unknown): Promise<OwnerRow> {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new OnboardingError('BAD_INPUT', 'the owner id is not a uuid');
  const [owner] = await db.select().from(owners).where(eq(owners.id, ownerId));
  if (owner === undefined) throw new OnboardingError('NO_OWNER', 'no owner has this id');
  return owner;
}

export interface OnboardingState {
  memoryAccount: 'missing' | 'present';
  delegate: 'missing' | 'present';
  allowance: 'missing' | 'present';
  purseAddress: string;
}

/**
 * How far the owner is through onboarding, from the owner row alone: each step is present
 * once confirmOnboardingTx has checked it on chain and recorded it. Reads nothing from chain,
 * so a present step says what Ellai verified then, not what holds now.
 * Throws OnboardingError: BAD_INPUT for an owner id that is not a uuid, NO_OWNER.
 */
export async function onboardingState(args: { db: Database; ownerId: string }): Promise<OnboardingState> {
  const owner = await loadOwner(args.db, args.ownerId);
  return {
    memoryAccount: owner.memwalAccountId === null ? 'missing' : 'present',
    delegate: owner.delegateRegisteredAt === null ? 'missing' : 'present',
    allowance: owner.allowanceId === null || owner.allowanceCheckedAt === null ? 'missing' : 'present',
    purseAddress: owner.purseAddress,
  };
}
