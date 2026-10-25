import { withServerContext } from '../../../../server/http/context.js';
import { respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { cachedPublicProof, readPublicProof } from '../../../../server/public/proof.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What Ellai really did, for anyone, with no session: totals, the 20 latest payments Ellai
 * verified on chain with explorer links, and the 20 latest confirmed memory writes by blob id
 * and kind (C18). Nothing an owner or an agent wrote, and no owner address, is in it. Served from
 * a process cache read at most once per LIMITS.publicProofCacheMs, and the database is opened
 * only for that one read, so no anonymous request costs more (C22). 503 proof_unavailable when
 * the first read of a window fails and there is no earlier copy.
 */
export async function GET(): Promise<Response> {
  return respond(async () => jsonResponse(await cachedPublicProof(() => withServerContext((ctx) => readPublicProof(ctx.db)), Date.now())));
}
