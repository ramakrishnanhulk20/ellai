// Proves on Sui Mainnet that an owner ends their allowance with one signature and that Sui then
// no longer has it, with no USDC moving:
//   1. the test owner's balances, read through Tatum
//   2. the owner issues a fresh allowance to its own purse (0.01 USDC in total, 0.01 USDC a day,
//      one day), dry-run first, signed with the test owner key and sent through Tatum
//   3. the allowance is read back through Tatum (getAllowance) and its cap found
//      (findAllowanceCap), the cap held to the one the issue itself created
//   4. the revoke is built (buildRevokeAllowance), checked (assertRevokeAllowance), dry-run,
//      signed with the test owner key and sent through Tatum; its gas is read from its effects
//   5. getAllowance on the id answers NOT_FOUND, and the owner's cap for it is gone; then
//      objectExists (gRPC) answers false for an allowance an earlier revoke deleted and true for
//      the test owner's live one
// Neither transaction may change any USDC balance; one that does stops the run.
// Every stage is idempotent through scratchpad/slice-state-end.json, written before anything is
// sent and updated after, so a run that stopped part way resumes with the same allowance and never
// leaves a second one behind. A run after a finished one proves a fresh cycle.
// Prints digests, addresses, amounts and links. Never prints a key, a signature or signed bytes.
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { GrpcTypes } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeStructTag, SUI_DECIMALS, SUI_TYPE_ARG } from '@mysten/sui/utils';
import { z } from 'zod';
import {
  AllowanceError,
  assertRevokeAllowance,
  buildIssueAllowance,
  buildRevokeAllowance,
  type ChainFacts,
  type IssueArgs,
  type RevokeArgs,
} from '@ellai/core/allowance';
import { type BalanceChange, type Chain, ChainError, classifyChainError, createChain, type ExecutionResult } from '@ellai/core/chain';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { USDC_DECIMALS, USDC_TYPE_MAINNET } from '@ellai/core/usdc';
import { config } from '../src/config.js';

const STATE_FILE = new URL('../../../scratchpad/slice-state-end.json', import.meta.url);
const SUISCAN = 'https://suiscan.xyz/mainnet';
const SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);
const ALLOWANCE_OBJECT_TYPE = normalizeStructTag(`0x2::allowance::Allowance<0x2::balance::Balance<${USDC_TYPE_MAINNET}>>`);
const ALLOWANCE_CAP_TYPE = normalizeStructTag(`0x2::allowance::AllowanceCap<0x2::balance::Balance<${USDC_TYPE_MAINNET}>>`);
const { SimulateTransactionRequest_TransactionChecks: SimulationChecks } = GrpcTypes;

const DAY_MS = 86_400_000;
// The smallest allowance worth proving with. Nothing is ever spent through it.
const PROOF_LIFETIME_CAP_ATOMIC = 10_000n;
const PROOF_PERIOD_LIMIT_ATOMIC = 10_000n;
const PROOF_PERIOD_MS = BigInt(DAY_MS);
// Longer than one Tatum pacing window, so a read refused for its rate is tried once more after it.
const RATE_LIMIT_WAIT_MS = 65_000;
// getAllowance and findAllowanceCap read Tatum's GraphQL index, which on 2026-10-28 stood about
// 1,400 checkpoints (several minutes) behind Tatum's own gRPC node, so their reads after a write
// wait up to ten minutes instead of LIMITS.chainReadAfterWriteTries.
const INDEX_READ_TRIES = 40;
const INDEX_READ_DELAY_MS = 15_000;
// The two answers Ellai's index-lag check (objectExists) must tell apart: an allowance a revoke
// deleted on 2026-10-28, read from that transaction's effects, and the test owner's allowance in use.
const REVOKED_ALLOWANCE = {
  id: '0x5bfefb0eaee7f21a326993506fbbd77dad767e3a4e25f8694be97a79a7b13f0a',
  revokeDigest: '242q2vg9KZUBmn3xYJ1vRazc5Dnk4GY9bX5yUsQtnU46',
};
const LIVE_ALLOWANCE = '0xd2b941082590b7d9d0a04482109670f94c290714889b67e8ef2c60ec6d9699c8';

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
const uintText = z.string().max(20).regex(/^(0|[1-9]\d*)$/);
const factsSchema = z.strictObject({ epoch: uintText, referenceGasPrice: uintText, nonce: z.number().int().min(0).max(0xffff_ffff) });

