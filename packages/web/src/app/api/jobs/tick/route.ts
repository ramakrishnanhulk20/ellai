import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { scoped } from '../../../../server/http/context.js';
import { jsonResponse } from '../../../../server/http/json.js';
import { pruneRateCounters } from '../../../../server/http/ratelimit.js';
import { errorCode, runJobsTick } from '../../../../server/jobs/tick.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Seconds this route may run, so the ceiling is Ellai's choice and not the platform's default.
// Next.js reads this export without running the module, so it is written as the literal value of
// LIMITS.slowRouteMaxDurationS, and a test holds the two equal. A tick reads the chain and
// Walrus Memory for many owners in turn.
export const maxDuration = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one jobs tick: the scheduler's call, with `Authorization: Bearer <JOBS_SECRET>` compared
 * in constant time by scoped('jobs'); anything else is 401 jobs_unauthorized, with errors.ts's
 * `WWW-Authenticate: Bearer realm="ellai-jobs"`, and nothing runs. The tick's Tatum requests
 * count against the jobs budget alone (LIMITS.tatumCallsJobsPerDay). Then deletes rate
 * counters older than LIMITS.rateCounterRetentionMs, which outlives the longest window that reads them. Answers with runJobsTick's summary: counts,
 * owner ids and fixed codes only, never an error message or a value (C19). A failure to
 * prune is recorded in the summary under the step 'rate_counters' and does not hide the tick.
 */
export const POST = scoped('jobs', async (_request, ctx): Promise<Response> => {
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
});
