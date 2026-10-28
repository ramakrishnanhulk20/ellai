'use client';

import { useInView } from 'motion/react';
import { useEffect, useRef } from 'react';
import { atomicToUsdc } from './proof-format.js';
import { easeOutCubic } from './scene/easing.js';
import { usePrefersReducedMotion } from './useMediaQuery.js';
import { useProof } from './useProof.js';

const COUNT_SECONDS = 1.2;

type Kind = 'count' | 'usdc';

function render(kind: Kind, value: number): string {
  const whole = Math.round(value);
  return kind === 'usdc' ? atomicToUsdc(String(whole)) : String(whole);
}

/**
 * A number that counts up from where it is now to its target over 1.2 seconds once `run` is true.
 * The text is written straight to the element, so React does not re-render on every frame.
 * Fresh totals from a refresh move it from the old number to the new one instead of from zero.
 */
function CountUp({
  target,
  exact,
  kind,
  run,
  still,
}: {
  target: number;
  exact: string;
  kind: Kind;
  run: boolean;
  still: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);

  useEffect(() => {
    const node = element.current;
    if (!node || !run || still) return;
    const from = shown.current;
    if (from === target) {
      node.textContent = exact;
      return;
    }
    const begin = performance.now();
    let frame = 0;
    function step(now: number) {
      // The frame's own timestamp can be a hair older than `begin`, which would make progress negative.
      const progress = Math.min(1, Math.max(0, (now - begin) / (COUNT_SECONDS * 1000)));
      shown.current = from + (target - from) * easeOutCubic(progress);
      // The last frame shows the exact figure, so a large amount never ends on a rounding slip.
      if (node) node.textContent = progress < 1 ? render(kind, shown.current) : exact;
      if (progress < 1) frame = requestAnimationFrame(step);
      else shown.current = target;
    }
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, exact, kind, run, still]);

  return <span ref={element}>{still ? exact : render(kind, 0)}</span>;
}

function Total({
  label,
  target,
  exact,
  kind,
  run,
  still,
}: {
  label: string;
  target: number;
  exact: string;
  kind: Kind;
  run: boolean;
  still: boolean;
}) {
  return (
    <div>
      <p className="font-display text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-none tabular-nums text-fg">
        <CountUp target={target} exact={exact} kind={kind} run={run} still={still} />
      </p>
      <p className="label-mono mt-3 text-muted">{label}</p>
    </div>
  );
}

/** The four headline numbers. They stay at zero while the read is loading, empty or failed. */
export function ProofTotals({ className = '' }: { className?: string }) {
  const state = useProof();
  const still = usePrefersReducedMotion();
  const row = useRef<HTMLDivElement>(null);
  const entered = useInView(row, { once: true, amount: 0.5 });
  const totals = state.status === 'ready' ? state.data.totals : null;

  const atomic = totals?.verifiedUsdcAtomic ?? '0';
  const payments = totals?.verifiedPayments ?? 0;
  const answers = totals?.confirmedOwnerAnswers ?? 0;
  const learned = totals?.approvedByLearning ?? 0;

  return (
    <div ref={row} role="group" aria-label="Proof totals" className={`grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4 ${className}`}>
      <Total label="PAYMENTS VERIFIED ON SUI" target={payments} exact={String(payments)} kind="count" run={entered} still={still} />
      <Total label="USDC PAID" target={Number(atomic)} exact={atomicToUsdc(atomic)} kind="usdc" run={entered} still={still} />
      <Total label="ANSWERS ON WALRUS" target={answers} exact={String(answers)} kind="count" run={entered} still={still} />
      <Total label="PAID ON ITS OWN" target={learned} exact={String(learned)} kind="count" run={entered} still={still} />
    </div>
  );
}
