'use client';

import { AnimatePresence, motion, useInView } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { gsap, refreshScrollTriggers } from '../scroll-trigger.js';
import { useMediaQuery, usePrefersReducedMotion } from '../useMediaQuery.js';
import { useMemoryMap } from '../useMemoryMap.js';
import { EASE_OUT_EXPO, JourneyCard } from './JourneyCards.js';
import { JourneyRoute, MiniRoute } from './JourneyRoute.js';
import { BEATS, beatAt, buildJourney, loopProgress, tokenX, YOU_X, type Journey } from './journey-model.js';

const PIN_DISTANCE = '+=500%';
const BEAT_TOTAL = String(BEATS.length).padStart(2, '0');

/** Where each beat's card hangs under the route: the node the payment rests on, and the owner for the last beat. */
const CARD_ANCHOR = [0.25, 0.5, 0.75, 1, YOU_X] as const;

const DOT_GRID: CSSProperties = {
  backgroundImage: 'radial-gradient(#DEDFDF 1.4px, transparent 1.4px)',
  backgroundSize: '14px 14px',
  maskImage: 'radial-gradient(ellipse 80% 70% at 50% 55%, #000 35%, transparent 100%)',
  WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 55%, #000 35%, transparent 100%)',
};

function beatNumber(index: number): string {
  return `${String(index + 1).padStart(2, '0')} / ${BEAT_TOTAL}`;
}

function SectionLabel() {
  return (
    <h2
      id="journey-label"
      className="flex items-center gap-3 font-plex text-sm font-medium uppercase tracking-[0.06em] text-ink-soft"
    >
      <span aria-hidden className="size-2 shrink-0 bg-accent" />A payment&apos;s journey
    </h2>
  );
}

/** One beat of the stacked layout: its words, a thin route, then its card. Nothing pins. */
function StackedBeat({ index, journey, still }: { index: number; journey: Journey; still: boolean }) {
  const block = useRef<HTMLElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const beat = BEATS[index];
  if (!beat) return null;
  const shown = still || seen;
  return (
    <motion.article
      ref={block}
      className={index === 0 ? 'mt-10' : 'mt-[72px]'}
      initial={still ? false : { opacity: 0, y: 24 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
    >
      <p className="font-plex text-sm text-ink-soft">{beatNumber(index)}</p>
      <h3 className="mt-3 font-grotesk text-[clamp(1.75rem,6vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.025em] text-ink">
        {beat.title}
      </h3>
      <p className="mt-3 max-w-[34rem] text-[17px] leading-[1.6] text-ink-soft">{beat.text}</p>
      <div className="mt-6 pb-5">
        <MiniRoute beat={index} />
      </div>
      <div className="mt-8 max-w-[420px]">
        <JourneyCard beat={index} journey={journey} active={shown} />
      </div>
    </motion.article>
  );
}

/**
 * The signature moment. On wide screens it pins for 500vh and the scroll walks one payment across the
 * route, opening a card with the real numbers at each stop and ending on the learning loop. On small
 * screens, or for people who ask for less motion, the five beats are stacked and nothing pins.
 */
export function JourneySection() {
  const state = useMemoryMap();
  const reduced = usePrefersReducedMotion();
  const wide = useMediaQuery('(min-width: 1024px)');
  const frame = useRef<HTMLDivElement>(null);
  const [beat, setBeat] = useState(0);

  const map = state.status === 'ready' ? state.data : null;
  const journey = useMemo(() => buildJourney(map), [map]);
  const pinned = wide && !reduced;

  useEffect(() => {
    const target = frame.current;
    if (!pinned || !target) return;
    setBeat(0);
    let current = 0;
    const context = gsap.context(() => {
      const playhead = { progress: 0 };
      // Scrubbing the tween, not the raw scroll, gives the 0.6 second catch-up.
      gsap.to(playhead, {
        progress: 1,
        ease: 'none',
        onUpdate: () => {
          const progress = playhead.progress;
          target.style.setProperty('--j', progress.toFixed(4));
          target.style.setProperty('--tx', tokenX(progress).toFixed(4));
          target.style.setProperty('--arc', loopProgress(progress).toFixed(4));
          const next = beatAt(progress);
          if (next !== current) {
            current = next;
            setBeat(next);
          }
        },
        scrollTrigger: {
          trigger: target,
          start: 'top top',
          end: PIN_DISTANCE,
          pin: true,
          scrub: 0.6,
        },
      });
    }, target);
    refreshScrollTriggers();
    return () => {
      context.revert();
      target.style.removeProperty('--j');
      target.style.removeProperty('--tx');
      target.style.removeProperty('--arc');
      refreshScrollTriggers();
    };
  }, [pinned]);

  const current = BEATS[beat] ?? BEATS[0];
  const anchor = CARD_ANCHOR[beat] ?? CARD_ANCHOR[0];

  // The frame div stays the same element in both layouts: the pin wraps it, and React must still find it in place when the layout flips.
  return (
    <section aria-labelledby="journey-label">
      <div
        ref={frame}
        className={
          pinned
            ? 'relative flex h-[100svh] flex-col justify-center overflow-hidden bg-paper pt-[72px]'
            : 'mx-auto w-full max-w-[100rem] px-5 pb-8 pt-24 sm:px-8 lg:px-14'
        }
      >
        {pinned ? (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-0" style={DOT_GRID} />
            <div className="relative mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
              <div className="h-[176px]">
                <div className="flex items-center gap-4">
                  <SectionLabel />
                  <span className="font-plex text-sm text-ink-soft">{beatNumber(beat)}</span>
                </div>
                <div aria-live="polite">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={beat}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT_EXPO } }}
                      exit={{ opacity: 0, y: -12, transition: { duration: 0.2, ease: EASE_OUT_EXPO } }}
                    >
                      <h3 className="mt-5 whitespace-nowrap font-grotesk text-[clamp(2rem,3.4vw,3.25rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
                        {current?.title}
                      </h3>
                      <p className="mt-3 max-w-[40rem] text-lg leading-[1.6] text-ink-soft">{current?.text}</p>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>

              <div className="h-[clamp(48px,9svh,88px)]" />
              <JourneyRoute beat={beat} amount={journey.example?.amount ?? null} />
              <div className="h-[clamp(32px,6svh,56px)]" />

              <div className="relative min-h-[272px]">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={beat}
                    className="relative"
                    style={
                      {
                        '--node-x': anchor,
                        width: 'min(360px, 100%)',
                        left: 'clamp(0px, calc(var(--node-x) * 100% - 180px), calc(100% - 360px))',
                      } as CSSProperties
                    }
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT_EXPO, delay: 0.1 } }}
                    exit={{ opacity: 0, y: -8, transition: { duration: 0.2, ease: EASE_OUT_EXPO } }}
                  >
                    <JourneyCard beat={beat} journey={journey} active />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </>
        ) : (
          <>
            <SectionLabel />
            {BEATS.map((entry, index) => (
              <StackedBeat key={entry.id} index={index} journey={journey} still={reduced} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
