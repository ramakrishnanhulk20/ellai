// Moves real USDC on Sui Mainnet, small and capped, to prove Ellai's money path end to end:
//   1. balances of the test owner, its purse and the gas wallet, read through Tatum
//   2. the owner issues a native allowance to the purse (1.00 USDC in total, 0.50 per 24 hours,
//      30 days), read back from chain and checked: funder is the owner, spender the purse, coin USDC
//   3. if refillDecision says so, the purse pulls one 0.10 USDC refill through the allowance,
//      the gas wallet sponsoring the gas, after assertRefill passes
//   4. the purse pays one live third-party seller 0.01 USDC with a gasless send, and the payment
//      is verified on chain from the digest Ellai computed itself (C8)
//   5. the final balances
// Every stage is idempotent through scratchpad/slice-state-pay.json, written before anything
// is sent and updated after, so a re-run never issues, refills or pays twice. At most 0.20 USDC
// may leave the owner and at most 0.02 USDC may go to sellers; any stage that would pass
// either stops the run. Every transaction is dry-run first and must move exactly the money
// expected; a real transaction that moves anything else stops the run on the spot.
// Prints digests, addresses, amounts and links. Never prints a key, a signature, signed
// bytes or the X-PAYMENT value, and seller text is printed as inert, length-capped text.
// Flags: --until=N stops after stage N; --again allows one more seller payment.
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
} from '../src/chain.js';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '../src/challenge.js';
import { config } from '../src/config.js';
import { canonicalSuiAddress, derivePurseKeypair } from '../src/keys.js';
import { LIMITS } from '../src/limits.js';
import { NetError, safeFetch } from '../src/net.js';
import { PaymentError, paymentHeader, signPayment } from '../src/payment.js';
import { KNOWN_SELLERS } from '../src/sellers.js';
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
// Ceilings for this order alone, on top of the allowance's own caps.
const MAX_OWNER_OUTFLOW_ATOMIC = 200_000n;
const MAX_SELLER_PAID_ATOMIC = 20_000n;
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
  version: z.literal(1),
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
        status: z.enum(['signed', 'sent', 'verified', 'mismatch', 'unsettled']),
        digest: digestText,
        sellerUrl: z.string().max(LIMITS.resourceMaxLength),
        recipient: addressText,
        amountAtomic: uintText,
        sellerStatus: z.number().int().nullable(),
        verdict: z.string().max(300).nullable(),
        signedAtMs: z.number().int().nonnegative(),
      }),
    )
    .max(50),
});
type State = z.infer<typeof stateSchema>;
type FactsRecord = z.infer<typeof factsSchema>;

