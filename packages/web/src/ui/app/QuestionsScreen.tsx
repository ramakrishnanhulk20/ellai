'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../useMediaQuery.js';
import { fetchDecisions, isApiError, isSignedOut, postAnswer, type Decision, type Question } from './api.js';
import { atomicToUsdc } from './format.js';
import { CheckIcon } from './icons.js';
import { useQuestions, useSession, type Verdict } from './session.js';
import {
  AgentQuote,
  Button,
  Card,
  CopyButton,
  ErrorLine,
  MemoryChips,
  PageShell,
  Ring,
  Skeleton,
  When,
  place,
} from './ui.js';

const REASON_MAX = 300;
const CONFIRM_WINDOW_MS = 6_000;

// Every small label in a question card shares this shape. The colour is added where it is used.
const LABEL_CAPS = 'font-mono text-[12px] font-medium uppercase leading-[1.5] tracking-[0.06em]';

function answerError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'answered') return 'Already answered.';
    if (error.code === 'not_asked') return 'This question expired. The agent can ask again.';
    if (error.code === 'not_found') return 'This question is gone.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

function BlockLabel({ children }: { children: string }) {
  return <p className={`${LABEL_CAPS} text-muted`}>{children}</p>;
}

function Outcome({ verdict }: { verdict: Verdict }) {
  return verdict === 'approve' ? (
    <p className="flex items-start gap-2 text-[15px] leading-[1.5] text-paid">
      <CheckIcon className="mt-[3px] shrink-0" />
      <span>Approved. Your agent can retry within 10 minutes, and Ellai will pay once.</span>
    </p>
  ) : (
    <p className="text-[15px] leading-[1.5] text-refused">Refused. Ellai will refuse this seller from now on.</p>
  );
}

