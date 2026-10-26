import { scoped, withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { cachedPublicProof, readPublicProof } from '../../../../server/public/proof.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What Ellai really did, for anyone, with no session, and only for owners who opted in
 * (owners.public_proof, off by default), since each digest leads on chain to an owner's purse
 * and wallet: totals over those owners, the latest payments Ellai verified on chain by its own
 * digest, with explorer links, and the latest memory writes by blob id and kind, each one both
 * confirmed by Walrus Memory and then found among the owner's Walrus Blob objects on chain by
 * the jobs tick (C18). A memory not found on chain within LIMITS.blobChainCheckMaxAgeMs of its
 * confirmation is never shown. Nothing an owner or an agent wrote, and no owner address, is in it. Served from
 * a process cache read at most once per LIMITS.publicProofCacheMs, and the database is opened
 * only for that one read, so no anonymous request costs more (C22). 503 proof_unavailable when
 * the first read of a window fails and there is no earlier copy.
 */
export const GET = scoped('anyone', async (): Promise<Response> => {
  return respond(async () => jsonResponse(await cachedPublicProof(() => withServerContext((ctx) => readPublicProof(ctx.db)), Date.now())));
});
