'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { currentTheme, followDevice, setTheme, subscribeTheme, type Theme } from './theme.js';

const BOX = 'size-10 shrink-0 rounded-[8px] border border-mist';

function Sun() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="3.25" />
      <path d="M9 1.5v1.75M9 14.75v1.75M1.5 9h1.75M14.75 9h1.75M3.7 3.7l1.24 1.24M13.06 13.06l1.24 1.24M3.7 14.3l1.24-1.24M13.06 4.94l1.24-1.24" />
    </svg>
  );
}

function Moon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15.75 9.59A6.75 6.75 0 1 1 8.41 2.25 5.25 5.25 0 0 0 15.75 9.59z" />
    </svg>
  );
}

/**
 * The one switch between dark and light. Before the page has hydrated it is an empty box of the
 * same size, so nothing moves when the real button arrives. It shows the mode a press will bring:
 * a sun while the page is dark, a moon while it is light.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme | null>(subscribeTheme, currentTheme, () => null);

  useEffect(() => followDevice(), []);

  if (theme === null) return <span aria-hidden className={`inline-flex ${BOX}`} />;

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      className={`inline-flex items-center justify-center text-ink-soft transition-[border-color,color] duration-[160ms] ease-out hover:border-ink hover:text-ink motion-reduce:transition-none ${BOX}`}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}
