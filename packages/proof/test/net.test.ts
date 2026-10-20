// Covers: safeFetch's URL rules, the public-address check on every resolved address,
// pinning the connection to the checked address, refusal of redirects, the size cap,
// the timeout (on the lookup and on a silent server), the headers sent and returned,
// and two live requests: a real seller through the real resolver, and the same seller
// pinned to the wrong address, which TLS must refuse.
// Does NOT cover: DNS answers that change between two lookups (safeFetch looks up
// once, so there is no second answer to test), HTTP/2, or a public host that is
// itself hostile. The local tests swap only the socket under undici for one that
// reaches a local server; the live tests run the real socket path.
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/limits.js';
import { NetError, safeFetch } from '../src/net.js';

const hooks = vi.hoisted(() => ({
  divertToPort: null as number | null,
  agentOptions: [] as unknown[],
  timeoutOverrideMs: undefined as number | undefined,
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  const { connect } = await import('node:net');
  class RecordingAgent extends actual.Agent {
    constructor(options: import('undici').Agent.Options) {
      hooks.agentOptions.push(options);
      const port = hooks.divertToPort;
      if (port === null) {
        super(options);
        return;
      }
      super({
        ...options,
        connect: (_target, callback) => {
          const socket = connect({ host: '127.0.0.1', port });
          socket.once('connect', () => callback(null, socket));
          socket.once('error', (error) => callback(error, null));
          return socket;
        },
      });
    }
  }
  return { ...actual, Agent: RecordingAgent };
});

vi.mock('../src/limits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/limits.js')>();
  return {
    LIMITS: {
      ...actual.LIMITS,
      get netTimeoutMs(): number {
        return hooks.timeoutOverrideMs ?? actual.LIMITS.netTimeoutMs;
      },
    },
  };
});

const PUBLIC_ADDRESS = '93.184.215.14';
const LIVE_SELLER = 'https://agentproof.vegagaminginc.workers.dev/v1/preflight';
const resolveToPublic = async (): Promise<string[]> => [PUBLIC_ADDRESS];

async function failureOf(call: Promise<unknown>): Promise<NetError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof NetError) return error;
    throw error;
  }
  throw new Error('expected safeFetch to refuse');
}

beforeEach(() => {
  hooks.agentOptions.length = 0;
});

describe('safeFetch URL rules', () => {
  it.each([
    ['plain http', 'http://seller.example/'],
    ['port 8443', 'https://seller.example:8443/'],
    ['a user name and password', 'https://user:secret@seller.example/'],
    ['a host ending in a dot', 'https://seller.example./'],
    ['an IPv4 literal', 'https://93.184.215.14/'],
    ['an IPv4 literal in hex', 'https://0x7f.1/'],
    ['an IPv6 literal', 'https://[2606:4700::1111]/'],
    ['text that is not a URL', 'seller.example'],
  ])('refuses %s before any lookup', async (_label, url) => {
    let lookups = 0;
    const error = await failureOf(safeFetch(url, { method: 'GET' }, { resolve: async () => [String(++lookups)] }));
    expect(error.code).toBe('BAD_URL');
    expect(lookups).toBe(0);
  });

  it('refuses a Host or Cookie request header', async () => {
    const refused: Record<string, string>[] = [{ Host: 'other.example' }, { cookie: 'session=1' }];
    for (const headers of refused) {
      const error = await failureOf(safeFetch('https://seller.example/', { method: 'GET', headers }, { resolve: resolveToPublic }));
      expect(error.code).toBe('BAD_URL');
    }
  });
});

describe('safeFetch address check', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['::1'],
    ['::ffff:127.0.0.1'],
    ['fc00::1'],
    ['::7f00:1'],
    ['127.1'],
  ])('refuses a host that resolves to %s without connecting', async (address) => {
    const error = await failureOf(safeFetch('https://seller.example/', { method: 'GET' }, { resolve: async () => [address] }));
    expect(error.code).toBe('NOT_PUBLIC');
    expect(hooks.agentOptions).toHaveLength(0);
  });

  it('refuses a host with one public and one private address', async () => {
    for (const addresses of [
      [PUBLIC_ADDRESS, '10.0.0.1'],
      ['10.0.0.1', PUBLIC_ADDRESS],
    ]) {
      const error = await failureOf(safeFetch('https://seller.example/', { method: 'GET' }, { resolve: async () => addresses }));
      expect(error.code).toBe('NOT_PUBLIC');
    }
    expect(hooks.agentOptions).toHaveLength(0);
  });

  it('treats a host with no addresses as a network failure', async () => {
    const error = await failureOf(safeFetch('https://seller.example/', { method: 'GET' }, { resolve: async () => [] }));
    expect(error.code).toBe('NETWORK');
  });

  it('times out a lookup that never answers', async () => {
    hooks.timeoutOverrideMs = 200;
    try {
      const error = await failureOf(
        safeFetch('https://seller.example/', { method: 'GET' }, { resolve: () => new Promise<string[]>(() => undefined) }),
      );
      expect(error.code).toBe('TIMEOUT');
    } finally {
      hooks.timeoutOverrideMs = undefined;
    }
  });
});