function loadState(owner: string, purse: string, gasWallet: string): State {
  if (!existsSync(STATE_FILE)) return { version: 1, owner, purse, gasWallet, issue: null, refills: [], payments: [] };
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
  again: boolean;
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

/**
 * C8: verified only from the digest Ellai computed from the bytes it signed, a success, and
 * exactly two USDC changes: minus the canonical amount at the purse, plus it at the canonical
 * recipient. Addresses and coin types on both sides come out of the SDK normalisers.
 */
function settlementMismatch(
  changes: BalanceChange[],
  status: 'success' | 'failure',
  purse: string,
  expected: { recipient: string; amount: bigint },
): string | null {
  if (status !== 'success') return 'the transaction failed on chain';
  const usdcChanges = changes.filter((change) => change.coinType === USDC_TYPE_MAINNET);
  const debits = usdcChanges.filter((change) => change.address === purse);
  const credits = usdcChanges.filter((change) => change.address === expected.recipient);
  if (debits.length !== 1 || debits[0]?.amount !== -expected.amount) return `the purse's USDC change is not -${usdc(expected.amount)}`;
  if (credits.length !== 1 || credits[0]?.amount !== expected.amount) return `the recipient's USDC change is not +${usdc(expected.amount)}`;
  if (usdcChanges.length !== 2) return 'another address had a USDC change';
  return null;
}

/**
 * Reads the settlement of a recorded payment, at most `tries` times, and records the verdict.
 * The record holds the canonical recipient and amount. A mismatch always stops the run. A
 * payment still not on chain is recorded as unsettled; it stops the run only when stopIfUnsettled.
 */
async function verifyPayment(run: Run, record: State['payments'][number], tries: number, stopIfUnsettled: boolean): Promise<void> {
  const { chain, tatum, wallets, state } = run;
  const expected = { recipient: record.recipient, amount: BigInt(record.amountAtomic) };
  for (let attempt = 0; attempt < tries; attempt++) {
    await sleep(LIMITS.settlementPollIntervalMs);
    let result;
    try {
      result = await tatum.read(() => chain.getTransactionResult(record.digest));
    } catch (error) {
      if (error instanceof ChainError && error.code === 'NOT_FOUND') continue;
      throw error;
    }
    const mismatch = settlementMismatch(result.balanceChanges, result.status, wallets.purseAddress, expected);
    record.status = mismatch === null ? 'verified' : 'mismatch';
    record.verdict = mismatch;
    saveState(state);
    if (mismatch !== null) throw new Stop(`NOT VERIFIED: ${mismatch}. Digest ${record.digest}  ${txLink(record.digest)}`);
    console.log(`  VERIFIED on chain through Tatum, digest computed by Ellai: ${record.digest}`);
    console.log(`    purse     ${wallets.purseAddress}  -${usdc(expected.amount)}`);
    console.log(`    recipient ${record.recipient}  +${usdc(expected.amount)}`);
    console.log(`    no other USDC change; ${txLink(record.digest)}`);
    return;
  }
  record.status = 'unsettled';
  record.verdict = `seller answered ${record.sellerStatus ?? 'nothing'}; not on chain when last read`;
  saveState(state);
  const message = `Payment ${record.digest} is not on chain after ${tries} read(s). It is never sent again, and it still counts against the seller ceiling.`;
  if (stopIfUnsettled) throw new Stop(message);
  console.log(`  ${message}`);
}

async function findSeller(
  run: Run,
  skipHosts: ReadonlySet<string>,
): Promise<{ seller: (typeof KNOWN_SELLERS)[number]; payment: CanonicalPayment } | null> {
  for (const seller of KNOWN_SELLERS) {
    const { hostname, pathname } = new URL(seller.url);
    if (skipHosts.has(hostname)) {
      console.log(`  ${seller.method} ${hostname}${pathname}: skipped, this host took a payment header in this order without a verified settlement`);
      continue;
    }
    // Reserved before the challenge is fetched, so a pacing wait never eats its validity window.
    await run.tatum.reserve(2);
    try {
      const response = await safeFetch(seller.url, {
        method: seller.method,
        ...(seller.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: seller.body }),
      });
      const payment = parseChallenge(response, Date.now());
      if (payment.amount !== SELLER_PRICE_ATOMIC) {
        console.log(`  ${seller.method} ${hostname}${pathname}: asks ${usdc(payment.amount)}, not ${usdc(SELLER_PRICE_ATOMIC)}; next seller`);
        continue;
      }
      console.log(`  ${seller.method} ${hostname}${pathname}: 402 for ${usdc(payment.amount)} to ${payment.recipient}`);
      return { seller, payment };
    } catch (error) {
      const label = error instanceof NetError || error instanceof ChallengeError ? error.code : 'UNEXPECTED';
      console.log(`  ${seller.method} ${hostname}${pathname}: refused (${label}); next seller`);
    }
  }
  return null;
}

