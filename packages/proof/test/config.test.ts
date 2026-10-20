// Covers: validation of the environment and the wording of its errors.
// Does NOT cover: reading the root .env file from disk (the npm scripts do that with
// Node's --env-file-if-exists flag), or whether a well-formed key holds any funds.
import { randomBytes } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Env = Record<string, string | undefined>;
type ConfigModule = typeof import('../src/config.js');

function validEnv(): Env {
  return {
    SUI_NETWORK: 'mainnet',
    TATUM_API_KEY: '',
    ELLAI_MASTER_SECRET: randomBytes(32).toString('hex'),
    OWNER_TEST_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
    GAS_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  };
}

// config.ts parses process.env as soon as it is imported, so every import here runs
// against a stubbed environment and a fresh module cache.
async function importWithEnv(env: Env): Promise<ConfigModule> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import('../src/config.js');
}

function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('loadConfig threw something that is not an Error');
  }
  throw new Error('loadConfig did not throw');
}

function breakChecksum(key: string): string {
  return key.slice(0, -1) + (key.endsWith('q') ? 'p' : 'q');
}

let loadConfig: ConfigModule['loadConfig'];

beforeAll(async () => {
  ({ loadConfig } = await importWithEnv(validEnv()));
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('accepts a complete mainnet environment and treats a blank Tatum key as unset', () => {
    const env = validEnv();
    const parsed = loadConfig(env);
    expect(parsed.SUI_NETWORK).toBe('mainnet');
    expect(parsed.TATUM_API_KEY).toBeUndefined();
    expect(parsed.ELLAI_MASTER_SECRET).toBe(env.ELLAI_MASTER_SECRET);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('names a missing variable', () => {
    const env = validEnv();
    delete env.ELLAI_MASTER_SECRET;
    expect(() => loadConfig(env)).toThrow('ELLAI_MASTER_SECRET (missing)');
  });

  it('names a malformed secret without ever echoing its value', () => {
    const malformed: Env = {
      ELLAI_MASTER_SECRET: randomBytes(31).toString('hex'),
      OWNER_TEST_PRIVATE_KEY: breakChecksum(Ed25519Keypair.generate().getSecretKey()),
      GAS_PRIVATE_KEY: breakChecksum(Ed25519Keypair.generate().getSecretKey()),
      TATUM_API_KEY: 'tatum-key-that-must-stay-hidden',
    };
    const error = errorFrom(() => loadConfig({ ...validEnv(), ...malformed, SUI_NETWORK: 'testnet' }));

    for (const name of ['ELLAI_MASTER_SECRET', 'OWNER_TEST_PRIVATE_KEY', 'GAS_PRIVATE_KEY']) {
      expect(error.message).toContain(`${name} (malformed)`);
    }
    const everything = `${error.message}\n${error.stack ?? ''}\n${String(error.cause ?? '')}`;
    for (const value of Object.values(malformed)) {
      expect(everything).not.toContain(value);
    }
    expect(error.cause).toBeUndefined();
  });

  it('refuses every network other than mainnet', () => {
    for (const network of ['testnet', 'devnet', 'localnet', 'Mainnet', ' mainnet']) {
      expect(() => loadConfig({ ...validEnv(), SUI_NETWORK: network })).toThrow('SUI_NETWORK (malformed)');
    }
  });

  it('refuses a master secret that is not exactly 64 hex characters', () => {
    const good = randomBytes(32).toString('hex');
    for (const secret of [good.slice(1), `${good}a`, `0x${good}`, `${good.slice(1)}g`]) {
      expect(() => loadConfig({ ...validEnv(), ELLAI_MASTER_SECRET: secret })).toThrow(
        'ELLAI_MASTER_SECRET (malformed)',
      );
    }
  });

  it('refuses a key that is not a valid Ed25519 suiprivkey', () => {
    const notBech32 = `suiprivkey${randomBytes(32).toString('hex')}`;
    expect(() => loadConfig({ ...validEnv(), GAS_PRIVATE_KEY: notBech32 })).toThrow('GAS_PRIVATE_KEY (malformed)');
  });
});

describe('config export', () => {
  it('is parsed from process.env when the module is imported', async () => {
    const env = validEnv();
    const { config } = await importWithEnv(env);
    expect(config.OWNER_TEST_PRIVATE_KEY).toBe(env.OWNER_TEST_PRIVATE_KEY);
  });

  it('stops the import when a variable is bad', async () => {
    await expect(importWithEnv({ ...validEnv(), SUI_NETWORK: 'testnet' })).rejects.toThrow('SUI_NETWORK (malformed)');
  });
});
