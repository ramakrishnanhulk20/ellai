// Moves real USDC on Sui Mainnet, small and capped, to prove Ellai's money path end to end:
//   1. balances of the test owner, its purse and the gas wallet, read through Tatum
//   2. the owner issues a native allowance to the purse (1.00 USDC in total, 0.50 per 24 hours,
//      30 days), read back from chain and checked: funder is the owner, spender the purse, coin USDC
//   3. if refillDecision says so, the purse pulls one 0.10 USDC refill through the allowance,
//      the gas wallet sponsoring the gas, after assertRefill passes
//   4. every payment an earlier run signed and did not see settle is read again by its digest:
//      one that landed is verified, one that has not keeps counting until its epoch window
//      has closed and the chain shows it never landed, and only then is released (C4). Then
//      the purse pays at most one live third-party seller 0.01 USDC with a gasless send,
//      skipping hosts that answered a paid call with an error while it can still land: the
//      seller's documented request goes unpaid and must answer a 0.01 USDC 402, the same
//      request goes again with the payment header and that seller's paid wait, and the
//      payment is verified on chain by verifySettlement from the digest Ellai computed (C8)
//   5. the final balances
// Every stage is idempotent through scratchpad/slice-state-pay.json, written before anything
// is sent and updated after, so a re-run never issues, refills or pays twice. Ceilings: at most
// 0.20 USDC may leave the owner; in this order at most 0.02 USDC newly signed to sellers and at
// most one new payment settled; across both orders at most 0.04 USDC signed to sellers and not
// released. Anything that would pass one stops the run. Every transaction is dry-run first
// and must move exactly the money expected; a real transaction that moves anything else
// stops the run on the spot.
// Prints digests, addresses, amounts and links. Never prints a key, a signature, signed
// bytes or the X-PAYMENT value, and seller text is printed as inert, length-capped text.
// Flag: --until=N stops after stage N.
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, SUI_DECIMALS, SUI_TYPE_ARG } from '@mysten/sui/utils';
import { z } from 'zod';
import {
  AllowanceError,
  assertRefill,
  buildIssueAllowance,
  buildRefill,
  type ChainFacts,
  type RefillArgs,
  type RefillFacts,
  refillDecision,
} from '../src/allowance.js';
import {
  type AllowanceState,
  type BalanceChange,
  type Balances,
  type Chain,
  ChainError,
  createChain,
  type ExecutionResult,
  type TransactionResult,
} from '../src/chain.js';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '../src/challenge.js';
import { config } from '../src/config.js';
import { canonicalSuiAddress, derivePurseKeypair } from '../src/keys.js';
import { LIMITS } from '../src/limits.js';
import { NetError, type SafeRequest, safeFetch } from '../src/net.js';
import { PaymentError, paymentHeader, signPayment, verifySettlement } from '../src/payment.js';
import { KNOWN_SELLERS, type Seller } from '../src/sellers.js';
import { USDC_DECIMALS, USDC_TYPE_MAINNET } from '../src/usdc.js';

const STATE_FILE = new URL('../../../scratchpad/slice-state-pay.json', import.meta.url);
const SUISCAN = 'https://suiscan.xyz/mainnet';
const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);
const ALLOWANCE_OBJECT_TYPE = normalizeStructTag(`0x2::allowance::Allowance<0x2::balance::Balance<${USDC_TYPE_MAINNET}>>`);

const DAY_MS = 86_400_000;
// The terms this order asks the owner to grant.
const SLICE_LIFETIME_CAP_ATOMIC = 1_000_000n;
const SLICE_PERIOD_MS = BigInt(DAY_MS);
const SLICE_PERIOD_LIMIT_ATOMIC = 500_000n;
const SLICE_EXPIRY_MS = 30 * DAY_MS;
const SELLER_PRICE_ATOMIC = 10_000n;
// The order the payments signed by this run belong to. The ceilings below are its own.
const THIS_ORDER = 'WO-3c';
// Ceilings on top of the allowance's own caps.
const MAX_OWNER_OUTFLOW_ATOMIC = 200_000n;
/** Signed to sellers in this order, released or not, so a release never buys another attempt. */
const MAX_NEW_SIGNED_ATOMIC = 20_000n;
/**
 * Signed to sellers and not released, settled or not, across both orders (C4): the earlier
 * order's 0.02 USDC ceiling plus this order's.
 */
const MAX_SELLER_COUNTED_ATOMIC = 40_000n;
const BODY_EXCERPT_CHARS = 300;
// Facts older than this are read again before a build, so a build never leans on a stale epoch.
const FACTS_MAX_AGE_MS = 5 * 60_000;

// Anonymous Tatum allows 5 requests a minute per IP. Two seconds of slack over the minute,
// and a wait longer than one window after a refusal.
const PACING_WINDOW_MS = 62_000;
const RATE_LIMIT_WAIT_MS = 65_000;
const RATE_LIMIT_RETRIES = 2;
// The most requests one executeTransaction makes when nothing goes wrong: the send and, on a
// refusal, the lookup that confirms it.
const EXECUTE_REQUESTS = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A stop the operator must read: the run ends, nothing further is sent. */
class Stop extends Error {}

function units(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const sign = amount < 0n ? '-' : '';
  const magnitude = amount < 0n ? -amount : amount;
  return `${sign}${magnitude / base}.${(magnitude % base).toString().padStart(decimals, '0')}`;
}
const usdc = (atomic: bigint) => `${units(atomic, USDC_DECIMALS)} USDC`;
const sui = (mist: bigint) => `${units(mist, SUI_DECIMALS)} SUI`;
const txLink = (digest: string) => `${SUISCAN}/tx/${digest}`;
const objectLink = (id: string) => `${SUISCAN}/object/${id}`;

const addressText = z.string().regex(/^0x[0-9a-f]{64}$/);
const digestText = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const uintText = z.string().max(78).regex(/^(0|[1-9]\d*)$/);
const factsSchema = z.strictObject({
  epoch: uintText,
  referenceGasPrice: uintText,
  nonce: z.number().int().min(0).max(0xffff_ffff),
});

