import { LIMITS } from '@ellai/core/limits';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { VERDICTS, decisions, grants, memories, owners, questions } from '../db/schema.js';
import { ownerDecisionSentence } from './sentences.js';

export type AnswerErrorCode = 'BAD_INPUT' | 'NOT_FOUND' | 'ANSWERED' | 'NOT_ASKED';

/** Every refusal from answerQuestion. The message is fixed text. */
export class AnswerError extends Error {
  readonly code: AnswerErrorCode;

  constructor(code: AnswerErrorCode, message: string) {
    super(message);
    this.name = 'AnswerError';
    this.code = code;
  }
}

export interface AnswerArgs {
  db: Database;
  ownerId: string;
  decisionId: string;
  answer: 'approve' | 'refuse';
  reason: string | null;
  /** The owner's Ellai delegate key, as 64 lowercase hex characters, recorded as the memory's writer. */
  delegatePublicKeyHex: string;
  namespace: string;
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

function bad(message: string): never {
  throw new AnswerError('BAD_INPUT', message);
}

function checkReason(reason: unknown): string | null {
  if (reason === null) return null;
  if (typeof reason !== 'string') bad('the reason must be text or null');
  const trimmed = reason.trim();
  if (trimmed === '') return null;
  // Counted in code points, as Postgres counts the column cap.
  if (Array.from(trimmed).length > LIMITS.reasonMaxChars) bad(`the reason must be at most ${LIMITS.reasonMaxChars} characters`);
  return trimmed;
}

/**
 * Records the owner's yes or no to one question, in one transaction that locks the owner
 * row, then the question, then the decision, in the same order decide takes the owner lock.
 *
 * The question must be this owner's and unanswered, and its decision must still be 'asked'
 * (C13, C15). The answer and its time are recorded, the decision becomes 'answered', and an
 * owner_decision memory (pending, with no blob yet) is written with the verdict, recipient,
 * amount and host of that decision, and linked from the question. From that moment a
 * refusal blocks every later payment to the recipient (C11, C12). A yes also writes one
 * grant for that same recipient, at most that amount, the same seller URL, method and body
 * hash, expiring LIMITS.grantTtlMs after `now`. Nothing is sent to Walrus here.
 *
 * Throws AnswerError: BAD_INPUT, NOT_FOUND (no such question for this owner, including
 * another owner's), ANSWERED, NOT_ASKED (the decision has moved on).
 */
export async function answerQuestion(args: AnswerArgs): Promise<{ memoryId: string; grantId: string | null }> {
  if (typeof args.ownerId !== 'string' || !UUID.test(args.ownerId)) bad('the owner id is not a uuid');
  if (typeof args.decisionId !== 'string' || !UUID.test(args.decisionId)) bad('the decision id is not a uuid');
  if (!(VERDICTS as readonly string[]).includes(args.answer)) bad('the answer must be approve or refuse');
  if (typeof args.delegatePublicKeyHex !== 'string' || !HEX_32_BYTES.test(args.delegatePublicKeyHex)) {
    bad('the delegate public key must be 64 lowercase hex characters');
  }
  if (typeof args.namespace !== 'string' || args.namespace.length === 0 || args.namespace.length > LIMITS.memwalNamespaceMaxLength) {
    bad('the namespace is missing or too long');
  }
  if (!(args.now instanceof Date) || Number.isNaN(args.now.getTime())) bad('the current time is not a date');
  const reason = checkReason(args.reason);
  const ownerId = args.ownerId.toLowerCase();
  const decisionId = args.decisionId.toLowerCase();
  const { answer, now } = args;

  return args.db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
    const thisQuestion = and(eq(questions.decisionId, decisionId), eq(questions.ownerId, ownerId));
    const [question] = owner === undefined ? [] : await tx.select().from(questions).where(thisQuestion).for('update');
    if (question === undefined) throw new AnswerError('NOT_FOUND', 'there is no such question for this owner');
    if (question.answeredAt !== null || question.answer !== null) throw new AnswerError('ANSWERED', 'this question has already been answered');

    const thisDecision = and(eq(decisions.id, decisionId), eq(decisions.ownerId, ownerId));
    const [decision] = await tx.select().from(decisions).where(thisDecision).for('update');
    if (decision === undefined || decision.status !== 'asked') {
      throw new AnswerError('NOT_ASKED', 'this decision is no longer waiting for an answer');
    }

    const [memory] = await tx
      .insert(memories)
      .values({
        ownerId,
        kind: 'owner_decision',
        decisionId,
        recipient: decision.recipient,
        amountAtomic: decision.amountAtomic,
        verdict: answer,
        sellerHost: decision.sellerHost,
        sentence: ownerDecisionSentence({
          verdict: answer,
          recipient: decision.recipient,
          amountAtomic: decision.amountAtomic,
          sellerHost: decision.sellerHost,
          purpose: decision.purpose,
          reason,
          date: now,
        }),
        namespace: args.namespace,
        writerPublicKey: args.delegatePublicKeyHex,
        status: 'pending',
        createdAt: now,
      })
      .returning({ id: memories.id });
    if (memory === undefined) throw new Error('the memory insert returned no row');

    await tx.update(questions).set({ answer, reason, answeredAt: now, memoryId: memory.id }).where(thisQuestion);
    await tx.update(decisions).set({ status: 'answered' }).where(and(thisDecision, eq(decisions.status, 'asked')));

    if (answer === 'refuse') return { memoryId: memory.id, grantId: null };
    const [grant] = await tx
      .insert(grants)
      .values({
        ownerId,
        decisionId,
        recipient: decision.recipient,
        maxAmountAtomic: decision.amountAtomic,
        sellerUrl: decision.sellerUrl,
        sellerMethod: decision.sellerMethod,
        bodyHash: decision.bodyHash,
        expiresAt: new Date(now.getTime() + LIMITS.grantTtlMs),
      })
      .returning({ id: grants.id });
    if (grant === undefined) throw new Error('the grant insert returned no row');
    return { memoryId: memory.id, grantId: grant.id };
  });
}