// Holds digests, ids and build facts only: nothing here can move money or sign.
const stateSchema = z.strictObject({
  version: z.literal(1),
  owner: addressText,
  purse: addressText,
  issue: z
    .strictObject({
      status: z.enum(['sending', 'issued']),
      digest: digestText,
      facts: factsSchema,
      expirationMs: uintText,
      allowanceId: addressText.nullable(),
      capId: addressText.nullable(),
    })
    .nullable(),
  revoke: z
    .strictObject({
      status: z.enum(['sending', 'ended']),
      digest: digestText,
      facts: factsSchema,
      initialSharedVersion: uintText,
      cap: z.strictObject({ objectId: addressText, version: uintText, digest: digestText }),
    })
    .nullable(),
});
type State = z.infer<typeof stateSchema>;
type FactsRecord = z.infer<typeof factsSchema>;

function freshState(owner: string, purse: string): State {
  return { version: 1, owner, purse, issue: null, revoke: null };
}

function loadState(owner: string, purse: string): State {
  if (!existsSync(STATE_FILE)) return freshState(owner, purse);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    throw new Stop('The state file is not JSON. Nothing was sent. Look at it before running again.');
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) throw new Stop('The state file has an unknown shape. Nothing was sent. Look at it before running again.');
  if (result.data.owner !== owner || result.data.purse !== purse) throw new Stop('The state file belongs to another owner than the one in .env. Nothing was sent.');
  return result.data;
}

/** Written to a side file and renamed over, so a crash mid-write never leaves half a record. */
function saveState(state: State): void {
  mkdirSync(new URL('.', STATE_FILE), { recursive: true });
  const side = new URL('./slice-state-end.json.next', STATE_FILE);
  writeFileSync(side, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(side, STATE_FILE);
}

const factsRecord = (facts: ChainFacts): FactsRecord => ({ epoch: String(facts.epoch), referenceGasPrice: String(facts.referenceGasPrice), nonce: facts.nonce });
const factsFrom = (record: FactsRecord): ChainFacts => ({ epoch: BigInt(record.epoch), referenceGasPrice: BigInt(record.referenceGasPrice), nonce: record.nonce });

interface Run {
  chain: Chain;
  owner: Ed25519Keypair;
  ownerAddress: string;
  purseAddress: string;
  state: State;
}

/** For reads and dry runs only, which are safe to repeat. Sends are never retried here. */
async function read<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ChainError) || error.code !== 'RATE_LIMITED') throw error;
    console.log(`  (Tatum rate limited; waiting ${RATE_LIMIT_WAIT_MS / 1000} s and reading again)`);
    await sleep(RATE_LIMIT_WAIT_MS);
    return run();
  }
}

/** Polls for what a landed transaction changed, while Tatum's nodes catch up: `tries` reads, `delayMs` apart. */
async function afterWrite<T>(readOnce: () => Promise<T | null>, tries: number = LIMITS.chainReadAfterWriteTries, delayMs: number = LIMITS.chainReadAfterWriteDelayMs): Promise<T | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    await sleep(delayMs);
    const value = await read(readOnce);
    if (value !== null) return value;
  }
  return null;
}

/** afterWrite for reads of Tatum's GraphQL index, which lags its gRPC node. */
const afterIndex = <T>(readOnce: () => Promise<T | null>) => afterWrite(readOnce, INDEX_READ_TRIES, INDEX_READ_DELAY_MS);

/**
 * The owner pays gas from their SUI address balance, as the setup screen's builds do when it covers
 * the budget. A test owner without enough there is told to top up rather than paid for with coins.
 */
async function addressBalanceFacts(run: Run, budgetMist: number): Promise<ChainFacts> {
  const { suiAddressBalance } = await read(() => run.chain.getWalletBalances(run.ownerAddress));
  if (suiAddressBalance < BigInt(budgetMist)) {
    throw new Stop(`The test owner's SUI address balance is ${sui(suiAddressBalance)}, under the ${sui(BigInt(budgetMist))} budget. Nothing was sent.`);
  }
  const epoch = await read(() => run.chain.getCurrentEpoch());
  const referenceGasPrice = await read(() => run.chain.getReferenceGasPrice());
  if (referenceGasPrice > BigInt(LIMITS.maxGasPriceMist)) {
    throw new Stop(`The reference gas price is ${referenceGasPrice} MIST, above the ${LIMITS.maxGasPriceMist} MIST ceiling. Nothing was sent.`);
  }
  return { epoch, referenceGasPrice, nonce: randomInt(0, 2 ** 32) };
}

