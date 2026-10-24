// Sends one unpaid request to each known Sui Mainnet seller through safeFetch, with the
// method, body and content type the seller documents, parses the 402 with
// parseChallenge, and prints one line per seller. It never pays, signs or sends a
// transaction, and it needs no keys. Everything printed comes from the canonical payment
// or a refusal code, never from raw seller text.
import { ChallengeError, type CanonicalPayment, parseChallenge } from '../src/challenge.js';
import { NetError, safeFetch } from '../src/net.js';
import { KNOWN_SELLERS } from '../src/sellers.js';
import { USDC_DECIMALS } from '../src/usdc.js';

function inUsdc(atomic: bigint): string {
  const base = 10n ** BigInt(USDC_DECIMALS);
  return `${atomic / base}.${(atomic % base).toString().padStart(USDC_DECIMALS, '0')}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

function describePayment(payment: CanonicalPayment, nowMs: number): string {
  const seconds = Math.round((payment.expiresAtMs - nowMs) / 1_000);
  return [
    payment.dialect.padEnd(14),
    `${inUsdc(payment.amount)} USDC`.padEnd(14),
    `to ${shortAddress(payment.recipient)}`,
    `expires ${new Date(payment.expiresAtMs).toISOString()} (in ${seconds} s)`,
  ].join('  ');
}

function refusalCode(error: unknown): string {
  if (error instanceof NetError || error instanceof ChallengeError) return error.code;
  return 'UNEXPECTED';
}

async function main(): Promise<void> {
  console.log(`Unpaid probe of ${KNOWN_SELLERS.length} Sui Mainnet sellers. No payment, no signing.`);
  let parsed = 0;
  for (const seller of KNOWN_SELLERS) {
    const { hostname, pathname } = new URL(seller.url);
    const label = `${seller.method.padEnd(4)} ${hostname}${pathname}`.padEnd(70);
    try {
      // Unpaid, so the default timeout: a 402 comes back before the seller does any work.
      const response = await safeFetch(seller.url, {
        method: seller.method,
        ...(seller.contentType === undefined ? {} : { headers: { 'content-type': seller.contentType } }),
        ...(seller.body === undefined ? {} : { body: seller.body }),
      });
      const nowMs = Date.now();
      const payment = parseChallenge(response, nowMs);
      parsed += 1;
      console.log(`${label}  ${describePayment(payment, nowMs)}  paid wait ${seller.paidTimeoutMs / 1_000} s`);
    } catch (error) {
      console.log(`${label}  REFUSED ${refusalCode(error)}`);
    }
  }
  console.log(`${parsed} of ${KNOWN_SELLERS.length} sellers gave a parsed canonical payment.`);
  if (parsed === 0) process.exitCode = 1;
}

main().catch(() => {
  console.error('probe failed');
  process.exitCode = 1;
});
