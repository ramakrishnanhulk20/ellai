'use client';

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { parseProof, type Proof } from './proof.js';

const ENDPOINT = '/api/public/proof';
const REFRESH_MS = 60_000;

export type ProofState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: Proof };

/**
 * Reads the public proof on mount and every 60 seconds. A hidden tab makes no requests, and a
 * tab that comes back after a minute away refreshes at once. A failed refresh keeps the last
 * good data: only a first load that fails shows the error state.
 */
function useProofRead(): ProofState {
  const [state, setState] = useState<ProofState>({ status: 'loading' });

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
        if (!response.ok) throw new Error(`proof answered ${response.status}`);
        const data = parseProof(await response.json());
        if (!data) throw new Error('proof had an unexpected shape');
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

const ProofContext = createContext<ProofState | null>(null);

/** Reads the proof once for everything below it, so the totals and both lists share one fetch. */
export function ProofProvider({ children }: { children: ReactNode }) {
  const state = useProofRead();
  return createElement(ProofContext, { value: state }, children);
}

export function useProof(): ProofState {
  const state = useContext(ProofContext);
  if (!state) throw new Error('useProof needs a ProofProvider above it');
  return state;
}
