// Starts the dev server with the repo's root .env loaded, so local secrets live in one file
// and are never copied into the app folder. Next itself still reads .env.development.local.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const rootEnv = resolve(app, '../../.env');
const loaded = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, 'utf8')) : {};
// A Postgres DATABASE_URL in the root .env is the live database the deploy scripts write to, so the
// preview drops it and keeps a local pglite: one, from here or from .env.development.local.
if (loaded.DATABASE_URL !== undefined && !loaded.DATABASE_URL.startsWith('pglite:')) delete loaded.DATABASE_URL;
const port = process.env.PORT ?? '3001';
const next = createRequire(import.meta.url).resolve('next/dist/bin/next');

// The server finds its migrations from its working directory, so it must start in the app folder.
const child = spawn(process.execPath, [next, 'dev', '-p', port], {
  cwd: app,
  stdio: 'inherit',
  env: { ...loaded, ...process.env },
});
child.on('exit', (code) => process.exit(code ?? 0));
