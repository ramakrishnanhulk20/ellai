import { KNOWN_SELLERS, type Seller } from '@ellai/core/sellers';

export interface CatalogEntry {
  /** Short stable slug the model names a seller by. It is never a URL. */
  id: string;
  url: string;
  method: 'POST' | 'GET';
  contentType: string | null;
  description: string;
  bodyExample: string | null;
}

const WALLET_CHECK_ID = 'ellai-wallet-check';
const WALLET_CHECK_PATH = '/api/sell/wallet-check';
const JSON_TYPE = 'application/json';
// The Sui framework address, the same example address core's sellers list uses.
const EXAMPLE_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000002';
const API_VERSION_SEGMENT = /^v[0-9]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The per-payment maximum every owner starts with, in atomic USDC: 0.05 USDC. It mirrors the
 * default of owners.per_payment_max_atomic in db/schema.ts. A seller priced above it is refused
 * for every owner who has not raised their own maximum, so it is not offered.
 */
export const DEFAULT_PER_PAYMENT_MAX_ATOMIC = 50_000n;

const USDC_DECIMALS = 6;
// Each note in core's list states its price once, as in "0.01 USDC".
const NOTE_PRICE = /\b([0-9]+)\.([0-9]{1,6}) USDC\b/g;

const sameUrl = (url: string) => new URL(url).href;

// Facts about single sellers that no field of core's record carries, so each is named here with
// its reason. Every seller not named is judged by the price rule alone. Not covered: a seller
// whose 402 breaks after this was written, which paidFetch still refuses when it is called.
const NOT_OFFERED = new Set(
  [
    // Its 402 names currency="[object Object]", which core's parseChallenge refuses as MALFORMED.
    'https://sui-inspector-x402.vercel.app/inspect',
    // The same broken currency header, refused as MALFORMED.
    'https://funkii-ai.vercel.app/palette',
    // A subscription: one payment buys a standing alert service the agent can neither use nor cancel.
    'https://t2000-bot-x402.vercel.app/subscribe',
  ].map(sameUrl),
);

// Derived from the URL rather than kept in a hand-written table, so a seller added to core
// gets an id without anyone remembering to name it. Stable for as long as the URL is.
function slugOf(url: string): string {
  const parsed = new URL(url);
  const firstLabel = parsed.hostname.split('.')[0] ?? '';
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '' && !API_VERSION_SEGMENT.test(segment));
  return [firstLabel, ...segments]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A seller whose documented request Ellai does not hold would only ever get a body the model
// guessed, so only sellers with a documented body and content type are offered.
function hasDocumentedRequest(seller: Seller): seller is Seller & { body: string; contentType: string } {
  return typeof seller.body === 'string' && typeof seller.contentType === 'string';
}

/** The price a seller's note states, in atomic USDC, or null when it states none or more than one. */
export function documentedPriceAtomic(note: string): bigint | null {
  const stated = [...note.matchAll(NOTE_PRICE)];
  if (stated.length !== 1) return null;
  const whole = stated[0]?.[1];
  const fraction = stated[0]?.[2];
  if (whole === undefined || fraction === undefined) return null;
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, '0'));
}

// A price the note does not state clearly is treated as too high, so the agent is never pointed
// at a seller the gate would refuse at default limits.
function payableAtDefaults(seller: Seller): boolean {
  if (NOT_OFFERED.has(sameUrl(seller.url))) return false;
  const price = documentedPriceAtomic(seller.note);
  return price !== null && price <= DEFAULT_PER_PAYMENT_MAX_ATOMIC;
}

function walletCheckUrl(appOrigin: string): string {
  if (typeof appOrigin !== 'string' || !URL.canParse(appOrigin)) throw new Error('The app origin is not a URL');
  const origin = new URL(appOrigin).origin;
  if (origin === 'null') throw new Error('The app origin is not an origin');
  return `${origin}${WALLET_CHECK_PATH}`;
}

/**
 * The only sellers the built-in agent can call (C7, C20): Ellai's own wallet check at
 * appOrigin + /api/sell/wallet-check, then every seller in core's KNOWN_SELLERS with a
 * documented body and content type, with that body as the example, that the gate can pay at
 * default limits: its note states one price of at most DEFAULT_PER_PAYMENT_MAX_ATOMIC, and it
 * is not one of the sellers named in NOT_OFFERED (two whose 402 core refuses as MALFORMED, and
 * a subscription). Each id is a slug made from the seller's host and path. The model names an
 * id; the URL, method and content type always come from here. Throws Error when appOrigin is
 * not an origin, or when two sellers would share an id, which is a configuration bug.
 */
export function agentCatalog(appOrigin: string): ReadonlyArray<CatalogEntry> {
  const entries: CatalogEntry[] = [
    {
      id: WALLET_CHECK_ID,
      url: walletCheckUrl(appOrigin),
      method: 'POST',
      contentType: JSON_TYPE,
      description:
        "Ellai's own wallet check, 0.01 USDC: a plain summary of one Sui Mainnet address with its SUI, its USDC, whether it has a Walrus Memory account, and how many Walrus blobs it holds (body {address})",
      bodyExample: JSON.stringify({ address: EXAMPLE_ADDRESS }),
    },
    ...KNOWN_SELLERS.filter(hasDocumentedRequest)
      .filter(payableAtDefaults)
      .map((seller) => ({
        id: slugOf(seller.url),
        url: seller.url,
        method: seller.method,
        contentType: seller.contentType,
        description: seller.note,
        bodyExample: seller.body,
      })),
  ];
  const ids = new Set<string>();
  for (const { id } of entries) {
    if (!SLUG.test(id) || ids.has(id)) throw new Error('Two agent catalog entries share an id, or an id is not a slug');
    ids.add(id);
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}
