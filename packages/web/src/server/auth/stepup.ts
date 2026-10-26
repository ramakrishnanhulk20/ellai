import { createHash, randomBytes } from 'node:crypto';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { TEXT_CAPS, owners, stepUps } from '../db/schema.js';
import { formatUsdc } from '../decide/sentences.js';
import { HttpError } from '../http/errors.js';
import { atomicAmountText } from '../http/owner-limits.js';
import { consumeWindow } from '../http/ratelimit.js';
import { checkLabel } from './agents.js';
import { SignInError, recoveredAddress, zkLoginChecksOf } from './signin.js';

const MIN_PAYMENT = BigInt(LIMITS.minPaymentAtomic);
const MAX_PAYMENT = BigInt(LIMITS.maxPaymentAtomic);
const MAX_DAILY_BUDGET = BigInt(LIMITS.onboardingDailyLimitMaxAtomic);
const NONCE_PATTERN = new RegExp(`^[0-9a-f]{${LIMITS.signinNonceBytes * 2}}$`);
const STEP_UP_KEY_PREFIX = 'owner-step-up:';
// A label cannot start a line of its own in the message, where it could pass for another setting.
const LINE_BREAKS = /[\r\n\v\f\u0085\p{Zl}\p{Zp}]/gu;

/**
 * Bytes a step-up proof can add to a request body: a signature of at most
 * LIMITS.signinSignatureMaxChars base64 characters, one byte each in JSON, and the nonce with its
 * keys and punctuation, which take under 100.
 */
export const STEP_UP_PROOF_MAX_BYTES = LIMITS.signinSignatureMaxChars + 256;

/** Either change fits its own route's cap, and the other cap is far more than the action and the wrapping take. */
export const STEP_UP_REQUEST_MAX_BYTES = LIMITS.settingsBodyMaxBytes + LIMITS.agentLabelBodyMaxBytes;

/** A signed step-up as the agents and settings routes take it: the nonce the step-up route issued and the wallet's signature over its message. */
export const stepUpProof = z.strictObject({
  nonce: z.string().regex(NONCE_PATTERN),
  signature: z.string().min(1).max(LIMITS.signinSignatureMaxChars),
});

export type StepUpProof = z.output<typeof stepUpProof>;

const SETTINGS_FIELDS = {
  paused: z.boolean().optional(),
  perPaymentMaxAtomic: atomicAmountText.optional(),
  dailyBudgetAtomic: atomicAmountText.optional(),
  approvalsNeeded: z.number().optional(),
  distanceCutoff: z.number().optional(),
  clearAutoPause: z.literal(true).optional(),
  publicProof: z.boolean().optional(),
};

const SETTINGS_KEYS = Object.keys(SETTINGS_FIELDS);
const changesSomething = (body: Record<string, unknown>) => SETTINGS_KEYS.some((key) => body[key] !== undefined);

/**
 * A settings change as PATCH /api/owner/settings reads it and a step-up names it: any of these
 * fields, at least one, the amounts as decimal strings. Its bounds are settingsBoundsProblem's.
 */
export const settingsChange = z.strictObject(SETTINGS_FIELDS).refine(changesSomething);

/** The settings route's body: a settings change, with a step-up when the change loosens anything. */
export const settingsPatch = z.strictObject({ ...SETTINGS_FIELDS, stepUp: stepUpProof.optional() }).refine(changesSomething);

export type SettingsChange = z.output<typeof settingsChange>;

const AGENT_FIELDS = { label: z.string() };

/** A new agent key as POST /api/owner/agents reads it and a step-up names it. agentLabel checks the label. */
export const agentChange = z.strictObject(AGENT_FIELDS);

/** The agents route's body: the label and the step-up every new agent key needs. */
export const agentCreate = z.strictObject({ ...AGENT_FIELDS, stepUp: stepUpProof.optional() });

/** The step-up route's body: which change, read exactly as the route that applies it reads it. */
export const stepUpRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create_agent'), change: agentChange }),
  z.strictObject({ action: z.literal('loosen_settings'), change: settingsChange }),
]);

export type StepUpRequest = z.output<typeof stepUpRequest>;

/** The owner columns a settings change is checked against and returns. */
export const OWNER_SETTINGS = {
  paused: owners.paused,
  autoPausedReason: owners.autoPausedReason,
  perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
  dailyBudgetAtomic: owners.dailyBudgetAtomic,
  approvalsNeeded: owners.approvalsNeeded,
  distanceCutoff: owners.distanceCutoff,
  publicProof: owners.publicProof,
};

