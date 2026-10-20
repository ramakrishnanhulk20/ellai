// Covers: per-owner key derivation, its determinism, its separation by owner and by
// purpose, address normalisation and refusal of bad input.
// Does NOT cover: whether a derived address holds funds or is registered as a Walrus
// Memory delegate on chain, or protection of the master secret at rest.
import { hkdfSync, randomBytes } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';
import { deriveMemwalDelegateKeypair, derivePurseKeypair } from '../src/keys.js';

const MASTER = randomBytes(32).toString('hex');
const OWNER_A = `0x${randomBytes(32).toString('hex')}`;
const OWNER_B = `0x${randomBytes(32).toString('hex')}`;

function publicKeyHex(keypair: Ed25519Keypair): string {
  return toHex(keypair.getPublicKey().toRawBytes());
}

describe('derivePurseKeypair and deriveMemwalDelegateKeypair', () => {
  it('give the same key for the same inputs', () => {
    expect(derivePurseKeypair(MASTER, OWNER_A).getSecretKey()).toBe(derivePurseKeypair(MASTER, OWNER_A).getSecretKey());
    expect(deriveMemwalDelegateKeypair(MASTER, OWNER_A).getSecretKey()).toBe(
      deriveMemwalDelegateKeypair(MASTER, OWNER_A).getSecretKey(),
    );
  });

  it('give two owners different keys', () => {
    expect(derivePurseKeypair(MASTER, OWNER_A).toSuiAddress()).not.toBe(derivePurseKeypair(MASTER, OWNER_B).toSuiAddress());
    expect(publicKeyHex(deriveMemwalDelegateKeypair(MASTER, OWNER_A))).not.toBe(
      publicKeyHex(deriveMemwalDelegateKeypair(MASTER, OWNER_B)),
    );
  });

  it('give the two purposes different keys for one owner', () => {
    expect(publicKeyHex(derivePurseKeypair(MASTER, OWNER_A))).not.toBe(
      publicKeyHex(deriveMemwalDelegateKeypair(MASTER, OWNER_A)),
    );
  });

  it('give the short, long, upper case and unprefixed forms of one address the same key', () => {
    const long = `0x${'0'.repeat(60)}0abc`;
    const expected = derivePurseKeypair(MASTER, long).toSuiAddress();
    for (const form of ['0xabc', '0x0abc', '0xABC', '0XAbC', 'abc', `0x${'0'.repeat(60)}0ABC`]) {
      expect(derivePurseKeypair(MASTER, form).toSuiAddress()).toBe(expected);
    }
  });

  it('throw on anything that is not a Sui address', () => {
    for (const bad of ['', '0x', 'hello', '0xzz', ' 0x2', `0x${'1'.repeat(65)}`, `${OWNER_A}00`]) {
      expect(() => derivePurseKeypair(MASTER, bad)).toThrow(/Sui address/);
      expect(() => deriveMemwalDelegateKeypair(MASTER, bad)).toThrow(/Sui address/);
    }
  });

  it('throw on a master secret that is not 64 hex characters', () => {
    for (const bad of ['', MASTER.slice(2), `${MASTER.slice(1)}g`, `0x${MASTER}`]) {
      expect(() => derivePurseKeypair(bad, OWNER_A)).toThrow(/Master secret/);
    }
  });

  it('follow the frozen derivation: HKDF-SHA256, salt ellai/v1, info purpose:normalised owner', () => {
    const master = '11'.repeat(32);
    const owner = `0x${'0'.repeat(63)}2`;
    const seed = hkdfSync('sha256', Buffer.from(master, 'hex'), Buffer.from('ellai/v1'), Buffer.from(`purse:${owner}`), 32);
    expect(derivePurseKeypair(master, '0x2').getSecretKey()).toBe(Ed25519Keypair.fromSecretKey(new Uint8Array(seed)).getSecretKey());

    // Pinned so a refactor cannot move every purse to a new address unnoticed.
    expect(derivePurseKeypair(master, '0x2').toSuiAddress()).toBe(
      '0x2e74aa5132535374667f8ff3f88bc50b4787cdc804c943fde880a736984ab0cc',
    );
    expect(publicKeyHex(deriveMemwalDelegateKeypair(master, '0x2'))).toBe(
      '75193de0edf3ec72680125dedaf3436c7dea52ba735a142580bdb07ac6609101',
    );
  });
});
