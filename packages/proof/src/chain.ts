import { ChannelCredentials } from '@grpc/grpc-js';
import { bcs } from '@mysten/sui/bcs';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  isValidStructTag,
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_TYPE_ARG,
} from '@mysten/sui/utils';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { z } from 'zod';
import { canonicalSuiAddress } from './keys.js';
import { LIMITS } from './limits.js';
import { USDC_TYPE_MAINNET } from './usdc.js';

const TATUM_GRPC_HOST = 'sui-mainnet-grpc.gateway.tatum.io:443';
const TATUM_GRAPHQL_URL = 'https://sui-mainnet.gateway.tatum.io/graphql';
const API_KEY_HEADER = 'x-api-key';

const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);

/** The Walrus system package's Blob type. Each Walrus Memory write leaves one of these at the owner's address. */
export const WALRUS_BLOB_TYPE = normalizeStructTag(
  '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::blob::Blob',
);

const U32_MAX = 0xffff_ffff;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_FIRST_SERVER_ERROR = 500;

export type ChainErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'UPSTREAM'
  | 'BAD_RESPONSE'
  | 'LIMIT_EXCEEDED';

/**
 * Every failure from this module is a ChainError. Its message is written here from
 * fixed text, status codes and validated inputs only. Upstream error text is never
 * copied in and the upstream error is never attached, so a key or token cannot ride
 * along into a log.
 */
export class ChainError extends Error {
  readonly code: ChainErrorCode;
  readonly retryable: boolean;

