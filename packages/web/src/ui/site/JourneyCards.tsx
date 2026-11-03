'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { badgeFor, reasonFor } from '../DecisionCard.js';
import { shortId } from '../proof-format.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { breakAtDots } from './CheckSection.js';
import { formatDay, type CitedMemory, type Journey } from './journey-model.js';

export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

const LABEL = 'font-plex text-xs font-medium uppercase tracking-[0.06em] text-ink-soft';
const WRAP = '[overflow-wrap:anywhere]';
const HOST_WRAP = '[overflow-wrap:break-word]';
const FOOTER = 'mt-4 border-t border-mist pt-3';
const BADGE = 'rounded-[6px] px-2 py-1 font-plex text-xs font-medium uppercase leading-4';

const CHECK_ROWS = [
  'Payments are switched on',
  'Under your per-payment maximum',
  'Inside your daily budget',
  'You never refused this seller',
] as const;

function blobUrl(blobId: string): string {
  return `https://walruscan.com/mainnet/blob/${encodeURIComponent(blobId)}`;
}

function CheckSquare() {
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center bg-accent">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 10.5l3 3 7-7" />
      </svg>
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-plex text-xs text-accent-text underline-offset-[3px] hover:underline"
    >
      {children}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8.5l5-5M4 3.5h4.5V8" />
      </svg>
    </a>
  );
}

/** A past answer's day and its Walrus blob, on one line. The day is left out when the map does not hold the memory. */
function BlobLine({ blobId, at }: { blobId: string; at: string | null }) {
  return (
    <p className="font-plex text-xs text-ink-soft">
      {at ? `${formatDay(at)} / ` : null}
      <ExternalLink href={blobUrl(blobId)}>blob {shortId(blobId)}</ExternalLink>
    </p>
  );
}

function verdictLine(verdict: 'approve' | 'refuse', host: string): string {
  return `${verdict === 'approve' ? 'Yes' : 'No'} to ${host}`;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="w-full min-w-0 rounded-[12px] border border-mist bg-paper p-5 shadow-[0_1px_2px_rgba(26,26,26,0.05),0_12px_28px_-8px_rgba(26,26,26,0.14)] lg:p-6">
      {children}
    </div>
  );
}

function PaywallCard({ journey }: { journey: Journey }) {
  const { example } = journey;
  return (
    <Shell>
      <div className={`flex justify-between ${LABEL}`}>
        <span>HTTP 402</span>
        <span className="text-accent-text">Payment required</span>
      </div>
      {example ? (
        <>
          <p className={`mt-4 font-grotesk text-[40px] font-bold leading-none tracking-[-0.03em] text-ink ${WRAP}`}>
            {example.amount} USDC
          </p>
          <p className={`mt-2 text-base text-ink-soft ${HOST_WRAP}`}>to {breakAtDots(example.host)}</p>
        </>
      ) : (
        <p className="mt-4 text-base text-ink">A seller asks to be paid first.</p>
      )}
      <p className={`${FOOTER} ${LABEL}`}>
        <span className="normal-case">x402</span> / USDC on Sui Mainnet
      </p>
    </Shell>
  );
}

function ChecksCard({ active }: { active: boolean }) {
  const reduced = usePrefersReducedMotion();
  const shown = { opacity: 1, x: 0 };
  const hidden = { opacity: 0, x: -8 };
  return (
    <Shell>
      <p className={LABEL}>Ellai checks, in this order</p>
      <ul className="mt-[14px] flex flex-col gap-3">
        {CHECK_ROWS.map((text, index) => (
          <motion.li
            key={text}
            className="flex items-center gap-3 text-base text-ink"
            initial={reduced ? false : hidden}
            animate={active || reduced ? shown : hidden}
            transition={
              reduced ? { duration: 0 } : { duration: 0.3, ease: EASE_OUT_EXPO, delay: 0.2 + index * 0.15 }
            }
          >
            <CheckSquare />
            <span>{text}</span>
          </motion.li>
        ))}
      </ul>
      <p className={`${FOOTER} text-[15px] font-medium text-ink`}>A refusal beats anything Ellai learned.</p>
    </Shell>
  );
}

function RecallRow({ entry, flashDelay }: { entry: CitedMemory; flashDelay: number | null }) {
  const line = entry.verdict && entry.host ? verdictLine(entry.verdict, entry.host) : 'A past answer';
  return (
    <li
      className={`-mx-2 rounded-[6px] px-2 ${flashDelay === null ? '' : 'journey-flash'}`}
      style={flashDelay === null ? undefined : { animationDelay: `${flashDelay}ms` }}
    >
      <p className={`text-[15px] leading-[1.35] text-ink ${HOST_WRAP}`}>{breakAtDots(line)}</p>
      <BlobLine blobId={entry.blobId} at={entry.at} />
    </li>
  );
}

