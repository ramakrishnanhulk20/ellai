import { buildIssueAllowance } from '@ellai/core/allowance';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { buildAddDelegateTx, buildCreateAccountTx, findMemoryAccount } from '@ellai/core/memory';
import { toBase64 } from '@mysten/sui/utils';
import type { Database } from '../db/client.js';
import { formatUsdc } from '../decide/sentences.js';
import { ownerDelegate } from '../memory/delegate.js';
import { buildUsdcMoveStep, chooseOwnerGas } from './funds.js';
import {
  ALREADY_DONE_MESSAGE,
  type AccountStep,
  type BuildStep,
  checkBuildStep,
  checkNow,
  loadOwner,
  OnboardingError,
  type OwnerRow,
  USDC_MOVE_STEP,
} from './state.js';

/** Stored on chain next to Ellai's key on the owner's Walrus Memory account. */
export const DELEGATE_LABEL = 'Ellai';

/**
 * The Tatum calls buildOnboardingTx's success path makes for each step, which the build route
 * counts against the day's budgets before any of them (C22). An account step first reads what Sui
 * already shows with findMemoryAccount (the registry and the owner's registry entry, the account
 * too for a delegate), then core's builder reads the registry and the entry again, the account too
 * for a delegate, and makes the one simulate call that resolves the transaction: 2 + 3 and 3 + 4.
 * An allowance chooses its gas source (chooseOwnerGas: the owner's balances, then the gas price and
 * either the epoch or the owner's SUI coins), three calls. The USDC move lists the owner's USDC
 * coins first, then chooses its gas source the same way: four.
 */
export const BUILD_CHAIN_CALLS: Readonly<Record<BuildStep, number>> = { memory_account: 5, add_delegate: 7, allowance: 3, usdc_to_address: 4 };
// A unit conversion: the owner sets how long the allowance runs as a count of days.
const MS_PER_DAY = 86_400_000;
const MAX_DAYS = Math.floor(LIMITS.onboardingAllowanceMaxMs / MS_PER_DAY);

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
 * Builds the owner's own unsigned transaction for an account step, with the owner, the account
 * and Ellai's derived delegate key taken from the owner row and the master secret, never from a
 * caller (C7), and a plain summary of it. Before building, Sui is read through `chain` with
 * findMemoryAccount, and a step Sui already shows done is refused with ALREADY_DONE, so the owner
 * is never asked to sign a transaction that could only fail: memory_account when the owner has
 * any account; add_delegate when the recorded account holds Ellai's key for this owner.
 * add_delegate needs the account recorded first (NOT_READY), checked before any chain read.
 * Core's builders check the bytes they return (one call to the account function, the owner as
 * sender and gas payer, gas at most LIMITS.memwalAccountTxMaxGasMist).
 * Throws OnboardingError ALREADY_DONE or NOT_READY; MemoryError or ChainError from core when
 * Sui refuses the build or Tatum cannot answer.
 */
export async function buildAccountStep(args: {
  chain: Chain;
  owner: OwnerRow;
  step: AccountStep;
  masterSecretHex: string;
}): Promise<{ bytes: Uint8Array; summary: SummaryLine[] }> {
  const { chain, owner, step } = args;
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);

  if (step === 'memory_account') {
    if ((await findMemoryAccount(chain, ownerAddress)) !== null) throw new OnboardingError('ALREADY_DONE', ALREADY_DONE_MESSAGE);
    const bytes = await buildCreateAccountTx({ chain, owner: ownerAddress });
    return {
      bytes,
      summary: [
        { label: 'Action', value: 'Create your Walrus Memory account' },
        { label: 'Account owner', value: ownerAddress },
      ],
    };
  }

  if (owner.memwalAccountId === null) throw new OnboardingError('NOT_READY', 'create the Walrus Memory account first');
  const accountId = canonicalSuiAddress(owner.memwalAccountId);
  const { keypair, publicKeyHex } = ownerDelegate(args.masterSecretHex, ownerAddress);
  const onChain = await findMemoryAccount(chain, ownerAddress);
  // The delegate list and publicKeyHex are lowercase hex from the same SDK encoder. A key on some
  // other account is not this step done: core's builder refuses that account instead.
  if (onChain !== null && canonicalSuiAddress(onChain.accountId) === accountId && onChain.delegates.includes(publicKeyHex)) {
    throw new OnboardingError('ALREADY_DONE', ALREADY_DONE_MESSAGE);
  }
  const bytes = await buildAddDelegateTx({
    chain,
    owner: ownerAddress,
    accountId,
    delegatePublicKey: keypair.getPublicKey().toRawBytes(),
    label: DELEGATE_LABEL,
  });
  return {
    bytes,
    summary: [
      { label: 'Action', value: "Add Ellai's key to your Walrus Memory account" },
      { label: 'Walrus Memory account', value: accountId },
      { label: 'Key added', value: publicKeyHex },
      { label: 'Key name', value: DELEGATE_LABEL },
    ],
  };
}

