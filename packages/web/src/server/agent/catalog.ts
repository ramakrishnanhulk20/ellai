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

function walletCheckUrl(appOrigin: string): string {
  if (typeof appOrigin !== 'string' || !URL.canParse(appOrigin)) throw new Error('The app origin is not a URL');
  const origin = new URL(appOrigin).origin;
  if (origin === 'null') throw new Error('The app origin is not an origin');
  return `${origin}${WALLET_CHECK_PATH}`;
}

/**
 * The only sellers the built-in agent can call (C7, C20): Ellai's own wallet check at
 * appOrigin + /api/sell/wallet-check, then every seller in core's KNOWN_SELLERS with a
 * documented body and content type, with that body as the example. Each id is a slug made
 * from the seller's host and path. The model names an id; the URL, method and content type
 * always come from here. Throws Error when appOrigin is not an origin, or when two sellers
 * would share an id, which is a configuration bug.
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
    ...KNOWN_SELLERS.filter(hasDocumentedRequest).map((seller) => ({
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
