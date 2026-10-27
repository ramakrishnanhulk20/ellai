'use client';

import Lenis from 'lenis';
import { useEffect, type ReactNode } from 'react';
import { usePrefersReducedMotion } from './useMediaQuery.js';

/** Smooth scrolling for the whole page. People who ask for less motion get the browser's own scroll. */
export function LenisProvider({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ lerp: 0.1, autoRaf: true });
    return () => lenis.destroy();
  }, [reduced]);

  return <>{children}</>;
}
