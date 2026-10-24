import { createHmac, randomBytes } from 'node:crypto';
import { LIMITS } from '@ellai/core/limits';
import { TEXT_CAPS } from '../db/schema.js';

// Each kind of token has its own prefix, so a session token is never accepted where an
// agent token is expected or the other way round, and neither can ever equal a record id.
export const SESSION_TOKEN_PREFIX = 'ellai_session_';
export const AGENT_TOKEN_PREFIX = 'ellai_agent_';
export type BearerTokenPrefix = typeof SESSION_TOKEN_PREFIX | typeof AGENT_TOKEN_PREFIX;

// Unpadded base64url spends four characters on every three bytes, rounded up.
const BODY_CHARS = Math.ceil((LIMITS.bearerTokenBytes * 4) / 3);
const BODY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${BODY_CHARS}}$`);
const SECRET_PATTERN = /^(?:[0-9a-f]{2}){32,}$/i;

function secretKey(secretHex: string): Buffer {
  // Buffer.from(hex) silently stops at the first bad character, which would quietly
  // shorten the key, so the whole value is checked first.
  if (typeof secretHex !== 'string' || !SECRET_PATTERN.test(secretHex)) {
    throw new Error('The session secret must be at least 32 bytes written as hex');
  }
  return Buffer.from(secretHex, 'hex');
}

// Tokens are found by this keyed hash. The caller never knows the key, so the value an
// indexed lookup compares is one they can neither choose nor predict, and how long the
// lookup takes tells them nothing that helps forge a token (C13). A copy of the database
// alone also cannot be used to check a guessed token.
function keyedHash(token: string, key: Buffer): string {
  return createHmac('sha256', key).update(token, 'utf8').digest('hex');
}

/**
 * Whether a value has exactly the shape newBearerToken makes for this prefix: the prefix,
 * then LIMITS.bearerTokenBytes bytes as unpadded base64url. Never throws.
 */
export function isBearerToken(token: unknown, prefix: BearerTokenPrefix): token is string {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return false;
  return BODY_PATTERN.test(token.slice(prefix.length));
}

/**
 * Makes a new bearer token: the prefix, then LIMITS.bearerTokenBytes random bytes as
 * unpadded base64url.
 * Returns the token, which is shown to its holder once and never stored; its HMAC-SHA256
 * under the session secret as 64 hex characters, which is what the database stores and
 * looks up; and its first TEXT_CAPS.tokenPrefix characters for display.
 * Throws if the prefix is not one of the two token prefixes, or if secretHex is not at
 * least 32 bytes written as hex. The message never contains the secret.
 */
export function newBearerToken(prefix: BearerTokenPrefix, secretHex: string): { token: string; hash: string; displayPrefix: string } {
  const key = secretKey(secretHex);
  if (prefix !== SESSION_TOKEN_PREFIX && prefix !== AGENT_TOKEN_PREFIX) throw new Error('Unknown bearer token prefix');
  const token = prefix + randomBytes(LIMITS.bearerTokenBytes).toString('base64url');
  return { token, hash: keyedHash(token, key), displayPrefix: token.slice(0, TEXT_CAPS.tokenPrefix) };
}

/**
 * The stored hash of a bearer token of either kind, or null for any value that is not
 * exactly the shape newBearerToken makes, so junk never reaches a database query. A caller
 * that accepts only one kind checks isBearerToken with that prefix as well.
 * Throws if secretHex is not at least 32 bytes written as hex.
 */
export function hashBearerToken(token: string, secretHex: string): string | null {
  const key = secretKey(secretHex);
  if (!isBearerToken(token, SESSION_TOKEN_PREFIX) && !isBearerToken(token, AGENT_TOKEN_PREFIX)) return null;
  return keyedHash(token, key);
}