describe('safeFetch against a local server', () => {
  let server: Server;
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  let streamClosed: Promise<number> = Promise.resolve(0);

  function streamForever(res: ServerResponse): void {
    let sent = 0;
    streamClosed = new Promise((resolve) => res.on('close', () => resolve(sent)));
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(16 * 1024, 0x78);
    const pump = (): void => {
      while (!res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) return;
      }
    };
    res.on('drain', pump);
    pump();
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://127.0.0.1/' }).end();
      } else if (req.url === '/forever') {
        streamForever(res);
      } else if (req.url === '/silent') {
        // Never answers: the timeout has to end the request.
      } else {
        res.writeHead(402, { 'X-Mixed-Case': 'kept', 'Set-Cookie': 'tracker=1', 'content-type': 'text/plain' }).end('pay me');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
    hooks.divertToPort = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    hooks.divertToPort = null;
  });

  it('pins the connection to the checked address and sends only the headers passed in', async () => {
    const res = await safeFetch(
      'https://Seller.Example:443/pay?x=1#ignored',
      { method: 'GET', headers: { 'x-test': '1' } },
      { resolve: resolveToPublic },
    );

    expect(res.status).toBe(402);
    expect(res.bodyText).toBe('pay me');
    expect(res.url).toBe('https://seller.example/pay?x=1');
    expect(res.host).toBe('seller.example');
    expect(res.headers['x-mixed-case']).toBe('kept');
    expect(res.headers['set-cookie']).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/pay?x=1');
    expect(seen[0]?.headers.host).toBe('seller.example');
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(['connection', 'host', 'x-test']);

    const options = hooks.agentOptions[0] as { connect: { lookup: (...args: unknown[]) => void } };
    const asked: unknown[][] = [];
    options.connect.lookup('anything.example', { all: true }, (...args: unknown[]) => asked.push(args));
    options.connect.lookup('anything.example', {}, (...args: unknown[]) => asked.push(args));
    expect(asked).toEqual([
      [null, [{ address: PUBLIC_ADDRESS, family: 4 }]],
      [null, PUBLIC_ADDRESS, 4],
    ]);
  });

  it('refuses a redirect and does not follow it', async () => {
    const error = await failureOf(safeFetch('https://seller.example/redirect', { method: 'GET' }, { resolve: resolveToPublic }));
    expect(error.code).toBe('REDIRECT');
    expect(seen).toHaveLength(1);
  });

  it('stops reading at the size cap and closes the stream', async () => {
    const error = await failureOf(safeFetch('https://seller.example/forever', { method: 'GET' }, { resolve: resolveToPublic }));
    expect(error.code).toBe('TOO_LARGE');
    const sentBytes = await streamClosed;
    expect(sentBytes).toBeGreaterThan(LIMITS.netMaxResponseBytes);
  });

  it('times out a server that never answers', async () => {
    hooks.timeoutOverrideMs = 300;
    const started = Date.now();
    try {
      const error = await failureOf(safeFetch('https://seller.example/silent', { method: 'GET' }, { resolve: resolveToPublic }));
      expect(error.code).toBe('TIMEOUT');
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      hooks.timeoutOverrideMs = undefined;
    }
  });
});

describe('safeFetch live', () => {
  const LIVE_TIMEOUT_MS = LIMITS.netTimeoutMs * 2;

  it(
    'gets a 402 from a real Sui Mainnet seller through the real resolver',
    async () => {
      const res = await safeFetch(LIVE_SELLER, { method: 'GET' });
      expect(res.status).toBe(402);
      expect(res.host).toBe('agentproof.vegagaminginc.workers.dev');
      // Only the real seller sends this, so the test cannot pass against the local server.
      expect(res.bodyText).toContain('"x402Version"');
      expect(res.headers['www-authenticate']).toMatch(/^Payment /);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'cannot reach the seller when pinned to another public address, because TLS checks the host name',
    async () => {
      const error = await failureOf(safeFetch(LIVE_SELLER, { method: 'GET' }, { resolve: async () => ['8.8.8.8'] }));
      expect(error.code).toBe('NETWORK');
    },
    LIVE_TIMEOUT_MS,
  );
});
