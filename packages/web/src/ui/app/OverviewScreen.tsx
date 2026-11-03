'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { PosterRing } from '../site/PosterRing.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import type { Overview, Question } from './api.js';
import { atomicToUsdc, lastPayments, yesesLikeIt } from './format.js';
import { RefreshIcon } from './icons.js';
import { useOverview, useQuestions } from './session.js';
import { Button, Card, ErrorLine, PageShell, Skeleton, When, place } from './ui.js';

const REFRESH_COOLDOWN_MS = 10_000;
const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

// The band is always dark, so its text colours are literal values and do not follow the page tokens.
const BAND_MUTED = 'text-[rgba(244,242,236,0.56)]';

function RefreshButton({ fetching, failed, onRefresh }: { fetching: boolean; failed: boolean; onRefresh: () => void }) {
  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function press() {
    onRefresh();
    setCooling(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCooling(false), REFRESH_COOLDOWN_MS);
  }

  const done = cooling && !fetching && !failed;
  return (
    <Button disabled={cooling} busy={fetching} onClick={press}>
      {fetching ? null : <RefreshIcon />}
      {done ? 'Refreshed' : 'Refresh'}
    </Button>
  );
}

// A purse that did answer is always shown, because money left in it after an allowance ends is still
// there. With no allowance a line says so. A purse that comes back null was either never read, which
// is "Not set up", or read and failed, which must never be called "Not set up".
function PurseReadout({ overview }: { overview: Overview }) {
  const { purse, purseRead, onboarding } = overview;
  if (purse !== null) {
    return (
      <>
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-display text-[clamp(3.25rem,7vw,6rem)] font-bold leading-[0.95] tracking-[-0.04em] tabular-nums [overflow-wrap:anywhere]">
            {atomicToUsdc(purse.usdcAtomic)}
          </span>
          <span className={`text-[18px] ${BAND_MUTED}`}>USDC</span>
        </p>
        {onboarding.allowance === 'missing' ? (
          <p className={`mt-3 max-w-[32rem] text-[15px] leading-[1.5] ${BAND_MUTED}`}>
            No allowance. Ellai pays only from refills it verified, under your rules.
          </p>
        ) : null}
      </>
    );
  }
  if (!purseRead) {
    return <p className={`font-display text-[32px] font-semibold leading-[1.2] ${BAND_MUTED}`}>Not set up</p>;
  }
  return (
    <>
      <p className={`font-display text-[32px] font-semibold leading-[1.2] ${BAND_MUTED}`}>Could not read</p>
      <p className={`mt-2 text-[15px] leading-[1.5] ${BAND_MUTED}`}>Refresh in a minute</p>
    </>
  );
}

