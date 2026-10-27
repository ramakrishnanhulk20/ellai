import type { ReactNode } from 'react';

/**
 * Holds the scene and lets it trail the page by 8 percent as you scroll. The shift comes from
 * the scroll position CSS variable that ScrollProgress publishes.
 */
export function ParallaxLayer({ children, disabled }: { children: ReactNode; disabled: boolean }) {
  return (
    <div
      className="absolute inset-0 will-change-transform"
      style={disabled ? undefined : { transform: 'translate3d(0, calc(var(--scroll-y, 0) * 0.08px), 0)' }}
    >
      {children}
    </div>
  );
}
