import { randomBytes } from 'node:crypto';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { SIGNATURE_SCHEME_TO_FLAG, parseSerializedSignature } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners, sessions, signinNonces } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import { consumeShared, consumeWindow } from '../http/ratelimit.js';
import { SESSION_TOKEN_PREFIX, newBearerToken } from './tokens.js';

export type SignInErrorCode =
  | 'BAD_ADDRESS'
  | 'BAD_MESSAGE'
  | 'WRONG_SITE'
  | 'BAD_SIGNATURE'
  | 'ZKLOGIN_UNAVAILABLE'
  | 'CHAIN_UNAVAILABLE'
  | 'NONCE_UNKNOWN'
  | 'NONCE_USED'
  | 'NONCE_EXPIRED';

const SIGN_IN_ERROR_MESSAGES: Readonly<Record<SignInErrorCode, string>> = {
  BAD_ADDRESS: 'the address is not a Sui address',
  BAD_MESSAGE: 'the sign-in message is not in the form Ellai issues',
  WRONG_SITE: 'the sign-in message is for a different site',
  BAD_SIGNATURE: 'the signature does not prove the address in the message signed it',
  ZKLOGIN_UNAVAILABLE: 'zkLogin sign-in is not available on this server',
  CHAIN_UNAVAILABLE: 'Sui could not be read to check this zkLogin signature',
  NONCE_UNKNOWN: 'the sign-in request was not issued by this server',
  NONCE_USED: 'the sign-in request has already been used',
  NONCE_EXPIRED: 'the sign-in request has expired',
};

/**
 * Every refusal of a caller's sign-in. The message comes from the code alone, so it can
 * never carry the address, message or signature the caller sent (C19).
 */
export class SignInError extends Error {
  readonly code: SignInErrorCode;

  constructor(code: SignInErrorCode) {
    super(SIGN_IN_ERROR_MESSAGES[code]);
    this.name = 'SignInError';
    this.code = code;
  }
}

function refuse(code: SignInErrorCode): never {
  throw new SignInError(code);
}

const NONCE_PATTERN = new RegExp(`^[0-9a-f]{${LIMITS.signinNonceBytes * 2}}$`);
const ZKLOGIN_FLAG = SIGNATURE_SCHEME_TO_FLAG.ZkLogin;
const MULTISIG_FLAG = SIGNATURE_SCHEME_TO_FLAG.MultiSig;

/** The checks against Sui that every zkLogin sign-in shares, whoever sends it (C22). */
export const ZKLOGIN_CHECK_QUOTAS = [
  { name: 'zklogin-checks:minute', limit: LIMITS.zkLoginChecksPerMinute, windowMs: LIMITS.rateWindowMinuteMs },
  { name: 'zklogin-checks:day', limit: LIMITS.zkLoginChecksPerDay, windowMs: LIMITS.rateWindowDayMs },
] as const;

/**
 * The checks against Sui one client may ask for, counted before the shared quotas so no single
 * client can spend them alone (C34). The minute's limit is counted first.
 */
export const ZKLOGIN_CLIENT_LIMITS = [
  { name: 'zklogin-checks:client:minute', limit: LIMITS.zkLoginChecksPerClientPerMinute, windowMs: LIMITS.rateWindowMinuteMs },
  { name: 'zklogin-checks:client:day', limit: LIMITS.zkLoginChecksPerClientPerDay, windowMs: LIMITS.rateWindowDayMs },
] as const;

interface Site {
  host: string;
  origin: string;
}

interface SignedIn {
  ownerId: string;
  sessionToken: string;
  expiresAt: Date;
}

