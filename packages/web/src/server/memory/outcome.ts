import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, memories, owners } from '../db/schema.js';
import { outcomeSentence } from '../decide/sentences.js';
import { MemoryServiceError } from './delegate.js';
import { MEMORY_NAMESPACE } from './namespace.js';

export interface OutcomeArgs {
  db: Database;
  ownerId: string;
  decisionId: string;
  delivered: boolean;
  /** The owner's Ellai delegate key, as 64 lowercase hex characters, recorded as the memory's writer. */
  delegatePublicKeyHex: string;
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

function bad(message: string): never {
  throw new MemoryServiceError('BAD_INPUT', message);
}

/**
 * Records what a paid seller did for one of the owner's decisions as a pending 'outcome'
 * memory in MEMORY_NAMESPACE: the decision's recipient, amount and seller host, no verdict,
 * and the sentence from outcomeSentence. An outcome never counts as an approval, because only
 * an owner_decision row can (C9). Nothing is sent to Walrus here; submitPendingMemories does that.
 *
 * Idempotent per decision: the owner row and then the decision row are locked FOR UPDATE, in
 * the order answerQuestion takes them, and an outcome already recorded for the decision is
 * returned as it is, so two calls never write two outcomes.
 *
 * Throws MemoryServiceError: BAD_INPUT, DECISION (no such decision for this owner, including
 * another owner's).
 */
export async function recordOutcome(args: OutcomeArgs): Promise<{ memoryId: string }> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) bad('the owner id is not a uuid');
  if (typeof args.decisionId !== 'string' || !UUID.test(args.decisionId)) bad('the decision id is not a uuid');
  if (typeof args.delivered !== 'boolean') bad('delivered must be true or false');
  if (typeof args.delegatePublicKeyHex !== 'string' || !HEX_32_BYTES.test(args.delegatePublicKeyHex)) {
    bad('the delegate public key must be 64 lowercase hex characters');
  }
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) bad('the current time is not a date');
  const ownerId = args.ownerId.toLowerCase();
  const decisionId = args.decisionId.toLowerCase();
  const { delivered, now } = args;

  return args.db.transaction(async (tx) => {
    // The insert's foreign keys take a share lock on the owner row, so locking the decision
    // first would deadlock against answerQuestion, which holds the owner and waits for the decision.
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
    const thisDecision = and(eq(decisions.id, decisionId), eq(decisions.ownerId, ownerId));
    const [decision] = owner === undefined ? [] : await tx.select().from(decisions).where(thisDecision).for('update');
    if (decision === undefined) throw new MemoryServiceError('DECISION', 'there is no such decision for this owner');

    const [recorded] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.ownerId, ownerId), eq(memories.decisionId, decisionId), eq(memories.kind, 'outcome')))
      .orderBy(asc(memories.createdAt), asc(memories.id))
      .limit(1);
    if (recorded !== undefined) return { memoryId: recorded.id };

    const [memory] = await tx
      .insert(memories)
      .values({
        ownerId,
        kind: 'outcome',
        decisionId,
        recipient: decision.recipient,
        amountAtomic: decision.amountAtomic,
        verdict: null,
        sellerHost: decision.sellerHost,
        sentence: outcomeSentence({
          recipient: decision.recipient,
          amountAtomic: decision.amountAtomic,
          sellerHost: decision.sellerHost,
          purpose: decision.purpose,
          delivered,
          date: now,
        }),
        namespace: MEMORY_NAMESPACE,
        writerPublicKey: args.delegatePublicKeyHex,
        status: 'pending',
        createdAt: now,
      })
      .returning({ id: memories.id });
    if (memory === undefined) throw new Error('the memory insert returned no row');
    return { memoryId: memory.id };
  });
}
