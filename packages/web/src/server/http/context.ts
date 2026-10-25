import { join } from 'node:path';
import { type Chain, createChain } from '@ellai/core/chain';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { ServerEnv } from '../env.js';

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

function sharedChain(env: ServerEnv): Chain {
  const store = shared();
  store.chain ??= createChain({ apiKey: env.TATUM_API_KEY });
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
 * one process-wide client with the env's Tatum key. Throws when the environment is invalid
 * or the database cannot be opened.
 */
export async function getServerContext(): Promise<ServerContext & { close: () => Promise<void> }> {
  const opened = await (factory ?? openDefault)();
  return { db: opened.db, chain: opened.chain, env: opened.env, now: opened.now, close: opened.close ?? (async () => undefined) };
}

/**
 * Runs `run` with a fresh context and always closes it afterwards, whether `run` returned or
 * threw. A failure to close is recorded as a fixed code and never replaces run's own result.
 */
export async function withServerContext<T>(run: (ctx: ServerContext) => Promise<T>): Promise<T> {
  const { close, ...ctx } = await getServerContext();
  try {
    return await run(ctx);
  } finally {
    try {
      await close();
    } catch {
      console.error('[ellai db] close_failed');
    }
  }
}
