import { hkdfSync } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

// Changing the salt, the info layout or the seed length moves every purse to a new
// address and strands the money in the old one. Treat all three as frozen.
const DERIVATION_SALT = Buffer.from('ellai/v1', 'utf8');
const ED25519_SEED_BYTES = 32;
const MASTER_SECRET_PATTERN = /^[0-9a-f]{64}$/i;

type Purpose = 'purse' | 'memwal-delegate';

function masterSecretBytes(masterSecretHex: string): Buffer {
  // Buffer.from(hex) silently stops at the first bad character, so check first.
  if (!MASTER_SECRET_PATTERN.test(masterSecretHex)) {
    throw new Error('Master secret must be exactly 64 hex characters');
  }
  return Buffer.from(masterSecretHex, 'hex');
}

/**
 * The one address parser for this package: the SDK normaliser, then the SDK validity
 * check. Every address that is derived from, queried or compared goes through it.
 * Throws on an empty value or anything that is not a 32-byte hex Sui address. The
 * message never repeats the input.
 */
export function canonicalSuiAddress(address: string): string {
  // normalizeSuiAddress pads an empty string or a bare "0x" into the zero address,
  // which would quietly give every caller with a missing address the same purse.
  if (address.replace(/^0x/i, '') === '') {
    throw new Error('Sui address is empty');
  }
  const normalized = normalizeSuiAddress(address);
  if (!isValidSuiAddress(normalized)) {
    throw new Error('Not a valid Sui address');
  }
  return normalized;
}

function deriveKeypair(purpose: Purpose, masterSecretHex: string, ownerAddress: string): Ed25519Keypair {
  const info = Buffer.from(`${purpose}:${canonicalSuiAddress(ownerAddress)}`, 'utf8');
  const seed = hkdfSync('sha256', masterSecretBytes(masterSecretHex), DERIVATION_SALT, info, ED25519_SEED_BYTES);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed));
}

/**
 * Derives the owner's purse key: the address Ellai pays sellers from on that owner's behalf.
 * The same master secret and owner always give the same key, so nothing per owner is stored.
 * Throws if the master secret is not 64 hex characters or the address is not a Sui address.
 */
export function derivePurseKeypair(masterSecretHex: string, ownerAddress: string): Ed25519Keypair {
  return deriveKeypair('purse', masterSecretHex, ownerAddress);
}

/**
 * Derives the owner's Walrus Memory delegate key, which Ellai uses to write and recall
 * that owner's memories. It is a different key from the purse, so leaking one derived
 * key does not expose the other. Throws on the same inputs as derivePurseKeypair.
 */
export function deriveMemwalDelegateKeypair(masterSecretHex: string, ownerAddress: string): Ed25519Keypair {
  return deriveKeypair('memwal-delegate', masterSecretHex, ownerAddress);
}
