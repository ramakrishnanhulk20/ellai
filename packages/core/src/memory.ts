import { bcs } from '@mysten/sui/bcs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { deriveDynamicFieldID, normalizeStructTag, normalizeSuiAddress, toBase64, toHex } from '@mysten/sui/utils';
import { MemWal } from '@mysten-incubation/memwal';
import { addDelegateKey, type CreateAccountOpts, createAccount } from '@mysten-incubation/memwal/account';
import { type Chain, ChainError, classifyChainError } from './chain.js';
import { canonicalSuiAddress } from './keys.js';
import { LIMITS } from './limits.js';

/** Walrus Memory's Sui Mainnet package, as the hosted relayer's GET /config reports it. */
export const WALRUS_MEMORY_PACKAGE_ID = '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5';
/**
 * The shared registry that maps each owner address to its one account. The relayer's
 * /config does not publish it (MemWal issue #1152); its type was read from chain.
 */
export const WALRUS_MEMORY_REGISTRY_ID = '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f';
export const DEFAULT_RELAYER_URL = 'https://relayer.memory.walrus.xyz';

const SUI_CLOCK_ID = normalizeSuiAddress('0x6');
const REGISTRY_TYPE = normalizeStructTag(`${WALRUS_MEMORY_PACKAGE_ID}::account::AccountRegistry`);
const ACCOUNT_TYPE = normalizeStructTag(`${WALRUS_MEMORY_PACKAGE_ID}::account::MemWalAccount`);
const ACCOUNT_FIELD_TYPE = normalizeStructTag('0x2::dynamic_field::Field<address, 0x2::object::ID>');
// create_account and add_delegate_key abort unless the registry is on this schema
// version. Any other value means the package moved on and this file must be re-read.
const REGISTRY_VERSION = '4';
const ED25519_PUBLIC_KEY_BYTES = 32;
// Stored on chain in the clear next to the key, so it names the app and nothing else.
const DELEGATE_LABEL = 'Ellai';
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_GATEWAY_TIMEOUT = 504;

// Job ids, blob ids and namespaces are echoed into output and stored, so each is held to a
// short fixed character set instead of being trusted as whatever the relayer sent.
const RELAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const TIMESTAMP_PATTERN = /^[0-9T:.+Z-]{1,40}$/;
// The relayer rejects blank text, and a lone zero-width space hangs it (MemWal issue #1156).
const INVISIBLE = /[\s​-‍⁠﻿]/gu;

export type MemoryErrorCode = 'ACCOUNT' | 'DELEGATE' | 'WRITE' | 'RECALL' | 'TIMEOUT' | 'RATE_LIMITED' | 'UPSTREAM';

/**
 * Every failure from this module. The message is fixed text plus counts, status codes and
 * ids this module validated. Upstream error text is never copied in and the upstream error
 * is never attached, so a key, a signature or a relayer body cannot ride along into a log.
 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const RegistryBcs = bcs.struct('AccountRegistry', {
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

const AccountFieldBcs = bcs.struct('Field', { id: bcs.Address, name: bcs.Address, value: bcs.Address });

const AccountBcs = bcs.struct('MemWalAccount', {
  id: bcs.Address,
  owner: bcs.Address,
  delegate_keys: bcs.vector(
    bcs.struct('DelegateKey', {
      public_key: bcs.byteVector(),
      sui_address: bcs.Address,
      label: bcs.string(),
      created_at: bcs.u64(),
    }),
  ),
  created_at: bcs.u64(),
  active: bcs.bool(),
  admin_quarantined: bcs.bool(),
  legacy_account_id: bcs.option(bcs.Address),
  access_counter_version: bcs.u64(),
});

/** Parses the whole of `bytes` or fails: bcs reads a prefix and ignores the rest, which would hide a layout change. */
function decodeExact<T>(schema: { parse(bytes: Uint8Array): T; serialize(value: never): { toBytes(): Uint8Array } }, bytes: Uint8Array, what: string): T {
  let value: T;
  try {
    value = schema.parse(bytes);
  } catch {
    throw new MemoryError('UPSTREAM', `${what} does not have the expected layout`);
  }
  if (schema.serialize(value as never).toBytes().length !== bytes.length) {
    throw new MemoryError('UPSTREAM', `${what} has bytes past the expected layout`);
  }
  return value;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// Calls made through chain.grpc directly get the transport timeout but no retries and no
// pacing, and anonymous Tatum allows 5 requests a minute. Every account step goes through
// here so a first run, about a dozen requests, never bursts past that. A chain with an API
// key is not held to the anonymous rate; a rate limit there is still retried by tatumStep.
const tatumRequestTimes: number[] = [];

async function reserveTatum(chain: Chain, requests: number): Promise<void> {
  if (chain.usesApiKey) return;
  for (;;) {
    const now = Date.now();
    while (tatumRequestTimes.length > 0 && (tatumRequestTimes[0] ?? 0) <= now - LIMITS.tatumPacingWindowMs) {
      tatumRequestTimes.shift();
    }
    if (tatumRequestTimes.length + requests <= LIMITS.tatumAnonymousRequestsPerMinute) {
      for (let i = 0; i < requests; i++) tatumRequestTimes.push(now);
      return;
    }
    await sleep((tatumRequestTimes[0] ?? now) + LIMITS.tatumPacingWindowMs - now);
  }
}

/** The gateway's RpcError, found by shape: the SDK wraps it in a SimulationError as `cause`. */
function rpcErrorIn(error: unknown): { rpcError: object; code: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    const { name, code, cause } = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === 'RpcError' && typeof code === 'string') {
      return { rpcError: current, code: /^[A-Z_]+$/.test(code) ? code : 'UNKNOWN' };
    }
    current = cause;
  }
  return null;
}

function tatumFailure(error: unknown, fallback: MemoryErrorCode): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof ChainError) {
    // The caller's own Tatum budget refused it and nothing was sent; callers answer that with
    // "try tomorrow", so it must reach them as it is, never as a Tatum failure.
    if (error.code === 'BUDGET') throw error;
    if (error.code === 'RATE_LIMITED') return new MemoryError('RATE_LIMITED', 'Tatum rate limited a Walrus Memory account step');
    if (error.code === 'TIMEOUT') return new MemoryError('TIMEOUT', 'Tatum did not answer a Walrus Memory account step in time');
    return new MemoryError('UPSTREAM', `Tatum refused a Walrus Memory account step (${error.code})`);
  }
  const rpc = rpcErrorIn(error);
  if (rpc) {
    // chain.ts owns the reading of a gRPC status, including the fixed phrases that tell a
    // rate limit from an oversized message. The codes and wording here stay this module's.
    const status = classifyChainError(rpc.rpcError).code;
    if (status === 'RATE_LIMITED') {
      return new MemoryError('RATE_LIMITED', `Tatum rate limited a Walrus Memory account step (gRPC ${rpc.code})`);
    }
    if (status === 'TIMEOUT') {
      return new MemoryError('TIMEOUT', `Tatum did not answer a Walrus Memory account step in time (gRPC ${rpc.code})`);
    }
    if (status === 'INVALID_INPUT') {
      return new MemoryError(fallback, `Sui refused a Walrus Memory account step (gRPC ${rpc.code})`);
    }
    return new MemoryError('UPSTREAM', `Tatum gateway error on a Walrus Memory account step (gRPC ${rpc.code})`);
  }
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new MemoryError('TIMEOUT', 'a Walrus Memory account step did not finish in time; run again, a landed transaction is found and reused');
  }
  if (name === 'SimulationError') return new MemoryError(fallback, 'the Walrus Memory transaction would fail on chain');
  return new MemoryError(fallback, 'a Walrus Memory account step failed');
}

