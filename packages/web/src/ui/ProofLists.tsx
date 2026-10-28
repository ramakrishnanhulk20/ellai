'use client';

import type { ReactNode } from 'react';
import { atomicToUsdc, formatAgo, shortId } from './proof-format.js';
import type { ProofMemory, ProofPayment } from './proof.js';
import { useProof } from './useProof.js';

const WALRUSCAN_BLOB = 'https://walruscan.com/mainnet/blob/';

function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M3 9 9 3M4.5 3H9v4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One 56px row. The link stretches over the whole row, so the hover fill, the underline on the
 * short id and the click area all belong to the same thing.
 */
function Row({
  title,
  when,
  id,
  href,
  linkLabel,
}: {
  title: string;
  when: string;
  id: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <li className="proof-row relative -mx-3 flex min-h-14 items-center justify-between gap-4 border-b border-line px-3 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="break-words text-[15px] leading-[1.3] text-fg">{title}</p>
        <p className="text-[13px] leading-[1.3] text-muted">{when}</p>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener"
        aria-label={linkLabel}
        className="inline-flex shrink-0 items-center gap-[6px] font-mono text-[13px] text-fg after:absolute after:inset-0 after:content-['']"
      >
        <span className="link-draw">{shortId(id)}</span>
        <Arrow />
      </a>
    </li>
  );
}

function PaymentRow({ payment, now }: { payment: ProofPayment; now: number }) {
  const amount = atomicToUsdc(payment.amountAtomic);
  return (
    <Row
      title={`${amount} USDC to ${payment.sellerHost}`}
      when={formatAgo(payment.signedAt, now)}
      id={payment.digest}
      href={payment.explorerUrl}
      linkLabel={`Payment of ${amount} USDC to ${payment.sellerHost}, transaction ${shortId(payment.digest)}, opens in a new tab`}
    />
  );
}

function MemoryRow({ memory, now }: { memory: ProofMemory; now: number }) {
  const kind = memory.kind === 'owner_decision' ? 'Owner answer' : 'Outcome';
  return (
    <Row
      title={kind}
      when={formatAgo(memory.confirmedAt, now)}
      id={memory.blobId}
      href={`${WALRUSCAN_BLOB}${encodeURIComponent(memory.blobId)}`}
      linkLabel={`${kind}, Walrus blob ${shortId(memory.blobId)}, opens in a new tab`}
    />
  );
}

function Card({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  /** True only once the read finished with nothing to show, so loading never says "nothing". */
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-[16px] border border-line bg-panel p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-[16px] font-medium text-fg">{title}</h3>
        <p className="label-mono text-muted">{count}</p>
      </div>
      {empty ? (
        <p className="label-mono mt-6 text-muted">NOTHING PUBLIC YET</p>
      ) : (
        <ul className="mt-4">{children}</ul>
      )}
    </section>
  );
}

/** The two proof lists side by side: payments Sui confirmed, and memories Walrus holds. */
export function ProofLists({ limit, className = '' }: { limit: number; className?: string }) {
  const state = useProof();
  const settled = state.status !== 'loading';
  const data = state.status === 'ready' ? state.data : null;
  const payments = (data?.payments ?? []).slice(0, limit);
  const memories = (data?.memories ?? []).slice(0, limit);
  // Read once per render: the lists re-render on every refresh, which keeps the "5 min ago" wording current.
  const now = Date.now();

  return (
    <div className={`grid gap-6 lg:grid-cols-2 ${className}`}>
      <Card title="Latest payments" count={payments.length} empty={settled && payments.length === 0}>
        {payments.map((payment) => (
          <PaymentRow key={payment.digest} payment={payment} now={now} />
        ))}
      </Card>
      <Card title="Latest memories" count={memories.length} empty={settled && memories.length === 0}>
        {memories.map((memory) => (
          <MemoryRow key={memory.blobId} memory={memory} now={now} />
        ))}
      </Card>
    </div>
  );
}
