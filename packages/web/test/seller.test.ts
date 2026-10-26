// Covers: Ellai's own wallet check seller on PGlite with a stand-in chain. The 402 it issues
// round-trips through core's parseChallenge into a payment of exactly 0.01 USDC to the pay-to
// address with the nonce and epochs the challenge id carries; a payment is refused for an
// unknown, expired, already-claimed or other-resource challenge, and for a header that is not
// the t2000 shape; bytes paying another recipient or amount or carrying an extra command, and a
// signature that is not the sender's, are refused after the claim and never executed; a
// settlement mismatch or failure is refused and closed; every other execution failure, whatever
// its code or type, but core's two never-sent codes, is an unknown outcome read back by its
// digest and settled if it landed, and otherwise left open to the same bytes alone,
// so a retry delivers; that retry is read at most once per recheck window, rechecks of every sale
// together at most LIMITS.sellerRechecksPerDayGlobal times a day, and the sale is closed for good
// once its epoch window has closed and LIMITS.paymentReleaseReads reads after that all miss; a
// check that fails after the payment settled is served again to the same bytes alone, under the
// same recheck caps and at most LIMITS.sellerRedeliveriesPerSale times, without spending the day
// past that, and delivered once; with a slow chain no read or check step begins past the
// seller's deadline and a request cut short leaves its sale waiting or undelivered; a challenge pays once and one payment never pays
// two challenges; the unpaid rate limit per caller and for every caller together; the caps on
// sends per caller a minute and a day and for every caller a day, counted only after the offline
// checks and never reaching the chain past them; a send Ellai's Tatum budget refused closed as
// never sent, with 503 until the UTC day ends, while a refusal after the send keeps its sale
// waiting; one epoch read per cache window, and during an outage one per
// LIMITS.epochFailureCacheMs; the wallet check summary and its blob cap; the pay-to fallback;
// the route's duration ceiling; and no response ever carries the payment header, its bytes or
// its signature.
// Does NOT cover: the live chain or Tatum (`npm run prove:seller` pays one 0.01 USDC live),
// core's own challenge, payment and settlement rules or which code its executeTransaction throws
// when (core's tests; the stand-in chain throws what core promises), zkLogin or multisig payers,
// two connections racing on one claim or on serving one settled sale (PGlite serves one
// connection at a time), or the HTTP route beyond its duration ceiling (routes-public.test.ts).
import { randomBytes } from 'node:crypto';
import { type BalanceChange, type Chain, ChainError, type ChainErrorCode, type ExecutionResult, type TransactionResult, type WalrusBlob } from '@ellai/core/chain';
import { type CanonicalPayment, parseChallenge } from '@ellai/core/challenge';
import { canonicalSuiAddress } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { findMemoryAccount } from '@ellai/core/memory';
import { DEPLOYMENT_NETWORK, SUI_MAINNET_CHAIN_ID } from '@ellai/core/network';
import { paymentHeader, signPayment } from '@ellai/core/payment';
import { USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as walletCheckRoute from '../src/app/api/sell/wallet-check/route.js';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { sellerSales } from '../src/server/db/schema.js';
import { SellerError, issueWalletCheckChallenge, readSellerChallengeId, sellerChallengeId } from '../src/server/seller/challenge.js';
import { LONGEST_READ_MS, SELLER_END_BY_MS, SELLER_READ_BY_MS, sellerDeadline } from '../src/server/seller/deadline.js';
import { HANDLER_MESSAGES, type SellerResponse, handleWalletCheck, sellerPayTo } from '../src/server/seller/handler.js';
import { SETTLE_REASONS, type SettleOutcome, markDelivered, settleWalletCheckPayment } from '../src/server/seller/settle.js';
import { walletCheck } from '../src/server/seller/walletcheck.js';

vi.mock('@ellai/core/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ellai/core/memory')>()),
  findMemoryAccount: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof createDb>>;
let db: Database;

beforeAll(async () => {
  handle = await createDb('pglite:memory');
  db = handle.db;
  await migrate(db);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  vi.mocked(findMemoryAccount).mockReset();
  vi.mocked(findMemoryAccount).mockResolvedValue(null);
});

const NOW = new Date('2026-10-24T10:00:00Z');
const RESOURCE = 'https://ellai.example/api/seller/wallet-check';
const OTHER_RESOURCE = 'https://ellai.example/api/seller/other';
const PAY_TO = canonicalSuiAddress(`0x${'5e'.repeat(32)}`);
const OTHER = canonicalSuiAddress(`0x${'a7'.repeat(32)}`);
const EPOCH = 1_100n;
const PRICE = BigInt(LIMITS.sellerPriceAtomic);
const BINDING = { resource: RESOURCE, recipient: PAY_TO, amount: PRICE };
const buyer = Ed25519Keypair.generate();
const BUYER = canonicalSuiAddress(buyer.toSuiAddress());
const CHECKED = canonicalSuiAddress(`0x${'c4'.repeat(32)}`);
const BODY = JSON.stringify({ address: CHECKED });

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

const saleOf = async (challengeId: string) => one(await db.select().from(sellerSales).where(eq(sellerSales.challengeId, challengeId)));
const saleCount = async () => (await db.select({ id: sellerSales.id }).from(sellerSales)).length;

/** What a chain shows for the payer's exact send to PAY_TO, or `changes` instead. */
function landed(txBytes: Uint8Array, changes?: (payer: string) => BalanceChange[]): ExecutionResult {
  const payer = canonicalSuiAddress(TransactionDataBuilder.fromBytes(txBytes).getData().sender ?? '');
  return {
    digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
    status: 'success',
    errorCode: null,
    balanceChanges: changes?.(payer) ?? [
      { address: payer, coinType: USDC_TYPE_MAINNET, amount: -PRICE },
      { address: PAY_TO, coinType: USDC_TYPE_MAINNET, amount: PRICE },
    ],
    createdObjects: [],
  };
}

interface ChainState {
  /** An Error is thrown by the epoch read instead. */
  epoch: bigint | Error;
  execute: (txBytes: Uint8Array) => ExecutionResult;
  /** What a read of a digest finds; null is a chain that does not have it (NOT_FOUND). */
  read: (digest: string) => TransactionResult | null;
  blobs: number | 'too many';
}

function stubChain(overrides: Partial<ChainState> = {}) {
  const state: ChainState = { epoch: EPOCH, execute: (txBytes) => landed(txBytes), read: () => null, blobs: 0, ...overrides };
  const calls = { epochs: 0, executions: [] as string[], reads: [] as string[], balances: [] as string[], blobs: [] as string[] };
  const chain = {
    usesApiKey: false,
    getCurrentEpoch: async () => {
      calls.epochs += 1;
      if (state.epoch instanceof Error) throw state.epoch;
      return state.epoch;
    },
    executeTransaction: async (txBytes: Uint8Array) => {
      calls.executions.push(TransactionDataBuilder.getDigestFromBytes(txBytes));
      return state.execute(txBytes);
    },
    getTransactionResult: async (digest: string) => {
      calls.reads.push(digest);
      const found = state.read(digest);
      if (found === null) throw new ChainError('NOT_FOUND', 'Transaction was not found on Sui mainnet');
      return found;
    },
    getBalances: async (address: string) => {
      calls.balances.push(address);
      return { usdcAddressBalance: 50_000n, usdcCoinBalance: 1_234_567n, suiTotal: 1_500_000_000n };
    },
    listOwnedWalrusBlobs: async (address: string): Promise<WalrusBlob[]> => {
      calls.blobs.push(address);
      if (state.blobs === 'too many') throw new ChainError('LIMIT_EXCEEDED', 'Tatum listOwnedWalrusBlobs: more than 1000 blobs, refusing a partial list');
      return Array.from({ length: state.blobs }, (_, i) => ({ objectId: `0x${i}`, blobId: `blob-${i}`, registeredEpoch: 1, endEpoch: 2, deletable: true }));
    },
  } as unknown as Chain;
  return { chain, state, calls };
}

function issue(chain: Chain, resourceUrl = RESOURCE, now = NOW) {
  return issueWalletCheckChallenge({ db, chain, resourceUrl, payTo: PAY_TO, now });
}

/** The 402 as a buyer reads it, through core's own parser. */
function asBuyer(issued: { status: number; headers: Record<string, string>; body: string }, url = RESOURCE): CanonicalPayment {
  const parsed = new URL(url);
  return parseChallenge({ status: issued.status, headers: issued.headers, bodyText: issued.body, url: parsed.href, host: parsed.hostname }, NOW.getTime());
}

async function pay(payment: CanonicalPayment, keypair = buyer) {
  const signed = await signPayment(payment, keypair, NOW.getTime(), payment.minEpoch ?? EPOCH);
  return { signed, header: paymentHeader(payment, signed).value };
}