/** One Tatum step: paced when the chain is anonymous, and tried again after a rate limit up to LIMITS.tatumRateLimitRetries times. */
async function tatumStep<T>(chain: Chain, fallback: MemoryErrorCode, requests: number, run: () => PromiseLike<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    await reserveTatum(chain, requests);
    try {
      return await run();
    } catch (error) {
      const failure = tatumFailure(error, fallback);
      if (failure.code !== 'RATE_LIMITED' || retry >= LIMITS.tatumRateLimitRetries) throw failure;
      await sleep(LIMITS.tatumRateLimitWaitMs);
    }
  }
}

async function readObjectContents(chain: Chain, objectId: string, expectedType: string, what: string): Promise<Uint8Array | null> {
  const { objects } = await tatumStep(chain, 'UPSTREAM', 1, () => chain.grpc.getObjects({ objectIds: [objectId], include: { content: true } }));
  const [object] = objects;
  if (objects.length !== 1 || object === undefined) throw new MemoryError('UPSTREAM', `Tatum returned no answer for the ${what}`);
  if (object instanceof Error) {
    if ((object as { reason?: unknown }).reason === 'notFound') return null;
    throw new MemoryError('UPSTREAM', `Tatum could not read the ${what}`);
  }
  if (normalizeSuiAddress(object.objectId) !== objectId) throw new MemoryError('UPSTREAM', `Tatum answered for a different object than the ${what}`);
  if (object.type !== expectedType) throw new MemoryError('ACCOUNT', `the ${what} is not of the Walrus Memory type expected`);
  const content: unknown = await object.content;
  if (!(content instanceof Uint8Array)) throw new MemoryError('UPSTREAM', `the ${what} came back without contents`);
  return content;
}

interface RegistryState {
  tableId: string;
  /** create_account and add_delegate_key both need a finalized migration and this schema version. */
  open: boolean;
}

async function readRegistry(chain: Chain): Promise<RegistryState> {
  const registryId = normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID);
  const content = await readObjectContents(chain, registryId, REGISTRY_TYPE, 'Walrus Memory registry');
  if (content === null) throw new MemoryError('ACCOUNT', 'the Walrus Memory registry was not found on Sui Mainnet');
  const registry = decodeExact(RegistryBcs, content, 'Walrus Memory registry');
  if (registry.id !== registryId) throw new MemoryError('UPSTREAM', 'the Walrus Memory registry contents name another object');
  return { tableId: registry.accounts.id, open: registry.migration_finalized && registry.version === REGISTRY_VERSION };
}

/** The owner's account id from the registry's owner-to-account table, or null when the owner has none. */
async function findAccountId(chain: Chain, tableId: string, ownerAddress: string): Promise<string | null> {
  const fieldId = deriveDynamicFieldID(tableId, 'address', bcs.Address.serialize(ownerAddress).toBytes());
  const content = await readObjectContents(chain, fieldId, ACCOUNT_FIELD_TYPE, 'registry entry');
  if (content === null) return null;
  const field = decodeExact(AccountFieldBcs, content, 'registry entry');
  if (field.id !== fieldId || field.name !== ownerAddress) throw new MemoryError('UPSTREAM', 'the registry entry names another owner');
  return field.value;
}

interface AccountState {
  delegateKeys: Uint8Array[];
  usable: boolean;
}

async function readAccount(chain: Chain, accountId: string, ownerAddress: string): Promise<AccountState | null> {
  const content = await readObjectContents(chain, accountId, ACCOUNT_TYPE, 'Walrus Memory account');
  if (content === null) return null;
  const account = decodeExact(AccountBcs, content, 'Walrus Memory account');
  if (account.id !== accountId) throw new MemoryError('UPSTREAM', 'the Walrus Memory account contents name another object');
  if (account.owner !== ownerAddress) throw new MemoryError('ACCOUNT', 'the Walrus Memory account belongs to another owner');
  return { delegateKeys: account.delegate_keys.map((key) => key.public_key), usable: account.active && !account.admin_quarantined };
}

/** Reads again while Tatum's nodes catch up with a write just made, at most LIMITS.memwalReadAfterWriteAttempts times. */
async function readAfterWrite<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 1; !ready(value) && attempt < LIMITS.memwalReadAfterWriteAttempts; attempt++) {
    await sleep(LIMITS.memwalReadAfterWriteDelayMs);
    value = await read();
  }
  return value;
}

