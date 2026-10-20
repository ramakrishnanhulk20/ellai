// Covers: Tatum's live Sui Mainnet gateway with no API key: the gas price, a digest
// that does not exist, the balance split for the test owner, refusal of bad input,
// and that a rejected key never shows up in an error. Then, after waiting for a fresh
// Tatum minute: the current epoch, a real settled USDC payment read with its status,
// a dry run of garbage bytes, and both response size caps.
// Does NOT cover: a paid key's rate limits, the Walrus blob listing (the probe script
// and the scratch cross-check exercise it), paging past one page, an owner that
// actually holds USDC, a failed transaction's status read from chain (none is pinned
// here), or a dry run that executes and fails (probe:pay shows the refusal path).
// Anonymous Tatum allows 5 requests a minute. This file makes 4, waits, then makes 4
// more, so running it twice inside one minute can fail with RATE_LIMITED.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase58 } from '@mysten/sui/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChainError, createChain } from '../src/chain.js';
import { LIMITS } from '../src/limits.js';
import { USDC_TYPE_MAINNET } from '../src/usdc.js';

const FILE_STARTED_AT = Date.now();

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

// A real gasless 0.01 USDC payment to the payTo of the JMPR hotel search seller, settled
// on 2026-10-05 in epoch 1271 with gas price 0. Found through the public Sui GraphQL
// endpoint by the seller's address, from its openapi.json in reference/payments/live.
const REAL_PAYMENT = {
  digest: 'FLfFCzQrU6gzsYWqLNhcKJVpadpuFy9vHARkv1hvQakS',
  payer: '0x1b0ceebfe92ae5e06314889403be7a19d6762a75cc0ae7c6f8427d384ca3fba8',
  seller: '0x9549bff7412d028e936f3b4525c986c3165273cf363db0a72337da54e001391c',
};

// One second of slack per side of Tatum's minute, so the 4 calls above and the 4 below
// never share a 60 second window.
const FRESH_MINUTE_MS = 65_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('createChain payment reads against Tatum Sui Mainnet, anonymous', () => {
  beforeAll(async () => {
    await sleep(Math.max(0, FILE_STARTED_AT + FRESH_MINUTE_MS - Date.now()));
  }, FRESH_MINUTE_MS + 5_000);

  it('reads the current epoch as a bigint above zero', { timeout: TEST_TIMEOUT_MS }, async () => {
    const epoch = await chain.getCurrentEpoch();
    expect(typeof epoch).toBe('bigint');
    expect(epoch > 0n).toBe(true);
  });

  it('reads a real settled USDC payment with its status and both balance changes', { timeout: TEST_TIMEOUT_MS }, async () => {
    const result = await chain.getTransactionResult(REAL_PAYMENT.digest);
    expect(result.status).toBe('success');
    expect([...result.balanceChanges].sort((a, b) => (a.amount < b.amount ? -1 : 1))).toEqual([
      { address: REAL_PAYMENT.payer, coinType: USDC_TYPE_MAINNET, amount: -10_000n },
      { address: REAL_PAYMENT.seller, coinType: USDC_TYPE_MAINNET, amount: 10_000n },
    ]);
  });

  it('dry-runs garbage bytes into a failure with a short fixed code, within the timeout', { timeout: TEST_TIMEOUT_MS }, async () => {
    const started = Date.now();
    const result = await chain.simulate(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(Date.now() - started).toBeLessThan(LIMITS.tatumTimeoutMs);
    expect(result).toEqual({ status: 'failure', errorCode: 'INVALID_ARGUMENT', balanceChanges: [] });
  });

  it('refuses empty bytes and a malformed digest without asking Tatum', async () => {
    expect((await failureOf(chain.simulate(new Uint8Array()))).code).toBe('INVALID_INPUT');
    expect((await failureOf(chain.getTransactionResult('0xabc'))).code).toBe('INVALID_INPUT');
  });

  it('refuses a gRPC message over the receive cap as LIMIT_EXCEEDED, without retrying', { timeout: TEST_TIMEOUT_MS }, async () => {
    vi.resetModules();
    vi.doMock('../src/limits.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/limits.js')>();
      return { LIMITS: { ...original.LIMITS, grpcMaxReceiveBytes: 1 } };
    });
    const capped = (await import('../src/chain.js')).createChain({});
    try {
      // Matched by shape: the re-imported module has its own ChainError class.
      const failure = await capped.getReferenceGasPrice().then(
        () => null,
        (error: unknown) => error as { name?: string; code?: string; retryable?: boolean },
      );
      // bounded() retries only retryable errors, so retryable false means one attempt.
      expect(failure).toMatchObject({ name: 'ChainError', code: 'LIMIT_EXCEEDED', retryable: false });
    } finally {
      capped.close();
      vi.doUnmock('../src/limits.js');
      vi.resetModules();
    }
  });

  it('refuses a GraphQL body over the byte cap, declared or streamed, as LIMIT_EXCEEDED', async () => {
    const overCap = LIMITS.graphqlMaxResponseBytes + 1;
    const chunk = new Uint8Array(65_536);
    const streamed = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent < overCap; sent += chunk.length) controller.enqueue(chunk);
          controller.close();
        },
      });
    const responses = [
      () => new Response('{}', { status: 200, headers: { 'content-length': String(overCap) } }),
      () => new Response(streamed(), { status: 200 }),
    ];
    try {
      for (const respond of responses) {
        vi.stubGlobal('fetch', async () => respond());
        const failure = await failureOf(chain.listOwnedWalrusBlobs(owner.address));
        expect(failure.code).toBe('LIMIT_EXCEEDED');
        expect(failure.retryable).toBe(false);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