function headerFor(parts: { sender: string; txBytes: Uint8Array; signature: string; challengeId: string }, extra: Record<string, unknown> = {}): string {
  const body = {
    x402Version: 1,
    scheme: 'exact',
    network: DEPLOYMENT_NETWORK,
    payload: { senderAddress: parts.sender, txBytes: toBase64(parts.txBytes), senderSignature: parts.signature, challengeId: parts.challengeId },
    ...extra,
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

interface Tamper {
  recipient?: string;
  amount?: bigint;
  extraCommand?: boolean;
}

/** The plain send by hand, with one thing changed: what a buyer trying to pay less or elsewhere would hand in. */
async function handBuilt(payment: CanonicalPayment, tamper: Tamper = {}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(BUYER);
  const [balance] = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [tx.withdrawal({ amount: tamper.amount ?? payment.amount, type: USDC_TYPE_MAINNET })],
  });
  if (balance === undefined) throw new Error('redeem_funds returned nothing');
  tx.moveCall({
    target: '0x2::balance::send_funds',
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [balance, tx.pure.address(tamper.recipient ?? payment.recipient)],
  });
  if (tamper.extraCommand) tx.moveCall({ target: '0x2::coin::zero', typeArguments: [USDC_TYPE_MAINNET] });
  tx.setGasPrice(0);
  tx.setGasBudget(0);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(payment.minEpoch),
      maxEpoch: String(payment.maxEpoch),
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_MAINNET_CHAIN_ID,
      nonce: Number(payment.nonce),
    },
  });
  return tx.build();
}

// Counts the waits between chain reads instead of waiting them out.
const waits: number[] = [];
const noWait = async (ms: number) => {
  waits.push(ms);
};

function settle(chain: Chain, paymentHeaderValue: string, options: { resourceUrl?: string; now?: Date; callerKey?: string } = {}) {
  return settleWalletCheckPayment({
    db,
    chain,
    paymentHeader: paymentHeaderValue,
    resourceUrl: options.resourceUrl ?? RESOURCE,
    callerKey: options.callerKey ?? `caller-${randomBytes(8).toString('hex')}`,
    now: options.now ?? NOW,
    sleep: noWait,
  });
}

interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  callerKey?: string;
  now?: Date;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function call(chain: Chain, options: CallOptions = {}) {
  return handleWalletCheck({
    db,
    chain,
    method: options.method ?? 'POST',
    url: RESOURCE,
    headers: options.headers ?? { 'content-type': 'application/json' },
    body: options.body ?? BODY,
    payTo: PAY_TO,
    callerKey: options.callerKey ?? `caller-${randomBytes(8).toString('hex')}`,
    now: options.now ?? NOW,
    sleep: options.sleep ?? noWait,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

type SlowCall = 'execute' | 'read' | 'epoch' | 'balances';

/**
 * stubChain on a clock of its own: each send and read moves it on by its entry in `delays`, and
 * `sleep` moves it too, so a slow Tatum costs no real time. `starts` holds the time each call began.
 */
function slowChain(delays: Record<SlowCall, number>, overrides: Partial<ChainState> = {}) {
  const stub = stubChain(overrides);
  const time = { ms: 0 };
  const starts: number[] = [];
  const slow =
    <A extends unknown[], R>(kind: SlowCall, run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      starts.push(time.ms);
      time.ms += delays[kind];
      return run(...args);
    };
  const chain = {
    ...stub.chain,
    executeTransaction: slow('execute', stub.chain.executeTransaction),
    getTransactionResult: slow('read', stub.chain.getTransactionResult),
    getCurrentEpoch: slow('epoch', stub.chain.getCurrentEpoch),
    getBalances: slow('balances', stub.chain.getBalances),
  } as Chain;
  const sleep = async (ms: number) => {
    time.ms += ms;
  };
  return { ...stub, chain, time, starts, clock: () => time.ms, sleep };
}

describe('issueWalletCheckChallenge', () => {
  it('issues a 402 that parseChallenge reads as exactly 0.01 USDC to the pay-to address with the nonce and epochs its id carries, stored as issued', async () => {
    const { chain, calls } = stubChain();
    const issued = await issue(chain);
    const payment = asBuyer(issued);

    expect(issued.status).toBe(402);
    expect(payment).toMatchObject({
      dialect: 'x402-v1-t2000',
      recipient: PAY_TO,
      amount: 10_000n,
      asset: USDC_TYPE_MAINNET,
      network: 'sui:mainnet',
      challengeId: issued.challengeId,
      minEpoch: EPOCH,
      maxEpoch: EPOCH + 1n,
      resource: RESOURCE,
    });
    const option = (JSON.parse(issued.body) as { accepts: [{ maxTimeoutSeconds: number; extra: { suimpp: { nonce: number } } }] }).accepts[0];
    expect(option.maxTimeoutSeconds).toBe(LIMITS.sellerChallengeTtlMs / 1_000);
    expect(String(option.extra.suimpp.nonce)).toBe(payment.nonce);
    expect(issued.headers['WWW-Authenticate']).toBe(
      `Payment realm="ellai.example", recipient="${PAY_TO}", currency="${USDC_TYPE_MAINNET}", amount="0.01"`,
    );

    expect(readSellerChallengeId(issued.challengeId, BINDING)).toEqual({ nonce: Number(payment.nonce), minEpoch: EPOCH, maxEpoch: EPOCH + 1n });
    expect(readSellerChallengeId(issued.challengeId, { ...BINDING, resource: OTHER_RESOURCE })).toBeNull();
    expect(readSellerChallengeId(issued.challengeId, { ...BINDING, recipient: OTHER })).toBeNull();
    expect(readSellerChallengeId(issued.challengeId, { ...BINDING, amount: PRICE + 1n })).toBeNull();

    expect(await saleOf(issued.challengeId)).toMatchObject({
      amountAtomic: PRICE,
      recipient: PAY_TO,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + LIMITS.sellerChallengeTtlMs),
      status: 'issued',
      payer: null,
      digest: null,
      settledAt: null,
    });
    expect(calls.epochs).toBe(1);
    expect((await issue(chain)).challengeId).not.toBe(issued.challengeId);
  });

  it('refuses a pay-to address that cannot be paid, a resource that is not a plain URL and an epoch past the id layout, storing nothing', async () => {
    const before = await saleCount();
    const { chain } = stubChain();
    await expect(issueWalletCheckChallenge({ db, chain, resourceUrl: RESOURCE, payTo: '0x0', now: NOW })).rejects.toThrow(SellerError);
    await expect(issueWalletCheckChallenge({ db, chain, resourceUrl: RESOURCE, payTo: 'seller', now: NOW })).rejects.toThrow(SellerError);
    for (const url of ['ftp://ellai.example/check', 'https://user:pw@ellai.example/check', 'not a url']) {
      await expect(issue(chain, url)).rejects.toThrow(SellerError);
    }
    await expect(issue(stubChain({ epoch: 2n ** 32n }).chain)).rejects.toThrow(SellerError);
    expect(await saleCount()).toBe(before);
  });

  it('reads the epoch once per LIMITS.epochCacheMs, and issues nothing from a failed read or one lower than an epoch already read (C22)', async () => {
    const { chain, state, calls } = stubChain();
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const epochOf = async (now: Date) => readSellerChallengeId((await issue(chain, RESOURCE, now)).challengeId, BINDING)?.minEpoch;

    expect(await epochOf(at(0))).toBe(EPOCH);
    state.epoch = EPOCH + 1n;
    expect(await epochOf(at(LIMITS.epochCacheMs - 1))).toBe(EPOCH);
    expect(calls.epochs).toBe(1);
    expect(await epochOf(at(LIMITS.epochCacheMs))).toBe(EPOCH + 1n);
    expect(calls.epochs).toBe(2);

    // A node still short of the boundary the last read passed, then, once that failure is no
    // longer remembered, a read that fails: the expired reading is not fallen back on, and
    // nothing is stored.
    const before = await saleCount();
    const failed = 2 * LIMITS.epochCacheMs;
    state.epoch = EPOCH;
    await expect(issue(chain, RESOURCE, at(failed))).rejects.toThrow(SellerError);
    state.epoch = new ChainError('TIMEOUT', 'timed out', true);
    await expect(issue(chain, RESOURCE, at(failed + LIMITS.epochFailureCacheMs))).rejects.toThrow(ChainError);
    expect(await saleCount()).toBe(before);
    expect(calls.epochs).toBe(4);

    state.epoch = EPOCH + 1n;
    expect(await epochOf(at(failed + 2 * LIMITS.epochFailureCacheMs))).toBe(EPOCH + 1n);
    // A clock that reads earlier than the cached read cannot make that read look younger.
    expect(await epochOf(at(LIMITS.epochCacheMs))).toBe(EPOCH + 1n);
    expect(calls.epochs).toBe(6);
  });
});

describe('settleWalletCheckPayment', () => {
  it('takes the exact payment once: executed through the chain, verified, recorded as settled but not yet delivered, and refused when presented again once delivered', async () => {
    const { chain, calls } = stubChain();
    const issued = await issue(chain);
    const { signed, header } = await pay(asBuyer(issued));

    expect(await settle(chain, header)).toEqual({ ok: true, digest: signed.digest, payer: BUYER });
    expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'settled', digest: signed.digest, payer: BUYER, settledAt: NOW, deliveredAt: null });
    await markDelivered(db, signed.digest, NOW);
    expect((await saleOf(issued.challengeId)).deliveredAt).toEqual(NOW);
    expect(await settle(chain, header)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });
    expect(calls.executions).toEqual([signed.digest]);
  });

  it('refuses a header for an unknown, expired, already-claimed or other-resource challenge without touching the chain', async () => {
    const { chain, calls } = stubChain();

    const unissued = asBuyer(await issue(chain));
    const neverStored = sellerChallengeId({ nonce: Number(unissued.nonce), minEpoch: EPOCH, random: 1 }, BINDING);
    const { header: unknown } = await pay({ ...unissued, challengeId: neverStored });
    expect(await settle(chain, unknown)).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.unknown });

    const late = await issue(chain);
    const { header: lateHeader } = await pay(asBuyer(late));
    expect(await settle(chain, lateHeader, { now: new Date(NOW.getTime() + LIMITS.sellerChallengeTtlMs) })).toEqual({
      ok: false,
      status: 402,
      reason: SETTLE_REASONS.expired,
    });
    expect((await saleOf(late.challengeId)).status).toBe('issued');

    const elsewhere = await issue(chain);
    const { header: elsewhereHeader } = await pay(asBuyer(elsewhere));
    expect(await settle(chain, elsewhereHeader, { resourceUrl: OTHER_RESOURCE })).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.otherResource });
    expect((await saleOf(elsewhere.challengeId)).status).toBe('issued');

    const claimed = await issue(chain);
    const { header: claimedHeader } = await pay(asBuyer(claimed));
    await db.update(sellerSales).set({ status: 'rejected', payer: OTHER }).where(eq(sellerSales.challengeId, claimed.challengeId));
    expect(await settle(chain, claimedHeader)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });

    expect(calls.executions).toEqual([]);
  });

  it('refuses bytes that pay another recipient, another amount or carry an extra command, after claiming the challenge, and never executes them', async () => {
    const { chain, calls } = stubChain();
    const control = asBuyer(await issue(chain));
    expect(toBase64(await handBuilt(control))).toBe((await pay(control)).signed.txBytesBase64);

    for (const tamper of [{ recipient: OTHER }, { amount: PRICE - 1n }, { amount: PRICE * 2n }, { extraCommand: true }]) {
      const issued = await issue(chain);
      const payment = asBuyer(issued);
      const txBytes = await handBuilt(payment, tamper);
      const { signature } = await buyer.signTransaction(txBytes);
      const header = headerFor({ sender: BUYER, txBytes, signature, challengeId: issued.challengeId });

      expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.bytes });
      expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'rejected', payer: BUYER, digest: null, settledAt: null });
      const { header: honest } = await pay(payment);
      expect(await settle(chain, honest)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });
    }
    expect(calls.executions).toEqual([]);
  });

  it('refuses a signature made by anyone but the sender, and never executes the bytes', async () => {
    const { chain, calls } = stubChain();
    const stranger = Ed25519Keypair.generate();
    for (const sign of [
      async (txBytes: Uint8Array) => (await stranger.signTransaction(txBytes)).signature,
      async (txBytes: Uint8Array) => (await buyer.signTransaction(new Uint8Array([...txBytes, 0]))).signature,
    ]) {
      const issued = await issue(chain);
      const txBytes = await handBuilt(asBuyer(issued));
      const header = headerFor({ sender: BUYER, txBytes, signature: await sign(txBytes), challengeId: issued.challengeId });
      expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.signature });
      expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'rejected', digest: null });
    }
    expect(calls.executions).toEqual([]);
  });

  const mismatched = (txBytes: Uint8Array) =>
    landed(txBytes, (payer) => [
      { address: payer, coinType: USDC_TYPE_MAINNET, amount: -PRICE },
      { address: PAY_TO, coinType: USDC_TYPE_MAINNET, amount: PRICE - 1n },
      { address: OTHER, coinType: USDC_TYPE_MAINNET, amount: 1n },
    ]);
  const failedOnChain = (txBytes: Uint8Array): ExecutionResult => ({ ...landed(txBytes, () => []), status: 'failure', errorCode: 'INSUFFICIENT_ADDRESS_BALANCE' });

  it('rejects only on a definite answer: a settlement that is not the exact payment, a failed one, or bytes core refused to send, each closed against its digest', async () => {
    const outcomes: Array<[ChainState['execute'], string]> = [
      [mismatched, SETTLE_REASONS.mismatch],
      [failedOnChain, SETTLE_REASONS.failed],
      [() => {
        throw new ChainError('INVALID_INPUT', 'a signature is not base64');
      }, SETTLE_REASONS.failed],
    ];
    for (const [execute, reason] of outcomes) {
      const { chain, calls } = stubChain({ execute });
      const issued = await issue(chain);
      const { signed, header } = await pay(asBuyer(issued));
      expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason });
      expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'rejected', digest: signed.digest, payer: BUYER, settledAt: NOW });
      expect(await settle(chain, header)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });
      expect(calls.executions).toEqual([signed.digest]);
      expect(calls.reads).toEqual([]);
    }
  });

  it('keeps the sale waiting on every execution failure but the two core throws only when nothing was sent, whatever its code, retry flag or type (C29)', async () => {
    const mayHaveLanded = ['NOT_FOUND', 'TIMEOUT', 'RATE_LIMITED', 'UNAUTHORIZED', 'UPSTREAM', 'BAD_RESPONSE', 'LIMIT_EXCEEDED'] as const;
    // Stops compiling when core adds a code this test does not place.
    const everyCodePlaced: [Exclude<ChainErrorCode, (typeof mayHaveLanded)[number] | 'INVALID_INPUT' | 'BUDGET'>] extends [never] ? true : false = true;
    expect(everyCodePlaced).toBe(true);
    const failures: Error[] = [
      ...mayHaveLanded.flatMap((code) => [true, false].map((retryable) => new ChainError(code, `Tatum executeTransaction: ${code}; the transaction may have landed`, retryable))),
      new Error('the connection closed'),
    ];
    for (const failure of failures) {
      const { chain, calls } = stubChain({
        execute: () => {
          throw failure;
        },
      });
      const issued = await issue(chain);
      const { signed, header } = await pay(asBuyer(issued));
      expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed });
      expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'rejected', digest: signed.digest, settledAt: null });
      expect(calls.reads).toEqual(Array<string>(LIMITS.chainReadAfterWriteTries).fill(signed.digest));
    }
  });

  it('reads the digest after an unknown execution outcome, settling a payment that landed and closing on a failed or mismatched one (A1-7)', async () => {
    const reads: Array<[(txBytes: Uint8Array) => TransactionResult, SettleOutcome | null, string]> = [
      [landed, null, 'settled'],
      [failedOnChain, { ok: false, status: 402, reason: SETTLE_REASONS.failed }, 'rejected'],
      [mismatched, { ok: false, status: 402, reason: SETTLE_REASONS.mismatch }, 'rejected'],
    ];
    for (const [found, outcome, status] of reads) {
      const { chain, state, calls } = stubChain({
        execute: () => {
          throw new ChainError('TIMEOUT', 'Tatum executeTransaction: timed out; the transaction may have landed', true);
        },
      });
      const issued = await issue(chain);
      const { signed, header } = await pay(asBuyer(issued));
      // A lagging node misses it twice before the third read finds it.
      state.read = () => (calls.reads.length < 3 ? null : found(Buffer.from(signed.txBytesBase64, 'base64')));
      waits.length = 0;
      expect(await settle(chain, header)).toEqual(outcome ?? { ok: true, digest: signed.digest, payer: BUYER });
      expect(await saleOf(issued.challengeId)).toMatchObject({ status, digest: signed.digest, payer: BUYER, settledAt: NOW });
      expect(calls.reads).toEqual([signed.digest, signed.digest, signed.digest]);
      expect(waits).toEqual([LIMITS.chainReadAfterWriteDelayMs, LIMITS.chainReadAfterWriteDelayMs]);
      expect(calls.executions).toEqual([signed.digest]);
    }
  });

  it('keeps a sale whose outcome stays unknown open to the same bytes alone, and a retry with the same header after the challenge expired re-checks the chain and delivers (A1-7)', async () => {
    const { chain, state, calls } = stubChain({
      execute: () => {
        throw new ChainError('UPSTREAM', 'Tatum executeTransaction: gateway error; the transaction may have landed', true);
      },
    });
    const unpaid = await call(chain);
    const payment = asBuyer(unpaid);
    const { signed, header } = await pay(payment);
    const paidCall = (now: Date) => call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, now });

    const unknown = await paidCall(NOW);
    expect(unknown.status).toBe(402);
    expect(JSON.parse(unknown.body)).toEqual({ error: SETTLE_REASONS.unconfirmed });
    expect(calls.reads).toEqual(Array<string>(LIMITS.chainReadAfterWriteTries).fill(signed.digest));
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'rejected', digest: signed.digest, payer: BUYER, settledAt: null });

    // Other bytes for the same challenge, even well formed and signed, cannot pick the sale up.
    const other = await pay(payment, Ed25519Keypair.generate());
    expect(await settle(chain, other.header)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });

    const tenMinutesLater = new Date(NOW.getTime() + 600_000);
    expect((await paidCall(tenMinutesLater)).status).toBe(402);
    expect(calls.reads).toHaveLength(2 * LIMITS.chainReadAfterWriteTries);

    state.read = (digest) => (digest === signed.digest ? landed(Buffer.from(signed.txBytesBase64, 'base64')) : null);
    const nextWindow = new Date(tenMinutesLater.getTime() + LIMITS.sellerRecheckIntervalMs);
    const delivered = await paidCall(nextWindow);
    expect(delivered.status).toBe(200);
    expect(JSON.parse(delivered.body)).toMatchObject({ address: CHECKED });
    const receipt = JSON.parse(Buffer.from(delivered.headers['X-PAYMENT-RESPONSE'] ?? '', 'base64').toString('utf8'));
    expect(receipt).toEqual({ success: true, network: 'sui:mainnet', transaction: signed.digest, payer: BUYER });
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'settled', digest: signed.digest, settledAt: nextWindow });

    expect((await paidCall(nextWindow)).status).toBe(409);
    expect(calls.executions).toEqual([signed.digest]);
  });

  const executionUnknown = () => {
    throw new ChainError('UPSTREAM', 'Tatum executeTransaction: gateway error; the transaction may have landed', true);
  };

  it('rechecks a waiting sale at most once per LIMITS.sellerRecheckIntervalMs window, answering one too soon as waiting, with Retry-After and no chain read (C21, C22)', async () => {
    const { chain, calls } = stubChain({ execute: executionUnknown });
    const payment = asBuyer(await call(chain));
    const { header } = await pay(payment);
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const paidCall = (now: Date) => call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, now });
    expect(NOW.getTime() % LIMITS.sellerRecheckIntervalMs).toBe(0);

    expect(JSON.parse((await paidCall(at(0))).body)).toEqual({ error: SETTLE_REASONS.unconfirmed });
    const first = await paidCall(at(1_000));
    expect(first.status).toBe(402);
    expect(first.headers['Retry-After']).toBeUndefined();
    expect(calls.reads).toHaveLength(2 * LIMITS.chainReadAfterWriteTries);

    const tooSoon = await paidCall(at(2_000));
    expect(tooSoon).toMatchObject({ status: 402, headers: { 'Retry-After': '28' } });
    expect(JSON.parse(tooSoon.body)).toEqual({ error: SETTLE_REASONS.unconfirmed });
    expect(await settle(chain, header, { now: at(LIMITS.sellerRecheckIntervalMs - 1) })).toEqual({
      ok: false,
      status: 402,
      reason: SETTLE_REASONS.unconfirmed,
      retryAfterSeconds: 1,
    });
    expect(calls.reads).toHaveLength(2 * LIMITS.chainReadAfterWriteTries);

    expect((await paidCall(at(LIMITS.sellerRecheckIntervalMs))).status).toBe(402);
    expect(calls.reads).toHaveLength(3 * LIMITS.chainReadAfterWriteTries);
    expect(calls.executions).toHaveLength(1);
  });

  it('closes a waiting sale for good once the epoch is past its window and LIMITS.paymentReleaseReads reads after that are all NOT_FOUND, and never reads it again (C21)', async () => {
    const { chain, state, calls } = stubChain({ execute: executionUnknown });
    const payment = asBuyer(await call(chain));
    const { signed, header } = await pay(payment);
    expect(payment.maxEpoch).toBe(EPOCH + 1n);
    // Each step is one full epoch cache after the last, so every recheck reads the epoch set before it.
    const step = (n: number) => new Date(NOW.getTime() + n * LIMITS.epochCacheMs);
    const recheck = (now: Date) => settle(chain, header, { now });
    const waiting = { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed };
    const tries = LIMITS.chainReadAfterWriteTries;

    expect(await recheck(step(0))).toEqual(waiting);
    // At the window's last epoch the bytes can still land, so the sale waits.
    state.epoch = EPOCH + 1n;
    expect(await recheck(step(1))).toEqual(waiting);
    expect(calls.reads).toHaveLength(2 * tries);

    // Past the window, a final read the chain cannot answer leaves it waiting too.
    state.epoch = EPOCH + 2n;
    state.read = () => {
      throw new ChainError('UPSTREAM', 'Tatum getTransactionResult: gateway error', true);
    };
    expect(await recheck(step(2))).toEqual(waiting);
    expect(calls.reads).toHaveLength(3 * tries + 1);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'rejected', digest: signed.digest, settledAt: null });

    state.read = () => null;
    waits.length = 0;
    expect(await recheck(step(3))).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.lapsed });
    const closedAfter = 4 * tries + 1 + LIMITS.paymentReleaseReads;
    expect(calls.reads).toHaveLength(closedAfter);
    expect(waits.slice(tries - 1)).toEqual(Array<number>(LIMITS.paymentReleaseReads - 1).fill(LIMITS.settlementPollIntervalMs));
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'rejected', digest: signed.digest, settledAt: step(3) });

    expect(await recheck(step(4))).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });
    expect(calls.reads).toHaveLength(closedAfter);
    expect(calls.executions).toEqual([signed.digest]);
  });

  it('never closes a waiting sale on fewer than LIMITS.paymentReleaseReads misses after its window: a payment found on the last of them settles (C29)', async () => {
    const { chain, state, calls } = stubChain({ execute: executionUnknown });
    const payment = asBuyer(await call(chain));
    const { signed, header } = await pay(payment);
    const tries = LIMITS.chainReadAfterWriteTries;
    expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed });
    expect(LIMITS.paymentReleaseReads).toBeGreaterThan(1);

    // The window has closed, and a lagging node misses the payment on every read but the last one after that.
    state.epoch = EPOCH + 2n;
    const lastRead = 2 * tries + LIMITS.paymentReleaseReads;
    state.read = () => (calls.reads.length < lastRead ? null : landed(Buffer.from(signed.txBytesBase64, 'base64')));
    const later = new Date(NOW.getTime() + LIMITS.epochCacheMs);
    expect(await settle(chain, header, { now: later })).toEqual({ ok: true, digest: signed.digest, payer: BUYER });
    expect(calls.reads).toHaveLength(lastRead);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'settled', digest: signed.digest, settledAt: later });
    expect(calls.executions).toEqual([signed.digest]);
  });

  it('lets exactly one of two payments racing for one challenge claim it', async () => {
    const { chain, calls } = stubChain();
    const issued = await issue(chain);
    const payment = asBuyer(issued);
    const first = await pay(payment);
    const second = await pay(payment, Ed25519Keypair.generate());
    const outcomes = await Promise.all([settle(chain, first.header), settle(chain, second.header)]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, status: 409, reason: SETTLE_REASONS.used }]);
    expect(calls.executions).toHaveLength(1);
  });

  it('never lets one payment pay two challenges that share a nonce and an epoch', async () => {
    const { chain, calls } = stubChain();
    const first = await issue(chain);
    const payment = asBuyer(first);
    const twinId = sellerChallengeId({ nonce: Number(payment.nonce), minEpoch: EPOCH, random: 7 }, BINDING);
    await db.insert(sellerSales).values({
      challengeId: twinId,
      amountAtomic: PRICE,
      recipient: PAY_TO,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + LIMITS.sellerChallengeTtlMs),
    });
    const { signed, header } = await pay(payment);
    expect(await settle(chain, header)).toMatchObject({ ok: true, digest: signed.digest });

    const replay = headerFor({ sender: BUYER, txBytes: Buffer.from(signed.txBytesBase64, 'base64'), signature: signed.signature, challengeId: twinId });
    expect(await settle(chain, replay)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.presented });
    expect(await saleOf(twinId)).toMatchObject({ status: 'rejected', digest: null });
    expect(calls.executions).toEqual([signed.digest]);
  });

  it('refuses a header that is not exactly the t2000 payment shape, before reading any sale', async () => {
    const { chain } = stubChain();
    const issued = await issue(chain);
    const { signed } = await pay(asBuyer(issued));
    const parts = { sender: BUYER, txBytes: Buffer.from(signed.txBytesBase64, 'base64'), signature: signed.signature, challengeId: issued.challengeId };
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    const bad = [
      '',
      'not base64 at all!',
      b64('not json'),
      b64('[]'),
      headerFor(parts, { extra: 1 }),
      headerFor(parts, { network: 'sui:testnet' }),
      headerFor(parts, { x402Version: 2 }),
      headerFor({ ...parts, sender: '0xnot-an-address' }),
      headerFor({ ...parts, challengeId: 'x'.repeat(LIMITS.challengeIdMaxLength + 1) }),
      headerFor({ ...parts, signature: 'not base64!' }),
      b64(JSON.stringify({ padding: 'a'.repeat(LIMITS.challengeMaxBytes) })),
    ];
    for (const header of bad) {
      expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.header });
    }
    expect((await saleOf(issued.challengeId)).status).toBe('issued');
  });

  const DAY_MS = 86_400_000;
  // The start of the UTC day `days` after NOW's, a day no other test sends payments in.
  const dayAfter = (days: number) => Math.floor(NOW.getTime() / DAY_MS) * DAY_MS + days * DAY_MS;

  it('stops a flood of payments signed by empty wallets from one caller at 3 a minute and 20 a day, sending none past either (C22, C34)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { chain, calls } = stubChain({ execute: failedOnChain });
    const at = (minute: number, second: number) => new Date(dayAfter(2) + minute * 60_000 + second * 1_000);
    const attempt = async (now: Date, callerKey = '203.0.113.66') => {
      const payment = asBuyer(await call(chain, { callerKey, now }));
      const { header } = await pay(payment, Ed25519Keypair.generate());
      return { header, challengeId: payment.challengeId ?? '', answer: await call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, callerKey, now }) };
    };
    expect([LIMITS.sellerExecutesPerClientPerMinute, LIMITS.sellerExecutesPerClientPerDay]).toEqual([3, 20]);

    const statuses: number[][] = [];
    const refused: Array<Awaited<ReturnType<typeof attempt>>> = [];
    for (let minute = 0; minute < 7; minute++) {
      const row: number[] = [];
      for (let second = 1; second <= 4; second++) {
        const sent = await attempt(at(minute, second));
        row.push(sent.answer.status);
        if (sent.answer.status === 429) refused.push(sent);
      }
      statuses.push(row);
    }
    // Sui runs an empty wallet's send and fails it, a definite answer: 402. A send the minute's
    // limit turns away counts nothing toward the day, so the day's 20th send is in minute 6.
    expect(statuses).toEqual([...Array<number[]>(6).fill([402, 402, 402, 429]), [402, 402, 429, 429]]);
    expect(calls.executions).toHaveLength(20);
    const [firstRefused, , , , , , dayRefused, minuteRefused] = refused;
    expect(firstRefused?.answer).toMatchObject({ status: 429, headers: { 'Retry-After': '56' } });
    expect(JSON.parse(firstRefused?.answer.body ?? '{}')).toEqual({ error: SETTLE_REASONS.executeRate });
    expect(dayRefused?.answer).toMatchObject({ status: 429, headers: { 'Retry-After': String(DAY_MS / 1_000 - 6 * 60 - 3) } });
    expect(JSON.parse(dayRefused?.answer.body ?? '{}')).toEqual({ error: SETTLE_REASONS.executeRateToday });
    expect(JSON.parse(minuteRefused?.answer.body ?? '{}')).toEqual({ error: SETTLE_REASONS.executeRate });

    expect((await attempt(at(7, 1))).answer.status).toBe(429);
    expect(calls.executions).toHaveLength(20);
    // Another caller still has its own minute and day.
    expect((await attempt(at(7, 2), '203.0.113.67')).answer.status).toBe(402);
    expect(calls.executions).toHaveLength(21);

    // A sale turned away keeps no digest, so its bytes can never send rechecks to the chain.
    expect(await saleOf(firstRefused?.challengeId ?? '')).toMatchObject({ status: 'rejected', digest: null, settledAt: null });
    const again = await call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': firstRefused?.header ?? '' }, callerKey: '203.0.113.68', now: at(8, 1) });
    expect(JSON.parse(again.body)).toEqual({ error: SETTLE_REASONS.used });
    expect(calls.executions).toHaveLength(21);
    expect(calls.reads).toEqual([]);
    const lines = warn.mock.calls.map((line) => line.join(' '));
    expect([lines.filter((line) => line.endsWith('client:minute')).length, lines.filter((line) => line.endsWith('client:day')).length]).toEqual([7, 2]);
    expect(lines.every((line) => line.startsWith('[ellai seller] execute_limited seller-executes:client:'))).toBe(true);
    warn.mockRestore();
  });

  it('rechecks waiting sales at most LIMITS.sellerRechecksPerDayGlobal times a day across every sale, answering the next as still waiting with Retry-After and no chain read, and a settled sale asking to be served again with 503 (C22)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { chain, calls } = stubChain({ execute: executionUnknown });
    const at = (ms: number) => new Date(dayAfter(4) + ms);
    const waiting = { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed };
    // Two sales left waiting by sends Tatum gave no answer to.
    const headers: string[] = [];
    for (const second of [0, 1]) {
      const issued = await issue(chain, RESOURCE, at(second * 1_000));
      const { header } = await pay(asBuyer(issued));
      expect(await settle(chain, header, { now: at(second * 1_000) })).toEqual(waiting);
      headers.push(header);
    }
    const readsBefore = calls.reads.length;
    expect(LIMITS.sellerRechecksPerDayGlobal).toBe(100);

    // Each sale once in each of 50 recheck windows: 100 rechecks, each reading the chain.
    for (let window = 1; window <= 50; window++) {
      for (const header of headers) expect(await settle(chain, header, { now: at(window * LIMITS.sellerRecheckIntervalMs) })).toEqual(waiting);
    }
    expect(calls.reads.length - readsBefore).toBe(100 * LIMITS.chainReadAfterWriteTries);
    // A new window for the sale, but not for the day.
    const nextMs = 51 * LIMITS.sellerRecheckIntervalMs;
    expect(await settle(chain, headers[0] ?? '', { now: at(nextMs) })).toEqual({ ...waiting, retryAfterSeconds: (DAY_MS - nextMs) / 1_000 });
    expect(await settle(chain, headers[1] ?? '', { now: at(nextMs) })).toMatchObject({ ...waiting, retryAfterSeconds: (DAY_MS - nextMs) / 1_000 });
    expect(calls.reads.length - readsBefore).toBe(100 * LIMITS.chainReadAfterWriteTries);
    expect(calls.executions).toHaveLength(2);

    // A sale that settled but was never served shares the same day.
    const served = stubChain();
    const settledSale = await issue(served.chain, RESOURCE, at(2_000));
    const { header: settledHeader } = await pay(asBuyer(settledSale));
    expect(await settle(served.chain, settledHeader, { now: at(2_000) })).toMatchObject({ ok: true });
    expect(await settle(served.chain, settledHeader, { now: at(nextMs) })).toEqual({
      ok: false,
      status: 503,
      reason: SETTLE_REASONS.deliverToday,
      retryAfterSeconds: (DAY_MS - nextMs) / 1_000,
    });
    // The turn the day turned away is given back, since no check was read for it.
    expect(await saleOf(settledSale.challengeId)).toMatchObject({ status: 'settled', deliveredAt: null, redeliveries: 0 });
    expect(served.calls.executions).toHaveLength(1);
    expect(served.calls.reads).toEqual([]);
    expect(error.mock.calls.map((line) => line.join(' '))).toEqual(['[ellai seller] quota_spent seller-rechecks:day']);
    error.mockRestore();
  });

  it('sends at most LIMITS.sellerExecutesPerDayGlobal payments a day across every caller, turning the next away with 503 and logging the spent quota once (C22)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { chain, calls } = stubChain({ execute: failedOnChain });
    const now = new Date(dayAfter(3) + 60_000);
    const paid = async (callerKey: string) => {
      const issued = await issue(chain, RESOURCE, now);
      const { header } = await pay(asBuyer(issued), Ed25519Keypair.generate());
      return { challengeId: issued.challengeId, outcome: await settle(chain, header, { callerKey, now }) };
    };
    expect(LIMITS.sellerExecutesPerDayGlobal).toBe(150);
    for (let i = 0; i < LIMITS.sellerExecutesPerDayGlobal; i++) {
      // Three from each caller, the most one may send in a minute.
      expect((await paid(`198.51.100.${Math.floor(i / 3)}`)).outcome).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.failed });
    }
    expect(calls.executions).toHaveLength(150);

    const busy = await paid('192.0.2.151');
    expect(busy.outcome).toEqual({ ok: false, status: 503, reason: SETTLE_REASONS.executeBusy, retryAfterSeconds: DAY_MS / 1_000 - 60 });
    expect(await saleOf(busy.challengeId)).toMatchObject({ status: 'rejected', digest: null, settledAt: null });
    expect((await paid('192.0.2.152')).outcome).toMatchObject({ ok: false, status: 503 });
    expect(calls.executions).toHaveLength(150);
    expect(calls.reads).toEqual([]);
    expect(error.mock.calls.map((line) => line.join(' '))).toEqual(['[ellai seller] quota_spent seller-executes:day']);
    error.mockRestore();
  });

  it("closes a sale whose send Ellai's Tatum budget refused, nothing sent, with 503 until the UTC day ends and no chain read; a refusal after the send keeps its sale waiting (C22, C29)", async () => {
    const now = new Date(dayAfter(5) + 60_000);
    const notSent = () => {
      throw new ChainError('BUDGET', 'Tatum executeTransaction: the request budget refused the send; transaction was not sent');
    };
    const { chain, calls } = stubChain({ execute: notSent });
    const tomorrow = { ok: false, status: 503, reason: SETTLE_REASONS.chainUnavailableToday, retryAfterSeconds: DAY_MS / 1_000 - 60 };

    const issued = await issue(chain, RESOURCE, now);
    const { signed, header } = await pay(asBuyer(issued));
    expect(await settle(chain, header, { now })).toEqual(tomorrow);
    expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'rejected', digest: null, payer: BUYER, settledAt: null });
    // The same bytes find a closed sale, not one waiting on the chain.
    expect(await settle(chain, header, { now: new Date(now.getTime() + LIMITS.sellerRecheckIntervalMs) })).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });

    const unpaid = await call(chain, { now });
    const paid = await call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': (await pay(asBuyer(unpaid))).header }, now });
    expect(paid).toMatchObject({ status: 503, headers: { 'Retry-After': String(DAY_MS / 1_000 - 60) } });
    expect(JSON.parse(paid.body)).toEqual({ error: SETTLE_REASONS.chainUnavailableToday });
    expect(calls.executions).toHaveLength(2);
    expect(calls.executions[0]).toBe(signed.digest);
    expect(calls.reads).toEqual([]);

    // Core reports a budget refusal after the bytes went out as an unknown outcome, never BUDGET.
    const afterSend = stubChain({
      execute: () => {
        throw new ChainError('RATE_LIMITED', 'Tatum executeTransaction: the request budget refused a request after the bytes were sent; transaction may have landed', false);
      },
    });
    const waiting = await issue(afterSend.chain, RESOURCE, now);
    const sent = await pay(asBuyer(waiting));
    expect(await settle(afterSend.chain, sent.header, { now })).toEqual({ ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed });
    expect(await saleOf(waiting.challengeId)).toMatchObject({ status: 'rejected', digest: sent.signed.digest, settledAt: null });
    expect(afterSend.calls.reads).toEqual(Array<string>(LIMITS.chainReadAfterWriteTries).fill(sent.signed.digest));
  });

  it('serves a settled sale again at most LIMITS.sellerRedeliveriesPerSale times however often its check fails, then answers 410 for good with nothing read and none of the recheck day spent (C22, C29)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(findMemoryAccount).mockRejectedValue(new Error('the memory account could not be read'));
    const { chain, calls } = stubChain();
    // One recheck window apart, in a day no other test rechecks in.
    const at = (window: number) => new Date(dayAfter(7) + window * LIMITS.sellerRecheckIntervalMs);
    const payment = asBuyer(await call(chain, { now: at(0) }));
    const { header } = await pay(payment);
    const paidCall = (now: Date) => call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, now });
    const perSale = LIMITS.sellerRedeliveriesPerSale;
    expect([perSale, LIMITS.sellerRechecksPerDayGlobal]).toEqual([5, 100]);

    // The answer that came with the payment, then every turn the sale has.
    const statuses: number[] = [];
    for (let window = 0; window <= perSale; window++) statuses.push((await paidCall(at(window))).status);
    expect(statuses).toEqual(Array<number>(1 + perSale).fill(502));
    expect(calls.balances).toHaveLength(1 + perSale);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'settled', deliveredAt: null, redeliveries: perSale });

    const spent = await paidCall(at(perSale + 1));
    expect(spent.status).toBe(410);
    expect(spent.headers['Retry-After']).toBeUndefined();
    expect(JSON.parse(spent.body)).toEqual({ error: SETTLE_REASONS.deliverExhausted });
    // As many more tries as the day holds, each in a window of its own.
    for (let window = perSale + 2; window < perSale + 2 + LIMITS.sellerRechecksPerDayGlobal; window++) {
      expect((await paidCall(at(window))).status).toBe(410);
    }
    expect(calls.balances).toHaveLength(1 + perSale);
    expect(calls.executions).toHaveLength(1);
    expect(calls.reads).toEqual([]);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ redeliveries: perSale });
    expect(warn.mock.calls.map((line) => line.join(' '))).toEqual(
      Array<string>(1 + LIMITS.sellerRechecksPerDayGlobal).fill('[ellai seller] redelivery_limited seller-redeliveries:sale'),
    );
    warn.mockRestore();

    // Had those tries spent the day, this buyer's waiting sale would be turned away unread.
    const other = stubChain({ execute: executionUnknown });
    const { header: otherHeader } = await pay(asBuyer(await issue(other.chain, RESOURCE, at(0))));
    const waiting = { ok: false, status: 402, reason: SETTLE_REASONS.unconfirmed };
    expect(await settle(other.chain, otherHeader, { now: at(0) })).toEqual(waiting);
    expect(await settle(other.chain, otherHeader, { now: at(perSale + 2 + LIMITS.sellerRechecksPerDayGlobal) })).toEqual(waiting);
    expect(other.calls.reads).toHaveLength(2 * LIMITS.chainReadAfterWriteTries);
  });

  it('starts no chain read past SELLER_READ_BY_MS when Tatum is slow, so the paid request ends by SELLER_END_BY_MS, and a recheck cut short leaves the sale waiting, never lapsed (C21, C29)', async () => {
    // Every read as slow as core lets one be; a send slower still, as its rounds of retries can be.
    const delays = { execute: 120_000, read: LONGEST_READ_MS, epoch: LONGEST_READ_MS, balances: LONGEST_READ_MS };
    const slow = slowChain(delays, { execute: executionUnknown });
    const payment = asBuyer(await call(slow.chain));
    const { signed, header } = await pay(payment);
    const paidCall = (now: Date) => call(slow.chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, now, clock: slow.clock, sleep: slow.sleep });
    const startedRequest = () => {
      slow.time.ms = 0;
      slow.starts.length = 0;
    };
    const unconfirmed = { error: SETTLE_REASONS.unconfirmed };

    startedRequest();
    const first = await paidCall(NOW);
    expect(JSON.parse(first.body)).toEqual(unconfirmed);
    // The send, then reads 33 s long and 3 s apart until the next would begin past the deadline.
    expect(slow.starts).toEqual([0, 120_000, 156_000, 192_000, 228_000]);
    expect(slow.starts.every((ms) => ms < SELLER_READ_BY_MS)).toBe(true);
    expect(slow.time.ms).toBeLessThanOrEqual(SELLER_END_BY_MS);
    expect(slow.calls.reads).toHaveLength(4);

    // Past its window, the reads after the window are cut short too: one miss never closes the sale.
    slow.state.epoch = EPOCH + 2n;
    startedRequest();
    const later = new Date(NOW.getTime() + LIMITS.epochCacheMs);
    expect(JSON.parse((await paidCall(later)).body)).toEqual(unconfirmed);
    const tries = LIMITS.chainReadAfterWriteTries;
    const outcomeReads = Array.from({ length: tries }, (_, i) => i * (LONGEST_READ_MS + LIMITS.chainReadAfterWriteDelayMs));
    const epochRead = tries * LONGEST_READ_MS + (tries - 1) * LIMITS.chainReadAfterWriteDelayMs;
    expect(slow.starts).toEqual([...outcomeReads, epochRead, epochRead + LONGEST_READ_MS]);
    expect(slow.starts.every((ms) => ms < SELLER_READ_BY_MS)).toBe(true);
    expect(slow.time.ms).toBeLessThanOrEqual(SELLER_END_BY_MS);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'rejected', digest: signed.digest, settledAt: null });

    // The same header, once the chain shows the payment, settles and delivers.
    slow.state.read = () => landed(Buffer.from(signed.txBytesBase64, 'base64'));
    startedRequest();
    const delivered = await paidCall(new Date(later.getTime() + LIMITS.sellerRecheckIntervalMs));
    expect(delivered.status).toBe(200);
    expect(slow.calls.executions).toEqual([signed.digest]);
  });
});