// Holds digests, addresses, amounts and build facts only: nothing here can move money.
const stateSchema = z.strictObject({
  version: z.literal(2),
  owner: addressText,
  purse: addressText,
  gasWallet: addressText,
  issue: z
    .strictObject({
      status: z.enum(['sending', 'issued', 'failed']),
      digest: digestText,
      facts: factsSchema,
      expirationMs: uintText,
      allowanceId: addressText.nullable(),
      gasMist: uintText.nullable(),
      sentAtMs: z.number().int().nonnegative(),
    })
    .nullable(),
  refills: z
    .array(
      z.strictObject({
        status: z.enum(['sending', 'landed', 'failed']),
        digest: digestText,
        allowanceId: addressText,
        amountAtomic: uintText,
        facts: factsSchema,
        initialSharedVersion: uintText,
        gasMist: uintText.nullable(),
        sentAtMs: z.number().int().nonnegative(),
      }),
    )
    .max(50),
  payments: z
    .array(
      z.strictObject({
        // signed, sent and unsettled are open: the bytes may still land. released means the
        // window closed and the chain showed they never did.
        status: z.enum(['signed', 'sent', 'verified', 'mismatch', 'unsettled', 'released']),
        order: z.enum(['WO-3b', THIS_ORDER]),
        digest: digestText,
        sellerUrl: z.string().max(LIMITS.resourceMaxLength),
        recipient: addressText,
        amountAtomic: uintText,
        /** The last epoch the signed bytes can land in. */
        maxEpoch: uintText,
        sellerStatus: z.number().int().nullable(),
        verdict: z.string().max(300).nullable(),
        signedAtMs: z.number().int().nonnegative(),
      }),
    )
    .max(50),
});
type State = z.infer<typeof stateSchema>;
type PaymentRecord = State['payments'][number];
type FactsRecord = z.infer<typeof factsSchema>;

function loadState(owner: string, purse: string, gasWallet: string): State {
  if (!existsSync(STATE_FILE)) return { version: 2, owner, purse, gasWallet, issue: null, refills: [], payments: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    throw new Stop('The state file is not JSON. Nothing was sent. Look at it before running again.');
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) throw new Stop('The state file has an unknown shape. Nothing was sent. Look at it before running again.');
  const state = result.data;
  if (state.owner !== owner || state.purse !== purse || state.gasWallet !== gasWallet) {
    throw new Stop('The state file belongs to other wallets than the ones in .env. Nothing was sent.');
  }
  return state;
}

