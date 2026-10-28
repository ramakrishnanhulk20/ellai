import { isDeepStrictEqual } from 'node:util';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, isValidTransactionDigest, normalizeStructTag, normalizeSuiAddress, SUI_ADDRESS_LENGTH } from '@mysten/sui/utils';
import { canonicalSuiAddress } from './keys.js';
import { LIMITS } from './limits.js';
import { SUI_MAINNET_CHAIN_ID } from './network.js';
import { USDC_TYPE_MAINNET } from './usdc.js';

/** What the owner lets the purse pull, all four required. Amounts are atomic USDC. */
export interface AllowanceTerms {
  lifetimeCapAtomic: bigint;
  periodMs: bigint;
  periodLimitAtomic: bigint;
  expirationMs: bigint;
}

export interface IssueArgs {
  owner: string;
  spender: string;
  terms: AllowanceTerms;
}

export interface RefillArgs {
  /** The purse: the allowance's spender and the transaction's sender. */
  spender: string;
  /** The owner whose USDC address balance the allowance debits. */
  funder: string;
  allowanceId: string;
  amountAtomic: bigint;
  /** The gas wallet, which sponsors the refill from its SUI address balance. */
  gasOwner: string;
}

/**
 * Chain facts a build needs that its arguments do not carry. The caller reads them just
 * before building and keeps them, so the same arguments and facts always give the same
 * bytes, and a check can rebuild exactly what was signed.
 */
export interface ChainFacts {
  /** The epoch the chain is in now. The transaction is valid in it and in the next one. */
  epoch: bigint;
  referenceGasPrice: bigint;
  /** A random u32, so two otherwise equal transactions get different digests. */
  nonce: number;
}

export interface RefillFacts extends ChainFacts {
  /** From getAllowance, read in the same request whose funder and spender were checked. */
  allowanceInitialSharedVersion: bigint;
}

/** One of the owner's coins, named exactly as a transaction must name an owned object. */
export interface CoinRef {
  objectId: string;
  version: bigint;
  /** The coin's current object digest, base58. */
  digest: string;
}

/**
 * Facts for a transaction whose sender pays gas with their own SUI coins, for an owner whose SUI
 * address balance cannot cover the budget. There is no epoch window: the coins' versions already
 * stop the bytes being run twice, and the Sui SDK builds coin-paid transactions the same way.
 */
export interface CoinGasFacts {
  referenceGasPrice: bigint;
  /** The sender's own SUI coins, holding the gas budget between them. Sui merges them into the first. */
  gasCoins: CoinRef[];
}

/** How an owner pays for a transaction Ellai builds for them: from their SUI address balance (ChainFacts) or with their SUI coins. */
export type OwnerGasFacts = ChainFacts | CoinGasFacts;

export interface UsdcMoveArgs {
  /** The sender, the gas payer, and the address whose address balance the coins go into. */
  owner: string;
  /** Coins the owner holds now, as listUsdcCoins read them. Their order does not matter. */
  coins: CoinRef[];
}

export type AllowanceErrorCode = 'BAD_TERMS' | 'BAD_ARGS' | 'BUILD_FAILED' | 'MISMATCH' | 'NOTHING_TO_MOVE';

/**
 * Every refusal from this module. The message is fixed text, never a value from the
 * arguments or the bytes, because these messages reach logs.
 */
export class AllowanceError extends Error {
  readonly code: AllowanceErrorCode;

  constructor(code: AllowanceErrorCode, message: string) {
    super(message);
    this.name = 'AllowanceError';
    this.code = code;
  }
}

const ALLOWANCE_NEW = '0x2::allowance::new';
const PERIODIC_RATE_LIMIT = '0x2::allowance::periodic_rate_limit';
const OPTION_SOME = '0x1::option::some';
const RATE_LIMIT_TYPE = '0x2::allowance::RateLimit';
const BALANCE_SPEND = '0x2::allowance::balance_spend';
const SEND_FUNDS = '0x2::balance::send_funds';
// public fun send_funds<T>(coin: Coin<T>, recipient: address), read from Sui Mainnet on 2026-10-28.
const COIN_SEND_FUNDS = '0x2::coin::send_funds';
// Issuing takes the balance type; spending takes the coin type (Sui allowance docs).
const ALLOWANCE_BALANCE_TYPE = normalizeStructTag(`0x2::balance::Balance<${USDC_TYPE_MAINNET}>`);
// Shown by wallets and dashboards; the chain never reads it.
const ALLOWANCE_NAME = 'Ellai purse refills';

