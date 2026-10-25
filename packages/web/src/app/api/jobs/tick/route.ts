import { timingSafeEqual } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { readBearer } from '../../../../server/http/agent-auth.js';
import { withServerContext } from '../../../../server/http/context.js';
import { HttpError, respond } from '../../../../server/http/errors.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { pruneRateCounters } from '../../../../server/http/ratelimit.js';
import { errorCode, runJobsTick } from '../../../../server/jobs/tick.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Seconds this route may run, set here so the ceiling is Ellai's choice and not the platform's
// default. A tick reads the chain and Walrus Memory for many owners in turn.
export const maxDuration = 60;


const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// timingSafeEqual takes the same time whatever the bytes, but only for buffers of one length,
// so a value of another length is refused before any comparison. That says only that the
// length was wrong, and the secret is at least 64 hex characters, so its length is no help.
function isJobsSecret(sent: string | undefined, expected: string): boolean {
  if (sent === undefined) return false;
  const sentBytes = Buffer.from(sent, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return sentBytes.length === expectedBytes.length && timingSafeEqual(sentBytes, expectedBytes);
}

/**
 * Runs one jobs tick: the scheduler's call, with `Authorization: Bearer <JOBS_SECRET>` compared
 * in constant time; anything else is 401 jobs_unauthorized and nothing runs. Then deletes rate
 * counters older than LIMITS.rateCounterRetentionMs, which outlives the longest window that reads them. Answers with runJobsTick's summary: counts,
 * owner ids and fixed codes only, never an error message or a value (C19). A failure to
 * prune is recorded in the summary under the step 'rate_counters' and does not hide the tick.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      if (!isJobsSecret(readBearer(request), ctx.env.JOBS_SECRET)) throw new HttpError(401, 'jobs_unauthorized');
      const summary = await runJobsTick({
        db: ctx.db,
        chain: ctx.chain,
        masterSecretHex: ctx.env.ELLAI_MASTER_SECRET,
        gasKeypair: Ed25519Keypair.fromSecretKey(ctx.env.GAS_PRIVATE_KEY),
        now: ctx.now,
        sleep,
      });
      try {
        await pruneRateCounters(ctx.db, ctx.now());
      } catch (error) {
        summary.errors.push({ ownerId: '', step: 'rate_counters', code: errorCode(error) });
      }
      return jsonResponse(summary);
    }),
  );
}
