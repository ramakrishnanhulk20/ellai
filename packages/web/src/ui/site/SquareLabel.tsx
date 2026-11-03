import type { ReactNode } from 'react';

/** The small filled square and mono caps that open every section. The text colour comes from the parent or className. */
export function SquareLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`flex items-center gap-3 font-plex text-[13px] font-medium uppercase tracking-[0.06em] md:text-sm ${className}`}
    >
      <span aria-hidden className="size-2 shrink-0 bg-accent" />
      {children}
    </p>
  );
}