const U32_MAX = 0xffff_ffff;
const U64_MAX = 2n ** 64n - 1n;
const ZERO_ADDRESS = normalizeSuiAddress('0x0');

function fail(code: AllowanceErrorCode, message: string): never {
  throw new AllowanceError(code, message);
}

function addressOrFail(value: unknown, what: string): string {
  let address: string;
  try {
    if (typeof value !== 'string') throw new Error('not text');
    address = canonicalSuiAddress(value);
  } catch {
    return fail('BAD_ARGS', `${what} is not a Sui address`);
  }
  if (address === ZERO_ADDRESS) fail('BAD_ARGS', `${what} is the zero address`);
  return address;
}

function isU64(value: unknown, min: bigint): value is bigint {
  return typeof value === 'bigint' && value >= min && value <= U64_MAX;
}

function checkGasPrice(price: unknown): void {
  if (typeof price !== 'bigint' || price < 1n || price > BigInt(LIMITS.maxGasPriceMist)) fail('BAD_ARGS', 'the gas price is outside the limits');
}

function checkFacts(facts: ChainFacts): void {
  if (!isU64(facts?.epoch, 0n) || facts.epoch === U64_MAX) fail('BAD_ARGS', 'the epoch is not a u64 with room for the next one');
  checkGasPrice(facts.referenceGasPrice);
  if (!Number.isSafeInteger(facts.nonce) || facts.nonce < 0 || facts.nonce > U32_MAX) fail('BAD_ARGS', 'the nonce is not a u32');
}

function checkRefillFacts(facts: RefillFacts): void {
  checkFacts(facts);
  if (!isU64(facts.allowanceInitialSharedVersion, 1n)) fail('BAD_ARGS', "the allowance's shared version is not a positive u64");
}

/**
 * Gas comes from the payer's SUI address balance, with no gas coins. Sui allows that only
 * inside a ValidDuring window of at most two epochs, which is also what stops the bytes
 * being run again later.
 */
function payGasFromAddressBalance(tx: Transaction, gasOwner: string, facts: ChainFacts, budgetMist: number): void {
  tx.setGasOwner(gasOwner);
  tx.setGasPrice(facts.referenceGasPrice);
  tx.setGasBudget(budgetMist);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(facts.epoch),
      maxEpoch: String(facts.epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_MAINNET_CHAIN_ID,
      nonce: facts.nonce,
    },
  });
}

function paysWithCoins(facts: OwnerGasFacts): facts is CoinGasFacts {
  return typeof facts === 'object' && facts !== null && 'gasCoins' in facts;
}

/** Validated, normalised coin refs: 1 to LIMITS.ownedCoinsMax of them, none named twice. */
function coinRefsOrFail(list: unknown, what: string): CoinRef[] {
  if (!Array.isArray(list)) fail('BAD_ARGS', `the ${what} are not a list`);
  if (list.length > LIMITS.ownedCoinsMax) fail('BAD_ARGS', `a transaction names at most ${LIMITS.ownedCoinsMax} ${what}`);
  const seen = new Set<string>();
  return list.map((coin: CoinRef) => {
    const objectId = addressOrFail(coin?.objectId, `an id among the ${what}`);
    if (seen.has(objectId)) fail('BAD_ARGS', `one of the ${what} is named twice`);
    seen.add(objectId);
    if (!isU64(coin.version, 1n)) fail('BAD_ARGS', `a version among the ${what} is not a positive u64`);
    // Object digests and transaction digests share one form: 32 bytes in base58.
    if (typeof coin.digest !== 'string' || !isValidTransactionDigest(coin.digest)) fail('BAD_ARGS', `a digest among the ${what} is not 32 bytes of base58`);
    return { objectId, version: coin.version, digest: coin.digest };
  });
}

function checkCoinGasFacts(facts: CoinGasFacts): CoinGasFacts {
  checkGasPrice(facts.referenceGasPrice);
  const gasCoins = coinRefsOrFail(facts.gasCoins, 'gas coins');
  if (gasCoins.length === 0) fail('BAD_ARGS', 'a coin-paid transaction names no gas coins');
  return { referenceGasPrice: facts.referenceGasPrice, gasCoins };
}

