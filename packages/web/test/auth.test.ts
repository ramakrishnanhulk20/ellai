// Covers: wallet sign-in end to end on PGlite with real Ed25519, Secp256k1, Secp256r1 and
// multisig keys; the message shape and every refusal of a message, a signature or a nonce, the
// site and nonce checked before any chain read; the nonce used up before anything is counted, so
// ten tries of one zkLogin message reach the chain once and spend no client's places; every
// refusal after that claim leaving the nonce used and no session; zkLogin through a stub client,
// including a chain that cannot be read answering CHAIN_UNAVAILABLE (503) and the Tatum budget's
// refusal answering chain_unavailable_today (503); a signature past the
// zkLogin member cap refused with nothing counted; the per-client zkLogin limits per minute and per
// day (429, the day's as rate_limited_today) counted before the shared quotas per minute and per
// day (503, the day's as chain_unavailable_today), one check for each zkLogin member, with one log
// line per spent window; the sign-in day caps per client (429 rate_limited_today) and for everyone
// (503 chain_unavailable_today), counted only once the signature holds and before any owner row;
// an owner row pruned between the sign-in steps made again under a key-share lock;
// the owner row and its derived purse; sessions, their cookie (named __Host-ellai_session
// whenever it is Secure, and read under that name only), their end, and ending every live one of
// an owner at once; labels with runs of spaces made one and blank fillers or quote marks but
// apostrophes refused; agent tokens,
// their display prefixes, the cap on live external agents per owner (never counting the one
// built-in agent), and their revocation behind the owner's row lock; that one
// kind of token never works as the other or as a record id;
// that malformed tokens never reach the database; and that no refusal repeats a token, a
// signature or the message.
// Does NOT cover: zkLogin against a real chain (there is no network here, and no real proof is
// made; routes-auth also runs one through the route), passkey or
// ML-DSA signatures, real wallet software, two database connections racing for one nonce or
// for an owner's last agent place or a prune deleting the owner a sign-in is writing (the
// prune's delete runs inside the sign-in's own transaction) (PGlite serves one connection, so each race is run with
// Promise.all on that one connection), a row lock blocking a second connection (the revoke test
// shows the lock statement and that the revoke waits, but on PGlite the wait comes from its one
// connection), or the routes that will call these functions with their same-origin check and
// rate limits (routes-auth runs the per-client zkLogin limit through the verify route).
import { createHmac, randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { ChainError } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { bcs } from '@mysten/sui/bcs';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { SIGNATURE_SCHEME_TO_FLAG, type Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { MultiSigPublicKey, MultiSigSigner } from '@mysten/sui/multisig';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { computeZkLoginAddressFromSeed, getZkLoginSignature } from '@mysten/sui/zklogin';
import { eq } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentError, authenticateAgent, checkLabel, createAgentToken, listAgents, revokeAgent } from '../src/server/auth/agents.js';
import { endOwnerSessions, endSession, readSessionCookie, resolveSession, sessionCookie } from '../src/server/auth/sessions.js';
import {
  SIGN_IN_CLIENT_DAY,
  SIGN_IN_SHARED_DAY,
  SignInError,
  type SignInErrorCode,
  ZKLOGIN_CHECK_QUOTAS,
  ZKLOGIN_CLIENT_LIMITS,
  completeSignIn,
  issueSignIn,
} from '../src/server/auth/signin.js';
import { AGENT_TOKEN_PREFIX, type BearerTokenPrefix, SESSION_TOKEN_PREFIX, hashBearerToken, isBearerToken, newBearerToken } from '../src/server/auth/tokens.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import * as schema from '../src/server/db/schema.js';
import { TEXT_CAPS, agents, owners, sessions, signinNonces } from '../src/server/db/schema.js';
import { HttpError, toErrorResponse } from '../src/server/http/errors.js';
import { consumeShared, consumeWindow } from '../src/server/http/ratelimit.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  await handle.close();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const APP_ORIGIN = 'https://ellai.example';
const SECRET = hex(32);
const MASTER = hex(32);
const NOW = new Date('2026-10-24T10:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

// Fails the test on any use at all, so a function handed it provably never queried.
const untouchable = new Proxy({} as Database, {
  get() {
    throw new Error('the database was touched');
  },
});

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

async function sign(signer: Signer, message: string): Promise<string> {
  return (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
}

function issue(address: string, appOrigin = APP_ORIGIN) {
  return issueSignIn({ db, address, appOrigin, now: NOW });
}

interface CompleteOptions {
  now?: Date;
  zkLoginClient?: ClientWithCoreApi;
  clientKey?: string;
}

// Each call is a client of its own unless the test names one, so the per-client zkLogin limits
// turn away only the tests that are about them.
function complete(message: string, signature: string, options: CompleteOptions = {}) {
  const base = { db, message, signature, appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now: options.now ?? NOW, clientKey: options.clientKey ?? `client-${hex(8)}` };
  return options.zkLoginClient === undefined ? completeSignIn(base) : completeSignIn({ ...base, zkLoginClient: options.zkLoginClient });
}

async function signIn(signer: Signer = Ed25519Keypair.generate()) {
  const { message } = await issue(signer.toSuiAddress());
  return complete(message, await sign(signer, message));
}

function withLine(message: string, index: number, line: string): string {
  const lines = message.split('\n');
  lines[index] = line;
  return lines.join('\n');
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a refusal');
}

async function refused(promise: Promise<unknown>, code: SignInErrorCode): Promise<Error> {
  const error = await refusal(promise);
  expect(error).toBeInstanceOf(SignInError);
  expect(error).toMatchObject({ code, message: new SignInError(code).message });
  return error;
}

// A well-formed zkLogin signature for a Google account. Its proof is not real: what Sui would say
// about it is the stub client's answer.
const ZKLOGIN_ADDRESS_SEED = '13322897930163218532266430409510394316985274769125667290600321564259466511711';
const ZKLOGIN_ADDRESS = canonicalSuiAddress(computeZkLoginAddressFromSeed(BigInt(ZKLOGIN_ADDRESS_SEED), 'https://accounts.google.com', false));

async function zkLoginSignature(message: string): Promise<string> {
  return getZkLoginSignature({
    inputs: {
      proofPoints: { a: ['1', '2', '1'], b: [['1', '0'], ['3', '4'], ['1', '0']], c: ['5', '6', '1'] },
      issBase64Details: { value: 'yJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLC', indexMod4: 1 },
      headerBase64: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ',
      addressSeed: ZKLOGIN_ADDRESS_SEED,
    },
    maxEpoch: '10',
    userSignature: await sign(Ed25519Keypair.generate(), message),
  });
}

/** A multisig carrying `count` copies of one zkLogin member's signature, so it needs `count` chain checks. */
function zkLoginMembers(count: number): (message: string) => Promise<string> {
  return async (message) => {
    const member = fromBase64(await zkLoginSignature(message)).slice(1);
    const multisig = bcs.MultiSig.serialize(
      {
        sigs: Array.from({ length: count }, () => ({ ZkLogin: member })),
        bitmap: 2 ** count - 1,
        multisig_pk: { pk_map: [{ pubKey: { ED25519: Ed25519Keypair.generate().getPublicKey().toRawBytes() }, weight: 1 }], threshold: 1 },
      },
      { maxSize: 65_536 },
    ).toBytes();
    return toBase64(new Uint8Array([SIGNATURE_SCHEME_TO_FLAG.MultiSig, ...multisig]));
  };
}

async function zkLoginAttempt(now: Date, signature: (message: string) => Promise<string> = zkLoginSignature) {
  const issued = await issueSignIn({ db, address: ZKLOGIN_ADDRESS, appOrigin: APP_ORIGIN, now });
  return { issued, signed: await signature(issued.message) };
}

const nonceUsedAt = async (nonce: string) => one(await db.select().from(signinNonces).where(eq(signinNonces.nonce, nonce))).usedAt;
const sessionCount = async () => (await db.select().from(sessions)).length;

async function fillShared(quota: (typeof ZKLOGIN_CHECK_QUOTAS)[number], uses: number, now: Date): Promise<void> {
  for (let use = 0; use < uses; use += 1) await consumeShared(db, quota.name, quota.limit, quota.windowMs, now);
}

/** What a sign-in ended in: 'signed in', a SignInError code, or an HttpError's status and code. */
async function outcomeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'signed in';
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.code}`;
    if (error instanceof SignInError) return error.code;
    throw error;
  }
}

/** A stand-in chain client whose only call is Sui's zkLogin check, answered by `answer`. */
function zkLoginClient(answer: () => Promise<{ success: boolean; errors: string[] }>) {
  const verifyZkLoginSignature = vi.fn(answer);
  return { client: { core: { verifyZkLoginSignature } } as unknown as ClientWithCoreApi, verifyZkLoginSignature };
}

function createAgent(ownerId: string, label = 'Travel agent') {
  return createAgentToken({ db, ownerId, label, kind: 'external', sessionSecretHex: SECRET, now: NOW });
}

describe('bearer tokens', () => {
  it.each<BearerTokenPrefix>([SESSION_TOKEN_PREFIX, AGENT_TOKEN_PREFIX])('makes %s tokens with a keyed hash and a display prefix', (prefix) => {
    const first = newBearerToken(prefix, SECRET);
    expect(first.token).toMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`));
    expect(Buffer.from(first.token.slice(prefix.length), 'base64url')).toHaveLength(LIMITS.bearerTokenBytes);
    expect(first.hash).toBe(createHmac('sha256', Buffer.from(SECRET, 'hex')).update(first.token).digest('hex'));
    expect(first.displayPrefix).toBe(first.token.slice(0, prefix.length + 6));
    expect(hashBearerToken(first.token, SECRET)).toBe(first.hash);
    expect(hashBearerToken(first.token, hex(32))).not.toBe(first.hash);
    expect(newBearerToken(prefix, SECRET).token).not.toBe(first.token);
  });

  it.each<BearerTokenPrefix>([SESSION_TOKEN_PREFIX, AGENT_TOKEN_PREFIX])('gives %s keys display prefixes that tell them apart and fit the column', (prefix) => {
    const shown = Array.from({ length: 50 }, () => newBearerToken(prefix, SECRET).displayPrefix);
    for (const displayPrefix of shown) {
      expect(displayPrefix).toMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{6}$`));
      expect(displayPrefix.length).toBeLessThanOrEqual(TEXT_CAPS.tokenPrefix);
    }
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('hashes only the exact token shape and refuses a malformed secret', () => {
    const { token } = newBearerToken(SESSION_TOKEN_PREFIX, SECRET);
    const body = token.slice(SESSION_TOKEN_PREFIX.length);
    for (const junk of ['', 'junk', SESSION_TOKEN_PREFIX, `${token}A`, token.slice(0, -1), `${SESSION_TOKEN_PREFIX}${'+'.repeat(43)}`, `${SESSION_TOKEN_PREFIX}${body.slice(0, -1)}=`, ` ${token}`, token.toUpperCase(), `ellai_other_${body}`]) {
      expect(hashBearerToken(junk, SECRET)).toBeNull();
    }
    for (const badSecret of ['', 'abc', 'zz'.repeat(32), hex(31)]) {
      expect(() => hashBearerToken(token, badSecret)).toThrow('The session secret must be at least 32 bytes written as hex');
      expect(() => newBearerToken(AGENT_TOKEN_PREFIX, badSecret)).toThrow('The session secret must be at least 32 bytes written as hex');
    }
  });
});

describe('issueSignIn', () => {
  it('writes the message one item per line, with the canonical address, and stores the nonce', async () => {
    const address = Ed25519Keypair.generate().toSuiAddress();
    const issued = await issue(`0x${address.slice(2).toUpperCase()}`);
    expect(issued.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(issued.expiresAt).toEqual(later(LIMITS.signinNonceTtlMs));
    expect(issued.message.split('\n')).toEqual([
      'ellai.example wants you to sign in to Ellai with your Sui account:',
      address,
      '',
      'URI: https://ellai.example',
      `Nonce: ${issued.nonce}`,
      'Issued At: 2026-10-24T10:00:00.000Z',
      'Expiration Time: 2026-10-24T10:05:00.000Z',
    ]);
    expect(one(await db.select().from(signinNonces).where(eq(signinNonces.nonce, issued.nonce)))).toEqual({
      nonce: issued.nonce,
      createdAt: NOW,
      expiresAt: issued.expiresAt,
      usedAt: null,
    });

    const local = await issue(address, 'http://localhost:3000');
    expect(local.message.split('\n')[0]).toBe('localhost:3000 wants you to sign in to Ellai with your Sui account:');
    expect(local.message.split('\n')[3]).toBe('URI: http://localhost:3000');
  });

  it('refuses an empty or malformed address and stores nothing', async () => {
    const before = (await db.select().from(signinNonces)).length;
    for (const address of ['', '0x', 'not an address', `0x${'g'.repeat(64)}`, `0x${'1'.repeat(65)}`]) {
      await refused(issue(address), 'BAD_ADDRESS');
    }
    await expect(issue(Ed25519Keypair.generate().toSuiAddress(), 'https://ellai.example/path')).rejects.toThrow('The app origin must be an origin alone');
    expect(await db.select().from(signinNonces)).toHaveLength(before);
  });
});

describe('completeSignIn', () => {
  it.each([
    ['Ed25519', () => Ed25519Keypair.generate()],
    ['Secp256k1', () => Secp256k1Keypair.generate()],
    ['Secp256r1', () => Secp256r1Keypair.generate()],
  ])('signs in with an %s key: owner with its derived purse, nonce used, session hash stored', async (_scheme, makeKeypair) => {
    const keypair = makeKeypair();
    const address = keypair.toSuiAddress();
    const issued = await issue(address);
    const result = await complete(issued.message, await sign(keypair, issued.message));

    expect(result.sessionToken.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(result.expiresAt).toEqual(later(LIMITS.sessionTtlMs));
    expect(one(await db.select().from(owners).where(eq(owners.id, result.ownerId)))).toMatchObject({
      suiAddress: address,
      purseAddress: derivePurseKeypair(MASTER, address).toSuiAddress(),
    });
    expect(one(await db.select().from(signinNonces).where(eq(signinNonces.nonce, issued.nonce))).usedAt).toEqual(NOW);
    const session = one(await db.select().from(sessions).where(eq(sessions.ownerId, result.ownerId)));
    expect(session).toMatchObject({ tokenHash: hashBearerToken(result.sessionToken, SECRET), createdAt: NOW, expiresAt: result.expiresAt, revokedAt: null });
    expect(session.tokenHash).not.toBe(result.sessionToken);
  });

  it('signs in with a multisig address, and refuses a multisig signature below its threshold', async () => {
    const first = Ed25519Keypair.generate();
    const second = Secp256k1Keypair.generate();
    const multisig = MultiSigPublicKey.fromPublicKeys({
      threshold: 2,
      publicKeys: [
        { publicKey: first.getPublicKey(), weight: 1 },
        { publicKey: second.getPublicKey(), weight: 1 },
      ],
    });
    const address = multisig.toSuiAddress();
    const { message } = await issue(address);

    const belowThreshold = multisig.combinePartialSignatures([await sign(first, message)]);
    await refused(complete(message, belowThreshold), 'BAD_SIGNATURE');

    const { message: next } = await issue(address);
    const result = await complete(next, await sign(new MultiSigSigner(multisig, [first, second]), next));
    expect(one(await db.select().from(owners).where(eq(owners.id, result.ownerId))).suiAddress).toBe(address);
  });

  it('creates the owner row once and reuses it on the next sign-in', async () => {
    const keypair = Secp256k1Keypair.generate();
    const firstSignIn = await signIn(keypair);
    const secondSignIn = await signIn(keypair);
    expect(secondSignIn.ownerId).toBe(firstSignIn.ownerId);
    expect(secondSignIn.sessionToken).not.toBe(firstSignIn.sessionToken);
    const rows = await db.select().from(owners).where(eq(owners.suiAddress, keypair.toSuiAddress()));
    expect(rows).toHaveLength(1);
    expect(one(rows).purseAddress).toBe(derivePurseKeypair(MASTER, keypair.toSuiAddress()).toSuiAddress());
    expect(await db.select().from(sessions).where(eq(sessions.ownerId, firstSignIn.ownerId))).toHaveLength(2);
  });

  it('refuses a replayed signature, including two uses racing each other', async () => {
    const keypair = Ed25519Keypair.generate();
    const { message } = await issue(keypair.toSuiAddress());
    const signature = await sign(keypair, message);
    const raced = await Promise.allSettled([complete(message, signature), complete(message, signature)]);
    const won = raced.filter((outcome) => outcome.status === 'fulfilled');
    const lost = raced.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ name: 'SignInError', code: 'NONCE_USED' });

    await refused(complete(message, signature, { now: later(1_000) }), 'NONCE_USED');
    const ownerId = one(await db.select().from(owners).where(eq(owners.suiAddress, keypair.toSuiAddress()))).id;
    expect(await db.select().from(sessions).where(eq(sessions.ownerId, ownerId))).toHaveLength(1);
  });

  it('refuses an expired nonce, and accepts one a millisecond before it expires', async () => {
    const keypair = Ed25519Keypair.generate();
    const stale = await issue(keypair.toSuiAddress());
    await refused(complete(stale.message, await sign(keypair, stale.message), { now: later(LIMITS.signinNonceTtlMs) }), 'NONCE_EXPIRED');
    expect(await db.select().from(owners).where(eq(owners.suiAddress, keypair.toSuiAddress()))).toEqual([]);

    const fresh = await issue(keypair.toSuiAddress());
    await expect(complete(fresh.message, await sign(keypair, fresh.message), { now: later(LIMITS.signinNonceTtlMs - 1) })).resolves.toBeDefined();
  });

  it('refuses a nonce this server never issued, or issued with other times', async () => {
    const keypair = Ed25519Keypair.generate();
    const { message } = await issue(keypair.toSuiAddress());
    const madeUpNonce = withLine(message, 4, `Nonce: ${hex(16)}`);
    await refused(complete(madeUpNonce, await sign(keypair, madeUpNonce)), 'NONCE_UNKNOWN');
    const longerLife = withLine(message, 6, `Expiration Time: ${later(LIMITS.sessionTtlMs).toISOString()}`);
    await refused(complete(longerLife, await sign(keypair, longerLife)), 'NONCE_UNKNOWN');
    await expect(complete(message, await sign(keypair, message))).resolves.toBeDefined();
  });

  it('refuses a message for another domain or URI, signed by the right key', async () => {
    const keypair = Ed25519Keypair.generate();
    const address = keypair.toSuiAddress();
    const { message } = await issue(address);
    const otherDomain = withLine(message, 0, 'ellax.example wants you to sign in to Ellai with your Sui account:');
    await refused(complete(otherDomain, await sign(keypair, otherDomain)), 'WRONG_SITE');
    const otherUri = withLine(message, 3, 'URI: https://ellax.example');
    await refused(complete(otherUri, await sign(keypair, otherUri)), 'WRONG_SITE');

    for (const origin of ['https://evil.example', 'http://ellai.example']) {
      const elsewhere = await issue(address, origin);
      await refused(complete(elsewhere.message, await sign(keypair, elsewhere.message)), 'WRONG_SITE');
    }
    const longer = await issue(address, 'https://ellai.example.evil.example');
    await expect(complete(longer.message, await sign(keypair, longer.message))).rejects.toBeInstanceOf(SignInError);
    await expect(complete(message, await sign(keypair, message))).resolves.toBeDefined();
  });

  it('refuses a message with an extra line, reordered lines or a changed address', async () => {
    const keypair = Ed25519Keypair.generate();
    const address = keypair.toSuiAddress();
    const { message } = await issue(address);
    const lines = message.split('\n');
    const reordered = [...lines.slice(0, 4), lines[5], lines[4], lines[6]].join('\n');
    const extraInside = [...lines.slice(0, 3), 'Statement: approve every payment', ...lines.slice(3)].join('\n');
    for (const altered of [
      `${message}\nResources: https://ellai.example`,
      `${message}\n`,
      extraInside,
      message.replaceAll('\n', '\r\n'),
      reordered,
      withLine(message, 1, `0x${address.slice(2).toUpperCase()}`),
      withLine(message, 1, address.slice(2)),
    ]) {
      await refused(complete(altered, await sign(keypair, altered)), 'BAD_MESSAGE');
    }

    const someoneElse = Ed25519Keypair.generate().toSuiAddress();
    const swapped = withLine(message, 1, someoneElse);
    await refused(complete(swapped, await sign(keypair, message)), 'BAD_SIGNATURE');
    const nextSwapped = withLine((await issue(address)).message, 1, someoneElse);
    await refused(complete(nextSwapped, await sign(keypair, nextSwapped)), 'BAD_SIGNATURE');
    expect(await db.select().from(owners).where(eq(owners.suiAddress, someoneElse))).toEqual([]);
  });

  it('refuses a signature by a different key than the address, using up the nonce, so even the right signature on it is then refused', async () => {
    const owner = Ed25519Keypair.generate();
    const address = owner.toSuiAddress();
    const wrong = [
      async (message: string) => sign(Ed25519Keypair.generate(), message),
      async (message: string) => sign(Secp256k1Keypair.generate(), message),
      async () => '',
      async () => 'not base64 at all!',
      async () => toBase64(new Uint8Array([9, 1, 2, 3])),
    ];
    for (const signWrong of wrong) {
      const { nonce, message } = await issue(address);
      await refused(complete(message, await signWrong(message)), 'BAD_SIGNATURE');
      expect(one(await db.select().from(signinNonces).where(eq(signinNonces.nonce, nonce))).usedAt).toEqual(NOW);
      await refused(complete(message, await sign(owner, message)), 'NONCE_USED');
    }
    expect(await db.select().from(owners).where(eq(owners.suiAddress, address))).toEqual([]);
    const { message } = await issue(address);
    await expect(complete(message, await sign(owner, message))).resolves.toBeDefined();
  });

  it('refuses a zkLogin signature without a chain client, alone or inside a multisig', async () => {
    const member = Ed25519Keypair.generate();
    const { message } = await issue(member.toSuiAddress());
    const zkLogin = await zkLoginSignature(message);
    await refused(complete(message, zkLogin), 'ZKLOGIN_UNAVAILABLE');
    const { message: next } = await issue(member.toSuiAddress());

    const multisig = bcs.MultiSig.serialize(
      {
        sigs: [{ ZkLogin: fromBase64(zkLogin).slice(1) }],
        bitmap: 1,
        multisig_pk: { pk_map: [{ pubKey: { ED25519: member.getPublicKey().toRawBytes() }, weight: 1 }], threshold: 1 },
      },
      { maxSize: 65_536 },
    ).toBytes();
    const zkLoginInsideMultisig = toBase64(new Uint8Array([SIGNATURE_SCHEME_TO_FLAG.MultiSig, ...multisig]));
    await refused(complete(next, zkLoginInsideMultisig), 'ZKLOGIN_UNAVAILABLE');
  });

  it('checks the site and the nonce before the signature, so a zkLogin signature on a bad one makes no chain call', async () => {
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => ({ success: true, errors: [] }));
    const { message } = await issue(ZKLOGIN_ADDRESS);
    const otherSite = withLine(message, 0, 'ellax.example wants you to sign in to Ellai with your Sui account:');
    await refused(complete(otherSite, await zkLoginSignature(otherSite), { zkLoginClient: client }), 'WRONG_SITE');
    const madeUpNonce = withLine(message, 4, `Nonce: ${hex(16)}`);
    await refused(complete(madeUpNonce, await zkLoginSignature(madeUpNonce), { zkLoginClient: client }), 'NONCE_UNKNOWN');
    const signature = await zkLoginSignature(message);
    await refused(complete(message, signature, { zkLoginClient: client, now: later(LIMITS.signinNonceTtlMs) }), 'NONCE_EXPIRED');
    expect(verifyZkLoginSignature).not.toHaveBeenCalled();

    await expect(complete(message, signature, { zkLoginClient: client })).resolves.toMatchObject({ ownerId: expect.any(String) });
    await refused(complete(message, signature, { zkLoginClient: client }), 'NONCE_USED');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);
  });

  it('refuses a zkLogin signature Sui could not be read for as CHAIN_UNAVAILABLE, a 503 chain_unavailable, with the nonce used up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => {
      throw new Error('UNAVAILABLE: the gateway did not answer');
    });
    const { nonce, message } = await issue(ZKLOGIN_ADDRESS);
    const signature = await zkLoginSignature(message);
    const unavailable = await refused(complete(message, signature, { zkLoginClient: client }), 'CHAIN_UNAVAILABLE');
    const response = toErrorResponse(unavailable);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'chain_unavailable', message: 'Ellai could not read Sui just now. Try again in a minute.' });
    expect(one(await db.select().from(signinNonces).where(eq(signinNonces.nonce, nonce))).usedAt).toEqual(NOW);

    verifyZkLoginSignature.mockResolvedValue({ success: true, errors: [] });
    await refused(complete(message, signature, { zkLoginClient: client }), 'NONCE_USED');
    const { message: next } = await issue(ZKLOGIN_ADDRESS);
    await expect(complete(next, await zkLoginSignature(next), { zkLoginClient: client })).resolves.toMatchObject({ ownerId: expect.any(String) });
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("refuses a zkLogin signature Ellai's Tatum budget kept from Sui as 503 chain_unavailable_today, not CHAIN_UNAVAILABLE, with the nonce used up and nothing made (C22)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => {
      throw new ChainError('BUDGET', 'VerifySignature refused by the request budget, nothing was sent');
    });
    const sessionsBefore = await sessionCount();
    const { nonce, message } = await issue(ZKLOGIN_ADDRESS);
    const today = await refusal(complete(message, await zkLoginSignature(message), { zkLoginClient: client }));
    expect(today).toBeInstanceOf(HttpError);
    expect(today).toMatchObject({ status: 503, code: 'chain_unavailable_today' });
    const response = toErrorResponse(today);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'chain_unavailable_today', message: "Ellai has used today's budget for reading Sui. Try again tomorrow (days are counted in UTC)." });
    expect(await nonceUsedAt(nonce)).toEqual(NOW);
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);
  });

  it('uses up the nonce before anything is counted, so ten tries of one fake zkLogin signature, in turn or all at once, reach Sui once and spend no place of their client (C14, C34)', async () => {
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => ({ success: false, errors: ['the proof does not verify'] }));
    const sessionsBefore = await sessionCount();
    const clientKey = 'replaying-client';

    const inTurn = await issue(ZKLOGIN_ADDRESS);
    const inTurnSignature = await zkLoginSignature(inTurn.message);
    const codes: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      codes.push(await outcomeOf(complete(inTurn.message, inTurnSignature, { zkLoginClient: client, clientKey })));
    }
    expect(codes).toEqual(['BAD_SIGNATURE', ...Array<string>(9).fill('NONCE_USED')]);
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);

    const atOnce = await issue(ZKLOGIN_ADDRESS);
    const atOnceSignature = await zkLoginSignature(atOnce.message);
    const racedCodes = (await Promise.all(Array.from({ length: 10 }, () => outcomeOf(complete(atOnce.message, atOnceSignature, { zkLoginClient: client, clientKey }))))).sort();
    expect(racedCodes).toEqual(['BAD_SIGNATURE', ...Array<string>(9).fill('NONCE_USED')]);
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(2);
    expect(await sessionCount()).toBe(sessionsBefore);

    // Eighteen replays later the client has spent two places, so it has exactly one left this minute.
    expect(LIMITS.zkLoginChecksPerClientPerMinute).toBe(3);
    const third = await issue(ZKLOGIN_ADDRESS);
    expect(await outcomeOf(complete(third.message, await zkLoginSignature(third.message), { zkLoginClient: client, clientKey }))).toBe('BAD_SIGNATURE');
    const fourth = await issue(ZKLOGIN_ADDRESS);
    expect(await outcomeOf(complete(fourth.message, await zkLoginSignature(fourth.message), { zkLoginClient: client, clientKey }))).toBe('429 rate_limited');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(3);
  });

  it('leaves the nonce used and creates no session for every refusal after the claim: too many members, a client limit, a spent quota, a proof Sui rejects and a chain that cannot answer (C14, C34)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [perMinute] = ZKLOGIN_CHECK_QUOTAS;
    const [clientMinute] = ZKLOGIN_CLIENT_LIMITS;
    const rejects = zkLoginClient(async () => ({ success: false, errors: ['the proof does not verify'] }));
    const unreachable = zkLoginClient(async () => {
      throw new Error('UNAVAILABLE: the gateway did not answer');
    });
    const accepts = zkLoginClient(async () => ({ success: true, errors: [] }));
    // A day of its own, one minute per case, so each case's counters start at zero.
    const minute = (n: number) => new Date(Date.parse('2026-12-05T00:00:00.000Z') + n * 60_000);
    const cases: Array<{ expected: string; client: ClientWithCoreApi; prepare?: (now: Date, clientKey: string) => Promise<void>; signature?: (message: string) => Promise<string> }> = [
      { expected: 'BAD_SIGNATURE', client: accepts.client, signature: zkLoginMembers(LIMITS.zkLoginMembersMax + 1) },
      {
        expected: '429 rate_limited',
        client: accepts.client,
        prepare: async (now, clientKey) => {
          for (let use = 0; use < clientMinute.limit; use += 1) await consumeWindow(db, `${clientMinute.name}:${clientKey}`, clientMinute.limit, clientMinute.windowMs, now);
        },
      },
      { expected: 'CHAIN_UNAVAILABLE', client: accepts.client, prepare: (now) => fillShared(perMinute, perMinute.limit, now) },
      { expected: 'BAD_SIGNATURE', client: rejects.client },
      { expected: 'CHAIN_UNAVAILABLE', client: unreachable.client },
    ];
    const sessionsBefore = await sessionCount();
    for (const [index, refusalCase] of cases.entries()) {
      const now = minute(index);
      const clientKey = `refused-client-${index}`;
      await refusalCase.prepare?.(now, clientKey);
      const { issued, signed } = await zkLoginAttempt(now, refusalCase.signature);
      expect(await outcomeOf(complete(issued.message, signed, { zkLoginClient: refusalCase.client, clientKey, now }))).toBe(refusalCase.expected);
      expect(await nonceUsedAt(issued.nonce)).toEqual(now);
      expect(await outcomeOf(complete(issued.message, signed, { zkLoginClient: accepts.client, now }))).toBe('NONCE_USED');
    }
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(accepts.verifyZkLoginSignature).not.toHaveBeenCalled();
    expect(rejects.verifyZkLoginSignature).toHaveBeenCalledTimes(1);
    expect(unreachable.verifyZkLoginSignature).toHaveBeenCalledTimes(1);
  });

  it('refuses a signature with more zkLogin members than LIMITS.zkLoginMembersMax as BAD_SIGNATURE before any chain call, counting nothing for its client or for anyone (C34)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => ({ success: true, errors: [] }));
    const [perMinute] = ZKLOGIN_CHECK_QUOTAS;
    const perClient = LIMITS.zkLoginChecksPerClientPerMinute;
    const now = new Date('2026-12-03T09:00:00.000Z');
    // Exactly the places one client may take are left in the shared minute.
    await fillShared(perMinute, perMinute.limit - perClient, now);

    const over = await zkLoginAttempt(now, zkLoginMembers(LIMITS.zkLoginMembersMax + 1));
    expect(await outcomeOf(complete(over.issued.message, over.signed, { zkLoginClient: client, clientKey: 'member-client', now }))).toBe('BAD_SIGNATURE');
    expect(verifyZkLoginSignature).not.toHaveBeenCalled();

    // The same client still has all its places, and they are all that is left for anyone.
    for (let i = 0; i < perClient; i += 1) {
      const { issued, signed } = await zkLoginAttempt(now);
      expect(await outcomeOf(complete(issued.message, signed, { zkLoginClient: client, clientKey: 'member-client', now }))).toBe('signed in');
    }
    const after = await zkLoginAttempt(now);
    expect(await outcomeOf(complete(after.issued.message, after.signed, { zkLoginClient: client, clientKey: 'another-client', now }))).toBe('CHAIN_UNAVAILABLE');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(perClient);
  });

  it('counts one client against its own limit before the shared quota, so three requests from one client with fresh nonces take at most three places of the minute, and the rest are 429 rate_limited (C34)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(ZKLOGIN_CLIENT_LIMITS.map((limit) => limit.limit)).toEqual([LIMITS.zkLoginChecksPerClientPerMinute, LIMITS.zkLoginChecksPerClientPerDay]);
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => ({ success: true, errors: [] }));
    const [perMinute] = ZKLOGIN_CHECK_QUOTAS;
    const perClient = LIMITS.zkLoginChecksPerClientPerMinute;
    const now = new Date('2026-12-02T09:00:00.000Z');
    // One place more than this client may take is left in the shared minute.
    await fillShared(perMinute, perMinute.limit - perClient - 1, now);

    const outcomes: string[] = [];
    for (let i = 0; i < perClient + 2; i += 1) {
      const { issued, signed } = await zkLoginAttempt(now);
      outcomes.push(await outcomeOf(complete(issued.message, signed, { zkLoginClient: client, clientKey: 'one-client', now })));
    }
    expect(outcomes).toEqual([...Array<string>(perClient).fill('signed in'), '429 rate_limited', '429 rate_limited']);
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(perClient);

    // The one place left proves the refused requests took none of it.
    const other = await zkLoginAttempt(now);
    expect(await outcomeOf(complete(other.issued.message, other.signed, { zkLoginClient: client, clientKey: 'another-client', now }))).toBe('signed in');
    const last = await zkLoginAttempt(now);
    expect(await outcomeOf(complete(last.issued.message, last.signed, { zkLoginClient: client, clientKey: 'a-third-client', now }))).toBe('CHAIN_UNAVAILABLE');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(perClient + 1);
  });

  it('holds one client to LIMITS.zkLoginChecksPerClientPerDay checks a day, whatever minute they come in, while another client still signs in (C34)', { timeout: 60_000 }, async () => {
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => ({ success: true, errors: [] }));
    const day = Date.parse('2026-12-04T00:00:00.000Z');
    const perMinute = LIMITS.zkLoginChecksPerClientPerMinute;
    const perDay = LIMITS.zkLoginChecksPerClientPerDay;
    const signInAs = async (clientKey: string, now: Date) => {
      const { issued, signed } = await zkLoginAttempt(now);
      return outcomeOf(complete(issued.message, signed, { zkLoginClient: client, clientKey, now }));
    };

    const outcomes: string[] = [];
    for (let i = 0; i <= perDay; i += 1) outcomes.push(await signInAs('daily-client', new Date(day + Math.floor(i / perMinute) * 60_000)));
    // The day's refusal says so, since waiting a minute would not help.
    expect(outcomes).toEqual([...Array<string>(perDay).fill('signed in'), '429 rate_limited_today']);

    const freshMinute = new Date(day + (Math.floor(perDay / perMinute) + 1) * 60_000);
    expect(await signInAs('daily-client', freshMinute)).toBe('429 rate_limited_today');
    expect(await signInAs('another-client', freshMinute)).toBe('signed in');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(perDay + 1);
  });

  it('refuses zkLogin checks past the shared minute quota with CHAIN_UNAVAILABLE and past the day quota with 503 chain_unavailable_today, before any chain call, the nonce used up, counts each zkLogin member of a multisig, and logs a spent window once (C22, C34)', { timeout: 60_000 }, async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signinLines = () => error.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => line.startsWith('[ellai signin]'));
    const [perMinute, perDay] = ZKLOGIN_CHECK_QUOTAS;
    expect([perMinute.limit, perDay.limit]).toEqual([LIMITS.zkLoginChecksPerMinute, LIMITS.zkLoginChecksPerDay]);
    const { client, verifyZkLoginSignature } = zkLoginClient(async () => ({ success: true, errors: [] }));
    // A day of its own, so these counters start at zero and no other test counts in them.
    const day = Date.parse('2026-12-01T00:00:00.000Z');
    const at = (ms: number) => new Date(day + ms);
    const attempt = async (now: Date, signature?: (message: string) => Promise<string>) => {
      const { issued, signed } = await zkLoginAttempt(now, signature);
      return { issued, run: (when: Date) => complete(issued.message, signed, { zkLoginClient: client, now: when }) };
    };

    await fillShared(perMinute, perMinute.limit, at(1_000));
    const overMinute = await attempt(at(2_000));
    const unavailable = await refused(overMinute.run(at(2_000)), 'CHAIN_UNAVAILABLE');
    expect(toErrorResponse(unavailable).status).toBe(503);
    await refused((await attempt(at(3_000))).run(at(3_000)), 'CHAIN_UNAVAILABLE');
    expect(verifyZkLoginSignature).not.toHaveBeenCalled();
    expect(await nonceUsedAt(overMinute.issued.nonce)).toEqual(at(2_000));
    expect(signinLines()).toEqual(['[ellai signin] quota_spent zklogin-checks:minute']);

    // Its nonce is spent, so the next minute only a fresh sign-in gets through.
    await refused(overMinute.run(at(60_000)), 'NONCE_USED');
    await expect((await attempt(at(60_000))).run(at(60_000))).resolves.toMatchObject({ ownerId: expect.any(String) });
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);

    // Two zkLogin members are two checks, so one place left in the minute is not enough.
    await fillShared(perMinute, perMinute.limit - 1, at(120_000));
    await refused((await attempt(at(120_000), zkLoginMembers(2))).run(at(120_000)), 'CHAIN_UNAVAILABLE');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);

    await fillShared(perDay, perDay.limit, at(180_000));
    const overDay = await attempt(at(240_000));
    expect(await outcomeOf(overDay.run(at(240_000)))).toBe('503 chain_unavailable_today');
    expect(verifyZkLoginSignature).toHaveBeenCalledTimes(1);
    expect(await nonceUsedAt(overDay.issued.nonce)).toEqual(at(240_000));
    for (const line of signinLines()) expect(line).toMatch(/^\[ellai signin\] quota_spent zklogin-checks:(minute|day)$/);
  });

  /** One Ed25519 sign-in at `now` from `clientKey`, signed by `signWith` (the address's own key unless given). */
  async function daySignIn(now: Date, clientKey: string, signWith?: Signer) {
    const signer = Ed25519Keypair.generate();
    const issued = await issueSignIn({ db, address: signer.toSuiAddress(), appOrigin: APP_ORIGIN, now });
    const outcome = await outcomeOf(complete(issued.message, await sign(signWith ?? signer, issued.message), { clientKey, now }));
    const madeOwner = (await db.select().from(owners).where(eq(owners.suiAddress, canonicalSuiAddress(signer.toSuiAddress())))).length === 1;
    return { issued, outcome, madeOwner };
  }

  it('holds one client to LIMITS.signInsPerClientPerDay sign-ins a day, counted only once the signature holds: 429 rate_limited_today past it, with no owner or session, while another client signs in (C22, C34)', { timeout: 60_000 }, async () => {
    // A day of its own, so these counters start at zero.
    const now = new Date('2026-12-06T08:00:00.000Z');
    expect(SIGN_IN_CLIENT_DAY.limit).toBe(LIMITS.signInsPerClientPerDay);
    expect(await daySignIn(now, 'busy-client', Ed25519Keypair.generate())).toMatchObject({ outcome: 'BAD_SIGNATURE', madeOwner: false });
    const outcomes: string[] = [];
    for (let i = 0; i < SIGN_IN_CLIENT_DAY.limit; i += 1) outcomes.push((await daySignIn(now, 'busy-client')).outcome);
    expect(outcomes).toEqual(Array<string>(SIGN_IN_CLIENT_DAY.limit).fill('signed in'));

    const sessionsBefore = await sessionCount();
    const over = await daySignIn(now, 'busy-client');
    expect(over).toMatchObject({ outcome: '429 rate_limited_today', madeOwner: false });
    expect(await nonceUsedAt(over.issued.nonce)).toEqual(now);
    expect(await sessionCount()).toBe(sessionsBefore);
    expect((await daySignIn(now, 'another-client')).outcome).toBe('signed in');
    expect((await daySignIn(new Date(now.getTime() + 86_400_000), 'busy-client')).outcome).toBe('signed in');
  });

  it('refuses every sign-in past LIMITS.signInsPerDayGlobal with 503 chain_unavailable_today, after the signature and before any owner row, logging the spent day once (C22, C34)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A day no other test here signs in on, so the first refusal of the shared day is this test's.
    const now = new Date('2026-12-09T08:00:00.000Z');
    expect(SIGN_IN_SHARED_DAY.limit).toBe(LIMITS.signInsPerDayGlobal);
    await consumeShared(db, SIGN_IN_SHARED_DAY.name, SIGN_IN_SHARED_DAY.limit, SIGN_IN_SHARED_DAY.windowMs, now, SIGN_IN_SHARED_DAY.limit);
    const refused = [await daySignIn(now, 'first-client'), await daySignIn(now, 'second-client')];
    expect(refused.map(({ outcome, madeOwner }) => ({ outcome, madeOwner }))).toEqual(Array(2).fill({ outcome: '503 chain_unavailable_today', madeOwner: false }));
    for (const { issued } of refused) expect(await nonceUsedAt(issued.nonce)).toEqual(now);
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual(['[ellai signin] quota_spent signins:day']);
    expect((await daySignIn(new Date(now.getTime() + 86_400_000), 'first-client')).outcome).toBe('signed in');
  });

  it('makes the owner row again when emptyOwners deletes it between the sign-in steps, holding it FOR KEY SHARE until the session is written (C34)', async () => {
    const keypair = Ed25519Keypair.generate();
    const address = canonicalSuiAddress(keypair.toSuiAddress());
    const purseAddress = canonicalSuiAddress(derivePurseKeypair(MASTER, address).toSuiAddress());
    // A two-day-old row with nothing pointing at it: just what emptyOwners deletes.
    const old = one(await db.insert(owners).values({ suiAddress: address, purseAddress, createdAt: later(-2 * 86_400_000) }).returning({ id: owners.id }));
    const client = (db as unknown as { $client: PGlite }).$client;
    const sent: string[] = [];
    const logged = drizzlePglite({ client, schema, logger: { logQuery: (query) => sent.push(query) } }) as unknown as Database;
    const { message } = await issue(address);
    const signature = await sign(keypair, message);

    const result = await completeSignIn({ db: prunedMidway(logged, address), message, signature, appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now: NOW, clientKey: 'racing-client' });
    expect(result.ownerId).not.toBe(old.id);
    expect(await db.select({ id: owners.id }).from(owners).where(eq(owners.suiAddress, address))).toEqual([{ id: result.ownerId }]);
    expect(one(await db.select().from(sessions).where(eq(sessions.ownerId, result.ownerId))).tokenHash).toBe(hashBearerToken(result.sessionToken, SECRET));
    const held = sent.filter((query) => /^select "id" from "owners" where "owners"\."sui_address" = \$1 for key share$/.test(query));
    expect(held).toHaveLength(2);
  });
});

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `base`, except that inside a transaction the first owner insert is followed at once by the delete
 * emptyOwners would make for `address`: an owner row pruned between the sign-in steps. PGlite serves
 * one connection, so the delete runs inside the sign-in's own transaction.
 */