/** True once Tatum shows the transaction as successful, false while it does not show it yet. */
async function landedSuccessfully(chain: Chain, digest: string, code: MemoryErrorCode): Promise<boolean> {
  try {
    const { status } = await chain.getTransactionResult(digest);
    if (status !== 'success') throw new MemoryError(code, `transaction ${digest} failed on chain`);
    return true;
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

type WalletSigner = NonNullable<CreateAccountOpts['walletSigner']>;
type ExpectedArgument = { object: string } | { pure: Uint8Array };

/**
 * Checks the bytes about to be signed, not the transaction the helper handed over: Tatum
 * resolves the transaction and the SDK takes back what Tatum returns, so a changed target,
 * argument, sender or gas payer would otherwise be signed by the owner key.
 */
function assertSignable(bytes: Uint8Array, ownerAddress: string, fn: string, expected: ExpectedArgument[], code: MemoryErrorCode): void {
  const data = Transaction.from(bytes).getData();
  const refuse = (why: string) => new MemoryError(code, `refused before signing: ${why}`);
  if (!data.sender || normalizeSuiAddress(data.sender) !== ownerAddress) throw refuse('the sender is not the owner');
  if (data.gasData.owner && normalizeSuiAddress(data.gasData.owner) !== ownerAddress) throw refuse('someone other than the owner pays the gas');
  const budget = String(data.gasData.budget ?? '');
  if (!/^(0|[1-9]\d*)$/.test(budget)) throw refuse('the gas budget is missing');
  if (BigInt(budget) > BigInt(LIMITS.memwalAccountTxMaxGasMist)) {
    throw refuse(`the transaction reserves ${budget} MIST of gas, over the ${LIMITS.memwalAccountTxMaxGasMist} MIST cap`);
  }

  const [command] = data.commands;
  const call = command?.MoveCall;
  if (data.commands.length !== 1 || !call) throw refuse('it is not exactly one Move call');
  if (normalizeSuiAddress(call.package) !== WALRUS_MEMORY_PACKAGE_ID || call.module !== 'account' || call.function !== fn) {
    throw refuse('it calls something other than the Walrus Memory account function');
  }
  if (call.typeArguments.length !== 0 || call.arguments.length !== expected.length) throw refuse('its arguments are not the expected ones');
  call.arguments.forEach((argument, index) => {
    const want = expected[index];
    const input = argument.$kind === 'Input' ? data.inputs[argument.Input] : undefined;
    if (!want || !input) throw refuse('its arguments are not the expected ones');
    if ('object' in want) {
      const shared = input.Object?.SharedObject;
      if (!shared || normalizeSuiAddress(shared.objectId) !== want.object) throw refuse('it passes a different object');
    } else if (input.Pure?.bytes !== toBase64(want.pure)) {
      throw refuse('it passes a different value');
    }
  });
}

type AccountFunction = 'create_account' | 'add_delegate_key';

/** The account helper's transaction, resolved through Tatum with the owner as sender and gas payer, returned only once assertSignable passes. */
async function buildSignable(
  chain: Chain,
  transaction: unknown,
  ownerAddress: string,
  fn: AccountFunction,
  expected: ExpectedArgument[],
  code: MemoryErrorCode,
): Promise<Uint8Array> {
  if (!(transaction instanceof Transaction)) throw new MemoryError(code, 'the account helper did not hand over a transaction');
  transaction.setSender(ownerAddress);
  // One simulate call: the gateway resolves the objects, picks the gas and sets the expiry.
  const bytes = await tatumStep(chain, code, 1, () => transaction.build({ client: chain.grpc }));
  assertSignable(bytes, ownerAddress, fn, expected, code);
  return bytes;
}

/** The arguments create_account must carry, in order. */
function createAccountArguments(): ExpectedArgument[] {
  return [{ object: normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID) }, { object: SUI_CLOCK_ID }];
}

/** The arguments add_delegate_key must carry, in order, for this account, key and label. */
function addDelegateArguments(accountId: string, delegateKey: Uint8Array, label: string): ExpectedArgument[] {
  return [
    { object: accountId },
    { object: normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID) },
    { pure: bcs.byteVector().serialize(delegateKey).toBytes() },
    { pure: bcs.string().serialize(label).toBytes() },
    { object: SUI_CLOCK_ID },
  ];
}

/**
 * The owner's key as the account helper's wallet. It signs only the one Walrus Memory call
 * it was made for, after assertSignable, and nothing else: personal messages are refused.
 */
function ownerWallet(
  chain: Chain,
  owner: Ed25519Keypair,
  ownerAddress: string,
  fn: AccountFunction,
  expected: ExpectedArgument[],
  code: MemoryErrorCode,
): WalletSigner {
  return {
    address: ownerAddress,
    async signAndExecuteTransaction({ transaction }: { transaction: unknown }) {
      const bytes = await buildSignable(chain, transaction, ownerAddress, fn, expected, code);
      const { signature } = await owner.signTransaction(bytes);
      // Sending the same signed bytes again after a rate limit is safe: Sui runs a digest once.
      const result = await tatumStep(chain, code, 1, () =>
        chain.grpc.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true } }),
      );
      if (result.$kind !== 'Transaction') throw new MemoryError(code, `transaction ${result.FailedTransaction.digest} failed on chain`);
      const { digest } = result.Transaction;
      // The helper polls Tatum for this digest next, every 2 seconds for up to a minute and
      // outside any pacing. Waiting here until Tatum shows it lets that first poll succeed.
      const visible = await readAfterWrite(() => tatumStep(chain, code, 1, () => landedSuccessfully(chain, digest, code)), (seen) => seen);
      if (!visible) throw new MemoryError('TIMEOUT', `transaction ${digest} was sent but Tatum does not show it yet; run again to pick it up`);
      await reserveTatum(chain, LIMITS.memwalHelperWaitRequests);
      return { digest };
    },
    async signPersonalMessage() {
      throw new MemoryError(code, 'the owner key signs no messages for the account helper');
    },
  };
}

async function helperStep<T>(code: MemoryErrorCode, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw tatumFailure(error, code);
  }
}

/**
 * Makes sure `owner` has a Walrus Memory account on Sui Mainnet with `delegatePublicKey`
 * registered on it, reading the registry and the account through Tatum first so a second
 * run creates nothing and adds nothing.
 *
 * Creating the account and adding the key are the owner's own transactions: the owner signs
 * and pays gas from its address balance, through the SDK account helpers, sent via Tatum.
 * Each is refused before signing when its gas budget is over LIMITS.memwalAccountTxMaxGasMist
 * or its bytes are not exactly the expected call.
 *
 * Throws MemoryError: DELEGATE for a key that is not 32 bytes, an account already holding
 * the maximum number of keys, or a key that does not show on chain after it was added;
 * ACCOUNT when the registry is closed to writes, the account is frozen or owned by someone
 * else, or a new account does not show on chain; TIMEOUT, RATE_LIMITED or UPSTREAM for Tatum.
 */
export async function ensureMemoryAccount(args: {
  chain: Chain;
  owner: Ed25519Keypair;
  delegatePublicKey: Uint8Array;
}): Promise<{ accountId: string; created: boolean; delegateAdded: boolean; digests: string[] }> {
  const { chain, owner } = args;
  if (!(args.delegatePublicKey instanceof Uint8Array) || args.delegatePublicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new MemoryError('DELEGATE', `the delegate public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`);
  }
  const delegateKey = Uint8Array.from(args.delegatePublicKey);
  const ownerAddress = canonicalSuiAddress(owner.toSuiAddress());
  const registryId = normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID);
  const registry = await readRegistry(chain);
  const digests: string[] = [];

  let accountId = await findAccountId(chain, registry.tableId, ownerAddress);
  let created = false;
  if (accountId === null) {
    if (!registry.open) throw new MemoryError('ACCOUNT', 'the Walrus Memory registry is not open for new accounts');
    const result = await helperStep('ACCOUNT', () =>
      createAccount({
        packageId: WALRUS_MEMORY_PACKAGE_ID,
        registryId,
        walletSigner: ownerWallet(chain, owner, ownerAddress, 'create_account', createAccountArguments(), 'ACCOUNT'),
        suiClient: chain.grpc,
      }),
    );
    digests.push(result.digest);
    created = true;
    // The helper's id is a hint; the registry is the record of which account is the owner's.
    accountId = await readAfterWrite(
      () => findAccountId(chain, registry.tableId, ownerAddress),
      (id) => id !== null,
    );
    if (accountId === null) throw new MemoryError('ACCOUNT', `account transaction ${result.digest} landed but the registry shows no account`);
    if (result.accountId && normalizeSuiAddress(result.accountId) !== accountId) {
      throw new MemoryError('ACCOUNT', 'the account helper and the registry disagree on the new account id');
    }
  }
  const knownAccountId = accountId;

  let account = await readAfterWrite(
    () => readAccount(chain, knownAccountId, ownerAddress),
    (state) => state !== null,
  );
  if (account === null) throw new MemoryError('ACCOUNT', 'the registry names an account that Tatum cannot find');
  if (!account.usable) throw new MemoryError('ACCOUNT', 'the Walrus Memory account is frozen');

  const holdsKey = (state: AccountState | null) => state !== null && state.delegateKeys.some((key) => sameBytes(key, delegateKey));
  let delegateAdded = false;
  if (!holdsKey(account)) {
    if (account.delegateKeys.length >= LIMITS.memwalMaxDelegateKeys) {
      throw new MemoryError('DELEGATE', `the account already holds ${account.delegateKeys.length} delegate keys, the most allowed`);
    }
    if (!registry.open) throw new MemoryError('DELEGATE', 'the Walrus Memory registry is not open for new delegate keys');
    const expected = addDelegateArguments(knownAccountId, delegateKey, DELEGATE_LABEL);
    const result = await helperStep('DELEGATE', () =>
      addDelegateKey({
        packageId: WALRUS_MEMORY_PACKAGE_ID,
        registryId,
        accountId: knownAccountId,
        publicKey: delegateKey,
        label: DELEGATE_LABEL,
        walletSigner: ownerWallet(chain, owner, ownerAddress, 'add_delegate_key', expected, 'DELEGATE'),
        suiClient: chain.grpc,
      }),
    );
    digests.push(result.digest);
    delegateAdded = true;
    account = await readAfterWrite(() => readAccount(chain, knownAccountId, ownerAddress), holdsKey);
    if (!holdsKey(account)) throw new MemoryError('DELEGATE', `delegate transaction ${result.digest} landed but the key is not on the account`);
  }

  return { accountId: knownAccountId, created, delegateAdded, digests };
}

