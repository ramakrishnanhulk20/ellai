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
import { AgentQuote, Badge, Button, ErrorLine, MemoryChips, PageShell, When, type Tone } from './ui.js';

type Kind = 'own' | 'yes' | 'asked' | 'refused' | 'approved';

const BADGE: Record<Kind, { label: string; tone: Tone }> = {
  own: { label: 'PAID ON ITS OWN', tone: 'accent' },
  yes: { label: 'PAID AFTER YOUR YES', tone: 'paid' },
  asked: { label: 'ASKED YOU', tone: 'asked' },
  refused: { label: 'REFUSED', tone: 'refused' },
  approved: { label: 'APPROVED', tone: 'muted' },
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

function PaymentState({ paid }: { paid: NonNullable<Decision['paid']> }) {
  switch (paid.settlement) {
    case 'verified':
      return paid.explorerUrl.startsWith(EXPLORER_PREFIX) ? (
        <a
          href={paid.explorerUrl}
          target="_blank"
          rel="noopener"
          className="app-underline text-fg transition-colors duration-[160ms] ease-out hover:text-accent"
        >
          Verified on Sui
        </a>
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
      columns="xl:grid-cols-[120px_160px_minmax(0,1fr)_280px]"
      aside={decision.paid ? <PaymentState paid={decision.paid} /> : null}
      summary={
        <>
          <When iso={decision.createdAt} className={`${CELL_TIME} text-[14px] leading-[1.4] text-muted`} />
          <span
            className={`${CELL_LABEL} truncate text-[14px] leading-[1.4] text-fg ${decision.paid ? 'max-xl:pr-36' : ''}`}
            title={decision.agent.label}
          >
            {decision.agent.label}
          </span>
          <span className={`${CELL_MAIN} text-[15px] leading-[1.4] text-fg [overflow-wrap:anywhere] xl:line-clamp-2`} title={line}>
            {line}
          </span>
          <span className={`${CELL_BADGE} flex flex-wrap items-center justify-end gap-x-2 gap-y-1 xl:justify-start`}>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {kind === 'approved' ? <span className="text-[13px] text-muted">{STATUS_WORDS[decision.status]}</span> : null}
            {decision.answer === 'approve' ? <span className="text-[13px] text-paid">You approved</span> : null}
            {decision.answer === 'refuse' ? <span className="text-[13px] text-refused">You refused</span> : null}
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
    <PageShell label="HISTORY" title="Every decision">
      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError && !query.data ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{query.error.message}</ErrorLine>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[16px] leading-[1.5] text-muted">No decisions yet. They appear here as your agents ask to pay.</p>
      ) : (
        <>
          <div role="group" aria-label="Filter decisions" className="mb-6 flex flex-wrap gap-2">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={`h-8 rounded-button border border-line px-3 font-mono text-[12px] leading-none transition-[background-color,color,border-color] duration-[160ms] ease-out hover:border-fg hover:text-fg ${
                  filter === item.id ? 'bg-[rgba(242,242,238,0.06)] text-fg' : 'text-muted'
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
