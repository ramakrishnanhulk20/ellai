import { randomInt } from 'node:crypto';
import { buildIssueAllowance } from '@ellai/core/allowance';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { buildAddDelegateTx, buildCreateAccountTx } from '@ellai/core/memory';
import { toBase64 } from '@mysten/sui/utils';
import type { Database } from '../db/client.js';
import { formatUsdc } from '../decide/sentences.js';
import { ownerDelegate } from '../memory/delegate.js';
import { checkNow, checkStep, loadOwner, OnboardingError, type OnboardingStep } from './state.js';

/** Stored on chain next to Ellai's key on the owner's Walrus Memory account. */
export const DELEGATE_LABEL = 'Ellai';

/**
 * The Tatum calls buildOnboardingTx's success path makes for each step, which the build route
 * counts against the day's budgets before any of them (C22): the registry and the owner's registry
 * entry, the account too for a delegate, then the one simulate call that resolves the
 * transaction; or the epoch and the gas price for an allowance.
 */
export const BUILD_CHAIN_CALLS: Readonly<Record<OnboardingStep, number>> = { memory_account: 3, add_delegate: 4, allowance: 2 };
// A unit conversion: the owner sets how long the allowance runs as a count of days.
const MS_PER_DAY = 86_400_000;
const MAX_DAYS = Math.floor(LIMITS.onboardingAllowanceMaxMs / MS_PER_DAY);
// The allowance's nonce field is a u32.
const NONCE_RANGE = 2 ** 32;

export interface AllowanceRequest {
  dailyLimitAtomic: bigint;
  lifetimeCapAtomic: bigint;
  days: number;
}

export interface SummaryLine {
  label: string;
  value: string;
}

function bad(message: string): never {
  throw new OnboardingError('BAD_INPUT', message);
}

interface AllowanceTerms {
  dailyLimitAtomic: bigint;
  lifetimeCapAtomic: bigint;
  expirationMs: number;
}

function checkAllowance(request: unknown, now: Date): AllowanceTerms {
  if (typeof request !== 'object' || request === null) bad('give the daily limit, the total cap and the number of days');
  const { dailyLimitAtomic: daily, lifetimeCapAtomic: cap, days } = request as Record<string, unknown>;
  const dailyMax = BigInt(LIMITS.onboardingDailyLimitMaxAtomic);
  const capMax = BigInt(LIMITS.onboardingLifetimeCapMaxAtomic);
  // The purse is refilled a fixed amount at a time, so a smaller daily limit could never fund one refill.
  const dailyMin = BigInt(LIMITS.purseRefillAtomic);
  if (typeof daily !== 'bigint' || daily < dailyMin || daily > dailyMax) {
    bad(`the daily limit must be at least ${formatUsdc(dailyMin)} and at most ${formatUsdc(dailyMax)} USDC`);
  }
  if (typeof cap !== 'bigint' || cap < daily || cap > capMax) {
    bad(`the total cap must be at least the daily limit and at most ${formatUsdc(capMax)} USDC`);
  }
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days * MS_PER_DAY > LIMITS.onboardingAllowanceMaxMs) {
    bad(`the allowance must run a whole number of days, from 1 to ${MAX_DAYS}`);
  }
  return { dailyLimitAtomic: daily, lifetimeCapAtomic: cap, expirationMs: now.getTime() + days * MS_PER_DAY };
}