interface SignInFields extends Site {
  address: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

function checkNow(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  return now;
}

// The one reading of the app origin, used both for the message issueSignIn writes and for
// the site completeSignIn expects, so the two can never disagree about case, port or form.
function siteOf(appOrigin: string): Site {
  if (typeof appOrigin !== 'string' || !URL.canParse(appOrigin)) throw new Error('The app origin is not a URL');
  const url = new URL(appOrigin);
  if (url.origin !== appOrigin) throw new Error('The app origin must be an origin alone, as the environment check writes it');
  return { host: url.host, origin: url.origin };
}

// The single definition of the message. completeSignIn rebuilds the message from the
// fields it parsed and requires the result to equal what was signed, so any spelling this
// function would not write, any extra text and any reordering is refused.
function formatSignInMessage(fields: SignInFields): string {
  return [
    `${fields.host} wants you to sign in to Ellai with your Sui account:`,
    fields.address,
    '',
    `URI: ${fields.origin}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expiration Time: ${fields.expiresAt.toISOString()}`,
  ].join('\n');
}

const DOMAIN_SUFFIX = ' wants you to sign in to Ellai with your Sui account:';

function after(line: string | undefined, label: string): string {
  if (line === undefined || !line.startsWith(label)) refuse('BAD_MESSAGE');
  return line.slice(label.length);
}

function parseTime(text: string): Date {
  const time = new Date(text);
  if (Number.isNaN(time.getTime())) refuse('BAD_MESSAGE');
  return time;
}

function parseSignInMessage(message: string, site: Site): SignInFields {
  const lines = message.split('\n');
  if (lines.length !== 7 || lines[2] !== '') refuse('BAD_MESSAGE');
  const domainLine = lines[0] ?? '';
  if (!domainLine.endsWith(DOMAIN_SUFFIX)) refuse('BAD_MESSAGE');
  const host = domainLine.slice(0, -DOMAIN_SUFFIX.length);
  const origin = after(lines[3], 'URI: ');
  if (host !== site.host || origin !== site.origin) refuse('WRONG_SITE');

  let address: string;
  try {
    address = canonicalSuiAddress(lines[1] ?? '');
  } catch {
    refuse('BAD_MESSAGE');
  }
  const nonce = after(lines[4], 'Nonce: ');
  if (!NONCE_PATTERN.test(nonce)) refuse('BAD_MESSAGE');
  const fields: SignInFields = {
    host,
    origin,
    address,
    nonce,
    issuedAt: parseTime(after(lines[5], 'Issued At: ')),
    expiresAt: parseTime(after(lines[6], 'Expiration Time: ')),
  };
  if (formatSignInMessage(fields) !== message) refuse('BAD_MESSAGE');
  return fields;
}

// A zkLogin proof can only be checked against the chain, whether it signs alone or as a member
// of a multisig, and the SDK checks each zkLogin member that signed with a call of its own. A
// multisig whose zkLogin members did not sign is checked offline. Throws for a signature that
// does not parse.
function chainChecksOf(signature: string): number {
  const flag = fromBase64(signature)[0];
  if (flag === ZKLOGIN_FLAG) return 1;
  if (flag !== MULTISIG_FLAG) return 0;
  const parsed = parseSerializedSignature(signature);
  return parsed.signatureScheme === 'MultiSig' ? parsed.multisig.sigs.filter((sig) => 'ZkLogin' in sig).length : 0;
}

/**
 * The chain checks a signature needs, refused as BAD_SIGNATURE when it does not parse or carries
 * more than LIMITS.zkLoginMembersMax zkLogin members, before anything is counted or sent to Sui.
 */
function zkLoginChecksOf(signature: unknown): number {
  if (typeof signature !== 'string' || signature === '') refuse('BAD_SIGNATURE');
  let checks: number;
  try {
    checks = chainChecksOf(signature);
  } catch {
    refuse('BAD_SIGNATURE');
  }
  if (checks > LIMITS.zkLoginMembersMax) refuse('BAD_SIGNATURE');
  return checks;
}

/**
 * Counts `checks` uses of each per-client limit for `clientKey`, the minute's first, and throws
 * once either is passed, before any shared quota is spent (C34): HttpError 429 rate_limited past
 * the minute's, 429 rate_limited_today past the day's, since a minute's wait does nothing for a
 * day's. A client past the minute's limit spends nothing of its day.
 */
async function holdZkLoginClientLimits(db: Database, clientKey: string, checks: number, now: Date): Promise<void> {
  for (const limit of ZKLOGIN_CLIENT_LIMITS) {
    for (let check = 0; check < checks; check += 1) {
      if (await consumeWindow(db, `${limit.name}:${clientKey}`, limit.limit, limit.windowMs, now)) continue;
      throw new HttpError(429, limit.windowMs === LIMITS.rateWindowDayMs ? 'rate_limited_today' : 'rate_limited');
    }
  }
}

/**
 * Counts `checks` uses of each zkLogin quota, the minute's first, and refuses once either is
 * spent, before anything is sent to Sui (C22). The caller is over no limit of its own: Ellai's
 * shared budget for asking Sui is spent. Past the minute's quota that is CHAIN_UNAVAILABLE, a 503
 * chain_unavailable whose "try again in a minute" fits; past the day's it is HttpError 503
 * chain_unavailable_today, which says to come back tomorrow.
 * The first refusal in each window logs the quota's fixed name and nothing from the request.
 */
async function holdZkLoginQuotas(db: Database, checks: number, now: Date): Promise<void> {
  for (const quota of ZKLOGIN_CHECK_QUOTAS) {
    for (let check = 0; check < checks; check += 1) {
      const turn = await consumeShared(db, quota.name, quota.limit, quota.windowMs, now);
      if (turn.allowed) continue;
      if (turn.firstRefusal) console.error(`[ellai signin] quota_spent ${quota.name}`);
      if (quota.windowMs === LIMITS.rateWindowDayMs) throw new HttpError(503, 'chain_unavailable_today');
      refuse('CHAIN_UNAVAILABLE');
    }
  }
}

/**
 * The client with its one call the SDK makes for zkLogin, Sui's own check of the proof, watched.
 * The SDK answers a proof that does not hold with success false, so a throw from that call means
 * Sui could not be read, while every other throw during verification is about the signature.
 * The SDK calls nothing else on the client.
 */
function watchedClient(client: ClientWithCoreApi): { client: ClientWithCoreApi; chainFailed: () => boolean } {
  let failed = false;
  const { core } = client;
  const verifyZkLoginSignature: typeof core.verifyZkLoginSignature = async (options) => {
    try {
      return await core.verifyZkLoginSignature(options);
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const watchedCore = new Proxy(core, { get: (target, property) => (property === 'verifyZkLoginSignature' ? verifyZkLoginSignature : Reflect.get(target, property)) });
  const watched = new Proxy(client, { get: (target, property) => (property === 'core' ? watchedCore : Reflect.get(target, property)) });
  return { client: watched, chainFailed: () => failed };
}

// `client` is given only for a signature already counted as needing Sui, so a signature counted
// as offline that the SDK still wanted to send somewhere fails as BAD_SIGNATURE instead.
async function recoveredAddress(message: string, signature: string, claimed: string, client: ClientWithCoreApi | undefined): Promise<string> {
  const watched = client === undefined ? undefined : watchedClient(client);
  try {
    // The claimed address is passed so the SDK picks the matching zkLogin address form;
    // the comparison that decides is the one below, through the shared address parser.
    const publicKey = await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address: claimed, client: watched?.client });
    return canonicalSuiAddress(publicKey.toSuiAddress());
  } catch {
    refuse(watched?.chainFailed() === true ? 'CHAIN_UNAVAILABLE' : 'BAD_SIGNATURE');
  }
}

/**
 * Why a stored nonce cannot sign this message in, or null when it can: it must be one this
 * server issued with exactly the message's times (NONCE_UNKNOWN), unused (NONCE_USED) and
 * unexpired at `now` (NONCE_EXPIRED), the same conditions the claim in completeSignIn sets.
 */
function nonceRefusal(row: typeof signinNonces.$inferSelect | undefined, fields: SignInFields, now: Date): SignInErrorCode | null {
  const sameIssue = row !== undefined && row.createdAt.getTime() === fields.issuedAt.getTime() && row.expiresAt.getTime() === fields.expiresAt.getTime();
  if (!sameIssue) return 'NONCE_UNKNOWN';
  if (row.usedAt !== null) return 'NONCE_USED';
  return row.expiresAt.getTime() > now.getTime() ? null : 'NONCE_EXPIRED';
}

/**
 * Starts a wallet sign-in for an address: stores a fresh nonce that expires
 * LIMITS.signinNonceTtlMs after `now`, and returns the plain-text message the owner's wallet
 * signs as a Sui personal message. The message names the app's host and origin, the
 * canonical address, the nonce and both times, one item per line.
 * Throws SignInError BAD_ADDRESS for an empty or malformed address. Throws Error if `now`
 * is not a date or appOrigin is not a bare origin, which are server faults.
 */
export async function issueSignIn(args: { db: Database; address: string; appOrigin: string; now: Date }): Promise<{ nonce: string; message: string; expiresAt: Date }> {
  const now = checkNow(args.now);
  const site = siteOf(args.appOrigin);
  let address: string;
  try {
    address = canonicalSuiAddress(args.address);
  } catch {
    refuse('BAD_ADDRESS');
  }
  const nonce = randomBytes(LIMITS.signinNonceBytes).toString('hex');
  const expiresAt = new Date(now.getTime() + LIMITS.signinNonceTtlMs);
  await args.db.insert(signinNonces).values({ nonce, createdAt: now, expiresAt });
  return { nonce, message: formatSignInMessage({ ...site, address, nonce, issuedAt: now, expiresAt }), expiresAt };
}

/** What every sign-in passes. */
interface SignInRequest {
  db: Database;
  message: string;
  signature: string;
  appOrigin: string;
  masterSecretHex: string;
  sessionSecretHex: string;
  now: Date;
}

/**
 * A chain client for zkLogin always comes with the client key its checks are counted against,
 * so the per-client limits cannot be left out by mistake. Without one no zkLogin signature is
 * checked and there is nothing to count.
 */
type ZkLoginChecking = { zkLoginClient?: undefined; clientKey?: string } | { zkLoginClient: ClientWithCoreApi; clientKey: string };

/**
 * Finishes a wallet sign-in (C14, C34), in this order, each step refusing before the next runs:
 *
 * 1. The message must be exactly one that issueSignIn writes for this app's host and origin,
 *    and its nonce one this server issued with the message's times, unused and unexpired. That
 *    is read first, so a bad message or nonce costs one indexed read and never uses up the nonce.
 * 2. The nonce is claimed by one conditional update that only an unused, unexpired nonce issued
 *    with these exact times can pass, so a second use fails even under a race. It commits on its
 *    own: from here the nonce is spent whatever follows, and a replay never reaches a quota or Sui.
 * 3. The signature is parsed and its zkLogin members that signed are counted, one chain check
 *    each. A signature that does not parse, or carries more than LIMITS.zkLoginMembersMax, is
 *    BAD_SIGNATURE with nothing counted. A zkLogin signature with no `zkLoginClient` is
 *    ZKLOGIN_UNAVAILABLE.
 * 4. The checks are counted against `clientKey`, which must be the platform's verified client
 *    address (C22): past LIMITS.zkLoginChecksPerClientPerMinute, HttpError 429 rate_limited, past
 *    LIMITS.zkLoginChecksPerClientPerDay, 429 rate_limited_today, and no shared quota is spent.
 * 5. They are then counted against ZKLOGIN_CHECK_QUOTAS, which every caller shares: past the
 *    minute's, CHAIN_UNAVAILABLE (503 chain_unavailable), past the day's, HttpError 503
 *    chain_unavailable_today, with one fixed log line per window.
 * 6. The signature is checked as a Sui personal message that must recover to the address the
 *    message names: Ed25519, Secp256k1, Secp256r1 and multisig offline, zkLogin through
 *    `zkLoginClient` with its own timeout, and CHAIN_UNAVAILABLE rather than BAD_SIGNATURE when
 *    Sui cannot be read for it.
 * 7. In one short transaction, the owner row is created on first sign-in with its derived purse
 *    address, and a session whose token hash alone is stored, expiring LIMITS.sessionTtlMs after
 *    `now`.
 *
 * Returns the owner id, the session token (to be set as the cookie, never stored), and its
 * expiry.
 * Throws SignInError: BAD_MESSAGE, WRONG_SITE, BAD_SIGNATURE, ZKLOGIN_UNAVAILABLE,
 * CHAIN_UNAVAILABLE, NONCE_UNKNOWN, NONCE_USED, NONCE_EXPIRED; and HttpError 429 rate_limited or
 * rate_limited_today, and 503 chain_unavailable_today.
 * A refused message or nonce never uses up the nonce; every refusal after the claim leaves it
 * used and creates nothing. Throws Error for server faults: a bad time, origin, master secret,
 * session secret, or an empty client key beside a zkLogin client.
 */
export async function completeSignIn(args: SignInRequest & ZkLoginChecking): Promise<SignedIn> {
  const now = checkNow(args.now);
  const site = siteOf(args.appOrigin);
  if (args.zkLoginClient !== undefined && (typeof args.clientKey !== 'string' || args.clientKey === '')) throw new Error('The client key is missing');
  if (typeof args.message !== 'string') refuse('BAD_MESSAGE');
  // Every message this site issues has the same length, so anything longer is refused
  // before it is split or parsed.
  const issuedLength = formatSignInMessage({ ...site, address: canonicalSuiAddress('0x1'), nonce: '0'.repeat(LIMITS.signinNonceBytes * 2), issuedAt: now, expiresAt: now }).length;
  if (args.message.length > issuedLength) refuse('BAD_MESSAGE');
  const fields = parseSignInMessage(args.message, site);
  const thisNonce = eq(signinNonces.nonce, fields.nonce);
  // The claim below decides; this read only refuses early, without writing.
  const [issued] = await args.db.select().from(signinNonces).where(thisNonce);
  const early = nonceRefusal(issued, fields, now);
  if (early !== null) refuse(early);

  // Only a signature that recovers to fields.address creates anything, so both come from it.
  // Worked out before the claim, so a server fault here never spends the caller's nonce.
  const address = fields.address;
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(args.masterSecretHex, address).toSuiAddress());
  const session = newBearerToken(SESSION_TOKEN_PREFIX, args.sessionSecretHex);
  const sessionExpiresAt = new Date(now.getTime() + LIMITS.sessionTtlMs);

