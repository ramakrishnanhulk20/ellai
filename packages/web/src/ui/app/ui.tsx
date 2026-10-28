'use client';

import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import type { CitedMemory } from './api.js';
import { Banners } from './Banners.js';
import { formatWhen, useNow, walruscanUrl } from './format.js';
import { BUTTON_BASE, BUTTON_VARIANT, type Variant } from './button-styles.js';
import { CheckIcon, CopyIcon } from './icons.js';

/** The limit ring: a circle with a 40 degree gap at the top right. Stroke width is in screen pixels at any size. */
export function Ring({ size, stroke = 1.5, className = '' }: { size?: number; stroke?: number; className?: string }) {
  return (
    <svg
      width={size ?? '100%'}
      height={size ?? '100%'}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M13.909 1.617A9.25 9.25 0 1 0 18.383 6.091"
        stroke="currentColor"
        strokeWidth={stroke}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Sets the place of an item in a list, which the entrance animations turn into a delay. */
export function place(index: number): CSSProperties {
  return { '--i': index } as CSSProperties;
}

type ButtonProps = ComponentProps<'button'> & {
  variant?: Variant;
  size?: 'md' | 'lg';
  full?: boolean;
  busy?: boolean;
};

/** 40px by default, 48px for the main action on a screen. While busy it is disabled and shows the spinner. */
export function Button({
  variant = 'ghost',
  size = 'md',
  full = false,
  busy = false,
  className = '',
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const height = variant === 'text' ? '' : size === 'lg' ? 'h-12' : 'h-10';
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${height} ${full ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {busy ? <Ring size={16} className="ring-spin" /> : null}
      {children}
    </button>
  );
}

export function Card({ className = '', children, ...rest }: ComponentProps<'section'>) {
  return (
    <section className={`rounded-panel border border-line bg-panel p-6 ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[14px] leading-[1.4] text-refused">
      {children}
    </p>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`app-skeleton ${className}`} />;
}

/** A page's header, then the banners that apply to the whole account, then the page itself. */
export function PageShell({
  label,
  title,
  intro,
  action,
  children,
}: {
  label: string;
  title: string;
  intro?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="label-mono text-muted">{label}</p>
          <h1 className="mt-3 font-display text-[44px] font-medium leading-[1.05] tracking-[-0.01em] text-fg">{title}</h1>
          {intro ? <p className="mt-4 max-w-[640px] text-[16px] leading-[1.5] text-muted">{intro}</p> : null}
        </div>
        {action}
      </header>
      <Banners />
      {children}
    </div>
  );
}

/** A time that keeps itself current: "4 min ago" for a day, then the date. The full time sits in the tooltip. */
export function When({ iso, className = '' }: { iso: string; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={iso} className={className}>
      {formatWhen(iso, now)}
    </time>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-button text-muted transition-[background-color,color] duration-[160ms] ease-out hover:bg-[rgba(242,242,238,0.06)] hover:text-fg"
    >
      {copied ? <CheckIcon className="text-accent" /> : <CopyIcon />}
    </button>
  );
}

/** Links to the memories a decision relied on. A memory that Walrus does not hold yet has no blob to open, so it gets no chip. */
export function MemoryChips({ memories, className = '' }: { memories: CitedMemory[]; className?: string }) {
  const stored = memories.flatMap((memory) =>
    memory.blobId === null ? [] : [{ memoryId: memory.memoryId, blobId: memory.blobId }],
  );
  if (stored.length === 0) return null;
  return (
    <ul className={`flex flex-wrap gap-2 ${className}`}>
      {stored.map(({ memoryId, blobId }) => (
        <li key={memoryId}>
          <a
            href={walruscanUrl(blobId)}
            target="_blank"
            rel="noopener"
            className="inline-flex h-7 items-center rounded-button border border-line px-3 font-mono text-[12px] leading-none text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)]"
          >
            Memory {blobId.slice(0, 6)}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The agent's own words, always in quotes and set apart from Ellai's facts by a left rule. */
export function AgentQuote({ purpose }: { purpose: string }) {
  return (
    <blockquote className="border-l-2 border-line pl-3 text-[15px] leading-[1.5] text-muted [overflow-wrap:anywhere]">
      {'“'}
      {purpose}
      {'”'}
    </blockquote>
  );
}

export type Tone = 'accent' | 'paid' | 'asked' | 'refused' | 'muted';

const TONE: Record<Tone, string> = {
  accent: 'border-accent text-accent',
  paid: 'border-paid text-paid',
  asked: 'border-asked text-asked',
  refused: 'border-refused text-refused',
  muted: 'border-muted text-muted',
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`label-mono inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-button border px-2 ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  paid: 'text-paid',
  asked: 'text-asked',
  refused: 'text-refused',
  muted: 'text-muted',
};
