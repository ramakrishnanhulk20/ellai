'use client';

import { useEffect } from 'react';

const SCROLLED_AFTER = 24;

/**
 * The page's one scroll listener. It publishes the scroll position as --scroll-y and marks the
 * body once the page has moved past 24px, so CSS does the rest and React never re-renders while
 * scrolling. It writes to the body, not the root element, because the accent colour watcher
 * listens to the root's style.
 */
export function ScrollProgress() {
  useEffect(() => {
    const body = document.body;
    let frame = 0;

    function update() {
      frame = 0;
      const y = window.scrollY;
      body.style.setProperty('--scroll-y', String(y));
      if (y > SCROLLED_AFTER) body.setAttribute('data-scrolled', '');
      else body.removeAttribute('data-scrolled');
    }

    function onScroll() {
      if (frame === 0) frame = requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
      body.style.removeProperty('--scroll-y');
      body.removeAttribute('data-scrolled');
    };
  }, []);

  return null;
}