/** With preview set every control is switched off and nothing is ever sent. */
function AnswerArea({ question, preview }: { question: Question; preview: boolean }) {
  const { recordAnswer } = useSession();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<Verdict | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function stopConfirming() {
    clearTimeout(timer.current);
    setConfirming(false);
  }

  async function submit(verdict: Verdict) {
    if (preview) return;
    stopConfirming();
    setError(null);
    setPending(verdict);
    try {
      await postAnswer(question.decisionId, verdict, reason);
      recordAnswer(question.decisionId, verdict);
    } catch (failure) {
      setError(answerError(failure));
      setPending(null);
    }
  }

  // A refusal blocks every later payment to the seller, so the first press only asks again.
  function pressRefuse() {
    if (preview) return;
    if (confirming) {
      void submit('refuse');
      return;
    }
    setConfirming(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
  }

  const busy = pending !== null;
  const locked = busy || preview;
  // Three lines below 640px so the placeholder is not cut off on a phone.
  const roomy = useMediaQuery('(min-width: 640px)');
  return (
    <div>
      <textarea
        rows={roomy ? 2 : 3}
        maxLength={REASON_MAX}
        value={reason}
        disabled={locked}
        onChange={(event) => setReason(event.target.value)}
        aria-label="Your reason, optional"
        placeholder="Why? Optional. Saved to your Walrus Memory, so leave out anything private."
        className="block w-full resize-none rounded-button border border-line bg-panel p-3 text-[15px] leading-[1.5] text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] disabled:opacity-60"
      />
      <p className="mt-1 text-right font-mono text-[12px] text-faint">
        {reason.length}/{REASON_MAX}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-[10px] lg:flex-col lg:items-stretch">
        <Button
          variant="primary"
          size="lg"
          className="min-w-[120px] flex-1 lg:flex-none"
          busy={pending === 'approve'}
          disabled={locked}
          onClick={() => {
            stopConfirming();
            void submit('approve');
          }}
        >
          Approve
        </Button>
        <Button
          variant="refuse"
          size="lg"
          className={confirming ? 'flex-auto lg:flex-none' : 'min-w-[120px] flex-1 lg:flex-none'}
          busy={pending === 'refuse'}
          disabled={locked}
          onClick={pressRefuse}
        >
          {confirming ? 'Refuse this seller for good?' : 'Refuse'}
        </Button>
        {confirming && !busy ? (
          <Button variant="text" className="lg:self-start" onClick={stopConfirming}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
    </div>
  );
}

function QuestionCard({
  question,
  index,
  preview = false,
  previewVerdict,
}: {
  question: Question;
  index: number;
  preview?: boolean;
  previewVerdict?: Verdict;
}) {
  const { answers } = useSession();
  const verdict = preview ? previewVerdict : answers[question.decisionId];
  const { payment, agent } = question;
  return (
    <li className="app-rise" style={place(index)}>
      <Card
        className={`relative max-w-[960px] overflow-hidden p-0! transition-opacity duration-300 ease-out ${verdict ? 'opacity-60' : ''}`}
      >
        {verdict ? null : <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <div className="min-w-0 p-7">
            <div className="flex items-baseline justify-between gap-4">
              <p className={`${LABEL_CAPS} min-w-0 truncate text-muted`}>From {agent.label}</p>
              <When iso={question.askedAt} className="shrink-0 whitespace-nowrap text-[13px] text-muted" />
            </div>

            <div className="mt-6">
              <BlockLabel>Ellai checked</BlockLabel>
              <p className="mt-3 font-display text-[clamp(2.5rem,4.6vw,3.5rem)] font-bold leading-none tracking-[-0.035em] tabular-nums text-fg [overflow-wrap:anywhere]">
                {atomicToUsdc(payment.amountAtomic)} USDC
              </p>
              <p className="mt-3 text-[18px] leading-[1.4] text-fg [overflow-wrap:anywhere]">to {payment.sellerHost}</p>
              <div className="mt-2 flex items-start gap-1">
                <p className="min-w-0 break-all pt-[3px] font-mono text-[13px] leading-[1.5] text-muted">
                  {payment.recipient}
                </p>
                <CopyButton text={payment.recipient} label="Copy recipient address" />
              </div>
              <p className={`${LABEL_CAPS} mt-2 text-faint`}>Sui Mainnet / USDC</p>
            </div>

            <div className="mt-6">
              <BlockLabel>Why Ellai is asking</BlockLabel>
              <p className="mt-2 text-[16px] leading-[1.5] text-fg">{question.reason}</p>
              <MemoryChips memories={question.citedMemories} className="mt-3" />
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-6 border-t border-line bg-[var(--app-softer)] p-7 lg:border-l lg:border-t-0">
            <div>
              <BlockLabel>The agent says</BlockLabel>
              <div className="mt-3">
                <AgentQuote purpose={question.purpose} />
              </div>
            </div>
            <div className="mt-auto">
              {verdict ? <Outcome verdict={verdict} /> : <AnswerArea question={question} preview={preview} />}
            </div>
          </div>
        </div>
      </Card>
    </li>
  );
}

function Empty() {
  return (
    <Card
      className="flex max-w-[960px] flex-col items-center text-center"
      style={{
        padding: '64px 24px',
        backgroundImage: 'radial-gradient(var(--mist) 1.4px, transparent 1.4px)',
        backgroundSize: '14px 14px',
      }}
    >
      <div className="h-16 w-16 text-accent">
        <Ring stroke={1.5} />
      </div>
      <p className="mt-6 font-display text-[22px] font-semibold leading-[1.3] text-fg">Nothing to answer.</p>
      <p className="mt-2 max-w-[420px] text-[15px] leading-[1.5] text-muted">
        Ellai will ask here when an agent wants to pay for something new.
      </p>
    </Card>
  );
}

export function QuestionsScreen() {
  const { query, all } = useQuestions();
  return (
    <PageShell
      label="Questions"
      title="Your agents want to pay"
      intro="Ellai was not sure, so it is asking you. Your answer is saved to your Walrus Memory and shapes what Ellai does next time."
    >
      {query.isPending ? (
        <Skeleton className="h-[360px] max-w-[960px] rounded-[12px]!" />
      ) : query.isError && !query.data ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{query.error.message}</ErrorLine>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : all.length === 0 ? (
        <Empty />
      ) : (
        <ul className="flex flex-col gap-6">
          {all.map((question, index) => (
            <QuestionCard key={question.decisionId} question={question} index={index} />
          ))}
        </ul>
      )}
    </PageShell>
  );
}

const KNOWN_RULES: ReadonlyArray<Question['rule']> = ['bad_outcome', 'recall_unavailable', 'no_match'];

// The history keeps a question as a decision, and there its rule is free text, so a rule the card
// does not know falls back to no_match.
function decisionAsQuestion(decision: Decision): Question {
  return {
    decisionId: decision.decisionId,
    askedAt: decision.createdAt,
    payment: {
      recipient: decision.payment.recipient,
      amountAtomic: decision.payment.amountAtomic,
      sellerHost: decision.payment.sellerHost,
      asset: 'USDC',
      network: 'sui:mainnet',
    },
    agent: decision.agent,
    purpose: decision.purpose,
    rule: KNOWN_RULES.find((known) => known === decision.rule) ?? 'no_match',
    reason: decision.reason,
    citedMemories: decision.citedMemories,
  };
}

/**
 * Lab only: shows a real question card, once as it waits and once answered, when nothing is waiting.
 * It reads the newest asked decision from the history and sends nothing: every control is off.
 */
export function QuestionPreview() {
  // The key sits outside the app's own, so a signed-out answer cannot clear it half way through.
  const query = useQuery({
    queryKey: ['lab-question-preview'],
    queryFn: ({ signal }) => fetchDecisions(null, signal),
    staleTime: Infinity,
  });

  if (query.isPending) return <Skeleton className="h-[360px] max-w-[960px] rounded-[12px]!" />;
  if (isSignedOut(query.error)) return <p className="text-[15px] text-muted">Sign in at /app first to see the preview.</p>;
  if (query.isError) return <ErrorLine>{query.error.message}</ErrorLine>;

  const asked = query.data.decisions.find((decision) => decision.outcome === 'asked');
  if (!asked) {
    return <p className="text-[15px] text-muted">No asked decision on the first page of your history yet.</p>;
  }
  const question = decisionAsQuestion(asked);
  return (
    <ul className="flex flex-col gap-6">
      <QuestionCard question={question} index={0} preview />
      <QuestionCard question={question} index={1} preview previewVerdict="approve" />
    </ul>
  );
}
