import Anthropic from '@anthropic-ai/sdk';
import { LIMITS } from '@ellai/core/limits';
import { safeFetch } from '@ellai/core/net';
import { z } from 'zod';
import { AgentTaskError, type PaidFetchInput, runAgentTask } from '../../../../../server/agent/run.js';
import { withServerContext } from '../../../../../server/http/context.js';
import { respond } from '../../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../../server/http/origin.js';
import { requireOwner } from '../../../../../server/http/session.js';
import { MEMORY_NAMESPACE } from '../../../../../server/memory/namespace.js';
import { makeRecall } from '../../../../../server/memory/recall.js';
import { paidFetch } from '../../../../../server/pay/flow.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAUDE_API = 'https://api.anthropic.com';
// Each code point of the task is at most 12 bytes once escaped as JSON, plus room for the key.
const TASK_BODY_MAX_BYTES = LIMITS.agentTaskMaxChars * 12 + 1_024;
// runAgentTask trims the task and counts it in code points; this only bounds what is read.
const body = z.strictObject({ task: z.string() });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The key stays on the server: it goes to the SDK and nowhere else. The base URL is pinned so
// no environment variable can send it to another host, and the SDK's own logging is off so
// ANTHROPIC_LOG can never print a request that carries the key or the owner's task (C19, 6n).
function claudeClient(apiKey: string | undefined): Anthropic | null {
  return apiKey === undefined ? null : new Anthropic({ apiKey, baseURL: CLAUDE_API, logLevel: 'off' });
}

/**
 * Runs one task with Ellai's built-in agent for the signed-in owner: { task } in, { status,
 * answer, steps } out (see runAgentTask). Every purchase goes through paidFetch with the
 * owner's built-in agent id and the same dependencies an agent route uses, so Ellai's gate
 * decides, signs and limits it (C16). The owner comes from the session alone (C13) and the
 * request must come from the app (C14). Without ANTHROPIC_API_KEY the answer is status
 * 'needs_key' and no model is called. 403 cross_origin, 401 signed_out, 400 for a bad body,
 * and 400 bad_task for a task that is empty or longer than LIMITS.agentTaskMaxChars.
 */
export async function POST(request: Request): Promise<Response> {
  return respond(() =>
    withServerContext(async (ctx) => {
      requireSameOrigin(request, ctx.env.APP_ORIGIN);
      const { ownerId } = await requireOwner(request, ctx);
      const { task } = await readJson(request, body, TASK_BODY_MAX_BYTES);
      const masterSecretHex = ctx.env.ELLAI_MASTER_SECRET;
      const paidFetchFor = (agentId: string, input: PaidFetchInput) =>
        paidFetch({
          db: ctx.db,
          ownerId,
          agentId,
          url: input.url,
          method: input.method,
          body: input.body,
          contentType: input.contentType,
          purpose: input.purpose,
          secrets: { masterSecretHex },
          deps: {
            fetch: safeFetch,
            chain: ctx.chain,
            recallFor: (owner) => makeRecall({ owner, masterSecretHex, namespace: MEMORY_NAMESPACE }),
            now: ctx.now,
            sleep,
          },
        });
      try {
        const result = await runAgentTask({
          db: ctx.db,
          ownerId,
          task,
          appOrigin: ctx.env.APP_ORIGIN,
          anthropic: claudeClient(ctx.env.ANTHROPIC_API_KEY),
          paidFetchFor,
          now: ctx.now,
        });
        return jsonResponse(result);
      } catch (error) {
        if (error instanceof AgentTaskError) return jsonResponse({ error: 'bad_task', message: error.message }, { status: 400 });
        throw error;
      }
    }),
  );
}