/** Written to a side file and renamed over, so a crash mid-write never leaves half a record. */
function saveState(state: State): void {
  mkdirSync(new URL('.', STATE_FILE), { recursive: true });
  const side = new URL('./slice-state-pay.json.next', STATE_FILE);
  writeFileSync(side, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(side, STATE_FILE);
}

function factsRecord(facts: ChainFacts): FactsRecord {
  return { epoch: String(facts.epoch), referenceGasPrice: String(facts.referenceGasPrice), nonce: facts.nonce };
}

function factsFrom(record: FactsRecord): ChainFacts {
  return { epoch: BigInt(record.epoch), referenceGasPrice: BigInt(record.referenceGasPrice), nonce: record.nonce };
}

/** Keeps this script's own anonymous Tatum use under the per-minute allowance, and waits out a refusal on reads. */
class Tatum {
  readonly #anonymous: boolean;
  readonly #calls: number[] = [];

  constructor(anonymous: boolean) {
    this.#anonymous = anonymous;
  }

  async reserve(count: number): Promise<void> {
    if (!this.#anonymous) return;
    const prune = () => {
      while (this.#calls.length > 0 && (this.#calls[0] ?? 0) <= Date.now() - PACING_WINDOW_MS) this.#calls.shift();
    };
    for (prune(); this.#calls.length + count > LIMITS.tatumAnonymousRequestsPerMinute; prune()) {
      await sleep((this.#calls[0] ?? Date.now()) + PACING_WINDOW_MS - Date.now());
    }
    for (let i = 0; i < count; i++) this.#calls.push(Date.now());
  }

  /** For reads and dry runs only, which are safe to repeat. Sends are never retried here. */
  async read<T>(run: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      await this.reserve(1);
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof ChainError) || error.code !== 'RATE_LIMITED' || retry >= RATE_LIMIT_RETRIES) throw error;
        console.log(`  (Tatum rate limited; waiting ${RATE_LIMIT_WAIT_MS / 1000} s and reading again)`);
        await sleep(RATE_LIMIT_WAIT_MS);
      }
    }
  }
}

interface Wallets {
  owner: Ed25519Keypair;
  purse: Ed25519Keypair;
  gas: Ed25519Keypair;
  ownerAddress: string;
  purseAddress: string;
  gasAddress: string;
}

interface Run {
  chain: Chain;
  tatum: Tatum;
  wallets: Wallets;
  state: State;
  facts: { value: ChainFacts; readAtMs: number } | null;
  purseUsdc: bigint | null;
}

function describeBalances(label: string, address: string, balances: Balances): string {
  return [
    `  ${label} ${address}`,
    `    USDC address balance ${usdc(balances.usdcAddressBalance)}, USDC in coins ${usdc(balances.usdcCoinBalance)}, SUI ${sui(balances.suiTotal)}`,
  ].join('\n');
}

async function printBalances(run: Run): Promise<void> {
  const { chain, tatum, wallets } = run;
  const owner = await tatum.read(() => chain.getBalances(wallets.ownerAddress));
  const purse = await tatum.read(() => chain.getBalances(wallets.purseAddress));
  const gas = await tatum.read(() => chain.getBalances(wallets.gasAddress));
  run.purseUsdc = purse.usdcAddressBalance;
  console.log(describeBalances('Test owner', wallets.ownerAddress, owner));
  console.log(describeBalances('Purse     ', wallets.purseAddress, purse));
  console.log(describeBalances('Gas wallet', wallets.gasAddress, gas));
}

async function currentFacts(run: Run): Promise<ChainFacts> {
  if (run.facts && Date.now() - run.facts.readAtMs < FACTS_MAX_AGE_MS) return { ...run.facts.value, nonce: randomInt(0, 2 ** 32) };
  const epoch = await run.tatum.read(() => run.chain.getCurrentEpoch());
  const referenceGasPrice = await run.tatum.read(() => run.chain.getReferenceGasPrice());
  if (referenceGasPrice > BigInt(LIMITS.maxGasPriceMist)) {
    throw new Stop(`The reference gas price is ${referenceGasPrice} MIST, above the ${LIMITS.maxGasPriceMist} MIST ceiling. Nothing was sent.`);
  }
  run.facts = { value: { epoch, referenceGasPrice, nonce: 0 }, readAtMs: Date.now() };
  return { epoch, referenceGasPrice, nonce: randomInt(0, 2 ** 32) };
}

interface ExpectedChange {
  address: string;
  coinType: string;
  /** Exact amount, or for gas a debit between one MIST and the budget. */
  amount: bigint | { gasUpTo: bigint };
}

/** Names the first way the changes differ from exactly the expected ones, or null. Amounts compare as integers. */
function changesMismatch(changes: BalanceChange[], expected: ExpectedChange[]): string | null {
  if (changes.length !== expected.length) return `${changes.length} balance changes, expected ${expected.length}`;
  for (const want of expected) {
    const found = changes.filter((change) => change.address === want.address && change.coinType === want.coinType);
    const [change] = found;
    if (found.length !== 1 || change === undefined) return `no single change for ${want.address} in ${want.coinType}`;
    if (typeof want.amount === 'bigint') {
      if (change.amount !== want.amount) return `${want.address} changed by ${change.amount}, expected ${want.amount}`;
    } else if (change.amount >= 0n || -change.amount > want.amount.gasUpTo) {
      return `${want.address} gas change ${change.amount} is not a debit within the budget`;
    }
  }
  return null;
}

function gasPaid(changes: BalanceChange[], payer: string): bigint {
  const change = changes.find((entry) => entry.address === payer && entry.coinType === SUI_TYPE);
  return change === undefined ? 0n : -change.amount;
}

/**
 * The dry run must succeed and move exactly the expected money, or nothing is signed or sent.
 * With slotReserved the caller already reserved the request, and a rate limit is not waited
 * out, because the wait would outlast a seller's challenge.
 */
async function dryRun(run: Run, what: string, txBytes: Uint8Array, expected: ExpectedChange[], slotReserved = false): Promise<void> {
  const simulate = () => run.chain.simulate(txBytes);
  const simulation = slotReserved ? await simulate() : await run.tatum.read(simulate);
  if (simulation.status !== 'success') throw new Stop(`The ${what} dry run failed (${simulation.errorCode}). Nothing was sent.`);
  const mismatch = changesMismatch(simulation.balanceChanges, expected);
  if (mismatch !== null) throw new Stop(`The ${what} dry run moves money it should not: ${mismatch}. Nothing was sent.`);
  console.log(`  dry run ok: moves exactly the expected money`);
}

async function send(run: Run, txBytes: Uint8Array, signatures: string[]): Promise<ExecutionResult> {
  await run.tatum.reserve(EXECUTE_REQUESTS);
  try {
    return await run.chain.executeTransaction(txBytes, signatures);
  } catch (error) {
    if (error instanceof ChainError) {
      throw new Stop(`${error.message}. The state file keeps the digest; run again to resolve it before anything new is sent.`);
    }
    throw error;
  }
}

/** Polls for an object or balance that a landed transaction made, while Tatum's nodes catch up. */
async function afterWrite<T>(run: Run, readOnce: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; attempt < LIMITS.chainReadAfterWriteTries; attempt++) {
    await sleep(LIMITS.chainReadAfterWriteDelayMs);
    const value = await run.tatum.read(readOnce);
    if (value !== null) return value;
  }
  return null;
}

/** C7: the allowance read from chain now must be the owner's, for this purse, in USDC. */
function allowanceNotOurs(allowance: AllowanceState, wallets: Wallets): string | null {
  if (allowance.funder !== wallets.ownerAddress) return 'its funder is not the test owner';
  if (allowance.spender !== wallets.purseAddress) return 'its spender is not the purse';
  if (allowance.coinType !== USDC_TYPE_MAINNET) return 'it is not over Sui Mainnet USDC';
  return null;
}

function issueArgs(wallets: Wallets, expirationMs: bigint) {
  return {
    owner: wallets.ownerAddress,
    spender: wallets.purseAddress,
    terms: {
      lifetimeCapAtomic: SLICE_LIFETIME_CAP_ATOMIC,
      periodMs: SLICE_PERIOD_MS,
      periodLimitAtomic: SLICE_PERIOD_LIMIT_ATOMIC,
      expirationMs,
    },
  };
}

async function readAllowanceAfterIssue(run: Run, allowanceId: string): Promise<AllowanceState> {
  const allowance = await afterWrite(run, () =>
    run.chain.getAllowance(allowanceId).catch((error: unknown) => {
      if (error instanceof ChainError && error.code === 'NOT_FOUND') return null;
      throw error;
    }),
  );
  if (allowance === null) throw new Stop(`Allowance ${allowanceId} is not readable through Tatum yet. Run again in a minute.`);
  return allowance;
}

