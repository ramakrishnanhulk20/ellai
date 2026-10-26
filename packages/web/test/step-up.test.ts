// Covers: the fresh wallet signature every loosening change needs (C36), on PGlite with real
// Ed25519 and Secp256k1 keys, through the step-up, agents and settings routes as Next calls them:
// each loosening settings field needing a step-up and each tightening one not, a cutoff sent as
// stored counting as no change, a new agent key always needing one; a valid step-up applying
// exactly its change once whatever order its fields arrive in; a replay, a step-up for another
// change (one field different, or the other action), another owner's, an expired one and a bad
// signature each refused with the one fixed 401, every one after the claim leaving the nonce spent
// and nothing applied, another owner's leaving it untouched for its owner; a zkLogin owner checked
// through the context chain's gRPC client inside that owner's Tatum scope; the step-up route's body
// checks and its hourly limit, counted before the body is read; the exact message for a settings
// change and for an agent key; and the change hash naming one change for one owner.
// Does NOT cover: a real chain or wallet (zkLogin goes through a stub client and no real proof is
// made), multisig or Secp256r1 signers (auth.test runs them through the same check at sign-in), two
// database connections racing for one nonce (PGlite serves one connection), the session and origin
// requirements of these routes (routes-account), or pruning expired step-ups (jobs.test).
import { createHash, randomBytes } from 'node:crypto';
import type { Chain } from '@ellai/core/chain';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { computeZkLoginAddressFromSeed, getZkLoginSignature } from '@mysten/sui/zklogin';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentsRoute from '../src/app/api/owner/agents/route.js';
import * as settingsRoute from '../src/app/api/owner/settings/route.js';
import * as stepUpRoute from '../src/app/api/owner/step-up/route.js';
import { completeSignIn, issueSignIn } from '../src/server/auth/signin.js';
import { stepUpChangeHash } from '../src/server/auth/stepup.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { agents, owners, stepUps } from '../src/server/db/schema.js';
import type { ServerEnv } from '../src/server/env.js';
import { setServerContextFactory } from '../src/server/http/context.js';
import { HttpError } from '../src/server/http/errors.js';
import { type TatumScope, currentTatumScope } from '../src/server/http/tatum-meter.js';

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const APP_ORIGIN = 'https://ellai.example';
const SECRET = hex(32);
const MASTER = hex(32);
const ENV: ServerEnv = {
  DATABASE_URL: 'pglite:memory',
  ELLAI_MASTER_SECRET: MASTER,
  GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  SESSION_SECRET: SECRET,
  JOBS_SECRET: hex(32),
  APP_ORIGIN,
};
const HOUR_MS = 3_600_000;
const AUTO_PAUSE = 'A payment landed that was not the one approved.';

const FIRST_MINUTE = Date.parse('2026-10-26T10:00:00.000Z');
let minutesUsed = 0;
let clock = new Date(FIRST_MINUTE);

// What Sui says about a zkLogin proof, and the Tatum scope each check ran in.
let zkLoginAccepted = true;
let zkLoginScopes: Array<TatumScope | undefined> = [];
const grpc = {
  core: {
    verifyZkLoginSignature: async () => {
      zkLoginScopes.push(currentTatumScope());
      return { success: zkLoginAccepted, errors: [] };
    },
  },
};
const chain = { usesApiKey: true, grpc } as unknown as Chain;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  setServerContextFactory(null);
  await handle.close();
});

