// Covers: wallet sign-in end to end on PGlite with real Ed25519, Secp256k1, Secp256r1 and
// multisig keys; the message shape and every refusal of a message, a signature or a nonce;
// the owner row and its derived purse; sessions, their cookie and their end; agent tokens
// and their revocation; that one kind of token never works as the other or as a record id;
// that malformed tokens never reach the database; and that no refusal repeats a token, a
// signature or the message.
// Does NOT cover: zkLogin with a chain client (there is no network here, so only the
// refusal without one is proven), passkey or ML-DSA signatures, real wallet software, two
// database connections racing for one nonce (PGlite serves one connection, so the race is
// run with Promise.all on that one connection), or the routes that will call these
// functions with their same-origin check and rate limits.
import { createHmac, randomBytes } from 'node:crypto';
import { derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { bcs } from '@mysten/sui/bcs';
import { SIGNATURE_SCHEME_TO_FLAG, type Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { MultiSigPublicKey, MultiSigSigner } from '@mysten/sui/multisig';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentError, authenticateAgent, createAgentToken, listAgents, revokeAgent } from '../src/server/auth/agents.js';
import { endSession, readSessionCookie, resolveSession, sessionCookie } from '../src/server/auth/sessions.js';
import { SignInError, type SignInErrorCode, completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { AGENT_TOKEN_PREFIX, type BearerTokenPrefix, SESSION_TOKEN_PREFIX, hashBearerToken, isBearerToken, newBearerToken } from '../src/server/auth/tokens.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, owners, sessions, signinNonces } from '../src/server/db/schema.js';

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

type CompleteArgs = Parameters<typeof completeSignIn>[0];

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

function complete(message: string, signature: string, overrides: Partial<CompleteArgs> = {}) {
  return completeSignIn({ db, message, signature, appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now: NOW, ...overrides });
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

function createAgent(ownerId: string, label = 'Travel agent') {
  return createAgentToken({ db, ownerId, label, kind: 'external', sessionSecretHex: SECRET, now: NOW });
}

describe('bearer tokens', () => {
  it.each<BearerTokenPrefix>([SESSION_TOKEN_PREFIX, AGENT_TOKEN_PREFIX])('makes %s tokens with a keyed hash and a display prefix', (prefix) => {
    const first = newBearerToken(prefix, SECRET);
    expect(first.token).toMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`));
    expect(Buffer.from(first.token.slice(prefix.length), 'base64url')).toHaveLength(LIMITS.bearerTokenBytes);
    expect(first.hash).toBe(createHmac('sha256', Buffer.from(SECRET, 'hex')).update(first.token).digest('hex'));
    expect(first.displayPrefix).toBe(first.token.slice(0, 12));
    expect(hashBearerToken(first.token, SECRET)).toBe(first.hash);
    expect(hashBearerToken(first.token, hex(32))).not.toBe(first.hash);
    expect(newBearerToken(prefix, SECRET).token).not.toBe(first.token);
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

    const result = await complete(message, await sign(new MultiSigSigner(multisig, [first, second]), message));
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
    await refused(complete(swapped, await sign(keypair, swapped)), 'BAD_SIGNATURE');
    expect(await db.select().from(owners).where(eq(owners.suiAddress, someoneElse))).toEqual([]);
  });

  it('refuses a signature by a different key than the address, without using up the nonce', async () => {
    const owner = Ed25519Keypair.generate();
    const { message } = await issue(owner.toSuiAddress());
    await refused(complete(message, await sign(Ed25519Keypair.generate(), message)), 'BAD_SIGNATURE');
    await refused(complete(message, await sign(Secp256k1Keypair.generate(), message)), 'BAD_SIGNATURE');
    for (const junk of ['', 'not base64 at all!', toBase64(new Uint8Array([9, 1, 2, 3]))]) {
      await refused(complete(message, junk), 'BAD_SIGNATURE');
    }
    await expect(complete(message, await sign(owner, message))).resolves.toBeDefined();
  });

  it('refuses a zkLogin signature without a chain client, alone or inside a multisig', async () => {
    const member = Ed25519Keypair.generate();
    const { message } = await issue(member.toSuiAddress());
    const zkLogin = getZkLoginSignature({
      inputs: {
        proofPoints: { a: ['1', '2', '1'], b: [['1', '0'], ['3', '4'], ['1', '0']], c: ['5', '6', '1'] },
        issBase64Details: { value: 'yJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLC', indexMod4: 1 },
        headerBase64: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ',
        addressSeed: '13322897930163218532266430409510394316985274769125667290600321564259466511711',
      },
      maxEpoch: '10',
      userSignature: await sign(Ed25519Keypair.generate(), message),
    });
    await refused(complete(message, zkLogin), 'ZKLOGIN_UNAVAILABLE');

    const multisig = bcs.MultiSig.serialize(
      {
        sigs: [{ ZkLogin: fromBase64(zkLogin).slice(1) }],
        bitmap: 1,
        multisig_pk: { pk_map: [{ pubKey: { ED25519: member.getPublicKey().toRawBytes() }, weight: 1 }], threshold: 1 },
      },
      { maxSize: 65_536 },
    ).toBytes();
    const zkLoginInsideMultisig = toBase64(new Uint8Array([SIGNATURE_SCHEME_TO_FLAG.MultiSig, ...multisig]));
    await refused(complete(message, zkLoginInsideMultisig), 'ZKLOGIN_UNAVAILABLE');
  });
});

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

  it('writes the session cookie with its attributes, and refuses anything but a session token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { token } = newBearerToken(SESSION_TOKEN_PREFIX, SECRET);
    expect(sessionCookie(token, later(LIMITS.sessionTtlMs), true)).toBe(`ellai_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure`);
    expect(sessionCookie(token, later(90_500), false)).toBe(`ellai_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=90`);
    expect(sessionCookie(token, later(-1_000), true)).toContain('Max-Age=0;');
    for (const value of [newBearerToken(AGENT_TOKEN_PREFIX, SECRET).token, `${token}; Domain=evil.example`, '']) {
      expect(() => sessionCookie(value, later(1_000), true)).toThrow('Only a session token can be set as the session cookie');
    }
  });

  it('reads exactly one session cookie from the request header', () => {
    const { token } = newBearerToken(SESSION_TOKEN_PREFIX, SECRET);
    expect(readSessionCookie(null)).toBeUndefined();
    expect(readSessionCookie('')).toBeUndefined();
    expect(readSessionCookie('theme=dark; other=1')).toBeUndefined();
    expect(readSessionCookie(`theme=dark; ellai_session=${token}; other=1`)).toBe(token);
    expect(readSessionCookie(`ellai_session=${token}`)).toBe(token);
    expect(readSessionCookie(`Ellai_session=${token}`)).toBeUndefined();
    expect(readSessionCookie(`ellai_session=${token}; ellai_session=${newBearerToken(SESSION_TOKEN_PREFIX, SECRET).token}`)).toBeUndefined();
  });
});

describe('agents', () => {
  it('creates, authenticates and revokes an agent token, and refuses it once revoked', async () => {
    const { ownerId } = await signIn();
    const agent = await createAgent(ownerId, '  Travel agent  ');
    expect(isBearerToken(agent.token, AGENT_TOKEN_PREFIX)).toBe(true);
    expect(agent.displayPrefix).toBe(agent.token.slice(0, 12));
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
});

describe('error messages', () => {
  it('never repeat a token, a signature or the message text', async () => {
    const marker = `marker${hex(8)}`;
    const owner = Ed25519Keypair.generate();
    const { message } = await issue(owner.toSuiAddress());
    const signature = await sign(owner, message);
    const markedMessage = `${message}\n${marker}`;
    const markedHost = withLine(message, 0, `${marker} wants you to sign in to Ellai with your Sui account:`);
    const errors = [
      await refusal(issue(marker)),
      await refusal(complete(markedMessage, await sign(owner, markedMessage))),
      await refusal(complete(markedHost, await sign(owner, markedHost))),
      await refusal(complete(message, marker)),
      await refusal(complete(message, toBase64(new TextEncoder().encode(marker)))),
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
      for (const secret of [marker, message, signature, result.sessionToken, agent.token]) {
        expect(text).not.toContain(secret);
      }
      expect(error.cause).toBeUndefined();
    }
  });
});
