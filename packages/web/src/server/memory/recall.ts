import { recallSentences } from '@ellai/core/memory';
import { ownerMemoryClient } from './delegate.js';

// Cosine distance runs from 0 to 2, so this keeps every hit the relayer ranks. The owner's
// own cutoff is applied by the rules, which also need the full count to tell when the
// result limit may have cut off a closer hit (C12).
const NO_CUTOFF = 2;

/**
 * The recall decide calls for one owner: a search by meaning in `namespace` of the owner's
 * own Walrus Memory account, signed by Ellai's derived delegate key, returning each hit's
 * blob id and distance and never its sentence. Every failure is a rejection, which decide
 * counts as a failed recall and answers by asking (C12): no account (MemoryServiceError
 * NO_ACCOUNT, before any client exists), a bad master secret, and any MemoryError from
 * recallSentences. One client per call, destroyed after it.
 */
export function makeRecall(args: {
  owner: { suiAddress: string; memwalAccountId: string | null };
  masterSecretHex: string;
  namespace: string;
}): (query: string, limit: number) => Promise<Array<{ blobId: string; distance: number }>> {
  const { owner, masterSecretHex, namespace } = args;
  return async (query, limit) => {
    const { client } = ownerMemoryClient(owner, masterSecretHex);
    try {
      const hits = await recallSentences(client, namespace, query, { limit, maxDistance: NO_CUTOFF });
      return hits.map(({ blobId, distance }) => ({ blobId, distance }));
    } finally {
      client.destroy();
    }
  };
}
