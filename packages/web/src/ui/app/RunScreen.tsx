'use client';

import { useEffect, useRef, useState } from 'react';
import { isApiError, runBuiltinAgent, type RunResult, type RunStep } from './api.js';
import { ButtonLink } from './ButtonLink.js';
import { useOverview } from './session.js';
import { Badge, Button, Card, ErrorLine, PageShell, Ring, type Tone } from './ui.js';

const TASK_MAX = 1_000;
const EXAMPLES = [
  'Find me a hotel in Lisbon for 20 November under 120 euros',
  'Check whether my Sui wallet has a Walrus Memory account',
  'Classify this email as spam or not: You won a free cruise',
] as const;

const STATUS = {
  done: { label: 'DONE', tone: 'accent' },
  stopped: { label: 'STOPPED', tone: 'asked' },
  limit: { label: 'LIMIT', tone: 'muted' },
  refused: { label: 'REFUSED', tone: 'refused' },
} as const satisfies Record<string, { label: string; tone: Tone }>;

type ShownResult = RunResult & { status: keyof typeof STATUS };

function isShown(result: RunResult): result is ShownResult {
  return result.status !== 'needs_key';
}

const OUTCOME: Record<RunStep['outcome'], { label: string; tone: Tone }> = {
  free: { label: 'FREE', tone: 'muted' },
  paid: { label: 'PAID', tone: 'paid' },
  asked: { label: 'ASKED YOU', tone: 'asked' },
  refused: { label: 'REFUSED', tone: 'refused' },
  failed: { label: 'FAILED', tone: 'muted' },
};

// A digest from the server is plain base58. A link is only built from one that looks like it.
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function NeedsKey() {
  return (
    <Card className="max-w-[720px]">
      <p className="text-[16px] leading-[1.5] text-fg">
        The built-in agent needs a Claude API key on Ellai&apos;s server. Everything else in Ellai works without it.
      </p>
    </Card>
  );
}

function StepRow({ step }: { step: RunStep }) {
  const outcome = OUTCOME[step.outcome];
  return (
    <li className="border-b border-line py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 font-mono text-[13px] leading-[1.4] text-fg [overflow-wrap:anywhere]">{step.sellerId}</span>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
      </div>
      <p className="mt-2 text-[14px] leading-[1.5] text-muted [overflow-wrap:anywhere]">{step.reason}</p>
      {step.digest !== null && DIGEST.test(step.digest) ? (
        <a
          href={`https://suiscan.xyz/mainnet/tx/${encodeURIComponent(step.digest)}`}
          target="_blank"
          rel="noopener"
          className="app-underline mt-2 inline-block text-[14px] text-fg transition-colors duration-[160ms] ease-out hover:text-accent"
        >
          See it on Sui
        </a>
      ) : null}
    </li>
  );
}

function ResultCard({ result }: { result: ShownResult }) {
  const status = STATUS[result.status];
  const asked = result.steps.some((step) => step.outcome === 'asked');
  return (
    <Card className="max-w-[720px]">
      <Badge tone={status.tone}>{status.label}</Badge>
      <p className="mt-4 whitespace-pre-wrap text-[16px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{result.answer}</p>
      {result.steps.length > 0 ? (
        <div className="mt-6 border-t border-line pt-6">
          <p className="label-mono text-muted">WHAT IT PAID FOR</p>
          <ul className="mt-4">
            {result.steps.map((step, index) => (
              <StepRow key={`${step.sellerId}-${index}`} step={step} />
            ))}
          </ul>
        </div>
      ) : null}
      {asked ? (
        <div className="mt-6">
          <ButtonLink href="/app/questions" variant="primary">
            Answer the question
          </ButtonLink>
        </div>
      ) : null}
    </Card>
  );
}

function Working({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Card className="flex max-w-[720px] items-center gap-4">
      <span className="h-6 w-6 shrink-0 text-accent">
        <Ring stroke={2} className="ring-spin" />
      </span>
      <p role="status" className="min-w-0 flex-1 text-[16px] leading-[1.5] text-fg">
        The agent is working. It can take a few minutes.
      </p>
      <p className="shrink-0 font-mono text-[15px] tabular-nums text-muted">{Math.floor((now - since) / 1_000)}s</p>
    </Card>
  );
}

export function RunScreen() {
  const { data: overview } = useOverview();
  const [task, setTask] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One request that stays open until the agent is done. There is nothing to poll.
  async function run() {
    setError(null);
    setResult(null);
    setStartedAt(Date.now());
    try {
      const answer = await runBuiltinAgent(task.trim());
      if (alive.current) setResult(answer);
    } catch (caught) {
      if (alive.current) setError(isApiError(caught) ? caught.message : 'Something went wrong. Try again.');
    } finally {
      if (alive.current) setStartedAt(null);
    }
  }

  const running = startedAt !== null;
  const needsKey = overview?.builtinAgent === 'needs_key' || result?.status === 'needs_key';

  return (
    <PageShell label="RUN" title="Give the built-in agent a task">
      {needsKey ? (
        <NeedsKey />
      ) : (
        <div className="flex flex-col gap-4">
          <Card className="max-w-[720px]">
            <textarea
              rows={4}
              maxLength={TASK_MAX}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              aria-label="Task for the built-in agent"
              placeholder="Tell the agent what you need. It can buy small pieces of data from a fixed list of sellers, and Ellai decides every payment."
              className="block w-full resize-none rounded-button border border-line bg-bg p-3 text-[16px] leading-[1.5] text-fg transition-[border-color] duration-[160ms] ease-out placeholder:text-faint hover:border-fg/40 focus:border-accent focus-visible:outline-none"
            />
            <ul className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => setTask(example)}
                    className="min-h-8 rounded-button border border-line px-3 py-[6px] text-left font-mono text-[12px] leading-[18px] text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)]"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button variant="primary" size="lg" className="min-w-[140px]" disabled={running || task.trim() === ''} onClick={() => void run()}>
                Run
              </Button>
            </div>
            {error ? (
              <div className="mt-3">
                <ErrorLine>{error}</ErrorLine>
              </div>
            ) : null}
          </Card>
          {startedAt !== null ? <Working since={startedAt} /> : null}
          {result && isShown(result) ? <ResultCard result={result} /> : null}
        </div>
      )}
    </PageShell>
  );
}