async function stagePayment(run: Run): Promise<void> {
  const { state, wallets, chain } = run;
  for (const record of state.payments.filter((entry) => entry.status === 'signed' || entry.status === 'sent' || entry.status === 'unsettled')) {
    console.log(`  Checking the payment an earlier run signed: ${record.digest} (it is never sent again)`);
    // One read for a payment already polled to its limit; the full poll for one a run never finished.
    await verifyPayment(run, record, record.status === 'unsettled' ? 1 : LIMITS.settlementPollTries, false);
  }
  const mismatched = state.payments.find((entry) => entry.status === 'mismatch');
  if (mismatched) {
    throw new Stop(`Payment ${mismatched.digest} settled but did not verify (${mismatched.verdict}). No more payments until a person reviews it.`);
  }
  const verified = state.payments.find((entry) => entry.status === 'verified');
  const unverified = state.payments.find((entry) => entry.status === 'unsettled');
  if (verified && !run.again) {
    console.log(`  Already paid and verified, nothing sent: ${verified.digest}  ${txLink(verified.digest)}`);
    console.log('  (pass --again to pay one more 0.01 USDC)');
    return;
  }
  // C8: a payment whose check could not finish pauses paying until a person has looked and passes --again.
  if (unverified && !run.again) {
    console.log(`  Payments paused: ${unverified.digest} could not be verified (${unverified.verdict}).`);
    console.log('  Nothing sent. After reviewing it, pass --again to pay one more 0.01 USDC.');
    return;
  }
  // Everything signed counts, settled or not, because signed bytes can still land.
  const signedTotal = state.payments.reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n) + SELLER_PRICE_ATOMIC;
  if (signedTotal > MAX_SELLER_PAID_ATOMIC) {
    throw new Stop(`Another payment would bring sellers to ${usdc(signedTotal)}, over the ${usdc(MAX_SELLER_PAID_ATOMIC)} ceiling. Stopping.`);
  }
  if (run.purseUsdc === null || run.purseUsdc < SELLER_PRICE_ATOMIC) {
    throw new Stop(`The purse holds ${run.purseUsdc === null ? 'an unknown amount' : usdc(run.purseUsdc)}, less than one payment. Nothing was paid.`);
  }

  const failedHosts = new Set(state.payments.filter((entry) => entry.status !== 'verified').map((entry) => new URL(entry.sellerUrl).hostname));
  const found = await findSeller(run, failedHosts);
  if (found === null) throw new Stop('No known seller answered a 0.01 USDC challenge. Nothing was paid.');
  const { seller, payment } = found;

  // Both requests below use the two slots findSeller reserved before fetching the challenge.
  const epoch = await chain.getCurrentEpoch();
  const signed = await signPayment(payment, wallets.purse, Date.now(), epoch);
  console.log(`  signed from the purse; digest ${signed.digest} (computed from the signed bytes)`);
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
  const record: State['payments'][number] = {
    status: 'signed',
    digest: signed.digest,
    sellerUrl: payment.sellerUrl,
    recipient: payment.recipient,
    amountAtomic: String(payment.amount),
    sellerStatus: null,
    verdict: null,
    signedAtMs: Date.now(),
  };
  state.payments.push(record);
  saveState(state);

  const header = paymentHeader(payment, signed);
  let bodyText = '';
  try {
    const response = await safeFetch(seller.url, {
      method: seller.method,
      headers: { ...(seller.body === undefined ? {} : { 'content-type': 'application/json' }), [header.name]: header.value },
      ...(seller.body === undefined ? {} : { body: seller.body }),
    });
    record.sellerStatus = response.status;
    bodyText = response.bodyText;
  } catch (error) {
    console.log(`  the paid request failed (${error instanceof NetError ? error.code : 'UNEXPECTED'}); checking the chain anyway`);
  }
  record.status = 'sent';
  saveState(state);
  if (record.sellerStatus !== null) {
    console.log(`  seller answered HTTP ${record.sellerStatus}`);
    console.log(`  body, first ${BODY_EXCERPT_CHARS} characters as plain text: ${inertExcerpt(bodyText, [header.value, signed.signature, signed.txBytesBase64])}`);
  }
  await verifyPayment(run, record, LIMITS.settlementPollTries, true);
}

function parseFlags(argv: string[]): { until: number; again: boolean } {
  let until = 5;
  let again = false;
  for (const flag of argv) {
    const match = /^--until=([1-5])$/.exec(flag);
    if (match?.[1]) until = Number(match[1]);
    else if (flag === '--again') again = true;
    else throw new Stop('Unknown flag. Use --until=N (1 to 5) and --again.');
  }
  return { until, again };
}

async function main(): Promise<void> {
  const { until, again } = parseFlags(process.argv.slice(2));
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
  const run: Run = { chain, tatum: new Tatum(anonymous), wallets, state, again, facts: null, purseUsdc: null };

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
    const paid = state.payments.filter((entry) => entry.status === 'verified').reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n);
    const ownerGas = BigInt(state.issue?.gasMist ?? '0');
    const sponsorGas = state.refills.reduce((sum, entry) => sum + BigInt(entry.gasMist ?? '0'), 0n);
    console.log(`\nIn this order so far: ${usdc(outflow)} left the owner (ceiling ${usdc(MAX_OWNER_OUTFLOW_ATOMIC)}), ${usdc(paid)} paid to sellers and verified (ceiling ${usdc(MAX_SELLER_PAID_ATOMIC)}).`);
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
