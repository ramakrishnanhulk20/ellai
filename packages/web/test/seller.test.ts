// Covers: Ellai's own wallet check seller on PGlite with a stand-in chain. The 402 it issues
// round-trips through core's parseChallenge into a payment of exactly 0.01 USDC to the pay-to
// address with the nonce and epochs the challenge id carries; a payment is refused for an
// unknown, expired, already-claimed or other-resource challenge, and for a header that is not
// the t2000 shape; bytes paying another recipient or amount or carrying an extra command, and a
// signature that is not the sender's, are refused after the claim and never executed; a
// settlement mismatch is refused and recorded; a challenge pays once and one payment never pays
// two challenges; the unpaid rate limit; the wallet check summary and its blob cap; the pay-to
// fallback; and no response ever carries the payment header, its bytes or its signature.
// Does NOT cover: the live chain or Tatum (`npm run prove:seller` pays one 0.01 USDC live),
// core's own challenge, payment and settlement rules (core's tests), zkLogin or multisig payers,
// two connections racing on one claim (PGlite serves one connection at a time), or the HTTP
// route that will call this handler.
import { randomBytes } from 'node:crypto';
import { type BalanceChange, type Chain, ChainError, type ExecutionResult, type WalrusBlob } from '@ellai/core/chain';
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
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { sellerSales } from '../src/server/db/schema.js';
import { SellerError, issueWalletCheckChallenge, readSellerChallengeId, sellerChallengeId } from '../src/server/seller/challenge.js';
import { HANDLER_MESSAGES, type SellerResponse, handleWalletCheck, sellerPayTo } from '../src/server/seller/handler.js';
import { SETTLE_REASONS, settleWalletCheckPayment } from '../src/server/seller/settle.js';
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
  epoch: bigint;
  execute: (txBytes: Uint8Array) => ExecutionResult;
  blobs: number | 'too many';
}

function stubChain(overrides: Partial<ChainState> = {}) {
  const state: ChainState = { epoch: EPOCH, execute: (txBytes) => landed(txBytes), blobs: 0, ...overrides };
  const calls = { epochs: 0, executions: [] as string[], balances: [] as string[], blobs: [] as string[] };
  const chain = {
    usesApiKey: false,
    getCurrentEpoch: async () => {
      calls.epochs += 1;
      return state.epoch;
    },
    executeTransaction: async (txBytes: Uint8Array) => {
      calls.executions.push(TransactionDataBuilder.getDigestFromBytes(txBytes));
      return state.execute(txBytes);
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

function settle(chain: Chain, paymentHeaderValue: string, options: { resourceUrl?: string; now?: Date } = {}) {
  return settleWalletCheckPayment({ db, chain, paymentHeader: paymentHeaderValue, resourceUrl: options.resourceUrl ?? RESOURCE, now: options.now ?? NOW });
}

function call(chain: Chain, options: { method?: string; headers?: Record<string, string>; body?: string; callerKey?: string; now?: Date } = {}) {
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
  });
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
});

describe('settleWalletCheckPayment', () => {
  it('takes the exact payment once: executed through the chain, verified, recorded as settled, and refused when presented again', async () => {
    const { chain, calls } = stubChain();
    const issued = await issue(chain);
    const { signed, header } = await pay(asBuyer(issued));

    expect(await settle(chain, header)).toEqual({ ok: true, digest: signed.digest, payer: BUYER });
    expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'settled', digest: signed.digest, payer: BUYER, settledAt: NOW });
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

  it('refuses a settlement that is not the exact payment, a failed one and an unknown outcome, and records each against its digest', async () => {
    const outcomes: Array<[ChainState['execute'], string]> = [
      [(txBytes) => landed(txBytes, (payer) => [
        { address: payer, coinType: USDC_TYPE_MAINNET, amount: -PRICE },
        { address: PAY_TO, coinType: USDC_TYPE_MAINNET, amount: PRICE - 1n },
        { address: OTHER, coinType: USDC_TYPE_MAINNET, amount: 1n },
      ]), SETTLE_REASONS.mismatch],
      [(txBytes) => ({ ...landed(txBytes, () => []), status: 'failure', errorCode: 'INSUFFICIENT_ADDRESS_BALANCE' }), SETTLE_REASONS.failed],
      [() => {
        throw new ChainError('TIMEOUT', 'timed out', true);
      }, SETTLE_REASONS.unconfirmed],
    ];
    for (const [execute, reason] of outcomes) {
      const { chain, calls } = stubChain({ execute });
      const issued = await issue(chain);
      const { signed, header } = await pay(asBuyer(issued));
      expect(await settle(chain, header)).toEqual({ ok: false, status: 402, reason });
      expect(await saleOf(issued.challengeId)).toMatchObject({ status: 'rejected', digest: signed.digest, payer: BUYER, settledAt: null });
      expect(calls.executions).toEqual([signed.digest]);
      expect(await settle(chain, header)).toEqual({ ok: false, status: 409, reason: SETTLE_REASONS.used });
    }
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
    expect(calls.epochs).toBe(LIMITS.sellerChallengesPerMinute);

    expect((await call(chain, { callerKey: '203.0.113.8', now: new Date(NOW.getTime() + 30_000) })).status).toBe(402);
    expect((await call(chain, { callerKey, now: new Date(NOW.getTime() + 60_000) })).status).toBe(402);
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
    expect(await walletCheck({ chain, address: CHECKED.toUpperCase().replace('0X', '0x') })).toMatchObject({
      address: CHECKED,
      sui: '1.5 SUI',
      usdcAddressBalance: '0.05 USDC',
      usdcCoins: '1.234567 USDC',
      hasWalrusMemoryAccount: false,
      walrusBlobs: 2,
    });
    expect(calls.blobs).toEqual([CHECKED]);
    const capped = stubChain({ blobs: 'too many' });
    expect((await walletCheck({ chain: capped.chain, address: CHECKED })).walrusBlobs).toBe(LIMITS.graphqlMaxPages * LIMITS.graphqlPageSize);
    await expect(walletCheck({ chain, address: '0xnope' })).rejects.toThrow();
    expect(calls.balances).toEqual([CHECKED]);
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