async function stageAllowance(run: Run): Promise<void> {
  const { state, wallets } = run;
  if (state.issue?.status === 'issued' && state.issue.allowanceId !== null) {
    const { allowanceId, digest, expirationMs } = state.issue;
    console.log(`  Already issued, nothing sent: allowance ${allowanceId}`);
    console.log(`  object ${objectLink(allowanceId)}`);
    console.log(`  issue digest ${digest}  ${txLink(digest)}`);
    showAllowance(run, await run.tatum.read(() => run.chain.getAllowance(allowanceId)), BigInt(expirationMs));
    return;
  }

  let txBytes: Uint8Array;
  let expirationMs: bigint;
  if (state.issue?.status === 'sending') {
    // An earlier run sent these exact bytes and did not learn the outcome. The same facts
    // rebuild the same bytes, and Sui runs one digest at most once.
    expirationMs = BigInt(state.issue.expirationMs);
    txBytes = await buildIssueAllowance(issueArgs(wallets, expirationMs), factsFrom(state.issue.facts));
    if (TransactionDataBuilder.getDigestFromBytes(txBytes) !== state.issue.digest) {
      throw new Stop('The recorded issue does not rebuild to its digest. Nothing was sent.');
    }
    console.log(`  Resolving the issue an earlier run sent: ${state.issue.digest}`);
  } else {
    const facts = await currentFacts(run);
    expirationMs = BigInt(Date.now() + SLICE_EXPIRY_MS);
    txBytes = await buildIssueAllowance(issueArgs(wallets, expirationMs), facts);
    await dryRun(run, 'issue', txBytes, [
      { address: wallets.ownerAddress, coinType: SUI_TYPE, amount: { gasUpTo: BigInt(LIMITS.issueGasBudgetMist) } },
    ]);
    state.issue = {
      status: 'sending',
      digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
      facts: factsRecord(facts),
      expirationMs: String(expirationMs),
      allowanceId: null,
      gasMist: null,
      sentAtMs: Date.now(),
    };
    saveState(state);
  }
  const issue = state.issue;
  if (issue === null) throw new Stop('The issue record is missing.');

  const { signature } = await wallets.owner.signTransaction(txBytes);
  const result = await send(run, txBytes, [signature]);
  if (result.status !== 'success') {
    issue.status = 'failed';
    saveState(state);
    throw new Stop(`The issue did not land (${result.errorCode}). Digest ${result.digest}. No allowance exists.`);
  }
  const unexpected = changesMismatch(result.balanceChanges, [
    { address: wallets.ownerAddress, coinType: SUI_TYPE, amount: { gasUpTo: BigInt(LIMITS.issueGasBudgetMist) } },
  ]);
  const created = result.createdObjects.filter((object) => object.type === ALLOWANCE_OBJECT_TYPE);
  const [allowanceObject] = created;
  if (created.length !== 1 || allowanceObject === undefined) {
    throw new Stop(`UNEXPECTED: the issue ${result.digest} landed but created ${created.length} USDC allowances. Stopping.`);
  }
  issue.status = 'issued';
  issue.allowanceId = allowanceObject.objectId;
  issue.gasMist = String(gasPaid(result.balanceChanges, wallets.ownerAddress));
  saveState(state);
  if (unexpected !== null) throw new Stop(`UNEXPECTED money movement in the issue ${result.digest}: ${unexpected}. Stopping.`);

  console.log(`  Issued allowance ${allowanceObject.objectId}`);
  console.log(`  object ${objectLink(allowanceObject.objectId)}`);
  console.log(`  issue digest ${result.digest}  ${txLink(result.digest)}`);
  console.log(`  owner gas ${sui(BigInt(issue.gasMist))}`);
  showAllowance(run, await readAllowanceAfterIssue(run, allowanceObject.objectId), expirationMs);
}

/** Prints the allowance as the chain holds it, after the C7 check and the check that it carries the signed terms. */
function showAllowance(run: Run, allowance: AllowanceState, expirationMs: bigint): void {
  const notOurs = allowanceNotOurs(allowance, run.wallets);
  if (notOurs !== null) throw new Stop(`C7 refused the allowance read back: ${notOurs}. Stopping.`);
  console.log(`  Read back through Tatum (C7 ok): funder ${allowance.funder}, spender ${allowance.spender}, coin USDC`);
  console.log(
    `  lifetime cap ${allowance.lifetimeCap === null ? 'none' : usdc(allowance.lifetimeCap)}, ` +
      `${allowance.periodLimit === null ? 'no rate limit' : `${usdc(allowance.periodLimit)} per ${allowance.periodMs} ms`}, ` +
      `expires ${allowance.expirationMs === null ? 'never' : new Date(Number(allowance.expirationMs)).toISOString()}, ` +
      `spent ${usdc(allowance.spentTotal)}`,
  );
  const matches =
    allowance.lifetimeCap === SLICE_LIFETIME_CAP_ATOMIC &&
    allowance.periodMs === SLICE_PERIOD_MS &&
    allowance.periodLimit === SLICE_PERIOD_LIMIT_ATOMIC &&
    allowance.expirationMs === expirationMs;
  if (!matches) throw new Stop('The allowance on chain does not carry the terms that were signed. Stopping.');
  console.log('  terms match what the owner signed: 1.00 USDC in total, 0.50 USDC per 24 hours, 30 days');
}

function refillArgsFor(run: Run, allowanceId: string, amountAtomic: bigint): RefillArgs {
  const { wallets } = run;
  return { spender: wallets.purseAddress, funder: wallets.ownerAddress, allowanceId, amountAtomic, gasOwner: wallets.gasAddress };
}

function refillChanges(wallets: Wallets, amount: bigint): ExpectedChange[] {
  return [
    { address: wallets.ownerAddress, coinType: USDC_TYPE_MAINNET, amount: -amount },
    { address: wallets.purseAddress, coinType: USDC_TYPE_MAINNET, amount },
    { address: wallets.gasAddress, coinType: SUI_TYPE, amount: { gasUpTo: BigInt(LIMITS.refillGasBudgetMist) } },
  ];
}

/** Both keys sign only bytes that pass assertRefill, checked right before the signatures. */
async function signAndSendRefill(run: Run, txBytes: Uint8Array, args: RefillArgs, facts: RefillFacts): Promise<ExecutionResult> {
  await assertRefill(txBytes, args, facts);
  const purseSignature = (await run.wallets.purse.signTransaction(txBytes)).signature;
  const gasSignature = (await run.wallets.gas.signTransaction(txBytes)).signature;
  return send(run, txBytes, [purseSignature, gasSignature]);
}

