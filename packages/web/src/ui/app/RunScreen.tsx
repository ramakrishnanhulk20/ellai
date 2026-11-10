'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isApiError, runBuiltinAgent, type RunResult, type RunStep } from './api.js';
import { ButtonLink } from './ButtonLink.js';
import { useOverview } from './session.js';
import { Badge, Button, Card, ErrorLine, PageShell, Ring, type Tone } from './ui.js';

const TASK_MAX = 1_000;
const SMALL_CAPS = 'font-mono text-[12px] font-medium uppercase leading-[1.5] tracking-[0.06em]';
const EXAMPLES = [
  'Find me a hotel in Lisbon for 20 November under 120 euros',
  'Check whether my Sui wallet has a Walrus Memory account',
  'Give me a short market read on SUI',
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

const DOT_GRID = { backgroundImage: 'radial-gradient(var(--mist) 1.4px, transparent 1.4px)', backgroundSize: '14px 14px' };

function NeedsKey() {
  return (
    <Card className="max-w-[720px] text-center" style={{ ...DOT_GRID, padding: '56px 24px' }}>
      <div className="flex justify-center text-accent">
        <Ring size={56} stroke={1.5} />
      </div>
      <p className="mx-auto mt-6 max-w-[34rem] text-[18px] leading-[1.5] text-fg">
        The built-in agent needs a Claude API key on Ellai&apos;s server. Everything else in Ellai works without it.
      </p>
      <a
        href="/docs"
        className="app-underline mt-5 inline-block text-[15px] font-medium text-fg transition-colors duration-[160ms] ease-out hover:text-accent-text"
      >
        How agents connect
      </a>
    </Card>
  );
}

/** One row of the run's timeline: a 10px square on a 1px line. The line runs down to the next row's square. */
function TimelineRow({ mark, last, children }: { mark: 'done' | 'running'; last: boolean; children: ReactNode }) {
  return (
    <li className={`relative pl-8 ${last ? '' : 'pb-6'}`}>
      {last ? null : <span aria-hidden="true" className="absolute bottom-[-6px] left-[4.5px] top-[18px] w-px bg-line" />}
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[6px] h-2.5 w-2.5 ${mark === 'done' ? 'bg-accent' : 'border-[1.5px] border-accent bg-panel'}`}
      />
      {children}
    </li>
  );
}

function StepRow({ step, last }: { step: RunStep; last: boolean }) {
  const outcome = OUTCOME[step.outcome];
  return (
    <TimelineRow mark="done" last={last}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 font-mono text-[13px] leading-[1.4] text-fg [overflow-wrap:anywhere]">{step.sellerId}</span>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
      </div>
      <p className="mt-2 text-[15px] leading-[1.5] text-muted [overflow-wrap:anywhere]">{step.reason}</p>
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
    </TimelineRow>
  );
}

function ResultCard({ result }: { result: ShownResult }) {
  const status = STATUS[result.status];
  const asked = result.steps.some((step) => step.outcome === 'asked');
  return (
    <>
      <Card className="max-w-[720px]">
        <Badge tone={status.tone}>{status.label}</Badge>
        <p className="mt-4 whitespace-pre-wrap text-[16px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{result.answer}</p>
        {asked ? (
          <div className="mt-6">
            <ButtonLink href="/app/questions" variant="primary">
              Answer the question
            </ButtonLink>
          </div>
        ) : null}
      </Card>
      {result.steps.length > 0 ? (
        <section aria-label="What it paid for" className="max-w-[720px] pt-6">
          <p className={`${SMALL_CAPS} text-muted`}>WHAT IT PAID FOR</p>
          <ol className="mt-5">
            {result.steps.map((step, index) => (
              <StepRow key={`${step.sellerId}-${index}`} step={step} last={index === result.steps.length - 1} />
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function Working({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Card className="max-w-[720px]">
      <ol>
        <TimelineRow mark="running" last>
          <div className="flex items-baseline gap-4">
            <p role="status" className="min-w-0 flex-1 text-[15px] leading-[1.5] text-fg">
              The agent is working. It can take a few minutes.
            </p>
            <p className="shrink-0 font-mono text-[15px] tabular-nums text-muted">{Math.floor((now - since) / 1_000)}s</p>
          </div>
        </TimelineRow>
      </ol>
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
              className="block min-h-[120px] w-full resize-none rounded-button border border-line bg-panel px-4 py-3 font-sans text-[16px] leading-[1.5] text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-fg/40 focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]"
            />
            <ul className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => setTask(example)}
                    className="min-h-8 rounded-button border border-line px-3 py-[6px] text-left font-mono text-[12px] leading-[18px] text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]"
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
