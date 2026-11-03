'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchMemories, type MemoryRow } from './api.js';
import { atomicToUsdc, walruscanUrl } from './format.js';
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
import { Badge, Button, ChainLink, ErrorLine, Figure, PageShell, VerdictSquare, When, type Verdict } from './ui.js';

function describe(memory: MemoryRow): string | null {
  const { amountAtomic, sellerHost } = memory;
  if (amountAtomic !== null && sellerHost !== null) return `${atomicToUsdc(amountAtomic)} USDC to ${sellerHost}`;
  if (amountAtomic !== null) return `${atomicToUsdc(amountAtomic)} USDC`;
  return sellerHost;
}

// An outcome row carries no delivered flag in the API, so it gets the neutral mark rather than a colour it cannot back up.
function squareFor(memory: MemoryRow): Verdict {
  if (memory.kind === 'outcome') return 'neutral';
  return memory.verdict === 'approve' ? 'approved' : 'refused';
}

function Summary({ rows }: { rows: MemoryRow[] | null }) {
  const count = (status: MemoryRow['status']) => (rows === null ? null : rows.filter((memory) => memory.status === status).length);
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
      <Figure label="On Walrus" value={count('confirmed')} tone="paid" />
      <Figure label="Waiting" value={count('pending')} />
      <Figure label="Failed" value={count('failed')} className="max-md:col-span-2" />
    </div>
  );
}

function SaveState({ memory }: { memory: MemoryRow }) {
  if (memory.status === 'failed') return <Badge tone="refused">Not saved</Badge>;
  if (memory.status === 'pending') {
    return (
      <Badge tone="muted">
        <span aria-hidden="true" className="save-pulse mr-2 h-1.5 w-1.5 rounded-full bg-accent" />
        Saving to Walrus
      </Badge>
    );
  }
  return memory.blobId === null ? (
    <span className="text-fg">On Walrus</span>
  ) : (
    <ChainLink href={walruscanUrl(memory.blobId)}>blob {memory.blobId.slice(0, 6)}...</ChainLink>
  );
}

function MemoryRowView({ memory }: { memory: MemoryRow }) {
  const line = describe(memory);
  return (
    <ExpandableRow
      columns="xl:grid-cols-[140px_130px_minmax(0,1fr)_110px]"
      aside={<SaveState memory={memory} />}
      summary={
        <>
          <span className={`${CELL_TIME} flex items-center gap-2`}>
            <VerdictSquare verdict={squareFor(memory)} />
            <When iso={memory.createdAt} className="text-[14px] leading-[1.4] text-muted" />
          </span>
          <span className={`${CELL_LABEL} text-[14px] leading-[1.4] text-fg`}>
            {memory.kind === 'owner_decision' ? 'Your answer' : 'Outcome'}
          </span>
          <span className={`${CELL_MAIN} text-[15px] leading-[1.4] text-fg [overflow-wrap:anywhere] xl:line-clamp-2`} title={line ?? undefined}>
            {line}
          </span>
          <span className={CELL_BADGE}>
            {memory.verdict === 'approve' ? <Badge tone="paid">APPROVED</Badge> : null}
            {memory.verdict === 'refuse' ? <Badge tone="refused">REFUSED</Badge> : null}
          </span>
        </>
      }
    >
      <p className="w-full whitespace-pre-wrap rounded-button border border-line p-3 font-mono text-[13px] leading-[1.5] text-muted [overflow-wrap:anywhere]">
        {memory.sentence}
      </p>
    </ExpandableRow>
  );
}

export function MemoriesScreen() {
  const query = useInfiniteQuery({
    queryKey: [APP_KEY, 'memories'],
    queryFn: ({ pageParam, signal }) => fetchMemories(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    gcTime: 0,
  });
  const rows = query.data?.pages.flatMap((page) => page.memories) ?? [];

  return (
    <PageShell
      label="MEMORIES"
      title="What Ellai has learned"
      intro="These live in your own Walrus Memory account. Ellai reads them to decide, and you own them."
    >
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
        <p className="text-[16px] leading-[1.5] text-muted">No memories yet. Each answer you give becomes one.</p>
      ) : (
        <>
          <Summary rows={rows} />
          <p className="-mt-2 mb-6 text-[14px] leading-[1.4] text-muted">
            Counted from the {rows.length} memories loaded below.
            {query.hasNextPage ? ' Load more to count older ones.' : ''}
          </p>
          <RowList>
            {rows.map((memory) => (
              <MemoryRowView key={memory.memoryId} memory={memory} />
            ))}
          </RowList>
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
