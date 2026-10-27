'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapDecision } from '../memory-map.js';

export type ActiveReplay = {
  decision: MapDecision;
  /** Counts up by one per replay and never resets while the page is open. */
  step: number;
};

/**
 * Walks the real decisions, newest first and looping, one every `seconds`. The decision is
 * picked when its turn starts, so a refresh that adds new decisions cannot swap the one
 * already on screen.
 */
export function useDecisionCycle(
  decisions: MapDecision[],
  seconds: number,
  enabled: boolean,
): ActiveReplay | null {
  const [active, setActive] = useState<ActiveReplay | null>(null);
  const newestFirst = useMemo(
    () => [...decisions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    [decisions],
  );
  const latest = useRef(newestFirst);
  latest.current = newestFirst;
  const hasDecisions = enabled && newestFirst.length > 0;

  useEffect(() => {
    if (!hasDecisions) {
      setActive(null);
      return;
    }
    let step = 0;
    function showNext() {
      const list = latest.current;
      const decision = list[step % list.length];
      if (decision) setActive({ decision, step });
      step += 1;
    }
    showNext();
    const timer = setInterval(showNext, seconds * 1000);
    return () => clearInterval(timer);
  }, [hasDecisions, seconds]);

  return active;
}