/** The facts checked, gas coins normalised, so a build and a byte check read them the same way (standard 2). */
function checkOwnerGasFacts(facts: OwnerGasFacts): OwnerGasFacts {
  if (paysWithCoins(facts)) return checkCoinGasFacts(facts);
  checkFacts(facts);
  return facts;
}

/** The owner pays gas from their SUI address balance (payGasFromAddressBalance) or with the SUI coins the facts name. */
function payOwnerGas(tx: Transaction, owner: string, facts: OwnerGasFacts, budgetMist: number): void {
  if (!paysWithCoins(facts)) {
    payGasFromAddressBalance(tx, owner, facts, budgetMist);
    return;
  }
  tx.setGasOwner(owner);
  tx.setGasPrice(facts.referenceGasPrice);
  tx.setGasBudget(budgetMist);
  tx.setGasPayment(facts.gasCoins.map((coin) => ({ objectId: coin.objectId, version: String(coin.version), digest: coin.digest })));
  tx.setExpiration({ None: true });
}

async function offlineBuild(tx: Transaction): Promise<Uint8Array> {
  try {
    // No client: every input is pure, a withdrawal or a fully named shared object, and
    // gas is set by hand, so nothing is looked up and the build is repeatable.
    return await tx.build();
  } catch {
    return fail('BUILD_FAILED', 'the SDK could not build the transaction');
  }
}

/**
 * Builds the unsigned transaction in which the owner issues a direct native allowance
 * (sui::allowance::new) over its Sui Mainnet USDC address balance, as the Sui docs show:
 * spender = the purse, a lifetime cap, a fixed-window periodic limit, an expiration and
 * no start time. The owner sends it and pays its gas, at most LIMITS.issueGasBudgetMist, from
 * its own SUI address balance inside the epoch window ChainFacts name, or with the SUI coins
 * CoinGasFacts name and no expiration. Offline and deterministic for the same args and facts.
 * Preconditions: facts were read from the chain just before, gas coins among them as the owner's
 * own; expirationMs is in the future.
 * Throws AllowanceError: BAD_ARGS for an address that is not a Sui address, the zero
 * address, a spender equal to the owner, or facts out of range (gas coins included); BAD_TERMS
 * for a zero or out-of-range term, or a period limit above the lifetime cap; BUILD_FAILED.
 */
export async function buildIssueAllowance(args: IssueArgs, facts: OwnerGasFacts): Promise<Uint8Array> {
  const owner = addressOrFail(args?.owner, 'the owner');
  const spender = addressOrFail(args.spender, 'the spender');
  if (spender === owner) fail('BAD_ARGS', 'the spender is the owner');
  const terms = args.terms;
  if (typeof terms?.lifetimeCapAtomic !== 'bigint' || terms.lifetimeCapAtomic <= 0n || terms.lifetimeCapAtomic > U64_MAX) {
    fail('BAD_TERMS', 'the lifetime cap is not a positive u64');
  }
  if (!isU64(terms.periodMs, 1n)) fail('BAD_TERMS', 'the period is not a positive u64');
  if (typeof terms.periodLimitAtomic !== 'bigint' || terms.periodLimitAtomic <= 0n || terms.periodLimitAtomic > terms.lifetimeCapAtomic) {
    fail('BAD_TERMS', 'the period limit is not between one atomic unit and the lifetime cap');
  }
  if (!isU64(terms.expirationMs, 1n)) fail('BAD_TERMS', 'the expiration is not a positive u64');
  const gas = checkOwnerGasFacts(facts);

  const tx = new Transaction();
  tx.setSender(owner);
  const rateLimit = tx.moveCall({
    target: PERIODIC_RATE_LIMIT,
    arguments: [tx.pure.u64(terms.periodMs), tx.pure.u256(terms.periodLimitAtomic)],
  });
  // Option<RateLimit> is not a pure value, so the Some comes from a Move call.
  const someRateLimit = tx.moveCall({ target: OPTION_SOME, typeArguments: [RATE_LIMIT_TYPE], arguments: [rateLimit] });
  tx.moveCall({
    target: ALLOWANCE_NEW,
    typeArguments: [ALLOWANCE_BALANCE_TYPE],
    arguments: [
      tx.pure.string(ALLOWANCE_NAME),
      tx.pure.address(spender),
      tx.pure.option('u256', terms.lifetimeCapAtomic),
      tx.pure.option('u64', null),
      tx.pure.option('u64', terms.expirationMs),
      someRateLimit,
    ],
  });
  payOwnerGas(tx, owner, gas, LIMITS.issueGasBudgetMist);
  return offlineBuild(tx);
}

