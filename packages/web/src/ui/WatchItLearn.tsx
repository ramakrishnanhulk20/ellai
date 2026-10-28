'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MapDecision } from './memory-map.js';
import { gsap, refreshScrollTriggers } from './scroll-trigger.js';
import { NarrowTimeline, WideTimeline } from './TimelineMarks.js';
import { buildTimeline, tallyThrough, timelineSignature, type Tally } from './timeline-model.js';
import { useMediaQuery, usePrefersReducedMotion } from './useMediaQuery.js';
import { useMemoryMap } from './useMemoryMap.js';

const NO_DECISIONS: MapDecision[] = [];
const PIN_DISTANCE = '+=220%';

function Counter({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div>
      <p className={`font-display text-[clamp(4rem,min(9vw,14vh),8rem)] font-semibold leading-none tabular-nums ${tone}`}>
        {value}
      </p>
      <p className="label-mono mt-3 text-muted">{label}</p>
    </div>
  );
}

function Headline({ className = '' }: { className?: string }) {
  return (
    <h2
      id="learn-heading"
      className={`font-display text-[clamp(2.5rem,6vw,6rem)] font-medium leading-none tracking-[-0.02em] text-fg ${className}`}
    >
      <span className="block">
        It asks you <span className="text-accent">less</span>
      </span>
      <span className="block">every week.</span>
    </h2>
  );
}

function Pitch({ className = '' }: { className?: string }) {
  return (
    <p className={`max-w-[400px] text-[18px] leading-[1.5] text-muted ${className}`}>
      Early on, Ellai asks about almost everything. As your answers build up on Walrus, it pays the ones you
      would have approved on its own, and still asks about anything new.
    </p>
  );
}

function EmptyNote() {
  return <p className="label-mono text-muted">NO PUBLIC DECISIONS YET</p>;
}

function Counters({ tally }: { tally: Tally }) {
  return (
    <>
      <Counter value={tally.asked} label="QUESTIONS ASKED" tone="text-asked" />
      <Counter value={tally.paid} label="PAID ON ITS OWN" tone="text-accent" />
    </>
  );
}

/**
 * Section 5. On wide screens it pins for 220vh and a playhead walks along Ellai's real decisions,
 * oldest first; each one appears as the playhead passes it and the two counters tick with them.
 * On small screens, or for people who ask for less motion, nothing pins.
 */
export function WatchItLearn() {
  const state = useMemoryMap();
  const reduced = usePrefersReducedMotion();
  const wide = useMediaQuery('(min-width: 1024px)');
  const stage = useRef<HTMLDivElement>(null);
  const [passed, setPassed] = useState(0);
  const [scrolledIn, setScrolledIn] = useState(0);

  const decisions = state.status === 'ready' ? state.data.decisions : NO_DECISIONS;
  const signature = timelineSignature(decisions);
  // The signature stands in for the decisions: a refresh with the same decisions must not rebuild the pin.
  const nodes = useMemo(() => buildTimeline(decisions), [signature]);
  const count = nodes.length;

  const settled = reduced || count === 0;
  const pinned = wide && !settled;
  const shown = settled ? count : Math.min(count, wide ? passed : scrolledIn);
  const tally = tallyThrough(nodes, shown);

  useEffect(() => {
    const target = stage.current;
    if (!pinned || !target) return;
    setPassed(0);
    const context = gsap.context(() => {
      const playhead = { progress: 0 };
      // Scrubbing the tween, not the raw scroll, gives the 0.6 second catch-up.
      gsap.to(playhead, {
        progress: 1,
        ease: 'none',
        onUpdate: () => {
          target.style.setProperty('--progress', playhead.progress.toFixed(4));
          setPassed(Math.min(count, Math.max(0, Math.floor(playhead.progress * count + 0.5))));
        },
        // Measured before section 6 below it, whose start moves down by this pin's length.
        scrollTrigger: {
          trigger: target,
          start: 'top top',
          end: PIN_DISTANCE,
          pin: true,
          scrub: 0.6,
          refreshPriority: 2,
        },
      });
    }, target);
    refreshScrollTriggers();
    return () => {
      context.revert();
      target.style.removeProperty('--progress');
      refreshScrollTriggers();
    };
  }, [pinned, count]);

  const reveal = useCallback((index: number) => setScrolledIn((current) => Math.max(current, index + 1)), []);

  const stageStyle = !pinned && wide ? ({ '--progress': 1 } as CSSProperties) : undefined;
  const empty = count === 0 && state.status !== 'loading';

  return (
    <section aria-labelledby="learn-heading" className="mt-24 lg:mt-40">
      <div
        ref={stage}
        style={stageStyle}
        className={wide ? 'relative h-svh overflow-hidden px-8 pt-[120px]' : 'relative px-4'}
      >
        {wide ? (
          <>
            <p className="label-mono text-muted">05 / WATCH IT LEARN</p>
            <div className="mt-6 grid grid-cols-[58.333%_1fr] items-end">
              <Headline />
              <Pitch />
              <div className="mt-16">
                <Counter value={tally.asked} label="QUESTIONS ASKED" tone="text-asked" />
              </div>
              <div className="mt-16">
                <Counter value={tally.paid} label="PAID ON ITS OWN" tone="text-accent" />
              </div>
            </div>
            {count > 0 ? (
              <>
                <WideTimeline nodes={nodes} shown={shown} />
                <p className="label-mono absolute inset-x-8 top-[calc(72%+56px)] text-center text-faint">
                  EVERY MARK IS A REAL DECISION, OLDEST ON THE LEFT
                </p>
              </>
            ) : (
              <div className="absolute inset-x-8 top-[72%]">{empty ? <EmptyNote /> : null}</div>
            )}
          </>
        ) : (
          <>
            <p className="label-mono text-muted">05 / WATCH IT LEARN</p>
            <Headline className="mt-6" />
            <Pitch className="mt-6" />
            <div className="relative mt-10">
              <div className="sticky top-[60px] z-10 -mx-4 grid grid-cols-2 gap-4 bg-[rgba(8,9,10,0.72)] px-4 py-3 backdrop-blur-[12px]">
                <Counters tally={tally} />
              </div>
              <div className="mt-6">
                {count > 0 ? (
                  <NarrowTimeline nodes={nodes} shown={shown} still={reduced} onReveal={reveal} />
                ) : empty ? (
                  <EmptyNote />
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
