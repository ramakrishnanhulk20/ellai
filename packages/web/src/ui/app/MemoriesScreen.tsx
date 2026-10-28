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
import { Badge, Button, ErrorLine, PageShell, When } from './ui.js';

function describe(memory: MemoryRow): string | null {
  const { amountAtomic, sellerHost } = memory;
  if (amountAtomic !== null && sellerHost !== null) return `${atomicToUsdc(amountAtomic)} USDC to ${sellerHost}`;
  if (amountAtomic !== null) return `${atomicToUsdc(amountAtomic)} USDC`;
  return sellerHost;
}

function SaveState({ memory }: { memory: MemoryRow }) {
  if (memory.status === 'failed') return <span className="text-refused">Not saved</span>;
  if (memory.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-2 text-muted">
        <span aria-hidden="true" className="save-pulse h-1.5 w-1.5 rounded-full bg-accent" />
        Saving to Walrus
      </span>
    );
  }
  return memory.blobId === null ? (
    <span className="text-fg">On Walrus</span>
  ) : (
    <a
      href={walruscanUrl(memory.blobId)}
      target="_blank"
      rel="noopener"
      className="app-underline text-fg transition-colors duration-[160ms] ease-out hover:text-accent"
    >
      On Walrus
    </a>
  );
}

function MemoryRowView({ memory }: { memory: MemoryRow }) {
  const line = describe(memory);
  return (
    <ExpandableRow
      columns="xl:grid-cols-[120px_130px_minmax(0,1fr)_110px]"
      aside={<SaveState memory={memory} />}
      summary={
        <>
          <When iso={memory.createdAt} className={`${CELL_TIME} text-[14px] leading-[1.4] text-muted`} />
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
  const count = (status: MemoryRow['status']) => rows.filter((memory) => memory.status === status).length;

  return (
    <PageShell
      label="MEMORIES"
      title="What Ellai has learned"
      intro="These live in your own Walrus Memory account. Ellai reads them to decide, and you own them."
    >
      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError && !query.data ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{query.error.message}</ErrorLine>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[16px] leading-[1.5] text-muted">No memories yet. Each answer you give becomes one.</p>
      ) : (
        <>
          <p className="label-mono mb-6 text-muted">
            {count('confirmed')} ON WALRUS / {count('pending')} WAITING / {count('failed')} FAILED
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