interface RefillTerms {
  spender: string;
  funder: string;
  allowanceId: string;
  amount: bigint;
  gasOwner: string;
}

function refillTerms(args: RefillArgs): RefillTerms {
  const spender = addressOrFail(args?.spender, 'the spender');
  const funder = addressOrFail(args.funder, 'the funder');
  const allowanceId = addressOrFail(args.allowanceId, 'the allowance id');
  const gasOwner = addressOrFail(args.gasOwner, 'the gas owner');
  if (spender === funder) fail('BAD_ARGS', 'the spender is the funder');
  // The purse holds no SUI on purpose; a refill it paid for itself is not one Ellai builds.
  if (spender === gasOwner) fail('BAD_ARGS', 'the spender would pay its own gas');
  if (typeof args.amountAtomic !== 'bigint' || args.amountAtomic <= 0n || args.amountAtomic > BigInt(LIMITS.purseRefillAtomic)) {
    fail('BAD_ARGS', 'the refill amount is not between one atomic unit and the refill size');
  }
  return { spender, funder, allowanceId, amount: args.amountAtomic, gasOwner };
}

function refillTransaction(terms: RefillTerms, facts: RefillFacts): Transaction {
  const tx = new Transaction();
  tx.setSender(terms.spender);
  const withdrawal = tx.withdrawal({
    amount: terms.amount,
    type: USDC_TYPE_MAINNET,
    from: 'allowance',
    allowance: terms.allowanceId,
    funder: terms.funder,
  });
  const allowance = tx.sharedObjectRef({
    objectId: terms.allowanceId,
    initialSharedVersion: String(facts.allowanceInitialSharedVersion),
    mutable: true,
  });
  const [balance] = tx.moveCall({
    target: BALANCE_SPEND,
    typeArguments: [USDC_TYPE_MAINNET],
    arguments: [allowance, withdrawal, tx.object.clock()],
  });
  if (balance === undefined) fail('BUILD_FAILED', 'balance_spend returned nothing');
  tx.moveCall({ target: SEND_FUNDS, typeArguments: [USDC_TYPE_MAINNET], arguments: [balance, tx.pure.address(terms.spender)] });
  payGasFromAddressBalance(tx, terms.gasOwner, facts, LIMITS.refillGasBudgetMist);
  return tx;
}

/**
 * Builds the unsigned refill: the purse (the allowance's spender) spends exactly
 * amountAtomic of Sui Mainnet USDC through the allowance, from the funder's address
 * balance, and sends it to its own address balance. Nothing else is in the transaction.
 * The gas wallet is the gas owner and pays from its SUI address balance, at most
 * LIMITS.refillGasBudgetMist. Offline and deterministic for the same args and facts.
 * Preconditions: the allowance was read from chain just before (getAllowance), with
 * funder equal to the owner and spender equal to the purse, and facts carry its shared version.
 * Throws AllowanceError: BAD_ARGS for a bad address, the zero address, a spender equal to
 * the funder or the gas owner, an amount above LIMITS.purseRefillAtomic or not positive,
 * or facts out of range; BUILD_FAILED.
 */
export async function buildRefill(args: RefillArgs, facts: RefillFacts): Promise<Uint8Array> {
  const terms = refillTerms(args);
  checkRefillFacts(facts);
  return offlineBuild(refillTransaction(terms, facts));
}

interface UsdcMoveTerms {
  owner: string;
  /** Sorted by object id, so one set of coins always builds the same bytes. */
  coins: CoinRef[];
  gas: OwnerGasFacts;
}