// The label is stored on chain in the clear, so it is held to plain characters.
const DELEGATE_LABEL_PATTERN = /^[A-Za-z0-9 ._-]{1,64}$/;

/** Carries the built bytes out of the account helper, which stops it before it could wait for a send. */
class BuiltTransaction extends Error {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    super('built and not signed');
    this.name = 'BuiltTransaction';
    this.bytes = bytes;
  }
}

/**
 * A wallet for the account helper that holds no key. It builds and checks the helper's
 * transaction exactly as ownerWallet does, then hands the bytes back instead of signing.
 */
function unsignedWallet(chain: Chain, ownerAddress: string, fn: AccountFunction, expected: ExpectedArgument[], code: MemoryErrorCode): WalletSigner {
  return {
    address: ownerAddress,
    async signAndExecuteTransaction({ transaction }: { transaction: unknown }) {
      throw new BuiltTransaction(await buildSignable(chain, transaction, ownerAddress, fn, expected, code));
    },
    async signPersonalMessage() {
      throw new MemoryError(code, 'an unsigned build signs no messages');
    },
  };
}

async function helperBytes(code: MemoryErrorCode, run: () => Promise<unknown>): Promise<Uint8Array> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BuiltTransaction) return error.bytes;
    throw tatumFailure(error, code);
  }
  throw new MemoryError(code, 'the account helper finished without handing over a transaction');
}

function suiIdOrFail(value: unknown, what: string): string {
  try {
    if (typeof value !== 'string') throw new Error('not text');
    return canonicalSuiAddress(value);
  } catch {
    throw new MemoryError('ACCOUNT', `${what} is not a Sui address`);
  }
}

/**
 * The owner's Walrus Memory account on Sui Mainnet, read through Tatum: its id from the
 * registry's owner-to-account table, and the public key of every delegate on it as lowercase
 * hex (64 characters for an Ed25519 key), or null when the owner has no account. The
 * account's own owner field must be `owner`. Reads only; three Tatum requests.
 * Throws MemoryError: ACCOUNT for an owner that is not a Sui address, a registry or account
 * of an unexpected type, or an account that belongs to another owner, is frozen, or is named
 * by the registry but missing; TIMEOUT, RATE_LIMITED or UPSTREAM for Tatum.
 */
export async function findMemoryAccount(chain: Chain, owner: string): Promise<{ accountId: string; delegates: string[] } | null> {
  const ownerAddress = suiIdOrFail(owner, 'the owner');
  const registry = await readRegistry(chain);
  const accountId = await findAccountId(chain, registry.tableId, ownerAddress);
  if (accountId === null) return null;
  const account = await readAccount(chain, accountId, ownerAddress);
  if (account === null) throw new MemoryError('ACCOUNT', 'the registry names an account that Tatum cannot find');
  if (!account.usable) throw new MemoryError('ACCOUNT', 'the Walrus Memory account is frozen');
  return { accountId, delegates: account.delegateKeys.map((key) => toHex(key)) };
}

/**
 * Builds the owner's create_account transaction without signing it, so the owner's own
 * wallet signs and sends it. It is the call ensureMemoryAccount makes, through the same
 * account helper, resolved through Tatum with the owner as sender and gas payer, and its
 * bytes pass the same assertSignable checks before they are returned: exactly one
 * create_account on the registry and the clock, gas at most LIMITS.memwalAccountTxMaxGasMist.
 * The registry is read first, so an owner who already has an account, or a registry closed
 * to new accounts, is refused before anything is built. The bytes carry the gas Tatum
 * picked: if the owner's gas changes before signing they go stale and are built again.
 * Throws MemoryError: ACCOUNT for an owner that is not a Sui address, an owner that already
 * has an account, a closed registry, or bytes that fail the checks; TIMEOUT, RATE_LIMITED or
 * UPSTREAM for Tatum.
 */
export async function buildCreateAccountTx(args: { chain: Chain; owner: string }): Promise<Uint8Array> {
  const { chain } = args;
  const ownerAddress = suiIdOrFail(args.owner, 'the owner');
  const registry = await readRegistry(chain);
  if ((await findAccountId(chain, registry.tableId, ownerAddress)) !== null) {
    throw new MemoryError('ACCOUNT', 'the owner already has a Walrus Memory account');
  }
  if (!registry.open) throw new MemoryError('ACCOUNT', 'the Walrus Memory registry is not open for new accounts');
  return helperBytes('ACCOUNT', () =>
    createAccount({
      packageId: WALRUS_MEMORY_PACKAGE_ID,
      registryId: normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID),
      walletSigner: unsignedWallet(chain, ownerAddress, 'create_account', createAccountArguments(), 'ACCOUNT'),
      suiClient: chain.grpc,
    }),
  );
}

/**
 * Builds the owner's add_delegate_key transaction for `delegatePublicKey` named `label` on
 * account `accountId`, without signing it, so the owner's own wallet signs and sends it. It
 * is the call ensureMemoryAccount makes, through the same account helper and the same
 * assertSignable checks as buildCreateAccountTx. The registry and the account are read
 * first: the registry must name `accountId` as the owner's account, and the account must be
 * usable, not already hold the key, and have room for one more.
 * Throws MemoryError: DELEGATE for a key that is not 32 bytes, a label that is not 1 to 64
 * letters, digits, spaces, dots, dashes or underscores, a key already on the account, an
 * account holding LIMITS.memwalMaxDelegateKeys keys, a closed registry, or bytes that fail
 * the checks; ACCOUNT for an owner or account id that is not a Sui address, an account the
 * registry does not name as the owner's, or one that is missing or frozen; TIMEOUT,
 * RATE_LIMITED or UPSTREAM for Tatum.
 */
