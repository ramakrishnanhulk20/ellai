'use client';

import Link from 'next/link';
import { AnimatePresence, motion, useInView } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { badgeFor } from '../DecisionCard.js';
import { formatUsdc } from '../format-usdc.js';
import { buildTimeline, formatWhen, type NodeKind, type TimelineNode } from '../timeline-model.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { useMemoryMap } from '../useMemoryMap.js';
import { ArrowRight } from './Arrow.js';
import { earlyLate, markLabel, type EarlyLate } from './learning-model.js';
import { SquareLabel } from './SquareLabel.js';

const EASE = [0.16, 1, 0.3, 1] as const;

const MARK_LOOK: Record<NodeKind, string> = {
  asked: 'border-[1.5px] border-ink bg-paper',
  learned: 'bg-accent',
  grant: 'bg-ink',
  refused: 'bg-refused-mark',
};

const BADGE_TONE: Record<NodeKind, string> = {
  learned: 'bg-accent-wash text-accent-text',
  asked: 'bg-bone text-ink',
  grant: 'bg-bone text-ink',
  refused: 'bg-refused-wash text-refused',
};

const LEGEND: Record<NodeKind, string> = {
  asked: 'Asked you',
  learned: 'Paid or approved on its own',
  grant: 'With your yes',
  refused: 'Refused',
};

const KIND_ORDER: readonly NodeKind[] = ['asked', 'learned', 'grant', 'refused'];

const SMALL_CAPS = 'font-plex text-xs font-medium uppercase tracking-[0.06em] text-ink-soft';

/** Seconds from the strip coming into view until its last mark has finished growing. */
function marksDoneAfter(count: number): number {
  return 0.2 + Math.max(0, count - 1) * 0.025 + 0.4;
}

function Header({ still }: { still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const shown = still || seen;
  const rise = (delay: number) => ({
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    animate: shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 },
    transition: { duration: still ? 0 : 0.7, ease: EASE, delay: still ? 0 : delay },
  });
  return (
    <div ref={block}>
      <motion.div {...rise(0)}>
        <SquareLabel className="text-ink-soft">Learning, measured</SquareLabel>
      </motion.div>
      <motion.h2
        id="learning-title"
        {...rise(0.08)}
        className="mt-6 max-w-[14ch] font-grotesk text-[clamp(2.25rem,6.1vw,5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink"
      >
        It asks you less as it learns.
      </motion.h2>
      <motion.p {...rise(0.16)} className="mt-6 max-w-[36rem] text-lg leading-[1.6] text-ink-soft md:text-xl">
        Early on, Ellai asks about almost everything. As your answers build up on Walrus, it pays on its own for the
        ones you would have said yes to, and still asks about anything new.
      </motion.p>
    </div>
  );
}

function Figure({
  value,
  caption,
  tone,
  delay,
  shown,
  still,
}: {
  value: number;
  caption: string;
  tone: string;
  delay: number;
  shown: boolean;
  still: boolean;
}) {
  return (
    // Both figures share two grid rows, so the numbers line up even when one caption wraps to more lines than the other.
    <div className="row-span-2 grid grid-rows-subgrid">
      <div className="overflow-hidden">
        <motion.p
          className={`font-grotesk text-[clamp(4.5rem,13.5vw,11rem)] font-bold leading-[0.95] tracking-[-0.045em] tabular-nums ${tone}`}
          initial={still ? false : { y: '100%' }}
          animate={{ y: shown ? 0 : '100%' }}
          transition={{ duration: still ? 0 : 0.9, ease: EASE, delay: still ? 0 : delay }}
        >
          {value}
        </motion.p>
      </div>
      <p className="mt-3 font-plex text-[13px] font-medium uppercase tracking-[0.06em] text-ink-soft md:text-sm">
        {caption}
      </p>
    </div>
  );
}

