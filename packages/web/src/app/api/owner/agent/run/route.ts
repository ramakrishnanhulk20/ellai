import Anthropic from '@anthropic-ai/sdk';
import { LIMITS } from '@ellai/core/limits';
import { z } from 'zod';
import { AGENT_MODEL_RETRIES, AgentTaskError, type PaidFetchInput, runAgentTask } from '../../../../../server/agent/run.js';
import { withServerContext } from '../../../../../server/http/context.js';
import { respond } from '../../../../../server/http/errors.js';
import { jsonResponse, readJson } from '../../../../../server/http/json.js';
import { requireSameOrigin } from '../../../../../server/http/origin.js';
import { requireOwner } from '../../../../../server/http/session.js';
import { agentPaidFetch } from '../../../../../server/mcp/server.js';
import type { PaidFetchResult } from '../../../../../server/pay/result.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Seconds this route may run, set here so the ceiling is Ellai's choice and not the platform's
// default. A run waits on the model and on paid calls, each of which can wait on a seller.
export const maxDuration = 60;

const CLAUDE_API = 'https://api.anthropic.com';
// Each code point of the task is at most 12 bytes once escaped as JSON, plus room for the key.
const TASK_BODY_MAX_BYTES = LIMITS.agentTaskMaxChars * 12 + 1_024;
// runAgentTask trims the task and counts it in code points; this only bounds what is read.
const body = z.strictObject({ task: z.string() });

// The key stays on the server: it goes to the SDK and nowhere else. The base URL is pinned so
// no environment variable can send it to another host, and the SDK's own logging is off so
// ANTHROPIC_LOG can never print a request that carries the key or the owner's task (C19, 6n).
// The SDK's own wait is ten minutes a try, so each try is held to Ellai's limit instead (C21).
function claudeClient(apiKey: string | undefined): Anthropic | null {
  if (apiKey === undefined) return null;
  return new Anthropic({ apiKey, baseURL: CLAUDE_API, logLevel: 'off', timeout: LIMITS.agentModelTimeoutMs, maxRetries: AGENT_MODEL_RETRIES });
}

/**
 * Runs one task with Ellai's built-in agent for the signed-in owner: { task } in, { status,
 * answer, steps } out (see runAgentTask). Every purchase goes through agentPaidFetch, the entry
 * an outside agent's call takes, with the owner's built-in agent id, so Ellai's gate decides
 * and signs it and the same per-agent and per-owner pay limits count it (C16, C22). A call past
 * either ends the run 'stopped'. The owner comes from the session alone (C13) and the
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
      const paidFetchFor = async (agentId: string, input: PaidFetchInput): Promise<PaidFetchResult> => {
        const fetched = await agentPaidFetch(
          ctx,
          { ownerId, agentId },
          { url: input.url, method: input.method, body: input.body ?? undefined, contentType: input.contentType ?? undefined, purpose: input.purpose },
        );
        // runAgentTask labels the seller's answer as untrusted itself, under its own name.
        const { sellerBodyIsUntrusted: _labelled, ...result } = fetched;
        return result;
      };
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
