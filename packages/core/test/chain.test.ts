// Covers: Tatum's live Sui Mainnet gateway (the .env key if set, else anonymous): the gas price, a digest
// that does not exist, the balance split for the test owner, refusal of bad input,
// and that a rejected key never shows up in an error. Then, after waiting for a fresh
// Tatum minute: the current epoch, a real settled USDC payment read with its status,
// a dry run of garbage bytes, and both response size caps. Offline: whether a chain says
// it sends an API key and, against stand-in gateway answers, executeTransaction's retry
// and refusal rules and getAllowance's shape checks and rate window. Then, after a third fresh minute: a
// real third-party USDC allowance read with its terms, an app-bound one refused, and a
// wrongly signed transaction refused by the network.
// Offline too, against stand-in GraphQL pages: scanOwnedWalrusBlobs reading one bounded stretch,
// handing back where the next starts, and its refusals; getWalrusEpoch against the shapes Tatum
// returned for Walrus Mainnet, and its refusals.
// Does NOT cover: a paid key's rate limits, the Walrus blob listing or scan against the live
// gateway (the probe script and the scratch cross-check exercise the listing), an owner that
// actually holds USDC, a failed transaction's status read from chain (none is pinned
// here), a dry run that executes and fails (probe:pay shows the refusal path), or a
// transaction that lands through executeTransaction (prove:pay sends real ones).
// Anonymous Tatum allows 5 requests a minute. This file makes 4, waits, makes 4 more,
// waits again, then makes 4, so running it twice inside one minute can fail with
// RATE_LIMITED.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeSuiAddress, toBase58, toBase64 } from '@mysten/sui/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChainError, WALRUS_BLOB_TYPE, WALRUS_SYSTEM_OBJECT_ID, createChain } from '../src/chain.js';
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

// Uses the operator's Tatum key when .env has one, so two suites running at once cannot
// exhaust the shared anonymous limit; without a key the waits below keep it under 5 a minute.
const ROOT_TATUM_KEY = existsSync(ROOT_ENV) ? parseEnv(readFileSync(ROOT_ENV, 'utf8')).TATUM_API_KEY || undefined : undefined;
const chain = createChain({ apiKey: ROOT_TATUM_KEY });
const owner = testOwner();

afterAll(() => chain.close());

