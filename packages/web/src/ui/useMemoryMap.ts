'use client';

import { useEffect, useState } from 'react';
import { parseMemoryMap, type MemoryMap } from './memory-map.js';

const ENDPOINT = '/api/public/memory-map';
const REFRESH_MS = 60_000;

export type MemoryMapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: MemoryMap };

/**
 * Reads the public memory map on mount and every 60 seconds. A hidden tab makes no
 * requests, and a tab that comes back after a minute away refreshes at once. A failed
 * refresh keeps the last good data: only a first load that fails shows the error state.
 */
export function useMemoryMap(): MemoryMapState {
  const [state, setState] = useState<MemoryMapState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    let inFlight: AbortController | null = null;
    let lastFetchAt = 0;

    async function load() {
      inFlight?.abort();
      const mine = new AbortController();
      inFlight = mine;
      lastFetchAt = Date.now();
      try {
        const response = await fetch(ENDPOINT, { cache: 'no-store', signal: mine.signal });
        if (!response.ok) throw new Error(`memory map answered ${response.status}`);
        const data = parseMemoryMap(await response.json());
        if (!data) throw new Error('memory map had an unexpected shape');
        if (alive && !mine.signal.aborted) setState({ status: 'ready', data });
      } catch {
        if (!alive || mine.signal.aborted) return;
        setState((current) => (current.status === 'ready' ? current : { status: 'error' }));
      }
    }

    function refreshIfVisible() {
      if (document.visibilityState === 'visible') void load();
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchAt >= REFRESH_MS) {
        void load();
      }
    }

    refreshIfVisible();
    const timer = setInterval(refreshIfVisible, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      alive = false;
      inFlight?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return state;
}
