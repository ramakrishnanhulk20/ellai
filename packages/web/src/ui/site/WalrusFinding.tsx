'use client';

import { motion, useInView } from 'motion/react';
import { useRef } from 'react';
import { useMediaQuery, usePrefersReducedMotion } from '../useMediaQuery.js';
import { FindingLinks, rise } from './CheckSection.js';
import { SquareLabel } from './SquareLabel.js';

const FOUR_COLUMNS_QUERY = '(min-width: 1024px)';

const STEP_STAGGER_SECONDS = 0.1;

type Step = {
  date: string;
  title: string;
  text: string;
  /** The last step is what Ellai does today, so its bar is ink instead of the accent. */
  today?: boolean;
};

const STEPS: readonly Step[] = [
  {
    date: '2 Nov 2026',
    title: 'What broke',
    text: "A memory search could hang for good. The SDK's own timeout did not cover one Sui read inside its encryption session setup, so a stalled read stalled the search.",
  },
  {
    date: '2 Nov 2026',
    title: 'We filed it',
    text: 'We filed the issue with a script that reproduces the hang, on the SDK version Ellai runs.',
  },
  {
    date: '2 Nov 2026',
    title: 'The Walrus team confirmed it',
    text: 'The Walrus Memory team reproduced it on SDK 0.1.12, confirmed the cause and opened a fix.',
  },
  {
    date: 'Today',
    title: 'Ellai stays safe meanwhile',
    text: 'Ellai waits at most 15 seconds for a memory search. When a search runs out, Ellai never pays on its own: it asks you, or refuses if too many questions are already waiting.',
    today: true,
  },
];

function StepCard({ step, index, still, inRow }: { step: Step; index: number; still: boolean; inRow: boolean }) {
  const card = useRef<HTMLLIElement>(null);
  const seen = useInView(card, { once: true, amount: 0.3 });
  const shown = still || seen;
  // Side by side the four rise one after another; stacked, each rises as it is scrolled to, with no extra wait.
  const delay = inRow ? index * STEP_STAGGER_SECONDS : 0;

  return (
    <motion.li
      ref={card}
      {...rise(shown, still, delay)}
      className="relative overflow-hidden rounded-[12px] border border-mist bg-paper p-5 card-shadow"
    >
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${step.today ? 'bg-ink' : 'bg-accent'}`} />
      <p className="font-plex text-xs font-medium uppercase tracking-[0.06em] text-ink-soft">{step.date}</p>
      <h3 className="mt-[10px] font-grotesk text-lg font-semibold leading-[1.3] text-ink">{step.title}</h3>
      <p className="mt-2 text-[15px] leading-[1.55] text-ink-soft">{step.text}</p>
    </motion.li>
  );
}

/**
 * The whole story of the Walrus Memory bug on the proof page: what broke, what we filed, what the
 * Walrus team said, and what keeps Ellai safe until their fix ships. The id lets /proof#walrus-finding
 * jump straight here, and the scroll margin keeps the fixed header off the panel's top edge.
 */
export function WalrusFinding() {
  const still = usePrefersReducedMotion();
  const inRow = useMediaQuery(FOUR_COLUMNS_QUERY);

  const head = useRef<HTMLDivElement>(null);
  const headSeen = useInView(head, { once: true, amount: 0.3 });
  const headShown = still || headSeen;

  const links = useRef<HTMLDivElement>(null);
  const linksSeen = useInView(links, { once: true, amount: 0.3 });
  const linksShown = still || linksSeen;

  return (
    <section
      id="walrus-finding"
      aria-labelledby="walrus-finding-title"
      className="mt-24 scroll-mt-24 rounded-[12px] border border-mist bg-bone p-6 md:mt-32 md:p-12"
    >
      <div ref={head}>
        <motion.div {...rise(headShown, still, 0)}>
          <SquareLabel className="text-ink-soft">Found while building</SquareLabel>
        </motion.div>
        <motion.h2
          id="walrus-finding-title"
          {...rise(headShown, still, 0.08)}
          className="mt-[18px] max-w-[22ch] font-grotesk text-[clamp(1.75rem,3.6vw,3rem)] font-bold leading-[1.08] tracking-[-0.025em] text-ink"
        >
          We found a bug in Walrus Memory. The Walrus team confirmed it.
        </motion.h2>
      </div>

      <ol className="mt-10 grid gap-3 lg:grid-cols-4 lg:gap-6">
        {STEPS.map((step, index) => (
          <StepCard key={step.title} step={step} index={index} still={still} inRow={inRow} />
        ))}
      </ol>

      <div ref={links} className="mt-8 grid gap-3 md:grid-cols-2">
        <FindingLinks shown={linksShown} still={still} />
      </div>
    </section>
  );
}