/** Names the first balance change that is not the owner's own SUI gas, or null. */
function notOnlyOwnerGas(changes: BalanceChange[], ownerAddress: string): string | null {
  for (const change of changes) {
    if (change.coinType === USDC_TYPE_MAINNET) return `${change.address} USDC changed by ${change.amount}`;
    if (change.coinType !== SUI_TYPE || change.address !== ownerAddress) return `${change.address} changed by ${change.amount} of ${change.coinType}`;
  }
  return changes.length > 1 ? `${changes.length} balance changes, expected at most one` : null;
}

interface GasUsed {
  computation: bigint;
  storage: bigint;
  rebate: bigint;
}

function gasUsedOf(gas: GrpcTypes.GasCostSummary | undefined, what: string): GasUsed {
  const { computationCost, storageCost, storageRebate } = gas ?? {};
  if (computationCost === undefined || storageCost === undefined || storageRebate === undefined) throw new Stop(`The ${what} came back without its gas summary.`);
  return { computation: computationCost, storage: storageCost, rebate: storageRebate };
}

function describeGas(gas: GasUsed): string {
  const net = gas.computation + gas.storage - gas.rebate;
  return `computation ${sui(gas.computation)}, storage ${sui(gas.storage)}, rebate ${sui(gas.rebate)}; charged before the rebate ${sui(gas.computation + gas.storage)}, net ${sui(net)}`;
}

/** The dry run must succeed and change nothing but the owner's SUI, or nothing is signed or sent. Then its gas, read in one more dry run. */
async function dryRun(run: Run, what: string, txBytes: Uint8Array): Promise<GasUsed> {
  const simulation = await read(() => run.chain.simulate(txBytes));
  if (simulation.status !== 'success') throw new Stop(`The ${what} dry run failed (${simulation.errorCode}). Nothing was sent.`);
  const moved = notOnlyOwnerGas(simulation.balanceChanges, run.ownerAddress);
  if (moved !== null) throw new Stop(`The ${what} dry run moves money it should not: ${moved}. Nothing was sent.`);
  const gas = await read(async () => {
    try {
      const { response } = await run.chain.grpc.transactionExecutionService.simulateTransaction(
        { transaction: { bcs: { value: txBytes } }, readMask: { paths: ['transaction.effects.gas_used'] }, checks: SimulationChecks.ENABLED, doGasSelection: false },
        { timeout: LIMITS.tatumTimeoutMs },
      );
      return gasUsedOf(response.transaction?.effects?.gasUsed, `${what} dry run`);
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw classifyChainError(error);
    }
  });
  console.log(`  dry run ok: succeeds, no USDC moves, only the owner's SUI pays gas; ${describeGas(gas)}`);
  return gas;
}

/** The gas a landed transaction was charged, read from its own effects. */
async function landedGas(run: Run, digest: string): Promise<GasUsed | null> {
  return afterWrite(async () => {
    try {
      const { response } = await run.chain.grpc.ledgerService.getTransaction({ digest, readMask: { paths: ['digest', 'effects.gas_used'] } }, { timeout: LIMITS.tatumTimeoutMs });
      if (response.transaction?.digest !== digest) return null;
      return gasUsedOf(response.transaction.effects?.gasUsed, 'landed transaction');
    } catch (error) {
      if (error instanceof Stop) throw error;
      const failure = classifyChainError(error);
      if (failure.code === 'NOT_FOUND') return null;
      throw failure;
    }
  });
}

async function send(run: Run, txBytes: Uint8Array): Promise<ExecutionResult> {
  const { signature } = await run.owner.signTransaction(txBytes);
  try {
    return await run.chain.executeTransaction(txBytes, [signature]);
  } catch (error) {
    if (error instanceof ChainError) throw new Stop(`${error.message}. The state file keeps the digest; run again to resolve it before anything new is sent.`);
    throw error;
  }
}

function issueArgs(run: Run, expirationMs: bigint): IssueArgs {
  return {
    owner: run.ownerAddress,
    spender: run.purseAddress,
    terms: { lifetimeCapAtomic: PROOF_LIFETIME_CAP_ATOMIC, periodMs: PROOF_PERIOD_MS, periodLimitAtomic: PROOF_PERIOD_LIMIT_ATOMIC, expirationMs },
  };
}