/** The two large numbers. It mounts only once the decisions are in, so its in-view watch finds its element. */
function Numbers({ figures, still }: { figures: EarlyLate; still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.4 });
  const shown = still || seen;
  return (
    <div ref={block} className="mt-12 md:mt-[72px]">
      <div className="grid grid-cols-2 gap-x-8 md:grid-cols-[1fr_auto_1fr]">
        <Figure
          value={figures.early}
          caption={`Questions in the earliest ${figures.n} below`}
          tone="text-ink"
          delay={0}
          shown={shown}
          still={still}
        />
        <svg
          width="64"
          height="24"
          viewBox="0 0 64 24"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="mb-[15px] hidden self-end stroke-ink-faint md:col-start-2 md:row-start-1 md:block"
        >
          <motion.path
            d="M2 12h58M50 4l10 8-10 8"
            initial={still ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: shown ? 1 : 0, opacity: shown ? 1 : 0 }}
            transition={{
              pathLength: { duration: still ? 0 : 0.6, ease: EASE, delay: still ? 0 : 0.4 },
              // The round end cap shows as a dot at zero length, so the line stays hidden until it starts drawing.
              opacity: { duration: 0, delay: still ? 0 : 0.4 },
            }}
          />
        </svg>
        <Figure
          value={figures.late}
          caption={`Questions in the latest ${figures.n} below`}
          tone="text-accent"
          delay={0.22}
          shown={shown}
          still={still}
        />
      </div>
      <p className="mt-4 text-[15px] leading-[1.5] text-ink-soft">
        Every number here is counted from the public decisions below, the learning test included.
      </p>
    </div>
  );
}

function Bracket({ left, width, caption }: { left: number; width: number; caption: string }) {
  return (
    <div className="absolute top-0" style={{ left: `${left}%`, width: `${width}%` }}>
      <div className="h-[6px] border-x border-b border-ink-soft" />
      <p className={`mt-2 whitespace-nowrap text-center ${SMALL_CAPS}`}>{caption}</p>
    </div>
  );
}

function Tooltip({ node, center, still }: { node: TimelineNode; center: number; still: boolean }) {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute z-20 w-[220px] rounded-[12px] border border-mist bg-paper px-[14px] py-3 card-shadow [--tip-w:220px] md:w-[260px] md:[--tip-w:260px]"
      style={
        {
          bottom: 'calc(100% + 12px)',
          // Centred on the mark, then held inside the strip so a mark at either end never pushes it off screen.
          left: `clamp(0px, calc(${center}px - var(--tip-w) / 2), calc(100% - var(--tip-w)))`,
        } as CSSProperties
      }
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: still ? 0 : 0.16 } }}
      exit={{ opacity: 0, transition: { duration: still ? 0 : 0.12 } }}
    >
      <p className="font-plex text-xs text-ink-soft">{formatWhen(node.at)}</p>
      <p className="mt-1.5">
        <span
          className={`inline-block rounded-[6px] px-[7px] py-[3px] font-plex text-[11px] font-medium uppercase ${BADGE_TONE[node.kind]}`}
        >
          {badgeFor(node.decision).label}
        </span>
      </p>
      <p className="mt-1.5 text-[15px] leading-[1.4] text-ink [overflow-wrap:anywhere]">
        {formatUsdc(node.amountUsdc)} USDC to {node.host}
      </p>
    </motion.div>
  );
}

