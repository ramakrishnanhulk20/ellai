'use client';

import { motion } from 'motion/react';
import { RISE_EASE } from './motion-tokens.js';
import { usePrefersReducedMotion } from './useMediaQuery.js';

const FIRST_LINE = ['Every', 'yes', 'you', 'give'];
const SECOND_LINE = ['becomes', 'a', 'memory.'];

const WORD = {
  hidden: { opacity: 0, y: 40 },
  show: (index: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.8, ease: RISE_EASE, delay: index * 0.05 },
  }),
};

function Words({ words, offset, accentFrom }: { words: string[]; offset: number; accentFrom?: number }) {
  const reduced = usePrefersReducedMotion();
  return words.map((word, position) => {
    const tone = accentFrom !== undefined && position >= accentFrom ? 'text-accent' : '';
    return (
      <span key={word + position}>
        {reduced ? (
          <span className={`inline-block ${tone}`}>{word}</span>
        ) : (
          <motion.span className={`inline-block ${tone}`} variants={WORD} custom={offset + position}>
            {word}
          </motion.span>
        )}
        {position < words.length - 1 ? ' ' : null}
      </span>
    );
  });
}

/** The closing statement. Its words rise one by one as the block scrolls into view. */
export function ExitStatement() {
  return (
    <section className="px-4 pb-[72px] pt-24 md:px-8 md:pb-[120px] md:pt-40">
      <motion.h2
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.4 }}
        className="font-display text-[clamp(3rem,10vw,9rem)] font-medium leading-none tracking-[-0.02em] text-balance text-fg"
      >
        <span className="block md:ml-[15%]">
          <Words words={FIRST_LINE} offset={0} />
        </span>
        <span className="block">
          <Words words={SECOND_LINE} offset={FIRST_LINE.length} accentFrom={2} />
        </span>
      </motion.h2>
      <p className="mt-12 max-w-[440px] text-[18px] leading-[1.5] text-muted md:ml-[58.333%]">
        Ellai keeps your answers in your own Walrus Memory account. The next time an agent asks, Ellai looks
        for answers like it, and pays on its own only when you have said yes enough times before.
      </p>
    </section>
  );
}
