'use client';

import type { ReactNode } from 'react';
import { useProof } from '../useProof.js';

function Separator() {
  return <span aria-hidden className="mx-3 inline-block size-1.5 bg-accent align-middle" />;
}

/** A live count, or three dots while the first read is in flight. It never shows a made-up number. */
function Count({ value }: { value: number | null }): ReactNode {
  if (value === null) return <span className="text-night-fg opacity-40">{'···'}</span>;
  return <span className="text-night-fg">{value.toLocaleString('en-US')}</span>;
}

/**
 * The film-poster billing block: two live counts from the public proof, then the tools in the credits.
 * If the proof cannot be read, the line drops the numbers instead of showing a zero that is not real.
 */
export function BillingBlock() {
  const proof = useProof();
  const counts =
    proof.status === 'ready'
      ? { payments: proof.data.totals.verifiedPayments, answers: proof.data.totals.confirmedOwnerAnswers }
      : proof.status === 'loading'
        ? { payments: null, answers: null }
        : null;

  return (
    <div className="border-t border-night-fg/[0.14] pb-5 pt-5 text-center font-plex text-xs font-medium uppercase leading-[1.7] tracking-[0.1em] text-night-fg/(--poster-text-soft) md:pb-6">
      {counts ? (
        <p>
          <Count value={counts.payments} /> {counts.payments === 1 ? 'payment' : 'payments'} settled on Sui Mainnet
          <Separator />
          <Count value={counts.answers} /> owner {counts.answers === 1 ? 'answer' : 'answers'} stored on Walrus
          <Separator />
          every one read back through Tatum
        </p>
      ) : (
        <p>
          Payments settled on Sui Mainnet
          <Separator />
          Owner answers stored on Walrus
          <Separator />
          Every one read back through Tatum
        </p>
      )}
      <p className="mt-1 text-night-fg/(--poster-text-soft)">
        Walrus Memory / Tatum Sui RPC / Sui allowance / <span className="normal-case">x402</span>
      </p>
    </div>
  );
}