function RecallCard({ journey, active }: { journey: Journey; active: boolean }) {
  const reduced = usePrefersReducedMotion();
  const matched = journey.example?.citationCount ?? 0;
  return (
    <Shell>
      <p className={LABEL}>{matched > 0 ? `Matched ${matched} of your past answers` : 'Searching your Walrus Memory'}</p>
      {journey.cited.length > 0 ? (
        <ul className="mt-[14px] flex flex-col gap-[10px]">
          {journey.cited.map((entry, index) => (
            <RecallRow
              key={`${index}-${entry.blobId}`}
              entry={entry}
              flashDelay={active && !reduced ? 300 + index * 250 : null}
            />
          ))}
        </ul>
      ) : null}
      <p className={`${FOOTER} ${LABEL}`}>Stored in the owner&apos;s own Walrus Memory account</p>
    </Shell>
  );
}

function SettledCard({ journey }: { journey: Journey }) {
  const { example } = journey;
  if (!example) {
    return (
      <Shell>
        <p className="text-base text-ink">Every payment is read back from Sui through Tatum before Ellai calls it paid.</p>
      </Shell>
    );
  }
  const reason = reasonFor(example.decision);
  return (
    <Shell>
      <span className={`inline-block bg-accent-wash text-accent-text ${BADGE}`}>{badgeFor(example.decision).label}</span>
      {reason ? <p className="mt-[6px] text-[13px] leading-snug text-ink-soft">{reason}</p> : null}
      <p className={`mt-[14px] font-grotesk text-[40px] font-bold leading-none tracking-[-0.03em] text-ink ${WRAP}`}>
        {example.amount} USDC
      </p>
      <p className={`mt-2 text-base text-ink-soft ${HOST_WRAP}`}>to {breakAtDots(example.host)}</p>
      <div className="mt-[14px] flex items-center gap-3 text-[15px] text-ink">
        <CheckSquare />
        <span>Read back from Sui through Tatum</span>
      </div>
      <div className={`${FOOTER} flex items-center justify-between gap-3`}>
        <span className="min-w-0 font-plex text-xs text-ink-soft [overflow-wrap:anywhere]">{shortId(example.digest)}</span>
        <ExternalLink href={`https://suiscan.xyz/mainnet/tx/${encodeURIComponent(example.digest)}`}>
          Open on Suiscan
        </ExternalLink>
      </div>
    </Shell>
  );
}

function LoopCard({ journey }: { journey: Journey }) {
  const { asked, answer } = journey;
  return (
    <Shell>
      {asked ? (
        <div>
          <p className={LABEL}>Anything new, it asks you</p>
          <p className={`mt-2 text-[15px] leading-[1.35] text-ink ${HOST_WRAP}`}>
            {asked.amount} USDC to {breakAtDots(asked.host)}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <span className={`bg-bone text-ink ${BADGE}`}>Asked you</span>
            <span className="font-plex text-xs text-ink-soft">{formatDay(asked.at)}</span>
          </div>
        </div>
      ) : null}
      {asked && answer ? <div aria-hidden className="my-[14px] h-px bg-mist" /> : null}
      {answer ? (
        <div>
          <p className={LABEL}>
            {answer.forAsked ? 'The answer for this seller, on Walrus' : 'The newest answer, on Walrus'}
          </p>
          <p className={`mt-2 text-[15px] leading-[1.35] text-ink ${HOST_WRAP}`}>
            {breakAtDots(verdictLine(answer.memory.verdict, answer.memory.host))}
          </p>
          <div className="mt-1">
            <BlobLine blobId={answer.memory.blobId} at={answer.memory.at} />
          </div>
        </div>
      ) : null}
      {asked || answer ? null : <p className="text-base text-ink">Your answers are written to your own Walrus Memory.</p>}
      <p className={`${FOOTER} text-[15px] font-medium text-ink`}>Next time, Ellai asks less.</p>
    </Shell>
  );
}

/** The product card for one beat of the journey. Every number and name on it comes from the public memory map. */
export function JourneyCard({ beat, journey, active }: { beat: number; journey: Journey; active: boolean }) {
  switch (beat) {
    case 0:
      return <PaywallCard journey={journey} />;
    case 1:
      return <ChecksCard active={active} />;
    case 2:
      return <RecallCard journey={journey} active={active} />;
    case 3:
      return <SettledCard journey={journey} />;
    default:
      return <LoopCard journey={journey} />;
  }
}
