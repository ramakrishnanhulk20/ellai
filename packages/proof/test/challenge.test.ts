// Covers: parseChallenge on every saved live 402 (five Sui Mainnet t2000 sellers, the
// DrVelvetFog testnet demo, and two POST sellers captured by probe:sellers whose header
// copy is broken) and on adversarial challenges. Each adversarial fixture is a live 402
// with one thing changed, named in its "note": ambiguity, disagreeing copies, bad
// amounts, assets, networks and ids, expiry, size and depth caps, mixed dialects,
// __proto__ keys, and a t2000 escrow job entry.
// Does NOT cover: whether the seller is honest, whether the recipient belongs to the
// host (trust is keyed on the recipient elsewhere), the epoch window against the live
// chain, or the network fetch itself (net.test.ts covers that).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CanonicalPayment, ChallengeError, parseChallenge } from '../src/challenge.js';
import { LIMITS } from '../src/limits.js';
import type { SafeResponse } from '../src/net.js';
import { USDC_TYPE_MAINNET } from '../src/usdc.js';

interface Fixture {
  expect?: string;
  note?: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const FIXTURES = new URL('./fixtures/', import.meta.url);
// The moment the live 402s were captured, so their epochs and timeouts read as fresh.
const NOW = Date.parse('2026-10-20T14:04:00Z');

function load(dir: 'live' | 'adversarial', name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${dir}/${name}.json`, FIXTURES), 'utf8')) as Fixture;
}

function responseOf(fixture: Fixture): SafeResponse {
  return {
    status: fixture.status,
    headers: fixture.headers,
    bodyText: fixture.body,
    url: fixture.url,
    host: new URL(fixture.url).hostname,
  };
}

function refusalOf(fixture: Fixture): ChallengeError {
  try {
    parseChallenge(responseOf(fixture), NOW);
  } catch (error) {
    if (error instanceof ChallengeError) return error;
    throw error;
  }
  throw new Error('expected parseChallenge to refuse');
}

const CANONICAL_KEYS = [
  'amount',
  'asset',
  'challengeId',
  'dialect',
  'expiresAtMs',
  'maxEpoch',
  'minEpoch',
  'network',
  'nonce',
  'recipient',
  'resource',
  'sellerHost',
  'sellerUrl',
];

describe('parseChallenge on the saved live 402s', () => {
  it.each([
    ['agentproof-deep-verify', 250_000n, '0x5dd4bd4f04ef4c3913acd4f9837fbb86aef946142aa37195a05af74e627a4f7c'],
    ['agentproof-mcp-verify', 50_000n, '0x5dd4bd4f04ef4c3913acd4f9837fbb86aef946142aa37195a05af74e627a4f7c'],
    ['agentproof-preflight', 10_000n, '0x5dd4bd4f04ef4c3913acd4f9837fbb86aef946142aa37195a05af74e627a4f7c'],
    ['agentproof-mcp', 10_000n, '0x5dd4bd4f04ef4c3913acd4f9837fbb86aef946142aa37195a05af74e627a4f7c'],
    ['jp-task-policy-classify', 20_000n, '0x2b4408b6c78ec9b9f9e93f877e978af0ebb9acdd25823c5280e490cdb779b249'],
  ])('%s parses into one canonical payment', (name, amount, recipient) => {
    const fixture = load('live', name);
    type LiveOption = { resource: string; extra: { suimpp: { challengeId: string; nonce: number } } };
    const [option] = (JSON.parse(fixture.body) as { accepts: [LiveOption] }).accepts;
    const payment = parseChallenge(responseOf(fixture), NOW);

    expect(payment).toEqual({
      dialect: 'x402-v1-t2000',
      sellerUrl: fixture.url,
      sellerHost: new URL(fixture.url).hostname,
      recipient,
      amount,
      asset: USDC_TYPE_MAINNET,
      network: 'sui:mainnet',
      expiresAtMs: NOW + LIMITS.paymentValidityMs,
      challengeId: option.extra.suimpp.challengeId,
      nonce: String(option.extra.suimpp.nonce),
      minEpoch: 1286n,
      maxEpoch: 1287n,
      resource: option.resource,
    } satisfies CanonicalPayment);
  });

  it('builds a fresh frozen object holding only the canonical fields', () => {
    const payment = parseChallenge(responseOf(load('live', 'agentproof-preflight')), NOW);
    expect(Object.keys(payment).sort()).toEqual(CANONICAL_KEYS);
    expect(Object.getPrototypeOf(payment)).toBe(Object.prototype);
    expect(Object.isFrozen(payment)).toBe(true);
  });

  it('refuses the DrVelvetFog demo because it is on testnet', () => {
    expect(['BAD_NETWORK', 'NO_PAYABLE_OPTION']).toContain(refusalOf(load('live', 'drvelvetfog-signal-whales-testnet')).code);
  });

  // Older t2000 serve builds write currency="[object Object]" into the header copy. That
  // copy cannot be read as a coin type, so it cannot be shown to agree with the body.
  it.each(['sui-inspector-inspect', 'funkii-palette'])('refuses %s, whose header copy of the currency is unreadable', (name) => {
    expect(refusalOf(load('live', name)).code).toBe('MALFORMED');
  });
});

describe('parseChallenge on adversarial challenges', () => {
  const names = readdirSync(new URL('adversarial/', FIXTURES))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length));

  it('has a fixture for every case the work order names', () => {
    for (const required of [
      'two-payable-options',
      'header-body-amount-disagree',
      'amount-zero',
      'amount-negative',
      'amount-decimal',
      'amount-exponent',
      'amount-010',
      'amount-over-max',
      'amount-under-min',
      'asset-not-usdc',
      'asset-usdc-short-form',
      'recipient-short-form',
      'network-testnet',
      'expired',
      'oversize-body',
      'nested-40-deep',
      'v1-and-v2-in-one-body',
      'proto-key',
      'escrow-terms',
    ]) {
      expect(names).toContain(required);
    }
  });

  it.each(names)('%s', (name) => {
    const fixture = load('adversarial', name);
    if (fixture.expect === 'PASS') {
      expect(() => parseChallenge(responseOf(fixture), NOW)).not.toThrow();
    } else {
      expect(refusalOf(fixture).code).toBe(fixture.expect);
    }
  });

  it('reads the short and long USDC type through one normaliser', () => {
    expect(parseChallenge(responseOf(load('adversarial', 'asset-usdc-short-form')), NOW).asset).toBe(USDC_TYPE_MAINNET);
  });

  it('turns a short recipient into the long form the header copy uses', () => {
    const payment = parseChallenge(responseOf(load('adversarial', 'recipient-short-form')), NOW);
    expect(payment.recipient).toBe(`0x${'abc12'.padStart(64, '0')}`);
  });

  it('ignores __proto__ keys and leaves Object.prototype alone', () => {
    const payment = parseChallenge(responseOf(load('adversarial', 'proto-key')), NOW);
    expect(payment.recipient).toBe('0x5dd4bd4f04ef4c3913acd4f9837fbb86aef946142aa37195a05af74e627a4f7c');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect(Object.hasOwn(payment, 'polluted')).toBe(false);
    expect(Object.getPrototypeOf(payment)).toBe(Object.prototype);
  });

  it('reads an x402 v2 Sui Mainnet challenge when its header and body agree', () => {
    const payment = parseChallenge(responseOf(load('adversarial', 'v2-mainnet')), NOW);
    expect(payment).toMatchObject({
      dialect: 'x402-v2',
      amount: 20_000n,
      recipient: '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d',
      resource: 'https://seller.example/v2/data',
      challengeId: null,
      nonce: null,
      minEpoch: null,
      maxEpoch: null,
    });
  });

  it('never copies seller text into a refusal message', () => {
    expect(refusalOf(load('adversarial', 'challenge-id-bad-characters')).message).not.toContain('onerror');
  });
});

describe('parseChallenge expiry', () => {
  function withTimeout(seconds: number): SafeResponse {
    const fixture = load('live', 'agentproof-preflight');
    return responseOf({ ...fixture, body: fixture.body.replace('"maxTimeoutSeconds":60', `"maxTimeoutSeconds":${seconds}`) });
  }

  it("keeps the seller's own expiry when it is the sooner one", () => {
    expect(parseChallenge(withTimeout(30), NOW).expiresAtMs).toBe(NOW + 30_000);
  });

  it("caps a long seller expiry at Ellai's own validity window", () => {
    expect(parseChallenge(withTimeout(3_600), NOW).expiresAtMs).toBe(NOW + LIMITS.paymentValidityMs);
  });
});
