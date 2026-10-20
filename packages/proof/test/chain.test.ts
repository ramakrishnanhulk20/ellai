// Covers: Tatum's live Sui Mainnet gateway with no API key: the gas price, a digest
// that does not exist, the balance split for the test owner, refusal of bad input,
// and that a rejected key never shows up in an error.
// Does NOT cover: a paid key's rate limits, the Walrus blob listing (the probe script
// and the scratch cross-check exercise it), paging past one page, or an owner that
// actually holds USDC. Anonymous Tatum allows 5 requests a minute and this file makes 4,
// so running it twice inside one minute can fail with RATE_LIMITED.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase58 } from '@mysten/sui/utils';
import { afterAll, describe, expect, it } from 'vitest';
import { ChainError, createChain } from '../src/chain.js';
import { LIMITS } from '../src/limits.js';

const ROOT_ENV = new URL('../../../.env', import.meta.url);

const RETRY_WAITS_MS = Array.from({ length: LIMITS.tatumRetries }, (_, i) => LIMITS.tatumRetryDelayMs * 2 ** i);
const WORST_CASE_MS = (LIMITS.tatumRetries + 1) * LIMITS.tatumTimeoutMs + RETRY_WAITS_MS.reduce((a, b) => a + b, 0);
const TEST_TIMEOUT_MS = WORST_CASE_MS + LIMITS.tatumTimeoutMs;

// Same parser as Node's --env-file, which the npm scripts use. Only the address leaves this function.
function testOwner(): { address: string; source: string } {
  const key = existsSync(ROOT_ENV) ? parseEnv(readFileSync(ROOT_ENV, 'utf8')).OWNER_TEST_PRIVATE_KEY : undefined;
  if (key) return { address: Ed25519Keypair.fromSecretKey(key).toSuiAddress(), source: 'the test owner from .env' };
  return { address: Ed25519Keypair.generate().toSuiAddress(), source: 'a fresh owner, since .env does not exist yet' };
}

async function failureOf(call: Promise<unknown>): Promise<ChainError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ChainError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const chain = createChain({});
const owner = testOwner();

afterAll(() => chain.close());

describe('createChain against Tatum Sui Mainnet, anonymous', () => {
  it('reads a reference gas price above zero', { timeout: TEST_TIMEOUT_MS }, async () => {
    const price = await chain.getReferenceGasPrice();
    expect(typeof price).toBe('bigint');
    expect(price > 0n).toBe(true);
  });

  it('reports a made-up digest as not found, clearly and within the timeout', { timeout: TEST_TIMEOUT_MS }, async () => {
    const digest = toBase58(randomBytes(32));
    const started = Date.now();
    const failure = await failureOf(chain.getTransactionBalanceChanges(digest));
    expect(Date.now() - started).toBeLessThan(LIMITS.tatumTimeoutMs);
    expect(failure.code).toBe('NOT_FOUND');
    expect(failure.message).toBe(`Transaction ${digest} was not found on Sui mainnet`);
  });

  it(`getBalances on ${owner.source} returns three bigints`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const balances = await chain.getBalances(owner.address);
    expect(Object.keys(balances).sort()).toEqual(['suiTotal', 'usdcAddressBalance', 'usdcCoinBalance']);
    for (const value of Object.values(balances)) {
      expect(typeof value).toBe('bigint');
      expect(value >= 0n).toBe(true);
    }
  });

  it('refuses a malformed address or digest as invalid input', async () => {
    expect((await failureOf(chain.getBalances('not an address'))).code).toBe('INVALID_INPUT');
    expect((await failureOf(chain.listOwnedWalrusBlobs(''))).code).toBe('INVALID_INPUT');
    expect((await failureOf(chain.getTransactionBalanceChanges('0xabc'))).code).toBe('INVALID_INPUT');
  });

  it('never puts a rejected API key into its error', { timeout: TEST_TIMEOUT_MS }, async () => {
    const fakeKey = `fake-${randomBytes(16).toString('hex')}`;
    const badKeyChain = createChain({ apiKey: fakeKey });
    try {
      const failure = await failureOf(badKeyChain.getReferenceGasPrice());
      expect(failure.code).toBe('UNAUTHORIZED');
      expect(`${failure.message}\n${failure.stack ?? ''}\n${String(failure.cause ?? '')}`).not.toContain(fakeKey);
    } finally {
      badKeyChain.close();
    }
  });
});