function usdcMoveTerms(args: UsdcMoveArgs, facts: OwnerGasFacts): UsdcMoveTerms {
  const owner = addressOrFail(args?.owner, 'the owner');
  const coins = coinRefsOrFail(args.coins, 'USDC coins');
  if (coins.length === 0) fail('NOTHING_TO_MOVE', 'there are no USDC coins to move');
  coins.sort((a, b) => (a.objectId < b.objectId ? -1 : 1));
  const gas = checkOwnerGasFacts(facts);
  if (paysWithCoins(gas) && gas.gasCoins.some((gasCoin) => coins.some((coin) => coin.objectId === gasCoin.objectId))) {
    fail('BAD_ARGS', 'a gas coin is also one of the USDC coins moved');
  }
  return { owner, coins, gas };
}

function usdcMoveTransaction(terms: UsdcMoveTerms): Transaction {
  const tx = new Transaction();
  tx.setSender(terms.owner);
  const [first, ...rest] = terms.coins.map((coin) => tx.objectRef({ objectId: coin.objectId, version: String(coin.version), digest: coin.digest }));
  if (first === undefined) fail('NOTHING_TO_MOVE', 'there are no USDC coins to move');
  // send_funds takes one Coin, so every other coin is first merged into it; MergeCoins deletes them.
  if (rest.length > 0) tx.mergeCoins(first, rest);
  tx.moveCall({ target: COIN_SEND_FUNDS, typeArguments: [USDC_TYPE_MAINNET], arguments: [first, tx.pure.address(terms.owner)] });
  payOwnerGas(tx, terms.owner, terms.gas, LIMITS.usdcMoveGasBudgetMist);
  return tx;
}

/**
 * Builds the unsigned transaction in which the owner moves the named Sui Mainnet USDC coins into
 * their own address balance, the only part of their USDC a Sui allowance can draw from: when there
 * is more than one coin, MergeCoins of the rest into the coin with the lowest object id, then
 * 0x2::coin::send_funds<USDC>(that coin, owner). Nothing else is in the transaction, and every coin
 * named ends up in the owner's address balance. The owner sends it and pays its gas, at most
 * LIMITS.usdcMoveGasBudgetMist, from their SUI address balance inside the epoch window ChainFacts
 * name, or with the SUI coins CoinGasFacts name and no expiration. Offline and deterministic for
 * the same owner, set of coins and facts, whatever order the USDC coins come in.
 * Preconditions: the coins, gas coins included, were read from chain just before as the owner's own.
 * Throws AllowanceError: NOTHING_TO_MOVE for an empty list; BAD_ARGS for an owner or coin id that
 * is not a Sui address or is the zero address, more than LIMITS.ownedCoinsMax coins of either kind,
 * a coin named twice, a gas coin that is also a USDC coin, a version or digest out of form, or
 * facts out of range; BUILD_FAILED.
 */
export async function buildUsdcToAddress(args: UsdcMoveArgs, facts: OwnerGasFacts): Promise<Uint8Array> {
  return offlineBuild(usdcMoveTransaction(usdcMoveTerms(args, facts)));
}

type DecodedTransaction = ReturnType<typeof bcs.TransactionData.parse>;
type DecodedV1 = Extract<DecodedTransaction, { $kind: 'V1' }>['V1'];
type DecodedPtb = Extract<DecodedV1['kind'], { $kind: 'ProgrammableTransaction' }>['ProgrammableTransaction'];
interface Decoded {
  v1: DecodedV1;
  ptb: DecodedPtb;
}

function decode(bytes: Uint8Array): Decoded {
  let parsed: DecodedTransaction;
  try {
    parsed = bcs.TransactionData.parse(bytes);
  } catch {
    return fail('MISMATCH', 'the bytes do not decode as a Sui transaction');
  }
  if (parsed.$kind !== 'V1') fail('MISMATCH', 'the transaction is not version 1 transaction data');
  const v1 = parsed.V1;
  if (v1.kind.$kind !== 'ProgrammableTransaction') fail('MISMATCH', 'the transaction is not a programmable transaction');
  return { v1, ptb: v1.kind.ProgrammableTransaction };
}

function sameAddress(value: string, expected: string): boolean {
  return normalizeSuiAddress(value) === expected;
}

function isUsdc(type: string): boolean {
  try {
    return normalizeStructTag(type) === USDC_TYPE_MAINNET;
  } catch {
    return false;
  }
}

