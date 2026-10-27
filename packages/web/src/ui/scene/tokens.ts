'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { Color } from 'three';

/** The 3D scene takes its colours from the same CSS tokens as the page, so the two cannot drift. */
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function readColor(name: string): Color {
  return new Color(readToken(name) || '#ffffff');
}

// The accent switcher sets --accent as an inline style on the root element.
function watchRootStyle(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => observer.disconnect();
}

export function useAccentColor(): Color {
  const value = useSyncExternalStore(
    watchRootStyle,
    () => readToken('--accent'),
    () => '',
  );
  return useMemo(() => new Color(value || '#ffffff'), [value]);
}