/** The dark band at the top of Overview: the purse large, the 30 day numbers under it, the limit ring behind. */
function StatusBand({ overview }: { overview: Overview }) {
  const reduced = usePrefersReducedMotion();
  const { counts } = overview;

  const rise = (delay: number) => ({
    initial: reduced ? (false as const) : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, delay, ease: EASE_OUT_EXPO },
  });

  const figures = [
    { label: 'Paid and verified, 30 days', value: counts.paid, color: 'text-[#8c9bff]' },
    { label: 'Approved, 30 days', value: counts.approved, color: 'text-[#f4f2ec]' },
    { label: 'Questions asked, 30 days', value: counts.asked, color: 'text-[#f4f2ec]' },
  ];

  return (
    <motion.div
      className="relative isolate min-h-[300px] overflow-hidden rounded-[16px] bg-[#07080a] p-6 text-[#f4f2ec] sm:p-10"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 70% at 80% 40%, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 70%)',
        }}
      />
      {/* Below 1024px the ring is hidden with visibility, not display: with display none the ring did not paint in headless Chrome. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [--ring-d:min(340px,34vw)] [--ring-x:84%] [--ring-y:46%] max-lg:invisible"
      >
        <PosterRing />
      </div>

      <div className="relative z-10 lg:max-w-[62%]">
        <p className="flex items-center gap-3">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-accent" />
          <span className={`font-mono text-[12px] uppercase tracking-[0.06em] ${BAND_MUTED}`}>In the purse</span>
        </p>

        <motion.div className="mt-4" {...rise(0.1)}>
          <PurseReadout overview={overview} />
        </motion.div>

        <div className="mt-9 flex flex-col gap-4 sm:grid sm:grid-cols-3 sm:gap-0">
          {figures.map((figure, index) => (
            <motion.div
              key={figure.label}
              className={index === 0 ? '' : 'sm:border-l sm:border-[rgba(244,242,236,0.14)] sm:pl-6'}
              {...rise(0.1 + (index + 1) * 0.08)}
            >
              <p className={`font-display text-[40px] font-bold leading-none tabular-nums ${figure.color}`}>
                {figure.value}
              </p>
              <p
                className={`mt-2 font-mono text-[11px] uppercase leading-[1.5] tracking-[0.06em] ${BAND_MUTED}`}
              >
                {figure.label}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function AskRate({ asked, window }: { asked: number; window: number }) {
  const marks = Math.min(asked, window);
  return (
    <Card>
      <h2 className="font-display text-[22px] font-semibold leading-[1.3] text-fg">
        {window === 0
          ? 'No payments yet. This fills in as your agents pay.'
          : `Of your ${lastPayments(window)}, Ellai asked you about ${asked}.`}
      </h2>
      {window > 0 ? (
        <>
          <div
            role="img"
            aria-label={`Ellai asked about ${asked} of your ${lastPayments(window)}`}
            className="mt-5 flex flex-wrap gap-[6px]"
          >
            {Array.from({ length: window }, (_, index) => {
              const style: CSSProperties = place(index);
              return index < marks ? (
                <span
                  key={index}
                  style={style}
                  className="mark-pop h-3.5 w-3.5 rounded-[3px] border-[1.5px] border-fg bg-panel sm:h-5 sm:w-5"
                />
              ) : (
                <span key={index} style={style} className="mark-pop h-3.5 w-3.5 rounded-[3px] bg-accent sm:h-5 sm:w-5" />
              );
            })}
          </div>
          <p className="mt-4 font-mono text-[12px] uppercase tracking-[0.06em] text-muted">
            Fewer hollow marks means Ellai has learned more
          </p>
        </>
      ) : null}
    </Card>
  );
}

function WaitingRow({ question }: { question: Question }) {
  return (
    <li>
      <Link
        href="/app/questions"
        className="-mx-3 flex items-start justify-between gap-4 rounded-button px-3 py-2 transition-colors duration-[160ms] ease-out hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]"
      >
        <span className="min-w-0">
          <span className="block text-[16px] leading-[1.4] text-fg [overflow-wrap:anywhere]">
            {atomicToUsdc(question.payment.amountAtomic)} USDC to {question.payment.sellerHost}
          </span>
          <span className="mt-0.5 block text-[13px] leading-[1.4] text-muted [overflow-wrap:anywhere]">
            {question.agent.label}
          </span>
        </span>
        <When iso={question.askedAt} className="shrink-0 whitespace-nowrap pt-0.5 text-[13px] text-muted" />
      </Link>
    </li>
  );
}

function WaitingCard() {
  const { query, waiting } = useQuestions();
  const newest = waiting.slice(0, 3);
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[20px] font-semibold leading-[1.4] text-fg">Waiting for you</h2>
        <Link
          href="/app/questions"
          className="app-underline inline-flex items-center gap-1.5 text-[14px] text-muted transition-colors duration-[160ms] ease-out hover:text-fg"
        >
          See all
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M2 7h10M8 3l4 4-4 4" />
          </svg>
        </Link>
      </div>
      <div className="mt-4">
        {query.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : query.isError && !query.data ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorLine>{query.error.message}</ErrorLine>
            <Button variant="text" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : newest.length === 0 ? (
          <p className="text-[15px] leading-[1.5] text-muted">Nothing to answer right now.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {newest.map((question) => (
              <WaitingRow key={question.decisionId} question={question} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function LimitsCard({ owner }: { owner: Overview['owner'] }) {
  const rows: Array<[string, string]> = [
    ['Per payment', `${atomicToUsdc(owner.perPaymentMaxAtomic)} USDC`],
    ['Per day', `${atomicToUsdc(owner.dailyBudgetAtomic)} USDC`],
    ['Pays on its own after', `${owner.approvalsNeeded} ${yesesLikeIt(owner.approvalsNeeded)}`],
    ['How alike', owner.distanceCutoff.toFixed(2)],
  ];
  return (
    <Card>
      <h2 className="font-display text-[20px] font-semibold leading-[1.4] text-fg">Your limits</h2>
      <dl className="mt-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-line py-3 text-[15px] leading-[1.4] last:border-b-0 last:pb-0"
          >
            <dt className="text-muted">{label}</dt>
            <dd className="text-right text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function OverviewScreen() {
  const overview = useOverview();
  const { data } = overview;

  return (
    <PageShell
      label="Overview"
      title="Your agents and Ellai"
      action={
        <RefreshButton
          fetching={overview.isFetching}
          failed={overview.isRefetchError}
          onRefresh={() => void overview.refetch()}
        />
      }
    >
      {overview.isRefetchError ? (
        <div className="mb-6">
          <ErrorLine>{overview.error.message}</ErrorLine>
        </div>
      ) : null}
      {data ? (
        <div>
          <StatusBand overview={data} />
          <div className="mt-4">
            <AskRate asked={data.questionsPer20.asked} window={data.questionsPer20.window} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <WaitingCard />
            <LimitsCard owner={data.owner} />
          </div>
        </div>
      ) : overview.isError ? (
        <Card className="flex flex-col items-start gap-3">
          <ErrorLine>{overview.error.message}</ErrorLine>
          <Button onClick={() => void overview.refetch()}>Try again</Button>
        </Card>
      ) : null}
    </PageShell>
  );
}
