// Proves Ellai's own seller live on Sui Mainnet: the 0.01 USDC wallet check. The seller handler
// is asked, with no payment, to check the test owner's address and answers 402; that 402 is read
// with core's parseChallenge, as any buyer would read it, and signed with core's signPayment from
// the test owner's purse; the payment goes back to the handler, which checks the bytes and the
// signature, sends them through Tatum, verifies the settlement from the chain's own effects and
// answers with the wallet check. The handler is called directly: putting it behind a public URL
// comes with the routes order. Exactly one 0.01 USDC leaves the purse, to the gas wallet unless
// ELLAI_SELLER_PAYTO is set, and a run after a payment was presented pays nothing and shows what
// is recorded. Reuses the PGlite file database at scratchpad/loop-db. Prints ids, digests and
// links, never a key, a signature, payment bytes or a payment header, and checks its own output
// for them before it ends.
import { fileURLToPath } from 'node:url';
import { type Chain, ChainError, createChain } from '@ellai/core/chain';
import { ChallengeError, parseChallenge } from '@ellai/core/challenge';
import { canonicalSuiAddress, derivePurseKeypair } from '@ellai/core/keys';
import { LIMITS } from '@ellai/core/limits';
import { MemoryError } from '@ellai/core/memory';
import { PaymentError, paymentHeader, signPayment } from '@ellai/core/payment';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, createDb, migrate } from '../src/server/db/client.js';
import { owners, sellerSales } from '../src/server/db/schema.js';
import { formatUsdc } from '../src/server/decide/sentences.js';
import { SellerError } from '../src/server/seller/challenge.js';
import { type SellerResponse, handleWalletCheck, sellerPayTo } from '../src/server/seller/handler.js';

const DB_DIR = fileURLToPath(new URL('../../../scratchpad/loop-db', import.meta.url));
// The route is not public yet, so the resource is named on the reserved .invalid domain, which
// no one can fetch. parseChallenge needs an https URL for the seller it read the 402 from.
const RESOURCE_URL = 'https://ellai.invalid/api/seller/wallet-check';
// Stands in for the platform's verified client address that the route will pass.
const CALLER_KEY = 'prove-seller';
const SUISCAN_TX = 'https://suiscan.xyz/mainnet/tx/';
const PRICE = BigInt(LIMITS.sellerPriceAtomic);

const usdc = (atomic: bigint) => `${formatUsdc(atomic)} USDC`;

/** A refusal written by this script. Its message is fixed text and validated ids only. */
class ProofError extends Error {}

const printed: string[] = [];
function say(line = ''): void {
  printed.push(line);
  console.log(line);
}

const blankIsMissing = (value: unknown): unknown => (value === '' ? undefined : value);

function isEd25519SuiKey(value: string): boolean {
  try {
    const { scheme, secretKey } = decodeSuiPrivateKey(value);
    return scheme === 'ED25519' && secretKey.length === 32;
  } catch {
    return false;
  }
}

const suiKey = z.string().startsWith('suiprivkey').refine(isEd25519SuiKey);

const configSchema = z.object({
  ELLAI_MASTER_SECRET: z.preprocess(blankIsMissing, z.string().regex(/^[0-9a-f]{64}$/i)),
  OWNER_TEST_PRIVATE_KEY: z.preprocess(blankIsMissing, suiKey),
  GAS_PRIVATE_KEY: z.preprocess(blankIsMissing, suiKey),
  TATUM_API_KEY: z.preprocess(blankIsMissing, z.string().optional()),
  ELLAI_SELLER_PAYTO: z.preprocess(blankIsMissing, z.string().optional()),
});

/** The variables this proof reads. The message names bad variables and never a value. */
function loadConfig(env: Record<string, string | undefined>): z.infer<typeof configSchema> {
  const names = Object.keys(configSchema.shape);
  const result = configSchema.safeParse(Object.fromEntries(names.map((name) => [name, env[name]])));
  if (result.success) return result.data;
  const bad = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  throw new ProofError(`root .env is missing or has malformed: ${bad.join(', ')}`);
}

function failureLabel(error: unknown): string {
  if (error instanceof ChallengeError || error instanceof PaymentError || error instanceof MemoryError) return `${error.code}: ${error.message}`;
  if (error instanceof ChainError) return `TATUM ${error.code}: ${error.message}`;
  if (error instanceof ProofError || error instanceof SellerError) return error.message;
  // Anything else may carry text from a library, so only its kind is shown.
  return `unexpected ${error instanceof Error ? error.name : 'failure'}`;
}

