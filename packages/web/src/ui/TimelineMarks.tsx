'use client';

import { motion } from 'motion/react';
import { BADGES } from './DecisionCard.js';
import { formatUsdc } from './format-usdc.js';
import { RISE_EASE } from './motion-tokens.js';
import { formatWhen, type NodeKind, type TimelineNode } from './timeline-model.js';

/** One mark, 12px. The shape and colour say how the decision ended. */
export function Mark({ kind }: { kind: NodeKind }) {
  if (kind === 'refused') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="stroke-refused">
        <path d="M1.5 1.5 10.5 10.5M10.5 1.5 1.5 10.5" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  const tone =
    kind === 'asked'
      ? 'border-[1.5px] border-asked'
      : kind === 'learned'
        ? 'bg-accent shadow-[0_0_12px_color-mix(in_srgb,var(--accent)_60%,transparent)]'
        : 'bg-paid';
  return <span aria-hidden="true" className={`block size-3 rounded-full ${tone}`} />;
}

function describe(node: TimelineNode): string {
  return `${formatUsdc(node.amountUsdc)} USDC to ${node.host}`;
}

function TipCard({ node }: { node: TimelineNode }) {
  const badge = BADGES[node.outcome];
  return (
    <>
      <p className="font-mono text-[12px] leading-normal text-muted">{formatWhen(node.at)}</p>
      <p className="mt-1 break-words text-[16px] leading-[1.25] text-fg">{describe(node)}</p>
      <p className={`label-mono mt-3 inline-flex h-6 items-center rounded-button border px-2 ${badge.tone}`}>
        {badge.label}
      </p>
    </>
  );
}

// Marks near either end line their card up with the mark's edge so it never leaves the screen.
function tipPlacement(position: number): string {
  if (position < 0.14) return '-left-3';
  if (position > 0.86) return '-right-3';
  return 'left-1/2 -ml-[120px]';
}

/** The horizontal timeline for wide screens. Marks show as the playhead passes them. */
export function WideTimeline({ nodes, shown }: { nodes: readonly TimelineNode[]; shown: number }) {
  return (
    <div className="absolute inset-x-8 top-[72%] h-0">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-line" />
      {nodes.map((node, index) => (
        <div
          key={node.id}
          data-on={index < shown ? '' : undefined}
          style={{ left: `${node.position * 100}%` }}
          className="tl-node absolute top-0 size-6 -translate-x-1/2 -translate-y-1/2 hover:z-10 focus-within:z-10"
        >
          <button
            type="button"
            aria-label={`${formatWhen(node.at)}. ${describe(node)}. ${BADGES[node.outcome].label.toLowerCase()}`}
            className="grid size-6 place-items-center rounded-full"
          >
            <span className="tl-mark">
              <Mark kind={node.kind} />
            </span>
          </button>
          <div
            aria-hidden="true"
            className={`tl-tip absolute bottom-full mb-3 w-[240px] rounded-card border border-line bg-[rgba(8,9,10,0.72)] p-3 text-left backdrop-blur-[12px] ${tipPlacement(node.position)}`}
          >
            <TipCard node={node} />
          </div>
        </div>
      ))}
      <span aria-hidden="true" className="tl-playhead" />
    </div>
  );
}

const MARK_IN = {
  hidden: { scale: 0 },
  show: { scale: 1, transition: { duration: 0.3, ease: RISE_EASE } },
};

type NarrowProps = {
  nodes: readonly TimelineNode[];
  /** How many marks have appeared. Marks above the highest one that scrolled into view count as passed. */
  shown: number;
  /** Plain marks with no scroll-in, for people who ask for less motion. */
  still: boolean;
  onReveal: (index: number) => void;
};

/** The vertical timeline for small screens: a line, then each decision stacked 40px apart. */
export function NarrowTimeline({ nodes, shown, still, onReveal }: NarrowProps) {
  return (
    <div className="relative">
      <div aria-hidden="true" className="absolute bottom-5 left-6 top-5 w-px bg-line" />
      <ol>
        {nodes.map((node, index) => (
          <li key={node.id} className="relative flex min-h-10 flex-col justify-center pl-12">
            <span className="absolute left-6 top-1/2 grid size-3 -translate-x-1/2 -translate-y-1/2 place-items-center">
              {still ? (
                <Mark kind={node.kind} />
              ) : (
                <motion.span
                  className="grid place-items-center"
                  variants={MARK_IN}
                  initial="hidden"
                  animate={index < shown ? 'show' : undefined}
                  whileInView="show"
                  viewport={{ once: true }}
                  onViewportEnter={() => onReveal(index)}
                >
                  <Mark kind={node.kind} />
                </motion.span>
              )}
            </span>
            <span className="block text-[14px] leading-[1.35] text-muted">{formatWhen(node.at)}</span>
            <span className="block break-words text-[14px] leading-[1.35] text-fg">
              {describe(node)}
              <span className="sr-only">. {BADGES[node.outcome].label.toLowerCase()}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