export interface OwnerSettings {
  paused: boolean;
  autoPausedReason: string | null;
  perPaymentMaxAtomic: bigint;
  dailyBudgetAtomic: bigint;
  approvalsNeeded: number;
  distanceCutoff: number;
  publicProof: boolean;
}

function checkNow(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  return now;
}

/**
 * Why a settings change is outside its bounds, as one sentence of fixed text and LIMITS, or null
 * when it is within them: the per-payment maximum within [LIMITS.minPaymentAtomic,
 * LIMITS.maxPaymentAtomic], the daily budget at most LIMITS.onboardingDailyLimitMaxAtomic and at
 * least the per-payment maximum after the change, approvals needed a whole number from
 * LIMITS.approvalsNeededMin to LIMITS.approvalsNeededMax, the distance cutoff above 0 and at most
 * LIMITS.distanceCutoffMax as the real column will hold it. Only what the change touches is
 * checked, so a value stored before these bounds existed can never stop an owner from pausing.
 */
export function settingsBoundsProblem(current: OwnerSettings, change: SettingsChange): string | null {
  const perPaymentMax = change.perPaymentMaxAtomic ?? current.perPaymentMaxAtomic;
  if (change.perPaymentMaxAtomic !== undefined && (perPaymentMax < MIN_PAYMENT || perPaymentMax > MAX_PAYMENT)) {
    return `The per-payment maximum must be from ${formatUsdc(MIN_PAYMENT)} to ${formatUsdc(MAX_PAYMENT)} USDC.`;
  }
  if (change.dailyBudgetAtomic !== undefined && change.dailyBudgetAtomic > MAX_DAILY_BUDGET) {
    return `The daily budget must be at most ${formatUsdc(MAX_DAILY_BUDGET)} USDC.`;
  }
  const amountsChange = change.perPaymentMaxAtomic !== undefined || change.dailyBudgetAtomic !== undefined;
  if (amountsChange && (change.dailyBudgetAtomic ?? current.dailyBudgetAtomic) < perPaymentMax) {
    return 'The daily budget must be at least the per-payment maximum.';
  }
  const approvals = change.approvalsNeeded;
  if (approvals !== undefined && (!Number.isSafeInteger(approvals) || approvals < LIMITS.approvalsNeededMin || approvals > LIMITS.approvalsNeededMax)) {
    return `Approvals needed must be a whole number from ${LIMITS.approvalsNeededMin} to ${LIMITS.approvalsNeededMax}.`;
  }
  // Checked as the real column will hold it, so a value that rounds to 0 there is refused
  // and what was checked is exactly what is stored.
  const cutoff = change.distanceCutoff === undefined ? undefined : Math.fround(change.distanceCutoff);
  if (cutoff !== undefined && !(cutoff > 0 && cutoff <= LIMITS.distanceCutoffMax)) return `The distance cutoff must be above 0 and at most ${LIMITS.distanceCutoffMax}.`;
  return null;
}

/**
 * Whether a settings change lets Ellai do more than `current` does, and so needs a step-up
 * (C36): it raises the per-payment maximum or the daily budget, lowers approvals needed, raises
 * the distance cutoff, unpauses a paused owner, clears an automatic pause that is set, or turns
 * the public proof page on. Each comparison is written so that a value it cannot order counts as
 * loosening, and the cutoff is compared as the real column holds both sides.
 */
export function settingsLoosen(current: OwnerSettings, change: SettingsChange): boolean {
  return (
    (change.perPaymentMaxAtomic !== undefined && !(change.perPaymentMaxAtomic <= current.perPaymentMaxAtomic)) ||
    (change.dailyBudgetAtomic !== undefined && !(change.dailyBudgetAtomic <= current.dailyBudgetAtomic)) ||
    (change.approvalsNeeded !== undefined && !(change.approvalsNeeded >= current.approvalsNeeded)) ||
    (change.distanceCutoff !== undefined && !(Math.fround(change.distanceCutoff) <= Math.fround(current.distanceCutoff))) ||
    (change.paused === false && current.paused) ||
    (change.clearAutoPause === true && current.autoPausedReason !== null) ||
    (change.publicProof === true && !current.publicProof)
  );
}

/**
 * An agent label as createAgentToken stores it, read by createAgentToken's own check, so the
 * label a step-up names is the label that is created. Throws AgentError BAD_INPUT.
 */
export function agentLabel(label: string): string {
  return checkLabel(label);
}

