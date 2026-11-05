import { Fragment } from 'react';
import { NODES, YOU_X } from './journey-model.js';

const LAST_NODE = NODES.length - 1;
const EASE = 'ease-[cubic-bezier(0.16,1,0.3,1)]';
const DASHED_LINE = 'linear-gradient(to right, var(--mist) 50%, transparent 50%)';

/** The node the payment chip rests on once a beat has finished travelling. The last beat stays on Sui. */
function restingNode(beat: number): number {
  return Math.min(Math.max(beat, 0) + 1, LAST_NODE);
}

/**
 * The route one payment takes, drawn across the pinned frame. The chip and the line it leaves behind
 * follow --tx, and the loop to the owner follows --arc. The frame writes both on every scroll tick, so
 * React only redraws when the beat changes and the nodes change colour.
 */
export function JourneyRoute({ beat, amount }: { beat: number; amount: string | null }) {
  const resting = restingNode(beat);
  const looping = beat >= LAST_NODE;

  return (
    <div aria-hidden className="relative h-[2px] w-full">
      <div className="absolute inset-0" style={{ backgroundImage: DASHED_LINE, backgroundSize: '10px 2px' }} />
      <div
        className="absolute inset-0 origin-left bg-accent"
        style={{ transform: 'scaleX(var(--tx, 0))' }}
      />

      {/* The arc is wiped in from the left with a clip, not drawn with a dash: a dash pattern on a stretched, fixed-width stroke breaks into gaps. The arc only ever moves right, so the wipe reads as drawing. */}
      <svg
        className={`absolute overflow-visible transition-opacity duration-300 ${looping ? 'opacity-100' : 'opacity-0'}`}
        style={{
          left: '50%',
          width: '25%',
          bottom: '1px',
          height: '64px',
          clipPath: 'inset(-8px calc((1 - var(--arc, 0)) * (100% + 16px) - 8px) -8px -8px)',
        }}
        viewBox="0 0 100 64"
        preserveAspectRatio="none"
      >
        <path
          d="M0 64 C0 0 100 0 100 64"
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      </svg>

      {NODES.map((node, index) => {
        const reached = index <= resting;
        const first = index === 0;
        const last = index === LAST_NODE;
        return (
          <Fragment key={node.id}>
            <span
              className={`absolute top-[1px] size-[14px] -translate-x-1/2 -translate-y-1/2 border-[1.5px] transition-[background-color,border-color] duration-300 ${
                reached ? 'border-accent bg-accent' : 'border-mist bg-paper'
              }`}
              style={{ left: `${node.x * 100}%` }}
            >
              {index === resting ? (
                <span className="journey-pulse absolute -inset-[1.5px] border-[1.5px] border-accent" />
              ) : null}
            </span>
            <span
              className={`absolute top-[20px] whitespace-nowrap font-plex text-xs font-medium uppercase tracking-[0.06em] transition-colors duration-300 ${
                reached ? 'text-ink' : 'text-ink-soft'
              } ${first ? 'left-0' : last ? 'right-0' : '-translate-x-1/2'}`}
              style={first || last ? undefined : { left: `${node.x * 100}%` }}
            >
              {node.label}
            </span>
          </Fragment>
        );
      })}

      <div
        className={`absolute size-[14px] -translate-x-1/2 -translate-y-1/2 bg-ink transition-transform duration-300 ${EASE} ${
          looping ? 'scale-100' : 'scale-[0.6]'
        }`}
        style={{ left: `${YOU_X * 100}%`, top: '-48px', opacity: 'clamp(0, calc((var(--arc, 0) - 0.5) * 10), 1)' }}
      >
        <span className="absolute bottom-full left-1/2 mb-[7px] -translate-x-1/2 font-plex text-xs font-medium uppercase leading-4 tracking-[0.06em] text-ink">
          You
        </span>
      </div>

      {/* The wrapper has no width, so the stem always sits on the node. The chip slides sideways by its own width times --tx: left-aligned to the node at the agent, centred halfway, right-aligned at Sui, so it never leaves the route's ends. */}
      <div
        className="absolute top-[1px] w-0"
        style={{ left: 'calc(var(--tx, 0) * 100%)', transform: 'translateY(calc(-50% - 22px))' }}
      >
        <span
          className="block w-max whitespace-nowrap rounded-[6px] bg-accent px-2 py-1 font-plex text-xs font-medium leading-3 text-accent-ink chip-shadow"
          style={{ transform: 'translateX(calc(var(--tx, 0) * -100%))' }}
        >
          {amount ? `${amount} USDC` : 'USDC'}
        </span>
        <span className="absolute left-0 top-full h-[14px] w-px -translate-x-1/2 bg-accent" />
      </div>
    </div>
  );
}

/** The route as a thin strip for the stacked layout: the beat's node is lit and named, the rest stay quiet. */
export function MiniRoute({ beat }: { beat: number }) {
  const lit = beat >= LAST_NODE ? 3 : restingNode(beat);
  const node = NODES[lit];
  const label = beat >= LAST_NODE ? 'You, then Walrus Memory' : (node?.label ?? '');
  const x = node?.x ?? 0;
  const labelPlace =
    x < 0.2
      ? { className: 'left-0', style: undefined }
      : x > 0.7
        ? { className: 'right-0 text-right', style: undefined }
        : { className: '-translate-x-1/2', style: { left: `${x * 100}%` } };

  return (
    <div aria-hidden className="relative h-[2px] w-full">
      <div className="absolute inset-0" style={{ backgroundImage: DASHED_LINE, backgroundSize: '10px 2px' }} />
      {NODES.map((entry, index) => (
        <span
          key={entry.id}
          className={`absolute top-[1px] size-[10px] -translate-x-1/2 -translate-y-1/2 border-[1.5px] ${
            index <= lit ? 'border-accent bg-accent' : 'border-mist bg-paper'
          }`}
          style={{ left: `${entry.x * 100}%` }}
        />
      ))}
      <span
        className={`absolute top-[12px] whitespace-nowrap font-plex text-[11px] uppercase tracking-[0.06em] text-ink ${labelPlace.className}`}
        style={labelPlace.style}
      >
        {label}
      </span>
    </div>
  );
}
