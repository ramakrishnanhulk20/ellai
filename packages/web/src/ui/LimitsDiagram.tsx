'use client';

import { useRef } from 'react';
import { useOnScreen } from './useOnScreen.js';

/**
 * Wallet, purse, seller. Only the lines and shapes scale with the column. Every word is plain
 * HTML laid over the drawing, so a label stays 12px on a phone instead of shrinking with it.
 * The layout numbers (percentages) are the shapes' places in the 560 x 360 drawing.
 * Two dots walk the paths while the diagram is on screen: the allowance, then the payment.
 */
export function LimitsDiagram() {
  const frame = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(frame);

  return (
    <div
      ref={frame}
      role="img"
      aria-label="Your wallet gives Ellai's purse an allowance with a daily limit, a cap and an end date. The purse holds at most 0.20 USDC and pays the seller when the seller asks for payment."
      data-live={onScreen ? '' : undefined}
      className="limits-diagram"
    >
      <svg viewBox="0 0 560 360" fill="none" aria-hidden="true" className="block h-auto w-full">
        <path d="M136 200H248" className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d="M312 200H440" className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <circle cx="88" cy="200" r="48" className="stroke-fg" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <circle cx="280" cy="200" r="32" className="stroke-accent" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <rect x="440" y="168" width="64" height="64" rx="12" className="stroke-muted" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>

      <div aria-hidden="true" className="limits-pill-stack" style={{ left: '34.286%', top: '42.222%' }}>
        <p className="limits-pill label-mono">ALLOWANCE: DAILY LIMIT / CAP / END DATE</p>
      </div>
      <div aria-hidden="true" className="limits-tick-stack" style={{ left: '67.143%', top: '55.556%' }}>
        <p className="label-mono whitespace-nowrap text-muted">402 / PAY</p>
      </div>

      <p aria-hidden="true" className="limits-name label-mono" style={{ left: '15.714%', top: '68.889%' }}>
        YOUR WALLET
      </p>
      <p aria-hidden="true" className="limits-name label-mono" style={{ left: '50%', top: '64.444%' }}>
        PURSE
        <span className="limits-cap-below">0.20 MAX</span>
      </p>
      <p aria-hidden="true" className="limits-name label-mono" style={{ left: '84.286%', top: '64.444%' }}>
        SELLER
      </p>
      <p aria-hidden="true" className="limits-cap-inside label-mono" style={{ left: '50%', top: '55.556%' }}>
        0.20
        <br />
        MAX
      </p>

      <span aria-hidden="true" className="limits-dot limits-dot-allowance" />
      <span aria-hidden="true" className="limits-dot limits-dot-payment" />
    </div>
  );
}
