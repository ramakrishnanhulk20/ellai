'use client';

import { useEffect, useRef, useState } from 'react';
import { isApiError, postAnswer, type Question } from './api.js';
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
  return <p className="label-mono text-muted">{children}</p>;
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

function AnswerArea({ question }: { question: Question }) {
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
    if (confirming) {
      void submit('refuse');
      return;
    }
    setConfirming(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
  }

  const busy = pending !== null;
  return (
    <div>
      <textarea
        rows={2}
        maxLength={REASON_MAX}
        value={reason}
        disabled={busy}
        onChange={(event) => setReason(event.target.value)}
        aria-label="Your reason, optional"
        placeholder="Why? Optional. Saved to your Walrus Memory, so leave out anything private."
        className="block w-full resize-none rounded-button border border-line bg-bg p-3 text-[15px] leading-[1.5] text-fg placeholder:text-faint disabled:opacity-60"
      />
      <p className="mt-1 text-right font-mono text-[12px] text-faint">
        {reason.length}/{REASON_MAX}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          className="min-w-[120px] flex-1"
          busy={pending === 'approve'}
          disabled={busy}
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
          className={confirming ? 'flex-auto' : 'min-w-[120px] flex-1'}
          busy={pending === 'refuse'}
          disabled={busy}
          onClick={pressRefuse}
        >
          {confirming ? 'Refuse this seller for good?' : 'Refuse'}
        </Button>
        {confirming && !busy ? (
          <Button variant="text" onClick={stopConfirming}>
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

function QuestionCard({ question, index }: { question: Question; index: number }) {
  const { answers } = useSession();
  const verdict = answers[question.decisionId];
  const { payment, agent } = question;
  return (
    <li className="app-rise" style={place(index)}>
      <Card className={`max-w-[720px] transition-opacity duration-300 ease-out ${verdict ? 'opacity-60' : ''}`}>
        <div className="flex items-baseline justify-between gap-4">
          <p className="label-mono min-w-0 truncate text-muted">FROM {agent.label}</p>
          <When iso={question.askedAt} className="shrink-0 whitespace-nowrap text-[13px] text-muted" />
        </div>

        <div className="mt-6">
          <BlockLabel>ELLAI CHECKED</BlockLabel>
          <p className="mt-3 font-display text-[44px] font-semibold leading-none tabular-nums text-fg [overflow-wrap:anywhere]">
            {atomicToUsdc(payment.amountAtomic)} USDC
          </p>
          <p className="mt-3 text-[18px] leading-[1.4] text-fg [overflow-wrap:anywhere]">to {payment.sellerHost}</p>
          <div className="mt-2 flex items-start gap-1">
            <p className="min-w-0 break-all pt-[3px] font-mono text-[13px] leading-[1.5] text-muted">{payment.recipient}</p>
            <CopyButton text={payment.recipient} label="Copy recipient address" />
          </div>
          <p className="label-mono mt-2 text-faint">SUI MAINNET / USDC</p>
        </div>

        <div className="mt-6">
          <BlockLabel>WHY ELLAI IS ASKING</BlockLabel>
          <p className="mt-2 text-[16px] leading-[1.5] text-fg">{question.reason}</p>
          <MemoryChips memories={question.citedMemories} className="mt-3" />
        </div>

        <div className="mt-6 border-t border-line pt-6">
          <BlockLabel>THE AGENT SAYS</BlockLabel>
          <div className="mt-3">
            <AgentQuote purpose={question.purpose} />
          </div>
        </div>

        <div className="mt-6">{verdict ? <Outcome verdict={verdict} /> : <AnswerArea question={question} />}</div>
      </Card>
    </li>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center">
      <div className="h-16 w-16 text-accent">
        <Ring stroke={1.5} />
      </div>
      <p className="mt-6 text-[18px] leading-[1.4] text-fg">Nothing to answer.</p>
      <p className="mt-2 max-w-[420px] text-[15px] leading-[1.5] text-muted">
        Ellai will ask here when an agent wants to pay for something new.
      </p>
    </div>
  );
}

export function QuestionsScreen() {
  const { query, all } = useQuestions();
  return (
    <PageShell
      label="QUESTIONS"
      title="Your agents want to pay"
      intro="Ellai was not sure, so it is asking you. Your answer is saved to your Walrus Memory and shapes what Ellai does next time."
    >
      {query.isPending ? (
        <Skeleton className="h-[420px] max-w-[720px]" />
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
