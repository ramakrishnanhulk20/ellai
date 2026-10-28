// Copies Ellai's real records from a local PGlite database (default scratchpad/dev-db) into the
// database DATABASE_URL names, so the live /proof page and memory map show the same owners,
// decisions, memories and payments the proofs made on Sui Mainnet. Run from the repo root, which
// loads the root .env:
//   npm run data:copy -w packages/web -- --dry-run     what would be copied; nothing is written
//   npm run data:copy -w packages/web                  copy, in one transaction
//   npm run data:copy -w packages/web -- --source <folder>
// The target is a migrated Postgres database (run db:migrate first) or, to rehearse, a pglite:
// database, which this script migrates itself. Rows are copied as Postgres renders them, through
// JSON on both sides, so timestamps keep their microseconds and large integers every digit.
// A row whose primary key the target already has is left alone, so running it twice copies
// nothing new. Sign-in sessions, sign-in nonces, step-ups and rate counters are never copied.
// The source folder is never opened in place: PGlite serves one process, and the dev server may
// hold it, so a copy in a temporary folder is read instead. Stop the dev server first for a copy
// that is consistent to the last write. Prints table names and counts only, never a value, a
// token hash or the target URL.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from '@neondatabase/serverless';
import { type SQL, is, sql } from 'drizzle-orm';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { z } from 'zod';
import * as schema from '../src/server/db/schema.js';

const DEFAULT_SOURCE = fileURLToPath(new URL('../../../scratchpad/dev-db', import.meta.url));
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../src/server/db/migrations', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../src/server/db/migrations/meta/_journal.json', import.meta.url));
// Rows per statement. A page of the widest table (memories, sentences up to 1,000 characters) is
// well under a megabyte of JSON, and the page count is fixed by the source count before copying.
const PAGE_ROWS = 200;

// Foreign-key order: every table here only points at tables listed before it, which main()
// checks against the schema before anything is read.
const COPIED = [
  schema.owners,
  schema.agents,
  schema.decisions,
  schema.memories,
  schema.decisionCitations,
  schema.questions,
  schema.grants,
  schema.grantUses,
  schema.payments,
  schema.refills,
  schema.sellerSales,
] as const;
// Sign-in state and short-lived counters: copying them would carry live sessions to a site with
// another SESSION_SECRET and spent nonces nobody needs.
const NEVER_COPIED = [schema.sessions, schema.signinNonces, schema.stepUps, schema.rateCounters] as const;

/** A refusal written by this script. Its message is fixed text and counts only. */
class CopyError extends Error {}

interface Runner {
  execute(query: SQL): PromiseLike<unknown>;
}

interface Opened {
  db: Runner & { transaction<T>(run: (tx: Runner) => Promise<T>): Promise<T> };
  label: string;
  /** Set only for a pglite: target, which starts empty and is migrated by this script. */
  migrate?: () => Promise<void>;
  close(): Promise<void>;
}

interface TablePlan {
  name: string;
  key: string[];
}

interface TableCounts {
  name: string;
  source: number;
  before: number;
  present: number;
  copied: number;
  after: number | null;
}

const journalSchema = z.object({ entries: z.array(z.object({ when: z.number().int().positive() })).min(1) });

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new CopyError('the database answered in a shape this script does not know');
  return rows as Array<Record<string, unknown>>;
}

async function one(runner: Runner, query: SQL): Promise<Record<string, unknown>> {
  const [row] = rowsOf(await runner.execute(query));
  if (row === undefined) throw new CopyError('a query that always returns a row returned none');
  return row;
}

async function countOf(runner: Runner, query: SQL): Promise<number> {
  const value = (await one(runner, query)).n;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new CopyError('a count came back as something other than a whole number');
  return value;
}

function plans(): TablePlan[] {
  const copied = new Set<unknown>(COPIED);
  const skipped = new Set<unknown>(NEVER_COPIED);
  // A table added to the schema later must be placed on one list on purpose, not skipped silently.
  for (const value of Object.values(schema)) {
    if (is(value, PgTable) && !copied.has(value) && !skipped.has(value)) {
      throw new CopyError(`table ${getTableConfig(value).name} is in the schema but on neither list in copy-data.ts`);
    }
  }
  const seen = new Set<unknown>();
  return COPIED.map((table) => {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const parent = foreignKey.reference().foreignTable;
      if (!seen.has(parent)) throw new CopyError(`table ${config.name} points at ${getTableConfig(parent).name}, which is not copied before it`);
    }
    seen.add(table);
    const key = config.primaryKeys[0]?.columns.map((column) => column.name) ?? config.columns.filter((column) => column.primary).map((column) => column.name);
    if (key.length === 0) throw new CopyError(`table ${config.name} has no primary key to copy by`);
    return { name: config.name, key };
  });
}

function parseCommandLine(): { dryRun: boolean; source: string } {
  try {
    const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, source: { type: 'string' } }, strict: true, allowPositionals: false });
    return { dryRun: values['dry-run'], source: resolve(values.source ?? DEFAULT_SOURCE) };
  } catch {
    throw new CopyError('usage: npm run data:copy -w packages/web -- [--dry-run] [--source <folder>]');
  }
}