  const claimed = await args.db
    .update(signinNonces)
    .set({ usedAt: now })
    .where(and(thisNonce, isNull(signinNonces.usedAt), gt(signinNonces.expiresAt, now), eq(signinNonces.createdAt, fields.issuedAt), eq(signinNonces.expiresAt, fields.expiresAt)))
    .returning({ nonce: signinNonces.nonce });
  if (claimed.length !== 1) {
    // A racing sign-in can use the nonce between the early read and this claim.
    const [row] = await args.db.select().from(signinNonces).where(thisNonce);
    refuse(nonceRefusal(row, fields, now) ?? 'NONCE_EXPIRED');
  }

  const checks = zkLoginChecksOf(args.signature);
  if (checks > 0) {
    if (args.zkLoginClient === undefined) refuse('ZKLOGIN_UNAVAILABLE');
    // Counted outside any transaction: a counter row updated inside one would stay locked through
    // the zkLogin check and line every zkLogin sign-in up behind the slowest one.
    await holdZkLoginClientLimits(args.db, args.clientKey, checks, now);
    await holdZkLoginQuotas(args.db, checks, now);
  }
  if ((await recoveredAddress(args.message, args.signature, address, checks > 0 ? args.zkLoginClient : undefined)) !== address) refuse('BAD_SIGNATURE');

  return args.db.transaction(async (tx) => {
    await tx.insert(owners).values({ suiAddress: address, purseAddress, createdAt: now }).onConflictDoNothing({ target: owners.suiAddress });
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.suiAddress, address));
    if (owner === undefined) throw new Error('The owner row is missing after it was created');
    await tx.insert(sessions).values({ ownerId: owner.id, tokenHash: session.hash, createdAt: now, expiresAt: sessionExpiresAt });
    return { ownerId: owner.id, sessionToken: session.token, expiresAt: sessionExpiresAt };
  });
}
