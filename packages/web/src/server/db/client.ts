import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from '@neondatabase/serverless';
import { is } from 'drizzle-orm';
import { NeonDatabase, drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { migrate as migrateNeon } from 'drizzle-orm/neon-serverless/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { PgliteDatabase, drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema.js';

/** One type for both drivers, so the code above this layer never knows which it is on. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Opens the database a DATABASE_URL names.
 * - 'pglite:memory' is a fresh in-memory database; 'pglite:<path>' is a file database at
 *   that path. Both run in this process and serve one connection at a time.
 * - 'postgres://' and 'postgresql://' URLs go through the Neon driver's WebSocket Pool,
 *   not its HTTP mode, because HTTP mode cannot hold an interactive transaction and so
 *   cannot take a row lock with SELECT ... FOR UPDATE. Node 22 and later supply the
 *   WebSocket the driver uses.
 * Throws for any other URL. The message never repeats the URL, which can hold a password.
 */
export async function createDb(url: string): Promise<{ db: Database; close(): Promise<void> }> {
  if (url.startsWith('pglite:')) {
    const location = url.slice('pglite:'.length);
    if (location === '') throw new Error('Unsupported database URL: pglite: needs "memory" or a path');
    const client = location === 'memory' ? await PGlite.create() : await PGlite.create(location);
    const db = drizzlePglite({ client, schema });
    return { db, close: () => client.close() };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new Pool({ connectionString: url });
    const db = drizzleNeon({ client: pool, schema });
    return { db, close: () => pool.end() };
  }
  throw new Error('Unsupported database URL: expected postgres://, postgresql:// or pglite:');
}

/**
 * Applies every migration in the migrations folder that the database has not had yet,
 * recording each in drizzle's own migrations table, so running it again is harmless.
 * Throws for a database that createDb did not make.
 */
export async function migrate(db: Database): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (is(db, PgliteDatabase)) return migratePglite(db, config);
  if (is(db, NeonDatabase)) return migrateNeon(db, config);
  throw new Error('migrate needs a database opened by createDb');
}
