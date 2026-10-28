// Applies Ellai's database migrations to the Postgres database DATABASE_URL names (Neon for the
// live site), through the same Neon WebSocket Pool and drizzle migrator the server's context uses,
// then prints each migration the database now records that it did not before. Running it again
// applies nothing. Run from the repo root, which loads the root .env:
//   npm run db:migrate -w packages/web
// A pglite: URL is refused: the dev server migrates a local database itself on first use. The URL
// is never printed, since it carries the database password, and neither is any error text, since
// a driver's message can name the host.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { type NeonDatabase, drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { z } from 'zod';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../src/server/db/migrations', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../src/server/db/migrations/meta/_journal.json', import.meta.url));

/** A refusal written by this script. Its message is fixed text only. */
class MigrateError extends Error {}

const journalSchema = z.object({
  entries: z.array(z.object({ when: z.number().int().positive(), tag: z.string().regex(/^[0-9a-z_]+$/) })).min(1),
});

// The same rule env.ts applies in production, repeated because importing env.ts would demand every
// other server variable as well.
function targetUrl(value: string | undefined): string {
  if (value === undefined || value === '') throw new MigrateError('DATABASE_URL is not set. Put the Neon connection string in the root .env first.');
  if (value.startsWith('pglite:')) throw new MigrateError('DATABASE_URL is a pglite: database. This script is for the live Postgres database; the dev server migrates pglite: itself.');
  if (!URL.canParse(value)) throw new MigrateError('DATABASE_URL is not a URL.');
  const url = new URL(value);
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hostname === '') {
    throw new MigrateError('DATABASE_URL must be a postgres:// or postgresql:// URL with a host.');
  }
  return value;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new MigrateError('the database answered in a shape this script does not know');
  return rows as Array<Record<string, unknown>>;
}

/** The created_at of every migration drizzle has recorded, oldest first; empty when it has recorded none. */
async function recorded(db: NeonDatabase): Promise<number[]> {
  const [present] = rowsOf(await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`));
  if (present?.present !== true) return [];
  const rows = rowsOf(await db.execute(sql`select created_at::text as at from drizzle.__drizzle_migrations order by created_at`));
  return rows.map((row) => Number(row.at));
}

function failureLabel(error: unknown): string {
  if (error instanceof MigrateError) return error.message;
  // Only a short code is shown: a driver's message can carry the host, and a query error carries its SQL.
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    // The Neon driver reports a connection it could not open as a bare WebSocket error event.
    if (candidate instanceof Event) return 'could not connect to the database. Check that DATABASE_URL is the Neon connection string.';
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(code)) return `database error, code ${code}`;
  }
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

async function main(): Promise<void> {
  const url = targetUrl(process.env.DATABASE_URL);
  const journal = journalSchema.parse(JSON.parse(readFileSync(JOURNAL, 'utf8')));
  const tagAt = new Map(journal.entries.map((entry) => [entry.when, entry.tag]));
  const newest = journal.entries.at(-1)?.when;

  const pool = new Pool({ connectionString: url });
  pool.on('error', () => {
    console.error('[ellai migrate] pool_error');
  });
  try {
    const db = drizzle({ client: pool });
    const before = await recorded(db);
    console.log(`Ellai migrations: ${journal.entries.length} in the repo, ${before.length} recorded in the database before this run.`);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = await recorded(db);
    const applied = after.filter((at) => !before.includes(at));
    for (const at of applied) console.log(`  applied ${tagAt.get(at) ?? `a migration this repo does not know (created_at ${at})`}`);
    if (applied.length === 0) console.log('  nothing to apply: the database already had every migration');
    if (after.at(-1) !== newest) throw new MigrateError('after migrating, the newest migration the database records is not the newest in the repo');
    console.log(`\nDONE: the database records ${after.length} migrations, the newest ${tagAt.get(newest ?? 0) ?? 'unknown'}.`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