beforeEach(() => {
  minutesUsed += 1;
  clock = new Date(FIRST_MINUTE + minutesUsed * 60_000 + 1_000);
  setServerContextFactory(async () => ({ db, chain, env: ENV, now: () => clock }));
  zkLoginAccepted = true;
  zkLoginScopes = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

function quiet(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

async function sign(signer: Signer, message: string): Promise<string> {
  return (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
}

interface Owner {
  ownerId: string;
  cookie: string;
}

interface KeyOwner extends Owner {
  signer: Signer;
}

async function signedInOwner(signer: Signer = Ed25519Keypair.generate()): Promise<KeyOwner> {
  const { message } = await issueSignIn({ db, address: signer.toSuiAddress(), appOrigin: APP_ORIGIN, now: clock });
  const done = await completeSignIn({ db, message, signature: await sign(signer, message), appOrigin: APP_ORIGIN, masterSecretHex: MASTER, sessionSecretHex: SECRET, now: clock });
  return { ownerId: done.ownerId, cookie: `__Host-ellai_session=${done.sessionToken}`, signer };
}

function send(method: string, path: string, body: unknown, owner: Owner): Request {
  return new Request(`${APP_ORIGIN}${path}`, { method, headers: { origin: APP_ORIGIN, cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const askStepUp = (owner: Owner, body: unknown) => stepUpRoute.POST(send('POST', '/api/owner/step-up', body, owner));
const patchSettings = (owner: Owner, body: unknown) => settingsRoute.PATCH(send('PATCH', '/api/owner/settings', body, owner));
const createAgent = (owner: Owner, body: unknown) => agentsRoute.POST(send('POST', '/api/owner/agents', body, owner));

interface Issued {
  nonce: string;
  message: string;
  expiresAt: string;
}

async function issued(owner: Owner, action: string, change: Record<string, unknown>): Promise<Issued> {
  const response = await askStepUp(owner, { action, change });
  expect(response.status).toBe(200);
  return (await response.json()) as Issued;
}

/** Asks for a step-up for this change and signs its message with the owner's wallet, as the app does. */
async function signed(owner: KeyOwner, action: string, change: Record<string, unknown>): Promise<{ nonce: string; signature: string }> {
  const { nonce, message } = await issued(owner, action, change);
  return { nonce, signature: await sign(owner.signer, message) };
}

async function refusedWith(response: Response, status: number, code: string): Promise<void> {
  expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, code]);
}

// Every refusal of a step-up reads the same, whatever check it failed.
async function rejected(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'step_up_rejected', message: new HttpError(401, 'step_up_rejected').message });
}

async function settingsOf(ownerId: string) {
  return one(
    await db
      .select({
        paused: owners.paused,
        autoPausedReason: owners.autoPausedReason,
        perPaymentMaxAtomic: owners.perPaymentMaxAtomic,
        dailyBudgetAtomic: owners.dailyBudgetAtomic,
        approvalsNeeded: owners.approvalsNeeded,
        distanceCutoff: owners.distanceCutoff,
        publicProof: owners.publicProof,
      })
      .from(owners)
      .where(eq(owners.id, ownerId)),
  );
}

const usedAt = async (nonce: string) => one(await db.select({ usedAt: stepUps.usedAt }).from(stepUps).where(eq(stepUps.nonce, nonce))).usedAt;
const stepUpsOf = async (ownerId: string) => db.select().from(stepUps).where(eq(stepUps.ownerId, ownerId));
const agentLabels = async (ownerId: string) => (await db.select({ label: agents.label }).from(agents).where(eq(agents.ownerId, ownerId)).orderBy(asc(agents.createdAt))).map((row) => row.label);

type Setup = Partial<typeof owners.$inferInsert>;
type Stored = Partial<Awaited<ReturnType<typeof settingsOf>>>;

describe('which changes need a step-up', () => {
  const loosening: Array<[string, Setup, Record<string, unknown>, Stored]> = [
    ['raising the per-payment maximum', {}, { perPaymentMaxAtomic: '60000' }, { perPaymentMaxAtomic: 60_000n }],
    ['raising the daily budget', {}, { dailyBudgetAtomic: '600000' }, { dailyBudgetAtomic: 600_000n }],
    ['lowering approvals needed', {}, { approvalsNeeded: 1 }, { approvalsNeeded: 1 }],
    ['raising the distance cutoff', {}, { distanceCutoff: 0.6 }, { distanceCutoff: 0.6 }],
    ['unpausing a paused owner', { paused: true }, { paused: false }, { paused: false }],
    ['clearing an automatic pause that is set', { autoPausedReason: AUTO_PAUSE }, { clearAutoPause: true }, { autoPausedReason: null }],
    ['turning the public proof page on', {}, { publicProof: true }, { publicProof: true }],
    ['a tightening change carrying one loosening field', {}, { approvalsNeeded: 3, publicProof: true }, { approvalsNeeded: 3, publicProof: true }],
  ];

  it.each(loosening)('%s: 403 step_up_required without one, nothing changed; applied with one', async (_name, setup, change, after) => {
    quiet();
    const owner = await signedInOwner();
    if (Object.keys(setup).length > 0) await db.update(owners).set(setup).where(eq(owners.id, owner.ownerId));
    const before = await settingsOf(owner.ownerId);
    await refusedWith(await patchSettings(owner, change), 403, 'step_up_required');
    expect(await settingsOf(owner.ownerId)).toEqual(before);
    expect((await patchSettings(owner, { ...change, stepUp: await signed(owner, 'loosen_settings', change) })).status).toBe(200);
    expect(await settingsOf(owner.ownerId)).toEqual({ ...before, ...after });
  });

  const tightening: Array<[string, Setup, Record<string, unknown>, Stored]> = [
    ['lowering the per-payment maximum', {}, { perPaymentMaxAtomic: '40000' }, { perPaymentMaxAtomic: 40_000n }],
    ['lowering the daily budget', {}, { dailyBudgetAtomic: '400000' }, { dailyBudgetAtomic: 400_000n }],
    ['raising approvals needed', {}, { approvalsNeeded: 3 }, { approvalsNeeded: 3 }],
    ['lowering the distance cutoff', {}, { distanceCutoff: 0.4 }, { distanceCutoff: 0.4 }],
    // The column holds 0.3 as a 32-bit float, so both sides are compared in that form.
    ['sending the distance cutoff already stored', { distanceCutoff: 0.3 }, { distanceCutoff: 0.3 }, {}],
    ['pausing', {}, { paused: true }, { paused: true }],
    ['unpausing an owner who is not paused', {}, { paused: false }, {}],
    ['clearing an automatic pause that is not set', {}, { clearAutoPause: true }, {}],
    ['turning the public proof page off', { publicProof: true }, { publicProof: false }, { publicProof: false }],
    ['turning on a public proof page that is already on', { publicProof: true }, { publicProof: true }, {}],
  ];

  it.each(tightening)('%s: applied on its own, and the step-up route will not issue one for it', async (_name, setup, change, after) => {
    quiet();
    const owner = await signedInOwner();
    if (Object.keys(setup).length > 0) await db.update(owners).set(setup).where(eq(owners.id, owner.ownerId));
    const before = await settingsOf(owner.ownerId);
    await refusedWith(await askStepUp(owner, { action: 'loosen_settings', change }), 400, 'step_up_not_needed');
    expect(await stepUpsOf(owner.ownerId)).toEqual([]);
    expect((await patchSettings(owner, change)).status).toBe(200);
    expect(await settingsOf(owner.ownerId)).toEqual({ ...before, ...after });
  });

  it('a new agent key always needs one, and its label is checked before one is asked for or spent', async () => {
    quiet();
    const owner = await signedInOwner();
    await refusedWith(await createAgent(owner, { label: 'Trip planner' }), 403, 'step_up_required');
    await refusedWith(await createAgent(owner, { label: 'bell\u0007' }), 400, 'bad_input');
    await refusedWith(await askStepUp(owner, { action: 'create_agent', change: { label: '   ' } }), 400, 'bad_input');
    await refusedWith(await askStepUp(owner, { action: 'create_agent', change: { label: 'x'.repeat(61) } }), 400, 'bad_input');
    expect(await stepUpsOf(owner.ownerId)).toEqual([]);
    expect(await agentLabels(owner.ownerId)).toEqual([]);
  });
});

describe('a step-up', () => {
  it('applies exactly the change it names, once, whatever order its fields arrive in, and refuses a replay', async () => {
    quiet();
    const owner = await signedInOwner();
    const stepUp = await signed(owner, 'loosen_settings', { dailyBudgetAtomic: '2000000', approvalsNeeded: 1 });
    const applied = await patchSettings(owner, { approvalsNeeded: 1, dailyBudgetAtomic: '2000000', stepUp });
    expect(await applied.json()).toMatchObject({ dailyBudgetAtomic: '2000000', approvalsNeeded: 1, perPaymentMaxAtomic: '50000', publicProof: false });
    expect(await usedAt(stepUp.nonce)).toEqual(clock);
    // Tightened again, so a replay would loosen.
    expect((await patchSettings(owner, { dailyBudgetAtomic: '500000', approvalsNeeded: 2 })).status).toBe(200);
    await rejected(await patchSettings(owner, { dailyBudgetAtomic: '2000000', approvalsNeeded: 1, stepUp }));
    expect(await settingsOf(owner.ownerId)).toMatchObject({ dailyBudgetAtomic: 500_000n, approvalsNeeded: 2 });

    const agentStepUp = await signed(owner, 'create_agent', { label: 'Trip planner' });
    expect((await createAgent(owner, { label: '  Trip planner ', stepUp: agentStepUp })).status).toBe(200);
    await rejected(await createAgent(owner, { label: 'Trip planner', stepUp: agentStepUp }));
    expect(await agentLabels(owner.ownerId)).toEqual(['Trip planner']);
  });

  it('issued for one change refuses a change with any one field different, or the other action, and is spent by the try', async () => {
    quiet();
    const owner = await signedInOwner();
    const before = await settingsOf(owner.ownerId);
    const change = { perPaymentMaxAtomic: '100000', dailyBudgetAtomic: '1000000' };
    for (const different of [
      { perPaymentMaxAtomic: '100001', dailyBudgetAtomic: '1000000' },
      { perPaymentMaxAtomic: '100000', dailyBudgetAtomic: '1000000', publicProof: true },
      { perPaymentMaxAtomic: '100000' },
    ]) {
      const stepUp = await signed(owner, 'loosen_settings', change);
      await rejected(await patchSettings(owner, { ...different, stepUp }));
      expect(await usedAt(stepUp.nonce)).toEqual(clock);
      await rejected(await patchSettings(owner, { ...change, stepUp }));
    }
    expect(await settingsOf(owner.ownerId)).toEqual(before);

    const forAgent = await signed(owner, 'create_agent', { label: 'Trip planner' });
    await rejected(await createAgent(owner, { label: 'Trip planner 2', stepUp: forAgent }));
    const forSettings = await signed(owner, 'loosen_settings', { publicProof: true });
    await rejected(await createAgent(owner, { label: 'Trip planner', stepUp: forSettings }));
    await rejected(await patchSettings(owner, { publicProof: true, stepUp: forSettings }));
    expect(await agentLabels(owner.ownerId)).toEqual([]);
    expect(await settingsOf(owner.ownerId)).toEqual(before);
  });

  it("is refused for another owner's session and left unused for its own owner", async () => {
    quiet();
    const owner = await signedInOwner();
    const thief = await signedInOwner();
    const stepUp = await signed(owner, 'loosen_settings', { publicProof: true });
    await rejected(await patchSettings(thief, { publicProof: true, stepUp }));
    const agentStepUp = await signed(owner, 'create_agent', { label: 'Trip planner' });
    await rejected(await createAgent(thief, { label: 'Trip planner', stepUp: agentStepUp }));
    expect([(await settingsOf(thief.ownerId)).publicProof, await agentLabels(thief.ownerId)]).toEqual([false, []]);
    expect([await usedAt(stepUp.nonce), await usedAt(agentStepUp.nonce)]).toEqual([null, null]);

    expect((await patchSettings(owner, { publicProof: true, stepUp })).status).toBe(200);
    expect((await createAgent(owner, { label: 'Trip planner', stepUp: agentStepUp })).status).toBe(200);
  });

  it('is refused from the moment it expires, LIMITS.stepUpTtlMs after it was issued', async () => {
    quiet();
    const owner = await signedInOwner();
    const lastMoment = await signed(owner, 'loosen_settings', { publicProof: true });
    const expired = await signed(owner, 'create_agent', { label: 'Trip planner' });
    const issuedAt = clock;
    clock = new Date(issuedAt.getTime() + LIMITS.stepUpTtlMs);
    await rejected(await createAgent(owner, { label: 'Trip planner', stepUp: expired }));
    expect(await agentLabels(owner.ownerId)).toEqual([]);
    clock = new Date(issuedAt.getTime() + LIMITS.stepUpTtlMs - 1);
    expect((await patchSettings(owner, { publicProof: true, stepUp: lastMoment })).status).toBe(200);
  });

  it('with a bad signature is refused, spends the nonce, and applies nothing', async () => {
    quiet();
    const owner = await signedInOwner();
    const before = await settingsOf(owner.ownerId);
    const change = { perPaymentMaxAtomic: '100000' };
    const badSignatures: Array<(message: string) => Promise<string>> = [
      (message) => sign(Ed25519Keypair.generate(), message),
      (message) => sign(owner.signer, message.replace('Per-payment maximum: 0.10 USDC', 'Per-payment maximum: 0.01 USDC')),
      async () => 'AAAA',
    ];
    for (const badSignature of badSignatures) {
      const { nonce, message } = await issued(owner, 'loosen_settings', change);
      await rejected(await patchSettings(owner, { ...change, stepUp: { nonce, signature: await badSignature(message) } }));
      expect(await usedAt(nonce)).toEqual(clock);
      await rejected(await patchSettings(owner, { ...change, stepUp: { nonce, signature: await sign(owner.signer, message) } }));
    }
    expect(await settingsOf(owner.ownerId)).toEqual(before);
  });

  it('from a Secp256k1 wallet goes through the same check', async () => {
    const owner = await signedInOwner(Secp256k1Keypair.generate());
    expect((await patchSettings(owner, { publicProof: true, stepUp: await signed(owner, 'loosen_settings', { publicProof: true }) })).status).toBe(200);
    expect((await createAgent(owner, { label: 'Trip planner', stepUp: await signed(owner, 'create_agent', { label: 'Trip planner' }) })).status).toBe(200);
    expect([(await settingsOf(owner.ownerId)).publicProof, await agentLabels(owner.ownerId)]).toEqual([true, ['Trip planner']]);
  });

  it("from a zkLogin owner is checked through the context chain's gRPC client inside that owner's Tatum scope, and refused when Sui does not accept it", async () => {
    quiet();
    const seed = '13322897930163218532266430409510394316985274769125667290600321564259466511711';
    const address = canonicalSuiAddress(computeZkLoginAddressFromSeed(BigInt(seed), 'https://accounts.google.com', false));
    const zkLoginSignature = async (message: string) =>
      getZkLoginSignature({
        inputs: {
          proofPoints: { a: ['1', '2', '1'], b: [['1', '0'], ['3', '4'], ['1', '0']], c: ['5', '6', '1'] },
          issBase64Details: { value: 'yJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLC', indexMod4: 1 },
          headerBase64: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ',
          addressSeed: seed,
        },
        maxEpoch: '10',
        userSignature: await sign(Ed25519Keypair.generate(), message),
      });
    const signIn = await issueSignIn({ db, address, appOrigin: APP_ORIGIN, now: clock });
    const done = await completeSignIn({
      db,
      message: signIn.message,
      signature: await zkLoginSignature(signIn.message),
      appOrigin: APP_ORIGIN,
      masterSecretHex: MASTER,
      sessionSecretHex: SECRET,
      now: clock,
      zkLoginClient: grpc as unknown as ClientWithCoreApi,
      clientKey: 'step-up-test',
    });
    const owner: Owner = { ownerId: done.ownerId, cookie: `__Host-ellai_session=${done.sessionToken}` };
    zkLoginScopes = [];

    const settings = await issued(owner, 'loosen_settings', { publicProof: true });
    expect((await patchSettings(owner, { publicProof: true, stepUp: { nonce: settings.nonce, signature: await zkLoginSignature(settings.message) } })).status).toBe(200);
    expect(zkLoginScopes).toEqual([{ kind: 'person', clientKey: expect.any(String), ownerId: owner.ownerId }]);

    zkLoginAccepted = false;
    const agent = await issued(owner, 'create_agent', { label: 'Trip planner' });
    await rejected(await createAgent(owner, { label: 'Trip planner', stepUp: { nonce: agent.nonce, signature: await zkLoginSignature(agent.message) } }));
    expect(zkLoginScopes).toHaveLength(2);
    expect(await usedAt(agent.nonce)).toEqual(clock);
    expect(await agentLabels(owner.ownerId)).toEqual([]);
  });
});

describe('POST /api/owner/step-up', () => {
  it('writes the message from the checked change alone, one line per field in a fixed order, and stores exactly that message and the hash of the change', async () => {
    const owner = await signedInOwner();
    const account = canonicalSuiAddress(owner.signer.toSuiAddress());
    await db.update(owners).set({ paused: true, autoPausedReason: AUTO_PAUSE }).where(eq(owners.id, owner.ownerId));
    const change = { publicProof: true, clearAutoPause: true, paused: false, distanceCutoff: 0.6, approvalsNeeded: 1, dailyBudgetAtomic: '2000000', perPaymentMaxAtomic: '15000' };
    const expiresAt = new Date(clock.getTime() + LIMITS.stepUpTtlMs).toISOString();
    const settings = await issued(owner, 'loosen_settings', change);
    expect(settings.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(settings.expiresAt).toBe(expiresAt);
    expect(settings.message).toBe(
      [
        'ellai.example asks you to confirm a change to your Ellai account.',
        '',
        `Account: ${account}`,
        'Per-payment maximum: 0.015 USDC',
        'Daily budget: 2.00 USDC',
        'Approvals needed: 1',
        'Distance cutoff: 0.6',
        'Automatic payments: resumed',
        'Clear automatic pause: yes',
        'Public proof page: on',
        '',
        `Nonce: ${settings.nonce}`,
        `Issued At: ${clock.toISOString()}`,
        `Expiration Time: ${expiresAt}`,
      ].join('\n'),
    );

    // A line separator or a format character inside a label is refused, so it can never start a
    // line of its own in the message or make the label read as other text.
    for (const label of ['Trip\u2028planner', 'Trip\u202eplanner', 'Trip\u200bplanner']) {
      expect((await askStepUp(owner, { action: 'create_agent', change: { label } })).status).toBe(400);
    }
    const agent = await issued(owner, 'create_agent', { label: '  Trip planner  ' });
    expect(agent.message).toBe(
      [
        'ellai.example asks you to confirm a change to your Ellai account.',
        '',
        `Account: ${account}`,
        'Create agent key: Trip planner',
        '',
        `Nonce: ${agent.nonce}`,
        `Issued At: ${clock.toISOString()}`,
        `Expiration Time: ${expiresAt}`,
      ].join('\n'),
    );

    const rows = await stepUpsOf(owner.ownerId);
    expect(rows.map((row) => [row.nonce, row.action, row.message, row.changeHash, row.usedAt]).sort()).toEqual(
      [
        [settings.nonce, 'loosen_settings', settings.message, stepUpChangeHash(owner.ownerId, { action: 'loosen_settings', change: { ...change, dailyBudgetAtomic: 2_000_000n, perPaymentMaxAtomic: 15_000n, clearAutoPause: true } }), null],
        [agent.nonce, 'create_agent', agent.message, stepUpChangeHash(owner.ownerId, { action: 'create_agent', change: { label: 'Trip planner' } }), null],
      ].sort(),
    );
  });

  it('refuses a body it cannot read exactly and a setting outside its bounds, storing nothing', async () => {
    quiet();
    const owner = await signedInOwner();
    for (const body of [
      {},
      { action: 'loosen_settings' },
      { action: 'loosen_settings', change: {} },
      { action: 'loosen_settings', change: { perPaymentMaxAtomic: 60_000 } },
      { action: 'create_agent', change: { label: 'x', kind: 'builtin' } },
      { action: 'create_agent', change: { publicProof: true } },
      { action: 'pay', change: { label: 'x' } },
      { action: 'loosen_settings', change: { publicProof: true }, ownerId: owner.ownerId },
    ]) {
      await refusedWith(await askStepUp(owner, body), 400, 'bad_body');
    }
    const bound = await askStepUp(owner, { action: 'loosen_settings', change: { approvalsNeeded: 0 } });
    expect(await bound.json()).toEqual({ error: 'out_of_bounds', message: 'Approvals needed must be a whole number from 1 to 10.' });
    expect(await stepUpsOf(owner.ownerId)).toEqual([]);
  });

  it('turns away the 21st request in one hour for one owner with 429, counted before the body is read, others and the next hour untouched (C22)', async () => {
    quiet();
    const owner = await signedInOwner();
    const other = await signedInOwner();
    expect(LIMITS.stepUpsPerOwnerPerHour).toBe(20);
    await refusedWith(await askStepUp(owner, {}), 400, 'bad_body');
    for (let i = 2; i <= 20; i += 1) await issued(owner, 'create_agent', { label: `Agent ${i}` });
    const refused = await askStepUp(owner, { action: 'create_agent', change: { label: 'One more' } });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'too_many_step_ups', message: new HttpError(429, 'too_many_step_ups').message });
    expect(await stepUpsOf(owner.ownerId)).toHaveLength(19);

    await issued(other, 'create_agent', { label: 'Theirs' });
    clock = new Date(Math.floor(clock.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    await issued(owner, 'create_agent', { label: 'Next hour' });
  });
});

describe('stepUpChangeHash', () => {
  it('names one change for one owner: the same fields in any order give one hash, any other owner, action or value another', () => {
    const ownerId = '6f1d8a3e-2b4c-4d5e-8f60-718293a4b5c6';
    const change = { dailyBudgetAtomic: 2_000_000n, approvalsNeeded: 1 };
    const hash = stepUpChangeHash(ownerId, { action: 'loosen_settings', change });
    expect(hash).toBe(createHash('sha256').update(`{"action":"loosen_settings","change":{"approvalsNeeded":1,"dailyBudgetAtomic":"2000000"},"ownerId":"${ownerId}"}`, 'utf8').digest('hex'));
    expect(stepUpChangeHash(ownerId, { action: 'loosen_settings', change: { approvalsNeeded: 1, dailyBudgetAtomic: 2_000_000n } })).toBe(hash);
    const others = [
      stepUpChangeHash('0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d', { action: 'loosen_settings', change }),
      stepUpChangeHash(ownerId, { action: 'loosen_settings', change: { ...change, approvalsNeeded: 2 } }),
      stepUpChangeHash(ownerId, { action: 'loosen_settings', change: { ...change, dailyBudgetAtomic: 2_000_001n } }),
      stepUpChangeHash(ownerId, { action: 'loosen_settings', change: { ...change, publicProof: true } }),
      stepUpChangeHash(ownerId, { action: 'create_agent', change: { label: 'Trip planner' } }),
    ];
    expect(new Set([hash, ...others]).size).toBe(others.length + 1);
  });
});
