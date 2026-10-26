import { ChannelCredentials } from '@grpc/grpc-js';
import { bcs } from '@mysten/sui/bcs';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { GrpcTypes, SuiGrpcClient } from '@mysten/sui/grpc';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import {
  deriveDynamicFieldID,
  fromBase64,
  isValidStructTag,
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
  SUI_TYPE_ARG,
} from '@mysten/sui/utils';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { type FinishedUnaryCall, type RpcInterceptor, UnaryCall } from '@protobuf-ts/runtime-rpc';
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

/**
 * Walrus Mainnet's shared System object, from @mysten/walrus MAINNET_WALRUS_PACKAGE_CONFIG. Its
 * inner state, a dynamic field keyed by the object's version, holds the committee and so the
 * current Walrus epoch, which is what a Blob's end_epoch is counted in, not Sui's.
 */
export const WALRUS_SYSTEM_OBJECT_ID = normalizeSuiAddress('0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2');
// A Move type keeps the address of the package that first defined it, the same for Blob and System.
const WALRUS_PACKAGE = parseStructTag(WALRUS_BLOB_TYPE).address;
const WALRUS_SYSTEM_TYPE = normalizeStructTag(`${WALRUS_PACKAGE}::system::System`);
const WALRUS_STATE_MODULE = 'system_state_inner';
const WALRUS_STATE_NAME = /^SystemStateInnerV[0-9]+$/;

const { ExecutionError_ExecutionErrorKind: ExecutionErrorKind, SimulateTransactionRequest_TransactionChecks: SimulationChecks } =
  GrpcTypes;
const { ChangedObject_IdOperation: IdOperation } = GrpcTypes;

const FRAMEWORK_ADDRESS = normalizeSuiAddress('0x2');

// The same fields are read when a transaction is sent and when its digest is looked up
// afterwards, so a landed transaction reads the same either way.
const EXECUTED_PATHS = [
  'digest',
  'effects.status',
  'balance_changes',
  'effects.changed_objects.object_id',
  'effects.changed_objects.object_type',
  'effects.changed_objects.id_operation',
];
// A sender and, when someone else pays the gas, that sponsor. Sui takes no others.
const MAX_SIGNATURES = 2;
// A ten-member multisig with zkLogin members stays well under this.
const MAX_SIGNATURE_CHARS = 16_384;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const U64_MAX = 2n ** 64n - 1n;
const U256_MAX = 2n ** 256n - 1n;
// The longest decimal u256. Longer text is refused before BigInt ever sees it.
const U256_MAX_DIGITS = 78;
// The allowance module refuses a longer name, so a longer one means the shape is not the module's.
const ALLOWANCE_NAME_MAX_CHARS = 128;

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
  | 'LIMIT_EXCEEDED'
  | 'BUDGET';

/** One request about to be sent to Tatum, as createChain's beforeRequest hook sees it. */
export interface TatumCall {
  transport: 'grpc' | 'graphql';
  /** The gRPC method name, or the GraphQL operation name ('graphql' when the query names none). */
  method: string;
}

/** Runs before every request to Tatum. Throwing, for any reason, stops the request from being sent. */
export type BeforeTatumRequest = (call: TatumCall) => void | Promise<void>;

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

export interface CreatedObject {
  objectId: string;
  /** normalizeStructTag form. */
  type: string;
}

export interface ExecutionResult {
  /** Computed from the signed bytes before they are sent, never taken from the gateway. */
  digest: string;
  status: ExecutionOutcome;
  /**
   * Null on success. Otherwise a fixed upper-case code: the chain's execution error kind,
   * or for bytes the network refused before running them, the gRPC refusal code or
   * INSUFFICIENT_ADDRESS_BALANCE. A refused transaction has no balance changes and cost nothing.
   */
  errorCode: string | null;
  balanceChanges: BalanceChange[];
  createdObjects: CreatedObject[];
}

export interface AllowanceState {
  /** The address whose address balance every spend debits. */
  funder: string;
  /** The only address that may send a spend. */
  spender: string;
  /** T in Allowance<Balance<T>>, normalizeStructTag form. */
  coinType: string;
  /** The most that may ever be spent, in atomic units. Null when only the rate limit bounds it. */
  lifetimeCap: bigint | null;
  /** Everything spent through the allowance so far. */
  spentTotal: bigint;
  /** Length of one fixed rate-limit window. Null when there is no rate limit. */
  periodMs: bigint | null;
  /** The most that may be spent inside one window. Null when there is no rate limit. */
  periodLimit: bigint | null;
  /** Spends at or after this time abort. Null when only the rate limit bounds time. */
  expirationMs: bigint | null;
  /** Names the allowance as a shared input in a spend. Read in the same request as the rest. */
  initialSharedVersion: bigint;
}

