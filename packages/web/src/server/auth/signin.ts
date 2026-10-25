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
import { consumeShared } from '../http/ratelimit.js';
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
 * Counts `checks` uses of each zkLogin quota, the minute's first, and refuses with
 * CHAIN_UNAVAILABLE once either is spent, before anything is sent to Sui (C22). The caller is
 * over no limit of its own: Ellai's shared budget for asking Sui is spent, which is what a
 * 503 chain_unavailable tells it, and its "try again in a minute" fits the minute's quota.
 */
async function holdZkLoginQuotas(db: Database, checks: number, now: Date): Promise<void> {
  for (const quota of ZKLOGIN_CHECK_QUOTAS) {
    for (let check = 0; check < checks; check += 1) {
      if (!(await consumeShared(db, quota.name, quota.limit, quota.windowMs, now)).allowed) refuse('CHAIN_UNAVAILABLE');
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

async function recoveredAddress(message: string, signature: unknown, claimed: string, client: ClientWithCoreApi | undefined): Promise<string> {
  if (typeof signature !== 'string' || signature === '') refuse('BAD_SIGNATURE');
  let needsChain: boolean;
  try {
    needsChain = chainChecksOf(signature) > 0;
  } catch {
    refuse('BAD_SIGNATURE');
  }
  if (needsChain && client === undefined) refuse('ZKLOGIN_UNAVAILABLE');
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

/** Why the signature does not sign this message in for `claimed`, or null when it does. */
async function signatureRefusal(message: string, signature: unknown, claimed: string, client: ClientWithCoreApi | undefined): Promise<SignInErrorCode | null> {
  try {
    return (await recoveredAddress(message, signature, claimed, client)) === claimed ? null : 'BAD_SIGNATURE';
  } catch (error) {
    if (error instanceof SignInError) return error.code;
    throw error;
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

/**
 * Finishes a wallet sign-in (C14), in the order nonce, claim, signature, session.
 *
 * The message must be exactly one that issueSignIn writes for this app's host and origin. Its
 * nonce must be one this server issued with the message's times, unused and unexpired; that is
 * read first, so a bad nonce never costs a chain read. A signature that needs Sui (zkLogin,
 * alone or as multisig members, one check for each member that signed) is then counted against
 * ZKLOGIN_CHECK_QUOTAS, which every caller shares; past either, the refusal is
 * CHAIN_UNAVAILABLE, nothing is sent to Sui, and the nonce is left as it was (C22).
 *
 * Then, in one transaction: the nonce is marked used by a conditional update that only an
 * unused, unexpired nonce issued with these exact times can pass, so a second use fails even
 * under a race. Only after that claim is the signature checked, as a Sui personal message that
 * must recover to the address the message names: Ed25519, Secp256k1, Secp256r1 and multisig
 * offline, zkLogin only through `zkLoginClient` (ZKLOGIN_UNAVAILABLE when none is given), and
 * CHAIN_UNAVAILABLE rather than BAD_SIGNATURE when Sui cannot be read for it. A refused
 * signature commits the claim and creates nothing, so every check against Sui has spent its
 * nonce and a replay of the same message never reaches Sui again (C14). A signature that holds
 * creates the owner row on first sign-in, with its derived purse address, and a session whose
 * token hash alone is stored, expiring LIMITS.sessionTtlMs after `now`. The transaction stays
 * open through the zkLogin check, which `zkLoginClient`'s own timeout bounds.
 *
 * Returns the owner id, the session token (to be set as the cookie, never stored), and its
 * expiry.
 * Throws SignInError: BAD_MESSAGE, WRONG_SITE, BAD_SIGNATURE, ZKLOGIN_UNAVAILABLE,
 * CHAIN_UNAVAILABLE, NONCE_UNKNOWN, NONCE_USED, NONCE_EXPIRED. A refused message never uses up
 * the nonce; a refused signature always does. Throws Error for server faults: a bad time,
 * origin, master secret or session secret.
 */
export async function completeSignIn(args: {
  db: Database;
  message: string;
  signature: string;
  appOrigin: string;
  masterSecretHex: string;
  sessionSecretHex: string;
  now: Date;
  zkLoginClient?: ClientWithCoreApi;
}): Promise<SignedIn> {
  const now = checkNow(args.now);
  const site = siteOf(args.appOrigin);
  if (typeof args.message !== 'string') refuse('BAD_MESSAGE');
  // Every message this site issues has the same length, so anything longer is refused
  // before it is split or parsed.
  const issuedLength = formatSignInMessage({ ...site, address: canonicalSuiAddress('0x1'), nonce: '0'.repeat(LIMITS.signinNonceBytes * 2), issuedAt: now, expiresAt: now }).length;
  if (args.message.length > issuedLength) refuse('BAD_MESSAGE');
  const fields = parseSignInMessage(args.message, site);
  const thisNonce = eq(signinNonces.nonce, fields.nonce);
  // Read before anything else, so a junk signature on a nonce that cannot sign in costs one
  // indexed read and never a quota or a chain read. The claim below decides; this only refuses early.
  const [issued] = await args.db.select().from(signinNonces).where(thisNonce);
  const early = nonceRefusal(issued, fields, now);
  if (early !== null) refuse(early);

  // Counted outside the transaction: a counter row updated inside it would stay locked through
  // the zkLogin check and line every zkLogin sign-in up behind the slowest one.
  if (args.zkLoginClient !== undefined) {
    let checks = 0;
    try {
      checks = typeof args.signature === 'string' ? chainChecksOf(args.signature) : 0;
    } catch {
      // Unreadable, so it is refused as BAD_SIGNATURE after the claim and never reaches Sui.
    }
    if (checks > 0) await holdZkLoginQuotas(args.db, checks, now);
  }

  // Only a signature that recovers to fields.address creates anything, so both come from it.
  const address = fields.address;
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(args.masterSecretHex, address).toSuiAddress());
  const session = newBearerToken(SESSION_TOKEN_PREFIX, args.sessionSecretHex);
  const sessionExpiresAt = new Date(now.getTime() + LIMITS.sessionTtlMs);

  const outcome = await args.db.transaction(async (tx): Promise<{ refused: SignInErrorCode } | { signedIn: SignedIn }> => {
    const claimed = await tx
      .update(signinNonces)
      .set({ usedAt: now })
      .where(
        and(
          thisNonce,
          isNull(signinNonces.usedAt),
          gt(signinNonces.expiresAt, now),
          eq(signinNonces.createdAt, fields.issuedAt),
          eq(signinNonces.expiresAt, fields.expiresAt),
        ),
      )
      .returning({ nonce: signinNonces.nonce });
    if (claimed.length !== 1) {
      // A racing sign-in can use the nonce between the early read and this claim.
      const [row] = await tx.select().from(signinNonces).where(thisNonce);
      refuse(nonceRefusal(row, fields, now) ?? 'NONCE_EXPIRED');
    }

    // Returned rather than thrown, so the transaction commits and the nonce stays used.
    const refusal = await signatureRefusal(args.message, args.signature, address, args.zkLoginClient);
    if (refusal !== null) return { refused: refusal };

    await tx.insert(owners).values({ suiAddress: address, purseAddress, createdAt: now }).onConflictDoNothing({ target: owners.suiAddress });
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.suiAddress, address));
    if (owner === undefined) throw new Error('The owner row is missing after it was created');

    await tx.insert(sessions).values({ ownerId: owner.id, tokenHash: session.hash, createdAt: now, expiresAt: sessionExpiresAt });
    return { signedIn: { ownerId: owner.id, sessionToken: session.token, expiresAt: sessionExpiresAt } };
  });
  if ('refused' in outcome) refuse(outcome.refused);
  return outcome.signedIn;
}
