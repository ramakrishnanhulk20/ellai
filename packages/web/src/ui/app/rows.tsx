'use client';

import { useState, type ReactNode } from 'react';
import { Button, ErrorLine, Skeleton } from './ui.js';

// One grid serves the wide table and the small-screen card. On a card the order is: first line
// holds the time and the badge, the second the amount, the third the label. `xl` turns it into
// table columns, one column per cell in DOM order.
export const CELL_TIME = 'col-start-1 row-start-1 xl:col-start-auto xl:row-start-auto';
export const CELL_BADGE = 'col-start-2 row-start-1 justify-self-end xl:col-start-auto xl:row-start-auto xl:justify-self-start';
export const CELL_MAIN = 'col-span-2 row-start-2 xl:col-auto xl:row-auto';
export const CELL_LABEL = 'col-span-2 row-start-3 xl:col-auto xl:row-auto';

export function RowList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col max-xl:gap-3 xl:border-t xl:border-line">{children}</ul>;
}

/**
 * A row that opens on click. The summary is the button; `aside` sits at the right end and may
 * hold a link, which cannot live inside a button, so it is laid over the row instead.
 */
export function ExpandableRow({
  summary,
  aside,
  children,
  columns,
}: {
  summary: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  columns: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="max-xl:rounded-card max-xl:border max-xl:border-line max-xl:bg-panel xl:border-b xl:border-line">
      <div className="relative transition-colors duration-[160ms] ease-out hover:bg-[rgba(242,242,238,0.04)] max-xl:rounded-card xl:flex xl:items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="block w-full cursor-pointer p-4 text-left xl:flex-1 xl:py-0"
        >
          <span
            className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 xl:h-16 xl:items-center xl:gap-x-4 xl:gap-y-0 ${columns}`}
          >
            {summary}
          </span>
        </button>
        <div className="absolute bottom-4 right-4 text-right text-[13px] leading-[1.4] xl:static xl:w-[160px] xl:shrink-0 xl:pr-4">
          {aside}
        </div>
      </div>
      <div className="app-expand" data-open={open || undefined}>
        <div>
          <div className="flex flex-col items-start gap-3 px-4 pb-5 pt-1 xl:max-w-[820px]">{children}</div>
        </div>
      </div>
    </li>
  );
}

export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}

export function LoadMore({
  show,
  busy,
  error,
  onClick,
}: {
  show: boolean;
  busy: boolean;
  error: string | null;
  onClick: () => void;
}) {
  if (!show && !error) return null;
  return (
    <div className="mt-6 flex flex-col gap-3">
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {show ? (
        <Button size="lg" full busy={busy} onClick={onClick}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