function prunedMidway(base: Database, address: string): Database {
  let pruned = false;
  const bound = (target: object, property: PropertyKey) => {
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const pruning = (tx: Tx) =>
    new Proxy(tx, {
      get(inner, property) {
        if (property !== 'insert') return bound(inner, property);
        return (table: typeof owners) => {
          const builder = inner.insert(table);
          if (table !== owners || pruned) return builder;
          return {
            values: (values: typeof owners.$inferInsert) => ({
              onConflictDoNothing: (config: { target: typeof owners.suiAddress }) =>
                builder
                  .values(values)
                  .onConflictDoNothing(config)
                  .then(async (result) => {
                    pruned = true;
                    await inner.delete(owners).where(eq(owners.suiAddress, address));
                    return result;
                  }),
            }),
          };
        };
      },
    });
  return new Proxy(base, {
    get(target, property) {
      if (property !== 'transaction') return bound(target, property);
      return (run: (tx: Tx) => Promise<unknown>) => target.transaction((tx) => run(pruning(tx)));
    },
  });
}

describe('sessions', () => {
  it('resolves a session token, and never an agent token or a record id', async () => {
    const result = await signIn();
    const resolved = await resolveSession({ db, token: result.sessionToken, sessionSecretHex: SECRET, now: NOW });
    expect(resolved).toEqual({ ownerId: result.ownerId, sessionId: expect.any(String) });
    expect(one(await db.select().from(sessions).where(eq(sessions.tokenHash, hashBearerToken(result.sessionToken, SECRET) ?? ''))).id).toBe(resolved?.sessionId);

    const agent = await createAgent(result.ownerId);
    expect(await resolveSession({ db, token: agent.token, sessionSecretHex: SECRET, now: NOW })).toBeNull();
    expect(await authenticateAgent({ db, token: result.sessionToken, sessionSecretHex: SECRET })).toBeNull();
    for (const id of [resolved?.sessionId, result.ownerId, agent.agentId, `${SESSION_TOKEN_PREFIX}${resolved?.sessionId}`]) {
      expect(await resolveSession({ db, token: id, sessionSecretHex: SECRET, now: NOW })).toBeNull();
      expect(await authenticateAgent({ db, token: id, sessionSecretHex: SECRET })).toBeNull();
    }
  });

  it('stops resolving a session once it expires or is ended', async () => {
    const result = await signIn();
    const resolve = (now: Date) => resolveSession({ db, token: result.sessionToken, sessionSecretHex: SECRET, now });
    expect(await resolve(later(LIMITS.sessionTtlMs - 1))).not.toBeNull();
    expect(await resolve(later(LIMITS.sessionTtlMs))).toBeNull();

    expect(await endSession({ db, token: result.sessionToken, sessionSecretHex: SECRET, now: later(5_000) })).toBe(true);
    expect(await resolve(later(10_000))).toBeNull();
    expect(await endSession({ db, token: result.sessionToken, sessionSecretHex: SECRET, now: later(20_000) })).toBe(false);
    expect(one(await db.select().from(sessions).where(eq(sessions.ownerId, result.ownerId))).revokedAt).toEqual(later(5_000));
  });

  it("ends every live session of one owner at once, leaving an ended or expired one as it was and another owner's open", async () => {
    const signer = Ed25519Keypair.generate();
    const first = await signIn(signer);
    const second = await signIn(signer);
    const ended = await signIn(signer);
    const expired = await signIn(signer);
    const other = await signIn();
    expect(new Set([first.ownerId, second.ownerId, ended.ownerId, expired.ownerId])).toEqual(new Set([first.ownerId]));
    const hashOf = (token: string) => hashBearerToken(token, SECRET) ?? '';
    await endSession({ db, token: ended.sessionToken, sessionSecretHex: SECRET, now: later(1_000) });
    await db.update(sessions).set({ expiresAt: later(2_000) }).where(eq(sessions.tokenHash, hashOf(expired.sessionToken)));

    expect(await endOwnerSessions({ db, ownerId: first.ownerId, now: later(5_000) })).toBe(2);
    for (const token of [first.sessionToken, second.sessionToken, ended.sessionToken, expired.sessionToken]) {
      expect(await resolveSession({ db, token, sessionSecretHex: SECRET, now: later(5_000) })).toBeNull();
    }
    const revokedAt = async (token: string) => one(await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.tokenHash, hashOf(token)))).revokedAt;
    expect([await revokedAt(first.sessionToken), await revokedAt(second.sessionToken), await revokedAt(ended.sessionToken), await revokedAt(expired.sessionToken)]).toEqual([
      later(5_000),
      later(5_000),
      later(1_000),
      null,
    ]);
    expect(await resolveSession({ db, token: other.sessionToken, sessionSecretHex: SECRET, now: later(5_000) })).toEqual({ ownerId: other.ownerId, sessionId: expect.any(String) });
    expect(await endOwnerSessions({ db, ownerId: first.ownerId, now: later(6_000) })).toBe(0);
    await expect(endOwnerSessions({ db, ownerId: first.ownerId, now: new Date(Number.NaN) })).rejects.toThrow('The current time is not a date');
  });

  it('refuses a malformed or wrong-kind token without touching the database', async () => {
    const session = newBearerToken(SESSION_TOKEN_PREFIX, SECRET).token;
    const agent = newBearerToken(AGENT_TOKEN_PREFIX, SECRET).token;
    const malformed = [undefined, '', 'junk', SESSION_TOKEN_PREFIX, `${session}A`, session.slice(0, -1), `${session}; Path=/`, ` ${session}`, session.toUpperCase(), `${SESSION_TOKEN_PREFIX}${'/'.repeat(43)}`];
    for (const token of [...malformed, agent]) {
      expect(await resolveSession({ db: untouchable, token, sessionSecretHex: SECRET, now: NOW })).toBeNull();
      expect(await endSession({ db: untouchable, token, sessionSecretHex: SECRET, now: NOW })).toBe(false);
    }
    for (const token of [...malformed.map((value) => value?.replace(SESSION_TOKEN_PREFIX, AGENT_TOKEN_PREFIX)), session]) {
      expect(await authenticateAgent({ db: untouchable, token, sessionSecretHex: SECRET })).toBeNull();
    }
    await expect(resolveSession({ db: untouchable, token: session, sessionSecretHex: SECRET, now: NOW })).rejects.toThrow('the database was touched');
    await expect(authenticateAgent({ db: untouchable, token: agent, sessionSecretHex: SECRET })).rejects.toThrow('the database was touched');
  });

  it('writes the session cookie with its attributes, named __Host-ellai_session whenever it is Secure, and refuses anything but a session token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { token } = newBearerToken(SESSION_TOKEN_PREFIX, SECRET);
    expect(sessionCookie(token, later(LIMITS.sessionTtlMs), true)).toBe(`__Host-ellai_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure`);
    expect(sessionCookie(token, later(90_500), false)).toBe(`ellai_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=90`);
    expect(sessionCookie(token, later(-1_000), true)).toContain('Max-Age=0;');
    expect(sessionCookie(token, later(1_000), true)).not.toContain('Domain');
    for (const value of [newBearerToken(AGENT_TOKEN_PREFIX, SECRET).token, `${token}; Domain=evil.example`, '']) {
      expect(() => sessionCookie(value, later(1_000), true)).toThrow('Only a session token can be set as the session cookie');
    }
  });

  it('reads exactly one session cookie, under the one name the Secure rule gives and never the other', () => {
    const { token } = newBearerToken(SESSION_TOKEN_PREFIX, SECRET);
    const other = newBearerToken(SESSION_TOKEN_PREFIX, SECRET).token;
    for (const secure of [true, false]) {
      expect(readSessionCookie(null, secure)).toBeUndefined();
      expect(readSessionCookie('', secure)).toBeUndefined();
      expect(readSessionCookie('theme=dark; other=1', secure)).toBeUndefined();
    }
    expect(readSessionCookie(`theme=dark; __Host-ellai_session=${token}; other=1`, true)).toBe(token);
    expect(readSessionCookie(`__Host-ellai_session=${token}`, true)).toBe(token);
    expect(readSessionCookie(`__host-ellai_session=${token}`, true)).toBeUndefined();
    expect(readSessionCookie(`__Host-ellai_session=${token}; __Host-ellai_session=${other}`, true)).toBeUndefined();
    // A plain-named cookie can be set by a sibling site on a shared parent domain, so once the
    // cookie is Secure it is never read, not even beside the real one or in its absence.
    expect(readSessionCookie(`ellai_session=${token}`, true)).toBeUndefined();
    expect(readSessionCookie(`ellai_session=${other}; __Host-ellai_session=${token}`, true)).toBe(token);
    expect(readSessionCookie(`__Secure-ellai_session=${token}`, true)).toBeUndefined();

    expect(readSessionCookie(`theme=dark; ellai_session=${token}; other=1`, false)).toBe(token);
    expect(readSessionCookie(`Ellai_session=${token}`, false)).toBeUndefined();
    expect(readSessionCookie(`__Host-ellai_session=${token}`, false)).toBeUndefined();
    expect(readSessionCookie(`ellai_session=${token}; ellai_session=${other}`, false)).toBeUndefined();
  });
});

