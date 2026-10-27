'use client';

import { useEffect, useState } from 'react';
import type { MemoryMapState } from './useMemoryMap.js';

function useSecondsSince(isoTime: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isoTime === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isoTime]);
  if (isoTime === null) return null;
  return Math.max(0, Math.floor((now - Date.parse(isoTime)) / 1000));
}

export function LiveCaption({ state }: { state: MemoryMapState }) {
  const generatedAt = state.status === 'ready' ? state.data.generatedAt : null;
  const seconds = useSecondsSince(generatedAt);

  let text: string;
  let live = false;
  if (state.status === 'loading') {
    text = 'READING WALRUS';
  } else if (state.status === 'error' || state.data.memories.length === 0) {
    text = 'NO PUBLIC MEMORIES YET';
  } else {
    live = true;
    text = `LIVE / ${state.data.totals.memories} MEMORIES ON WALRUS / UPDATED ${seconds ?? 0}S AGO`;
  }

  return (
    <p className="label-mono text-muted">
      {live ? <span className="live-dot mr-2 inline-block size-[6px] rounded-full bg-accent align-middle" /> : null}
      {text}
    </p>
  );
}
