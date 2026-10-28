import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners } from '../db/schema.js';

export const ONBOARDING_STEPS = ['memory_account', 'add_delegate', 'allowance'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The steps about the owner's Walrus Memory account, which Sui can show as done before Ellai builds anything. */
export const ACCOUNT_STEPS = ['memory_account', 'add_delegate'] as const;
export type AccountStep = (typeof ACCOUNT_STEPS)[number];

/**
 * Moves the owner's USDC coins into their address balance, the only part an allowance draws from.
 * Not one of the three recorded steps: nothing is stored, and it can be run any number of times.
 */
export const USDC_MOVE_STEP = 'usdc_to_address';

/**
 * Ends the owner's recorded allowance on Sui with the cap in their wallet. Not one of the three
 * recorded steps: once it lands the allowance is forgotten, and onboarding shows it missing.
 */
export const END_ALLOWANCE_STEP = 'end_allowance';

/** Every transaction the build and submit routes make for an owner: the three steps, the USDC move and ending the allowance. */
export const BUILD_STEPS = [...ONBOARDING_STEPS, USDC_MOVE_STEP, END_ALLOWANCE_STEP] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

/** Every step confirm takes a digest for: the three recorded steps and ending the allowance. */
export const CONFIRM_STEPS = [...ONBOARDING_STEPS, END_ALLOWANCE_STEP] as const;
export type ConfirmStep = (typeof CONFIRM_STEPS)[number];

export type OnboardingErrorCode =
  | 'BAD_INPUT'
  | 'NO_OWNER'
  | 'NOT_READY'
  | 'NOT_LANDED'
  | 'REFUSED'
  | 'ALREADY_DONE'
  | 'BAD_TRANSACTION'
  | 'NOTHING_TO_MOVE'
  | 'NOT_ENOUGH_SUI';

/** The one sentence for ALREADY_DONE, which the screens show as it is. */
export const ALREADY_DONE_MESSAGE = 'This step is already done on Sui. Confirm it to continue.';

/** The one sentence for NOTHING_TO_MOVE: the owner's wallet holds no USDC coins, so any USDC it has is already in its address balance. */
export const NOTHING_TO_MOVE_MESSAGE = 'Your wallet holds no USDC coins to move. Any USDC it has is already in its address balance.';

/** The one sentence for NOT_ENOUGH_SUI: neither the owner's SUI address balance nor their SUI coins cover the transaction's gas budget. */
export const NOT_ENOUGH_SUI_MESSAGE = "Your wallet needs a little SUI to pay this transaction's fee.";

/** NOT_READY for end_allowance when the owner row records no allowance. */
export const NO_ALLOWANCE_MESSAGE = 'You have no allowance to end.';

/** ALREADY_DONE for end_allowance when Sui no longer has the recorded allowance, which Ellai has then forgotten. */
export const ALLOWANCE_ENDED_MESSAGE = 'This allowance has already ended on Sui.';

/** NOT_READY for end_allowance when Sui shows no AllowanceCap for the recorded allowance in the owner's wallet. */
export const NO_ALLOWANCE_CAP_MESSAGE = 'Sui shows no key to end this allowance in your wallet.';

/**
 * Every refusal from onboarding. The message is fixed text plus limits and ids Ellai read or
 * validated itself, never a value the caller sent or upstream text.
 * NOT_LANDED means Sui does not show the transaction or its object yet, so asking again
 * shortly can succeed. REFUSED means the chain shows something other than what the step needs.
 * ALREADY_DONE means Sui already shows what the step would do, so it is confirmed without a
 * transaction. BAD_TRANSACTION means signed bytes sent to be relayed are not the step Ellai
 * builds for this owner, and nothing was sent. NOTHING_TO_MOVE means the owner holds no USDC
 * coins for the USDC move. NOT_ENOUGH_SUI means the owner's SUI cannot cover the gas budget.
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

export function checkBuildStep(step: unknown): BuildStep {
  if (typeof step !== 'string' || !(BUILD_STEPS as readonly string[]).includes(step)) {
    throw new OnboardingError('BAD_INPUT', `the step must be one of ${BUILD_STEPS.join(', ')}`);
  }
  return step as BuildStep;
}

export function checkConfirmStep(step: unknown): ConfirmStep {
  if (typeof step !== 'string' || !(CONFIRM_STEPS as readonly string[]).includes(step)) {
    throw new OnboardingError('BAD_INPUT', `the step must be one of ${CONFIRM_STEPS.join(', ')}`);
  }
  return step as ConfirmStep;
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

/**
 * Forgets an allowance that can never pay again, so onboarding shows it missing and the tick stops
 * visiting this owner for refills (C22). Only the allowance read is cleared: one recorded since
 * then stays.
 */
export async function forgetAllowance(db: Database, ownerId: string, allowanceId: string): Promise<void> {
  await db
    .update(owners)
    .set({ allowanceId: null, allowanceCheckedAt: null, refillNotBefore: null })
    .where(and(eq(owners.id, ownerId), eq(owners.allowanceId, allowanceId)));
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