export async function buildAddDelegateTx(args: {
  chain: Chain;
  owner: string;
  accountId: string;
  delegatePublicKey: Uint8Array;
  label: string;
}): Promise<Uint8Array> {
  const { chain } = args;
  if (!(args.delegatePublicKey instanceof Uint8Array) || args.delegatePublicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new MemoryError('DELEGATE', `the delegate public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`);
  }
  if (typeof args.label !== 'string' || !DELEGATE_LABEL_PATTERN.test(args.label)) {
    throw new MemoryError('DELEGATE', 'the label must be 1 to 64 letters, digits, spaces, dots, dashes or underscores');
  }
  const delegateKey = Uint8Array.from(args.delegatePublicKey);
  const { label } = args;
  const ownerAddress = suiIdOrFail(args.owner, 'the owner');
  const accountId = suiIdOrFail(args.accountId, 'the account id');

  const registry = await readRegistry(chain);
  if ((await findAccountId(chain, registry.tableId, ownerAddress)) !== accountId) {
    throw new MemoryError('ACCOUNT', "the registry does not name this account as the owner's");
  }
  const account = await readAccount(chain, accountId, ownerAddress);
  if (account === null) throw new MemoryError('ACCOUNT', 'the registry names an account that Tatum cannot find');
  if (!account.usable) throw new MemoryError('ACCOUNT', 'the Walrus Memory account is frozen');
  if (account.delegateKeys.some((key) => sameBytes(key, delegateKey))) throw new MemoryError('DELEGATE', 'the key is already on the account');
  if (account.delegateKeys.length >= LIMITS.memwalMaxDelegateKeys) {
    throw new MemoryError('DELEGATE', `the account already holds ${account.delegateKeys.length} delegate keys, the most allowed`);
  }
  if (!registry.open) throw new MemoryError('DELEGATE', 'the Walrus Memory registry is not open for new delegate keys');

  return helperBytes('DELEGATE', () =>
    addDelegateKey({
      packageId: WALRUS_MEMORY_PACKAGE_ID,
      registryId: normalizeSuiAddress(WALRUS_MEMORY_REGISTRY_ID),
      accountId,
      publicKey: delegateKey,
      label,
      walletSigner: unsignedWallet(chain, ownerAddress, 'add_delegate_key', addDelegateArguments(accountId, delegateKey, label), 'DELEGATE'),
      suiClient: chain.grpc,
    }),
  );
}

const cappedRelayerOrigins = new Set<string>();
let relayerFetchCapped = false;

async function cappedRelayerBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new MemoryError('UPSTREAM', `relayer response is over ${LIMITS.memwalMaxResponseBytes} bytes`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LIMITS.memwalMaxResponseBytes) {
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
    if (total > LIMITS.memwalMaxResponseBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
}

/**
 * Caps every response body from a registered relayer origin at LIMITS.memwalMaxResponseBytes.
 * SDK 0.1.8 calls the global fetch and takes no fetch of its own, so the cap has to sit
 * there. Requests to any other origin pass through untouched.
 */
function capRelayerResponses(origin: string): void {
  cappedRelayerOrigins.add(origin);
  if (relayerFetchCapped) return;
  const underlying = globalThis.fetch;
  const capped: typeof fetch = async (input, init) => {
    const response = await underlying(input, init);
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string | null = null;
    try {
      origin = new URL(href).origin;
    } catch {
      origin = null;
    }
    if (origin === null || !cappedRelayerOrigins.has(origin)) return response;
    const body = await cappedRelayerBody(response);
    const responseInit = { status: response.status, statusText: response.statusText, headers: response.headers };
    // These statuses may not carry a body at all; Response refuses one.
    return [204, 205, 304].includes(response.status) ? new Response(null, responseInit) : new Response(body, responseInit);
  };
  globalThis.fetch = capped;
  relayerFetchCapped = true;
}

type PointLedger = Array<{ at: number; points: number }>;

// The relayer counts points per delegate key, and callers make a new client for every call, so
// points are counted per key: a ledger per client let one visit spend 51 points in a 30-point
// window. createMemoryClient records each client's key here. A client made any other way, such as
// a test's stand-in, has no key and is counted on its own.
const clientDelegateKeys = new WeakMap<object, string>();
const keySpend = new Map<string, PointLedger>();
const unkeyedSpend = new WeakMap<object, PointLedger>();

function ledgerOf(client: object): PointLedger {
  const key = clientDelegateKeys.get(client);
  const found = key === undefined ? unkeyedSpend.get(client) : keySpend.get(key);
  if (found) return found;
  const ledger: PointLedger = [];
  if (key === undefined) unkeyedSpend.set(client, ledger);
  else keySpend.set(key, ledger);
  return ledger;
}

// A key whose last spend left the window is dropped, so the map holds only keys used in the last
// minute however many owners the process serves.
function forgetIdleKeys(now: number): void {
  for (const [key, ledger] of keySpend) {
    if ((ledger.at(-1)?.at ?? 0) <= now - LIMITS.memwalPacingWindowMs) keySpend.delete(key);
  }
}

/** How a relayer call waits for its delegate key's points. */
export interface RelayerPacing {
  /**
   * When false, a call whose key has spent its points for the current window is refused at once
   * with MemoryError RATE_LIMITED and nothing sent, instead of waiting up to
   * LIMITS.memwalPacingWindowMs for room: for a caller with a deadline, whose own check before the
   * call cannot see that wait. True when left out.
   */
  waitForPoints?: boolean;
}

async function spendRelayerPoints(client: object, points: number, pacing: RelayerPacing = {}): Promise<void> {
  if (points > LIMITS.memwalPointsPerMinute) throw new MemoryError('RATE_LIMITED', 'one request costs more relayer points than a minute allows');
  for (;;) {
    const now = Date.now();
    forgetIdleKeys(now);
    // Looked up again on every round: a wait can outlast the window, and the ledger it started on may have been dropped since.
    const ledger = ledgerOf(client);
    while (ledger.length > 0 && (ledger[0]?.at ?? 0) <= now - LIMITS.memwalPacingWindowMs) ledger.shift();
    const spent = ledger.reduce((sum, entry) => sum + entry.points, 0);
    if (spent + points <= LIMITS.memwalPointsPerMinute) {
      ledger.push({ at: now, points });
      return;
    }
    if (pacing.waitForPoints === false) throw new MemoryError('RATE_LIMITED', 'this delegate key has spent its relayer points for this minute; nothing was sent');
    await sleep((ledger[0]?.at ?? now) + LIMITS.memwalPacingWindowMs - now);
  }
}

function httpStatusOf(error: unknown): number | null {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/**
 * Bounds one whole SDK call at LIMITS.memwalCallTimeoutMs (C21): each request inside it has its
 * own deadline, but the steps before a request (the version check, the config, a SEAL session
 * whose read of Sui has none) can add up past any one of them. The SDK takes no signal for a whole
 * call, so a call past the ceiling is not stopped, only no longer waited for: it runs on unwatched
 * until its own steps end, and its later failure is swallowed so it cannot surface unhandled. A
 * client destroyed meanwhile refuses to sign anything it had not yet signed; a request it had
 * already signed can still be sent, so an abandoned write may reach the relayer after all.
 */
function withinCallCeiling<T>(call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MemoryError('TIMEOUT', `the relayer call did not finish within ${LIMITS.memwalCallTimeoutMs} ms`)),
      LIMITS.memwalCallTimeoutMs,
    );
  });
  call.catch(() => undefined);
  return Promise.race([call, ceiling]).finally(() => clearTimeout(timer));
}

