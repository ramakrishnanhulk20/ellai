// Covers: the input refusals of rememberSentences and recallSentences, the bulk write and
// wait against the SDK's own MemWalMock, failed jobs, recall's numeric-distance rule and its
// 0 to LIMITS.recallDistanceMax range (C12) and cutoff, that errors never carry the delegate
// secret or upstream text (C19), the relayer URL rule, the relayer response size cap (C21), the
// delegate key length check, and relayer points paced per delegate key across clients, waited for
// or refused at once when told not to wait (on fake timers).
// submitSentences sending exactly once without waiting, and checkJobs mapping each relayer
// state and refusing every malformed status answer. Against a stand-in chain: a gRPC refusal wrapped in a SimulationError keeping the failing
// step's own code, and Tatum being paced at the anonymous rate only without an API key.
// The unsigned builders: bytes that decode to exactly the expected Move call with the owner
// as sender, nothing sent, refusals before building, and tampered resolutions refused by
// assertSignable; findMemoryAccount's null, found and other-owner answers.
// Does NOT cover: anything on the live relayer or on Sui. Account creation, delegate
// registration, real job timing, rate limits and pacing against the live gateway are proven
// only by `npm run prove:memory`, which runs against Mainnet. Whether a real wallet signs the
// unsigned bytes as built is not covered anywhere yet.
import { bcs } from '@mysten/sui/bcs';
import { SimulationError } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Inputs, Transaction, type TransactionDataBuilder } from '@mysten/sui/transactions';
import { deriveDynamicFieldID, normalizeStructTag, normalizeSuiAddress, toBase64, toHex } from '@mysten/sui/utils';
import { type MemWal, MemWalMock } from '@mysten-incubation/memwal';
import { RpcError } from '@protobuf-ts/runtime-rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chain } from '../src/chain.js';
import { LIMITS } from '../src/limits.js';
import {
  buildAddDelegateTx,
  buildCreateAccountTx,
  checkJobs,
  createMemoryClient,
  DEFAULT_RELAYER_URL,
  ensureMemoryAccount,
  findMemoryAccount,
  MemoryError,
  recallSentences,
  rememberSentences,
  submitSentences,
  WALRUS_MEMORY_PACKAGE_ID,
  WALRUS_MEMORY_REGISTRY_ID,
} from '../src/memory.js';

const NAMESPACE = 'ellai-test-v1';
const ACCOUNT_ID = `0x${'ab'.repeat(32)}`;

