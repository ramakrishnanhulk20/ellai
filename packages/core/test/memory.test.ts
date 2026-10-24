// Covers: the input refusals of rememberSentences and recallSentences, the bulk write and
// wait against the SDK's own MemWalMock, failed jobs, recall's numeric-distance rule (C12)
// and cutoff, that errors never carry the delegate secret or upstream text (C19), the
// relayer URL rule, the relayer response size cap (C21) and the delegate key length check.
// Against a stand-in chain: a gRPC refusal wrapped in a SimulationError keeping the failing
// step's own code, and Tatum being paced at the anonymous rate only without an API key.
// Does NOT cover: anything on the live relayer or on Sui. Account creation, delegate
// registration, real job timing, rate limits and pacing against the live gateway are proven
// only by `npm run prove:memory`, which runs against Mainnet.
import { bcs } from '@mysten/sui/bcs';
import { SimulationError } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeStructTag, normalizeSuiAddress, toHex } from '@mysten/sui/utils';
import { type MemWal, MemWalMock } from '@mysten-incubation/memwal';
import { RpcError } from '@protobuf-ts/runtime-rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chain } from '../src/chain.js';
import { LIMITS } from '../src/limits.js';
import {
  createMemoryClient,
  DEFAULT_RELAYER_URL,
  ensureMemoryAccount,
  MemoryError,
  recallSentences,
  rememberSentences,
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