function normalised(request: StepUpRequest): StepUpRequest {
  return request.action === 'create_agent' ? { action: 'create_agent', change: { label: agentLabel(request.change.label) } } : request;
}

// Keys sorted at every level and bigints written as decimal strings, so one change has one
// spelling whatever order its fields arrived in. Anything without one exact JSON form is refused.
function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString(10));
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('a step-up change holds a number JSON cannot write');
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('a step-up change holds a value with no canonical form');
}

/**
 * The SHA-256, in lowercase hex, of the canonical JSON of { ownerId, action, change }, so it names
 * exactly one change for one owner.
 */
export function stepUpChangeHash(ownerId: string, request: StepUpRequest): string {
  return createHash('sha256').update(canonicalJson({ ownerId, action: request.action, change: request.change }), 'utf8').digest('hex');
}

// Exact to the atomic unit, with trailing zeros dropped down to cents: 2000000 reads 2.00, 15000 reads 0.015.
function usdcText(atomic: bigint): string {
  return formatUsdc(atomic).replace(/(\.\d{2}\d*?)0+$/, '$1');
}

// One line per field the change holds, always in this order, whatever order the body sent them in.
function changeLines(request: StepUpRequest): string[] {
  if (request.action === 'create_agent') return [`Create agent key: ${request.change.label.replace(LINE_BREAKS, '')}`];
  const change = request.change;
  const lines: string[] = [];
  if (change.perPaymentMaxAtomic !== undefined) lines.push(`Per-payment maximum: ${usdcText(change.perPaymentMaxAtomic)} USDC`);
  if (change.dailyBudgetAtomic !== undefined) lines.push(`Daily budget: ${usdcText(change.dailyBudgetAtomic)} USDC`);
  if (change.approvalsNeeded !== undefined) lines.push(`Approvals needed: ${change.approvalsNeeded}`);
  if (change.distanceCutoff !== undefined) lines.push(`Distance cutoff: ${change.distanceCutoff}`);
  if (change.paused !== undefined) lines.push(`Automatic payments: ${change.paused ? 'paused' : 'resumed'}`);
  if (change.clearAutoPause !== undefined) lines.push('Clear automatic pause: yes');
  if (change.publicProof !== undefined) lines.push(`Public proof page: ${change.publicProof ? 'on' : 'off'}`);
  return lines;
}

// The same reading of the app origin sign-in makes: an origin alone, or a server fault.
function hostOf(appOrigin: string): string {
  if (typeof appOrigin !== 'string' || !URL.canParse(appOrigin)) throw new Error('The app origin is not a URL');
  const url = new URL(appOrigin);
  if (url.origin !== appOrigin) throw new Error('The app origin must be an origin alone, as the environment check writes it');
  return url.host;
}

/**
 * Counts one step-up request against this owner's LIMITS.stepUpsPerOwnerPerHour, in the fixed hour
 * that holds `now` (C22). The key is the owner the session named, never anything the caller sends,
 * and a request over the limit still counts. Throws HttpError 429 too_many_step_ups beyond it.
 */
export async function limitStepUps(db: Database, ownerId: string, now: Date): Promise<void> {
  if (!(await consumeWindow(db, `${STEP_UP_KEY_PREFIX}${ownerId}`, LIMITS.stepUpsPerOwnerPerHour, LIMITS.rateWindowHourMs, checkNow(now)))) {
    throw new HttpError(429, 'too_many_step_ups');
  }
}

/**
 * Stores a step-up for one loosening change and returns the plain-text message the owner's wallet
 * signs as a Sui personal message (C36): the app's host, the owner's canonical address, one line
 * per field of the change in a fixed order and in words with units, the nonce (128 random bits)
 * and both times. It expires LIMITS.stepUpTtlMs after `now`. The row keeps the exact message and
 * stepUpChangeHash of the change, so the signature can authorise that change once and nothing else.
 * The change is checked as the route that applies it checks it: a label by agentLabel, a settings
 * change by settingsBoundsProblem against the owner's row and then settingsLoosen.
 * Throws AgentError BAD_INPUT for a bad label; HttpError 400 out_of_bounds for a setting outside
 * its bounds, 400 step_up_not_needed for a settings change that loosens nothing, 401 signed_out
 * when the owner row is gone. Throws Error for a `now` that is not a date or an app origin that
 * is not a bare origin, which are server faults.
 */
