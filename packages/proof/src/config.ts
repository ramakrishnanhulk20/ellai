import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { z } from 'zod';

// A line copied from .env.example arrives as an empty string. Treat it as unset so
// it is reported as missing instead of slipping through as a real value.
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

const envSchema = z.object({
  SUI_NETWORK: z.preprocess(blankIsMissing, z.literal('mainnet')),
  TATUM_API_KEY: z.preprocess(blankIsMissing, z.string().optional()),
  ELLAI_MASTER_SECRET: z.preprocess(blankIsMissing, z.string().regex(/^[0-9a-f]{64}$/i)),
  OWNER_TEST_PRIVATE_KEY: z.preprocess(blankIsMissing, suiKey),
  GAS_PRIVATE_KEY: z.preprocess(blankIsMissing, suiKey),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

const VARIABLE_NAMES = Object.keys(envSchema.shape);

/**
 * Validates the environment variables the proof package needs.
 * Throws an Error that names each bad variable and says whether it is missing or
 * malformed. The message never contains a value, and the zod error is not attached,
 * because its issues can carry the input.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const picked = Object.fromEntries(VARIABLE_NAMES.map((name) => [name, env[name]]));
  const result = envSchema.safeParse(picked);
  if (result.success) return Object.freeze(result.data);

  const badNames = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  const described = badNames.map((name) => {
    const value = env[name];
    return `${name} (${value === undefined || value === '' ? 'missing' : 'malformed'})`;
  });
  throw new Error(`Invalid environment variable: ${described.join(', ')}`);
}

export const config: Config = loadConfig(process.env);
