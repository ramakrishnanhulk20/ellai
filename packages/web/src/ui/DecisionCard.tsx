'use client';

import { AnimatePresence, motion } from 'motion/react';
import { formatUsdc } from './format-usdc.js';
import type { MapDecision } from './memory-map.js';
import { usePrefersReducedMotion } from './useMediaQuery.js';

/**
 * The badge a public decision wears. "Paid" needs a digest, which the server sets only for a payment it
 * verified on Sui. Whether it was on its own or with a yes comes from the rule and nothing else.
 */
export function badgeFor(decision: MapDecision): { label: string; tone: string } {
  if (decision.outcome === 'asked') return { label: 'ASKED YOU', tone: 'border-asked text-asked' };
  if (decision.outcome === 'refused') return { label: 'REFUSED', tone: 'border-refused text-refused' };
  const onItsOwn = decision.rule === 'learned';
  if (decision.digest) {
    return {
      label: onItsOwn ? 'PAID ON ITS OWN' : 'PAID WITH YOUR YES',
      tone: 'border-paid text-paid',
    };
  }
  return onItsOwn
    ? { label: 'APPROVED ON ITS OWN', tone: 'border-accent text-accent' }
    : { label: 'APPROVED WITH YOUR YES', tone: 'border-line text-muted' };
}

/** The reason line under the badge, from the rule alone. Null means the decision gets no reason line. */
export function reasonFor(decision: MapDecision): string | null {
  switch (decision.rule) {
    case 'learned': {
      const matched = decision.citations.length;
      if (matched === 0) return 'Matched your past answers';
      const distances = decision.citations.flatMap((citation) =>
        citation.distance === null ? [] : [citation.distance],
      );
      const base = `Matched ${matched} of your past answers`;
      return distances.length > 0 ? `${base}. Closest: ${Math.min(...distances).toFixed(2)} (0 is an exact match)` : base;
    }
    case 'grant':
      return decision.digest ? 'Paid with the yes you gave' : 'Approved with the yes you gave';
    case 'refused_recipient':
      return 'You said no to this seller before';
    case 'bad_outcome':
      return 'This seller has not been seen to deliver yet';
    case 'no_match':
      return 'Not enough past answers like this yet';
    case 'recall_unavailable':
      return 'Could not search your past answers, so it asked';
    case 'too_many_pending':
      return 'Too many questions already waiting for you';
    case 'paused':
      return 'Payments are paused';
    case 'over_payment_max':
      return 'Above the most you allow per payment';
    case 'over_daily_budget':
      return 'Over your daily budget';
    default:
      return null;
  }
}

function CardBody({ decision }: { decision: MapDecision }) {
  const badge = badgeFor(decision);
  const reason = reasonFor(decision);
  return (
    <>
      <p className="label-mono text-muted">AGENT WANTS TO PAY</p>
      <p className="mt-2 text-[20px] leading-[1.25] text-fg">
        {formatUsdc(decision.amountUsdc)} USDC to
        <span title={decision.host} className="block truncate text-[20px] leading-[1.25] text-fg">
          {decision.host}
        </span>
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

/**
 * Shows the decision the scene is replaying. Content cross-fades when the decision changes. The
 * box is as tall as the tallest card (a paid one with a two-line reason and the Sui link), so it
 * never changes height between decisions.
 */
export function DecisionCard({ decision, className = '' }: { decision: MapDecision | null; className?: string }) {
  const reduced = usePrefersReducedMotion();
  if (!decision) return null;
  return (
    <div
      className={`relative min-h-[236px] rounded-card border border-line bg-[rgba(8,9,10,0.72)] p-4 backdrop-blur-[12px] ${className}`}
    >
      <AnimatePresence mode="wait">
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
