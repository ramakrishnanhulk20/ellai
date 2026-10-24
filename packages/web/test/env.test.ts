// Covers: validation of the server environment and the wording of its errors.
// Does NOT cover: reading .env from disk, whether a database URL points at a reachable
// database, or whether a well-formed key or API key is accepted by the service it is for.
import { randomBytes } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Env = Record<string, string | undefined>;
type EnvModule = typeof import('../src/server/env.js');

function validEnv(): Env {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    ELLAI_MASTER_SECRET: randomBytes(32).toString('hex'),
    GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
    TATUM_API_KEY: '',
    MEMWAL_RELAYER_URL: 'https://relayer.memory.walrus.xyz',
    ANTHROPIC_API_KEY: '',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    JOBS_SECRET: randomBytes(32).toString('hex'),
    APP_ORIGIN: 'https://ellai.example',
  };
}

// env.ts parses process.env as soon as it is imported, so every import here runs
// against a stubbed environment and a fresh module cache.
async function importWithEnv(env: Env): Promise<EnvModule> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import('../src/server/env.js');
}

function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('loadServerEnv threw something that is not an Error');
  }
  throw new Error('loadServerEnv did not throw');
}

let loadServerEnv: EnvModule['loadServerEnv'];

beforeAll(async () => {
  ({ loadServerEnv } = await importWithEnv(validEnv()));
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadServerEnv', () => {
  it('accepts a complete environment on the in-memory database and treats blank optional keys as unset', () => {
    const env = validEnv();
    const parsed = loadServerEnv(env);
    expect(parsed.DATABASE_URL).toBe('pglite:memory');
    expect(parsed.TATUM_API_KEY).toBeUndefined();
    expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(parsed.APP_ORIGIN).toBe('https://ellai.example');
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts postgres URLs and a local file database', () => {
    const urls = [
      'postgresql://ellai:secret@ep-quiet-sky-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require',
      'postgres://ellai:secret@localhost:5432/ellai',
      'pglite:./data/ellai',
    ];
    for (const url of urls) {
      expect(loadServerEnv({ ...validEnv(), DATABASE_URL: url }).DATABASE_URL).toBe(url);
    }
  });

  it('refuses a pglite database outside development and test', () => {
    for (const nodeEnv of ['production', undefined, 'staging']) {
      for (const url of ['pglite:memory', 'pglite:./data/ellai']) {
        expect(() => loadServerEnv({ ...validEnv(), NODE_ENV: nodeEnv, DATABASE_URL: url })).toThrow('DATABASE_URL (malformed)');
      }
    }
  });

  it('names every missing variable', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    env.SESSION_SECRET = '';
    const error = errorFrom(() => loadServerEnv(env));
    expect(error.message).toContain('DATABASE_URL (missing)');
    expect(error.message).toContain('SESSION_SECRET (missing)');
    expect(error.message).not.toContain('APP_ORIGIN');
  });

  it('names malformed variables without ever echoing their values', () => {
    const malformed: Env = {
      DATABASE_URL: 'mysql://ellai:database-password-that-must-stay-hidden@db.example/ellai',
      ELLAI_MASTER_SECRET: randomBytes(31).toString('hex'),
      GAS_PRIVATE_KEY: `suiprivkey${randomBytes(32).toString('hex')}`,
      MEMWAL_RELAYER_URL: 'http://relayer.example',
      SESSION_SECRET: randomBytes(31).toString('hex'),
      JOBS_SECRET: `${randomBytes(32).toString('hex')}a`,
      APP_ORIGIN: 'https://ellai.example/app?token=origin-secret',
      TATUM_API_KEY: 'tatum-key-that-must-stay-hidden',
    };
    const error = errorFrom(() => loadServerEnv({ ...validEnv(), ...malformed }));

    for (const name of Object.keys(malformed).filter((name) => name !== 'TATUM_API_KEY')) {
      expect(error.message).toContain(`${name} (malformed)`);
    }
    const everything = `${error.message}\n${error.stack ?? ''}\n${String(error.cause ?? '')}`;
    for (const value of Object.values(malformed)) {
      expect(everything).not.toContain(value);
    }
    expect(error.cause).toBeUndefined();
  });

  it('refuses database URLs that are neither postgres nor pglite', () => {
    for (const url of ['pglite:', 'pglite: memory', 'https://db.example/ellai', 'postgresql://', 'memory']) {
      expect(() => loadServerEnv({ ...validEnv(), DATABASE_URL: url })).toThrow('DATABASE_URL (malformed)');
    }
  });

  it('refuses an http APP_ORIGIN in production and accepts localhost only in development and test', () => {
    const local = 'http://localhost:3000';
    for (const nodeEnv of ['production', undefined, 'staging']) {
      expect(() => loadServerEnv({ ...validEnv(), NODE_ENV: nodeEnv, APP_ORIGIN: local })).toThrow(
        'APP_ORIGIN (malformed)',
      );
    }
    for (const nodeEnv of ['development', 'test']) {
      expect(loadServerEnv({ ...validEnv(), NODE_ENV: nodeEnv, APP_ORIGIN: local }).APP_ORIGIN).toBe(local);
    }
    for (const notLocal of ['http://ellai.example', 'http://127.0.0.1:3000', 'http://localhost']) {
      expect(() => loadServerEnv({ ...validEnv(), NODE_ENV: 'development', APP_ORIGIN: notLocal })).toThrow(
        'APP_ORIGIN (malformed)',
      );
    }
  });

  it('keeps APP_ORIGIN to a bare origin, normalised', () => {
    expect(loadServerEnv({ ...validEnv(), APP_ORIGIN: 'https://Ellai.Example:443/' }).APP_ORIGIN).toBe(
      'https://ellai.example',
    );
    for (const bad of ['https://ellai.example/app', 'https://user:pw@ellai.example', 'https://ellai.example/#x', 'ellai.example']) {
      expect(() => loadServerEnv({ ...validEnv(), APP_ORIGIN: bad })).toThrow('APP_ORIGIN (malformed)');
    }
  });

  it('accepts session and jobs secrets of 32 bytes or more and refuses shorter or uneven hex', () => {
    const longer = randomBytes(48).toString('hex');
    expect(loadServerEnv({ ...validEnv(), SESSION_SECRET: longer, JOBS_SECRET: longer }).SESSION_SECRET).toBe(longer);
    for (const secret of [randomBytes(31).toString('hex'), `${randomBytes(32).toString('hex')}f`, `0x${randomBytes(32).toString('hex')}`]) {
      expect(() => loadServerEnv({ ...validEnv(), JOBS_SECRET: secret })).toThrow('JOBS_SECRET (malformed)');
    }
  });
});

describe('serverEnv export', () => {
  it('is parsed from process.env when the module is imported', async () => {
    const env = validEnv();
    const { serverEnv } = await importWithEnv(env);
    expect(serverEnv.GAS_PRIVATE_KEY).toBe(env.GAS_PRIVATE_KEY);
  });

  it('stops the import when a variable is bad', async () => {
    await expect(importWithEnv({ ...validEnv(), ELLAI_MASTER_SECRET: 'short' })).rejects.toThrow(
      'ELLAI_MASTER_SECRET (malformed)',
    );
  });
});
