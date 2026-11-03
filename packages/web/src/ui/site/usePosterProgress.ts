'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Publishes how far the poster has been scrolled away as --p (0 at the top, 1 after one screen)
 * and marks it data-covered once the white page fully hides it. The values go straight onto the
 * element, so React never re-renders per scroll tick, and the CSS does all the moving.
 */
export function usePosterProgress(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const section = ref.current;
    if (!section) return;
    let frame = 0;

    function update() {
      frame = 0;
      if (!section) return;
      const height = window.innerHeight;
      const scrolled = window.scrollY;
      const progress = Math.min(Math.max(scrolled / height, 0), 1);
      section.style.setProperty('--p', progress.toFixed(4));
      if (scrolled >= height * 1.05) section.setAttribute('data-covered', '');
      else section.removeAttribute('data-covered');
    }

    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