function pureAddress(bytesBase64: string): string | null {
  try {
    const raw = fromBase64(bytesBase64);
    return raw.length === SUI_ADDRESS_LENGTH ? normalizeSuiAddress(bcs.Address.parse(raw)) : null;
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Names the first way the gas price or the ValidDuring window differs from the facts built with, or null. */
function firstPriceOrWindowDifference(v1: DecodedV1, facts: ChainFacts): string | null {
  if (BigInt(v1.gasData.price) !== facts.referenceGasPrice) return 'the gas price is not the price built with';
  if (v1.expiration.$kind !== 'ValidDuring') return 'the expiration is not a ValidDuring window';
  const window = v1.expiration.ValidDuring;
  if (window.minEpoch === null || window.maxEpoch === null) return 'the epoch window is open';
  if (BigInt(window.minEpoch) !== facts.epoch || BigInt(window.maxEpoch) !== facts.epoch + 1n) {
    return 'the epoch window is not the one built for';
  }
  if (window.minTimestamp !== null || window.maxTimestamp !== null) return 'the expiration carries a timestamp';
  if (window.chain !== SUI_MAINNET_CHAIN_ID) return 'the chain is not Sui Mainnet';
  if (window.nonce !== facts.nonce) return 'the nonce is not the one built with';
  return null;
}

/** Names the first way the decoded transaction differs from the refill these terms describe, or null. */
function firstRefillDifference(actual: Decoded, expected: Decoded, terms: RefillTerms, facts: RefillFacts): string | null {
  const { v1, ptb } = actual;
  if (!sameAddress(v1.sender, terms.spender)) return 'the sender is not the purse';
  if (!sameAddress(v1.gasData.owner, terms.gasOwner)) return 'the gas owner is not the gas wallet';
  if (v1.gasData.payment.length !== 0) return 'the transaction carries gas coins';
  if (BigInt(v1.gasData.budget) !== BigInt(LIMITS.refillGasBudgetMist)) return 'the gas budget is not the refill budget';
  const gas = firstPriceOrWindowDifference(v1, facts);
  if (gas !== null) return gas;

  if (ptb.commands.length !== expected.ptb.commands.length) {
    return `the transaction has ${ptb.commands.length} commands, a refill has ${expected.ptb.commands.length}`;
  }
  if (ptb.inputs.length !== expected.ptb.inputs.length) {
    return `the transaction has ${ptb.inputs.length} inputs, a refill has ${expected.ptb.inputs.length}`;
  }

  const withdrawals = ptb.inputs.flatMap((input) => (input.$kind === 'FundsWithdrawal' ? [input.FundsWithdrawal] : []));
  const [spend] = withdrawals;
  if (withdrawals.length !== 1 || spend === undefined) return 'the transaction does not withdraw exactly once';
  if (spend.withdrawFrom.$kind !== 'SenderAllowance') return 'the withdrawal is not through an allowance';
  if (!sameAddress(spend.withdrawFrom.SenderAllowance.allowance, terms.allowanceId)) return 'the spend is not through the allowance named';
  if (!sameAddress(spend.withdrawFrom.SenderAllowance.funder, terms.funder)) return 'the spend does not debit the funder named';
  if (spend.typeArg.$kind !== 'Balance' || !isUsdc(spend.typeArg.Balance)) return 'the spend is not in Sui Mainnet USDC';
  if (spend.reservation.$kind !== 'MaxAmountU64' || BigInt(spend.reservation.MaxAmountU64) !== terms.amount) {
    return 'the spend amount is not the refill amount';
  }

  const coinTypes = ptb.commands.flatMap((command) => (command.$kind === 'MoveCall' ? command.MoveCall.typeArguments : []));
  if (!coinTypes.every(isUsdc)) return 'a call is not typed in Sui Mainnet USDC';

  const recipients = ptb.inputs.flatMap((input) => (input.$kind === 'Pure' ? [pureAddress(input.Pure.bytes)] : []));
  if (recipients.length !== 1) return 'the transaction does not send to exactly one address';
  if (recipients[0] !== terms.spender) return 'the refill is not sent to the purse';

  for (const [index, command] of ptb.commands.entries()) {
    if (!isDeepStrictEqual(command, expected.ptb.commands[index])) return `command ${index} is not the expected call`;
  }
  for (const [index, input] of ptb.inputs.entries()) {
    if (!isDeepStrictEqual(input, expected.ptb.inputs[index])) return `input ${index} is not the expected input`;
  }
  return null;
}

/**
 * Proves txBytes are the refill these args and facts describe and nothing else. The rule
 * is "equal to a fresh build from the same args and facts", byte for byte (standard 1).
 * Before that, both sides are decoded by the same SDK parser and compared field by
 * field, so a refusal names the first difference: sender, gas owner, gas coins, gas
 * budget and price, the epoch window, chain and nonce, the command and input counts,
 * the single allowance spend (allowance, funder, coin, amount), the coin type of every
 * call, the single recipient, then each command and input in order.
 * Covers: another sender, sponsor, allowance, funder, amount, coin or recipient, extra
 * commands (including any use of the sponsor's gas coin), a larger gas budget.
 * Does not cover: whether the allowance on chain belongs to this owner and purse; the
 * caller reads it with getAllowance first (C7).
 * The gas wallet and the purse sign only bytes that pass this check.
 * Throws AllowanceError: MISMATCH for any difference, BAD_ARGS or BUILD_FAILED when the
 * expected refill itself cannot be built.
 */
export async function assertRefill(txBytes: Uint8Array, args: RefillArgs, facts: RefillFacts): Promise<void> {
  if (!(txBytes instanceof Uint8Array)) fail('MISMATCH', 'the refill bytes are missing');
  const terms = refillTerms(args);
  checkRefillFacts(facts);
  const expectedBytes = await offlineBuild(refillTransaction(terms, facts));
  const difference = firstRefillDifference(decode(txBytes), decode(expectedBytes), terms, facts);
  if (difference !== null) fail('MISMATCH', difference);
  if (!sameBytes(txBytes, expectedBytes)) fail('MISMATCH', 'the bytes differ from a fresh build of the refill');
}

/** Names the first way the decoded transaction differs from the move these terms describe, or null. */
/** Names the first way the gas payment, price or expiration differs from how the owner was to pay, or null. */
function firstOwnerGasDifference(v1: DecodedV1, gas: OwnerGasFacts): string | null {
  if (!paysWithCoins(gas)) {
    if (v1.gasData.payment.length !== 0) return 'the transaction carries gas coins';
    return firstPriceOrWindowDifference(v1, gas);
  }
  const payment = v1.gasData.payment.map((coin) => ({ objectId: normalizeSuiAddress(coin.objectId), version: BigInt(coin.version), digest: coin.digest }));
  if (!isDeepStrictEqual(payment, gas.gasCoins)) return 'the gas coins are not the ones built with';
  if (BigInt(v1.gasData.price) !== gas.referenceGasPrice) return 'the gas price is not the price built with';
  if (v1.expiration.$kind !== 'None') return 'a coin-paid transaction carries an expiration';
  return null;
}

function firstUsdcMoveDifference(actual: Decoded, expected: Decoded, terms: UsdcMoveTerms): string | null {
  const { v1, ptb } = actual;
  if (!sameAddress(v1.sender, terms.owner)) return 'the sender is not the owner';
  if (!sameAddress(v1.gasData.owner, terms.owner)) return 'the gas owner is not the owner';
  if (BigInt(v1.gasData.budget) !== BigInt(LIMITS.usdcMoveGasBudgetMist)) return 'the gas budget is not the move budget';
  const gas = firstOwnerGasDifference(v1, terms.gas);
  if (gas !== null) return gas;

  if (ptb.commands.length !== expected.ptb.commands.length) {
    return `the transaction has ${ptb.commands.length} commands, this move has ${expected.ptb.commands.length}`;
  }
  if (ptb.inputs.length !== expected.ptb.inputs.length) {
    return `the transaction has ${ptb.inputs.length} inputs, this move has ${expected.ptb.inputs.length}`;
  }

  const coinTypes = ptb.commands.flatMap((command) => (command.$kind === 'MoveCall' ? command.MoveCall.typeArguments : []));
  if (!coinTypes.every(isUsdc)) return 'a call is not typed in Sui Mainnet USDC';

  const recipients = ptb.inputs.flatMap((input) => (input.$kind === 'Pure' ? [pureAddress(input.Pure.bytes)] : []));
  if (recipients.length !== 1 || recipients[0] !== terms.owner) return "the coins are not sent to the owner's own address balance";

  const named = new Set(terms.coins.map((coin) => coin.objectId));
  for (const input of ptb.inputs) {
    if (input.$kind !== 'Object') continue;
    const object = input.Object;
    if (object.$kind !== 'ImmOrOwnedObject' || !named.has(normalizeSuiAddress(object.ImmOrOwnedObject.objectId))) {
      return 'an object in the transaction is not one of the coins named';
    }
  }

  for (const [index, command] of ptb.commands.entries()) {
    if (!isDeepStrictEqual(command, expected.ptb.commands[index])) return `command ${index} is not the expected call`;
  }
  for (const [index, input] of ptb.inputs.entries()) {
    if (!isDeepStrictEqual(input, expected.ptb.inputs[index])) return `input ${index} is not the expected input`;
  }
  return null;
}

/**
 * Proves txBytes are the move these args and facts describe and nothing else: equal, byte for
 * byte, to buildUsdcToAddress with the same args and facts (standard 1). Both sides are first
 * decoded by the same SDK parser and compared field by field, so a refusal names the first
 * difference: sender, gas owner, gas budget, then how gas is paid (no gas coins, the price and the
 * epoch window, chain and nonce for the address balance; exactly the gas coins named, the price
 * and no expiration for coins), the command and input counts, the coin type of every call, the
 * single recipient, every object being one of the coins named, then each command and input in order.
 * Covers: another sender or gas payer, another recipient, another coin type, coins other than
 * the ones named (another owner's among them), other gas coins, extra commands, a larger gas budget.
 * Does not cover: whether the coins named, gas coins included, are the owner's own at their
 * current versions; the caller reads them through Tatum first and passes exactly those (C7).
 * Throws AllowanceError: MISMATCH for any difference; NOTHING_TO_MOVE, BAD_ARGS or BUILD_FAILED
 * when the expected move itself cannot be built.
 */
export async function assertUsdcToAddress(txBytes: Uint8Array, args: UsdcMoveArgs, facts: OwnerGasFacts): Promise<void> {
  if (!(txBytes instanceof Uint8Array)) fail('MISMATCH', 'the move bytes are missing');
  const terms = usdcMoveTerms(args, facts);
  const expectedBytes = await offlineBuild(usdcMoveTransaction(terms));
  const difference = firstUsdcMoveDifference(decode(txBytes), decode(expectedBytes), terms);
  if (difference !== null) fail('MISMATCH', difference);
  if (!sameBytes(txBytes, expectedBytes)) fail('MISMATCH', 'the bytes differ from a fresh build of the move');
}

const NO_REFILL = Object.freeze({ refill: false, amountAtomic: 0n });

/**
 * Decides whether the purse is refilled now (C23). A refill happens only when the purse
 * holds less than LIMITS.purseRefillBelowAtomic, fewer than LIMITS.purseMaxRefillsPerDay
 * refills happened in the last 24 hours, and the purse after the refill would hold no
 * more than LIMITS.purseMaxFloatAtomic. A refill is always exactly LIMITS.purseRefillAtomic.
 * Fails closed: an amount that is not a non-negative bigint, or a count that is not a
 * non-negative whole number, means no refill.
 * The caller counts every refill sent in the window, landed or not yet known.
 */
export function refillDecision(args: { purseUsdcAtomic: bigint; refillsInWindow: number }): { refill: boolean; amountAtomic: bigint } {
  const purse = args?.purseUsdcAtomic;
  const refills = args?.refillsInWindow;
  if (typeof purse !== 'bigint' || purse < 0n) return NO_REFILL;
  if (!Number.isSafeInteger(refills) || refills < 0) return NO_REFILL;
  if (purse >= BigInt(LIMITS.purseRefillBelowAtomic)) return NO_REFILL;
  if (refills >= LIMITS.purseMaxRefillsPerDay) return NO_REFILL;
  const amount = BigInt(LIMITS.purseRefillAtomic);
  if (purse + amount > BigInt(LIMITS.purseMaxFloatAtomic)) return NO_REFILL;
  return Object.freeze({ refill: true, amountAtomic: amount });
}