async function recordRefillResult(run: Run, record: State['refills'][number], result: ExecutionResult): Promise<void> {
  const { state, wallets } = run;
  if (result.status !== 'success') {
    record.status = 'failed';
    saveState(state);
    throw new Stop(`The refill did not land (${result.errorCode}). Digest ${result.digest}.`);
  }
  record.status = 'landed';
  record.gasMist = String(gasPaid(result.balanceChanges, wallets.gasAddress));
  saveState(state);
  const unexpected = changesMismatch(result.balanceChanges, refillChanges(wallets, BigInt(record.amountAtomic)));
  if (unexpected !== null) throw new Stop(`UNEXPECTED money movement in the refill ${result.digest}: ${unexpected}. Stopping.`);
  console.log(`  Refilled ${usdc(BigInt(record.amountAtomic))} into the purse`);
  console.log(`  refill digest ${result.digest}  ${txLink(result.digest)}`);
  console.log(`  gas wallet gas ${sui(BigInt(record.gasMist))}, paid from its SUI address balance (no gas coin, no sponsor package)`);
}

async function resolveSentRefills(run: Run): Promise<void> {
  for (const record of run.state.refills.filter((entry) => entry.status === 'sending')) {
    console.log(`  Resolving the refill an earlier run sent: ${record.digest}`);
    const args = refillArgsFor(run, record.allowanceId, BigInt(record.amountAtomic));
    const facts: RefillFacts = { ...factsFrom(record.facts), allowanceInitialSharedVersion: BigInt(record.initialSharedVersion) };
    const txBytes = await buildRefill(args, facts);
    if (TransactionDataBuilder.getDigestFromBytes(txBytes) !== record.digest) {
      throw new Stop('A recorded refill does not rebuild to its digest. Nothing was sent.');
    }
    await recordRefillResult(run, record, await signAndSendRefill(run, txBytes, args, facts));
  }
}

async function stageRefill(run: Run): Promise<void> {
  const { state, wallets, chain, tatum } = run;
  const allowanceId = state.issue?.status === 'issued' ? state.issue.allowanceId : null;
  if (allowanceId === null) throw new Stop('No issued allowance is recorded, so there is nothing to refill from.');
  await resolveSentRefills(run);

  const purse = (await tatum.read(() => chain.getBalances(wallets.purseAddress))).usdcAddressBalance;
  run.purseUsdc = purse;
  const now = Date.now();
  const counted = state.refills.filter((entry) => entry.status !== 'failed');
  const refillsInWindow = counted.filter((entry) => now - entry.sentAtMs < DAY_MS).length;
  const decision = refillDecision({ purseUsdcAtomic: purse, refillsInWindow });
  if (!decision.refill) {
    console.log(
      `  No refill: the purse holds ${usdc(purse)} (refills only below ${usdc(BigInt(LIMITS.purseRefillBelowAtomic))}), ` +
        `${refillsInWindow} of ${LIMITS.purseMaxRefillsPerDay} refills used in the last 24 hours`,
    );
    return;
  }
  const outflow = counted.reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n) + decision.amountAtomic;
  if (outflow > MAX_OWNER_OUTFLOW_ATOMIC) {
    throw new Stop(`A refill would take ${usdc(outflow)} from the owner in this order, over the ${usdc(MAX_OWNER_OUTFLOW_ATOMIC)} ceiling. Stopping.`);
  }

  const allowance = await tatum.read(() => chain.getAllowance(allowanceId));
  const notOurs = allowanceNotOurs(allowance, wallets);
  if (notOurs !== null) throw new Stop(`C7 refused the allowance at refill time: ${notOurs}. Nothing was sent.`);
  if (allowance.lifetimeCap !== null && allowance.lifetimeCap - allowance.spentTotal < decision.amountAtomic) {
    throw new Stop('The allowance has less left than one refill. Nothing was sent.');
  }
  if (allowance.expirationMs !== null && allowance.expirationMs <= BigInt(now + FACTS_MAX_AGE_MS)) {
    throw new Stop('The allowance expires within minutes. Nothing was sent.');
  }
  console.log(`  C7 ok at refill time: allowance ${allowanceId} is the owner's, for this purse, in USDC; ${usdc(allowance.spentTotal)} spent so far`);

  const args = refillArgsFor(run, allowanceId, decision.amountAtomic);
  const facts: RefillFacts = { ...(await currentFacts(run)), allowanceInitialSharedVersion: allowance.initialSharedVersion };
  const txBytes = await buildRefill(args, facts);
  await assertRefill(txBytes, args, facts);
  console.log(`  assertRefill ok: one allowance spend of ${usdc(decision.amountAtomic)} to the purse, gas wallet as sponsor`);
  await dryRun(run, 'refill', txBytes, refillChanges(wallets, decision.amountAtomic));

  const record: State['refills'][number] = {
    status: 'sending',
    digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
    allowanceId,
    amountAtomic: String(decision.amountAtomic),
    facts: factsRecord(facts),
    initialSharedVersion: String(facts.allowanceInitialSharedVersion),
    gasMist: null,
    sentAtMs: Date.now(),
  };
  state.refills.push(record);
  saveState(state);
  await recordRefillResult(run, record, await signAndSendRefill(run, txBytes, args, facts));

  const expected = purse + decision.amountAtomic;
  const after = await afterWrite(run, async () => {
    const balance = (await chain.getBalances(wallets.purseAddress)).usdcAddressBalance;
    return balance >= expected ? balance : null;
  });
  if (after === null) throw new Stop(`The purse balance does not show the refill yet. Run again in a minute.`);
  run.purseUsdc = after;
  console.log(`  purse USDC address balance now ${usdc(after)}`);
}