async function stageBalances(run: Run): Promise<bigint> {
  const wallet = await read(() => run.chain.getWalletBalances(run.ownerAddress));
  console.log(`  Test owner ${run.ownerAddress}`);
  console.log(`    USDC address balance ${usdc(wallet.usdcAddressBalance)}, USDC in coins ${usdc(wallet.usdcCoinBalance)}`);
  console.log(`    SUI address balance ${sui(wallet.suiAddressBalance)}, SUI in coins ${sui(wallet.suiCoinBalance)}`);
  console.log(`  Purse ${run.purseAddress}`);
  return wallet.usdcAddressBalance + wallet.usdcCoinBalance;
}

async function stageIssue(run: Run): Promise<{ allowanceId: string; capId: string }> {
  const { state } = run;
  if (state.issue?.status === 'issued' && state.issue.allowanceId !== null && state.issue.capId !== null) {
    console.log(`  Already issued by an earlier run, nothing sent: allowance ${state.issue.allowanceId}`);
    console.log(`  issue digest ${state.issue.digest}  ${txLink(state.issue.digest)}`);
    return { allowanceId: state.issue.allowanceId, capId: state.issue.capId };
  }

  let txBytes: Uint8Array;
  if (state.issue?.status === 'sending') {
    // The same facts rebuild the same bytes, and Sui runs one digest at most once.
    txBytes = await buildIssueAllowance(issueArgs(run, BigInt(state.issue.expirationMs)), factsFrom(state.issue.facts));
    if (TransactionDataBuilder.getDigestFromBytes(txBytes) !== state.issue.digest) throw new Stop('The recorded issue does not rebuild to its digest. Nothing was sent.');
    console.log(`  Resolving the issue an earlier run sent: ${state.issue.digest}`);
  } else {
    const facts = await addressBalanceFacts(run, LIMITS.issueGasBudgetMist);
    const expirationMs = BigInt(Date.now() + DAY_MS);
    txBytes = await buildIssueAllowance(issueArgs(run, expirationMs), facts);
    console.log(`  built: ${usdc(PROOF_LIFETIME_CAP_ATOMIC)} in total, ${usdc(PROOF_PERIOD_LIMIT_ATOMIC)} a day, ending ${new Date(Number(expirationMs)).toISOString()}`);
    await dryRun(run, 'issue', txBytes);
    state.issue = {
      status: 'sending',
      digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
      facts: factsRecord(facts),
      expirationMs: String(expirationMs),
      allowanceId: null,
      capId: null,
    };
    saveState(state);
  }

  const sending = state.issue;
  if (sending === null) throw new Stop('The issue record is missing.');
  const result = await send(run, txBytes);
  if (result.status !== 'success') {
    // A transaction that ran and failed, or that the network refused, created nothing.
    state.issue = null;
    saveState(state);
    throw new Stop(`The issue did not land (${result.errorCode}). Digest ${result.digest}. No allowance exists; run again.`);
  }
  const moved = notOnlyOwnerGas(result.balanceChanges, run.ownerAddress);
  const allowances = result.createdObjects.filter((object) => object.type === ALLOWANCE_OBJECT_TYPE);
  const caps = result.createdObjects.filter((object) => object.type === ALLOWANCE_CAP_TYPE);
  const [allowance] = allowances;
  const [cap] = caps;
  if (allowances.length !== 1 || caps.length !== 1 || allowance === undefined || cap === undefined) {
    throw new Stop(`UNEXPECTED: the issue ${result.digest} created ${allowances.length} allowances and ${caps.length} caps. Stopping.`);
  }
  state.issue = { ...sending, status: 'issued', allowanceId: allowance.objectId, capId: cap.objectId };
  saveState(state);
  if (moved !== null) throw new Stop(`UNEXPECTED money movement in the issue ${result.digest}: ${moved}. Stopping.`);
  console.log(`  Issued allowance ${allowance.objectId}  ${objectLink(allowance.objectId)}`);
  console.log(`  and its cap ${cap.objectId}, sent to the owner`);
  console.log(`  issue digest ${result.digest}  ${txLink(result.digest)}`);
  return { allowanceId: allowance.objectId, capId: cap.objectId };
}

