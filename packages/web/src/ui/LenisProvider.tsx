'use client';

import Lenis from 'lenis';
import { useEffect, type ReactNode } from 'react';
import { gsap, ScrollTrigger } from './scroll-trigger.js';
import { usePrefersReducedMotion } from './useMediaQuery.js';

/**
 * Smooth scrolling for the whole page, and the link between it and the pinned sections. GSAP's
 * clock drives Lenis, and Lenis tells ScrollTrigger every time it moves, so a pin never lags the
 * smoothed scroll. People who ask for less motion get the browser's own scroll.
 */
export function LenisProvider({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ lerp: 0.1, autoRaf: false });
    const tick = (seconds: number) => lenis.raf(seconds * 1000);

    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(tick);
    // GSAP would otherwise skip ahead after a slow frame, which makes a pinned scrub jump.
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.destroy();
    };
  }, [reduced]);

  return <>{children}</>;
}