/** Seller text, printed as inert text: secrets removed first, then every control or format character blanked, then cut. */
function inertExcerpt(body: string, secrets: string[]): string {
  let text = body;
  for (const secret of secrets) if (secret.length > 0) text = text.replaceAll(secret, '[redacted]');
  return Array.from(text)
    .slice(0, BODY_EXCERPT_CHARS)
    .map((char) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ? ' ' : char))
    .join('');
}

const isOpen = (record: PaymentRecord) => record.status === 'signed' || record.status === 'sent' || record.status === 'unsettled';
const sumAtomic = (records: PaymentRecord[]) => records.reduce((sum, record) => sum + BigInt(record.amountAtomic), 0n);

/**
 * The canonical payment a stored record was signed from, rebuilt from what the record keeps.
 * verifySettlement reads only the recipient, amount, asset and network, and signPayment signs
 * nothing but Sui Mainnet USDC in the t2000 dialect, so those hold for every record. The
 * signing time stands in for the expiry and the challenge id is left empty, so the rebuilt
 * payment could never be signed again.
 */
function storedPayment(record: PaymentRecord): CanonicalPayment {
  return {
    dialect: 'x402-v1-t2000',
    sellerUrl: record.sellerUrl,
    sellerHost: new URL(record.sellerUrl).hostname,
    recipient: record.recipient,
    amount: BigInt(record.amountAtomic),
    asset: USDC_TYPE_MAINNET,
    network: 'sui:mainnet',
    expiresAtMs: record.signedAtMs,
    challengeId: null,
    nonce: null,
    minEpoch: null,
    maxEpoch: BigInt(record.maxEpoch),
    resource: null,
  };
}