  constructor(code: ChainErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface Balances {
  /** USDC in the address balance. Allowances can draw only from this part. */
  usdcAddressBalance: bigint;
  /** USDC held as Coin objects at the address. */
  usdcCoinBalance: bigint;
  /** All SUI at the address, address balance and coins together. */
  suiTotal: bigint;
}

export interface BalanceChange {
  address: string;
  coinType: string;
  amount: bigint;
}

export interface WalrusBlob {
  objectId: string;
  /** Walrus's own text form (URL-safe base64 of the little-endian u256), the form Walrus Memory reports. */
  blobId: string;
  registeredEpoch: number;
  endEpoch: number;
  deletable: boolean;
}

export interface Chain {
  /** Raw gRPC client. Calls made on it directly get the transport timeout but no retries. */
  readonly grpc: SuiGrpcClient;
  /** Raw GraphQL client. Calls made on it directly get the fetch timeout but no retries. */
  readonly graphql: SuiGraphQLClient;
  getReferenceGasPrice(): Promise<bigint>;
  getBalances(address: string): Promise<Balances>;
  getTransactionBalanceChanges(digest: string): Promise<BalanceChange[]>;
  listOwnedWalrusBlobs(owner: string): Promise<WalrusBlob[]>;
  /** Closes the gRPC channel so a script can exit. */
  close(): void;
}

function grpcFailure(code: string, details: string): ChainError {
  switch (code) {
    case 'NOT_FOUND':
      return new ChainError('NOT_FOUND', 'not found (gRPC NOT_FOUND)');
    case 'INVALID_ARGUMENT':
    case 'OUT_OF_RANGE':
    case 'FAILED_PRECONDITION':
      return new ChainError('INVALID_INPUT', `request refused (gRPC ${code})`);
    case 'UNAUTHENTICATED':
    case 'PERMISSION_DENIED':
      return new ChainError('UNAUTHORIZED', `API key rejected (gRPC ${code})`);
    case 'UNIMPLEMENTED':
      return new ChainError('UPSTREAM', 'method not served by the gateway (gRPC UNIMPLEMENTED)');
    case 'RESOURCE_EXHAUSTED':
      return new ChainError('RATE_LIMITED', 'rate limited (gRPC RESOURCE_EXHAUSTED)', true);
    case 'DEADLINE_EXCEEDED':
    case 'CANCELLED':
      return new ChainError('TIMEOUT', `timed out (gRPC ${code})`, true);
    default:
      // grpc-js reports an HTTP 429 from the gateway as UNAVAILABLE. Only the fixed
      // label is kept from the details, never the text itself.
      if (details.includes(`HTTP status code ${HTTP_TOO_MANY_REQUESTS}`)) {
        return new ChainError('RATE_LIMITED', `rate limited (HTTP ${HTTP_TOO_MANY_REQUESTS} via gRPC)`, true);
      }
      return new ChainError('UPSTREAM', `gateway error (gRPC ${/^[A-Z_]+$/.test(code) ? code : 'UNKNOWN'})`, true);
  }
}

function httpFailure(status: number): ChainError {
  if (status === HTTP_TOO_MANY_REQUESTS) return new ChainError('RATE_LIMITED', `rate limited (HTTP ${status})`, true);
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return new ChainError('UNAUTHORIZED', `API key rejected (HTTP ${status})`);
  }
  if (status >= HTTP_FIRST_SERVER_ERROR) return new ChainError('UPSTREAM', `gateway error (HTTP ${status})`, true);
  return new ChainError('UPSTREAM', `request refused (HTTP ${status})`);
}

function classify(error: unknown): ChainError {
  if (error instanceof ChainError) return error;
  if (typeof error === 'object' && error !== null) {
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    // Matched by shape, not instanceof: the transport loads the CommonJS build of
    // protobuf-ts while the SDK may load another copy.
    if (name === 'RpcError' && typeof code === 'string') {
      return grpcFailure(code, typeof message === 'string' ? message : '');
    }
    if (name === 'AbortError' || name === 'TimeoutError') return new ChainError('TIMEOUT', 'timed out', true);
  }
  return new ChainError('UPSTREAM', 'network error', true);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function badResponse(what: string): ChainError {
  return new ChainError('BAD_RESPONSE', `unexpected response from Tatum: ${what}`);
}

function parseUnsigned(value: unknown, what: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw badResponse(what);
}

function parseSigned(value: unknown, what: string): bigint {
  // BigInt('') is 0n and BigInt(' 5 ') is 5n, so the shape is checked first.
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw badResponse(what);
}

function chainAddress(value: unknown, what: string): string {
  if (typeof value !== 'string') throw badResponse(what);
  const normalized = normalizeSuiAddress(value);
  if (!isValidSuiAddress(normalized)) throw badResponse(what);
  return normalized;
}

function chainStructTag(value: unknown, what: string): string {
  if (typeof value !== 'string') throw badResponse(what);
  let normalized: string;
  try {
    normalized = normalizeStructTag(value);
  } catch {
    throw badResponse(what);
  }
  if (!isValidStructTag(normalized)) throw badResponse(what);
  return normalized;
}

function inputAddress(address: string): string {
  try {
    return canonicalSuiAddress(address);
  } catch {
    throw new ChainError('INVALID_INPUT', 'not a valid Sui address');
  }
}

/** Walrus prints a blob id as URL-safe base64, without padding, of the u256 in little-endian bytes. */
function walrusBlobId(decimal: string): string {
  try {
    return bcs.u256().serialize(BigInt(decimal)).toBase64().replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
  } catch {
    throw badResponse('blob_id is not a u256');
  }
}

const epoch = z.number().int().min(0).max(U32_MAX);

const blobPageSchema = z.object({
  address: z.object({
    objects: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z
        .array(
          z.object({
            address: z.string(),
            contents: z.object({
              type: z.object({ repr: z.string() }),
              json: z.object({
                id: z.string(),
                blob_id: z.string().regex(/^(0|[1-9]\d*)$/),
                registered_epoch: epoch,
                storage: z.object({ end_epoch: epoch }),
                deletable: z.boolean(),
              }),
            }),
          }),
        )
        .max(LIMITS.graphqlPageSize),
    }),
  }),
});

const BLOBS_QUERY = `
  query EllaiOwnedWalrusBlobs($owner: SuiAddress!, $type: String!, $first: Int!, $after: String) {
    address(address: $owner) {
      objects(first: $first, after: $after, filter: { type: $type }) {
        pageInfo { hasNextPage endCursor }
        nodes { address contents { type { repr } json } }
      }
    }
  }
`;