/** One mark per decision, oldest to newest, with the earliest and latest windows bracketed below. It mounts only once the decisions are in. */
function Strip({ nodes, figures, still }: { nodes: TimelineNode[]; figures: EarlyLate | null; still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const pointerType = useRef('mouse');
  const seen = useInView(block, { once: true, amount: 0.3 });
  const shown = still || seen;
  const [open, setOpen] = useState<{ id: string; center: number } | null>(null);
  const count = nodes.length;
  const kinds = KIND_ORDER.filter((kind) => nodes.some((node) => node.kind === kind));
  const openNode = open ? (nodes.find((node) => node.id === open.id) ?? null) : null;
  const isOpen = open !== null;

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideTap = (event: PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) setOpen(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', closeOnOutsideTap);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideTap);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const fade = {
    initial: still ? (false as const) : { opacity: 0 },
    animate: { opacity: shown ? 1 : 0 },
    transition: { duration: still ? 0 : 0.3, delay: still ? 0 : marksDoneAfter(count) },
  };

  return (
    <div ref={block} className="mt-16 md:mt-[88px]">
      <div className={`flex justify-between ${SMALL_CAPS}`}>
        <span>Oldest</span>
        <span>Newest</span>
      </div>

      <div ref={row} className="relative mt-3 flex h-10 items-end gap-[3px] md:h-14 md:gap-[6px]">
        {nodes.map((node, index) => (
          <motion.button
            key={node.id}
            type="button"
            aria-label={markLabel(node)}
            className={`h-full min-w-0 flex-1 rounded-[3px] ${MARK_LOOK[node.kind]}`}
            style={{ originY: 1 }}
            initial={still ? false : { scaleY: 0 }}
            animate={
              shown
                ? {
                    scaleY: 1,
                    transition: { duration: still ? 0 : 0.4, ease: EASE, delay: still ? 0 : 0.2 + index * 0.025 },
                  }
                : { scaleY: 0 }
            }
            whileHover={still ? undefined : { scaleY: 1.08, transition: { duration: 0.16 } }}
            transition={{ duration: 0.16 }}
            onPointerDown={(event) => {
              pointerType.current = event.pointerType;
            }}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse') return;
              const mark = event.currentTarget;
              setOpen({ id: node.id, center: mark.offsetLeft + mark.offsetWidth / 2 });
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') setOpen(null);
            }}
            onFocus={(event) => {
              const mark = event.currentTarget;
              if (!mark.matches(':focus-visible')) return;
              setOpen({ id: node.id, center: mark.offsetLeft + mark.offsetWidth / 2 });
            }}
            onBlur={() => setOpen(null)}
            onClick={(event) => {
              // A mouse click already has its tooltip from the hover, and Enter or Space (detail 0) from the focus.
              if (event.detail === 0 || pointerType.current === 'mouse') return;
              const mark = event.currentTarget;
              setOpen((current) =>
                current?.id === node.id ? null : { id: node.id, center: mark.offsetLeft + mark.offsetWidth / 2 },
              );
            }}
          />
        ))}
        <AnimatePresence>
          {open && openNode ? <Tooltip key={openNode.id} node={openNode} center={open.center} still={still} /> : null}
        </AnimatePresence>
      </div>

      {figures ? (
        <motion.div {...fade} className="relative mt-[10px] h-8">
          <Bracket left={0} width={(figures.n / count) * 100} caption={`Earliest ${figures.n}`} />
          <Bracket
            left={((count - figures.n) / count) * 100}
            width={(figures.n / count) * 100}
            caption={`Latest ${figures.n}`}
          />
        </motion.div>
      ) : null}

      <motion.ul {...fade} className={`mt-8 flex flex-wrap gap-4 md:gap-6 ${SMALL_CAPS}`}>
        {kinds.map((kind) => (
          <li key={kind} className="flex items-center gap-2">
            <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${MARK_LOOK[kind]}`} />
            {LEGEND[kind]}
          </li>
        ))}
      </motion.ul>

      <div className="mt-8">
        <p className="text-[15px] leading-[1.5] text-ink-soft">
          Each mark is one of the {count} most recent public decisions, oldest on the left. Approved on its own means
          Ellai would have paid without asking you; in the learning test no money moved, and the real payments are on
          the{' '}
          <Link href="/proof" className="nav-sweep font-medium text-ink">
            proof page
          </Link>
          .
        </p>
        <Link href="/proof" className="nav-sweep mt-4 font-grotesk text-base font-medium text-ink">
          See the latest payments and memories
          <span className="ml-2 inline-block align-[-2px]">
            <ArrowRight />
          </span>
        </Link>
      </div>
    </div>
  );
}

/**
 * Landing section 3. It proves the claim from the public decisions instead of stating it: the questions
 * among the earliest ten of the public decisions shown against the latest ten, and each decision as one mark on a strip.
 */
export function LearningSection() {
  const state = useMemoryMap();
  const still = usePrefersReducedMotion();
  const decisions = state.status === 'ready' ? state.data.decisions : null;
  const nodes = useMemo(() => (decisions ? buildTimeline(decisions) : []), [decisions]);
  const figures = useMemo(() => earlyLate(nodes), [nodes]);

  return (
    <section aria-labelledby="learning-title" className="relative overflow-x-clip bg-paper">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="border-t border-mist pb-28 pt-24 md:pb-40 md:pt-32">
          <Header still={still} />
          {state.status === 'loading' ? null : state.status === 'error' ? (
            <p className="mt-12 font-plex text-[13px] font-medium uppercase tracking-[0.06em] text-ink-soft md:mt-[72px]">
              The public decisions could not be read just now. Reload to try again.
            </p>
          ) : nodes.length === 0 ? (
            <p className="mt-12 font-plex text-[13px] font-medium uppercase tracking-[0.06em] text-ink-soft md:mt-[72px]">
              No public decisions to show yet
            </p>
          ) : (
            <>
              {figures ? <Numbers figures={figures} still={still} /> : null}
              <Strip nodes={nodes} figures={figures} still={still} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