function relayerFailure(error: unknown, code: 'WRITE' | 'RECALL'): MemoryError {
  if (error instanceof MemoryError) return error;
  const { name, cause } = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown; cause?: unknown };
  if (name === 'MemWalRequestTimeout' || name === 'AbortError' || name === 'TimeoutError') {
    return new MemoryError('TIMEOUT', 'the relayer did not answer in time');
  }
  const status = httpStatusOf(error);
  if (status === null) return new MemoryError('UPSTREAM', 'the relayer request failed before an answer');
  // A rate limit sometimes arrives wrapped as a 500 "seal encrypt failed: Too Many Requests"
  // (MemWal issues #1071, #1153). The body is read for that fixed phrase only, never kept.
  if (status === HTTP_TOO_MANY_REQUESTS || (status >= 500 && typeof cause === 'string' && /too many requests/i.test(cause))) {
    return new MemoryError('RATE_LIMITED', `the relayer rate limited the request (HTTP ${status})`);
  }
  if (status === HTTP_GATEWAY_TIMEOUT) return new MemoryError('TIMEOUT', `the relayer timed out (HTTP ${status})`);
  if (status === 401 || status === 403) return new MemoryError('DELEGATE', `the relayer refused the delegate key (HTTP ${status})`);
  if (status >= 500) return new MemoryError('UPSTREAM', `the relayer failed (HTTP ${status})`);
  return new MemoryError(code, `the relayer refused the request (HTTP ${status})`);
}

function checkNamespace(namespace: unknown, code: 'WRITE' | 'RECALL'): string {
  if (typeof namespace !== 'string' || namespace.length > LIMITS.memwalNamespaceMaxLength || !NAMESPACE_PATTERN.test(namespace)) {
    throw new MemoryError(code, `the namespace must be 1 to ${LIMITS.memwalNamespaceMaxLength} characters of a-z, 0-9, dot, dash or underscore`);
  }
  return namespace;
}

function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE, '') !== '';
}

function checkSentences(sentences: unknown): string[] {
  if (!Array.isArray(sentences) || sentences.length === 0) throw new MemoryError('WRITE', 'give at least one sentence');
  if (sentences.length > LIMITS.memwalBulkMaxItems) {
    throw new MemoryError('WRITE', `at most ${LIMITS.memwalBulkMaxItems} sentences per write, got ${sentences.length}`);
  }
  const seen = new Set<string>();
  return sentences.map((sentence: unknown, index) => {
    const position = index + 1;
    if (typeof sentence !== 'string' || !hasVisibleText(sentence)) throw new MemoryError('WRITE', `sentence ${position} is empty`);
    if (Buffer.byteLength(sentence, 'utf8') > LIMITS.memwalSentenceMaxBytes) {
      throw new MemoryError('WRITE', `sentence ${position} is over ${LIMITS.memwalSentenceMaxBytes} bytes`);
    }
    // Case, spacing and look-alike forms do not make a second memory: search would
    // return both copies and crowd out the rest.
    const key = sentence.normalize('NFKC').replace(INVISIBLE, ' ').replace(/ +/g, ' ').trim().toLowerCase();
    if (seen.has(key)) throw new MemoryError('WRITE', `sentence ${position} repeats an earlier one`);
    seen.add(key);
    return sentence;
  });
}

function checkJobIds(accepted: unknown, count: number): string[] {
  const jobIds = typeof accepted === 'object' && accepted !== null ? (accepted as { job_ids?: unknown }).job_ids : undefined;
  if (
    !Array.isArray(jobIds) ||
    jobIds.length !== count ||
    !jobIds.every((id): id is string => typeof id === 'string' && RELAYER_ID_PATTERN.test(id)) ||
    new Set(jobIds).size !== count
  ) {
    throw new MemoryError('WRITE', `the relayer accepted the write but did not return ${count} distinct job ids`);
  }
  return jobIds;
}

function retryAfterMs(error: unknown): number {
  const seconds = typeof error === 'object' && error !== null ? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds : undefined;
  const asked = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : LIMITS.memwalRetryAfterMaxMs;
  return Math.min(Math.max(asked, LIMITS.memwalPollIntervalMs), LIMITS.memwalRetryAfterMaxMs);
}

/** Polls until every job is done, with both a poll ceiling and a time ceiling, and returns blob ids in job order. */
async function waitForJobs(client: MemWal, jobIds: string[]): Promise<string[]> {
  const deadline = Date.now() + LIMITS.memwalWaitTimeoutMs;
  const blobIds = new Map<string, string>();
  let pause: number = LIMITS.memwalPollIntervalMs;

  for (let poll = 0; poll < LIMITS.memwalPollMaxAttempts && blobIds.size < jobIds.length; poll++) {
    await sleep(Math.min(pause, Math.max(0, deadline - Date.now())));
    pause = LIMITS.memwalPollIntervalMs;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const pending = jobIds.filter((id) => !blobIds.has(id));
    await spendRelayerPoints(client, LIMITS.memwalRequestPoints);
    let status: unknown;
    try {
      status = await withinCallCeiling(client.getRememberBulkStatus(pending, { timeoutMs: Math.min(LIMITS.memwalRequestTimeoutMs, remaining) }));
    } catch (error) {
      const failure = relayerFailure(error, 'WRITE');
      if (failure.code === 'RATE_LIMITED') {
        pause = retryAfterMs(error);
        continue;
      }
      // A slow or failing status read says nothing about the jobs; the poll ceiling bounds these.
      if (failure.code === 'TIMEOUT' || failure.code === 'UPSTREAM') continue;
      throw failure;
    }

    const results = typeof status === 'object' && status !== null ? (status as { results?: unknown }).results : undefined;
    if (!Array.isArray(results)) throw new MemoryError('WRITE', 'the relayer status answer has the wrong shape');
    for (const item of results as unknown[]) {
      const { job_id: jobId, status: state, blob_id: blobId } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      if (typeof jobId !== 'string' || !pending.includes(jobId)) throw new MemoryError('WRITE', 'the relayer reported on a job that was not asked about');
      if (state === 'done') {
        if (typeof blobId !== 'string' || !RELAYER_ID_PATTERN.test(blobId)) throw new MemoryError('WRITE', `job ${jobId} finished without a usable blob id`);
        blobIds.set(jobId, blobId);
      } else if (state === 'failed' || state === 'not_found') {
        throw new MemoryError('WRITE', `memory write job ${jobId} ${state === 'failed' ? 'failed' : 'is unknown to the relayer'}`);
      } else if (state !== 'pending' && state !== 'running' && state !== 'uploaded') {
        throw new MemoryError('WRITE', `job ${jobId} is in a state this code does not know`);
      }
    }
  }

  if (blobIds.size < jobIds.length) {
    throw new MemoryError('TIMEOUT', `${jobIds.length - blobIds.size} of ${jobIds.length} memory writes were not done within the wait ceiling`);
  }
  return jobIds.map((id) => blobIds.get(id) ?? '');
}

