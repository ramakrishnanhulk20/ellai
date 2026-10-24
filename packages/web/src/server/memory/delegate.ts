import { deriveMemwalDelegateKeypair } from '@ellai/core/keys';
import { createMemoryClient } from '@ellai/core/memory';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';

export type MemoryServiceErrorCode = 'BAD_INPUT' | 'OWNER' | 'NO_ACCOUNT' | 'DECISION' | 'SEND_UNCERTAIN';

/** Every refusal from the memory service. The message is fixed text plus counts: no key, sentence or upstream text (C19). */
export class MemoryServiceError extends Error {
  readonly code: MemoryServiceErrorCode;

  constructor(code: MemoryServiceErrorCode, message: string) {
    super(message);
    this.name = 'MemoryServiceError';
    this.code = code;
  }
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/**
 * Ellai's Walrus Memory delegate key for one owner, derived from the master secret, with its
 * public key as 64 lowercase hex characters: the form decide, answerQuestion and recordOutcome
 * record as a memory's writer, so only memories this key wrote can earn trust (C9).
 * Throws on a master secret that is not 64 hex characters or an owner that is not a Sui address.
 */
export function ownerDelegate(masterSecretHex: string, ownerAddress: string): { keypair: Ed25519Keypair; publicKeyHex: string } {
  const keypair = deriveMemwalDelegateKeypair(masterSecretHex, ownerAddress);
  const publicKeyHex = toHex(keypair.getPublicKey().toRawBytes());
  if (!HEX_32_BYTES.test(publicKeyHex)) throw new Error('the delegate public key is not 32 bytes');
  return { keypair, publicKeyHex };
}

/**
 * A Walrus Memory client signing as the owner's derived delegate on the owner's own account,
 * and that delegate's public key. Makes no network call; the caller destroys the client.
 * Throws MemoryServiceError NO_ACCOUNT when the owner has no account yet, and MemoryError
 * ACCOUNT from core for an account id that is not a Sui object id.
 */
export function ownerMemoryClient(
  owner: { suiAddress: string; memwalAccountId: string | null },
  masterSecretHex: string,
): { client: ReturnType<typeof createMemoryClient>; publicKeyHex: string } {
  if (typeof owner.memwalAccountId !== 'string' || owner.memwalAccountId === '') {
    throw new MemoryServiceError('NO_ACCOUNT', 'the owner has no Walrus Memory account yet');
  }
  const { keypair, publicKeyHex } = ownerDelegate(masterSecretHex, owner.suiAddress);
  return { client: createMemoryClient({ delegate: keypair, accountId: owner.memwalAccountId }), publicKeyHex };
}