describe('handleWalletCheck', () => {
  it('sells a wallet check: a 402 when unpaid, then a 200 with the check and a receipt carrying the digest', async () => {
    const { chain, calls } = stubChain({ blobs: 3 });
    vi.mocked(findMemoryAccount).mockResolvedValue({ accountId: OTHER, delegates: [] });
    const unpaid = await call(chain);
    expect(unpaid.status).toBe(402);
    const { signed, header } = await pay(asBuyer(unpaid));

    const paid = await call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header } });
    expect(paid.status).toBe(200);
    const receipt = JSON.parse(Buffer.from(paid.headers['X-PAYMENT-RESPONSE'] ?? '', 'base64').toString('utf8'));
    expect(receipt).toEqual({ success: true, network: 'sui:mainnet', transaction: signed.digest, payer: BUYER });
    const check = JSON.parse(paid.body);
    expect(check).toMatchObject({
      address: CHECKED,
      sui: '1.5 SUI',
      usdcAddressBalance: '0.05 USDC',
      usdcCoins: '1.234567 USDC',
      hasWalrusMemoryAccount: true,
      walrusBlobs: 3,
    });
    expect(Number.isNaN(Date.parse(check.checkedAt))).toBe(false);
    expect(calls.balances).toEqual([CHECKED]);
    expect(vi.mocked(findMemoryAccount)).toHaveBeenCalledWith(chain, CHECKED);
  });

  const paidReceipt = (answer: SellerResponse) => JSON.parse(Buffer.from(answer.headers['X-PAYMENT-RESPONSE'] ?? '', 'base64').toString('utf8'));

  it('delivers once to the same header after a check that failed once the payment settled, refusing other bytes for that sale and the same header once delivered (C29)', async () => {
    const { chain, calls } = stubChain();
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const payment = asBuyer(await call(chain));
    const { signed, header } = await pay(payment);
    const paidCall = (now: Date, value = header) => call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': value }, now });
    const issuedReceipt = { success: true, network: 'sui:mainnet', transaction: signed.digest, payer: BUYER };

    vi.mocked(findMemoryAccount).mockRejectedValueOnce(new Error('the memory account could not be read'));
    const failed = await paidCall(at(0));
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({ error: HANDLER_MESSAGES.undelivered });
    expect(paidReceipt(failed)).toEqual(issuedReceipt);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'settled', digest: signed.digest, settledAt: at(0), deliveredAt: null });

    // Other bytes for the settled sale, well formed and signed, are refused and spend none of its turn.
    const other = await pay(payment, Ed25519Keypair.generate());
    const refused = await paidCall(at(1_000), other.header);
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toEqual({ error: SETTLE_REASONS.used });

    const delivered = await paidCall(at(1_000));
    expect(delivered.status).toBe(200);
    expect(JSON.parse(delivered.body)).toMatchObject({ address: CHECKED, sui: '1.5 SUI', usdcAddressBalance: '0.05 USDC' });
    expect(paidReceipt(delivered)).toEqual(issuedReceipt);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'settled', settledAt: at(0), deliveredAt: at(1_000) });

    const again = await paidCall(at(LIMITS.sellerRecheckIntervalMs));
    expect(again.status).toBe(409);
    expect(JSON.parse(again.body)).toEqual({ error: SETTLE_REASONS.used });
    expect(calls.executions).toEqual([signed.digest]);
    expect(calls.reads).toEqual([]);
    expect(calls.balances).toEqual([CHECKED, CHECKED]);
  });

  it('serves a settled sale again at most once per LIMITS.sellerRecheckIntervalMs window, answering one too soon with 429 and Retry-After and no check read (C22, C29)', async () => {
    const { chain, calls } = stubChain();
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const { header } = await pay(asBuyer(await call(chain)));
    const paidCall = (now: Date) => call(chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, now });
    expect(NOW.getTime() % LIMITS.sellerRecheckIntervalMs).toBe(0);

    vi.mocked(findMemoryAccount).mockRejectedValueOnce(new Error('the memory account could not be read'));
    vi.mocked(findMemoryAccount).mockRejectedValueOnce(new Error('the memory account could not be read'));
    expect((await paidCall(at(0))).status).toBe(502);
    expect((await paidCall(at(1_000))).status).toBe(502);
    const tooSoon = await paidCall(at(2_000));
    expect(tooSoon).toMatchObject({ status: 429, headers: { 'Retry-After': '28' } });
    expect(JSON.parse(tooSoon.body)).toEqual({ error: SETTLE_REASONS.deliverSoon });
    expect(calls.balances).toHaveLength(2);

    expect((await paidCall(at(LIMITS.sellerRecheckIntervalMs))).status).toBe(200);
    expect(calls.balances).toHaveLength(3);
    expect(calls.executions).toHaveLength(1);
  });

  it('starts no step of the check past SELLER_READ_BY_MS, for the delivery that comes with the payment and for one asked for again, leaving the sale undelivered for the same header (C21, C29)', async () => {
    const delays = { execute: SELLER_READ_BY_MS - 1, read: 0, epoch: 0, balances: LONGEST_READ_MS };
    const slow = slowChain(delays);
    const payment = asBuyer(await call(slow.chain));
    const { header } = await pay(payment);
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const paidCall = (now: Date) => {
      slow.time.ms = 0;
      return call(slow.chain, { headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, now, clock: slow.clock, sleep: slow.sleep });
    };

    // A send that ends just before the deadline: the balance read still begins, the memory account read does not.
    const first = await paidCall(at(0));
    expect(first.status).toBe(502);
    expect(JSON.parse(first.body)).toEqual({ error: HANDLER_MESSAGES.undelivered });
    expect(slow.calls.balances).toHaveLength(1);
    expect(vi.mocked(findMemoryAccount)).not.toHaveBeenCalled();
    expect(slow.time.ms).toBeLessThanOrEqual(SELLER_END_BY_MS);

    // Asked for again, a balance read that runs past the deadline stops the check the same way.
    delays.balances = SELLER_READ_BY_MS;
    expect((await paidCall(at(LIMITS.sellerRecheckIntervalMs))).status).toBe(502);
    expect(slow.calls.balances).toHaveLength(2);
    expect(vi.mocked(findMemoryAccount)).not.toHaveBeenCalled();
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ status: 'settled', deliveredAt: null, redeliveries: 1 });

    delays.balances = LONGEST_READ_MS;
    expect((await paidCall(at(2 * LIMITS.sellerRecheckIntervalMs))).status).toBe(200);
    expect(await saleOf(payment.challengeId ?? '')).toMatchObject({ deliveredAt: at(2 * LIMITS.sellerRecheckIntervalMs), redeliveries: 2 });
    expect(slow.calls.executions).toHaveLength(1);
  });

  it('answers 405 to anything but POST and 400 to a body without one Sui address, before counting or reading the chain', async () => {
    const { chain, calls } = stubChain();
    const callerKey = 'caller-shape';
    const notPost = await call(chain, { method: 'GET', callerKey });
    expect(notPost).toMatchObject({ status: 405, headers: { Allow: 'POST' } });
    for (const body of ['', '{}', 'null', JSON.stringify({ address: '0xnope' }), JSON.stringify({ address: CHECKED, more: 1 }), `{"address":"${'a'.repeat(LIMITS.challengeMaxBytes)}"}`]) {
      const answer = await call(chain, { body, callerKey });
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toEqual({ error: HANDLER_MESSAGES.body });
    }
    const twice = await call(chain, { headers: { 'X-PAYMENT': 'a', 'x-payment': 'b' }, callerKey });
    expect(JSON.parse(twice.body)).toEqual({ error: HANDLER_MESSAGES.headers });
    expect(calls.epochs).toBe(0);
    expect((await call(chain, { callerKey })).status).toBe(402);
  });

  it('returns 429 on the eleventh unpaid request from one caller in a minute, and counts each caller and each minute apart (C22)', async () => {
    const { chain, calls } = stubChain();
    const callerKey = '203.0.113.7';
    for (let i = 0; i < LIMITS.sellerChallengesPerMinute; i++) {
      expect((await call(chain, { callerKey, now: new Date(NOW.getTime() + i * 1_000) })).status).toBe(402);
    }
    const limited = await call(chain, { callerKey, now: new Date(NOW.getTime() + 30_000) });
    expect(limited).toMatchObject({ status: 429, headers: { 'Retry-After': '30' } });
    expect(JSON.parse(limited.body)).toEqual({ error: HANDLER_MESSAGES.rate });
    expect(calls.epochs).toBe(1);

    expect((await call(chain, { callerKey: '203.0.113.8', now: new Date(NOW.getTime() + 30_000) })).status).toBe(402);
    expect((await call(chain, { callerKey, now: new Date(NOW.getTime() + 60_000) })).status).toBe(402);
  });

  it('serves 100 callers in a minute from one epoch read, holds every caller together to LIMITS.sellerChallengesPerMinuteGlobal, and reads the epoch again only once LIMITS.epochCacheMs has passed (C22)', async () => {
    const { chain, calls } = stubChain();
    // Two hours after NOW, a minute no other test counts in.
    const minute = NOW.getTime() + 7_200_000;
    const at = (ms: number) => new Date(minute + ms);
    const before = await saleCount();

    const burst = await Promise.all(Array.from({ length: 100 }, (_, i) => call(chain, { callerKey: `198.51.100.${i}`, now: at(0) })));
    expect(burst.map((answer) => answer.status)).toEqual(Array<number>(100).fill(402));
    expect(calls.epochs).toBe(1);

    for (let i = 100; i < LIMITS.sellerChallengesPerMinuteGlobal; i++) {
      expect((await call(chain, { callerKey: `caller-${i}`, now: at(i * 10) })).status).toBe(402);
    }
    const busy = await call(chain, { callerKey: 'caller-never-seen', now: at(30_000) });
    expect(busy).toMatchObject({ status: 429, headers: { 'Retry-After': '30' } });
    expect(JSON.parse(busy.body)).toEqual({ error: HANDLER_MESSAGES.busy });
    expect(calls.epochs).toBe(1);
    expect(await saleCount()).toBe(before + LIMITS.sellerChallengesPerMinuteGlobal);

    // The next minute is a new shared window, still served from the one reading.
    expect((await call(chain, { callerKey: 'caller-never-seen', now: at(60_000) })).status).toBe(402);
    expect(calls.epochs).toBe(1);
    expect((await call(chain, { callerKey: 'caller-before-the-cache-ends', now: at(LIMITS.epochCacheMs - 1) })).status).toBe(402);
    expect(calls.epochs).toBe(1);
    // A reading LIMITS.epochCacheMs old is read again, once.
    expect((await call(chain, { callerKey: 'caller-after-the-cache', now: at(LIMITS.epochCacheMs) })).status).toBe(402);
    expect(calls.epochs).toBe(2);
  });

  it('answers 300 unpaid challenges during an outage with 503 from one epoch read per LIMITS.epochFailureCacheMs, storing nothing (C22)', async () => {
    const { chain, state, calls } = stubChain({ epoch: new ChainError('UPSTREAM', 'Tatum getEpoch: gateway error', true) });
    // Half a minute into a minute no other test counts in, so all 300 fit one shared minute and
    // the next failure window falls in the next minute.
    const start = NOW.getTime() + 6 * 3_600_000 + 30_000;
    const at = (ms: number) => new Date(start + ms);
    const spacing = LIMITS.epochFailureCacheMs / 300;
    const before = await saleCount();

    const answers: SellerResponse[] = [];
    for (let i = 0; i < 300; i++) answers.push(await call(chain, { callerKey: `outage-caller-${i}`, now: at(i * spacing) }));
    expect(answers.map((answer) => answer.status)).toEqual(Array<number>(300).fill(503));
    expect(JSON.parse(answers[299]?.body ?? '{}')).toEqual({ error: HANDLER_MESSAGES.unavailable });
    expect(calls.epochs).toBe(1);
    expect(await saleCount()).toBe(before);

    // The next window reads once more, and a chain that answers again is used at once.
    expect((await call(chain, { callerKey: 'outage-next-window', now: at(LIMITS.epochFailureCacheMs) })).status).toBe(503);
    expect(calls.epochs).toBe(2);
    state.epoch = EPOCH;
    expect((await call(chain, { callerKey: 'outage-over', now: at(2 * LIMITS.epochFailureCacheMs) })).status).toBe(402);
    expect(calls.epochs).toBe(3);
  });

  it('never puts the payment header, its bytes or its signature in any response, whatever the outcome (C19)', async () => {
    const MARKER = 'LEAKMARKER';
    const { chain } = stubChain();
    const responses: Array<[SellerResponse, string[]]> = [];
    const send = async (header: string, secrets: string[]) => {
      responses.push([await call(chain, { headers: { 'X-PAYMENT': header } }), [header, ...secrets]]);
    };

    const good = await pay(asBuyer(await call(chain)));
    const goodSecrets = [good.signed.txBytesBase64, good.signed.signature];
    await send(good.header, goodSecrets);
    await send(good.header, goodSecrets);

    const other = asBuyer(await call(chain));
    const txBytes = await handBuilt(other);
    const strangerSignature = (await Ed25519Keypair.generate().signTransaction(txBytes)).signature;
    await send(headerFor({ sender: BUYER, txBytes, signature: strangerSignature, challengeId: other.challengeId ?? '' }), [toBase64(txBytes), strangerSignature]);
    await send(headerFor({ sender: BUYER, txBytes, signature: strangerSignature, challengeId: MARKER }), [toBase64(txBytes), MARKER]);
    await send(headerFor({ sender: BUYER, txBytes, signature: strangerSignature, challengeId: other.challengeId ?? '' }, { note: MARKER }), [MARKER]);
    await send(`${MARKER}!!`, [MARKER]);

    const undelivered = await pay(asBuyer(await call(chain)));
    vi.mocked(findMemoryAccount).mockRejectedValue(new Error(`upstream said ${MARKER}`));
    await send(undelivered.header, [undelivered.signed.txBytesBase64, undelivered.signed.signature, MARKER]);

    expect(responses.map(([response]) => response.status)).toEqual([200, 409, 402, 402, 402, 402, 502]);
    for (const [response, secrets] of responses) {
      const everything = JSON.stringify(response);
      for (const secret of secrets) expect(everything).not.toContain(secret);
    }
    const [lastResponse] = responses.at(-1) ?? [];
    expect(JSON.parse(lastResponse?.body ?? '{}')).toEqual({ error: HANDLER_MESSAGES.undelivered });
    expect(lastResponse?.headers['X-PAYMENT-RESPONSE']).toBeDefined();
  });
});

