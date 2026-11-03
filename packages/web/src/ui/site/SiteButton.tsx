import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight } from './Arrow.js';

type Variant = 'primary' | 'ghost-dark' | 'ghost';
type Size = 'md' | 'lg';
type ArrowKind = 'right' | 'down' | 'none';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-deep',
  'ghost-dark':
    'border border-night-fg/[0.36] text-night-fg hover:border-night-fg hover:bg-[rgba(244,242,236,0.06)]',
  ghost: 'border border-ink text-ink hover:bg-bone',
};

const SIZE: Record<Size, string> = {
  md: 'h-10 px-5 text-[15px]',
  lg: 'h-12 px-6 text-base',
};

const ARROW_MOVE: Record<Exclude<ArrowKind, 'none'>, string> = {
  right: 'motion-safe:group-hover:translate-x-1',
  down: 'motion-safe:group-hover:translate-y-[3px]',
};

export function SiteButton({
  href,
  variant,
  size,
  arrow,
  children,
  className = '',
}: {
  href: string;
  variant: Variant;
  size: Size;
  arrow: ArrowKind;
  children: ReactNode;
  className?: string;
}) {
  const classes = `group inline-flex items-center justify-center gap-2.5 rounded-[8px] font-grotesk font-medium transition-[background-color,border-color,color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${SIZE[size]} ${VARIANT[variant]} ${className}`;
  const inner = (
    <>
      {children}
      {arrow === 'none' ? null : (
        <span
          className={`inline-flex transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${ARROW_MOVE[arrow]}`}
        >
          {arrow === 'right' ? <ArrowRight /> : <ArrowDown />}
        </span>
      )}
    </>
  );

  // A hash link stays a plain anchor so the browser scrolls to it without a client-side route change.
  if (href.startsWith('#')) {
    return (
      <a href={href} className={classes}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}
