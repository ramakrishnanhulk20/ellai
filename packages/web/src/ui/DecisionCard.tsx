'use client';

import { AnimatePresence, motion } from 'motion/react';
import { formatUsdc } from './format-usdc.js';
import type { MapDecision } from './memory-map.js';
import { usePrefersReducedMotion } from './useMediaQuery.js';

export const BADGES = {
  approved: { label: 'PAID ON ITS OWN', tone: 'border-paid text-paid' },
  asked: { label: 'ASKED YOU', tone: 'border-asked text-asked' },
  refused: { label: 'REFUSED', tone: 'border-refused text-refused' },
} as const;

/** The reason line under the badge. Null means the decision gets no reason line. */
function reasonFor(decision: MapDecision): string | null {
  if (decision.outcome === 'asked') return 'Not enough past answers like this yet';
  if (decision.outcome === 'refused') return 'You said no to this seller before';
  const matched = decision.citations.length;
  if (matched > 0) {
    const distances = decision.citations.flatMap((citation) =>
      citation.distance === null ? [] : [citation.distance],
    );
    const base = `Matched ${matched} of your past answers`;
    return distances.length > 0 ? `${base}, closest ${Math.min(...distances).toFixed(2)}` : base;
  }
  return decision.rule === 'grant' ? 'Paid with the yes you gave' : null;
}

function CardBody({ decision }: { decision: MapDecision }) {
  const badge = BADGES[decision.outcome];
  const reason = reasonFor(decision);
  return (
    <>
      <p className="label-mono text-muted">AGENT WANTS TO PAY</p>
      <p className="mt-2 break-words text-[20px] leading-[1.25] text-fg">
        {formatUsdc(decision.amountUsdc)} USDC to {decision.host}
      </p>
      <p
        className={`label-mono mt-3 inline-flex h-6 items-center rounded-button border px-2 ${badge.tone}`}
      >
        {badge.label}
      </p>
      {reason ? <p className="mt-3 text-[14px] leading-[1.4] text-muted">{reason}</p> : null}
      {decision.digest ? (
        <p className="mt-3">
          <a
            href={`https://suiscan.xyz/mainnet/tx/${encodeURIComponent(decision.digest)}`}
            target="_blank"
            rel="noopener"
            className="label-mono link-draw text-fg"
          >
            See it on Sui
          </a>
        </p>
      ) : null}
    </>
  );
}

/** Shows the decision the scene is replaying. Content cross-fades when the decision changes. */
export function DecisionCard({ decision, className = '' }: { decision: MapDecision | null; className?: string }) {
  const reduced = usePrefersReducedMotion();
  if (!decision) return null;
  return (
    <div
      className={`relative rounded-card border border-line bg-[rgba(8,9,10,0.72)] p-4 backdrop-blur-[12px] ${className}`}
    >
      <AnimatePresence mode="popLayout">
        <motion.div
          key={decision.id}
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -8 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <CardBody decision={decision} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
