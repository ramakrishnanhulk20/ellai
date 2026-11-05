'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchDecisions, type Decision, type DecisionStatus } from './api.js';
import { atomicToUsdc } from './format.js';
import { APP_KEY } from './session.js';
import {
  CELL_BADGE,
  CELL_LABEL,
  CELL_MAIN,
  CELL_TIME,
  ExpandableRow,
  ListSkeleton,
  LoadMore,
  RowList,
} from './rows.js';
import {
  AgentQuote,
  Badge,
  Button,
  ChainLink,
  ErrorLine,
  Figure,
  MemoryChips,
  PageShell,
  VerdictSquare,
  When,
  type Tone,
  type Verdict,
} from './ui.js';

type Kind = 'own' | 'yes' | 'asked' | 'refused' | 'approved';

const BADGE: Record<Kind, { label: string; tone: Tone }> = {
  own: { label: 'PAID ON ITS OWN', tone: 'accent' },
  yes: { label: 'PAID AFTER YOUR YES', tone: 'paid' },
  asked: { label: 'ASKED YOU', tone: 'asked' },
  refused: { label: 'REFUSED', tone: 'refused' },
  approved: { label: 'APPROVED', tone: 'muted' },
};

const VERDICT: Record<Kind, Verdict> = {
  own: 'approved',
  yes: 'approved',
  asked: 'asked',
  refused: 'refused',
  approved: 'approved',
};

// Ellai's first verdict never changes, so "paid" is read from the status: an approval that was
// never paid, or failed at signing, must not be shown as money that moved.
function kindOf(decision: Decision): Kind {
  if (decision.outcome === 'asked') return 'asked';
  if (decision.outcome === 'refused') return 'refused';
  if (decision.status === 'paid' && decision.rule === 'learned') return 'own';
  if (decision.status === 'paid' && decision.rule === 'grant') return 'yes';
  return 'approved';
}

type Filter = 'all' | 'own' | 'asked' | 'refused';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'own', label: 'Paid on its own' },
  { id: 'asked', label: 'Asked you' },
  { id: 'refused', label: 'Refused' },
];

const STATUS_WORDS: Record<DecisionStatus, string> = {
  open: 'Approved, not paid yet',
  paid: 'Paid',
  asked: 'Waiting for you',
  answered: 'You answered',
  refused: 'Refused',
  expired: 'Expired',
  failed: 'Could not be paid',
};

// The explorer link comes from the server, but a link is only built when it names a transaction page on Suiscan.
const EXPLORER_PREFIX = 'https://suiscan.xyz/mainnet/tx/';

// The figures use the same test as the filters, so each number is what its filter would show.
function Summary({ rows }: { rows: Decision[] | null }) {
  const count = (filter: Filter) => (rows === null ? null : rows.filter((decision) => matches(decision, filter)).length);
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
      <Figure label="Decisions shown" value={count('all')} />
      <Figure label="Paid on its own" value={count('own')} />
      <Figure label="Asked you" value={count('asked')} />
      <Figure label="Refused" value={count('refused')} />
    </div>
  );
}

function PaymentState({ paid }: { paid: NonNullable<Decision['paid']> }) {
  switch (paid.settlement) {
    case 'verified':
      return paid.explorerUrl.startsWith(EXPLORER_PREFIX) ? (
        <ChainLink href={paid.explorerUrl}>Verified on Sui</ChainLink>
      ) : (
        <span className="text-fg">Verified on Sui</span>
      );
    case 'pending':
      return <span className="text-muted">Checking on Sui</span>;
    case 'mismatch':
      return <span className="text-refused">Did not match</span>;
    case 'not_landed':
      return <span className="text-muted">Did not land</span>;
  }
}

