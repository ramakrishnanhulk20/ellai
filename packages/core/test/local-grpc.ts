import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from 'node:http2';
import { type AddressInfo, createConnection, createServer as createTcpServer, type Socket } from 'node:net';
import { ChannelCredentials } from '@grpc/grpc-js';
import { vi } from 'vitest';

export interface LocalGrpcServer {
  /** host:port to dial. */
  address: string;
  /** The gRPC methods called so far, in order. */
  calls: string[];
  close(): Promise<void>;
}

/**
 * A plaintext HTTP/2 server on localhost that takes gRPC calls. With no `answer` it never answers
 * any of them, as a gateway that has stopped responding would; otherwise `answer` decides what
 * each call gets, by its method name and its place in the order.
 */
export async function localGrpcServer(answer?: (stream: ServerHttp2Stream, method: string, index: number) => void): Promise<LocalGrpcServer> {
  const sessions = new Set<ServerHttp2Session>();
  const calls: string[] = [];
  const server = createServer();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    // A client that gives up on a call resets its stream, which the server sees as an error.
    session.on('error', () => undefined);
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => undefined);
    const method = String(headers[':path'] ?? '').split('/').at(-1) ?? '';
    calls.push(method);
    // @types/node names the base type here; a server only ever hands out its own streams.
    answer?.(stream as ServerHttp2Stream, method, calls.length - 1);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Answers a gRPC call with `code` and no message, as the gateway answers a refusal. */
export function refuseCall(stream: ServerHttp2Stream, code: number, message: string): void {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': String(code), 'grpc-message': encodeURIComponent(message) }, { endStream: true });
}

/** Answers a gRPC call with OK and one message, its protobuf bytes in an uncompressed gRPC frame. */
export function answerCall(stream: ServerHttp2Stream, message: Uint8Array): void {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
  stream.end(frame);
}

export interface BlackHoleProxy {
  /** host:port to dial. */
  address: string;
  /** Every connection open now stops passing bytes either way and stays open, as a NAT that forgot it does. New connections still work. */
  drop(): void;
  /** Connections made through the proxy so far. */
  connections(): number;
  close(): void;
}

/** A TCP proxy in front of `target`, so a test can drop a connection silently: no FIN, no RST. */
export async function blackHoleProxy(target: string): Promise<BlackHoleProxy> {
  const [host, port] = target.split(':');
  const pairs: Array<{ open: boolean; sockets: Socket[] }> = [];
  const server = createTcpServer((client) => {
    const upstream = createConnection({ host, port: Number(port) });
    const pair = { open: true, sockets: [client, upstream] };
    pairs.push(pair);
    client.on('data', (chunk) => pair.open && upstream.write(chunk));
    upstream.on('data', (chunk) => pair.open && client.write(chunk));
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    address: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    drop: () => {
      for (const pair of pairs) pair.open = false;
    },
    connections: () => pairs.length,
    close: () => {
      for (const pair of pairs) for (const socket of pair.sockets) socket.destroy();
      server.close();
    },
  };
}

/**
 * Runs `load` with every gRPC transport it imports dialing `address` in plaintext instead of
 * Tatum. Modules are loaded fresh, so `load` must import chain.ts (and memory.ts, if used) itself;
 * everything above the socket, the transport's deadline included, is the real code.
 */
export async function loadDialing<T>(address: string, load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock('@protobuf-ts/grpc-transport', async (importOriginal) => {
    const original = await importOriginal<typeof import('@protobuf-ts/grpc-transport')>();
    class LocalTransport extends original.GrpcTransport {
      constructor(options: ConstructorParameters<typeof original.GrpcTransport>[0]) {
        super({ ...options, host: address, channelCredentials: ChannelCredentials.createInsecure() });
      }
    }
    return { ...original, GrpcTransport: LocalTransport };
  });
  try {
    return await load();
  } finally {
    vi.doUnmock('@protobuf-ts/grpc-transport');
    vi.resetModules();
  }
}