/**
 * A Walrus Memory client that signs as Ellai's per-owner delegate key on the account.
 * The relayer is MEMWAL_RELAYER_URL, or the hosted Mainnet relayer when that is unset, and
 * must be a bare https origin. Every request has the LIMITS.memwalRequestTimeoutMs ceiling
 * and its response is capped at LIMITS.memwalMaxResponseBytes. Every client made for one delegate
 * key in this process spends that key's relayer points together, at most
 * LIMITS.memwalPointsPerMinute in any LIMITS.memwalPacingWindowMs. Makes no network call.
 * Throws MemoryError: ACCOUNT for an account id that is not a Sui object id, UPSTREAM for
 * a relayer URL that is not a bare https origin.
 */
export function createMemoryClient(args: { delegate: Ed25519Keypair; accountId: string }): MemWal {
  let accountId: string;
  try {
    accountId = canonicalSuiAddress(args.accountId);
  } catch {
    throw new MemoryError('ACCOUNT', 'the account id is not a Sui object id');
  }
  const configured = process.env.MEMWAL_RELAYER_URL;
  let relayer: URL;
  try {
    relayer = new URL(configured === undefined || configured === '' ? DEFAULT_RELAYER_URL : configured);
  } catch {
    throw new MemoryError('UPSTREAM', 'MEMWAL_RELAYER_URL is not a URL');
  }
  // The relayer signs and checks the request path from the root, so a base path would break every call.
  if (relayer.protocol !== 'https:' || relayer.username || relayer.password || relayer.pathname !== '/' || relayer.search || relayer.hash) {
    throw new MemoryError('UPSTREAM', 'MEMWAL_RELAYER_URL must be a bare https origin');
  }
  capRelayerResponses(relayer.origin);
  // A private copy of the seed, so client.destroy() can wipe it without touching the keypair.
  const { secretKey } = decodeSuiPrivateKey(args.delegate.getSecretKey());
  const client = MemWal.create({ key: Uint8Array.from(secretKey), accountId, serverUrl: relayer.origin, requestTimeoutMs: LIMITS.memwalRequestTimeoutMs });
  clientDelegateKeys.set(client, toHex(args.delegate.getPublicKey().toRawBytes()));
  return client;
}

/**
 * Stores each sentence as its own memory in `namespace` with one bulk write, then waits
 * until every job is done, and returns each sentence with its blob id and job id, in order.
 * Spends relayer points through a pace per delegate key, waiting for room, so it never runs past
 * the relayer's per-minute limit. The write is sent once and never resent: SDK 0.1.8 sends no
 * idempotency key on bulk writes, so a resend would store every sentence twice.
 *
 * Throws MemoryError: WRITE for no sentences, more than LIMITS.memwalBulkMaxItems, an
 * empty, oversized or repeated sentence, a bad namespace, or any failed job; TIMEOUT when
 * jobs are not done within the wait ceiling; DELEGATE, RATE_LIMITED or UPSTREAM from the relayer.
 */
export async function rememberSentences(
  client: MemWal,
  namespace: string,
  sentences: string[],
): Promise<Array<{ text: string; blobId: string; jobId: string }>> {
  const label = checkNamespace(namespace, 'WRITE');
  const texts = checkSentences(sentences);
  await spendRelayerPoints(client, LIMITS.memwalBulkPoints);
  let accepted: unknown;
  try {
    accepted = await withinCallCeiling(client.rememberBulk(texts.map((text) => ({ text, namespace: label }))));
  } catch (error) {
    throw relayerFailure(error, 'WRITE');
  }
  const jobIds = checkJobIds(accepted, texts.length);
  const blobIds = await waitForJobs(client, jobIds);
  return texts.map((text, index) => ({ text, blobId: blobIds[index] ?? '', jobId: jobIds[index] ?? '' }));
}

/**
 * Stores each sentence as its own memory in `namespace` with one bulk write and returns the
 * relayer's job ids in sentence order, without waiting for the jobs: read them later with
 * checkJobs. Same checks and the same per-key pace as rememberSentences, except that with
 * `pacing.waitForPoints` false a key with no points left is refused rather than waited for. The
 * write is sent once and never resent, because SDK 0.1.8 sends no idempotency key on bulk writes
 * and a resend would store every sentence twice.
 *
 * Throws MemoryError: WRITE for no sentences, more than LIMITS.memwalBulkMaxItems, an
 * empty, oversized or repeated sentence, a bad namespace, a relayer refusal, or an accepted
 * write that did not return one distinct job id per sentence; RATE_LIMITED, with nothing sent,
 * for a key with no points left when told not to wait; TIMEOUT, DELEGATE, RATE_LIMITED or
 * UPSTREAM from the relayer.
 */
export async function submitSentences(client: MemWal, namespace: string, sentences: string[], pacing: RelayerPacing = {}): Promise<string[]> {
  const label = checkNamespace(namespace, 'WRITE');
  const texts = checkSentences(sentences);
  await spendRelayerPoints(client, LIMITS.memwalBulkPoints, pacing);
  let accepted: unknown;
  try {
    accepted = await withinCallCeiling(client.rememberBulk(texts.map((text) => ({ text, namespace: label }))));
  } catch (error) {
    throw relayerFailure(error, 'WRITE');
  }
  return checkJobIds(accepted, texts.length);
}

/**
 * Reads the state of up to LIMITS.memwalBulkMaxItems bulk write jobs with one status call,
 * spending relayer points through the same per-key pace as every other call here (refused
 * rather than waited for when `pacing.waitForPoints` is false), and
 * returns one entry per job id in the order given. 'done' carries the blob id. 'failed'
 * covers a failed job and one the relayer does not know. 'pending' covers every state in
 * which the job is still working. The call is not retried here: the caller decides when to
 * look again.
 *
 * Throws MemoryError: WRITE for no job ids, more than LIMITS.memwalBulkMaxItems (the
 * relayer refuses more per call), a malformed or repeated job id, or an answer that is not
 * exactly one entry per job asked about, has a finished job without a usable blob id, or
 * names a state this code does not know; RATE_LIMITED, with nothing sent, for a key with no
 * points left when told not to wait; TIMEOUT, DELEGATE, RATE_LIMITED or UPSTREAM from the relayer.
 */