describe('agents', () => {
  it('creates, authenticates and revokes an agent token, and refuses it once revoked', async () => {
    const { ownerId } = await signIn();
    const agent = await createAgent(ownerId, '  Travel agent  ');
    expect(isBearerToken(agent.token, AGENT_TOKEN_PREFIX)).toBe(true);
    expect(agent.displayPrefix).toBe(agent.token.slice(0, AGENT_TOKEN_PREFIX.length + 6));
    expect(agent.token).not.toContain(agent.agentId);
    const row = one(await db.select().from(agents).where(eq(agents.id, agent.agentId)));
    expect(row).toMatchObject({ ownerId, label: 'Travel agent', kind: 'external', tokenHash: hashBearerToken(agent.token, SECRET), tokenPrefix: agent.displayPrefix, revokedAt: null });
    expect(Object.values(row)).not.toContain(agent.token);

    expect(await authenticateAgent({ db, token: agent.token, sessionSecretHex: SECRET })).toEqual({ ownerId, agentId: agent.agentId });
    await revokeAgent({ db, ownerId, agentId: agent.agentId, now: later(1_000) });
    expect(await authenticateAgent({ db, token: agent.token, sessionSecretHex: SECRET })).toBeNull();
    await revokeAgent({ db, ownerId, agentId: agent.agentId, now: later(2_000) });
    expect(one(await db.select().from(agents).where(eq(agents.id, agent.agentId))).revokedAt).toEqual(later(1_000));
  });

  it("refuses to revoke another owner's agent, which keeps working", async () => {
    const mine = await signIn();
    const theirs = await signIn();
    const theirAgent = await createAgent(theirs.ownerId);
    const notFound = new AgentError('NOT_FOUND', 'there is no such agent for this owner');
    await expect(revokeAgent({ db, ownerId: mine.ownerId, agentId: theirAgent.agentId, now: NOW })).rejects.toThrow(notFound);
    await expect(revokeAgent({ db, ownerId: mine.ownerId, agentId: '00000000-0000-4000-8000-000000000000', now: NOW })).rejects.toThrow(notFound);
    expect(await authenticateAgent({ db, token: theirAgent.token, sessionSecretHex: SECRET })).toEqual({ ownerId: theirs.ownerId, agentId: theirAgent.agentId });
  });

  it("lists only this owner's agents, and never a hash", async () => {
    const { ownerId } = await signIn();
    const first = await createAgent(ownerId, 'First');
    const second = await createAgentToken({ db, ownerId, label: 'Second', kind: 'builtin', sessionSecretHex: SECRET, now: later(1) });
    await createAgent((await signIn()).ownerId, 'Not mine');
    const listed = await listAgents({ db, ownerId });
    expect(listed.map((agent) => agent.agentId)).toEqual([first.agentId, second.agentId]);
    for (const agent of listed) {
      expect(Object.keys(agent).sort()).toEqual(['agentId', 'createdAt', 'displayPrefix', 'kind', 'label', 'revokedAt']);
    }
    const text = JSON.stringify(listed);
    for (const made of [first, second]) {
      expect(text).not.toContain(hashBearerToken(made.token, SECRET));
      expect(text).not.toContain(made.token);
    }
  });

  it('refuses a bad label, kind or owner', async () => {
    const { ownerId } = await signIn();
    for (const label of ['', '   ', 'x'.repeat(61), 'two\nlines', 42 as unknown as string]) {
      await expect(createAgent(ownerId, label)).rejects.toMatchObject({ name: 'AgentError', code: 'BAD_INPUT' });
    }
    await expect(createAgentToken({ db, ownerId, label: 'Agent', kind: 'admin' as 'external', sessionSecretHex: SECRET, now: NOW })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(createAgent('not-a-uuid')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(createAgent('00000000-0000-4000-8000-000000000000')).rejects.toThrow(new AgentError('NOT_FOUND', 'there is no such owner'));
    expect(await listAgents({ db, ownerId })).toEqual([]);
  });

  it('makes each run of spaces one, and refuses every other blank, invisible filler and quote mark but an apostrophe, so a label can neither pad a wallet line nor end its quote', async () => {
    const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
    expect(checkLabel('  Trip   planner  two ')).toBe('Trip planner two');
    expect(checkLabel(checkLabel('  Trip   planner  two '))).toBe('Trip planner two');
    for (const fine of ['Caf' + ch(0xe9) + ' bot', "Ram's bot", `Ram${ch(0x2019)}s bot`, ch(0x1f600).repeat(3), 'Agent-2 (travel)', ch(0x0928, 0x092e, 0x0938, 0x094d, 0x0924, 0x0947)]) {
      expect(checkLabel(fine)).toBe(fine);
    }
    const blanks = [0xa0, 0x1680, 0x2000, 0x2003, 0x200a, 0x202f, 0x205f, 0x3000];
    const fillers = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e, 0x034f, 0xfe0f, 0xe0041];
    const quotes = [0x22, 0x201c, 0x201d, 0x201e, 0x2033, 0x2036, 0x02ba, 0x02ee, 0x05f4, 0x3003, 0x301e, 0xff02, 0x2e42, 0x02dd];
    for (const codePoint of [...blanks, ...fillers, ...quotes]) {
      const label = `Bot${ch(codePoint).repeat(20)}Daily budget: 5.00 USDC`;
      expect(() => checkLabel(label), codePoint.toString(16)).toThrow(AgentError);
    }
    expect(() => checkLabel(`Bot${ch(0x3164)}`)).toThrow(new AgentError('BAD_INPUT', 'the label must not contain blank characters other than the plain space'));
    expect(() => checkLabel('Bot" and "x')).toThrow(new AgentError('BAD_INPUT', 'the label must not contain quote marks other than an apostrophe'));
    const { ownerId } = await signIn();
    await createAgent(ownerId, ' Trip   planner ');
    expect((await listAgents({ db, ownerId })).map((agent) => agent.label)).toEqual(['Trip planner']);
  });

  it('refuses the 21st live external agent, even in a race, never counts the built-in agent, and makes room when one is revoked', async () => {
    const { ownerId } = await signIn();
    expect(LIMITS.agentsPerOwnerMax).toBe(20);
    const tooMany = new AgentError('TOO_MANY_AGENTS', 'an owner may hold at most 20 agents at once; revoke one first');
    const builtin = (label: string) => createAgentToken({ db, ownerId, label, kind: 'builtin', sessionSecretHex: SECRET, now: NOW });
    await builtin('Demo agent');
    const made = [];
    for (let i = 1; i <= 19; i += 1) made.push(await createAgent(ownerId, `Agent ${i}`));

    const raced = await Promise.allSettled([createAgent(ownerId, 'Racer 1'), createAgent(ownerId, 'Racer 2'), createAgent(ownerId, 'Racer 3')]);
    expect(raced.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const lost of raced.filter((outcome) => outcome.status === 'rejected')) expect(lost.reason).toEqual(tooMany);
    await expect(createAgent(ownerId, 'Agent 21')).rejects.toThrow(tooMany);
    expect(await listAgents({ db, ownerId })).toHaveLength(21);

    // At the cap, a revoked built-in agent is replaced, and the index still allows only one live one.
    const [demo] = (await listAgents({ db, ownerId })).filter((agent) => agent.kind === 'builtin');
    await revokeAgent({ db, ownerId, agentId: demo?.agentId ?? '', now: later(500) });
    await expect(builtin('Built-in agent')).resolves.toMatchObject({ agentId: expect.any(String) });
    await expect(builtin('A second built-in agent')).rejects.toThrow();

    await revokeAgent({ db, ownerId, agentId: made[1]?.agentId ?? '', now: later(1_000) });
    await expect(createAgent(ownerId, 'Agent 21')).resolves.toMatchObject({ agentId: expect.any(String) });
    await expect(createAgent(ownerId, 'Agent 22')).rejects.toMatchObject({ name: 'AgentError', code: 'TOO_MANY_AGENTS' });
    expect(await listAgents({ db, ownerId })).toHaveLength(23);
    await expect(createAgent((await signIn()).ownerId, 'Someone else')).resolves.toBeDefined();
  });

  it('revokes under the owner row lock a signature holds, so it waits for a signer already holding it (C13)', async () => {
    const { ownerId } = await signIn();
    const first = await createAgent(ownerId, 'First');
    const second = await createAgent(ownerId, 'Second');

    // Every statement revokeAgent sends, with its transaction's start and end marked.
    const client = (db as unknown as { $client: PGlite }).$client;
    const sent: string[] = [];
    const logged = drizzlePglite({ client, schema, logger: { logQuery: (query) => sent.push(query) } }) as unknown as Database;
    const transaction = client.transaction.bind(client);
    client.transaction = (async (callback: Parameters<PGlite['transaction']>[0]) => {
      sent.push('begin');
      try {
        return await transaction(callback);
      } finally {
        sent.push('end');
      }
    }) as PGlite['transaction'];
    try {
      await revokeAgent({ db: logged, ownerId, agentId: first.agentId, now: later(1_000) });
    } finally {
      Reflect.deleteProperty(client, 'transaction');
    }
    expect(sent).toEqual([
      'begin',
      expect.stringMatching(/^select "id" from "owners" where "owners"\."id" = \$1 for update$/),
      expect.stringMatching(/^update "agents" set "revoked_at" = \$1 where/),
      'end',
    ]);

    // A signer holding the lock reads the agent live and finishes before the revoke lands.
    const events: string[] = [];
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const signer = db.transaction(async (tx) => {
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
      events.push('lock taken');
      held();
      await released;
      const [agent] = await tx.select({ revokedAt: agents.revokedAt }).from(agents).where(eq(agents.id, second.agentId));
      events.push(agent?.revokedAt === null ? 'agent live under the lock' : 'agent revoked under the lock');
    });
    await lockHeld;
    const revoking = revokeAgent({ db, ownerId, agentId: second.agentId, now: later(2_000) }).then(() => events.push('revoked'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(['lock taken']);
    release();
    await Promise.all([signer, revoking]);
    expect(events).toEqual(['lock taken', 'agent live under the lock', 'revoked']);
    expect(await authenticateAgent({ db, token: second.token, sessionSecretHex: SECRET })).toBeNull();
  });
});

describe('error messages', () => {
  it('never repeat a token, a signature or the message text', async () => {
    const marker = `marker${hex(8)}`;
    const owner = Ed25519Keypair.generate();
    const { message } = await issue(owner.toSuiAddress());
    const signature = await sign(owner, message);
    const markedMessage = `${message}\n${marker}`;
    const markedHost = withLine(message, 0, `${marker} wants you to sign in to Ellai with your Sui account:`);
    // A refused signature uses up its nonce, so each signature refusal and the sign-in get their own.
    const second = await issue(owner.toSuiAddress());
    const third = await issue(owner.toSuiAddress());
    const errors = [
      await refusal(issue(marker)),
      await refusal(complete(markedMessage, await sign(owner, markedMessage))),
      await refusal(complete(markedHost, await sign(owner, markedHost))),
      await refusal(complete(second.message, marker)),
      await refusal(complete(third.message, toBase64(new TextEncoder().encode(marker)))),
    ];
    const result = await complete(message, signature);
    errors.push(await refusal(complete(message, signature)));

    const agent = await createAgent(result.ownerId);
    const syncRefusal = (run: () => unknown) => refusal(Promise.resolve().then(run));
    errors.push(await syncRefusal(() => sessionCookie(agent.token, later(1_000), true)));
    errors.push(await syncRefusal(() => sessionCookie(`${result.sessionToken}; Domain=${marker}`, later(1_000), true)));
    errors.push(await refusal(createAgent(result.ownerId, `${marker}\u0007`)));
    errors.push(await refusal(revokeAgent({ db, ownerId: result.ownerId, agentId: marker, now: NOW })));

    expect(errors).toHaveLength(10);
    for (const error of errors) {
      const text = `${error.message}\n${error.stack ?? ''}`;
      for (const secret of [marker, message, second.message, third.message, signature, result.sessionToken, agent.token]) {
        expect(text).not.toContain(secret);
      }
      expect(error.cause).toBeUndefined();
    }
  });
});
