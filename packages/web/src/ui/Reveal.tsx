'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { RISE_EASE } from './motion-tokens.js';
import { usePrefersReducedMotion } from './useMediaQuery.js';

const STAGGER_SECONDS = 0.06;

/** Fades and lifts its content in once, as it scrolls into view. `index` staggers siblings by 60ms. */
export function Reveal({
  children,
  index = 0,
  className,
}: {
  children: ReactNode;
  index?: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, ease: RISE_EASE, delay: index * STAGGER_SECONDS }}
    >
      {children}
    </motion.div>
  );
}
