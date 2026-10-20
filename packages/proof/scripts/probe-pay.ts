// For each known Sui Mainnet seller whose 402 parses: reads the current epoch through
// Tatum, signs the payment from the test owner's purse, re-asserts the signed bytes,
// runs t2000's own seller verifier on the header offline, and dry-runs the bytes through
// Tatum. The header and the bytes are NEVER sent to a seller, and nothing is executed:
// the dry run carries no signature. The purse holds no USDC, so the expected dry-run
// result is a refusal for insufficient address balance. Prints digests, never a
// signature, a key, the bytes or a header value.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { parseX402Header, USDC, verifyX402Payment } from '@t2000/sui-x402';
import { ChainError, createChain } from '../src/chain.js';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '../src/challenge.js';
import { config } from '../src/config.js';
import { derivePurseKeypair } from '../src/keys.js';
import { LIMITS } from '../src/limits.js';
import { NetError, safeFetch } from '../src/net.js';
import { assertPlainUsdcSend, PaymentError, paymentHeader, signPayment } from '../src/payment.js';
import { KNOWN_SELLERS } from '../src/sellers.js';
import { USDC_DECIMALS } from '../src/usdc.js';

// Two seconds of slack over Tatum's minute.
const PACING_WINDOW_MS = 62_000;
const TATUM_CALLS_PER_SELLER = 2;
const SELLERS_NEEDED = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keeps anonymous Tatum use under its per-minute allowance, counting calls when they are made. */
function tatumPacer(anonymous: boolean) {
  const calls: number[] = [];
  const prune = () => {
    while (calls.length > 0 && (calls[0] ?? 0) <= Date.now() - PACING_WINDOW_MS) calls.shift();
  };
  return {
    async reserve(count: number): Promise<void> {
      if (!anonymous) return;
      for (prune(); calls.length + count > LIMITS.tatumAnonymousRequestsPerMinute; prune()) {
        await sleep((calls[0] ?? Date.now()) + PACING_WINDOW_MS - Date.now());
      }
    },
    mark(): void {
      calls.push(Date.now());
    },
  };
}

function inUsdc(atomic: bigint): string {
  const base = 10n ** BigInt(USDC_DECIMALS);
  return `${atomic / base}.${(atomic % base).toString().padStart(USDC_DECIMALS, '0')}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

function failureLabel(error: unknown): string {
  if (error instanceof NetError || error instanceof ChallengeError) return `REFUSED ${error.code}`;
  if (error instanceof PaymentError) return `PAYMENT ${error.code}`;
  if (error instanceof ChainError) return `TATUM ${error.code}`;
  return 'UNEXPECTED';
}

/** t2000's verdict with only its fixed wording kept: anything after a colon may quote values. */
function t2000Verdict(payment: CanonicalPayment, headerValue: string): string {
  try {
    const parsed = parseX402Header(headerValue);
    verifyX402Payment({
      payment: parsed,
      // What a t2000 seller passes: its own terms, and the challenge id read back from the payment.
      expected: {
        challengeId: parsed.payload.challengeId,
        amount: inUsdc(payment.amount),
        currency: USDC,
        recipient: payment.recipient,
        network: 'mainnet',
      },
    });
    return 'accepted';
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split(':')[0] ?? '') : '';
    return `rejected (${reason.replace(/[^\w /[\]-]/g, '')})`;
  }
}

async function main(): Promise<void> {
  const ownerAddress = Ed25519Keypair.fromSecretKey(config.OWNER_TEST_PRIVATE_KEY).toSuiAddress();
  const purse = derivePurseKeypair(config.ELLAI_MASTER_SECRET, ownerAddress);
  const anonymous = !config.TATUM_API_KEY;
  const pacer = tatumPacer(anonymous);
  const chain = createChain({ apiKey: config.TATUM_API_KEY });

  console.log('Payment probe. Signs from the test owner purse; sends nothing to any seller; executes nothing.');
  console.log(`Purse ${purse.toSuiAddress()} (holds no USDC, so the dry run should refuse for balance).`);
  console.log(`Tatum API key used: ${anonymous ? `no (anonymous, paced to ${LIMITS.tatumAnonymousRequestsPerMinute} a minute)` : 'yes'}`);

  let parsed = 0;
  let complete = 0;
  try {
    for (const seller of KNOWN_SELLERS) {
      const { hostname, pathname } = new URL(seller.url);
      console.log(`\n${seller.method.padEnd(4)} ${hostname}${pathname}`);
      // Reserved before the challenge is fetched, so a wait never eats its validity window.
      await pacer.reserve(TATUM_CALLS_PER_SELLER);
      try {
        const response = await safeFetch(seller.url, {
          method: seller.method,
          ...(seller.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: seller.body }),
        });
        const payment = parseChallenge(response, Date.now());
        parsed += 1;

        pacer.mark();
        const epoch = await chain.getCurrentEpoch();
        console.log(
          `     ${inUsdc(payment.amount)} USDC to ${shortAddress(payment.recipient)}, chain epoch ${epoch}, ` +
            `challenge window ${payment.minEpoch ?? '-'} to ${payment.maxEpoch ?? '-'}`,
        );

        const signed = await signPayment(payment, purse, Date.now(), epoch);
        const txBytes = fromBase64(signed.txBytesBase64);
        await assertPlainUsdcSend(txBytes, payment, signed.payer);
        console.log('     assert ok');

        const verdict = t2000Verdict(payment, paymentHeader(payment, signed).value);
        console.log(`     t2000 seller verifier, offline: ${verdict}`);

        pacer.mark();
        const simulation = await chain.simulate(txBytes);
        console.log(`     dry run through Tatum: ${simulation.status}${simulation.errorCode ? ` ${simulation.errorCode}` : ''}`);
        console.log(`     digest ${signed.digest} (signed, never sent)`);
        if (verdict === 'accepted') complete += 1;
      } catch (error) {
        console.log(`     ${failureLabel(error)}`);
      }
    }
  } finally {
    chain.close();
  }

  console.log(
    `\n${complete} of ${parsed} parsed sellers (${KNOWN_SELLERS.length} known): assert ok, verifier accepted, dry run answered.`,
  );
  if (complete < SELLERS_NEEDED) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Config, key and chain errors are built from fixed text and names, never values.
  console.error(error instanceof Error ? error.message : 'probe failed');
  process.exitCode = 1;
});
