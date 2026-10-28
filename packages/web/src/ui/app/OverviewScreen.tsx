'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Overview, Question } from './api.js';
import { atomicToUsdc, lastPayments, yesesLikeIt } from './format.js';
import { RefreshIcon } from './icons.js';
import { useOverview, useQuestions } from './session.js';
import { Button, Card, ErrorLine, PageShell, Skeleton, When, place } from './ui.js';

const REFRESH_COOLDOWN_MS = 10_000;

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

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col p-4 sm:p-6">
      <p className="label-mono text-muted">{label}</p>
      <div className="mt-auto pt-3">{children}</div>
    </Card>
  );
}

function BigNumber({ children, unit }: { children: ReactNode; unit?: string }) {
  return (
    <p className="font-display text-[32px] font-semibold leading-none tabular-nums text-fg [overflow-wrap:anywhere] sm:text-[44px]">
      {children}
      {unit ? <span className="ml-2 font-sans text-[15px] font-normal text-muted">{unit}</span> : null}
    </p>
  );
}

// An owner with no allowance has no purse to read, and a purse that comes back null with an
// allowance means the read failed. A purse that did answer is shown whatever the allowance says.
function PurseTile({ overview }: { overview: Overview }) {
  const { purse, onboarding } = overview;
  if (purse !== null) return <BigNumber unit="USDC">{atomicToUsdc(purse.usdcAtomic)}</BigNumber>;
  if (onboarding.allowance === 'missing') return <p className="text-[20px] leading-[1.2] text-muted">Not set up</p>;
  return (
    <>
      <p className="text-[20px] leading-[1.2] text-muted">Could not read</p>
      <p className="mt-2 text-[14px] leading-[1.4] text-faint">Refresh in a minute</p>
    </>
  );
}

function AskRate({ asked, window }: { asked: number; window: number }) {
  const rings = Math.min(asked, window);
  return (
    <Card>
      <h2 className="text-[18px] font-medium leading-[1.4] text-fg">
        {window === 0
          ? 'No payments yet. This fills in as your agents pay.'
          : `Of your ${lastPayments(window)}, Ellai asked you about ${asked}.`}
      </h2>
      {window > 0 ? (
        <>
          <div
            role="img"
            aria-label={`Ellai asked about ${asked} of your ${lastPayments(window)}`}
            className="mt-5 flex flex-wrap gap-2"
          >
            {Array.from({ length: window }, (_, index) => {
              const style: CSSProperties = place(index);
              return index < rings ? (
                <span
                  key={index}
                  style={style}
                  className="mark-pop h-[14px] w-[14px] rounded-full border-[1.5px] border-asked"
                />
              ) : (
                <span key={index} style={style} className="mark-pop h-[14px] w-[14px] rounded-full bg-accent" />
              );
            })}
          </div>
          <p className="label-mono mt-4 text-muted">FEWER RINGS MEANS ELLAI HAS LEARNED MORE</p>
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
        className="-mx-3 flex items-start justify-between gap-4 rounded-button px-3 py-2 transition-colors duration-[160ms] ease-out hover:bg-[rgba(242,242,238,0.04)]"
      >
        <span className="min-w-0">
          <span className="block text-[15px] leading-[1.4] text-fg [overflow-wrap:anywhere]">
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
        <h2 className="text-[18px] font-medium leading-[1.4] text-fg">Waiting for you</h2>
        <Link href="/app/questions" className="app-underline text-[14px] text-muted transition-colors duration-[160ms] ease-out hover:text-fg">
          See all
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
      <h2 className="text-[18px] font-medium leading-[1.4] text-fg">Your limits</h2>
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
      label="OVERVIEW"
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
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Tile label="PURSE">
              <PurseTile overview={data} />
            </Tile>
            <Tile label="PAID AND VERIFIED, 30 DAYS">
              <BigNumber>{data.counts.paid}</BigNumber>
            </Tile>
            <Tile label="APPROVED, 30 DAYS">
              <BigNumber>{data.counts.approved}</BigNumber>
            </Tile>
            <Tile label="QUESTIONS ASKED, 30 DAYS">
              <BigNumber>{data.counts.asked}</BigNumber>
            </Tile>
          </div>
          <AskRate asked={data.questionsPer20.asked} window={data.questionsPer20.window} />
          <div className="grid gap-4 xl:grid-cols-2">
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