/**
 * Where the allowance's rate limit stands, read in the same request as AllowanceState. The
 * module keeps the amount spent in the window it last charged in, numbered from the time of
 * its first spend, and starts a new window at the first spend after that one ends.
 */
export interface AllowanceWindow {
  /**
   * Spent inside the window the allowance last charged in. Null when there is no rate limit.
   * It stops counting at periodEndMs: the next spend after that opens a new, empty window.
   */
  periodSpent: bigint | null;
  /**
   * When the window the allowance last charged in ends: its first spend's time plus (window
   * number + 1) periods. Null when there is no rate limit, or nothing has been spent yet,
   * since the first spend is what opens the first window.
   */
  periodEndMs: bigint | null;
}

/** What getAllowance reads: the allowance's terms and where its current rate window stands. */
export type AllowanceReading = AllowanceState & AllowanceWindow;

export interface WalrusBlob {
  objectId: string;
  /** Walrus's own text form (URL-safe base64 of the little-endian u256), the form Walrus Memory reports. */
  blobId: string;
  registeredEpoch: number;
  endEpoch: number;
  deletable: boolean;
}

export interface ScannedWalrusBlob extends WalrusBlob {
  /** The Walrus epoch the blob was certified in, or null while it is not certified and so not yet readable from Walrus. */
  certifiedEpoch: number | null;
}

export interface WalrusBlobScan {
  blobs: ScannedWalrusBlob[];
  /** Where the next stretch starts, or null when this one reached the end of the listing. */
  next: string | null;
}

export interface Chain {
  /** True when an API key is sent with every request; false for the anonymous gateway. */
  readonly usesApiKey: boolean;
  /** Raw gRPC client. Calls made on it directly get the transport timeout and the beforeRequest hook, but no retries. */
  readonly grpc: SuiGrpcClient;
  /** Raw GraphQL client. Calls made on it directly get the fetch timeout and the beforeRequest hook, but no retries. */
  readonly graphql: SuiGraphQLClient;
  getReferenceGasPrice(): Promise<bigint>;
  getBalances(address: string): Promise<Balances>;
  getTransactionBalanceChanges(digest: string): Promise<BalanceChange[]>;
  getTransactionResult(digest: string): Promise<TransactionResult>;
  getCurrentEpoch(): Promise<bigint>;
  simulate(txBytes: Uint8Array): Promise<SimulationResult>;
  listOwnedWalrusBlobs(owner: string): Promise<WalrusBlob[]>;
  /**
   * One stretch of the owner's Walrus Blob objects: at most `maxPages` pages, from `after`, or
   * from the start when it is null. Anyone can send Blob objects to an address, so a caller
   * that must get through them all carries `next` to its next call instead of one long read.
   */
  scanOwnedWalrusBlobs(owner: string, opts: { after: string | null; maxPages: number }): Promise<WalrusBlobScan>;
  /** The epoch Walrus Mainnet is in now, the one a Blob's end_epoch counts in. Not Sui's epoch. */
  getWalrusEpoch(): Promise<number>;
  executeTransaction(txBytes: Uint8Array, signatures: string[]): Promise<ExecutionResult>;
  getAllowance(objectId: string): Promise<AllowanceReading>;
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

/**
 * Maps any failure from the gateway or the transport to a ChainError, reading only the
 * top-level error: a ChainError passes through, an RpcError (matched by shape) is sorted
 * by its gRPC status, an abort or timeout is TIMEOUT, and anything else is a retryable
 * UPSTREAM. Never copies upstream text into the result and never throws.
 */
export function classifyChainError(error: unknown): ChainError {
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

const GRAPHQL_OPERATION = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]{0,63})\b/;

/** The operation name a GraphQL request body names, or 'graphql'. Only a plain identifier is ever passed on. */
function graphqlOperation(body: unknown): string {
  if (typeof body !== 'string') return 'graphql';
  try {
    const { query } = JSON.parse(body) as { query?: unknown };
    return (typeof query === 'string' ? GRAPHQL_OPERATION.exec(query)?.[1] : undefined) ?? 'graphql';
  } catch {
    return 'graphql';
  }
}