export async function checkJobs(
  client: MemWal,
  jobIds: string[],
  pacing: RelayerPacing = {},
): Promise<Array<{ jobId: string; state: 'done' | 'pending' | 'failed'; blobId: string | null }>> {
  if (!Array.isArray(jobIds) || jobIds.length === 0) throw new MemoryError('WRITE', 'give at least one job id');
  if (jobIds.length > LIMITS.memwalBulkMaxItems) {
    throw new MemoryError('WRITE', `at most ${LIMITS.memwalBulkMaxItems} job ids per status check, got ${jobIds.length}`);
  }
  if (!jobIds.every((id: unknown) => typeof id === 'string' && RELAYER_ID_PATTERN.test(id))) {
    throw new MemoryError('WRITE', 'every job id must be 1 to 128 characters of A-Z, a-z, 0-9, dash or underscore');
  }
  const asked = [...jobIds];
  if (new Set(asked).size !== asked.length) throw new MemoryError('WRITE', 'a job id is repeated');

  await spendRelayerPoints(client, LIMITS.memwalRequestPoints, pacing);
  let status: unknown;
  try {
    status = await withinCallCeiling(client.getRememberBulkStatus(asked, { timeoutMs: LIMITS.memwalRequestTimeoutMs }));
  } catch (error) {
    throw relayerFailure(error, 'WRITE');
  }

  const results = typeof status === 'object' && status !== null ? (status as { results?: unknown }).results : undefined;
  // The relayer answers every job id it is asked about, "not_found" included, so a short or
  // long answer is malformed rather than a job that is still working.
  if (!Array.isArray(results) || results.length !== asked.length) throw new MemoryError('WRITE', 'the relayer status answer has the wrong shape');
  const pending = new Set(asked);
  const states = new Map<string, { state: 'done' | 'pending' | 'failed'; blobId: string | null }>();
  for (const item of results as unknown[]) {
    const { job_id: jobId, status: state, blob_id: blobId } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof jobId !== 'string' || !pending.has(jobId)) throw new MemoryError('WRITE', 'the relayer reported on a job that was not asked about, or on one job twice');
    pending.delete(jobId);
    if (state === 'done') {
      if (typeof blobId !== 'string' || !RELAYER_ID_PATTERN.test(blobId)) throw new MemoryError('WRITE', `job ${jobId} finished without a usable blob id`);
      states.set(jobId, { state: 'done', blobId });
    } else if (state === 'failed' || state === 'not_found') {
      states.set(jobId, { state: 'failed', blobId: null });
    } else if (state === 'pending' || state === 'running' || state === 'uploaded') {
      states.set(jobId, { state: 'pending', blobId: null });
    } else {
      throw new MemoryError('WRITE', `job ${jobId} is in a state this code does not know`);
    }
  }
  return asked.map((jobId) => ({ jobId, ...(states.get(jobId) ?? { state: 'pending' as const, blobId: null }) }));
}

/**
 * Searches `namespace` by meaning and returns the hits closer than `opts.maxDistance`,
 * closest first as the relayer ranks them, or [] when none are. Every hit must carry a
 * numeric distance from 0 to LIMITS.recallDistanceMax, the whole range cosine distance can
 * take, or the whole call fails, so a malformed answer can never pass as a match, as a
 * closer match than any real one, or as "nothing found" (C12).
 *
 * Throws MemoryError: RECALL for a bad query, namespace, limit or cutoff, a hit without a
 * numeric distance in that range, text or blob id, more hits than asked for, or hits the relayer
 * dropped unread; TIMEOUT, DELEGATE, RATE_LIMITED or UPSTREAM from the relayer. With
 * `pacing.waitForPoints` false, a key that has spent its points is RATE_LIMITED at once.
 */
export async function recallSentences(
  client: MemWal,
  namespace: string,
  query: string,
  opts: { limit: number; maxDistance: number },
  pacing: RelayerPacing = {},
): Promise<Array<{ text: string; blobId: string; distance: number; createdAt: string | null }>> {
  const label = checkNamespace(namespace, 'RECALL');
  if (typeof query !== 'string' || !hasVisibleText(query) || Buffer.byteLength(query, 'utf8') > LIMITS.memwalSentenceMaxBytes) {
    throw new MemoryError('RECALL', `the query must be non-empty and at most ${LIMITS.memwalSentenceMaxBytes} bytes`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > LIMITS.memwalRecallMaxLimit) {
    throw new MemoryError('RECALL', `the limit must be a whole number from 1 to ${LIMITS.memwalRecallMaxLimit}`);
  }
  // Cosine distance runs from 0 (same meaning) to 2 (opposite).
  if (!Number.isFinite(opts.maxDistance) || opts.maxDistance <= 0 || opts.maxDistance > LIMITS.recallDistanceMax) {
    throw new MemoryError('RECALL', `the distance cutoff must be above 0 and at most ${LIMITS.recallDistanceMax}`);
  }

  await spendRelayerPoints(client, LIMITS.memwalRequestPoints, pacing);
  let result: unknown;
  try {
    // maxDistance is applied below, not by the SDK: 0.1.8 filters with
    // `distance < maxDistance`, which silently drops a hit whose distance is missing,
    // the very hit that must fail the call.
    result = await withinCallCeiling(client.recall({ query, limit: opts.limit, namespace: label }));
  } catch (error) {
    throw relayerFailure(error, 'RECALL');
  }

  const { results, dropped_count: dropped } = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  if (!Array.isArray(results)) throw new MemoryError('RECALL', 'the recall answer has the wrong shape');
  if (results.length > opts.limit) throw new MemoryError('RECALL', `the relayer returned ${results.length} hits for a limit of ${opts.limit}`);
  // Hits the relayer could not download or decrypt are left out, so the rest may not be the closest.
  if (dropped !== undefined && dropped !== 0) throw new MemoryError('RECALL', 'the relayer left out hits it could not read');

  const hits = (results as unknown[]).map((hit, index) => {
    const { text, blob_id: blobId, distance, created_at: createdAt } = (typeof hit === 'object' && hit !== null ? hit : {}) as Record<string, unknown>;
    const position = index + 1;
    if (typeof distance !== 'number' || !Number.isFinite(distance)) throw new MemoryError('RECALL', `recall hit ${position} has no numeric distance`);
    if (distance < 0 || distance > LIMITS.recallDistanceMax) {
      throw new MemoryError('RECALL', `recall hit ${position} has a distance outside 0 to ${LIMITS.recallDistanceMax}`);
    }
    if (typeof text !== 'string') throw new MemoryError('RECALL', `recall hit ${position} has no text`);
    if (typeof blobId !== 'string' || !RELAYER_ID_PATTERN.test(blobId)) throw new MemoryError('RECALL', `recall hit ${position} has no usable blob id`);
    if (createdAt !== undefined && (typeof createdAt !== 'string' || !TIMESTAMP_PATTERN.test(createdAt))) {
      throw new MemoryError('RECALL', `recall hit ${position} has an unreadable write time`);
    }
    return { text, blobId, distance, createdAt: createdAt ?? null };
  });
  return hits.filter((hit) => hit.distance < opts.maxDistance);
}
