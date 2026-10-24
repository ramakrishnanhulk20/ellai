import { ChannelCredentials } from '@grpc/grpc-js';
import { bcs } from '@mysten/sui/bcs';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { GrpcTypes, SuiGrpcClient } from '@mysten/sui/grpc';
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

const { ExecutionError_ExecutionErrorKind: ExecutionErrorKind, SimulateTransactionRequest_TransactionChecks: SimulationChecks } =
  GrpcTypes;

// grpc-js reports a message over grpc.max_receive_message_length as RESOURCE_EXHAUSTED,
// the same code a rate limit uses, so its own fixed wording is what tells the two apart.
const GRPC_SIZE_CAP_PHRASE = 'Received message larger than max';
// A sender whose address balance is too small is refused before execution with only
// this fixed phrase and no structured reason. Matching it lets a probe tell "the purse
// is empty" from "the bytes are malformed". The phrase itself is never passed on.
const INSUFFICIENT_BALANCE_PHRASE = 'Insufficient address balance';

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

export type ExecutionOutcome = 'success' | 'failure';

export interface TransactionResult {
  /** Read from the transaction's effects. A failed transaction's balance changes are its gas charges, never a payment. */
  status: ExecutionOutcome;
  balanceChanges: BalanceChange[];
}

export interface SimulationResult {
  status: ExecutionOutcome;
  /** Null on success. Otherwise a fixed upper-case code, never text written by the node. */
  errorCode: string | null;
  balanceChanges: BalanceChange[];
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
  getTransactionResult(digest: string): Promise<TransactionResult>;
  getCurrentEpoch(): Promise<bigint>;
  simulate(txBytes: Uint8Array): Promise<SimulationResult>;
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
      if (details.startsWith(GRPC_SIZE_CAP_PHRASE)) {
        return new ChainError('LIMIT_EXCEEDED', `gRPC message is over ${LIMITS.grpcMaxReceiveBytes} bytes`);
      }
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

function parseBalanceChanges(changes: ReadonlyArray<{ address?: string; coinType?: string; amount?: string }>): BalanceChange[] {
  return changes.map((change) => ({
    address: chainAddress(change.address, 'balance change address'),
    coinType: chainStructTag(change.coinType, 'balance change coin type'),
    amount: parseSigned(change.amount, 'balance change amount'),
  }));
}

/** Absent or contradictory status fails closed: a transaction is never assumed to have succeeded. */
function executionOutcome(status: { success?: boolean; error?: unknown } | undefined): ExecutionOutcome {
  if (status?.success === true && status.error === undefined) return 'success';
  if (status?.success === false) return 'failure';
  throw badResponse('execution status is missing or contradictory');
}

function executionErrorCode(kind: number | undefined): string {
  const name: string | undefined = kind === undefined ? undefined : ExecutionErrorKind[kind];
  return name ?? ExecutionErrorKind[ExecutionErrorKind.EXECUTION_ERROR_KIND_UNKNOWN];
}

/**
 * A gRPC refusal that is about the transaction itself (the same codes classify reads as
 * INVALID_INPUT) becomes a short code: the gRPC code name, or INSUFFICIENT_ADDRESS_BALANCE
 * when the node says the sender's address balance cannot cover it. Anything else, such
 * as a timeout or a rate limit, returns null and stays an error.
 */
function simulationRefusal(error: unknown): string | null {
  if (classify(error).code !== 'INVALID_INPUT') return null;
  const { code, message } = error as { code: string; message?: unknown };
  if (typeof message === 'string' && message.includes(INSUFFICIENT_BALANCE_PHRASE)) return 'INSUFFICIENT_ADDRESS_BALANCE';
  return code;
}

/** Reads a response body, refusing it once it passes LIMITS.graphqlMaxResponseBytes, declared or streamed. */
async function cappedBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ChainError('LIMIT_EXCEEDED', `GraphQL response is over ${LIMITS.graphqlMaxResponseBytes} bytes`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LIMITS.graphqlMaxResponseBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > LIMITS.graphqlMaxResponseBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
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
 * throws ChainError on any failure. Responses are size-capped: a GraphQL body at
 * LIMITS.graphqlMaxResponseBytes and a gRPC message at LIMITS.grpcMaxReceiveBytes; going
 * over either is LIMIT_EXCEEDED and is not retried.
 */
export function createChain(opts: { apiKey?: string }): Chain {
  const apiKey = opts.apiKey === '' ? undefined : opts.apiKey;

  const transport = new GrpcTransport({
    host: TATUM_GRPC_HOST,
    channelCredentials: ChannelCredentials.createSsl(),
    timeout: LIMITS.tatumTimeoutMs,
    clientOptions: { 'grpc.max_receive_message_length': LIMITS.grpcMaxReceiveBytes },
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
    const body = await cappedBody(response);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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

        // Tatum omits a part that is zero (a wallet holding only an address balance comes
        // back with no coin_balance). One missing part is read as zero, checked by the sum
        // below. Both missing would hide a gateway that cannot tell the pools apart, so
        // that is refused, unlike the SDK wrapper, which turns any missing field into "0".
        if (entry.addressBalance === undefined && entry.coinBalance === undefined) {
          throw badResponse(`${coinType} balance has neither an address part nor a coin part`);
        }
        const inAddress = entry.addressBalance === undefined ? 0n : parseUnsigned(entry.addressBalance, `${coinType} address balance`);
        const inCoins = entry.coinBalance === undefined ? 0n : parseUnsigned(entry.coinBalance, `${coinType} coin balance`);
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

  async function fetchTransaction(operation: string, digest: string, paths: string[]) {
    if (!isValidTransactionDigest(digest)) {
      throw new ChainError('INVALID_INPUT', 'not a valid transaction digest');
    }
    // The digest is echoed only after the base58 check above, so it is safe to print.
    const notFound = () => new ChainError('NOT_FOUND', `Transaction ${digest} was not found on Sui mainnet`);
    const { response } = await bounded(operation, (abort) =>
      grpc.ledgerService.getTransaction({ digest, readMask: { paths: ['digest', ...paths] } }, { abort }),
    ).catch((error: unknown) => {
      throw error instanceof ChainError && error.code === 'NOT_FOUND' ? notFound() : error;
    });
    const transaction = response.transaction;
    if (!transaction) throw notFound();
    if (transaction.digest !== digest) throw badResponse('transaction digest does not match the request');
    return transaction;
  }

  async function getTransactionBalanceChanges(digest: string): Promise<BalanceChange[]> {
    const transaction = await fetchTransaction('getTransactionBalanceChanges', digest, ['balance_changes']);
    return parseBalanceChanges(transaction.balanceChanges);
  }

  /**
   * Reads a settled transaction's execution status together with its balance changes,
   * so a caller can never take the changes of a failed transaction as a payment.
   * Throws ChainError: INVALID_INPUT for a malformed digest, NOT_FOUND, BAD_RESPONSE when
   * the status is missing or contradictory, or any transport code.
   */
  async function getTransactionResult(digest: string): Promise<TransactionResult> {
    const transaction = await fetchTransaction('getTransactionResult', digest, ['effects.status', 'balance_changes']);
    return {
      status: executionOutcome(transaction.effects?.status),
      balanceChanges: parseBalanceChanges(transaction.balanceChanges),
    };
  }

  /** The epoch the chain is in now. Throws ChainError on any failure or a missing epoch. */
  async function getCurrentEpoch(): Promise<bigint> {
    const { response } = await bounded('getCurrentEpoch', (abort) =>
      grpc.ledgerService.getEpoch({ readMask: { paths: ['epoch'] } }, { abort }),
    );
    return parseUnsigned(response.epoch?.epoch, 'current epoch');
  }

  /**
   * Dry-runs exactly these bytes on Sui Mainnet through Tatum. Nothing is signed or
   * sent. Gas selection is off, because a gasless payment carries no gas on purpose,
   * and the node's own checks are on, so a refusal here is the one the network gives.
   *
   * A transaction the node refuses before running it, or that fails while running,
   * returns status "failure" with a fixed code: the chain's execution error kind, the
   * gRPC refusal code, or INSUFFICIENT_ADDRESS_BALANCE. Throws ChainError only when
   * there is no verdict on the transaction: INVALID_INPUT for empty bytes, TIMEOUT,
   * RATE_LIMITED, UNAUTHORIZED, UPSTREAM, LIMIT_EXCEEDED or BAD_RESPONSE.
   */
  async function simulate(txBytes: Uint8Array): Promise<SimulationResult> {
    if (!(txBytes instanceof Uint8Array) || txBytes.length === 0) {
      throw new ChainError('INVALID_INPUT', 'transaction bytes are empty');
    }
    const outcome = await bounded('simulate', async (abort) => {
      try {
        const { response } = await grpc.transactionExecutionService.simulateTransaction(
          {
            transaction: { bcs: { value: txBytes } },
            readMask: { paths: ['transaction.effects.status', 'transaction.balance_changes'] },
            checks: SimulationChecks.ENABLED,
            doGasSelection: false,
          },
          { abort },
        );
        return { refusal: null, response };
      } catch (error) {
        const refusal = simulationRefusal(error);
        if (refusal === null) throw error;
        return { refusal, response: null };
      }
    });
    if (outcome.refusal !== null) return { status: 'failure', errorCode: outcome.refusal, balanceChanges: [] };

    const transaction = outcome.response.transaction;
    if (!transaction) throw badResponse('simulation returned no transaction');
    const status = executionOutcome(transaction.effects?.status);
    return {
      status,
      errorCode: status === 'success' ? null : executionErrorCode(transaction.effects?.status?.error?.kind),
      balanceChanges: parseBalanceChanges(transaction.balanceChanges),
    };
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
    getTransactionResult,
    getCurrentEpoch,
    simulate,
    listOwnedWalrusBlobs,
    close: () => transport.close(),
  };
}