/** The settled transaction by the digest Ellai computed, or null while the chain does not have it. */
async function readSettlement(run: Run, digest: string): Promise<TransactionResult | null> {
  try {
    return await run.tatum.read(() => run.chain.getTransactionResult(digest));
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** C8 through verifySettlement. A payment that landed and is not exactly the approved one stops the run. */
function recordVerdict(run: Run, record: PaymentRecord, result: TransactionResult, payment: CanonicalPayment): void {
  const { wallets, state } = run;
  const verdict = verifySettlement(result, payment, wallets.purseAddress);
  record.status = verdict.verified ? 'verified' : 'mismatch';
  record.verdict = verdict.verified ? null : verdict.reason;
  saveState(state);
  if (!verdict.verified) throw new Stop(`NOT VERIFIED: ${verdict.reason}. Digest ${record.digest}  ${txLink(record.digest)}`);
  // After the check passed, these are the one debit and the one credit it found.
  const change = (address: string) =>
    result.balanceChanges.find((entry) => entry.address === address && entry.coinType === USDC_TYPE_MAINNET)?.amount ?? 0n;
  const credit = change(record.recipient);
  console.log(`  VERIFIED by verifySettlement, read through Tatum by the digest Ellai computed: ${record.digest}`);
  console.log(`    purse     ${wallets.purseAddress}  ${usdc(change(wallets.purseAddress))}`);
  console.log(`    recipient ${record.recipient}  ${credit > 0n ? '+' : ''}${usdc(credit)}`);
  console.log(`    no other USDC change; ${txLink(record.digest)}`);
}

/**
 * C4: every payment still open is read again by its digest. One that landed is verified.
 * One that has not keeps counting while the chain's epoch is at or before its maxEpoch. Past
 * it, the payment is released only if LIMITS.paymentReleaseReads further reads, all taken
 * after the epoch read, still do not find it.
 */
async function recheckOpenPayments(run: Run): Promise<void> {
  let epoch: bigint | null = null;
  for (const record of run.state.payments.filter(isOpen)) {
    const label = `${record.digest} (${record.order}, ${usdc(BigInt(record.amountAtomic))} to ${new URL(record.sellerUrl).hostname})`;
    const landed = await readSettlement(run, record.digest);
    if (landed !== null) {
      console.log(`  ${label}: landed since it was last read`);
      recordVerdict(run, record, landed, storedPayment(record));
      continue;
    }
    epoch ??= await run.tatum.read(() => run.chain.getCurrentEpoch());
    const maxEpoch = BigInt(record.maxEpoch);
    if (epoch <= maxEpoch) {
      record.status = 'unsettled';
      saveState(run.state);
      console.log(`  ${label}: not on chain. It can still land until epoch ${maxEpoch} ends and the chain is in epoch ${epoch}, so it still counts.`);
      continue;
    }
    let late: TransactionResult | null = null;
    for (let read = 0; read < LIMITS.paymentReleaseReads && late === null; read++) {
      await sleep(LIMITS.settlementPollIntervalMs);
      late = await readSettlement(run, record.digest);
    }
    if (late !== null) {
      console.log(`  ${label}: landed at the end of its window`);
      recordVerdict(run, record, late, storedPayment(record));
      continue;
    }
    record.status = 'released';
    record.verdict = `never landed; window closed after epoch ${maxEpoch}, released in epoch ${epoch}`;
    saveState(run.state);
    console.log(`  ${label}: released. Its window closed after epoch ${maxEpoch} and the chain shows it never landed.`);
  }
}

/** The seller's documented request: its method, its content type and body when it has one, then any extra headers. */
function sellerRequest(seller: Seller, extraHeaders: Record<string, string>, timeoutMs?: number): SafeRequest {
  return {
    method: seller.method,
    headers: { ...(seller.contentType === undefined ? {} : { 'content-type': seller.contentType }), ...extraHeaders },
    ...(seller.body === undefined ? {} : { body: seller.body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

const sellerLabel = (seller: Seller) => {
  const { hostname, pathname } = new URL(seller.url);
  return `${seller.method} ${hostname}${pathname}`;
};

/**
 * Hosts whose paid route answered one of Ellai's payments with anything but success while that
 * payment can still land. Their route failed after taking a valid header, so they are not paid
 * again until those payments are released. A request Ellai itself cut short puts no host here.
 * Hosts on both sides come from the same URL parser.
 */
function hostsThatFailedPaidCalls(state: State): Set<string> {
  const failed = state.payments.filter(
    (record) => isOpen(record) && record.sellerStatus !== null && (record.sellerStatus < 200 || record.sellerStatus >= 300),
  );
  return new Set(failed.map((record) => new URL(record.sellerUrl).hostname));
}

/** The first seller, in KNOWN_SELLERS order, whose unpaid documented request answers a 402 that parses to 0.01 USDC. */
async function findSeller(run: Run): Promise<{ seller: Seller; payment: CanonicalPayment } | null> {
  const failedHosts = hostsThatFailedPaidCalls(run.state);
  for (const seller of KNOWN_SELLERS) {
    if (failedHosts.has(new URL(seller.url).hostname)) {
      console.log(`  ${sellerLabel(seller)}: skipped, this host answered a paid call from Ellai with an error and that payment can still land`);
      continue;
    }
    // Reserved before the challenge is fetched, so a pacing wait never eats its validity window.
    await run.tatum.reserve(2);
    try {
      // Unpaid, so the default timeout: a 402 comes back before the seller does any work.
      const response = await safeFetch(seller.url, sellerRequest(seller, {}));
      const payment = parseChallenge(response, Date.now());
      if (payment.amount !== SELLER_PRICE_ATOMIC) {
        console.log(`  unpaid ${sellerLabel(seller)}: asks ${usdc(payment.amount)}, not ${usdc(SELLER_PRICE_ATOMIC)}; next seller`);
        continue;
      }
      console.log(`  unpaid ${sellerLabel(seller)}, ${seller.contentType ?? 'no'} body: HTTP ${response.status}, ${usdc(payment.amount)} to ${payment.recipient}`);
      console.log(`    ${seller.note}`);
      return { seller, payment };
    } catch (error) {
      const label = error instanceof NetError || error instanceof ChallengeError ? error.code : 'UNEXPECTED';
      console.log(`  unpaid ${sellerLabel(seller)}: refused (${label}); next seller`);
    }
  }
  return null;
}

async function stagePayment(run: Run): Promise<void> {
  const { state, wallets, chain } = run;
  await recheckOpenPayments(run);
  const mismatched = state.payments.find((entry) => entry.status === 'mismatch');
  if (mismatched) {
    throw new Stop(`Payment ${mismatched.digest} landed but did not verify (${mismatched.verdict}). No more payments until a person reviews it.`);
  }
  const ours = state.payments.filter((entry) => entry.order === THIS_ORDER);
  const settled = ours.find((entry) => entry.status === 'verified');
  if (settled) {
    console.log(`  This order's one new payment is settled and verified, nothing sent: ${settled.digest}  ${txLink(settled.digest)}`);
    return;
  }

  // Everything signed counts, settled or not, because signed bytes can still land.
  const newSigned = sumAtomic(ours) + SELLER_PRICE_ATOMIC;
  if (newSigned > MAX_NEW_SIGNED_ATOMIC) {
    throw new Stop(`Another payment would bring this order's signed total to ${usdc(newSigned)}, over the ${usdc(MAX_NEW_SIGNED_ATOMIC)} ceiling. Stopping.`);
  }
  const counted = sumAtomic(state.payments.filter((entry) => entry.status !== 'released')) + SELLER_PRICE_ATOMIC;
  if (counted > MAX_SELLER_COUNTED_ATOMIC) {
    throw new Stop(`Another payment would bring sellers' unreleased total to ${usdc(counted)}, over the ${usdc(MAX_SELLER_COUNTED_ATOMIC)} ceiling. Stopping.`);
  }
  console.log(
    `  Ceilings hold with one more payment: ${usdc(newSigned)} of ${usdc(MAX_NEW_SIGNED_ATOMIC)} newly signed in this order, ` +
      `${usdc(counted)} of ${usdc(MAX_SELLER_COUNTED_ATOMIC)} signed and not released`,
  );
  if (run.purseUsdc === null || run.purseUsdc < SELLER_PRICE_ATOMIC) {
    throw new Stop(`The purse holds ${run.purseUsdc === null ? 'an unknown amount' : usdc(run.purseUsdc)}, less than one payment. Nothing was paid.`);
  }

  const found = await findSeller(run);
  if (found === null) throw new Stop('No known seller answered its documented request with a 0.01 USDC challenge. Nothing was paid.');
  const { seller, payment } = found;
  if (payment.maxEpoch === null) throw new Stop('The challenge carries no epoch window. Nothing was signed.');

  // Both requests below use the two slots findSeller reserved before fetching the challenge.
  const epoch = await chain.getCurrentEpoch();
  const signed = await signPayment(payment, wallets.purse, Date.now(), epoch);
  console.log(`  signed from the purse; digest ${signed.digest} (computed from the signed bytes), valid until epoch ${payment.maxEpoch} ends`);
  await dryRun(
    run,
    'payment',
    fromBase64(signed.txBytesBase64),
    [
      { address: wallets.purseAddress, coinType: USDC_TYPE_MAINNET, amount: -payment.amount },
      { address: payment.recipient, coinType: USDC_TYPE_MAINNET, amount: payment.amount },
    ],
    true,
  );
  const record: PaymentRecord = {
    status: 'signed',
    order: THIS_ORDER,
    digest: signed.digest,
    sellerUrl: payment.sellerUrl,
    recipient: payment.recipient,
    amountAtomic: String(payment.amount),
    maxEpoch: String(payment.maxEpoch),
    sellerStatus: null,
    verdict: null,
    signedAtMs: Date.now(),
  };
  state.payments.push(record);
  saveState(state);

  const header = paymentHeader(payment, signed);
  let bodyText = '';
  let failure = '';
  console.log(`  paid ${sellerLabel(seller)}, same body and content type plus the payment header, waiting up to ${seller.paidTimeoutMs / 1_000} s`);
  try {
    const response = await safeFetch(seller.url, sellerRequest(seller, { [header.name]: header.value }, seller.paidTimeoutMs));
    record.sellerStatus = response.status;
    bodyText = response.bodyText;
  } catch (error) {
    failure = error instanceof NetError ? error.code : 'UNEXPECTED';
  }
  record.status = 'sent';
  saveState(state);
  if (record.sellerStatus === null) {
    console.log(`  the paid request failed (${failure}); checking the chain anyway`);
  } else {
    console.log(`  seller answered HTTP ${record.sellerStatus}`);
    console.log(`  answer, first ${BODY_EXCERPT_CHARS} characters as plain text: ${inertExcerpt(bodyText, [header.value, signed.signature, signed.txBytesBase64])}`);
  }
  const answeredOk = record.sellerStatus !== null && record.sellerStatus >= 200 && record.sellerStatus < 300;

  // recordVerdict stops the run on a mismatch, so landing here means verified.
  let verified = false;
  for (let attempt = 0; attempt < LIMITS.settlementPollTries && !verified; attempt++) {
    await sleep(LIMITS.settlementPollIntervalMs);
    const result = await readSettlement(run, record.digest);
    if (result !== null) {
      recordVerdict(run, record, result, payment);
      verified = true;
    }
  }
  if (!verified) {
    record.status = 'unsettled';
    record.verdict = `seller answered ${record.sellerStatus ?? 'nothing'}; not on chain when last read`;
    saveState(state);
  }
  if (!answeredOk && verified) {
    throw new Stop(`Payment ${record.digest} settled and verified, but the seller answered ${record.sellerStatus ?? failure}, not success. Stopping.`);
  }
  if (!answeredOk) {
    throw new Stop(
      `The seller did not answer with success (${record.sellerStatus ?? failure}) and payment ${record.digest} is not on chain. ` +
        `No other seller is tried until the chain shows it never landed after epoch ${record.maxEpoch}.`,
    );
  }
  if (!verified) {
    throw new Stop(
      `Payment ${record.digest} is not on chain after ${LIMITS.settlementPollTries} reads. It is never sent again and keeps counting ` +
        `until its window closes after epoch ${record.maxEpoch} and the chain shows it never landed.`,
    );
  }
}

function parseFlags(argv: string[]): { until: number } {
  let until = 5;
  for (const flag of argv) {
    const match = /^--until=([1-5])$/.exec(flag);
    if (match?.[1]) until = Number(match[1]);
    else throw new Stop('Unknown flag. Use --until=N (1 to 5).');
  }
  return { until };
}

async function main(): Promise<void> {
  const { until } = parseFlags(process.argv.slice(2));
  const owner = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY);
  const gas = Ed25519Keypair.fromSecretKey(config.GAS_PRIVATE_KEY);
  const ownerAddress = canonicalSuiAddress(owner.toSuiAddress());
  const purse = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress);
  const wallets: Wallets = {
    owner,
    purse,
    gas,
    ownerAddress,
    purseAddress: canonicalSuiAddress(purse.toSuiAddress()),
    gasAddress: canonicalSuiAddress(gas.toSuiAddress()),
  };
  const state = loadState(wallets.ownerAddress, wallets.purseAddress, wallets.gasAddress);
  const anonymous = !config.TATUM_API_KEY;
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const run: Run = { chain, tatum: new Tatum(anonymous), wallets, state, facts: null, purseUsdc: null };

  console.log('Ellai money path on Sui Mainnet, real USDC, small and capped.');
  console.log(`Tatum API key used: ${anonymous ? `no (anonymous, paced to ${LIMITS.tatumAnonymousRequestsPerMinute} a minute)` : 'yes'}`);
  const stages: Array<[string, () => Promise<void>]> = [
    ['1. Balances', () => printBalances(run)],
    ['2. Allowance from the owner to the purse', () => stageAllowance(run)],
    ['3. Sponsored refill', () => stageRefill(run)],
    ['4. One paid call to a live seller', () => stagePayment(run)],
    ['5. Final balances', () => printBalances(run)],
  ];
  try {
    for (const [index, [title, stage]] of stages.entries()) {
      if (index + 1 > until) {
        console.log(`\nStopping after stage ${until}, as asked.`);
        break;
      }
      console.log(`\n${title}`);
      await stage();
    }
  } finally {
    chain.close();
    const outflow = state.refills.filter((entry) => entry.status === 'landed').reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n);
    const paid = sumAtomic(state.payments.filter((entry) => entry.status === 'verified'));
    const newSigned = sumAtomic(state.payments.filter((entry) => entry.order === THIS_ORDER));
    const counted = sumAtomic(state.payments.filter((entry) => entry.status !== 'released'));
    const ownerGas = BigInt(state.issue?.gasMist ?? '0');
    const sponsorGas = state.refills.reduce((sum, entry) => sum + BigInt(entry.gasMist ?? '0'), 0n);
    console.log(`\nSo far: ${usdc(outflow)} left the owner (ceiling ${usdc(MAX_OWNER_OUTFLOW_ATOMIC)}); ${usdc(paid)} paid to sellers and verified.`);
    console.log(
      `Sellers: ${usdc(newSigned)} newly signed in ${THIS_ORDER} (ceiling ${usdc(MAX_NEW_SIGNED_ATOMIC)}), ` +
        `${usdc(counted)} signed and not released across both orders (ceiling ${usdc(MAX_SELLER_COUNTED_ATOMIC)}).`,
    );
    console.log(`Gas so far: owner ${sui(ownerGas)}, gas wallet ${sui(sponsorGas)}.`);
  }
}

main().catch((error: unknown) => {
  // Every message below is built from fixed text, codes, digests, addresses and amounts.
  if (error instanceof Stop) console.error(`\nSTOPPED: ${error.message}`);
  else if (error instanceof ChainError || error instanceof AllowanceError || error instanceof PaymentError) {
    console.error(`\nSTOPPED: ${error.name} ${error.code}: ${error.message}`);
  } else if (error instanceof ChallengeError || error instanceof NetError) console.error(`\nSTOPPED: ${error.name} ${error.code}`);
  else console.error(`\nSTOPPED: ${error instanceof Error ? error.message : 'unexpected failure'}`);
  process.exitCode = 1;
});
