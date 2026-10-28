import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// Registered here, at the one place both pinned sections and the smooth-scroll provider import from.
gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A pinned section pushes everything below it down by its pin distance, so whenever any pin is
 * made or removed every trigger has to measure again. Calls close together share one measure.
 */
export function refreshScrollTriggers(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 120);
}