/**
 * Connects to Tatum's Sui Mainnet gateway: gRPC over the native HTTP/2 transport
 * (the SDK's default gRPC-web transport is refused by Tatum) and GraphQL.
 * Server only. The key, when given, is sent as the x-api-key header and nowhere else.
 * Every function below has a timeout of LIMITS.tatumTimeoutMs per attempt and at most
 * LIMITS.tatumRetries retries, used only for errors that can clear on their own, and
 * throws ChainError on any failure.
 */
export function createChain(opts: { apiKey?: string }): Chain {
  const apiKey = opts.apiKey === '' ? undefined : opts.apiKey;

  const transport = new GrpcTransport({
    host: TATUM_GRPC_HOST,
    channelCredentials: ChannelCredentials.createSsl(),
    timeout: LIMITS.tatumTimeoutMs,
    ...(apiKey ? { meta: { [API_KEY_HEADER]: apiKey } } : {}),
  });
  const grpc = new SuiGrpcClient({ network: 'mainnet', transport });

  const boundedFetch: typeof fetch = async (input, init) => {
    const timeout = AbortSignal.timeout(LIMITS.tatumTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(input, { ...init, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpFailure(response.status);
    }
    return response;
  };
  const graphql = new SuiGraphQLClient({
    network: 'mainnet',
    url: TATUM_GRAPHQL_URL,
    fetch: boundedFetch,
    ...(apiKey ? { headers: { [API_KEY_HEADER]: apiKey } } : {}),
  });

  function scrub(error: ChainError): ChainError {
    if (!apiKey || !error.message.includes(apiKey)) return error;
    return new ChainError(error.code, error.message.replaceAll(apiKey, '[redacted]'), error.retryable);
  }

  // gRPC calls return a thenable UnaryCall rather than a Promise, hence PromiseLike.
  async function attempt<T>(run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ChainError('TIMEOUT', `no answer within ${LIMITS.tatumTimeoutMs} ms`, true));
      }, LIMITS.tatumTimeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function bounded<T>(operation: string, run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt(run);
      } catch (error) {
        const failure = classify(error);
        if (!failure.retryable || retry >= LIMITS.tatumRetries) {
          throw scrub(new ChainError(failure.code, `Tatum ${operation}: ${failure.message}`, failure.retryable));
        }
        await sleep(LIMITS.tatumRetryDelayMs * 2 ** retry);
      }
    }
  }

  async function getReferenceGasPrice(): Promise<bigint> {
    const { response } = await bounded('getReferenceGasPrice', (abort) =>
      grpc.ledgerService.getEpoch({ readMask: { paths: ['reference_gas_price'] } }, { abort }),
    );
    const price = parseUnsigned(response.epoch?.referenceGasPrice, 'reference gas price');
    if (price === 0n) throw badResponse('reference gas price is zero');
    return price;
  }

  async function getBalances(address: string): Promise<Balances> {
    const owner = inputAddress(address);
    let usdc: { address: bigint; coin: bigint } | undefined;
    let sui: bigint | undefined;
    let pageToken: Uint8Array | undefined;

    for (let page = 0; page < LIMITS.balanceMaxPages; page++) {
      const { response } = await bounded('getBalances', (abort) =>
        grpc.stateService.listBalances({ owner, pageSize: LIMITS.balancePageSize, pageToken }, { abort }),
      );
      if (response.balances.length > LIMITS.balancePageSize) throw badResponse('more balances than the page size');

      for (const entry of response.balances) {
        const coinType = chainStructTag(entry.coinType, 'balance coin type');
        if (coinType !== USDC_TYPE_MAINNET && coinType !== SUI_TYPE) continue;

        // The SDK's own wrapper turns a missing field into "0", which would hide a
        // gateway that cannot tell the two USDC pools apart. Absent means refuse.
        const inAddress = parseUnsigned(entry.addressBalance, `${coinType} address balance`);
        const inCoins = parseUnsigned(entry.coinBalance, `${coinType} coin balance`);
        const total = parseUnsigned(entry.balance, `${coinType} total balance`);
        if (inAddress + inCoins !== total) throw badResponse(`${coinType} parts do not add up to the total`);

        if (coinType === USDC_TYPE_MAINNET) {
          if (usdc) throw badResponse('USDC listed twice');
          usdc = { address: inAddress, coin: inCoins };
        } else {
          if (sui !== undefined) throw badResponse('SUI listed twice');
          sui = total;
        }
      }

      pageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
      if (!pageToken || (usdc && sui !== undefined)) {
        return { usdcAddressBalance: usdc?.address ?? 0n, usdcCoinBalance: usdc?.coin ?? 0n, suiTotal: sui ?? 0n };
      }
    }
    throw new ChainError('LIMIT_EXCEEDED', `Tatum getBalances: more than ${LIMITS.balanceMaxPages} pages of coin types`);
  }

  async function getTransactionBalanceChanges(digest: string): Promise<BalanceChange[]> {
    if (!isValidTransactionDigest(digest)) {
      throw new ChainError('INVALID_INPUT', 'not a valid transaction digest');
    }
    // The digest is echoed only after the base58 check above, so it is safe to print.
    const notFound = () => new ChainError('NOT_FOUND', `Transaction ${digest} was not found on Sui mainnet`);
    const { response } = await bounded('getTransactionBalanceChanges', (abort) =>
      grpc.ledgerService.getTransaction({ digest, readMask: { paths: ['digest', 'balance_changes'] } }, { abort }),
    ).catch((error: unknown) => {
      throw error instanceof ChainError && error.code === 'NOT_FOUND' ? notFound() : error;
    });
    const transaction = response.transaction;
    if (!transaction) throw notFound();
    if (transaction.digest !== digest) throw badResponse('transaction digest does not match the request');

    return transaction.balanceChanges.map((change) => ({
      address: chainAddress(change.address, 'balance change address'),
      coinType: chainStructTag(change.coinType, 'balance change coin type'),
      amount: parseSigned(change.amount, 'balance change amount'),
    }));
  }

  async function listOwnedWalrusBlobs(owner: string): Promise<WalrusBlob[]> {
    const ownerAddress = inputAddress(owner);
    const blobs: WalrusBlob[] = [];
    let after: string | null = null;

    for (let page = 0; page < LIMITS.graphqlMaxPages; page++) {
      const variables: Record<string, unknown> = {
        owner: ownerAddress,
        type: WALRUS_BLOB_TYPE,
        first: LIMITS.graphqlPageSize,
        after,
      };
      const result = await bounded('listOwnedWalrusBlobs', (signal) =>
        graphql.query({ query: BLOBS_QUERY, variables, signal }),
      );
      if (result.errors?.length) {
        throw new ChainError('UPSTREAM', `Tatum listOwnedWalrusBlobs: GraphQL returned ${result.errors.length} error(s)`);
      }
      const parsed = blobPageSchema.safeParse(result.data);
      if (!parsed.success) throw badResponse('Walrus blob page has the wrong shape');
      const { nodes, pageInfo } = parsed.data.address.objects;

      for (const node of nodes) {
        const objectId = chainAddress(node.address, 'blob object id');
        if (chainAddress(node.contents.json.id, 'blob id field') !== objectId) {
          throw badResponse('blob object id does not match its contents');
        }
        if (chainStructTag(node.contents.type.repr, 'blob type') !== WALRUS_BLOB_TYPE) {
          throw badResponse('an object that is not a Walrus Blob passed the type filter');
        }
        blobs.push({
          objectId,
          blobId: walrusBlobId(node.contents.json.blob_id),
          registeredEpoch: node.contents.json.registered_epoch,
          endEpoch: node.contents.json.storage.end_epoch,
          deletable: node.contents.json.deletable,
        });
      }

      if (!pageInfo.hasNextPage) return blobs;
      if (!pageInfo.endCursor) throw badResponse('next page promised without a cursor');
      after = pageInfo.endCursor;
    }
    throw new ChainError(
      'LIMIT_EXCEEDED',
      `Tatum listOwnedWalrusBlobs: more than ${LIMITS.graphqlMaxPages * LIMITS.graphqlPageSize} blobs, refusing a partial list`,
    );
  }

  return {
    grpc,
    graphql,
    getReferenceGasPrice,
    getBalances,
    getTransactionBalanceChanges,
    listOwnedWalrusBlobs,
    close: () => transport.close(),
  };
}