function distinctSentences(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Test fact number ${index + 1} about the Ellai setup.`);
}

/** A client whose every method fails the test unless the test replaces it. */
function stubClient(methods: Partial<Record<'rememberBulk' | 'getRememberBulkStatus' | 'recall', (...args: never[]) => Promise<unknown>>>) {
  const untouched = () => Promise.reject(new Error('relayer was called'));
  const client = {
    rememberBulk: vi.fn(methods.rememberBulk ?? untouched),
    getRememberBulkStatus: vi.fn(methods.getRememberBulkStatus ?? untouched),
    recall: vi.fn(methods.recall ?? untouched),
  };
  return { client, asMemWal: client as unknown as MemWal };
}

async function caught(promise: Promise<unknown>): Promise<MemoryError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(MemoryError);
  return error as MemoryError;
}

/** Runs a write against fake timers, so the 4-second poll pause costs no real time. */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('rememberSentences', () => {
  it('refuses more than 20 sentences without calling the relayer', async () => {
    const { client, asMemWal } = stubClient({});
    const error = await caught(rememberSentences(asMemWal, NAMESPACE, distinctSentences(LIMITS.memwalBulkMaxItems + 1)));
    expect(error.code).toBe('WRITE');
    expect(error.message).toContain(`at most ${LIMITS.memwalBulkMaxItems}`);
    expect(client.rememberBulk).not.toHaveBeenCalled();
  });

  it('refuses no sentences, empty ones and repeated ones without calling the relayer', async () => {
    const { client, asMemWal } = stubClient({});
    const refusals: Array<[string[], RegExp]> = [
      [[], /at least one/],
      [['A real fact.', ''], /sentence 2 is empty/],
      [['   \n\t'], /sentence 1 is empty/],
      [['​'], /sentence 1 is empty/],
      [['The owner refused this seller.', 'The owner refused this seller.'], /sentence 2 repeats/],
      [['The owner refused this seller.', '  the OWNER  refused this seller. '], /sentence 2 repeats/],
    ];
    for (const [sentences, message] of refusals) {
      const error = await caught(rememberSentences(asMemWal, NAMESPACE, sentences));
      expect(error.code).toBe('WRITE');
      expect(error.message).toMatch(message);
    }
    const oversized = 'x'.repeat(LIMITS.memwalSentenceMaxBytes + 1);
    expect((await caught(rememberSentences(asMemWal, NAMESPACE, [oversized]))).code).toBe('WRITE');
    expect((await caught(rememberSentences(asMemWal, 'Has Spaces', ['A real fact.']))).code).toBe('WRITE');
    expect(client.rememberBulk).not.toHaveBeenCalled();
  });

  it('writes with one bulk call, waits for every job, and returns each sentence with its blob id in order', async () => {
    const mock = MemWalMock.create({ namespace: 'default' });
    const bulk = vi.spyOn(mock, 'rememberBulk');
    const sentences = distinctSentences(10);
    const written = await withFakeTimers(() => rememberSentences(mock as unknown as MemWal, NAMESPACE, sentences));
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk.mock.calls[0]?.[0]).toEqual(sentences.map((text) => ({ text, namespace: NAMESPACE })));
    expect(written.map((memory) => memory.text)).toEqual(sentences);
    expect(new Set(written.map((memory) => memory.blobId)).size).toBe(10);
    for (const memory of written) {
      expect(memory.blobId).toMatch(/^mock-blob-/);
      expect(memory.jobId).toMatch(/^mock-job-/);
    }
  });

  it('throws WRITE when any job fails', async () => {
    const { asMemWal } = stubClient({
      rememberBulk: async () => ({ job_ids: ['job-a', 'job-b'], total: 2, status: 'accepted' }),
      getRememberBulkStatus: async () => ({
        results: [
          { job_id: 'job-a', status: 'done', blob_id: 'blob-a' },
          { job_id: 'job-b', status: 'failed', error: 'encryption backend unavailable' },
        ],
      }),
    });
    const error = await withFakeTimers(() => caught(rememberSentences(asMemWal, NAMESPACE, distinctSentences(2))));
    expect(error.code).toBe('WRITE');
    expect(error.message).toContain('job-b failed');
    expect(error.message).not.toContain('encryption backend');
  });
});

describe('submitSentences', () => {
  it('sends one bulk write and returns the job ids in sentence order without polling', async () => {
    const mock = MemWalMock.create({ namespace: 'default' });
    const bulk = vi.spyOn(mock, 'rememberBulk');
    const status = vi.spyOn(mock, 'getRememberBulkStatus');
    const sentences = distinctSentences(3);
    const jobIds = await submitSentences(mock as unknown as MemWal, NAMESPACE, sentences);
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk.mock.calls[0]?.[0]).toEqual(sentences.map((text) => ({ text, namespace: NAMESPACE })));
    expect(jobIds).toHaveLength(3);
    expect(new Set(jobIds).size).toBe(3);
    for (const jobId of jobIds) expect(jobId).toMatch(/^mock-job-/);
    expect(status).not.toHaveBeenCalled();
  });

  it('refuses bad input before sending, and never sends again after a failed send', async () => {
    const { client, asMemWal } = stubClient({});
    expect((await caught(submitSentences(asMemWal, NAMESPACE, distinctSentences(LIMITS.memwalBulkMaxItems + 1)))).code).toBe('WRITE');
    expect((await caught(submitSentences(asMemWal, NAMESPACE, ['Same fact.', 'same fact.']))).code).toBe('WRITE');
    expect((await caught(submitSentences(asMemWal, 'Has Spaces', ['A fact.']))).code).toBe('WRITE');
    expect(client.rememberBulk).not.toHaveBeenCalled();

    const timeout = Object.assign(new Error('deadline'), { name: 'MemWalRequestTimeout' });
    const timedOut = stubClient({ rememberBulk: () => Promise.reject(timeout) });
    expect((await caught(submitSentences(timedOut.asMemWal, NAMESPACE, ['A fact.']))).code).toBe('TIMEOUT');
    expect(timedOut.client.rememberBulk).toHaveBeenCalledTimes(1);

    const short = stubClient({ rememberBulk: async () => ({ job_ids: ['job-a'], total: 1, status: 'running' }) });
    const error = await caught(submitSentences(short.asMemWal, NAMESPACE, ['A fact.', 'Another fact.']));
    expect(error.message).toContain('did not return 2 distinct job ids');
    expect(short.client.rememberBulk).toHaveBeenCalledTimes(1);
  });
});

describe('checkJobs', () => {
  const answer = (results: unknown) => stubClient({ getRememberBulkStatus: async () => ({ results }) });

  it('maps every relayer state onto done, pending or failed, in the order asked, with one status read', async () => {
    const asked = ['job-a', 'job-b', 'job-c', 'job-d', 'job-e', 'job-f'];
    const { client, asMemWal } = answer([
      { job_id: 'job-f', status: 'not_found' },
      { job_id: 'job-a', status: 'done', blob_id: 'blob-a' },
      { job_id: 'job-b', status: 'pending' },
      { job_id: 'job-c', status: 'running' },
      { job_id: 'job-d', status: 'uploaded' },
      { job_id: 'job-e', status: 'failed', error: 'encryption backend unavailable' },
    ]);
    expect(await checkJobs(asMemWal, asked)).toEqual([
      { jobId: 'job-a', state: 'done', blobId: 'blob-a' },
      { jobId: 'job-b', state: 'pending', blobId: null },
      { jobId: 'job-c', state: 'pending', blobId: null },
      { jobId: 'job-d', state: 'pending', blobId: null },
      { jobId: 'job-e', state: 'failed', blobId: null },
      { jobId: 'job-f', state: 'failed', blobId: null },
    ]);
    expect(client.getRememberBulkStatus).toHaveBeenCalledTimes(1);
    expect(client.getRememberBulkStatus.mock.calls[0]?.[0]).toEqual(asked);
  });

  it('refuses every malformed answer', async () => {
    const malformed: Array<[unknown, RegExp]> = [
      [undefined, /wrong shape/],
      [[], /wrong shape/],
      [[{ job_id: 'job-a', status: 'done', blob_id: 'blob-a' }, { job_id: 'job-b', status: 'pending' }], /wrong shape/],
      [[{ job_id: 'job-z', status: 'done', blob_id: 'blob-z' }], /not asked about/],
      [[{ job_id: 'job-a', status: 'done' }], /without a usable blob id/],
      [[{ job_id: 'job-a', status: 'done', blob_id: 'has spaces' }], /without a usable blob id/],
      [[{ job_id: 'job-a', status: 'queued' }], /state this code does not know/],
      [[{ status: 'done', blob_id: 'blob-a' }], /not asked about/],
    ];
    for (const [results, message] of malformed) {
      const error = await caught(checkJobs(answer(results).asMemWal, ['job-a']));
      expect(error.code).toBe('WRITE');
      expect(error.message).toMatch(message);
    }
    const twice = answer([
      { job_id: 'job-a', status: 'pending' },
      { job_id: 'job-a', status: 'done', blob_id: 'blob-a' },
    ]);
    expect((await caught(checkJobs(twice.asMemWal, ['job-a', 'job-b']))).message).toMatch(/one job twice/);
  });

  it('refuses bad job ids and more than the relayer allows per call without calling it', async () => {
    const { client, asMemWal } = stubClient({});
    const tooMany = Array.from({ length: LIMITS.memwalBulkMaxItems + 1 }, (_, index) => `job-${index}`);
    for (const jobIds of [[], tooMany, ['job a'], ['job-a', 'job-a'], [`job-${'x'.repeat(128)}`]]) {
      expect((await caught(checkJobs(asMemWal, jobIds))).code).toBe('WRITE');
    }
    expect(client.getRememberBulkStatus).not.toHaveBeenCalled();
  });
});

describe('recallSentences', () => {
  it('throws RECALL when any hit has no numeric distance, and never lets the SDK filter one away', async () => {
    const good = { blob_id: 'blob-1', text: 'A matching fact.', distance: 0.2 };
    for (const distance of [undefined, null, '0.3', Number.NaN, Number.POSITIVE_INFINITY]) {
      const { client, asMemWal } = stubClient({
        recall: async () => ({ results: [good, { blob_id: 'blob-2', text: 'Another fact.', distance }], total: 2 }),
      });
      const error = await caught(recallSentences(asMemWal, NAMESPACE, 'which fact matches?', { limit: 5, maxDistance: 0.8 }));
      expect(error.code).toBe('RECALL');
      expect(error.message).toContain('hit 2 has no numeric distance');
      // SDK 0.1.8 drops `distance < maxDistance` misses itself, which would hide a missing distance.
      expect(client.recall.mock.calls[0]?.[0]).not.toHaveProperty('maxDistance');
    }
  });

  it('throws RECALL when any hit has a distance below 0 or above LIMITS.recallDistanceMax, and keeps hits at both ends (C12)', async () => {
    expect(LIMITS.recallDistanceMax).toBe(2);
    const good = { blob_id: 'blob-1', text: 'A matching fact.', distance: 0.2 };
    for (const distance of [-0.001, -1, LIMITS.recallDistanceMax + 0.001, 7]) {
      const { asMemWal } = stubClient({ recall: async () => ({ results: [good, { blob_id: 'blob-2', text: 'Another fact.', distance }], total: 2 }) });
      const error = await caught(recallSentences(asMemWal, NAMESPACE, 'which fact matches?', { limit: 5, maxDistance: LIMITS.recallDistanceMax }));
      expect(error.code).toBe('RECALL');
      expect(error.message).toBe(`recall hit 2 has a distance outside 0 to ${LIMITS.recallDistanceMax}`);
    }
    const ends = [
      { blob_id: 'blob-same', text: 'The same fact.', distance: 0 },
      { blob_id: 'blob-opposite', text: 'The opposite fact.', distance: LIMITS.recallDistanceMax },
    ];
    const { asMemWal } = stubClient({ recall: async () => ({ results: ends, total: 2 }) });
    const hits = await recallSentences(asMemWal, NAMESPACE, 'which fact matches?', { limit: 5, maxDistance: LIMITS.recallDistanceMax });
    // The cutoff is strict, so a hit at the far end is read and checked but never returned.
    expect(hits.map((hit) => [hit.blobId, hit.distance])).toEqual([['blob-same', 0]]);
  });

  it('returns hits under the cutoff with their distances, and [] when nothing is close', async () => {
    const mock = MemWalMock.create({
      initialMemories: [
        { text: 'The first seller the test pays is agentproof for 0.01 USDC.', namespace: NAMESPACE },
        { text: 'A refusal always wins over any approval.', namespace: NAMESPACE },
        { text: 'The first seller lives in another namespace.', namespace: 'other' },
      ],
    });
    const hits = await recallSentences(mock as unknown as MemWal, NAMESPACE, 'first seller the test pays', { limit: 5, maxDistance: 0.5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain('agentproof');
    expect(typeof hits[0]?.distance).toBe('number');
    expect(hits[0]?.createdAt).toBeNull();
    expect(await recallSentences(mock as unknown as MemWal, NAMESPACE, 'weather in Tokyo', { limit: 5, maxDistance: 0.5 })).toEqual([]);
  });

  it('throws RECALL for more hits than asked for, for hits left out unread, and for a bad limit or cutoff', async () => {
    const hit = { blob_id: 'blob-1', text: 'A fact.', distance: 0.1 };
    const tooMany = stubClient({ recall: async () => ({ results: [hit, hit], total: 2 }) }).asMemWal;
    expect((await caught(recallSentences(tooMany, NAMESPACE, 'q', { limit: 1, maxDistance: 0.8 }))).code).toBe('RECALL');
    const dropped = stubClient({ recall: async () => ({ results: [hit], total: 1, dropped_count: 2 }) }).asMemWal;
    expect((await caught(recallSentences(dropped, NAMESPACE, 'q', { limit: 5, maxDistance: 0.8 }))).code).toBe('RECALL');
    const { client, asMemWal } = stubClient({});
    for (const opts of [{ limit: 0, maxDistance: 0.8 }, { limit: 101, maxDistance: 0.8 }, { limit: 5, maxDistance: 0 }, { limit: 5, maxDistance: Number.NaN }]) {
      expect((await caught(recallSentences(asMemWal, NAMESPACE, 'q', opts))).code).toBe('RECALL');
    }
    expect(client.recall).not.toHaveBeenCalled();
  });
});

describe('errors (C19)', () => {
  const delegate = Ed25519Keypair.generate();
  const secretBech32 = delegate.getSecretKey();
  const secretHex = toHex(decodeSuiPrivateKey(secretBech32).secretKey);
  const leaky = (status: number) =>
    Object.assign(new Error(`upstream echoed ${secretHex} and ${secretBech32}`), { status, cause: `{"error":"${secretHex}"}` });

  it('never carry the delegate secret, a cause, or the upstream text', async () => {
    const failures: MemoryError[] = [];
    for (const status of [401, 429, 500, 400]) {
      const { asMemWal } = stubClient({ rememberBulk: () => Promise.reject(leaky(status)), recall: () => Promise.reject(leaky(status)) });
      failures.push(await caught(rememberSentences(asMemWal, NAMESPACE, ['A fact.'])));
      failures.push(await caught(recallSentences(asMemWal, NAMESPACE, 'q', { limit: 5, maxDistance: 0.8 })));
    }
    failures.push(await caught((async () => createMemoryClient({ delegate, accountId: `${secretHex}zz` }))()));
    expect(failures.map((failure) => failure.code)).toEqual(['DELEGATE', 'DELEGATE', 'RATE_LIMITED', 'RATE_LIMITED', 'UPSTREAM', 'UPSTREAM', 'WRITE', 'RECALL', 'ACCOUNT']);
    for (const failure of failures) {
      const everything = `${failure.message} ${String(failure.stack)} ${JSON.stringify(failure)}`;
      expect(everything).not.toContain(secretHex);
      expect(everything).not.toContain(secretBech32);
      expect(everything).not.toContain('upstream echoed');
      expect(failure.cause).toBeUndefined();
    }
  });
});

describe('createMemoryClient', () => {
  it('signs as the delegate key and uses the hosted relayer by default', async () => {
    const delegate = Ed25519Keypair.generate();
    const client = createMemoryClient({ delegate, accountId: ACCOUNT_ID });
    expect(await client.getPublicKeyHex()).toBe(toHex(delegate.getPublicKey().toRawBytes()));
    client.destroy();
    // destroy() wipes the client's own copy of the seed, never the caller's keypair.
    expect(delegate.getSecretKey()).toMatch(/^suiprivkey/);
    expect(DEFAULT_RELAYER_URL).toBe('https://relayer.memory.walrus.xyz');
  });

  it('refuses a relayer URL that is not a bare https origin', () => {
    const delegate = Ed25519Keypair.generate();
    for (const url of ['http://relayer.memory.walrus.xyz', 'https://relayer.example/base', 'https://user:pw@relayer.example', 'not a url']) {
      vi.stubEnv('MEMWAL_RELAYER_URL', url);
      expect(() => createMemoryClient({ delegate, accountId: ACCOUNT_ID })).toThrow(/MEMWAL_RELAYER_URL/);
    }
  });

  it('passes small relayer responses through and refuses one over the size cap (C21)', async () => {
    const small = new Response(JSON.stringify({ status: 'ok', version: '0.1.0' }), { status: 200 });
    const huge = new Response(new Uint8Array(LIMITS.memwalMaxResponseBytes + 1), { status: 200 });
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValueOnce(small).mockResolvedValueOnce(huge);
    vi.stubGlobal('fetch', fetchStub);
    // A fresh module, so its cap wraps this stub rather than a fetch an earlier test wrapped.
    vi.resetModules();
    try {
      const fresh = await import('../src/memory.js');
      const client = fresh.createMemoryClient({ delegate: Ed25519Keypair.generate(), accountId: ACCOUNT_ID });
      await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
      await expect(client.health()).rejects.toMatchObject({ name: 'MemoryError', code: 'UPSTREAM' });
      expect(fetchStub).toHaveBeenCalledWith(`${DEFAULT_RELAYER_URL}/health`, expect.anything());
    } finally {
      vi.resetModules();
    }
  });
});

describe('relayer pacing', () => {
  /** A real client for `delegate` whose bulk write is a stand-in that accepts one job per sentence. */
  function pacedClient(delegate: Ed25519Keypair) {
    const client = createMemoryClient({ delegate, accountId: ACCOUNT_ID });
    const rememberBulk = vi.fn(async (items: unknown[]) => ({ job_ids: items.map((_, index) => `job-${index}`), total: items.length, status: 'running' }));
    Object.assign(client, { rememberBulk });
    return { client, rememberBulk };
  }

  it('counts relayer points per delegate key across every client made for it, so a second client waits out the first one\'s window (B-N6)', async () => {
    expect(LIMITS.memwalPointsPerMinute).toBe(3 * LIMITS.memwalBulkPoints);
    const delegate = Ed25519Keypair.generate();
    const first = pacedClient(delegate);
    const second = pacedClient(delegate);
    const otherKey = pacedClient(Ed25519Keypair.generate());
    vi.useFakeTimers();
    try {
      for (let write = 0; write < 3; write++) await submitSentences(first.client, NAMESPACE, [`Fact number ${write}.`]);
      // Told not to wait, the same key is refused at once and nothing is sent.
      const refused = await caught(submitSentences(second.client, NAMESPACE, ['Another fact.'], { waitForPoints: false }));
      expect(refused.code).toBe('RATE_LIMITED');
      expect(second.rememberBulk).not.toHaveBeenCalled();
      // Another delegate key has a window of its own.
      expect(await submitSentences(otherKey.client, NAMESPACE, ['A third fact.'], { waitForPoints: false })).toEqual(['job-0']);

      const waiting = submitSentences(second.client, NAMESPACE, ['Another fact.']);
      await vi.advanceTimersByTimeAsync(LIMITS.memwalPacingWindowMs - 1);
      expect(second.rememberBulk).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await waiting).toEqual(['job-0']);
      expect(second.rememberBulk).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      for (const { client } of [first, second, otherKey]) client.destroy();
    }
  });
});

describe('ensureMemoryAccount', () => {
  it('refuses a delegate key that is not 32 bytes before touching the chain', async () => {
    const untouchable = new Proxy({}, {
      get() {
        throw new Error('chain was touched');
      },
    }) as Chain;
    for (const key of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      const error = await caught(ensureMemoryAccount({ chain: untouchable, owner: Ed25519Keypair.generate(), delegatePublicKey: key }));
      expect(error.code).toBe('DELEGATE');
    }
  });
});

describe('ensureMemoryAccount against a stand-in chain', () => {
  const REGISTRY_ID = normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID);
  const notFound = () => Object.assign(new Error('stand-in not found'), { reason: 'notFound' });

  /** The registry as create_account needs it, in the on-chain layout memory.ts decodes. */
  function openRegistry(): { objectId: string; type: string; content: Uint8Array } {
    const layout = bcs.struct('AccountRegistry', {
      id: bcs.Address,
      accounts: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
      migration_finalized: bcs.bool(),
      pinned_allowlist_root: bcs.option(bcs.byteVector()),
      expected_account_imports: bcs.u64(),
      expected_delegate_imports: bcs.u64(),
      imported_accounts: bcs.u64(),
      imported_delegates: bcs.u64(),
      version: bcs.u64(),
    });
    const content = layout
      .serialize({
        id: REGISTRY_ID,
        accounts: { id: `0x${'7e'.repeat(32)}`, size: 0 },
        migration_finalized: true,
        pinned_allowlist_root: null,
        expected_account_imports: 0,
        expected_delegate_imports: 0,
        imported_accounts: 0,
        imported_delegates: 0,
        version: 4,
      })
      .toBytes();
    return { objectId: REGISTRY_ID, type: normalizeStructTag(`${WALRUS_MEMORY_PACKAGE_ID}::account::AccountRegistry`), content };
  }

  it("reports a gRPC refusal wrapped in a SimulationError with the failing step's own code", async () => {
    const refusal = new RpcError('stand-in refusal', 'FAILED_PRECONDITION');
    const wrapped = new SimulationError(refusal.message, { cause: refusal });
    const getObjects = vi.fn(async ({ objectIds: [id] }: { objectIds: string[] }) => ({
      objects: [id === REGISTRY_ID ? openRegistry() : notFound()],
    }));
    const chain = {
      // A key, so the module's shared pacing ledger can never make this test wait.
      usesApiKey: true,
      grpc: {
        getObjects,
        // Transaction.build hands resolution to the client's plugin. The gRPC client's own
        // plugin rethrows a gateway refusal exactly like this: the SDK's SimulationError,
        // whose name stays "Error", with the RpcError as its cause.
        core: {
          resolveTransactionPlugin: () => async () => {
            throw wrapped;
          },
        },
      },
    } as unknown as Chain;
    const error = await caught(ensureMemoryAccount({ chain, owner: Ed25519Keypair.generate(), delegatePublicKey: new Uint8Array(32) }));
    expect(error.code).toBe('ACCOUNT');
    expect(error.message).toBe('Sui refused a Walrus Memory account step (gRPC FAILED_PRECONDITION)');
    expect(getObjects).toHaveBeenCalledTimes(2);
  });

  it('paces Tatum at the anonymous rate only when the chain has no API key', async () => {
    const requests = LIMITS.tatumAnonymousRequestsPerMinute + 1;
    const fakeMsFor = async (usesApiKey: boolean): Promise<number> => {
      // A fresh module, so each run starts from an empty pacing ledger.
      vi.resetModules();
      const fresh = await import('../src/memory.js');
      const getObjects = vi.fn(async () => ({ objects: [notFound()] }));
      const chain = { usesApiKey, grpc: { getObjects } } as unknown as Chain;
      const elapsed = await withFakeTimers(async () => {
        const started = Date.now();
        for (let i = 0; i < requests; i++) {
          // A registry that is not found ends the call after exactly one Tatum request.
          const run = fresh.ensureMemoryAccount({ chain, owner: Ed25519Keypair.generate(), delegatePublicKey: new Uint8Array(32) });
          await expect(run).rejects.toMatchObject({ name: 'MemoryError', code: 'ACCOUNT' });
        }
        return Date.now() - started;
      });
      expect(getObjects).toHaveBeenCalledTimes(requests);
      return elapsed;
    };
    try {
      expect(await fakeMsFor(true)).toBe(0);
      expect(await fakeMsFor(false)).toBeGreaterThanOrEqual(LIMITS.tatumPacingWindowMs);
    } finally {
      vi.resetModules();
    }
  });
});

describe('unsigned account builders and findMemoryAccount against a stand-in chain', () => {
  const REGISTRY_ID = normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID);
  const TABLE_ID = `0x${'7e'.repeat(32)}`;
  const CLOCK_ID = normalizeSuiAddress('0x6');
  const OWNER = normalizeSuiAddress(`0x${'a1'.repeat(32)}`);
  const OTHER = normalizeSuiAddress(`0x${'b2'.repeat(32)}`);
  const ACCOUNT = normalizeSuiAddress(`0x${'c3'.repeat(32)}`);
  const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const GAS_COIN = { objectId: normalizeSuiAddress(`0x${'9c'.repeat(32)}`), version: '7', digest: 'AQ2cfEAh3AiC1SBMkH64f4MP4QsvTettKfhLXErgNcFh' };
  const FIELD_TYPE = normalizeStructTag('0x2::dynamic_field::Field<address, 0x2::object::ID>');
  const ACCOUNT_TYPE = normalizeStructTag(`${WALRUS_MEMORY_PACKAGE_ID}::account::MemWalAccount`);
  const notFound = () => Object.assign(new Error('stand-in not found'), { reason: 'notFound' });

  const RegistryLayout = bcs.struct('AccountRegistry', {
    id: bcs.Address,
    accounts: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
    migration_finalized: bcs.bool(),
    pinned_allowlist_root: bcs.option(bcs.byteVector()),
    expected_account_imports: bcs.u64(),
    expected_delegate_imports: bcs.u64(),
    imported_accounts: bcs.u64(),
    imported_delegates: bcs.u64(),
    version: bcs.u64(),
  });
  const FieldLayout = bcs.struct('Field', { id: bcs.Address, name: bcs.Address, value: bcs.Address });
  const AccountLayout = bcs.struct('MemWalAccount', {
    id: bcs.Address,
    owner: bcs.Address,
    delegate_keys: bcs.vector(
      bcs.struct('DelegateKey', { public_key: bcs.byteVector(), sui_address: bcs.Address, label: bcs.string(), created_at: bcs.u64() }),
    ),
    created_at: bcs.u64(),
    active: bcs.bool(),
    admin_quarantined: bcs.bool(),
    legacy_account_id: bcs.option(bcs.Address),
    access_counter_version: bcs.u64(),
  });

  interface Setup {
    /** The account the registry names for OWNER, if any. */
    account?: { id: string; owner: string; keys: Uint8Array[] };
    /** Changes the resolved transaction the way a hostile or broken gateway could. */
    tamper?: (data: TransactionDataBuilder) => void;
  }

  function standIn(setup: Setup = {}) {
    const objects = new Map<string, { objectId: string; type: string; content: Uint8Array }>();
    const registry = RegistryLayout.serialize({
      id: REGISTRY_ID,
      accounts: { id: TABLE_ID, size: 1 },
      migration_finalized: true,
      pinned_allowlist_root: null,
      expected_account_imports: 0,
      expected_delegate_imports: 0,
      imported_accounts: 0,
      imported_delegates: 0,
      version: 4,
    });
    objects.set(REGISTRY_ID, {
      objectId: REGISTRY_ID,
      type: normalizeStructTag(`${WALRUS_MEMORY_PACKAGE_ID}::account::AccountRegistry`),
      content: registry.toBytes(),
    });
    if (setup.account) {
      const { id, owner, keys } = setup.account;
      const fieldId = deriveDynamicFieldID(TABLE_ID, 'address', bcs.Address.serialize(OWNER).toBytes());
      objects.set(fieldId, { objectId: fieldId, type: FIELD_TYPE, content: FieldLayout.serialize({ id: fieldId, name: OWNER, value: id }).toBytes() });
      const delegateKeys = keys.map((key) => ({ public_key: key, sui_address: OTHER, label: 'Ellai', created_at: 1 }));
      const account = AccountLayout.serialize({
        id,
        owner,
        delegate_keys: delegateKeys,
        created_at: 1,
        active: true,
        admin_quarantined: false,
        legacy_account_id: null,
        access_counter_version: 0,
      });
      objects.set(id, { objectId: id, type: ACCOUNT_TYPE, content: account.toBytes() });
    }
    const getObjects = vi.fn(async ({ objectIds: [id] }: { objectIds: string[] }) => ({ objects: [objects.get(id ?? '') ?? notFound()] }));
    const sent = vi.fn(() => Promise.reject(new Error('a transaction was sent')));
    // Stands in for the gateway's resolution: shared objects get a version and the owner's gas is picked.
    const resolve = vi.fn(async (data: TransactionDataBuilder, _options: unknown, next: () => Promise<void>) => {
      data.inputs.forEach((input, index) => {
        if (input.$kind !== 'UnresolvedObject') return;
        const objectId = normalizeSuiAddress(input.UnresolvedObject.objectId);
        data.inputs[index] = Inputs.SharedObjectRef({ objectId, initialSharedVersion: 1, mutable: objectId !== CLOCK_ID });
      });
      data.gasData.price = '1000';
      data.gasData.budget = '4000000';
      data.gasData.payment = [GAS_COIN];
      setup.tamper?.(data);
      await next();
    });
    const chain = {
      usesApiKey: true,
      executeTransaction: sent,
      grpc: { getObjects, executeTransaction: sent, core: { resolveTransactionPlugin: () => resolve } },
    } as unknown as Chain;
    return { chain, getObjects, sent, resolve };
  }

  const untouchable = new Proxy({}, {
    get() {
      throw new Error('chain was touched');
    },
  }) as Chain;

  type Data = ReturnType<Transaction['getData']>;
  type Argument = NonNullable<Data['commands'][number]['MoveCall']>['arguments'][number];

  function sharedId(data: Data, argument: Argument | undefined): string | undefined {
    const input = argument?.$kind === 'Input' ? data.inputs[argument.Input] : undefined;
    return input?.Object?.SharedObject?.objectId;
  }

  function pureBytes(data: Data, argument: Argument | undefined): string | undefined {
    return argument?.$kind === 'Input' ? data.inputs[argument.Input]?.Pure?.bytes : undefined;
  }

  it('builds create_account for the owner as sender and gas payer, and sends nothing', async () => {
    const { chain, sent, resolve } = standIn();
    const bytes = await buildCreateAccountTx({ chain, owner: OWNER });
    const data = Transaction.from(bytes).getData();
    expect(data.sender).toBe(OWNER);
    expect(data.gasData.owner ?? OWNER).toBe(OWNER);
    expect(data.commands).toHaveLength(1);
    const call = data.commands[0]?.MoveCall;
    expect(call && normalizeSuiAddress(call.package)).toBe(WALRUS_MEMORY_PACKAGE_ID);
    expect([call?.module, call?.function]).toEqual(['account', 'create_account']);
    expect(call?.arguments.map((argument) => sharedId(data, argument))).toEqual([REGISTRY_ID, CLOCK_ID]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses create_account for an owner who already has an account, before building', async () => {
    const { chain, resolve } = standIn({ account: { id: ACCOUNT, owner: OWNER, keys: [] } });
    const error = await caught(buildCreateAccountTx({ chain, owner: OWNER }));
    expect(error.code).toBe('ACCOUNT');
    expect(error.message).toBe('the owner already has a Walrus Memory account');
    expect(resolve).not.toHaveBeenCalled();
    expect((await caught(buildCreateAccountTx({ chain: untouchable, owner: 'not an address' }))).code).toBe('ACCOUNT');
  });

  it('builds add_delegate_key with exactly this account, key and label, and sends nothing', async () => {
    const { chain, sent } = standIn({ account: { id: ACCOUNT, owner: OWNER, keys: [] } });
    const bytes = await buildAddDelegateTx({ chain, owner: OWNER, accountId: ACCOUNT, delegatePublicKey: KEY, label: 'Ellai' });
    const data = Transaction.from(bytes).getData();
    expect(data.sender).toBe(OWNER);
    expect(data.commands).toHaveLength(1);
    const call = data.commands[0]?.MoveCall;
    expect([call?.module, call?.function]).toEqual(['account', 'add_delegate_key']);
    const [account, registry, key, label, clock] = call?.arguments ?? [];
    expect([sharedId(data, account), sharedId(data, registry), sharedId(data, clock)]).toEqual([ACCOUNT, REGISTRY_ID, CLOCK_ID]);
    expect(pureBytes(data, key)).toBe(toBase64(bcs.byteVector().serialize(KEY).toBytes()));
    expect(pureBytes(data, label)).toBe(toBase64(bcs.string().serialize('Ellai').toBytes()));
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses a bad key or label before touching the chain, and an account or key that does not fit', async () => {
    const base = { chain: untouchable, owner: OWNER, accountId: ACCOUNT, label: 'Ellai' };
    for (const key of [new Uint8Array(31), new Uint8Array(33)]) {
      expect((await caught(buildAddDelegateTx({ ...base, delegatePublicKey: key }))).code).toBe('DELEGATE');
    }
    for (const label of ['', 'x'.repeat(65), 'Ellai<script>', 'Ellai\n']) {
      expect((await caught(buildAddDelegateTx({ ...base, delegatePublicKey: KEY, label }))).code).toBe('DELEGATE');
    }

    const elsewhere = standIn({ account: { id: ACCOUNT, owner: OWNER, keys: [] } });
    const notTheirs = await caught(
      buildAddDelegateTx({ chain: elsewhere.chain, owner: OWNER, accountId: OTHER, delegatePublicKey: KEY, label: 'Ellai' }),
    );
    expect(notTheirs.message).toBe("the registry does not name this account as the owner's");

    const already = standIn({ account: { id: ACCOUNT, owner: OWNER, keys: [KEY] } });
    const present = await caught(buildAddDelegateTx({ chain: already.chain, owner: OWNER, accountId: ACCOUNT, delegatePublicKey: KEY, label: 'Ellai' }));
    expect([present.code, present.message]).toEqual(['DELEGATE', 'the key is already on the account']);
    expect(already.resolve).not.toHaveBeenCalled();
  });

  it('refuses bytes the gateway changed: another sender, a gas sponsor, an extra command, or gas over the cap', async () => {
    const tampering: Array<(data: TransactionDataBuilder) => void> = [
      (data) => {
        data.sender = OTHER;
      },
      (data) => {
        data.gasData.owner = OTHER;
      },
      (data) => {
        data.commands.push({ $kind: 'MakeMoveVec', MakeMoveVec: { type: null, elements: [] } });
      },
      (data) => {
        data.gasData.budget = String(LIMITS.memwalAccountTxMaxGasMist + 1);
      },
    ];
    for (const tamper of tampering) {
      const { chain, sent } = standIn({ tamper });
      const error = await caught(buildCreateAccountTx({ chain, owner: OWNER }));
      expect(error.code).toBe('ACCOUNT');
      expect(error.message).toMatch(/^refused before signing: /);
      expect(sent).not.toHaveBeenCalled();
    }
  });

  it("findMemoryAccount returns null, the account with its delegate keys as hex, or refuses another owner's account", async () => {
    expect(await findMemoryAccount(standIn().chain, OWNER)).toBeNull();
    const found = await findMemoryAccount(standIn({ account: { id: ACCOUNT, owner: OWNER, keys: [KEY] } }).chain, OWNER);
    expect(found).toEqual({ accountId: ACCOUNT, delegates: [toHex(KEY)] });
    const stolen = await caught(findMemoryAccount(standIn({ account: { id: ACCOUNT, owner: OTHER, keys: [] } }).chain, OWNER));
    expect([stolen.code, stolen.message]).toEqual(['ACCOUNT', 'the Walrus Memory account belongs to another owner']);
  });
});