describe('walletCheck', () => {
  it('summarises an address through the chain with exact decimal amounts, and caps the blob count at the page limits of the blob reader', async () => {
    const { chain, calls } = stubChain({ blobs: 2 });
    const deadline = sellerDeadline(Date.now(), Date.now);
    expect(await walletCheck({ chain, address: CHECKED.toUpperCase().replace('0X', '0x'), deadline })).toMatchObject({
      address: CHECKED,
      sui: '1.5 SUI',
      usdcAddressBalance: '0.05 USDC',
      usdcCoins: '1.234567 USDC',
      hasWalrusMemoryAccount: false,
      walrusBlobs: 2,
    });
    expect(calls.blobs).toEqual([CHECKED]);
    const capped = stubChain({ blobs: 'too many' });
    expect((await walletCheck({ chain: capped.chain, address: CHECKED, deadline })).walrusBlobs).toBe(LIMITS.graphqlMaxPages * LIMITS.graphqlPageSize);
    await expect(walletCheck({ chain, address: '0xnope', deadline })).rejects.toThrow();
    expect(calls.balances).toEqual([CHECKED]);
  });

  it('cuts off a check still waiting on the chain at the end-by time, and starts no step after it (C21)', async () => {
    const { chain, calls } = stubChain();
    let answer: () => void = () => undefined;
    const hanging = {
      ...chain,
      getBalances: (address: string) => {
        calls.balances.push(address);
        return new Promise((resolve) => {
          answer = () => resolve({ usdcAddressBalance: 0n, usdcCoinBalance: 0n, suiTotal: 0n });
        });
      },
    } as Chain;
    const startMs = Date.now();
    const deadline = { clock: Date.now, readByMs: startMs + 10, endByMs: startMs + 30 };

    await expect(walletCheck({ chain: hanging, address: CHECKED, deadline })).rejects.toMatchObject({ name: 'ChainError', code: 'TIMEOUT' });
    // The read that was cut off answers late; the check behind it starts nothing more.
    answer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.balances).toEqual([CHECKED]);
    expect(vi.mocked(findMemoryAccount)).not.toHaveBeenCalled();
    expect(calls.blobs).toEqual([]);
  });
});

