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
    <section
      className={`rounded-[12px] border border-line bg-panel p-6 shadow-[0_1px_2px_rgba(26,26,26,0.05),0_12px_28px_-8px_rgba(26,26,26,0.10)] lg:p-7 ${className}`}
      {...rest}
    >
      {children}
    </section>
  );
}

/** A big count over its small caps label. A null value means the count is still loading, so it shows three dots and no number. */
export function Figure({
  value,
  label,
  tone,
  className = '',
}: {
  value: number | null;
  label: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <Card className={`p-5! ${className}`}>
      <p className={`font-display text-[36px] font-bold leading-none tabular-nums ${tone ? TONE_TEXT[tone] : 'text-fg'}`}>
        {value === null ? <span className="opacity-40">{'···'}</span> : value}
      </p>
      <p className="mt-2 font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-muted">{label}</p>
    </Card>
  );
}

export type Verdict = 'approved' | 'refused' | 'asked' | 'neutral';

/**
 * The small square at the start of a row: accent when approved, red when refused, hollow while the question still
 * waits on the owner, and grey for a row whose data carries no verdict. The grey is decoration, not a status.
 */
export function VerdictSquare({ verdict }: { verdict: Verdict }) {
  const look =
    verdict === 'asked'
      ? 'border-[1.5px] border-fg'
      : verdict === 'refused'
        ? 'bg-refused'
        : verdict === 'neutral'
          ? 'bg-[#a7aaaa]'
          : 'bg-accent';
  return <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-[2px] ${look}`} />;
}

/** A link out to a transaction or a blob, with the arrow that says it leaves the app. */
export function ChainLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-1 font-mono text-[12px] leading-[1.4] text-[#2f45c8] underline-offset-2 hover:underline"
    >
      {children}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8.5l5-5M4.5 3.5h4v4" />
      </svg>
    </a>
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
      <header className="mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <p className="flex items-center gap-3 font-mono text-[13px] font-medium uppercase tracking-[0.06em] text-muted md:text-[14px]">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-accent" />
            {label}
          </p>
          <h1 className="mt-4 font-display text-[clamp(2.25rem,4.4vw,3.75rem)] font-bold leading-[1.04] tracking-[-0.03em] text-fg">
            {title}
          </h1>
          {intro ? <p className="mt-4 max-w-[40rem] text-[17px] leading-[1.6] text-muted md:text-[18px]">{intro}</p> : null}
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
      className="grid h-7 w-7 shrink-0 place-items-center rounded-button text-muted transition-[background-color,color] duration-[160ms] ease-out hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] hover:text-fg"
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
            className="inline-flex h-7 items-center rounded-button border border-line px-3 font-mono text-[12px] leading-none text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]"
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
  accent: 'bg-[color-mix(in_srgb,var(--accent)_10%,#ffffff)] text-[#2f45c8]',
  paid: 'bg-[color-mix(in_srgb,var(--paid)_10%,#ffffff)] text-paid',
  asked: 'bg-[color-mix(in_srgb,var(--asked)_10%,#ffffff)] text-asked',
  refused: 'bg-[#fdeceb] text-refused',
  muted: 'bg-[#f1f1f1] text-muted',
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-[6px] px-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] ${TONE[tone]}`}
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