/** Reads the allowance and its cap back through Tatum, as the end_allowance build does, and holds both to what the issue made. */
async function stageReadBack(run: Run, issued: { allowanceId: string; capId: string }): Promise<RevokeArgs> {
  const allowance = await afterIndex(() =>
    run.chain.getAllowance(issued.allowanceId).catch((error: unknown) => {
      if (error instanceof ChainError && error.code === 'NOT_FOUND') return null;
      throw error;
    }),
  );
  if (allowance === null) throw new Stop(`Allowance ${issued.allowanceId} is not readable through Tatum yet. Run again in a minute.`);
  if (allowance.funder !== run.ownerAddress || allowance.spender !== run.purseAddress || allowance.coinType !== USDC_TYPE_MAINNET) {
    throw new Stop('The allowance read back is not the test owner\'s, for its purse, in USDC. Stopping.');
  }
  if (allowance.lifetimeCap !== PROOF_LIFETIME_CAP_ATOMIC || allowance.periodLimit !== PROOF_PERIOD_LIMIT_ATOMIC || allowance.periodMs !== PROOF_PERIOD_MS) {
    throw new Stop('The allowance on chain does not carry the terms that were signed. Stopping.');
  }
  console.log(`  getAllowance: funder is the test owner, spender its purse, coin USDC, ${usdc(allowance.lifetimeCap)} in total and a day, shared version ${allowance.initialSharedVersion}`);

  const cap = await afterIndex(() => run.chain.findAllowanceCap(run.ownerAddress, issued.allowanceId));
  if (cap === null) throw new Stop(`findAllowanceCap does not list a cap for ${issued.allowanceId} yet. Run again in a minute.`);
  if (cap.objectId !== issued.capId) throw new Stop(`findAllowanceCap found cap ${cap.objectId}, not the ${issued.capId} the issue created. Stopping.`);
  console.log(`  findAllowanceCap: cap ${cap.objectId} at version ${cap.version}, the one the issue created`);
  return { owner: run.ownerAddress, allowance: { objectId: issued.allowanceId, initialSharedVersion: allowance.initialSharedVersion }, cap };
}

/** `args` is null only when an earlier run sent a revoke this one resolves. */
async function stageRevoke(run: Run, allowanceId: string, args: RevokeArgs | null): Promise<void> {
  const { state } = run;
  let txBytes: Uint8Array;
  let simulated: GasUsed | null = null;
  if (state.revoke?.status === 'sending') {
    const recorded = state.revoke;
    const resumed: RevokeArgs = {
      owner: run.ownerAddress,
      allowance: { objectId: allowanceId, initialSharedVersion: BigInt(recorded.initialSharedVersion) },
      cap: { objectId: recorded.cap.objectId, version: BigInt(recorded.cap.version), digest: recorded.cap.digest },
    };
    txBytes = await buildRevokeAllowance(resumed, factsFrom(recorded.facts));
    if (TransactionDataBuilder.getDigestFromBytes(txBytes) !== recorded.digest) throw new Stop('The recorded revoke does not rebuild to its digest. Nothing was sent.');
    await assertRevokeAllowance(txBytes, resumed, factsFrom(recorded.facts));
    console.log(`  Resolving the revoke an earlier run sent: ${recorded.digest}`);
  } else {
    if (args === null) throw new Stop('The allowance and its cap were not read back, so nothing is built.');
    const facts = await addressBalanceFacts(run, LIMITS.revokeGasBudgetMist);
    txBytes = await buildRevokeAllowance(args, facts);
    await assertRevokeAllowance(txBytes, args, facts);
    console.log(`  assertRevokeAllowance ok: one 0x2::allowance::revoke of that allowance with that cap, the owner sending and paying at most ${sui(BigInt(LIMITS.revokeGasBudgetMist))}`);
    simulated = await dryRun(run, 'revoke', txBytes);
    state.revoke = {
      status: 'sending',
      digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
      facts: factsRecord(facts),
      initialSharedVersion: String(args.allowance.initialSharedVersion),
      cap: { objectId: args.cap.objectId, version: String(args.cap.version), digest: args.cap.digest },
    };
    saveState(state);
  }
  const revoke = state.revoke;
  if (revoke === null) throw new Stop('The revoke record is missing.');

  const result = await send(run, txBytes);
  if (result.status !== 'success') {
    state.revoke = null;
    saveState(state);
    throw new Stop(`The revoke did not land (${result.errorCode}). Digest ${result.digest}. The allowance still exists; run again to end it.`);
  }
  revoke.status = 'ended';
  saveState(state);
  const moved = notOnlyOwnerGas(result.balanceChanges, run.ownerAddress);
  if (moved !== null) throw new Stop(`UNEXPECTED money movement in the revoke ${result.digest}: ${moved}. Stopping.`);
  console.log(`  Revoked with one signature from the test owner`);
  console.log(`  revoke digest ${result.digest}  ${txLink(result.digest)}`);
  const landed = await landedGas(run, result.digest);
  if (simulated !== null) console.log(`  revoke gas, simulated: ${describeGas(simulated)}`);
  console.log(`  revoke gas, landed:    ${landed === null ? 'not readable yet' : describeGas(landed)}`);
  console.log(`  revoke gas budget ${sui(BigInt(LIMITS.revokeGasBudgetMist))} at a reference gas price of ${revoke.facts.referenceGasPrice} MIST`);
}

