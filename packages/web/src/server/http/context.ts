import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { type BeforeTatumRequest, type Chain, createChain } from '@ellai/core/chain';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { ServerEnv } from '../env.js';
import { readBearer, requireAgent, respondToAgent } from './agent-auth.js';
import { clientKey } from './client.js';
import { HttpError, respond } from './errors.js';
import { requireSameOrigin } from './origin.js';
import { requireOwner } from './session.js';
import { tatumMeter, withTatumScope } from './tatum-meter.js';

/** Everything a route handler works with. */
export interface ServerContext {
  readonly db: Database;
  readonly chain: Chain;
  readonly env: ServerEnv;
  readonly now: () => Date;
}

/** A context as a factory makes it, with a close for anything opened for this one request. */
export type FactoryContext = ServerContext & { close?: () => Promise<void> };
export type ServerContextFactory = () => Promise<FactoryContext>;

interface Shared {
  chain?: Chain;
  localDb?: Promise<Database>;
  openMeters?: AsyncLocalStorage<BeforeTatumRequest>;
}

// Kept on globalThis, not in module scope, because the Next dev server can load this module
// more than once, and two copies would mean two in-memory databases that disagree.
const SHARED_KEY = '__ellaiServerShared';

function shared(): Shared {
  const holder = globalThis as unknown as Record<string, Shared | undefined>;
  holder[SHARED_KEY] ??= {};
  return holder[SHARED_KEY];
}

const systemClock = (): Date => new Date();

function openMeters(): AsyncLocalStorage<BeforeTatumRequest> {
  const store = shared();
  store.openMeters ??= new AsyncLocalStorage<BeforeTatumRequest>();
  return store.openMeters;
}

// The chain is one per process but each request has a database of its own (a Neon pool per
// request), so a Tatum request is counted by the meter of the request it runs inside. Outside any
// request there is nowhere to count it, so it is refused.
const meterOfOpenRequest: BeforeTatumRequest = (call) => {
  const meter = openMeters().getStore();
  if (meter === undefined) {
    console.error('[ellai tatum] no_request');
    throw new Error('no request is open to count this Tatum request in');
  }
  return meter(call);
};

function sharedChain(env: ServerEnv): Chain {
  const store = shared();
  store.chain ??= createChain({ apiKey: env.TATUM_API_KEY, beforeRequest: meterOfOpenRequest });
  return store.chain;
}

// db/client.ts finds its migrations through import.meta.url, which a bundler cannot follow
// to a folder and which points inside the build output once bundled. A route handler runs
// with the Next project as its working directory, so the folder is found from there.
const MIGRATIONS_FOLDER = join(process.cwd(), 'src', 'server', 'db', 'migrations');

// The same rules as createDb's pglite branch, repeated here so route code never loads
// db/client.ts. A database inside one server process would lose every payment record on a
// restart, so this refuses to run in production.
async function openLocalDatabase(url: string): Promise<Database> {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    throw new Error('Unsupported database URL: pglite: is for development and tests, not production');
  }
  const location = url.slice('pglite:'.length);
  if (location === '') throw new Error('Unsupported database URL: pglite: needs "memory" or a path');
  const client = location === 'memory' ? await PGlite.create() : await PGlite.create(location);
  const db = drizzlePglite({ client, schema });
  try {
    await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return db;
}

// PGlite serves one process, so it is opened and migrated once and then reused.
function sharedLocalDatabase(url: string): Promise<Database> {
  const store = shared();
  if (store.localDb !== undefined) return store.localDb;
  const opening = openLocalDatabase(url);
  store.localDb = opening;
  // A failed open is forgotten, so the next request tries again instead of failing forever.
  opening.catch(() => {
    if (store.localDb === opening) store.localDb = undefined;
  });
  return opening;
}

