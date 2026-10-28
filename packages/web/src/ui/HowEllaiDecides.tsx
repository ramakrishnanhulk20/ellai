'use client';

import { AnimatePresence, motion, useInView } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { exampleSignature, pickExample, STEP_COUNT, STEPS, type Example } from './decide-model.js';
import { MobileStage, Stage } from './DecideStage.js';
import type { MapDecision } from './memory-map.js';
import { RISE_EASE } from './motion-tokens.js';
import { gsap, refreshScrollTriggers } from './scroll-trigger.js';
import { useMediaQuery, usePrefersReducedMotion } from './useMediaQuery.js';
import { useMemoryMap } from './useMemoryMap.js';

const NO_DECISIONS: MapDecision[] = [];
const PIN_DISTANCE = '+=400%';

const TITLE_CLASS =
  'font-display text-[clamp(2rem,4vw,3.5rem)] font-medium leading-[1.05] tracking-[-0.01em] text-fg';

function stepNumber(index: number): string {
  return `0${index + 1} / 0${STEP_COUNT}`;
}

/** One step of the small-screen and reduced-motion layout: its words, then its stage state. */
function StackedStep({ index, example, still }: { index: number; example: Example | null; still: boolean }) {
  const block = useRef<HTMLElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const step = STEPS[index];
  if (!step) return null;
  return (
    <motion.article
      ref={block}
      className={index === 0 ? 'mt-12' : 'mt-16'}
      initial={still ? false : { opacity: 0, y: 24 }}
      animate={still || seen ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: 0.7, ease: RISE_EASE }}
    >
      <p className="font-mono text-[14px] text-fg">{stepNumber(index)}</p>
      <h2 className={`mt-4 ${TITLE_CLASS}`}>{step.title}</h2>
      <p className="mt-4 max-w-[440px] text-[18px] leading-[1.5] text-muted">{step.text}</p>
      <div className="mt-8">
        <MobileStage step={index} example={example} live={still || seen} still={still} />
      </div>
    </motion.article>
  );
}

/**
 * Section 6. On wide screens it pins for 400vh and the scroll moves through five steps, each
 * adding to one stage, told with Ellai's newest learned approval. On small screens, or for
 * people who ask for less motion, the five steps are stacked and nothing pins.
 */
export function HowEllaiDecides() {
  const state = useMemoryMap();
  const reduced = usePrefersReducedMotion();
  const wide = useMediaQuery('(min-width: 1024px)');
  const frame = useRef<HTMLDivElement>(null);
  const live = useInView(frame, { once: true, amount: 0.5 });
  const [step, setStep] = useState(0);

  const decisions = state.status === 'ready' ? state.data.decisions : NO_DECISIONS;
  const picked = pickExample(decisions);
  const signature = exampleSignature(picked);
  // The signature stands in for the example: a refresh that brings the same decision must not rebuild anything.
  const example = useMemo(() => picked, [signature]);

  const pinned = wide && !reduced;

  useEffect(() => {
    const target = frame.current;
    if (!pinned || !target) return;
    setStep(0);
    const context = gsap.context(() => {
      const playhead = { progress: 0 };
      // Scrubbing the tween, not the raw scroll, gives the 0.6 second catch-up.
      gsap.to(playhead, {
        progress: 1,
        ease: 'none',
        onUpdate: () => {
          target.style.setProperty('--progress', playhead.progress.toFixed(4));
          setStep(Math.min(STEP_COUNT - 1, Math.floor(playhead.progress * STEP_COUNT)));
        },
        // Section 5 sits above this one, so it must measure first; its pin pushes this one down.
        scrollTrigger: {
          trigger: target,
          start: 'top top',
          end: PIN_DISTANCE,
          pin: true,
          scrub: 0.6,
          refreshPriority: 1,
        },
      });
    }, target);
    refreshScrollTriggers();
    return () => {
      context.revert();
      target.style.removeProperty('--progress');
      refreshScrollTriggers();
    };
  }, [pinned]);

  const current = STEPS[step] ?? STEPS[0];

  return (
    <section aria-label="How Ellai decides" className="mt-24 lg:mt-40">
      <div
        ref={frame}
        style={pinned ? undefined : ({ '--progress': 1 } as CSSProperties)}
        className={pinned ? 'relative h-svh overflow-hidden' : 'relative px-4 lg:px-8'}
      >
        {pinned ? (
          <>
            <div aria-hidden="true" className="absolute left-8 top-[120px] h-[240px] w-[2px] bg-line">
              <div
                className="absolute inset-x-0 top-0 bg-accent"
                style={{ height: 'calc(var(--progress, 0) * 100%)' }}
              />
            </div>
            <div className="absolute left-8 top-[120px] w-[41.666%] pl-6">
              <p className="label-mono text-muted">06 / HOW ELLAI DECIDES</p>
              <p className="mt-6 font-mono text-[14px] text-fg">{stepNumber(step)}</p>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={step}
                  className="mt-4"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: RISE_EASE } }}
                  exit={{ opacity: 0, y: -12, transition: { duration: 0.2, ease: RISE_EASE } }}
                >
                  <h2 className={TITLE_CLASS}>{current?.title}</h2>
                  <p className="mt-6 max-w-[440px] text-[18px] leading-[1.5] text-muted">{current?.text}</p>
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="absolute left-1/2 right-8 top-1/2 grid h-[70svh] -translate-y-1/2 place-items-center">
              <Stage step={step} example={example} live={live} still={false} />
            </div>
          </>
        ) : (
          <div className="max-w-[640px]">
            <p className="label-mono text-muted">06 / HOW ELLAI DECIDES</p>
            {STEPS.map((_, index) => (
              <StackedStep key={index} index={index} example={example} still={reduced} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