async function stageGone(run: Run, allowanceId: string): Promise<void> {
  const gone = await afterIndex(async () => {
    try {
      await run.chain.getAllowance(allowanceId);
      return null;
    } catch (error) {
      if (error instanceof ChainError && error.code === 'NOT_FOUND') return error.code;
      throw error;
    }
  });
  if (gone === null) throw new Stop(`Sui still shows allowance ${allowanceId} after the revoke landed. Run again in a minute.`);
  console.log(`  getAllowance(${allowanceId}) answers ${gone}`);
  const cap = await read(() => run.chain.findAllowanceCap(run.ownerAddress, allowanceId));
  if (cap !== null) throw new Stop(`findAllowanceCap still lists cap ${cap.objectId} for the ended allowance. Stopping.`);
  console.log('  findAllowanceCap finds no cap for it in the owner\'s wallet');
  const revokedHeld = await read(() => run.chain.objectExists(REVOKED_ALLOWANCE.id));
  const liveHeld = await read(() => run.chain.objectExists(LIVE_ALLOWANCE));
  if (revokedHeld || !liveHeld) throw new Stop(`objectExists answered ${revokedHeld} for the revoked allowance and ${liveHeld} for the live one, not false and true. Stopping.`);
  console.log(`  objectExists through gRPC: ${REVOKED_ALLOWANCE.id} (revoked in ${REVOKED_ALLOWANCE.revokeDigest}) answers false, the test owner's live allowance ${LIVE_ALLOWANCE} answers true`);
}

async function main(): Promise<void> {
  const owner = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY);
  const ownerAddress = canonicalSuiAddress(owner.toSuiAddress());
  const purseAddress = canonicalSuiAddress(derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress).toSuiAddress());
  let state = loadState(ownerAddress, purseAddress);
  if (state.revoke?.status === 'ended') {
    state = freshState(ownerAddress, purseAddress);
    saveState(state);
  }
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const run: Run = { chain, owner, ownerAddress, purseAddress, state };

  console.log('Ending an Ellai allowance on Sui Mainnet with one signature. No USDC moves.');
  console.log(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
  try {
    console.log('\n1. Balances');
    const usdcBefore = await stageBalances(run);
    console.log('\n2. A fresh allowance from the test owner to its purse');
    const issued = await stageIssue(run);
    console.log('\n3. Read back through Tatum, as the end_allowance build reads them');
    const resuming = state.revoke?.status === 'sending';
    if (resuming) console.log('  Skipped: an earlier run already sent the revoke, so it is resolved by its digest.');
    const args = resuming ? null : await stageReadBack(run, issued);
    console.log('\n4. Ended with one signature');
    await stageRevoke(run, issued.allowanceId, args);
    console.log('\n5. After the revoke');
    await stageGone(run, issued.allowanceId);
    const usdcAfter = await stageBalances(run);
    console.log(`  Neither transaction changed any USDC balance; the test owner's USDC read ${usdc(usdcBefore)} before and ${usdc(usdcAfter)} after.`);
    console.log('\nPROVEN: the allowance existed, the owner ended it with one signature, and Sui no longer has it.');
  } finally {
    chain.close();
  }
}

main().catch((error: unknown) => {
  // Every message below is built from fixed text, codes, digests, addresses and amounts.
  if (error instanceof Stop) console.error(`\nSTOPPED: ${error.message}`);
  else if (error instanceof ChainError || error instanceof AllowanceError) console.error(`\nSTOPPED: ${error.name} ${error.code}: ${error.message}`);
  else console.error(`\nSTOPPED: ${error instanceof Error ? error.message : 'unexpected failure'}`);
  process.exitCode = 1;
});
