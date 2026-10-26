import { LIMITS } from '@ellai/core/limits';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { AGENT_KINDS, TEXT_CAPS, agents, owners } from '../db/schema.js';
import { AGENT_TOKEN_PREFIX, hashBearerToken, isBearerToken, newBearerToken } from './tokens.js';

export type AgentErrorCode = 'BAD_INPUT' | 'NOT_FOUND' | 'TOO_MANY_AGENTS';

/** Every refusal from the agent functions. The message is fixed text and never repeats input. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export interface AgentSummary {
  agentId: string;
  label: string;
  kind: (typeof AGENT_KINDS)[number];
  displayPrefix: string;
  createdAt: Date;
  revokedAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Format characters (bidi overrides, zero-width joiners) and line or paragraph separators too: a
// label is shown in the wallet message the owner signs, and these can make it read as other text.
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function bad(message: string): never {
  throw new AgentError('BAD_INPUT', message);
}

function checkUuid(value: unknown, message: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) bad(message);
  return value.toLowerCase();
}

function checkNow(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('The current time is not a date');
  return now;
}

/** Trimmed, 1 to TEXT_CAPS.agentLabel code points, no control or format characters. Throws AgentError BAD_INPUT. */
export function checkLabel(label: unknown): string {
  if (typeof label !== 'string') bad('the label must be text');
  const trimmed = label.trim();
  // Counted in code points, as Postgres counts the column cap.
  const length = Array.from(trimmed).length;
  if (length === 0 || length > TEXT_CAPS.agentLabel) bad(`the label must be 1 to ${TEXT_CAPS.agentLabel} characters`);
  if (CONTROL_CHARACTER.test(trimmed)) bad('the label must not contain control characters');
  return trimmed;
}

/**
 * Creates an agent for an owner and its bearer token (C13). Only the token's hash and its
 * display prefix are stored; the token itself is returned here once and can never be read
 * back. The label is trimmed and must be 1 to TEXT_CAPS.agentLabel characters with no
 * control characters. An owner holds at most LIMITS.agentsPerOwnerMax external agents that are
 * not revoked: the count and the insert run in one transaction holding the owner row FOR
 * UPDATE, so two creates at once can never both take the last place. The built-in agent is not
 * counted, so an owner at the cap can still run it; the agents_one_live_builtin_per_owner index
 * holds each owner to one live built-in agent.
 * Throws AgentError: BAD_INPUT, NOT_FOUND (no such owner), TOO_MANY_AGENTS (the owner already
 * holds the most external agents). Throws Error if `now` is not a date or the secret is malformed.
 */
export async function createAgentToken(args: {
  db: Database;
  ownerId: string;
  label: string;
  kind: 'external' | 'builtin';
  sessionSecretHex: string;
  now: Date;
}): Promise<{ agentId: string; token: string; displayPrefix: string }> {
  const ownerId = checkUuid(args.ownerId, 'the owner id is not a uuid');
  const label = checkLabel(args.label);
  if (!(AGENT_KINDS as readonly string[]).includes(args.kind)) bad('the agent kind must be external or builtin');
  const now = checkNow(args.now);
  const minted = newBearerToken(AGENT_TOKEN_PREFIX, args.sessionSecretHex);

  return args.db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
    if (owner === undefined) throw new AgentError('NOT_FOUND', 'there is no such owner');
    if (args.kind === 'external') {
      const [held] = await tx
        .select({ n: count() })
        .from(agents)
        .where(and(eq(agents.ownerId, ownerId), eq(agents.kind, 'external'), isNull(agents.revokedAt)));
      if ((held?.n ?? 0) >= LIMITS.agentsPerOwnerMax) {
        throw new AgentError('TOO_MANY_AGENTS', `an owner may hold at most ${LIMITS.agentsPerOwnerMax} agents at once; revoke one first`);
      }
    }
    const [agent] = await tx
      .insert(agents)
      .values({ ownerId, label, kind: args.kind, tokenHash: minted.hash, tokenPrefix: minted.displayPrefix, createdAt: now })
      .returning({ id: agents.id });
    if (agent === undefined) throw new Error('The agent insert returned no row');
    return { agentId: agent.id, token: minted.token, displayPrefix: minted.displayPrefix };
  });
}

/**
 * Revokes one of this owner's agents by setting its revoked_at to `now`. From that moment
 * authenticateAgent refuses its token. Revoking an agent that is already revoked keeps the
 * first time and succeeds.
 * The revoke runs in one transaction holding the owner row FOR UPDATE, the lock
 * signForDecision holds while it reads the agent and signs, so a revoke and a signature for
 * this owner run one after the other and never interleave (C13): a signature that took the
 * lock first finishes before the revoke lands, and one that comes after reads the agent revoked.
 * Throws AgentError: BAD_INPUT, NOT_FOUND, which is also what another owner's agent gives,
 * so the answer never reveals that an id exists elsewhere. Throws Error if `now` is not a
 * date.
 */
export async function revokeAgent(args: { db: Database; ownerId: string; agentId: string; now: Date }): Promise<void> {
  const ownerId = checkUuid(args.ownerId, 'the owner id is not a uuid');
  const agentId = checkUuid(args.agentId, 'the agent id is not a uuid');
  const now = checkNow(args.now);
  const notFound = () => new AgentError('NOT_FOUND', 'there is no such agent for this owner');
  const thisOwnersAgent = and(eq(agents.id, agentId), eq(agents.ownerId, ownerId));
  await args.db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
    if (owner === undefined) throw notFound();
    const revoked = await tx
      .update(agents)
      .set({ revokedAt: now })
      .where(and(thisOwnersAgent, isNull(agents.revokedAt)))
      .returning({ id: agents.id });
    if (revoked.length === 1) return;
    const [existing] = await tx.select({ id: agents.id }).from(agents).where(thisOwnersAgent);
    if (existing === undefined) throw notFound();
  });
}

/**
 * This owner's agents, revoked ones included, oldest first. The columns are named one by
 * one, so the token hash is never read. Throws AgentError BAD_INPUT for a malformed owner id.
 */
export async function listAgents(args: { db: Database; ownerId: string }): Promise<AgentSummary[]> {
  const ownerId = checkUuid(args.ownerId, 'the owner id is not a uuid');
  return args.db
    .select({
      agentId: agents.id,
      label: agents.label,
      kind: agents.kind,
      displayPrefix: agents.tokenPrefix,
      createdAt: agents.createdAt,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .where(eq(agents.ownerId, ownerId))
    .orderBy(asc(agents.createdAt), asc(agents.id));
}

/**
 * The agent and owner an agent token belongs to, or null for a missing, malformed,
 * unknown or revoked token (C13). Anything that is not exactly an agent token, including a
 * session token, is refused before any query. One lookup by the token's hash; the owner
 * comes only from the agent row, never from anything else the caller sends. Throws Error
 * if the secret is malformed.
 */
export async function authenticateAgent(args: {
  db: Database;
  token: string | undefined;
  sessionSecretHex: string;
}): Promise<{ ownerId: string; agentId: string } | null> {
  if (!isBearerToken(args.token, AGENT_TOKEN_PREFIX)) return null;
  const hash = hashBearerToken(args.token, args.sessionSecretHex);
  if (hash === null) return null;
  const [row] = await args.db
    .select({ ownerId: agents.ownerId, agentId: agents.id, revokedAt: agents.revokedAt })
    .from(agents)
    .where(eq(agents.tokenHash, hash));
  if (row === undefined || row.revokedAt !== null) return null;
  return { ownerId: row.ownerId, agentId: row.agentId };
}
