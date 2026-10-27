import { scoped, withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { cachedMemoryMap, readMemoryMap } from '../../../../server/public/proof.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The map of Ellai's learning the landing page draws, for anyone, with no session, and only for
 * owners who opted in (owners.public_proof, off by default): owner answers by blob id that
 * Walrus Memory confirmed and the jobs tick then found on chain and has not seen expire, and the
 * latest decisions with the answers each one cited and how close recall found each (C18).
 * Nothing an owner or an agent wrote, and no owner, agent or address, is in it (C17, C19).
 * Served from a process cache read at most once per LIMITS.publicProofCacheMs, with no chain or
 * relayer call, and the database is opened only for that one read (C22). 503 proof_unavailable
 * when the first read of a window fails and there is no earlier copy.
 */
export const GET = scoped('anyone', async (): Promise<Response> => {
  return respond(async () => jsonResponse(await cachedMemoryMap(() => withServerContext((ctx) => readMemoryMap(ctx.db, ctx.now())), Date.now())));
});
