import type { MapDecision } from './memory-map.js';

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
      // A distance means the match came from Walrus Memory's search by meaning, not an exact lookup.
      const byMeaning = decision.citations.some((citation) => citation.distance !== null);
      return `Matched ${matched} of your past answers${byMeaning ? ' by meaning' : ''}`;
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