function DecisionRow({ decision }: { decision: Decision }) {
  const kind = kindOf(decision);
  const badge = BADGE[kind];
  const line = `${atomicToUsdc(decision.payment.amountAtomic)} USDC to ${decision.payment.sellerHost}`;
  return (
    <ExpandableRow
      columns="xl:grid-cols-[150px_160px_minmax(0,1fr)_280px]"
      aside={decision.paid ? <PaymentState paid={decision.paid} /> : null}
      summary={
        <>
          <span className={`${CELL_TIME} flex items-center gap-2`}>
            <VerdictSquare verdict={VERDICT[kind]} />
            <When iso={decision.createdAt} className="font-mono text-[13px] leading-[1.4] text-muted" />
          </span>
          <span
            className={`${CELL_LABEL} truncate text-[15px] leading-[1.4] text-muted ${decision.paid ? 'max-xl:pr-36' : ''}`}
            title={decision.agent.label}
          >
            {decision.agent.label}
          </span>
          <span className={`${CELL_MAIN} text-[15px] leading-[1.4] text-fg [overflow-wrap:anywhere] xl:line-clamp-2`} title={line}>
            {line}
          </span>
          <span className={`${CELL_BADGE} flex flex-wrap items-center justify-end gap-x-2 gap-y-1 xl:justify-start`}>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {kind === 'approved' ? (
              <span className="whitespace-nowrap text-[14px] text-muted">{STATUS_WORDS[decision.status]}</span>
            ) : null}
            {decision.answer === 'approve' ? (
              <span className="whitespace-nowrap text-[14px] text-paid">You approved</span>
            ) : null}
            {decision.answer === 'refuse' ? (
              <span className="whitespace-nowrap text-[14px] text-refused">You refused</span>
            ) : null}
          </span>
        </>
      }
    >
      <p className="text-[15px] leading-[1.5] text-fg">{decision.reason}</p>
      <MemoryChips memories={decision.citedMemories} />
      <AgentQuote purpose={decision.purpose} />
      <p className="text-[14px] leading-[1.4] text-muted">{STATUS_WORDS[decision.status]}</p>
    </ExpandableRow>
  );
}

function matches(decision: Decision, filter: Filter): boolean {
  if (filter === 'all') return true;
  const kind = kindOf(decision);
  return filter === kind;
}

export function HistoryScreen() {
  const [filter, setFilter] = useState<Filter>('all');
  const query = useInfiniteQuery({
    queryKey: [APP_KEY, 'decisions'],
    queryFn: ({ pageParam, signal }) => fetchDecisions(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    gcTime: 0,
  });
  const rows = query.data?.pages.flatMap((page) => page.decisions) ?? [];
  const shown = rows.filter((decision) => matches(decision, filter));

  return (
    <PageShell label="HISTORY" title="Decisions">
      {query.isPending ? (
        <>
          <Summary rows={null} />
          <ListSkeleton />
        </>
      ) : query.isError && !query.data ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{query.error.message}</ErrorLine>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[16px] leading-[1.5] text-muted">No decisions yet. They appear here as your agents ask to pay.</p>
      ) : (
        <>
          <Summary rows={rows} />
          <p className="-mt-2 mb-6 text-[14px] leading-[1.4] text-muted">
            Counted from the {rows.length} decisions loaded below.
            {query.hasNextPage ? ' Load more to count older ones.' : ''}
          </p>
          <div
            role="group"
            aria-label="Filter decisions"
            className="mb-6 inline-flex max-w-full flex-wrap gap-y-1 rounded-button border border-line bg-panel p-1"
          >
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={`h-8 rounded-[6px] px-3 font-mono text-[12px] font-medium uppercase leading-none tracking-[0.06em] transition-colors duration-[160ms] ease-out ${
                  filter === item.id ? 'bg-fg text-paper' : 'text-muted hover:text-fg'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="text-[15px] leading-[1.5] text-muted">No decisions match this filter.</p>
          ) : (
            <RowList>
              {shown.map((decision) => (
                <DecisionRow key={decision.decisionId} decision={decision} />
              ))}
            </RowList>
          )}
          <LoadMore
            show={query.hasNextPage}
            busy={query.isFetchingNextPage}
            error={query.isFetchNextPageError ? query.error.message : null}
            onClick={() => void query.fetchNextPage()}
          />
        </>
      )}
    </PageShell>
  );
}
