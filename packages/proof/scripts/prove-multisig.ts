// Moves real USDC on Sui Mainnet, tiny and capped, to settle one question: if each owner's
// purse is a 1-of-2 Sui multisig (Ellai's purse key or the owner's own key), can either key
// alone make a gasless USDC send from it?
//   1. the test owner's purse key and owner key, and the multisig address they make
//   2. funding: the purse, signing alone as a plain key, sends 0.03 USDC to the multisig
//   3. send A: the multisig sends 0.01 USDC to the test owner, signed by the purse key as the only member
//   4. send B, the recovery path: the multisig sends all it has left (0.02 USDC) to the test
//      owner, signed by the owner key as the only member, and must end at 0 USDC
//   5. final balances, every digest, and the three answers
// Every send is a plain gasless send (buildInternalSend), checked by assertInternalSend just
// before a key signs it (C6), dry-run first, and read back with getTransactionResult, where it
// must move exactly the expected USDC and nothing else. Idempotent through
// scratchpad/slice-state-multisig.json, written before every send, so a re-run never sends a
// step twice and a step whose send failed is never replaced by a new transaction.
// Ceilings: at most 0.03 USDC leaves the purse; the only recipients are the multisig and the
// test owner. Anything that would pass one stops the run.
// Prints digests, addresses, amounts and links. Never prints a key, a signature or signed bytes.
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { MultiSigPublicKey } from '@mysten/sui/multisig';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { z } from 'zod';
import { type BalanceChange, type Balances, type Chain, ChainError, createChain, type TransactionResult } from '../src/chain.js';
import { config } from '../src/config.js';
import { canonicalSuiAddress, derivePurseKeypair } from '../src/keys.js';
import { LIMITS } from '../src/limits.js';
import {
  assertInternalSend,
  buildInternalSend,
  type InternalSendArgs,
  MultisigError,
  recoveryPurse,
  signAsMultisigMember,
} from '../src/multisig.js';
import { USDC_DECIMALS, USDC_TYPE_MAINNET } from '../src/usdc.js';

const STATE_FILE = new URL('../../../scratchpad/slice-state-multisig.json', import.meta.url);
const SUISCAN = 'https://suiscan.xyz/mainnet';

const FUND_ATOMIC = 30_000n;
const SEND_A_ATOMIC = 10_000n;
const SWEEP_EXPECTED_ATOMIC = FUND_ATOMIC - SEND_A_ATOMIC;
const MAX_PURSE_OUTFLOW_ATOMIC = 30_000n;
// The member order recoveryPurse fixes: Ellai's purse key first, the owner's key second.
const ELLAI_MEMBER_INDEX = 0;
const OWNER_MEMBER_INDEX = 1;

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
const signed = (atomic: bigint) => `${atomic > 0n ? '+' : ''}${usdc(atomic)}`;
const txLink = (digest: string) => `${SUISCAN}/tx/${digest}`;
const accountLink = (address: string) => `${SUISCAN}/account/${address}`;
type Usdc = Pick<Balances, 'usdcAddressBalance' | 'usdcCoinBalance'>;
const usdcTotal = (balances: Usdc) => balances.usdcAddressBalance + balances.usdcCoinBalance;

const addressText = z.string().regex(/^0x[0-9a-f]{64}$/);
const digestText = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const uintText = z.string().max(78).regex(/^(0|[1-9]\d*)$/);

const STEPS = ['fund', 'sendA', 'sendB'] as const;
type StepName = (typeof STEPS)[number];
type SignerKind = 'purse' | 'ellai-member' | 'owner-member';