describe('the wallet check route', () => {
  it('asks for the ceiling in LIMITS.slowRouteMaxDurationS, since a paid request can wait on the send, the reads after it and the check', () => {
    expect(walletCheckRoute.maxDuration).toBe(LIMITS.slowRouteMaxDurationS);
  });

  it('lets the slowest read begun just before the seller deadline end with LIMITS.paidRequestMarginMs still left under that ceiling (C21)', () => {
    // Core's bounded read: three tries of tatumTimeoutMs, with waits of 1 and 2 retry delays between.
    expect(LIMITS.tatumRetries).toBe(2);
    expect(LONGEST_READ_MS).toBe(3 * LIMITS.tatumTimeoutMs + 3 * LIMITS.tatumRetryDelayMs);
    expect(SELLER_READ_BY_MS + LONGEST_READ_MS).toBe(SELLER_END_BY_MS);
    expect(SELLER_END_BY_MS + LIMITS.paidRequestMarginMs).toBe(walletCheckRoute.maxDuration * 1_000);
    expect(SELLER_READ_BY_MS).toBeGreaterThan(0);
  });
});

describe('sellerPayTo', () => {
  it('pays ELLAI_SELLER_PAYTO when it is set and the gas wallet otherwise', () => {
    const gas = Ed25519Keypair.generate();
    expect(sellerPayTo({ GAS_PRIVATE_KEY: gas.getSecretKey() })).toBe(canonicalSuiAddress(gas.toSuiAddress()));
    expect(sellerPayTo({ GAS_PRIVATE_KEY: gas.getSecretKey(), ELLAI_SELLER_PAYTO: PAY_TO })).toBe(PAY_TO);
    expect(() => sellerPayTo({ GAS_PRIVATE_KEY: 'not a key' })).toThrow(SellerError);
  });
});