/**
 * Puts `admit` in front of every unary call on the transport, so calls the Sui SDK makes through
 * the raw client pass it as well as this module's own. A unary call has to be returned at once,
 * so it is returned as a promise of the real call made only after `admit` resolves. Streaming
 * calls cannot be counted one request at a time, and Ellai makes none, so they are refused.
 */
function admittingInterceptor(admit: (call: TatumCall) => Promise<void>): RpcInterceptor {
  const unmetered = (): never => {
    throw new ChainError('BUDGET', 'streaming calls to Tatum cannot be counted, so none is sent');
  };
  return {
    interceptUnary(next, method, input, options) {
      // A UnaryCall is a thenable, so this settles once the whole call has.
      const finished: Promise<FinishedUnaryCall<object, object>> = admit({ transport: 'grpc', method: method.name }).then(() => {
        // An abort listener added after the signal fired never runs, so a call whose deadline
        // passed while admit ran would otherwise still be sent.
        if (options.abort?.aborted) throw new ChainError('TIMEOUT', `${method.name} was abandoned before it was sent`, true);
        return next(method, input, options);
      });
      const part = <T>(pick: (call: FinishedUnaryCall<object, object>) => T): Promise<T> => {
        const settled = finished.then(pick);
        // As grpc-transport's own parts do: a caller that awaits only the response must not
        // leave the other parts of a refused call as unhandled rejections.
        settled.catch(() => undefined);
        return settled;
      };
      return new UnaryCall(
        method,
        options.meta ?? {},
        input,
        part((call) => call.headers),
        part((call) => call.response),
        part((call) => call.status),
        part((call) => call.trailers),
      );
    },
    interceptServerStreaming: unmetered,
    interceptClientStreaming: unmetered,
    interceptDuplex: unmetered,
  };
}

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
 * A gRPC refusal that is about the transaction itself (the same codes classifyChainError
 * reads as INVALID_INPUT) becomes a short code: the gRPC code name, or
 * INSUFFICIENT_ADDRESS_BALANCE when the node says the sender's address balance cannot
 * cover it. Anything else, such as a timeout or a rate limit, returns null and stays an error.
 */