function utcMinute(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Builds the transaction the owner signs in their own wallet for one onboarding step, and a
 * plain list of what it does. Nothing is signed or sent, and nothing is recorded: the step
 * counts only once confirmOnboardingTx has read its result from chain.
 * - memory_account: create_account for the owner's own Walrus Memory account (core
 *   buildCreateAccountTx), refused when Sui already shows one.
 * - add_delegate: adds Ellai's derived delegate key for this owner, named "Ellai", to the
 *   recorded account (core buildAddDelegateTx). Needs the account recorded first.
 * - allowance: the owner lets their own purse draw Sui Mainnet USDC from the owner's address
 *   balance: at most dailyLimitAtomic per LIMITS.allowancePeriodMs (a fixed day),
 *   lifetimeCapAtomic in total, ending `days` whole days after `now` (core buildIssueAllowance, epoch and gas price read through
 *   `chain`). Daily limit in (0, LIMITS.onboardingDailyLimitMaxAtomic], total cap in
 *   [daily limit, LIMITS.onboardingLifetimeCapMaxAtomic], days from 1 to the
 *   LIMITS.onboardingAllowanceMaxMs span. The owner pays gas, at most LIMITS.issueGasBudgetMist,
 *   from their SUI address balance, and the bytes are valid only in this epoch and the next.
 * Owner, purse and account come from the owner row, never from the caller, and every
 * summary value is one of those or a validated term (C7, C15).
 * Throws OnboardingError: BAD_INPUT for a bad step, date, owner id or allowance term;
 * NO_OWNER; NOT_READY for add_delegate before the account is recorded. Throws MemoryError,
 * AllowanceError or ChainError from core when Sui refuses the build or Tatum cannot answer.
 */
export async function buildOnboardingTx(args: {
  db: Database;
  ownerId: string;
  step: OnboardingStep;
  allowance?: AllowanceRequest;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<{ txBytesBase64: string; summary: SummaryLine[] }> {
  const step = checkStep(args.step);
  const now = checkNow(args.now);
  const terms = step === 'allowance' ? checkAllowance(args.allowance, now) : null;
  const owner = await loadOwner(args.db, args.ownerId);
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);
  const { chain } = args;

  if (step === 'memory_account') {
    const bytes = await buildCreateAccountTx({ chain, owner: ownerAddress });
    return {
      txBytesBase64: toBase64(bytes),
      summary: [
        { label: 'Action', value: 'Create your Walrus Memory account' },
        { label: 'Account owner', value: ownerAddress },
      ],
    };
  }

  if (step === 'add_delegate') {
    if (owner.memwalAccountId === null) throw new OnboardingError('NOT_READY', 'create the Walrus Memory account first');
    const accountId = canonicalSuiAddress(owner.memwalAccountId);
    const { keypair, publicKeyHex } = ownerDelegate(args.masterSecretHex, ownerAddress);
    const bytes = await buildAddDelegateTx({
      chain,
      owner: ownerAddress,
      accountId,
      delegatePublicKey: keypair.getPublicKey().toRawBytes(),
      label: DELEGATE_LABEL,
    });
    return {
      txBytesBase64: toBase64(bytes),
      summary: [
        { label: 'Action', value: "Add Ellai's key to your Walrus Memory account" },
        { label: 'Walrus Memory account', value: accountId },
        { label: 'Key added', value: publicKeyHex },
        { label: 'Key name', value: DELEGATE_LABEL },
      ],
    };
  }

  if (terms === null) bad('give the daily limit, the total cap and the number of days');
  const purseAddress = canonicalSuiAddress(owner.purseAddress);
  const epoch = await chain.getCurrentEpoch();
  const referenceGasPrice = await chain.getReferenceGasPrice();
  const bytes = await buildIssueAllowance(
    {
      owner: ownerAddress,
      spender: purseAddress,
      terms: {
        lifetimeCapAtomic: terms.lifetimeCapAtomic,
        periodMs: BigInt(LIMITS.allowancePeriodMs),
        periodLimitAtomic: terms.dailyLimitAtomic,
        expirationMs: BigInt(terms.expirationMs),
      },
    },
    { epoch, referenceGasPrice, nonce: randomInt(0, NONCE_RANGE) },
  );
  return {
    txBytesBase64: toBase64(bytes),
    summary: [
      { label: 'Action', value: 'Let your Ellai purse draw USDC from your address balance' },
      { label: 'Who may spend', value: purseAddress },
      { label: 'Daily limit', value: `${formatUsdc(terms.dailyLimitAtomic)} USDC` },
      { label: 'Total cap', value: `${formatUsdc(terms.lifetimeCapAtomic)} USDC` },
      { label: 'Ends', value: utcMinute(terms.expirationMs) },
    ],
  };
}
