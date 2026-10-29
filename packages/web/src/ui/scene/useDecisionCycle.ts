'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapDecision } from '../memory-map.js';

export type ActiveReplay = {
  decision: MapDecision;
  /** Counts up by one per replay and never resets while the page is open. */
  step: number;
};

/**
 * Walks the real decisions, looping, one every `seconds`. Decisions with a verified payment
 * come first, newest first, then the rest, newest first, so the first card after load is a
 * real payment. The decision is picked when its turn starts, so a refresh that adds new
 * decisions cannot swap the one already on screen.
 */
export function useDecisionCycle(
  decisions: MapDecision[],
  seconds: number,
  enabled: boolean,
): ActiveReplay | null {
  const [active, setActive] = useState<ActiveReplay | null>(null);
  const ordered = useMemo(() => {
    const newestFirst = [...decisions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return [...newestFirst.filter((decision) => decision.digest), ...newestFirst.filter((decision) => !decision.digest)];
  }, [decisions]);
  const latest = useRef(ordered);
  latest.current = ordered;
  const hasDecisions = enabled && ordered.length > 0;

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