function simulationRefusal(error: unknown): string | null {
  if (classifyChainError(error).code !== 'INVALID_INPUT') return null;
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

// Its own schema, so the list function reads exactly what it always has. certified_epoch must be
// present, as a number or null: a page without it cannot say whether a blob is readable.
const blobScanPageSchema = z.object({
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
                certified_epoch: epoch.nullable(),
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

type UserSignatureInput = { bcs: { value: Uint8Array }; signature: { oneofKind: undefined } };

/** The message never repeats a signature, because a signature over unsent bytes is a bearer value. */
function signatureInputs(signatures: unknown): UserSignatureInput[] {
  if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
    throw new ChainError('INVALID_INPUT', `a transaction needs between 1 and ${MAX_SIGNATURES} signatures`);
  }
  return signatures.map((signature: unknown) => {
    if (
      typeof signature !== 'string' ||
      signature.length === 0 ||
      signature.length > MAX_SIGNATURE_CHARS ||
      !STRICT_BASE64.test(signature)
    ) {
      throw new ChainError('INVALID_INPUT', 'a signature is not base64');
    }
    return { bcs: { value: fromBase64(signature) }, signature: { oneofKind: undefined } };
  });
}

function executedResult(transaction: GrpcTypes.ExecutedTransaction | undefined, digest: string): ExecutionResult {
  if (!transaction) throw badResponse('execution returned no transaction');
  if (transaction.digest !== digest) throw badResponse('the executed digest is not the digest of the signed bytes');
  const status = executionOutcome(transaction.effects?.status);
  const createdObjects = (transaction.effects?.changedObjects ?? [])
    .filter((change) => change.idOperation === IdOperation.CREATED)
    .map((change) => ({
      objectId: chainAddress(change.objectId, 'created object id'),
      type: chainStructTag(change.objectType, 'created object type'),
    }));
  return {
    digest,
    status,
    errorCode: status === 'success' ? null : executionErrorCode(transaction.effects?.status?.error?.kind),
    balanceChanges: parseBalanceChanges(transaction.balanceChanges),
    createdObjects,
  };
}

const uintText = z.string().max(U256_MAX_DIGITS).regex(/^(0|[1-9]\d*)$/);

// Strict objects: a field the allowance module does not have today, or a window kind
// other than fixed milliseconds, is an unknown shape and is refused rather than skipped.
const allowanceObjectSchema = z.strictObject({
  object: z
    .strictObject({
      address: z.string(),
      owner: z.strictObject({ __typename: z.string(), initialSharedVersion: z.number().int().positive().optional() }),
      asMoveObject: z
        .strictObject({
          contents: z.strictObject({
            type: z.strictObject({ repr: z.string() }),
            json: z.strictObject({
              id: z.string(),
              settings: z.strictObject({
                funder: z.string(),
                spender: z.string().nullable(),
                app: z.string().nullable(),
                lifetime_cap: uintText.nullable(),
                start_timestamp_ms: uintText.nullable(),
                expiration_timestamp_ms: uintText.nullable(),
                rate_limit: z
                  .strictObject({
                    '@variant': z.literal('Windowed'),
                    limit: uintText,
                    spent: uintText,
                    anchor_ms: uintText.nullable(),
                    index: uintText,
                    window: z.strictObject({ '@variant': z.literal('PeriodicMs'), pos0: uintText }),
                  })
                  .nullable(),
                name: z.string().max(ALLOWANCE_NAME_MAX_CHARS),
              }),
              current_spend: uintText,
            }),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const moveObjectSchema = z.object({
  object: z
    .object({
      address: z.string(),
      asMoveObject: z.object({ contents: z.object({ type: z.object({ repr: z.string() }), json: z.unknown() }) }).nullable(),
    })
    .nullable(),
});

// Not strict: these objects carry many fields Ellai does not read, and only the ones below decide anything.
const walrusSystemSchema = z.object({ id: z.string(), version: z.string().max(U256_MAX_DIGITS).regex(/^(0|[1-9]\d*)$/) });
const walrusStateFieldSchema = z.object({
  id: z.string(),
  name: z.string().max(U256_MAX_DIGITS).regex(/^(0|[1-9]\d*)$/),
  value: z.object({ committee: z.object({ epoch }) }),
});

const MOVE_OBJECT_QUERY = `
  query EllaiMoveObject($id: SuiAddress!) {
    object(address: $id) {
      address
      asMoveObject { contents { type { repr } json } }
    }
  }
`;

const ALLOWANCE_QUERY = `
  query EllaiAllowance($id: SuiAddress!) {
    object(address: $id) {
      address
      owner { __typename ... on Shared { initialSharedVersion } }
      asMoveObject { contents { type { repr } json } }
    }
  }
`;

function unsignedAtMost(text: string, max: bigint, what: string): bigint {
  const value = BigInt(text);
  if (value > max) throw badResponse(`${what} is out of range`);
  return value;
}

/** T from 0x2::allowance::Allowance<0x2::balance::Balance<T>>, read by the SDK's own type parser. */
function allowanceCoinType(repr: string): string {
  const outer = parseStructTag(chainStructTag(repr, 'allowance type'));
  const [balance] = outer.typeParams;
  if (
    outer.address !== FRAMEWORK_ADDRESS ||
    outer.module !== 'allowance' ||
    outer.name !== 'Allowance' ||
    outer.typeParams.length !== 1 ||
    typeof balance !== 'object'
  ) {
    throw badResponse('the object is not a Sui allowance');
  }
  const [coin] = balance.typeParams;
  if (
    balance.address !== FRAMEWORK_ADDRESS ||
    balance.module !== 'balance' ||
    balance.name !== 'Balance' ||
    balance.typeParams.length !== 1 ||
    typeof coin !== 'object'
  ) {
    throw badResponse('the allowance is not over the Balance of a coin');
  }
  return chainStructTag(normalizeStructTag(coin), 'allowance coin type');
}

/**
 * Connects to Tatum's Sui Mainnet gateway: gRPC over the native HTTP/2 transport
 * (the SDK's default gRPC-web transport is refused by Tatum) and GraphQL.
 * Server only. The key, when given, is sent as the x-api-key header and nowhere else.
 * Every function below has a timeout of LIMITS.tatumTimeoutMs per attempt and at most
 * LIMITS.tatumRetries retries, used only for errors that can clear on their own, and
 * throws ChainError on any failure. Responses are size-capped: a GraphQL body at
 * LIMITS.graphqlMaxResponseBytes and a gRPC message at LIMITS.grpcMaxReceiveBytes; going
 * over either is LIMIT_EXCEEDED and is not retried.
 *
 * `beforeRequest`, when given, is awaited before every request sent to Tatum: each gRPC call on
 * the transport, the Sui SDK's own calls through `grpc` included, each GraphQL fetch, each page
 * and each retry. If it throws, nothing is sent and that request fails with ChainError BUDGET,
 * which is never retried; streaming gRPC calls are then refused the same way, since they cannot
 * be counted. Without it nothing runs before a request.
 */
export function createChain(opts: { apiKey?: string; beforeRequest?: BeforeTatumRequest }): Chain {
  const apiKey = opts.apiKey === '' ? undefined : opts.apiKey;
  const { beforeRequest } = opts;
  // The hook's own error is never kept: it is the caller's code, and its text is not this module's to pass on.
  const admit =
    beforeRequest === undefined
      ? null
      : async (call: TatumCall): Promise<void> => {
          try {
            await beforeRequest(call);
          } catch {
            throw new ChainError('BUDGET', `${call.method} refused by the request budget, nothing was sent`);
          }
        };

  const transport = new GrpcTransport({
    host: TATUM_GRPC_HOST,
    channelCredentials: ChannelCredentials.createSsl(),
    timeout: LIMITS.tatumTimeoutMs,
    clientOptions: { 'grpc.max_receive_message_length': LIMITS.grpcMaxReceiveBytes },
    ...(apiKey ? { meta: { [API_KEY_HEADER]: apiKey } } : {}),
    ...(admit ? { interceptors: [admittingInterceptor(admit)] } : {}),
  });
  const grpc = new SuiGrpcClient({ network: 'mainnet', transport });

  const boundedFetch: typeof fetch = async (input, init) => {
    if (admit) await admit({ transport: 'graphql', method: graphqlOperation(init?.body) });
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
        const failure = classifyChainError(error);
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

        // Tatum omits a part that is zero: a wallet holding only an address balance comes
        // back with no coin_balance, and an emptied wallet comes back as total "0" with
        // neither part. A missing part reads as zero, checked by the sum below. Both parts
        // missing with a non-zero total would hide a gateway that cannot tell the pools
        // apart, so that is refused, unlike the SDK wrapper, which turns any gap into "0".
        const total = parseUnsigned(entry.balance, `${coinType} total balance`);
        if (entry.addressBalance === undefined && entry.coinBalance === undefined && total !== 0n) {
          throw badResponse(`${coinType} balance has neither an address part nor a coin part`);
        }
        const inAddress = entry.addressBalance === undefined ? 0n : parseUnsigned(entry.addressBalance, `${coinType} address balance`);
        const inCoins = entry.coinBalance === undefined ? 0n : parseUnsigned(entry.coinBalance, `${coinType} coin balance`);
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

  /**
   * Reads at most `maxPages` pages of LIMITS.graphqlPageSize Walrus Blob objects owned by
   * `owner`, through Tatum GraphQL, starting at the cursor `after` (null for the first page), with
   * the same checks per object as listOwnedWalrusBlobs plus certified_epoch. Each page has the
   * usual timeout and retries; a stretch is never more than LIMITS.graphqlMaxPages pages. `next`
   * is the cursor after the last page read, or null once the listing has no more pages, so a
   * stretch that ends exactly at the end of the listing says so.
   * Throws ChainError: INVALID_INPUT for a malformed owner, `maxPages` outside 1 to
   * LIMITS.graphqlMaxPages, or a cursor that is empty or over LIMITS.graphqlCursorMaxChars;
   * BAD_RESPONSE for a page of the wrong shape, a next page promised without a cursor or with one
   * over that length; UPSTREAM for GraphQL errors; or any transport code.
   */
  async function scanOwnedWalrusBlobs(owner: string, opts: { after: string | null; maxPages: number }): Promise<WalrusBlobScan> {
    const ownerAddress = inputAddress(owner);
    const { maxPages } = opts;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > LIMITS.graphqlMaxPages) {
      throw new ChainError('INVALID_INPUT', `maxPages must be a whole number from 1 to ${LIMITS.graphqlMaxPages}`);
    }
    let after = opts.after;
    if (after !== null && (typeof after !== 'string' || after.length === 0 || after.length > LIMITS.graphqlCursorMaxChars)) {
      throw new ChainError('INVALID_INPUT', `a page cursor is 1 to ${LIMITS.graphqlCursorMaxChars} characters`);
    }
    const blobs: ScannedWalrusBlob[] = [];

    for (let page = 0; page < maxPages; page++) {
      const variables: Record<string, unknown> = {
        owner: ownerAddress,
        type: WALRUS_BLOB_TYPE,
        first: LIMITS.graphqlPageSize,
        after,
      };
      const result = await bounded('scanOwnedWalrusBlobs', (signal) =>
        graphql.query({ query: BLOBS_QUERY, variables, signal }),
      );
      if (result.errors?.length) {
        throw new ChainError('UPSTREAM', `Tatum scanOwnedWalrusBlobs: GraphQL returned ${result.errors.length} error(s)`);
      }
      const parsed = blobScanPageSchema.safeParse(result.data);
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
          certifiedEpoch: node.contents.json.certified_epoch,
          endEpoch: node.contents.json.storage.end_epoch,
          deletable: node.contents.json.deletable,
        });
      }

      if (!pageInfo.hasNextPage) return { blobs, next: null };
      if (!pageInfo.endCursor) throw badResponse('next page promised without a cursor');
      if (pageInfo.endCursor.length > LIMITS.graphqlCursorMaxChars) throw badResponse('the page cursor is longer than Ellai keeps');
      after = pageInfo.endCursor;
    }
    return { blobs, next: after };
  }

  /** One Move object read through Tatum GraphQL, its type normalised and its contents not yet checked. */
  async function readMoveObject(operation: string, id: string): Promise<{ type: string; json: unknown }> {
    const result = await bounded(operation, (signal) => graphql.query({ query: MOVE_OBJECT_QUERY, variables: { id }, signal }));
    if (result.errors?.length) throw new ChainError('UPSTREAM', `Tatum ${operation}: GraphQL returned ${result.errors.length} error(s)`);
    const parsed = moveObjectSchema.safeParse(result.data);
    if (!parsed.success) throw badResponse(`${operation} object has the wrong shape`);
    const object = parsed.data.object;
    if (object === null) throw new ChainError('NOT_FOUND', `Tatum ${operation}: object ${id} was not found on Sui mainnet`);
    if (chainAddress(object.address, 'object id') !== id) throw badResponse('the object returned is not the one asked for');
    if (object.asMoveObject === null) throw badResponse(`${operation} object is not a Move object`);
    return { type: chainStructTag(object.asMoveObject.contents.type.repr, `${operation} object type`), json: object.asMoveObject.contents.json };
  }

  /**
   * Reads the current Walrus epoch the way Walrus's own client does: the System object's version,
   * then the dynamic field that version names, whose value's committee.epoch is the epoch. Two
   * GraphQL requests, each with the usual timeout and retries. Every object id, type and the
   * field's name are checked against what was asked for, so another object cannot stand in.
   * Throws ChainError: NOT_FOUND, BAD_RESPONSE for any other shape or type, UPSTREAM for GraphQL
   * errors, or any transport code.
   */
  async function getWalrusEpoch(): Promise<number> {
    const system = await readMoveObject('getWalrusEpoch', WALRUS_SYSTEM_OBJECT_ID);
    if (system.type !== WALRUS_SYSTEM_TYPE) throw badResponse('the Walrus system object has another type');
    const fields = walrusSystemSchema.safeParse(system.json);
    if (!fields.success || chainAddress(fields.data.id, 'Walrus system id field') !== WALRUS_SYSTEM_OBJECT_ID) {
      throw badResponse('the Walrus system object has an unknown shape');
    }
    const version = unsignedAtMost(fields.data.version, U64_MAX, 'the Walrus system version');

    const fieldId = deriveDynamicFieldID(WALRUS_SYSTEM_OBJECT_ID, 'u64', bcs.u64().serialize(version).toBytes());
    const state = await readMoveObject('getWalrusEpoch', fieldId);
    const field = parseStructTag(state.type);
    const [key, inner] = field.typeParams;
    if (
      field.address !== FRAMEWORK_ADDRESS ||
      field.module !== 'dynamic_field' ||
      field.name !== 'Field' ||
      field.typeParams.length !== 2 ||
      key !== 'u64' ||
      typeof inner !== 'object' ||
      inner.address !== WALRUS_PACKAGE ||
      inner.module !== WALRUS_STATE_MODULE ||
      !WALRUS_STATE_NAME.test(inner.name)
    ) {
      throw badResponse('the Walrus system state is not of the type expected');
    }
    const contents = walrusStateFieldSchema.safeParse(state.json);
    if (!contents.success || chainAddress(contents.data.id, 'Walrus state id field') !== fieldId || BigInt(contents.data.name) !== version) {
      throw badResponse('the Walrus system state has an unknown shape');
    }
    return contents.data.value.committee.epoch;
  }

  /** One read of a digest's outcome, no retries. Null while the chain has no such transaction. */
  async function landedResult(digest: string): Promise<ExecutionResult | null> {
    try {
      const { response } = await attempt((abort) =>
        grpc.ledgerService.getTransaction({ digest, readMask: { paths: EXECUTED_PATHS } }, { abort }),
      );
      return response.transaction ? executedResult(response.transaction, digest) : null;
    } catch (error) {
      const failure = classifyChainError(error);
      if (failure.code === 'NOT_FOUND') return null;
      throw failure;
    }
  }

  /**
   * Sends signed bytes to Sui Mainnet through Tatum and returns what the chain did with
   * them. The digest is computed here from the bytes, so the result always names the
   * transaction that was signed.
   *
   * Identical signed bytes always have the same digest and Sui runs a digest at most once,
   * so retrying is safe; even so, after a timeout or a transient error the digest is
   * looked up first, at least LIMITS.tatumRetryDelayMs later, and the bytes are sent again
   * only when the chain does not have it. A refusal is believed only after the same lookup,
   * also LIMITS.tatumRetryDelayMs later, because bytes that landed through an earlier send
   * can be refused when sent again; a failed lookup there, RATE_LIMITED included, is an
   * unknown outcome and nothing is sent again. At most LIMITS.tatumRetries further rounds,
   * each bounded by LIMITS.tatumTimeoutMs per request.
   *
   * Returns status "failure" with a fixed code for a transaction that ran and failed, or
   * that the network refused before running it. Throws ChainError INVALID_INPUT for empty
   * bytes or bad signatures without sending anything. Any other ChainError means the
   * outcome is unknown, and its message says so and names the digest to read later.
   */
  async function executeTransaction(txBytes: Uint8Array, signatures: string[]): Promise<ExecutionResult> {
    if (!(txBytes instanceof Uint8Array) || txBytes.length === 0) {
      throw new ChainError('INVALID_INPUT', 'transaction bytes are empty');
    }
    const userSignatures = signatureInputs(signatures);
    const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
    const outcomeUnknown = (failure: ChainError) =>
      scrub(
        new ChainError(
          failure.code,
          `Tatum executeTransaction: ${failure.message}; transaction ${digest} may have landed, read it before building another`,
          failure.retryable,
        ),
      );

    let lastFailure: ChainError | null = null;
    for (let round = 0; round <= LIMITS.tatumRetries; round++) {
      if (lastFailure !== null) {
        await sleep(LIMITS.tatumRetryDelayMs * 2 ** (round - 1));
        let landed: ExecutionResult | null;
        try {
          landed = await landedResult(digest);
        } catch (error) {
          lastFailure = classifyChainError(error);
          if (!lastFailure.retryable) throw outcomeUnknown(lastFailure);
          continue;
        }
        if (landed !== null) return landed;
      }
      try {
        const { response } = await attempt((abort) =>
          grpc.transactionExecutionService.executeTransaction(
            { transaction: { bcs: { value: txBytes } }, signatures: userSignatures, readMask: { paths: EXECUTED_PATHS } },
            { abort },
          ),
        );
        return executedResult(response.transaction, digest);
      } catch (error) {
        const failure = classifyChainError(error);
        if (failure.code === 'INVALID_INPUT') {
          const refusal = simulationRefusal(error) ?? 'REFUSED';
          // Tatum's free plan answers about 3 requests a second, so a read sent the moment the
          // send is refused is often rate limited and the outcome would read as unknown.
          await sleep(LIMITS.tatumRetryDelayMs);
          let landed: ExecutionResult | null;
          try {
            landed = await landedResult(digest);
          } catch (lookupError) {
            throw outcomeUnknown(classifyChainError(lookupError));
          }
          return landed ?? { digest, status: 'failure', errorCode: refusal, balanceChanges: [], createdObjects: [] };
        }
        if (!failure.retryable) throw outcomeUnknown(failure);
        lastFailure = failure;
      }
    }
    throw outcomeUnknown(lastFailure ?? new ChainError('UPSTREAM', 'no attempt was made', true));
  }

  /**
   * Reads a direct (not app-bound) allowance from Sui Mainnet through Tatum GraphQL, in
   * one request, with where its rate window stands (AllowanceWindow). Every address and the
   * coin type come out of the SDK normalisers.
   * Refuses, as BAD_RESPONSE, anything that is not exactly the allowance module's shape
   * today: another object type, an app-bound allowance, one with no spender or with a
   * start time (Ellai never sets one, and the result has nowhere to report it), a
   * calendar-month window, an unknown field, a number out of range, or a rate limit the
   * module could not have written: spending with no first-spend time, or more spent in a
   * window than its limit.
   * Throws ChainError: INVALID_INPUT for a malformed id, NOT_FOUND when no object has the
   * id (never issued, revoked, or not yet indexed), or any transport code.
   */
  async function getAllowance(objectId: string): Promise<AllowanceReading> {
    const id = inputAddress(objectId);
    const result = await bounded('getAllowance', (signal) =>
      graphql.query({ query: ALLOWANCE_QUERY, variables: { id }, signal }),
    );
    if (result.errors?.length) {
      throw new ChainError('UPSTREAM', `Tatum getAllowance: GraphQL returned ${result.errors.length} error(s)`);
    }
    const parsed = allowanceObjectSchema.safeParse(result.data);
    if (!parsed.success) throw badResponse('the allowance object has an unknown shape');
    const object = parsed.data.object;
    if (object === null) throw new ChainError('NOT_FOUND', `Allowance ${id} was not found on Sui mainnet`);
    if (chainAddress(object.address, 'allowance object id') !== id) throw badResponse('the object returned is not the one asked for');
    if (object.asMoveObject === null) throw badResponse('the object is not a Move object');
    const { type, json } = object.asMoveObject.contents;
    const coinType = allowanceCoinType(type.repr);
    if (chainAddress(json.id, 'allowance id field') !== id) throw badResponse('the allowance contents name another object');
    const { initialSharedVersion } = object.owner;
    if (object.owner.__typename !== 'Shared' || initialSharedVersion === undefined) {
      throw badResponse('the allowance is not a shared object');
    }

    const { settings } = json;
    if (settings.app !== null) throw badResponse('the allowance is bound to an app, which Ellai does not spend from');
    if (settings.spender === null) throw badResponse('the allowance has no spender');
    if (settings.start_timestamp_ms !== null) throw badResponse('the allowance has a start time, which Ellai never sets');
    const rate = settings.rate_limit;
    let window: AllowanceWindow = { periodSpent: null, periodEndMs: null };
    if (rate !== null) {
      const period = unsignedAtMost(rate.window.pos0, U64_MAX, 'the rate-limit period');
      const limit = unsignedAtMost(rate.limit, U256_MAX, 'the rate-limit amount');
      const spent = unsignedAtMost(rate.spent, U256_MAX, 'the amount spent in the window');
      const index = unsignedAtMost(rate.index, U64_MAX, 'the window number');
      const anchor = rate.anchor_ms === null ? null : unsignedAtMost(rate.anchor_ms, U64_MAX, 'the first spend time');
      // The module stamps the first spend's time in the same step that records it, and aborts
      // any spend that takes a window past its limit, so it never writes either of these.
      if (anchor === null && (spent !== 0n || index !== 0n)) throw badResponse('the rate limit has spending but no first spend time');
      if (spent > limit) throw badResponse('the window has more spent than its limit');
      window = { periodSpent: spent, periodEndMs: anchor === null ? null : anchor + (index + 1n) * period };
    }
    return {
      ...window,
      funder: chainAddress(settings.funder, 'allowance funder'),
      spender: chainAddress(settings.spender, 'allowance spender'),
      coinType,
      lifetimeCap: settings.lifetime_cap === null ? null : unsignedAtMost(settings.lifetime_cap, U256_MAX, 'the lifetime cap'),
      spentTotal: unsignedAtMost(json.current_spend, U256_MAX, 'the amount spent'),
      periodMs: rate === null ? null : unsignedAtMost(rate.window.pos0, U64_MAX, 'the rate-limit period'),
      periodLimit: rate === null ? null : unsignedAtMost(rate.limit, U256_MAX, 'the rate-limit amount'),
      expirationMs:
        settings.expiration_timestamp_ms === null
          ? null
          : unsignedAtMost(settings.expiration_timestamp_ms, U64_MAX, 'the expiration'),
      initialSharedVersion: BigInt(initialSharedVersion),
    };
  }

  return {
    usesApiKey: apiKey !== undefined,
    grpc,
    graphql,
    getReferenceGasPrice,
    getBalances,
    getTransactionBalanceChanges,
    getTransactionResult,
    getCurrentEpoch,
    simulate,
    listOwnedWalrusBlobs,
    scanOwnedWalrusBlobs,
    getWalrusEpoch,
    executeTransaction,
    getAllowance,
    close: () => transport.close(),
  };
}
