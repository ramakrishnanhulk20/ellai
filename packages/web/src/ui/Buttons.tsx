import type { ReactNode } from 'react';

const BASE = 'label-mono inline-flex items-center rounded-button px-4';

const PRIMARY =
  'bg-accent text-accent-ink transition-[translate,box-shadow] duration-[160ms] ease-out hover:-translate-y-px hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_24%,transparent)]';

const GHOST =
  'border border-line text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)]';

type Height = 'h-10' | 'h-12';

/** The accent button: lifts 1px and gains a soft ring on hover. */
export function PrimaryLink({ href, height, children }: { href: string; height: Height; children: ReactNode }) {
  return (
    <a href={href} className={`${BASE} ${height} ${PRIMARY}`}>
      {children}
    </a>
  );
}

/** The quiet button: the border brightens and a faint fill appears on hover. */
export function GhostLink({ href, height, children }: { href: string; height: Height; children: ReactNode }) {
  return (
    <a href={href} className={`${BASE} ${height} ${GHOST}`}>
      {children}
    </a>
  );
}