// One Pool per request, ended when the request ends: a serverless instance can freeze between
// requests, and a pool kept across that freeze holds sockets the database has long closed.
function requestPool(url: string): { db: Database; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: url });
  // Without a listener, a connection dropping while idle would crash the server. The error's
  // text can name the database host, so only a fixed code is recorded.
  pool.on('error', () => {
    console.error('[ellai db] pool_error');
  });
  return { db: drizzleNeon({ client: pool, schema }), close: () => pool.end() };
}

async function openDefault(): Promise<FactoryContext> {
  // Loaded here rather than at the top: env.ts checks process.env the moment it loads, and
  // next build loads every route module without the server's secrets.
  const { serverEnv: env } = await import('../env.js');
  const chain = sharedChain(env);
  if (env.DATABASE_URL.startsWith('pglite:')) return { db: await sharedLocalDatabase(env.DATABASE_URL), chain, env, now: systemClock };
  return { ...requestPool(env.DATABASE_URL), chain, env, now: systemClock };
}

let factory: ServerContextFactory | null = null;

/**
 * Replaces how contexts are made, so tests can hand the real handlers a PGlite database, a
 * stub chain, a fixed env and a fixed clock. Null restores the default, which reads env.ts.
 */
export function setServerContextFactory(next: ServerContextFactory | null): void {
  factory = next;
}

/**
 * Opens a context for one request. With a postgres DATABASE_URL that is a new Neon Pool,
 * which the caller must end with close(); withServerContext does this. With a pglite: URL it
 * is the one process-wide database, migrated once, and close() does nothing. The chain is
 * one process-wide client with the env's Tatum key, whose every request to Tatum is counted by
 * the meter of the withServerContext it runs inside and refused outside one. Throws when the
 * environment is invalid or the database cannot be opened.
 */
export async function getServerContext(): Promise<ServerContext & { close: () => Promise<void> }> {
  const opened = await (factory ?? openDefault)();
  return { db: opened.db, chain: opened.chain, env: opened.env, now: opened.now, close: opened.close ?? (async () => undefined) };
}

/**
 * Runs `run` with a fresh context and always closes it afterwards, whether `run` returned or
 * threw. Every request the default chain sends to Tatum while `run` runs is counted in this
 * context's database by tatumMeter, against the Tatum scope that request runs in (C22). A
 * failure to close is recorded as a fixed code and never replaces run's own result.
 */
export async function withServerContext<T>(run: (ctx: ServerContext) => Promise<T>): Promise<T> {
  const { close, ...ctx } = await getServerContext();
  try {
    return await openMeters().run(tatumMeter(ctx.db, ctx.now), () => run(ctx));
  } finally {
    try {
      await close();
    } catch {
      console.error('[ellai db] close_failed');
    }
  }
}

/** Who may call a route. It decides how scoped() authenticates the request and which Tatum scope the route's work runs in. */
export type RouteCaller = 'anyone' | 'owner' | 'agent' | 'jobs';

type SessionOwner = Awaited<ReturnType<typeof requireOwner>>;
type AgentCaller = Awaited<ReturnType<typeof requireAgent>>;
type RouteHandler<Rest extends unknown[]> = (request: Request, ...rest: Rest) => Promise<Response>;

// RFC 9110 section 9.2.1: these methods change nothing, so an owner may read from wherever its cookie is sent.
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