async function openPglite(location: string, label: string, cleanup?: () => void): Promise<Opened> {
  const client = location === 'memory' ? await PGlite.create() : await PGlite.create(location);
  const db = drizzlePglite({ client });
  return {
    db,
    label,
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: async () => {
      await client.close().catch(() => undefined);
      cleanup?.();
    },
  };
}

async function openSource(folder: string): Promise<Opened> {
  if (!existsSync(join(folder, 'PG_VERSION'))) throw new CopyError('the source folder is not a PGlite database. Nothing was opened.');
  const copy = mkdtempSync(join(tmpdir(), 'ellai-copy-source-'));
  cpSync(folder, copy, { recursive: true });
  return openPglite(copy, `${folder} (read from a temporary copy)`, () => rmSync(copy, { recursive: true, force: true }));
}

async function openTarget(value: string | undefined, source: string): Promise<Opened> {
  if (value === undefined || value === '') throw new CopyError('DATABASE_URL is not set. Put the Neon connection string in the root .env first.');
  if (value.startsWith('pglite:')) {
    const location = value.slice('pglite:'.length);
    if (location === '') throw new CopyError('DATABASE_URL pglite: needs "memory" or a folder');
    if (location !== 'memory' && resolve(location) === source) throw new CopyError('DATABASE_URL names the source folder itself');
    return openPglite(location, location === 'memory' ? 'pglite:memory, a rehearsal database this script migrates' : 'a local pglite folder, a rehearsal database this script migrates');
  }
  if (!URL.canParse(value)) throw new CopyError('DATABASE_URL is not a URL.');
  const url = new URL(value);
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hostname === '') {
    throw new CopyError('DATABASE_URL must be a postgres:// or postgresql:// URL with a host, or pglite: to rehearse.');
  }
  const pool = new Pool({ connectionString: value });
  pool.on('error', () => {
    console.error('[ellai copy] pool_error');
  });
  return { db: drizzleNeon({ client: pool }), label: 'the Postgres database in DATABASE_URL (address not shown)', close: () => pool.end().catch(() => undefined) };
}