export async function issueStepUp(args: { db: Database; ownerId: string; appOrigin: string; request: StepUpRequest; now: Date }): Promise<{ nonce: string; message: string; expiresAt: Date }> {
  const now = checkNow(args.now);
  const host = hostOf(args.appOrigin);
  const request = normalised(args.request);
  const [owner] = await args.db
    .select({ suiAddress: owners.suiAddress, ...OWNER_SETTINGS })
    .from(owners)
    .where(eq(owners.id, args.ownerId));
  if (owner === undefined) throw new HttpError(401, 'signed_out');
  if (request.action === 'loosen_settings') {
    const problem = settingsBoundsProblem(owner, request.change);
    if (problem !== null) throw new HttpError(400, 'out_of_bounds', problem);
    if (!settingsLoosen(owner, request.change)) throw new HttpError(400, 'step_up_not_needed');
  }

  const nonce = randomBytes(LIMITS.signinNonceBytes).toString('hex');
  const expiresAt = new Date(now.getTime() + LIMITS.stepUpTtlMs);
  const message = [
    `${host} asks you to confirm a change to your Ellai account.`,
    '',
    `Account: ${canonicalSuiAddress(owner.suiAddress)}`,
    ...changeLines(request),
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join('\n');
  if (Array.from(message).length > TEXT_CAPS.stepUpMessage) throw new Error('The step-up message is longer than its column holds');
  await args.db.insert(stepUps).values({ nonce, ownerId: args.ownerId, action: request.action, changeHash: stepUpChangeHash(args.ownerId, request), message, createdAt: now, expiresAt });
  return { nonce, message, expiresAt };
}

function rejected(): never {
  throw new HttpError(401, 'step_up_rejected');
}

/**
 * Spends a step-up on exactly this change for this owner, or refuses it (C14, C36). In order:
 * 1. The owner's address is read; a missing row is HttpError 401 signed_out and spends nothing.
 * 2. The nonce is claimed by one conditional update that only this owner's unused, unexpired
 *    step-up can pass. It commits on its own, before the signature is checked, because a zkLogin
 *    check sends a Tatum request whose meter writes on this same connection, which an open
 *    transaction on PGlite would block. From here the nonce is spent whatever follows, so a
 *    replay or a race finds it used. Another owner's step-up is never touched.
 * 3. The claimed row must name this action and stepUpChangeHash of this change.
 * 4. The signature must recover, over the stored message, to the owner's address through
 *    sign-in's own check (zkLoginChecksOf, recoveredAddress): offline for Ed25519, Secp256k1,
 *    Secp256r1 and multisig, through `zkLoginClient` for zkLogin, inside the caller's Tatum scope.
 * Every refusal in 2 to 4 is HttpError 401 step_up_rejected with one fixed text, whatever the
 * reason, and leaves a claimed nonce used. Throws SignInError CHAIN_UNAVAILABLE (503) when Sui
 * cannot be read for a zkLogin proof, and HttpError 503 chain_unavailable_today when the Tatum
 * budget refuses that check; the nonce stays used. Returns only when the change may be applied.
 */
export async function claimStepUp(args: { db: Database; ownerId: string; request: StepUpRequest; proof: StepUpProof; zkLoginClient: ClientWithCoreApi; now: Date }): Promise<void> {
  const now = checkNow(args.now);
  const request = normalised(args.request);
  const changeHash = stepUpChangeHash(args.ownerId, request);
  const [owner] = await args.db.select({ suiAddress: owners.suiAddress }).from(owners).where(eq(owners.id, args.ownerId));
  if (owner === undefined) throw new HttpError(401, 'signed_out');
  const address = canonicalSuiAddress(owner.suiAddress);

  const [claimed] = await args.db
    .update(stepUps)
    .set({ usedAt: now })
    .where(and(eq(stepUps.nonce, args.proof.nonce), eq(stepUps.ownerId, args.ownerId), isNull(stepUps.usedAt), gt(stepUps.expiresAt, now)))
    .returning({ action: stepUps.action, changeHash: stepUps.changeHash, message: stepUps.message });
  if (claimed === undefined || claimed.action !== request.action || claimed.changeHash !== changeHash) rejected();

  let signer: string;
  try {
    const checks = zkLoginChecksOf(args.proof.signature);
    signer = await recoveredAddress(claimed.message, args.proof.signature, address, checks > 0 ? args.zkLoginClient : undefined);
  } catch (error) {
    if (error instanceof SignInError && error.code === 'BAD_SIGNATURE') rejected();
    throw error;
  }
  if (signer !== address) rejected();
}