// timingSafeEqual takes the same time whatever the bytes, but only for buffers of one length,
// so a value of another length is refused before any comparison. That says only that the
// length was wrong, and the secret is at least 64 hex characters, so its length is no help.
function isJobsSecret(sent: string | undefined, expected: string): boolean {
  if (sent === undefined) return false;
  const sentBytes = Buffer.from(sent, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return sentBytes.length === expectedBytes.length && timingSafeEqual(sentBytes, expectedBytes);
}

const scopedHandlers = new WeakSet<object>();

/** Whether `handler` was made by scoped(), so a test can hold every route handler to it. */
export function isScoped(handler: unknown): boolean {
  return typeof handler === 'function' && scopedHandlers.has(handler);
}

/**
 * Makes a route handler whose work can reach Tatum only inside the Tatum scope of whoever called
 * it, so tatumMeter charges every request to that caller (C22, C34). Authentication runs before
 * the scope is entered and reads only the database; a Tatum request made there would be refused.
 * - 'anyone': nothing is checked. The handler runs as a person keyed on the request's client
 *   (clientKey) and opens its own context and answers its own errors, since /api/public/proof
 *   must not open a database on every request. What it returns is passed back unchanged.
 * - 'owner': errors are answered by respond and a context is opened. A request whose method can
 *   change anything (not GET, HEAD or OPTIONS) must come from the app (requireSameOrigin, C14),
 *   checked before the session is read. The owner comes from the session cookie alone
 *   (requireOwner, C13). The handler gets the context and the owner, and runs as a person with
 *   the request's client key and that owner.
 * - 'agent': errors are answered by respondToAgent and a context is opened. The agent and its
 *   owner come from the bearer token alone (requireAgent, C13). The handler gets the context and
 *   the agent, and runs as a person with the request's client key and the agent's owner.
 * - 'jobs': errors are answered by respond and a context is opened. Anything but exactly
 *   `Authorization: Bearer <JOBS_SECRET>`, compared in constant time, is 401 jobs_unauthorized
 *   and nothing runs. The handler gets the context and runs in the jobs scope.
 * Any further arguments Next passes, such as a dynamic route's params, follow on unchanged.
 */
export function scoped<Args extends unknown[], Result>(caller: 'anyone', handler: (...args: Args) => Result): (...args: Args) => Result;
export function scoped<Rest extends unknown[]>(caller: 'owner', handler: (request: Request, ctx: ServerContext, owner: SessionOwner, ...rest: Rest) => Promise<Response>): RouteHandler<Rest>;
export function scoped<Rest extends unknown[]>(caller: 'agent', handler: (request: Request, ctx: ServerContext, agent: AgentCaller, ...rest: Rest) => Promise<Response>): RouteHandler<Rest>;
export function scoped<Rest extends unknown[]>(caller: 'jobs', handler: (request: Request, ctx: ServerContext, ...rest: Rest) => Promise<Response>): RouteHandler<Rest>;
export function scoped(caller: RouteCaller, handler: (...args: never[]) => unknown): (...args: never[]) => unknown {
  const run = handler as unknown as (...args: unknown[]) => unknown;
  const answered = (...args: unknown[]): Promise<Response> => run(...args) as Promise<Response>;
  let wrapped: (request: Request, ...rest: unknown[]) => unknown;
  switch (caller) {
    case 'anyone':
      wrapped = (...args: unknown[]) => withTatumScope({ kind: 'person', clientKey: clientKey(args[0] instanceof Request ? args[0] : undefined) }, () => run(...args));
      break;
    case 'owner':
      wrapped = (request, ...rest) =>
        respond(() =>
          withServerContext(async (ctx) => {
            if (!SAFE_METHODS.has(request.method)) requireSameOrigin(request, ctx.env.APP_ORIGIN);
            const owner = await requireOwner(request, ctx);
            return withTatumScope({ kind: 'person', clientKey: clientKey(request), ownerId: owner.ownerId }, () => answered(request, ctx, owner, ...rest));
          }),
        );
      break;
    case 'agent':
      wrapped = (request, ...rest) =>
        respondToAgent(() =>
          withServerContext(async (ctx) => {
            const agent = await requireAgent(request, ctx);
            return withTatumScope({ kind: 'person', clientKey: clientKey(request), ownerId: agent.ownerId }, () => answered(request, ctx, agent, ...rest));
          }),
        );
      break;
    case 'jobs':
      wrapped = (request, ...rest) =>
        respond(() =>
          withServerContext(async (ctx) => {
            if (!isJobsSecret(readBearer(request), ctx.env.JOBS_SECRET)) throw new HttpError(401, 'jobs_unauthorized');
            return withTatumScope({ kind: 'jobs' }, () => answered(request, ctx, ...rest));
          }),
        );
      break;
  }
  scopedHandlers.add(wrapped);
  return wrapped as (...args: never[]) => unknown;
}