/** The created_at of the newest migration drizzle recorded in this database, or null for none. */
async function newestMigration(runner: Runner): Promise<number | null> {
  const present = await one(runner, sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if (present.present !== true) return null;
  const row = await one(runner, sql`select max(created_at)::text as newest from drizzle.__drizzle_migrations`);
  return typeof row.newest === 'string' ? Number(row.newest) : null;
}

function keyMatch(key: string[], left: string, right: string): SQL {
  return sql.join(
    key.map((column) => sql`${sql.identifier(left)}.${sql.identifier(column)} = ${sql.identifier(right)}.${sql.identifier(column)}`),
    sql` and `,
  );
}

const keyList = (key: string[]): SQL => sql.join(key.map((column) => sql.identifier(column)), sql`, `);

/** One page of a source table as Postgres's own JSON for its rows, in primary key order. */
async function sourcePage(source: Runner, plan: TablePlan, offset: number): Promise<{ json: string; rows: number }> {
  const row = await one(
    source,
    sql`select coalesce(json_agg(page), '[]'::json)::text as json, count(*)::int as n
        from (select * from ${sql.identifier(plan.name)} order by ${keyList(plan.key)} limit ${PAGE_ROWS} offset ${offset}) page`,
  );
  if (typeof row.json !== 'string' || typeof row.n !== 'number') throw new CopyError(`a page of ${plan.name} came back in an unexpected shape`);
  return { json: row.json, rows: row.n };
}

const rowsFromJson = (plan: TablePlan, json: string): SQL => sql`json_populate_recordset(null::${sql.identifier(plan.name)}, ${json}::json)`;

/** How many of the page's rows the target already holds by primary key. */
function presentInTarget(target: Runner, plan: TablePlan, json: string): Promise<number> {
  return countOf(
    target,
    sql`select count(*)::int as n from ${rowsFromJson(plan, json)} as incoming
        where exists (select 1 from ${sql.identifier(plan.name)} as held where ${keyMatch(plan.key, 'held', 'incoming')})`,
  );
}

const OWNERS = getTableConfig(schema.owners).name;

/** Owners in the page that the target holds under the same Sui address with another id, or the same id with another address. */
function disagreeingOwners(target: Runner, plan: TablePlan, json: string): Promise<number> {
  const id = sql.identifier(schema.owners.id.name);
  const address = sql.identifier(schema.owners.suiAddress.name);
  return countOf(
    target,
    sql`select count(*)::int as n from ${rowsFromJson(plan, json)} as incoming
        join ${sql.identifier(plan.name)} as held
          on (held.${address} = incoming.${address} and held.${id} <> incoming.${id})
          or (held.${id} = incoming.${id} and held.${address} <> incoming.${address})`,
  );
}

function insertPage(target: Runner, plan: TablePlan, json: string): Promise<number> {
  return countOf(
    target,
    sql`with inserted as (
          insert into ${sql.identifier(plan.name)} select * from ${rowsFromJson(plan, json)}
          on conflict (${keyList(plan.key)}) do nothing returning 1
        ) select count(*)::int as n from inserted`,
  );
}

const tableCount = (runner: Runner, name: string): Promise<number> => countOf(runner, sql`select count(*)::int as n from ${sql.identifier(name)}`);

async function copyTable(source: Runner, target: Runner, plan: TablePlan, dryRun: boolean): Promise<TableCounts> {
  const sourceRows = await tableCount(source, plan.name);
  const before = await tableCount(target, plan.name);
  let present = 0;
  let copied = 0;
  for (let offset = 0; offset < sourceRows; offset += PAGE_ROWS) {
    const page = await sourcePage(source, plan, offset);
    if (plan.name === OWNERS && (await disagreeingOwners(target, plan, page.json)) > 0) {
      throw new CopyError('the target already holds an owner with the same Sui address under another id, or the same id under another address. Nothing was copied.');
    }
    const held = await presentInTarget(target, plan, page.json);
    present += held;
    if (dryRun) continue;
    const inserted = await insertPage(target, plan, page.json);
    if (held + inserted !== page.rows) throw new CopyError(`${plan.name}: rows copied and rows already there do not add up to the page`);
    copied += inserted;
  }
  if (!dryRun && present + copied !== sourceRows) throw new CopyError(`${plan.name}: the pages read do not add up to the source count`);
  const after = dryRun ? null : await tableCount(target, plan.name);
  if (after !== null && after !== before + copied) throw new CopyError(`${plan.name}: the target count did not grow by exactly the rows copied`);
  return { name: plan.name, source: sourceRows, before, present, copied: dryRun ? sourceRows - present : copied, after };
}

function printCounts(rows: TableCounts[], dryRun: boolean): void {
  const width = Math.max(...rows.map((row) => row.name.length));
  const headers = ['source', 'target before', 'already there', dryRun ? 'would copy' : 'copied', 'target after'];
  console.log(`  ${'table'.padEnd(width)}  ${headers.join('  ')}`);
  for (const row of rows) {
    const cells = [row.source, row.before, row.present, row.copied, row.after ?? '-'].map((value, index) => String(value).padStart(headers[index]?.length ?? 0));
    console.log(`  ${row.name.padEnd(width)}  ${cells.join('  ')}`);
  }
}

function failureLabel(error: unknown): string {
  if (error instanceof CopyError) return error.message;
  // A query error's message carries its SQL and parameters, which here are whole rows with token
  // hashes, so only the database's error code and the constraint it names are shown.
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    // The Neon driver reports a connection it could not open as a bare WebSocket error event.
    if (candidate instanceof Event) return 'could not connect to the database. Check that DATABASE_URL is the Neon connection string.';
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(code)) {
      const constraint = (candidate as { constraint?: unknown }).constraint;
      const named = typeof constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(constraint) ? `, constraint ${constraint}` : '';
      return `database error, code ${code}${named}. The transaction was rolled back, so nothing was copied.`;
    }
  }
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

async function main(): Promise<void> {
  const { dryRun, source: sourceFolder } = parseCommandLine();
  const tables = plans();
  const journal = journalSchema.parse(JSON.parse(readFileSync(JOURNAL, 'utf8')));
  const newest = journal.entries.at(-1)?.when ?? null;

  const target = await openTarget(process.env.DATABASE_URL, sourceFolder);
  let source: Opened | null = null;
  try {
    source = await openSource(sourceFolder);
    console.log(`Ellai data copy${dryRun ? ', DRY RUN: no row will be written' : ''}`);
    console.log(`  from ${source.label}`);
    console.log(`  to   ${target.label}\n`);

    if ((await newestMigration(source.db)) !== newest) throw new CopyError('the source database is not at the newest migration. Start the dev server on it once, then run this again.');
    await target.migrate?.();
    if ((await newestMigration(target.db)) !== newest) throw new CopyError('the target database is not at the newest migration. Run `npm run db:migrate -w packages/web` first.');

    const sourceDb = source.db;
    const counts = await target.db.transaction(async (tx) => {
      const done: TableCounts[] = [];
      for (const plan of tables) done.push(await copyTable(sourceDb, tx, plan, dryRun));
      return done;
    });
    printCounts(counts, dryRun);

    const total = counts.reduce((sum, row) => sum + row.copied, 0);
    console.log(`\nNot copied, by design: ${NEVER_COPIED.map((table) => getTableConfig(table).name).join(', ')}.`);
    console.log('Agent keys: the copied agents keep their token hashes, and a hash only matches its key under the');
    console.log('SESSION_SECRET it was made with. On a site with a new SESSION_SECRET those old keys will not work.');
    console.log('Create new agent keys in the app after deploy instead, and revoke the old ones there.');
    console.log(dryRun ? `\nDRY RUN DONE: ${total} rows would be copied. Nothing was written.` : `\nDONE: ${total} rows copied in one transaction.`);
  } finally {
    await source?.close();
    await target.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
