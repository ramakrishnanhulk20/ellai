import { LIMITS } from '@ellai/core/limits';
import { recallSentences } from '@ellai/core/memory';
import { ownerMemoryClient } from './delegate.js';

// Cosine distance runs from 0 to 2, so this keeps every hit the relayer ranks. The owner's
// own cutoff is applied by the rules, which also need the full count to tell when the
// result limit may have cut off a closer hit (C12).
const NO_CUTOFF = LIMITS.recallDistanceMax;

/**
 * The recall decide calls for one owner: a search by meaning in `namespace` of the owner's
 * own Walrus Memory account, signed by Ellai's derived delegate key, returning each hit's
 * blob id and distance and never its sentence. Every failure is a rejection, which decide
 * counts as a failed recall and answers by asking (C12): no account (MemoryServiceError
 * NO_ACCOUNT, before any client exists), a bad master secret, and any MemoryError from
 * recallSentences, which refuses the whole answer when any hit's distance is missing or outside
 * 0 to LIMITS.recallDistanceMax. A delegate key that has spent its relayer points for the
 * minute is refused at once with MemoryError RATE_LIMITED and nothing sent, never waited for, so
 * a paid request asks instead of stalling. One client per call, destroyed after it.
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
      // A wait for points can outlast decide's own recall timeout and send the search after decide has already asked.
      const hits = await recallSentences(client, namespace, query, { limit, maxDistance: NO_CUTOFF }, { waitForPoints: false });
      return hits.map(({ blobId, distance }) => ({ blobId, distance }));
    } finally {
      client.destroy();
    }
  };
}