/**
 * Builds the transaction the owner signs in their own wallet for one onboarding step or the USDC
 * move, and a plain list of what it does. Nothing is signed or sent, and nothing is recorded: a
 * step counts only once confirmOnboardingTx has read its result from chain.
 * - memory_account: create_account for the owner's own Walrus Memory account (core
 *   buildCreateAccountTx), refused with ALREADY_DONE when Sui already shows one (buildAccountStep).
 * - add_delegate: adds Ellai's derived delegate key for this owner, named "Ellai", to the
 *   recorded account (core buildAddDelegateTx). Needs the account recorded first, and is refused
 *   with ALREADY_DONE when Sui shows that account already holding the key.
 * - allowance: the owner lets their own purse draw Sui Mainnet USDC from the owner's address
 *   balance: at most dailyLimitAtomic per LIMITS.allowancePeriodMs (a fixed day),
 *   lifetimeCapAtomic in total, ending `days` whole days after `now` (core buildIssueAllowance).
 *   Daily limit in (0, LIMITS.onboardingDailyLimitMaxAtomic], total cap in
 *   [daily limit, LIMITS.onboardingLifetimeCapMaxAtomic], days from 1 to the
 *   LIMITS.onboardingAllowanceMaxMs span. The owner pays gas, at most LIMITS.issueGasBudgetMist, as
 *   chooseOwnerGas picks from a live read: from their SUI address balance when it covers the budget,
 *   the bytes then valid only in this epoch and the next, otherwise with the fewest of their SUI
 *   coins that do.
 * - usdc_to_address: moves the owner's USDC coins into their own address balance, gas chosen the
 *   same way (buildUsdcMoveStep). Not a recorded step.
 * Owner, purse and account come from the owner row, never from the caller, and every
 * summary value is one of those or a validated term (C7, C15).
 * Throws OnboardingError: BAD_INPUT for a bad step, date, owner id or allowance term;
 * NO_OWNER; NOT_READY for add_delegate before the account is recorded; ALREADY_DONE for an
 * account step Sui already shows done; NOTHING_TO_MOVE for the move when the owner holds no USDC
 * coins; NOT_ENOUGH_SUI when the owner's SUI cannot cover the gas budget. Throws MemoryError,
 * AllowanceError or ChainError from core when Sui refuses the build or Tatum cannot answer.
 */
export async function buildOnboardingTx(args: {
  db: Database;
  ownerId: string;
  step: BuildStep;
  allowance?: AllowanceRequest;
  chain: Chain;
  masterSecretHex: string;
  now: Date;
}): Promise<{ txBytesBase64: string; summary: SummaryLine[] }> {
  const step = checkBuildStep(args.step);
  const now = checkNow(args.now);
  const terms = step === 'allowance' ? checkAllowance(args.allowance, now) : null;
  const owner = await loadOwner(args.db, args.ownerId);
  const ownerAddress = canonicalSuiAddress(owner.suiAddress);
  const { chain } = args;

  if (step === USDC_MOVE_STEP) {
    const { bytes, summary } = await buildUsdcMoveStep(chain, ownerAddress);
    return { txBytesBase64: toBase64(bytes), summary };
  }
  if (step !== 'allowance') {
    const { bytes, summary } = await buildAccountStep({ chain, owner, step, masterSecretHex: args.masterSecretHex });
    return { txBytesBase64: toBase64(bytes), summary };
  }

  if (terms === null) bad('give the daily limit, the total cap and the number of days');
  const purseAddress = canonicalSuiAddress(owner.purseAddress);
  const facts = await chooseOwnerGas(chain, ownerAddress, LIMITS.issueGasBudgetMist);
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
    facts,
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