function errorOf(response: SellerResponse): string {
  try {
    const parsed = JSON.parse(response.body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : 'no error text';
  } catch {
    return 'a body that is not JSON';
  }
}

function pretty(body: string): string {
  return JSON.stringify(JSON.parse(body), null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

async function walletUsdc(chain: Chain, address: string): Promise<bigint> {
  return (await chain.getBalances(address)).usdcAddressBalance;
}

/**
 * The order's money rule, from what the seller recorded for this purse: once any payment from it
 * has been sent to the chain, nothing new is paid, whatever became of it.
 */
async function earlierPayments(db: Database, chain: Chain, purse: string): Promise<boolean> {
  const sales = await db.select().from(sellerSales).where(eq(sellerSales.payer, purse));
  const sent = sales.filter((sale) => sale.digest !== null);
  if (sent.length === 0) {
    say(`  No earlier payment from this purse was sent to the chain${sales.length > 0 ? ` (${sales.length} refused before sending, nothing moved)` : ''}`);
    return false;
  }
  for (const sale of sent) {
    const digest = sale.digest ?? '';
    let onChain = 'not read';
    try {
      onChain = (await chain.getTransactionResult(digest)).status;
    } catch (error) {
      onChain = error instanceof ChainError ? error.code : 'unreadable';
    }
    say(`  Earlier sale ${sale.challengeId}: ${sale.status}, digest ${digest}, on chain: ${onChain}`);
    say(`  ${SUISCAN_TX}${digest}`);
  }
  return true;
}

async function main(): Promise<void> {
  // createDb refuses a pglite: database outside development and tests.
  process.env.NODE_ENV = 'development';
  const config = loadConfig(process.env);
  const ownerAddress = canonicalSuiAddress(Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress());
  const purseKeypair = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress);
  const purse = canonicalSuiAddress(purseKeypair.toSuiAddress());
  const payTo = sellerPayTo({ ELLAI_SELLER_PAYTO: config.ELLAI_SELLER_PAYTO, GAS_PRIVATE_KEY: config.GAS_PRIVATE_KEY });

  say("Ellai's own seller on Sui Mainnet: the 0.01 USDC wallet check. Real USDC, exactly 0.01 in this order.");
  say(`Tatum API key used: ${config.TATUM_API_KEY ? 'yes' : 'no (anonymous)'}`);
  say(`Test owner ${ownerAddress}, purse ${purse} (derived), database scratchpad/loop-db`);
  say(`Seller paid to ${payTo} (${config.ELLAI_SELLER_PAYTO === undefined ? 'the gas wallet, ELLAI_SELLER_PAYTO is unset' : 'ELLAI_SELLER_PAYTO'})`);

  const handle = await createDb(`pglite:${DB_DIR}`);
  const chain = createChain({ apiKey: config.TATUM_API_KEY });
  const problems: string[] = [];
  const secrets: string[] = [config.ELLAI_MASTER_SECRET, config.OWNER_TEST_PRIVATE_KEY, config.GAS_PRIVATE_KEY, 'suiprivkey'];
  try {
    const { db } = handle;
    await migrate(db);

    say('\n0. Before paying');
    const [owner] = await db.select({ id: owners.id }).from(owners).where(and(eq(owners.suiAddress, ownerAddress), eq(owners.purseAddress, purse)));
    if (owner === undefined) throw new ProofError('the test owner and purse are not in scratchpad/loop-db; nothing was paid');
    say(`  Owner ${owner.id} is in the database with this purse`);
    if (await earlierPayments(db, chain, purse)) {
      throw new ProofError('a payment from this purse was already sent to the seller in an earlier run; nothing new is paid');
    }
    const purseBefore = await walletUsdc(chain, purse);
    const payToBefore = await walletUsdc(chain, payTo);
    say(`  Purse USDC ${usdc(purseBefore)}, seller pay-to USDC ${usdc(payToBefore)} (address balances, read through Tatum)`);
    if (purseBefore < PRICE) throw new ProofError('the purse holds less than 0.01 USDC; nothing was paid');

    const ask = (headers: Record<string, string>) =>
      handleWalletCheck({
        db,
        chain,
        method: 'POST',
        url: RESOURCE_URL,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ address: ownerAddress }),
        payTo,
        callerKey: CALLER_KEY,
        now: new Date(),
      });

    say(`\n1. An unpaid POST ${RESOURCE_URL} asking to check ${ownerAddress}`);
    const unpaid = await ask({});
    say(`  HTTP ${unpaid.status}`);
    if (unpaid.status !== 402) throw new ProofError(`the seller answered ${unpaid.status}, not 402: ${errorOf(unpaid)}`);
    say(`  WWW-Authenticate: ${unpaid.headers['WWW-Authenticate'] ?? 'missing'}`);
    say('  Body:');
    say(pretty(unpaid.body));

    say("\n2. The 402 read with core's parseChallenge and signed from the test owner's purse");
    const host = new URL(RESOURCE_URL).hostname;
    const payment = parseChallenge({ status: unpaid.status, headers: unpaid.headers, bodyText: unpaid.body, url: RESOURCE_URL, host }, Date.now());
    say(`  Canonical payment: ${usdc(payment.amount)} to ${payment.recipient}, challenge ${payment.challengeId}, nonce ${payment.nonce}, epochs ${payment.minEpoch} to ${payment.maxEpoch}`);
    if (payment.recipient !== payTo || payment.amount !== PRICE) {
      throw new ProofError('the challenge does not ask for exactly 0.01 USDC to the seller pay-to address; nothing was signed');
    }
    const epoch = await chain.getCurrentEpoch();
    const signed = await signPayment(payment, purseKeypair, Date.now(), epoch);
    const header = paymentHeader(payment, signed);
    secrets.push(header.value, signed.txBytesBase64, signed.signature);
    say(`  Signed by purse ${signed.payer} in epoch ${epoch}; digest ${signed.digest}, computed from the signed bytes`);

    say('\n3. The paid request: the seller checks the bytes and the signature, sends them through Tatum and verifies the settlement');
    const paid = await ask({ [header.name]: header.value });
    say(`  HTTP ${paid.status}`);
    const [sale] = await db.select().from(sellerSales).where(eq(sellerSales.challengeId, payment.challengeId ?? ''));
    say(`  Sale ${payment.challengeId}: ${sale?.status ?? 'missing'}, digest ${sale?.digest ?? 'none'}, payer ${sale?.payer ?? 'none'}`);
    if (sale?.digest) say(`  ${SUISCAN_TX}${sale.digest}`);
    if (paid.status !== 200) {
      problems.push(`the paid request answered ${paid.status}: ${errorOf(paid)}`);
    } else {
      const receipt = JSON.parse(Buffer.from(paid.headers['X-PAYMENT-RESPONSE'] ?? '', 'base64').toString('utf8')) as { transaction?: unknown; payer?: unknown };
      say(`  X-PAYMENT-RESPONSE: transaction ${String(receipt.transaction)}, payer ${String(receipt.payer)}`);
      say('  Wallet check:');
      say(pretty(paid.body));
      if (receipt.transaction !== signed.digest) problems.push('the receipt does not carry the digest of the signed bytes');
      if (sale?.status !== 'settled' || sale.digest !== signed.digest) problems.push('the sale is not recorded as settled with the signed digest');
    }

    say('\n4. Balances after, as Tatum reads them now');
    const purseAfter = await walletUsdc(chain, purse);
    const payToAfter = await walletUsdc(chain, payTo);
    say(`  Purse USDC ${usdc(purseBefore)} before, ${usdc(purseAfter)} after; seller pay-to USDC ${usdc(payToBefore)} before, ${usdc(payToAfter)} after`);
    say(`  Realised: ${sale?.status === 'settled' ? usdc(PRICE) : usdc(0n)} verified by the seller from the transaction's own effects; the reads above can lag a landed transaction by a few seconds`);
    if (purseBefore - purseAfter > PRICE) problems.push('more than 0.01 USDC left the purse');
  } finally {
    await handle.close();
    chain.close();
  }

  const output = printed.join('\n');
  const leaked = secrets.filter((secret) => output.includes(secret)).length;
  say(`\nLeak check: ${leaked === 0 ? 'no key, signature, payment bytes or payment header appears in this output' : `${leaked} secret values appear in this output`}`);
  if (leaked > 0) problems.push('a secret value appears in the output');

  if (problems.length > 0) {
    say(`\nNOT PROVEN: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else {
    say("\nPROVEN: Ellai's seller issued a 402 that core's own buyer code reads and pays, took exactly 0.01 USDC once, checked the bytes and the signature before sending them through Tatum, verified the settlement on chain and answered with the wallet check.");
  }
}

main().catch((error: unknown) => {
  console.error(`\nSTOPPED: ${failureLabel(error)}`);
  process.exitCode = 1;
});
