import { canonicalSuiAddress } from '@ellai/core/keys';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { z } from 'zod';

// A line copied from .env.example arrives as an empty string. Treat it as unset so
// it is reported as missing instead of slipping through as a real value.
const blankIsMissing = (value: unknown): unknown => (value === '' ? undefined : value);

const HEX_64 = /^[0-9a-f]{64}$/i;
const AT_LEAST_32_BYTES_HEX = /^(?:[0-9a-f]{2}){32,}$/i;

function isEd25519SuiKey(value: string): boolean {
  try {
    const { scheme, secretKey } = decodeSuiPrivateKey(value);
    return scheme === 'ED25519' && secretKey.length === 32;
  } catch {
    return false;
  }
}

function isDatabaseUrl(value: string, allowLocalDatabase: boolean): boolean {
  if (value.startsWith('pglite:')) {
    if (!allowLocalDatabase) return false;
    const location = value.slice('pglite:'.length);
    return location.length > 0 && location.trim() === location;
  }
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
}

/**
 * Returns the URL's origin when the value is nothing but an origin, else null. A path,
 * query or credentials are refused rather than dropped, so the origin Ellai compares
 * requests against is exactly the one the operator wrote.
 */
function originOf(value: string, allowLocalHttp: boolean): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && allowLocalHttp && url.hostname === 'localhost' && url.port !== '') {
    return url.origin;
  }
  return null;
}

function origin(allowLocalHttp: boolean) {
  return z.string().transform((value, ctx) => {
    const parsed = originOf(value, allowLocalHttp);
    if (parsed === null) {
      ctx.addIssue({ code: 'custom', message: 'not an allowed origin' });
      return z.NEVER;
    }
    return parsed;
  });
}

const suiKey = z.string().startsWith('suiprivkey').refine(isEd25519SuiKey);

// Money sent to the zero address is gone for good, and buyers refuse a challenge that names it.
const ZERO_ADDRESS = canonicalSuiAddress('0x0');

const payToAddress = z.string().transform((value, ctx) => {
  let address: string;
  try {
    address = canonicalSuiAddress(value);
  } catch {
    address = ZERO_ADDRESS;
  }
  if (address === ZERO_ADDRESS) {
    ctx.addIssue({ code: 'custom', message: 'not a Sui address that can be paid' });
    return z.NEVER;
  }
  return address;
});

function envSchema(isLocal: boolean) {
  return z.object({
    DATABASE_URL: z.preprocess(blankIsMissing, z.string().refine((value) => isDatabaseUrl(value, isLocal))),
    ELLAI_MASTER_SECRET: z.preprocess(blankIsMissing, z.string().regex(HEX_64)),
    GAS_PRIVATE_KEY: z.preprocess(blankIsMissing, suiKey),
    TATUM_API_KEY: z.preprocess(blankIsMissing, z.string().optional()),
    MEMWAL_RELAYER_URL: z.preprocess(blankIsMissing, origin(false).optional()),
    ANTHROPIC_API_KEY: z.preprocess(blankIsMissing, z.string().optional()),
    SESSION_SECRET: z.preprocess(blankIsMissing, z.string().regex(AT_LEAST_32_BYTES_HEX)),
    JOBS_SECRET: z.preprocess(blankIsMissing, z.string().regex(AT_LEAST_32_BYTES_HEX)),
    APP_ORIGIN: z.preprocess(blankIsMissing, origin(isLocal)),
    ELLAI_SELLER_PAYTO: z.preprocess(blankIsMissing, payToAddress.optional()),
  });
}

export type ServerEnv = Readonly<z.infer<ReturnType<typeof envSchema>>>;

const VARIABLE_NAMES = Object.keys(envSchema(false).shape);

/**
 * Validates the environment variables the server needs.
 * Plain http is accepted for APP_ORIGIN only as http://localhost:<port>, and a pglite:
 * database only at all, and both only when NODE_ENV is "development" or "test". An unset
 * or unknown NODE_ENV counts as production, so a deploy that forgets to set it still
 * refuses an insecure origin and a database that would lose every payment record.
 * ELLAI_SELLER_PAYTO is optional and comes back in the one Sui address form used everywhere;
 * the zero address is refused. When it is unset the seller is paid to the gas wallet.
 * Throws an Error that names each bad variable and says whether it is missing or
 * malformed. The message never contains a value, and the zod error is not attached,
 * because its issues can carry the input.
 */
export function loadServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const isLocal = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const picked = Object.fromEntries(VARIABLE_NAMES.map((name) => [name, env[name]]));
  const result = envSchema(isLocal).safeParse(picked);
  if (result.success) return Object.freeze(result.data);

  const badNames = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  const described = badNames.map((name) => {
    const value = env[name];
    return `${name} (${value === undefined || value === '' ? 'missing' : 'malformed'})`;
  });
  throw new Error(`Invalid environment variable: ${described.join(', ')}`);
}

export const serverEnv: ServerEnv = loadServerEnv(process.env);