// Holds digests, addresses, amounts and build facts only: nothing here can move money.
const stepSchema = z.strictObject({
  // sending: the bytes may have landed. verified: landed and moved exactly the expected USDC.
  // mismatch: landed and moved something else. failed: the chain refused or failed it.
  status: z.enum(['sending', 'verified', 'mismatch', 'failed']),
  digest: digestText,
  from: addressText,
  to: addressText,
  amountAtomic: uintText,
  epoch: uintText,
  nonce: z.number().int().min(0).max(0xffff_ffff),
  signer: z.enum(['purse', 'ellai-member', 'owner-member']),
  errorCode: z.string().max(80).nullable(),
  sentAtMs: z.number().int().nonnegative(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  owner: addressText,
  purse: addressText,
  multisig: addressText,
  /** USDC totals read before the first send, so the end state can be checked against them. */
  start: z.strictObject({ ownerAtomic: uintText, purseAtomic: uintText, multisigAtomic: uintText }).nullable(),
  fund: stepSchema.nullable(),
  sendA: stepSchema.nullable(),
  sendB: stepSchema.nullable(),
});
type State = z.infer<typeof stateSchema>;
type StepRecord = z.infer<typeof stepSchema>;

function loadState(owner: string, purse: string, multisig: string): State {
  if (!existsSync(STATE_FILE)) return { version: 1, owner, purse, multisig, start: null, fund: null, sendA: null, sendB: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    throw new Stop('The state file is not JSON. Nothing was sent. Look at it before running again.');
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) throw new Stop('The state file has an unknown shape. Nothing was sent. Look at it before running again.');
  const state = result.data;
  if (state.owner !== owner || state.purse !== purse || state.multisig !== multisig) {
    throw new Stop('The state file belongs to other wallets than the ones in .env. Nothing was sent.');
  }
  return state;
}

/** Written to a side file and renamed over, so a crash mid-write never leaves half a record. */
function saveState(state: State): void {
  mkdirSync(new URL('.', STATE_FILE), { recursive: true });
  const side = new URL('./slice-state-multisig.json.next', STATE_FILE);
  writeFileSync(side, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(side, STATE_FILE);
}

/** Keeps anonymous Tatum use under the per-minute allowance, and waits out a refusal on reads. */
class Tatum {
  readonly #anonymous: boolean;
  readonly #calls: number[] = [];

  constructor(anonymous: boolean) {
    this.#anonymous = anonymous;
  }

  async reserve(count: number): Promise<void> {
    if (!this.#anonymous) return;
    const prune = () => {
      while (this.#calls.length > 0 && (this.#calls[0] ?? 0) <= Date.now() - LIMITS.tatumPacingWindowMs) this.#calls.shift();
    };
    for (prune(); this.#calls.length + count > LIMITS.tatumAnonymousRequestsPerMinute; prune()) {
      await sleep((this.#calls[0] ?? Date.now()) + LIMITS.tatumPacingWindowMs - Date.now());
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
        if (!(error instanceof ChainError) || error.code !== 'RATE_LIMITED' || retry >= LIMITS.tatumRateLimitRetries) throw error;
        console.log(`  (Tatum rate limited; waiting ${LIMITS.tatumRateLimitWaitMs / 1000} s and reading again)`);
        await sleep(LIMITS.tatumRateLimitWaitMs);
      }
    }
  }
}

interface Run {
  chain: Chain;
  tatum: Tatum;
  owner: Ed25519Keypair;
  purse: Ed25519Keypair;
  multisig: MultiSigPublicKey;
  ownerAddress: string;
  purseAddress: string;
  multisigAddress: string;
  state: State;
  /** The multisig's USDC as last read in this run, for the sweep answer. */
  multisigFinal: bigint | null;
}

const STEP_TITLES: Record<StepName, string> = {
  fund: 'funding (purse to multisig, the purse key signing alone as a plain key)',
  sendA: 'send A (multisig to owner, the purse key as the only member signature)',
  sendB: 'send B (multisig to owner, the owner key as the only member signature)',
};

/** The closed set of places this proof may send to, on purpose: the multisig and the test owner. */
function recipientAllowed(run: Run, to: string): boolean {
  return to === run.multisigAddress || to === run.ownerAddress;
}

function expectedChanges(from: string, to: string, amount: bigint): BalanceChange[] {
  return [
    { address: from, coinType: USDC_TYPE_MAINNET, amount: -amount },
    { address: to, coinType: USDC_TYPE_MAINNET, amount },
  ];
}

/**
 * Names the first way the changes differ from exactly the expected ones, or null. Exactly two
 * changes are allowed, so any SUI change (a gas charge) also counts as a difference.
 */
function changesMismatch(changes: BalanceChange[], expected: BalanceChange[]): string | null {
  if (changes.length !== expected.length) return `${changes.length} balance changes, expected ${expected.length}`;
  for (const want of expected) {
    const found = changes.filter((change) => change.address === want.address && change.coinType === want.coinType);
    const [change] = found;
    if (found.length !== 1 || change === undefined) return `no single change for ${want.address} in USDC`;
    if (change.amount !== want.amount) return `${want.address} changed by ${change.amount}, expected ${want.amount}`;
  }
  return null;
}

/** An address's USDC, read with chain.getBalances, which reads an emptied address as zero. */
async function readUsdc(run: Run, address: string): Promise<Usdc> {
  return run.tatum.read(() => run.chain.getBalances(address));
}

/** Polls a read while Tatum's nodes catch up after a write. Null when the wanted value never shows. */
async function afterWrite<T>(readOnce: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; attempt < LIMITS.chainReadAfterWriteTries; attempt++) {
    const value = await readOnce();
    if (value !== null) return value;
    await sleep(LIMITS.chainReadAfterWriteDelayMs);
  }
  return null;
}

async function readResult(run: Run, digest: string): Promise<TransactionResult | null> {
  try {
    return await run.tatum.read(() => run.chain.getTransactionResult(digest));
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

function argsOf(record: StepRecord): InternalSendArgs {
  return {
    from: record.from,
    to: record.to,
    amountAtomic: BigInt(record.amountAtomic),
    epoch: BigInt(record.epoch),
    nonce: record.nonce,
  };
}

/** The member bitmap of a multisig signature must name exactly the one member expected. */
function assertOnlyMember(signature: string, index: number): void {
  const parsed = parseSerializedSignature(signature);
  if (parsed.signatureScheme !== 'MultiSig' || parsed.multisig.bitmap !== 1 << index || parsed.multisig.sigs.length !== 1) {
    throw new Stop('The combined signature does not carry exactly the one member expected. Nothing was sent.');
  }
}

/** Every key signs only bytes that pass assertInternalSend for this step's own args, checked right here (C6). */
async function signStep(run: Run, txBytes: Uint8Array, args: InternalSendArgs, kind: SignerKind): Promise<string> {
  await assertInternalSend(txBytes, args);
  if (kind === 'purse') return (await run.purse.signTransaction(txBytes)).signature;
  const member = kind === 'ellai-member' ? run.purse : run.owner;
  const signature = await signAsMultisigMember(txBytes, member, run.multisig);
  assertOnlyMember(signature, kind === 'ellai-member' ? ELLAI_MEMBER_INDEX : OWNER_MEMBER_INDEX);
  return signature;
}

async function send(run: Run, txBytes: Uint8Array, signature: string) {
  // The send and, on a refusal, the lookup that confirms it.
  await run.tatum.reserve(2);
  try {
    return await run.chain.executeTransaction(txBytes, [signature]);
  } catch (error) {
    if (error instanceof ChainError) {
      throw new Stop(`${error.message}. The state file keeps the digest; run again to resolve it before anything new is sent.`);
    }
    throw error;
  }
}

/** Reads the landed send by its digest and checks it moved exactly the expected USDC and nothing else. */
async function verifyLanded(run: Run, name: StepName, record: StepRecord, landed: TransactionResult | null): Promise<void> {
  const result = landed ?? (await afterWrite(() => readResult(run, record.digest)));
  if (result === null) {
    throw new Stop(`${record.digest} is not readable through Tatum yet. Run again in a minute to read it; nothing new will be sent.`);
  }
  const mismatch =
    result.status !== 'success'
      ? 'the transaction did not succeed on chain'
      : changesMismatch(result.balanceChanges, expectedChanges(record.from, record.to, BigInt(record.amountAtomic)));
  if (mismatch !== null) {
    record.status = result.status === 'success' ? 'mismatch' : 'failed';
    saveState(run.state);
    throw new Stop(`UNEXPECTED in ${name} ${record.digest}: ${mismatch}. Stopping; nothing further is sent.`);
  }
  record.status = 'verified';
  saveState(run.state);
  console.log(`  VERIFIED with getTransactionResult, read by the digest computed from the signed bytes: ${record.digest}`);
  console.log(`    ${record.from}  ${signed(-BigInt(record.amountAtomic))}`);
  console.log(`    ${record.to}  ${signed(BigInt(record.amountAtomic))}`);
  console.log(`    no other balance change, so no gas was charged; ${txLink(record.digest)}`);
}

/**
 * One send for one step, at most once. A verified step prints and returns. A failed or
 * mismatched step stops the run: it is never replaced by a new transaction. A step left in
 * "sending" is rebuilt from its record, must give the same digest, and is read from chain
 * first; only if the chain does not have it are the same bytes sent again, which Sui runs at
 * most once.
 */
async function runStep(run: Run, name: StepName, from: string, to: string, amount: bigint, kind: SignerKind): Promise<void> {
  const { state } = run;
  const existing = state[name];
  if (existing?.status === 'verified') {
    console.log(`  Already verified, nothing sent: ${usdc(BigInt(existing.amountAtomic))} ${existing.from} to ${existing.to}`);
    console.log(`  digest ${existing.digest}  ${txLink(existing.digest)}`);
    return;
  }
  if (existing?.status === 'failed' || existing?.status === 'mismatch') {
    throw new Stop(
      `${STEP_TITLES[name]} already ended as ${existing.status} (${existing.errorCode ?? 'no code'}), digest ${existing.digest}. ` +
        'It is not retried with a new transaction. Nothing was sent.',
    );
  }
  if (!recipientAllowed(run, to)) throw new Stop('The recipient is neither the multisig nor the test owner. Nothing was sent.');

  let record: StepRecord;
  let txBytes: Uint8Array;
  if (existing?.status === 'sending') {
    record = existing;
    if (record.from !== from || record.to !== to || (name !== 'sendB' && BigInt(record.amountAtomic) !== amount)) {
      throw new Stop(`The recorded ${name} is not the send this step makes. Nothing was sent.`);
    }
    txBytes = await buildInternalSend(argsOf(record));
    if (TransactionDataBuilder.getDigestFromBytes(txBytes) !== record.digest) {
      throw new Stop(`The recorded ${name} does not rebuild to its digest. Nothing was sent.`);
    }
    console.log(`  Resolving the ${name} an earlier run sent: ${record.digest}`);
    const landed = await readResult(run, record.digest);
    if (landed !== null) {
      await verifyLanded(run, name, record, landed);
      return;
    }
    console.log('  not on chain; sending the same signed bytes again (same digest, not a new transaction)');
  } else {
    if (from === run.purseAddress) {
      const outflow = STEPS.map((step) => state[step])
        .filter((entry): entry is StepRecord => entry !== null && entry.from === run.purseAddress && entry.status !== 'failed')
        .reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n);
      if (outflow + amount > MAX_PURSE_OUTFLOW_ATOMIC) {
        throw new Stop(`This send would take ${usdc(outflow + amount)} from the purse, over the ${usdc(MAX_PURSE_OUTFLOW_ATOMIC)} ceiling. Nothing was sent.`);
      }
    }
    const epoch = await run.tatum.read(() => run.chain.getCurrentEpoch());
    const args: InternalSendArgs = { from, to, amountAtomic: amount, epoch, nonce: randomInt(0, 2 ** 32) };
    txBytes = await buildInternalSend(args);
    await assertInternalSend(txBytes, args);
    console.log(`  assertInternalSend ok: one gasless send of ${usdc(amount)}, valid in epochs ${epoch} and ${epoch + 1n}`);
    const simulation = await run.tatum.read(() => run.chain.simulate(txBytes));
    if (simulation.status !== 'success') {
      throw new Stop(`The ${name} dry run failed; the chain answered ${simulation.errorCode}. Nothing was sent.`);
    }
    const dryMismatch = changesMismatch(simulation.balanceChanges, expectedChanges(from, to, amount));
    if (dryMismatch !== null) throw new Stop(`The ${name} dry run moves money it should not: ${dryMismatch}. Nothing was sent.`);
    console.log('  dry run ok: moves exactly the expected USDC and charges no gas');
    record = {
      status: 'sending',
      digest: TransactionDataBuilder.getDigestFromBytes(txBytes),
      from,
      to,
      amountAtomic: String(amount),
      epoch: String(epoch),
      nonce: args.nonce,
      signer: kind,
      errorCode: null,
      sentAtMs: Date.now(),
    };
    state[name] = record;
    saveState(state);
  }

  const signature = await signStep(run, txBytes, argsOf(record), kind);
  const result = await send(run, txBytes, signature);
  if (result.digest !== record.digest) throw new Stop('The executed digest is not the recorded one. Stopping.');
  if (result.status !== 'success') {
    record.status = 'failed';
    record.errorCode = result.errorCode;
    saveState(state);
    throw new Stop(`The ${name} send did not land; the chain answered ${result.errorCode}. Digest ${result.digest}. Not retried.`);
  }
  console.log(`  landed: ${result.digest}`);
  await verifyLanded(run, name, record, null);
}

function balanceLine(label: string, address: string, balances: Usdc): string {
  return (
    `  ${label} ${address}  ${usdc(usdcTotal(balances))} ` +
    `(address balance ${usdc(balances.usdcAddressBalance)}, coins ${usdc(balances.usdcCoinBalance)})`
  );
}

async function stageKeys(run: Run): Promise<void> {
  console.log(`  member 1: Ellai's purse key, address ${run.purseAddress}, weight 1`);
  console.log(`  member 2: the test owner's key, address ${run.ownerAddress}, weight 1`);
  console.log('  threshold 1: either member alone can sign');
  console.log(`  multisig address ${run.multisigAddress}  ${accountLink(run.multisigAddress)}`);

  const owner = await readUsdc(run, run.ownerAddress);
  const purse = await readUsdc(run, run.purseAddress);
  const multisig = await readUsdc(run, run.multisigAddress);
  console.log(balanceLine('Test owner', run.ownerAddress, owner));
  console.log(balanceLine('Purse     ', run.purseAddress, purse));
  console.log(balanceLine('Multisig  ', run.multisigAddress, multisig));
  if (run.state.start === null) {
    if (STEPS.some((step) => run.state[step] !== null)) throw new Stop('Sends are recorded but no starting balances. Nothing was sent.');
    run.state.start = {
      ownerAtomic: String(usdcTotal(owner)),
      purseAtomic: String(usdcTotal(purse)),
      multisigAtomic: String(usdcTotal(multisig)),
    };
    saveState(run.state);
    console.log('  starting balances recorded');
  }
}

async function stageFund(run: Run): Promise<void> {
  await runStep(run, 'fund', run.purseAddress, run.multisigAddress, FUND_ATOMIC, 'purse');
}

async function stageSendA(run: Run): Promise<void> {
  if (run.state.fund?.status !== 'verified') throw new Stop('The funding send is not verified. Nothing was sent.');
  if (run.state.sendA === null) {
    const funded = await afterWrite(async () => {
      const balance = (await readUsdc(run, run.multisigAddress)).usdcAddressBalance;
      return balance >= FUND_ATOMIC ? balance : null;
    });
    if (funded === null) throw new Stop('The multisig does not show the funding yet. Run again in a minute.');
    console.log(`  multisig USDC address balance ${usdc(funded)}`);
  }
  await runStep(run, 'sendA', run.multisigAddress, run.ownerAddress, SEND_A_ATOMIC, 'ellai-member');
}

async function stageSendB(run: Run): Promise<void> {
  if (run.state.sendA?.status !== 'verified') throw new Stop('Send A is not verified. Nothing was sent.');
  let remaining = SWEEP_EXPECTED_ATOMIC;
  if (run.state.sendB === null) {
    let last: Usdc | null = null;
    const ready = await afterWrite(async () => {
      last = await readUsdc(run, run.multisigAddress);
      return last.usdcAddressBalance === SWEEP_EXPECTED_ATOMIC && last.usdcCoinBalance === 0n ? last : null;
    });
    if (ready === null) {
      const seen = last === null ? 'nothing readable' : balanceLine('', run.multisigAddress, last).trim();
      throw new Stop(`The multisig should hold exactly ${usdc(SWEEP_EXPECTED_ATOMIC)} in its address balance and no coins; read ${seen}. Nothing was sent.`);
    }
    remaining = ready.usdcAddressBalance;
    console.log(`  multisig holds ${usdc(remaining)}, all in its address balance: sweeping all of it`);
  } else if (run.state.sendB.status === 'sending') {
    remaining = BigInt(run.state.sendB.amountAtomic);
  }
  await runStep(run, 'sendB', run.multisigAddress, run.ownerAddress, remaining, 'owner-member');

  const empty = await afterWrite(async () => {
    const total = usdcTotal(await readUsdc(run, run.multisigAddress));
    return total === 0n ? total : null;
  });
  if (empty === null) throw new Stop('The multisig does not show 0 USDC after the sweep. Stopping.');
  run.multisigFinal = empty;
  console.log('  multisig now holds 0 USDC');
}

async function stageFinal(run: Run): Promise<void> {
  const start = run.state.start;
  if (start === null) throw new Stop('No starting balances are recorded.');
  const want = {
    owner: BigInt(start.ownerAtomic) + FUND_ATOMIC,
    purse: BigInt(start.purseAtomic) - FUND_ATOMIC,
    multisig: BigInt(start.multisigAtomic),
  };
  let read: { owner: Usdc; purse: Usdc; multisig: Usdc } | null = null;
  const settled = await afterWrite(async () => {
    read = {
      owner: await readUsdc(run, run.ownerAddress),
      purse: await readUsdc(run, run.purseAddress),
      multisig: await readUsdc(run, run.multisigAddress),
    };
    const matches = usdcTotal(read.owner) === want.owner && usdcTotal(read.purse) === want.purse && usdcTotal(read.multisig) === want.multisig;
    return matches ? read : null;
  });
  const final = settled ?? read;
  if (final === null) throw new Stop('The final balances could not be read.');
  const { owner, purse, multisig } = final;
  run.multisigFinal = usdcTotal(multisig);
  console.log(balanceLine('Test owner', run.ownerAddress, owner));
  console.log(`    change since the start ${signed(usdcTotal(owner) - BigInt(start.ownerAtomic))} (expected ${signed(FUND_ATOMIC)})`);
  console.log(balanceLine('Purse     ', run.purseAddress, purse));
  console.log(`    change since the start ${signed(usdcTotal(purse) - BigInt(start.purseAtomic))} (expected ${signed(-FUND_ATOMIC)})`);
  console.log(balanceLine('Multisig  ', run.multisigAddress, multisig));
  if (settled === null) throw new Stop('The final balances are not the expected end state. Read them on Suiscan before anything else.');
  console.log('  end state matches: purse down 0.03, multisig back to 0, owner up 0.03');
}

function answer(record: StepRecord | null, extraCheck: boolean): string {
  if (record === null || record.status === 'sending') return 'not settled yet';
  if (record.status === 'verified') return extraCheck ? 'yes' : 'landed and verified, final balance not read in this run';
  return `no (${record.status}, the chain answered ${record.errorCode ?? 'with unexpected changes'})`;
}

function printSummary(run: Run): void {
  const { state } = run;
  console.log('\nDigests');
  for (const step of STEPS) {
    const record = state[step];
    console.log(`  ${STEP_TITLES[step]}`);
    console.log(record === null ? '    not sent' : `    ${record.status}: ${record.digest}  ${txLink(record.digest)}`);
  }
  const multisigSends = [state.sendA, state.sendB].filter((entry): entry is StepRecord => entry !== null);
  const gasless = multisigSends.some((entry) => entry.status === 'verified')
    ? 'yes'
    : multisigSends.some((entry) => entry.status === 'failed' || entry.status === 'mismatch')
      ? `no (${multisigSends.map((entry) => entry.errorCode ?? entry.status).join(', ')})`
      : 'not settled yet';
  console.log('\nAnswers');
  console.log(`  A gasless USDC send from a 1-of-2 multisig works: ${gasless}`);
  console.log(`  Ellai alone (the purse key as the only member) can spend it: ${answer(state.sendA, true)}`);
  console.log(`  The owner alone can sweep it back to 0: ${answer(state.sendB, run.multisigFinal === 0n)}`);
}

async function main(): Promise<void> {
  const owner = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY);
  const ownerAddress = canonicalSuiAddress(owner.toSuiAddress());
  const purse = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress);
  const purseAddress = canonicalSuiAddress(purse.toSuiAddress());
  const { address: multisigAddress, multisig } = recoveryPurse(purse.getPublicKey(), owner.getPublicKey());
  const state = loadState(ownerAddress, purseAddress, multisigAddress);
  const anonymous = !config.TATUM_API_KEY;
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const run: Run = {
    chain,
    tatum: new Tatum(anonymous),
    owner,
    purse,
    multisig,
    ownerAddress,
    purseAddress,
    multisigAddress,
    state,
    multisigFinal: null,
  };

  console.log('Owner recovery through a 1-of-2 multisig purse, on Sui Mainnet, real USDC, tiny and capped.');
  console.log(`Tatum API key used: ${anonymous ? `no (anonymous, paced to ${LIMITS.tatumAnonymousRequestsPerMinute} a minute)` : 'yes'}`);
  const stages: Array<[string, () => Promise<void>]> = [
    ['1. Keys, the multisig address and starting balances', () => stageKeys(run)],
    [`2. Fund the multisig: ${usdc(FUND_ATOMIC)} from the purse`, () => stageFund(run)],
    [`3. Send A, Ellai alone: ${usdc(SEND_A_ATOMIC)} from the multisig to the test owner`, () => stageSendA(run)],
    ['4. Send B, the owner alone: everything left in the multisig to the test owner', () => stageSendB(run)],
    ['5. Final balances', () => stageFinal(run)],
  ];
  try {
    for (const [title, stage] of stages) {
      console.log(`\n${title}`);
      await stage();
    }
  } finally {
    chain.close();
    printSummary(run);
  }
}

main().catch((error: unknown) => {
  // Every message below is built from fixed text, codes, digests, addresses and amounts.
  if (error instanceof Stop) console.error(`\nSTOPPED: ${error.message}`);
  else if (error instanceof ChainError || error instanceof MultisigError) console.error(`\nSTOPPED: ${error.name} ${error.code}: ${error.message}`);
  else console.error(`\nSTOPPED: ${error instanceof Error ? error.message : 'unexpected failure'}`);
  process.exitCode = 1;
});