describe('createChain against Tatum Sui Mainnet', () => {
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

describe('createChain payment reads against Tatum Sui Mainnet', () => {
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

const SIGNED_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const SIGNED_DIGEST = TransactionDataBuilder.getDigestFromBytes(SIGNED_BYTES);
const SIGNATURE = toBase64(new Uint8Array(97).fill(7));
const CREATED_ID = normalizeSuiAddress(`0x${'ab'.repeat(32)}`);
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function rpcError(code: string): Error {
  return Object.assign(new Error(`stand-in ${code}`), { name: 'RpcError', code });
}

/** A landed transaction as the gateway describes it: one created object, one left alone, one SUI gas charge. */
function landed(digest = SIGNED_DIGEST) {
  return {
    response: {
      transaction: {
        digest,
        effects: {
          status: { success: true },
          changedObjects: [
            { objectId: CREATED_ID, objectType: '0x2::allowance::AllowanceCap<0x2::balance::Balance<0x2::sui::SUI>>', idOperation: GrpcTypes.ChangedObject_IdOperation.CREATED },
            { objectId: `0x${'cd'.repeat(32)}`, objectType: '0x2::coin::Coin<0x2::sui::SUI>', idOperation: GrpcTypes.ChangedObject_IdOperation.NONE },
          ],
        },
        balanceChanges: [{ address: owner.address, coinType: SUI, amount: '-1000' }],
      },
    },
  };
}

type Answer = () => Promise<unknown>;

/** A chain whose two gRPC methods answer from the given lists and never reach the network. */
function standIn(sends: Answer[], lookups: Answer[]) {
  const local = createChain({});
  const unexpected = () => Promise.reject(new Error('the test gave no answer for this call'));
  const send = vi.spyOn(local.grpc.transactionExecutionService, 'executeTransaction').mockImplementation(unexpected as never);
  for (const answer of sends) send.mockImplementationOnce(answer as never);
  const lookup = vi.spyOn(local.grpc.ledgerService, 'getTransaction').mockImplementation(unexpected as never);
  for (const answer of lookups) lookup.mockImplementationOnce(answer as never);
  return { local, send, lookup };
}

describe('createChain options', () => {
  it('says whether it sends an API key, treating a blank key as none', () => {
    const chains = [createChain({}), createChain({ apiKey: '' }), createChain({ apiKey: 'stand-in-key' })];
    try {
      expect(chains.map((each) => each.usesApiKey)).toEqual([false, false, true]);
    } finally {
      for (const each of chains) each.close();
    }
  });
});

describe('executeTransaction retry and refusal rules, against stand-in gateway answers', () => {
  it('refuses empty bytes and bad signatures without sending anything, and never echoes a signature', async () => {
    const { local, send } = standIn([], []);
    try {
      expect((await failureOf(local.executeTransaction(new Uint8Array(), [SIGNATURE]))).code).toBe('INVALID_INPUT');
      expect((await failureOf(local.executeTransaction(SIGNED_BYTES, []))).code).toBe('INVALID_INPUT');
      expect((await failureOf(local.executeTransaction(SIGNED_BYTES, [SIGNATURE, SIGNATURE, SIGNATURE]))).code).toBe('INVALID_INPUT');
      const badSignature = 'not base64, and secret';
      const failure = await failureOf(local.executeTransaction(SIGNED_BYTES, [badSignature]));
      expect(failure.code).toBe('INVALID_INPUT');
      expect(failure.message).not.toContain(badSignature);
      expect(send).not.toHaveBeenCalled();
    } finally {
      local.close();
    }
  });

  it('after a timeout, returns what landed without sending the bytes again', async () => {
    const { local, send, lookup } = standIn([() => Promise.reject(rpcError('DEADLINE_EXCEEDED'))], [async () => landed()]);
    try {
      const result = await local.executeTransaction(SIGNED_BYTES, [SIGNATURE]);
      expect(result).toEqual({
        digest: SIGNED_DIGEST,
        status: 'success',
        errorCode: null,
        balanceChanges: [{ address: owner.address, coinType: SUI, amount: -1000n }],
        createdObjects: [{ objectId: CREATED_ID, type: '0x0000000000000000000000000000000000000000000000000000000000000002::allowance::AllowanceCap<0x0000000000000000000000000000000000000000000000000000000000000002::balance::Balance<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>>' }],
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      local.close();
    }
  });

  it('sends the bytes again only when the chain does not have the digest', async () => {
    const { local, send, lookup } = standIn(
      [() => Promise.reject(rpcError('UNAVAILABLE')), async () => landed()],
      [() => Promise.reject(rpcError('NOT_FOUND'))],
    );
    try {
      expect((await local.executeTransaction(SIGNED_BYTES, [SIGNATURE])).status).toBe('success');
      expect(send).toHaveBeenCalledTimes(2);
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      local.close();
    }
  });

  it('believes a refusal only after reading the digest, so bytes that landed earlier read as landed', async () => {
    const refusedOnly = standIn([() => Promise.reject(rpcError('INVALID_ARGUMENT'))], [() => Promise.reject(rpcError('NOT_FOUND'))]);
    const landedBefore = standIn([() => Promise.reject(rpcError('INVALID_ARGUMENT'))], [async () => landed()]);
    try {
      expect(await refusedOnly.local.executeTransaction(SIGNED_BYTES, [SIGNATURE])).toEqual({
        digest: SIGNED_DIGEST,
        status: 'failure',
        errorCode: 'INVALID_ARGUMENT',
        balanceChanges: [],
        createdObjects: [],
      });
      expect((await landedBefore.local.executeTransaction(SIGNED_BYTES, [SIGNATURE])).status).toBe('success');
      expect(refusedOnly.send).toHaveBeenCalledTimes(1);
      expect(landedBefore.send).toHaveBeenCalledTimes(1);
    } finally {
      refusedOnly.local.close();
      landedBefore.local.close();
    }
  });

  it('reports an answer about other bytes, or running out of retries, as an unknown outcome naming the digest', async () => {
    const otherDigest = standIn([async () => landed(toBase58(randomBytes(32)))], []);
    const rateLimited = () => Promise.reject(rpcError('RESOURCE_EXHAUSTED'));
    const notFound = () => Promise.reject(rpcError('NOT_FOUND'));
    const exhausted = standIn([rateLimited, rateLimited, rateLimited], [notFound, notFound]);
    try {
      const mismatch = await failureOf(otherDigest.local.executeTransaction(SIGNED_BYTES, [SIGNATURE]));
      expect(mismatch.code).toBe('BAD_RESPONSE');
      expect(mismatch.message).toContain(`transaction ${SIGNED_DIGEST} may have landed`);
      const giveUp = await failureOf(exhausted.local.executeTransaction(SIGNED_BYTES, [SIGNATURE]));
      expect(giveUp.code).toBe('RATE_LIMITED');
      expect(giveUp.message).toContain(`transaction ${SIGNED_DIGEST} may have landed`);
      expect(exhausted.send).toHaveBeenCalledTimes(LIMITS.tatumRetries + 1);
      expect(exhausted.lookup).toHaveBeenCalledTimes(LIMITS.tatumRetries);
    } finally {
      otherDigest.local.close();
      exhausted.local.close();
    }
  });
});

// A Walrus Blob object as Sui GraphQL returned them for a Walrus Memory owner on 2026-10-20
// (reference/walrus-memory/live-checks/blobs-molong.json), numbered so each is its own.
function blobNode(n: number, change: (json: any) => void = () => undefined) {
  const id = normalizeSuiAddress(`0x${n.toString(16)}`);
  const json = {
    id,
    registered_epoch: 39,
    blob_id: String(19_990_686_123_865_857_633n + BigInt(n)),
    size: '358',
    encoding_type: 1,
    certified_epoch: 41,
    storage: { id: normalizeSuiAddress(`0x${(n + 1_000).toString(16)}`), start_epoch: 39, end_epoch: 54, storage_size: '66034000' },
    deletable: true,
  };
  change(json);
  return { address: id, contents: { type: { repr: WALRUS_BLOB_TYPE }, json } };
}

const blobPage = (nodes: unknown[], endCursor: string | null, hasNextPage = endCursor !== null) => ({
  data: { address: { objects: { pageInfo: { hasNextPage, endCursor }, nodes } } },
});

/** Answers each GraphQL request with the next page in turn, and records the cursor each one asked from. */
async function withPages<T>(pages: unknown[], run: (asked: Array<string | null>) => Promise<T>): Promise<T> {
  const asked: Array<string | null> = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const { variables } = JSON.parse(String(init?.body)) as { variables: { after: string | null } };
    asked.push(variables.after);
    const page = pages[asked.length - 1] ?? { data: null };
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    return await run(asked);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('scanOwnedWalrusBlobs, against stand-in GraphQL pages', () => {
  const holder = normalizeSuiAddress(`0x${'4c'.repeat(32)}`);

  it('reads at most maxPages pages from the cursor given, with each blob certified epoch, and says where the next stretch starts', async () => {
    const pages = [blobPage([blobNode(1), blobNode(2)], 'cursor-1'), blobPage([blobNode(3, (json) => (json.certified_epoch = null))], 'cursor-2')];
    const first = await withPages(pages, async (asked) => {
      const scan = await chain.scanOwnedWalrusBlobs(holder, { after: null, maxPages: 2 });
      expect(asked).toEqual([null, 'cursor-1']);
      return scan;
    });
    expect(first.next).toBe('cursor-2');
    expect(first.blobs.map((blob) => [blob.certifiedEpoch, blob.endEpoch, blob.registeredEpoch, blob.deletable])).toEqual([
      [41, 54, 39, true],
      [41, 54, 39, true],
      [null, 54, 39, true],
    ]);
    // Blob ids come out in the listing's own form, the form the relayer reports and blobs.ts compares.
    const listed = await withPages([blobPage([blobNode(1), blobNode(2), blobNode(3)], null)], () => chain.listOwnedWalrusBlobs(holder));
    expect(first.blobs.map(({ objectId, blobId }) => ({ objectId, blobId }))).toEqual(listed.map(({ objectId, blobId }) => ({ objectId, blobId })));

    const last = await withPages([blobPage([blobNode(4)], null)], async (asked) => {
      const scan = await chain.scanOwnedWalrusBlobs(holder, { after: 'cursor-2', maxPages: 2 });
      expect(asked).toEqual(['cursor-2']);
      return scan;
    });
    expect(last).toMatchObject({ next: null, blobs: [{ objectId: normalizeSuiAddress('0x4'), certifiedEpoch: 41 }] });
  });

  it('never reads more than LIMITS.graphqlMaxPages pages in one stretch, where the list would refuse', async () => {
    const pages = Array.from({ length: LIMITS.graphqlMaxPages + 1 }, (_, i) => blobPage([blobNode(i + 1)], `cursor-${i + 1}`));
    const scan = await withPages(pages, async (asked) => {
      const result = await chain.scanOwnedWalrusBlobs(holder, { after: null, maxPages: LIMITS.graphqlMaxPages });
      expect(asked).toHaveLength(LIMITS.graphqlMaxPages);
      return result;
    });
    expect(scan.blobs).toHaveLength(LIMITS.graphqlMaxPages);
    expect(scan.next).toBe(`cursor-${LIMITS.graphqlMaxPages}`);
    const listed = await withPages(pages, () => failureOf(chain.listOwnedWalrusBlobs(holder)));
    expect(listed.code).toBe('LIMIT_EXCEEDED');
  });

  it('refuses a bad owner, page count or cursor without asking Tatum', async () => {
    const refused = await withPages([], async (asked) => {
      const calls = [
        chain.scanOwnedWalrusBlobs('', { after: null, maxPages: 1 }),
        chain.scanOwnedWalrusBlobs(holder, { after: null, maxPages: 0 }),
        chain.scanOwnedWalrusBlobs(holder, { after: null, maxPages: LIMITS.graphqlMaxPages + 1 }),
        chain.scanOwnedWalrusBlobs(holder, { after: null, maxPages: 1.5 }),
        chain.scanOwnedWalrusBlobs(holder, { after: '', maxPages: 1 }),
        chain.scanOwnedWalrusBlobs(holder, { after: 'c'.repeat(LIMITS.graphqlCursorMaxChars + 1), maxPages: 1 }),
      ];
      const failures = await Promise.all(calls.map(failureOf));
      expect(asked).toEqual([]);
      return failures;
    });
    for (const failure of refused) expect(failure.code).toBe('INVALID_INPUT');
  });

  it('refuses a page that leaves out certified_epoch, promises a page without a usable cursor, or holds another type', async () => {
    const pages: Array<[string, unknown]> = [
      ['no certified_epoch', blobPage([blobNode(1, (json) => delete json.certified_epoch)], null)],
      ['a next page with no cursor', blobPage([blobNode(1)], null, true)],
      ['a cursor longer than Ellai keeps', blobPage([blobNode(1)], 'c'.repeat(LIMITS.graphqlCursorMaxChars + 1))],
      ['an object that is not a Blob', blobPage([{ ...blobNode(1), contents: { ...blobNode(1).contents, type: { repr: '0x2::coin::Coin<0x2::sui::SUI>' } } }], null)],
    ];
    for (const [what, page] of pages) {
      const failure = await withPages([page, blobPage([], null)], () => failureOf(chain.scanOwnedWalrusBlobs(holder, { after: null, maxPages: 2 })));
      expect(failure.code, what).toBe('BAD_RESPONSE');
    }
  });
});

// What Tatum GraphQL returned for Walrus Mainnet on 2026-10-26 (scratchpad/walrus-epoch-proof.mts,
// its one live run): the System object at version 3, and the inner state field that version
// names, trimmed to the fields getWalrusEpoch reads, with committee.epoch 42.
const WALRUS_STATE_ID = '0x0b2d4076d3a0b82a632144e835cd972527b185bda9d55011a9cc38fe557a475d';
const WALRUS_STATE_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field::Field<u64,0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::system_state_inner::SystemStateInnerV1>';

function walrusAnswers(change: (system: any, state: any) => void = () => undefined): unknown[] {
  const system = {
    address: WALRUS_SYSTEM_OBJECT_ID,
    asMoveObject: {
      contents: {
        type: { repr: '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::system::System' },
        json: { id: WALRUS_SYSTEM_OBJECT_ID, version: '3', package_id: `0x${'98'.repeat(32)}`, new_package_id: null },
      },
    },
  };
  const state = {
    address: WALRUS_STATE_ID,
    asMoveObject: {
      contents: {
        type: { repr: WALRUS_STATE_TYPE },
        json: { id: WALRUS_STATE_ID, name: '3', value: { committee: { members: [], n_shards: 1000, epoch: 42 }, total_capacity_size: '1' } },
      },
    },
  };
  change(system, state);
  return [{ data: { object: system } }, { data: { object: state } }];
}

/** Answers each GraphQL request in turn and records the object id each one asked for. */
async function withObjects<T>(answers: unknown[], run: (asked: string[]) => Promise<T>): Promise<T> {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    asked.push((JSON.parse(String(init?.body)) as { variables: { id: string } }).variables.id);
    return new Response(JSON.stringify(answers[asked.length - 1] ?? { data: { object: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    return await run(asked);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('getWalrusEpoch, against the shapes Tatum returned', () => {
  it('reads the System object, then the inner state field its version names, and returns committee.epoch', async () => {
    const epoch = await withObjects(walrusAnswers(), async (asked) => {
      const read = await chain.getWalrusEpoch();
      // The field id is derived from the System id and the version, never taken from an answer.
      expect(asked).toEqual([WALRUS_SYSTEM_OBJECT_ID, WALRUS_STATE_ID]);
      return read;
    });
    expect(epoch).toBe(42);
  });

  it('refuses another type, another version, another object or a missing epoch', async () => {
    const refusals: Array<[string, (system: any, state: any) => void]> = [
      ['a System of another package', (system) => (system.asMoveObject.contents.type.repr = '0x2::coin::Coin<0x2::sui::SUI>')],
      ['a System with no version', (system) => delete system.asMoveObject.contents.json.version],
      ['a field holding another type', (_, state) => (state.asMoveObject.contents.type.repr = WALRUS_STATE_TYPE.replace('system_state_inner', 'staking_inner'))],
      ['a field under another package', (_, state) => (state.asMoveObject.contents.type.repr = WALRUS_STATE_TYPE.replace('0xfdc88f7d', '0xaaaaaaaa'))],
      ['a field keyed by another version', (_, state) => (state.asMoveObject.contents.json.name = '2')],
      ['a field whose contents name another object', (_, state) => (state.asMoveObject.contents.json.id = `0x${'77'.repeat(32)}`)],
      ['no committee epoch', (_, state) => delete state.asMoveObject.contents.json.value.committee.epoch],
      ['an epoch that is not a whole number', (_, state) => (state.asMoveObject.contents.json.value.committee.epoch = 4.5)],
    ];
    for (const [what, change] of refusals) {
      const failure = await withObjects(walrusAnswers(change), () => failureOf(chain.getWalrusEpoch()));
      expect(failure.code, what).toBe('BAD_RESPONSE');
    }
    const missing = await withObjects([{ data: { object: null } }], () => failureOf(chain.getWalrusEpoch()));
    expect(missing.code).toBe('NOT_FOUND');
  });
});

const STAND_IN_ALLOWANCE = normalizeSuiAddress(`0x${'5a'.repeat(32)}`);

// The shape Sui GraphQL returned for a real allowance on 2026-10-24, with short and
// upper-case addresses so normalisation shows. Each refusal test changes one thing.
function allowanceBody(change: (object: any) => void = () => undefined): unknown {
  const object = {
    address: STAND_IN_ALLOWANCE,
    owner: { __typename: 'Shared', initialSharedVersion: 1_050_464_896 },
    asMoveObject: {
      contents: {
        type: {
          repr: '0x2::allowance::Allowance<0x2::balance::Balance<0xDBA34672E30CB065B1F93E3AB55318768FD6FEF66C15942C9F7CB846E2F900E7::usdc::USDC>>',
        },
        json: {
          id: STAND_IN_ALLOWANCE,
          settings: {
            funder: `0x${'AB'.repeat(32)}`,
            spender: '0x5',
            app: null,
            lifetime_cap: '1000000',
            start_timestamp_ms: null,
            expiration_timestamp_ms: '1800000000000',
            rate_limit: {
              '@variant': 'Windowed',
              limit: '500000',
              spent: '0',
              anchor_ms: null,
              index: '0',
              window: { '@variant': 'PeriodicMs', pos0: '86400000' },
            },
            name: 'Ellai purse refills',
          },
          current_spend: '0',
        },
      },
    },
  };
  change(object);
  return { data: { object } };
}

async function withGraphql<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('getAllowance shape checks, against stand-in GraphQL bodies', () => {
  it('reads every term, with addresses and the coin type normalised', async () => {
    const allowance = await withGraphql(allowanceBody(), () => chain.getAllowance(STAND_IN_ALLOWANCE));
    expect(allowance).toEqual({
      funder: normalizeSuiAddress(`0x${'ab'.repeat(32)}`),
      spender: normalizeSuiAddress('0x5'),
      coinType: USDC_TYPE_MAINNET,
      lifetimeCap: 1_000_000n,
      spentTotal: 0n,
      periodMs: 86_400_000n,
      periodLimit: 500_000n,
      expirationMs: 1_800_000_000_000n,
      initialSharedVersion: 1_050_464_896n,
      periodSpent: 0n,
      periodEndMs: null,
    });
  });

  it("reads the current window's spend and its end, numbered from the first spend", async () => {
    const anchored = allowanceBody((o) => {
      Object.assign(o.asMoveObject.contents.json.settings.rate_limit, { spent: '300000', anchor_ms: '1761300000000', index: '2' });
      o.asMoveObject.contents.json.current_spend = '700000';
    });
    const allowance = await withGraphql(anchored, () => chain.getAllowance(STAND_IN_ALLOWANCE));
    expect(allowance).toMatchObject({ spentTotal: 700_000n, periodSpent: 300_000n, periodEndMs: 1_761_300_000_000n + 3n * 86_400_000n });
    const unlimited = await withGraphql(
      allowanceBody((o) => (o.asMoveObject.contents.json.settings.rate_limit = null)),
      () => chain.getAllowance(STAND_IN_ALLOWANCE),
    );
    expect(unlimited).toMatchObject({ periodMs: null, periodLimit: null, periodSpent: null, periodEndMs: null });
  });

  it('refuses every shape that is not a direct allowance exactly as the module writes it', async () => {
    const refusals: Array<[string, (object: any) => void]> = [
      ['an unknown field', (o) => (o.asMoveObject.contents.json.settings.extra = '1')],
      ['a calendar-month window', (o) => (o.asMoveObject.contents.json.settings.rate_limit.window = { '@variant': 'CalendarMonths', pos0: '1' })],
      ['an app-bound allowance', (o) => (o.asMoveObject.contents.json.settings.app = 'abc::app::APP')],
      ['a start time', (o) => (o.asMoveObject.contents.json.settings.start_timestamp_ms = '1')],
      ['no spender', (o) => (o.asMoveObject.contents.json.settings.spender = null)],
      ['an object that is not shared', (o) => (o.owner = { __typename: 'AddressOwner' })],
      ['another object type', (o) => (o.asMoveObject.contents.type.repr = '0x2::coin::Coin<0x2::sui::SUI>')],
      ['an allowance over a Coin, not a Balance', (o) => (o.asMoveObject.contents.type.repr = '0x2::allowance::Allowance<0x2::coin::Coin<0x2::sui::SUI>>')],
      ['contents naming another object', (o) => (o.asMoveObject.contents.json.id = `0x${'99'.repeat(32)}`)],
      ['an expiration past u64', (o) => (o.asMoveObject.contents.json.settings.expiration_timestamp_ms = '18446744073709551616')],
      ['a negative amount', (o) => (o.asMoveObject.contents.json.current_spend = '-1')],
      ['window spending with no first spend time', (o) => (o.asMoveObject.contents.json.settings.rate_limit.spent = '1')],
      ['a later window with no first spend time', (o) => (o.asMoveObject.contents.json.settings.rate_limit.index = '1')],
      ['more spent in a window than its limit', (o) => Object.assign(o.asMoveObject.contents.json.settings.rate_limit, { anchor_ms: '1', spent: '500001' })],
    ];
    for (const [what, change] of refusals) {
      const failure = await withGraphql(allowanceBody(change), () => failureOf(chain.getAllowance(STAND_IN_ALLOWANCE)));
      expect(failure.code, what).toBe('BAD_RESPONSE');
    }
  });

  it('reports a missing object as not found and a malformed id as invalid input', async () => {
    const missing = await withGraphql({ data: { object: null } }, () => failureOf(chain.getAllowance(STAND_IN_ALLOWANCE)));
    expect(missing.code).toBe('NOT_FOUND');
    expect((await failureOf(chain.getAllowance('0x'))).code).toBe('INVALID_INPUT');
  });
});

// A direct USDC allowance on Sui Mainnet issued by a third party (its name reads "Suikii:
// Test"), found through the public Sui GraphQL endpoint on 2026-10-24. Its terms cannot
// change on chain; only the amount spent can grow, until its funder revokes it.
const REAL_ALLOWANCE = {
  id: '0xc3eed777a78495a4d57e1d08a1d9c5548a7665e9ee3f88d878acb73a42eaf992',
  funder: '0x663954093dd74fb5be017341c0bdce6dc5a1a59f9d640bf9aca38ed02495a5cf',
  spender: '0xcce95abc352a17917e2c55c0e353b53e64acac4920efe61bd8beaf796658e457',
  spentOn20261024: 20_000n,
};
// An app-bound mainnet allowance (blink::SwapFunding), from the same search.
const APP_BOUND_ALLOWANCE = '0x2be7c47e7eec4ef6476b732ec19aa506ca6cd5e634e02b640fec8af057a92e40';

describe('allowance and execution against Tatum Sui Mainnet', () => {
  beforeAll(async () => {
    await sleep(Math.max(0, FILE_STARTED_AT + 2 * FRESH_MINUTE_MS - Date.now()));
  }, 2 * FRESH_MINUTE_MS + 5_000);

  it('reads a real third-party USDC allowance with its terms', { timeout: TEST_TIMEOUT_MS }, async () => {
    const allowance = await chain.getAllowance(REAL_ALLOWANCE.id);
    expect(allowance).toMatchObject({
      funder: REAL_ALLOWANCE.funder,
      spender: REAL_ALLOWANCE.spender,
      coinType: USDC_TYPE_MAINNET,
      lifetimeCap: 520_000n,
      periodMs: 604_800_000n,
      periodLimit: 10_000n,
      expirationMs: 1_824_136_989_761n,
      initialSharedVersion: 1_050_464_896n,
    });
    expect(allowance.spentTotal >= REAL_ALLOWANCE.spentOn20261024).toBe(true);
  });

  it('refuses a real app-bound allowance', { timeout: TEST_TIMEOUT_MS }, async () => {
    const failure = await failureOf(chain.getAllowance(APP_BOUND_ALLOWANCE));
    expect(failure.code).toBe('BAD_RESPONSE');
    expect(failure.message).toContain('bound to an app');
  });

  it('gets a wrongly signed transaction refused by the network, with nothing landed', { timeout: 2 * TEST_TIMEOUT_MS }, async () => {
    const sender = Ed25519Keypair.generate();
    const tx = new Transaction();
    tx.setSender(sender.toSuiAddress());
    const [balance] = tx.moveCall({
      target: '0x2::balance::redeem_funds',
      typeArguments: [USDC_TYPE_MAINNET],
      arguments: [tx.withdrawal({ amount: 10_000n, type: USDC_TYPE_MAINNET })],
    });
    if (balance === undefined) throw new Error('redeem_funds returned nothing');
    tx.moveCall({ target: '0x2::balance::send_funds', typeArguments: [USDC_TYPE_MAINNET], arguments: [balance, tx.pure.address(sender.toSuiAddress())] });
    tx.setGasPrice(0);
    tx.setGasBudget(0);
    tx.setGasPayment([]);
    tx.setExpiration({
      ValidDuring: { minEpoch: '0', maxEpoch: '1', minTimestamp: null, maxTimestamp: null, chain: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S', nonce: 1 },
    });
    const bytes = await tx.build();
    const { signature } = await Ed25519Keypair.generate().signTransaction(bytes);

    const result = await chain.executeTransaction(bytes, [signature]);
    expect(result.status).toBe('failure');
    expect(result.errorCode).toMatch(/^[A-Z_]+$/);
    expect(result.digest).toBe(TransactionDataBuilder.getDigestFromBytes(bytes));
    expect(result.balanceChanges).toEqual([]);
    expect(result.createdObjects).toEqual([]);
  });
});
