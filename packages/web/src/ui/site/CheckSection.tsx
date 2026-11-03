'use client';

import Link from 'next/link';
import { animate, motion, useInView } from 'motion/react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { atomicToUsdc, formatAgo, shortId } from '../proof-format.js';
import type { Proof, ProofMemory, ProofPayment } from '../proof.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { useProof, type ProofState } from '../useProof.js';
import { ArrowRight } from './Arrow.js';
import { SiteButton } from './SiteButton.js';
import { SquareLabel } from './SquareLabel.js';

const EASE = [0.16, 1, 0.3, 1] as const;

const COUNT_SECONDS = 0.9;

const LIST_LIMIT = 6;

const WALRUSCAN_BLOB = 'https://walruscan.com/mainnet/blob/';

const SMALL_CAPS = 'font-plex text-[13px] font-medium uppercase tracking-[0.06em] text-ink-soft';
const SMALL_CAPS_12 = 'font-plex text-xs font-medium uppercase tracking-[0.06em] text-ink-soft';

/** The house entrance: fade in while rising 24px, once, and nothing moves for people who ask for less motion. */
export function rise(shown: boolean, still: boolean, delay = 0) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    animate: shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 },
    transition: { duration: still ? 0 : 0.7, ease: EASE, delay: still ? 0 : delay },
  };
}

function Header({ still }: { still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const shown = still || seen;
  return (
    <div ref={block}>
      <motion.div {...rise(shown, still, 0)}>
        <SquareLabel className="text-ink-soft">Proof</SquareLabel>
      </motion.div>
      <motion.h2
        id="check-title"
        {...rise(shown, still, 0.08)}
        className="mt-6 max-w-[12ch] font-grotesk text-[clamp(2.25rem,6.1vw,5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink"
      >
        Don&apos;t trust us. Check.
      </motion.h2>
      <motion.p {...rise(shown, still, 0.16)} className="mt-6 max-w-[36rem] text-lg leading-[1.6] text-ink-soft md:text-xl">
        Every payment below settled on Sui and was read back through Tatum. Every memory is a Walrus blob owned by the
        person who made it. Open any of them.
      </motion.p>
    </div>
  );
}

type Kind = 'count' | 'usdc';

function written(kind: Kind, value: number): string {
  return kind === 'usdc' ? (value / 1_000_000).toFixed(2) : String(Math.round(value));
}

/**
 * One headline number. Once the proof is in and the block has come into view it counts up from zero,
 * writing straight to the element so React does not re-render on every frame. A later refresh counts
 * from the number on screen to the new one. The last frame is the exact figure, never a rounded one.
 */
function Figure({
  kind,
  ready,
  target,
  exact,
  run,
  still,
  tone,
  caption,
}: {
  kind: Kind;
  ready: boolean;
  target: number;
  exact: string;
  run: boolean;
  still: boolean;
  tone: string;
  caption: string;
}) {
  const node = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);

  // A layout effect, so the count starts from zero before the browser paints the final figure.
  useLayoutEffect(() => {
    const element = node.current;
    if (!ready || !run || still || !element) return;
    const from = shown.current ?? 0;
    if (from === target) {
      element.textContent = exact;
      return;
    }
    element.textContent = written(kind, from);
    const count = animate(from, target, {
      duration: COUNT_SECONDS,
      ease: EASE,
      onUpdate: (value) => {
        shown.current = value;
        element.textContent = written(kind, value);
      },
      onComplete: () => {
        shown.current = target;
        element.textContent = exact;
      },
    });
    return () => count.stop();
  }, [ready, run, still, target, exact, kind]);

  return (
    <div className="min-w-0 border-t border-mist pt-5">
      <p
        className={`font-grotesk text-[clamp(2.75rem,5.5vw,4.5rem)] font-bold leading-none tracking-[-0.04em] tabular-nums [overflow-wrap:anywhere] ${tone}`}
      >
        {ready ? <span ref={node}>{exact}</span> : <span className="opacity-40">···</span>}
      </p>
      <p className={`mt-[10px] ${SMALL_CAPS}`}>{caption}</p>
    </div>
  );
}

/** It mounts only when the read has not failed, so its in-view watch always finds its element. */
function TotalsGrid({ totals, still }: { totals: Proof['totals'] | null; still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.5 });
  const shown = still || seen;
  const ready = totals !== null;
  const atomic = totals?.verifiedUsdcAtomic ?? '0';
  const payments = totals?.verifiedPayments ?? 0;
  const answers = totals?.confirmedOwnerAnswers ?? 0;
  const learned = totals?.approvedByLearning ?? 0;

  return (
    <motion.div
      ref={block}
      role="group"
      aria-label="Proof totals"
      {...rise(shown, still)}
      className="grid grid-cols-2 gap-x-8 gap-y-10 lg:grid-cols-4"
    >
      <Figure
        kind="count"
        ready={ready}
        target={payments}
        exact={String(payments)}
        run={seen}
        still={still}
        tone="text-ink"
        caption="Payments verified on Sui"
      />
      <Figure
        kind="usdc"
        ready={ready}
        target={Number(atomic)}
        exact={atomicToUsdc(atomic)}
        run={seen}
        still={still}
        tone="text-ink"
        caption="USDC paid"
      />
      <Figure
        kind="count"
        ready={ready}
        target={answers}
        exact={String(answers)}
        run={seen}
        still={still}
        tone="text-ink"
        caption="Answers on Walrus"
      />
      <Figure
        kind="count"
        ready={ready}
        target={learned}
        exact={String(learned)}
        run={seen}
        still={still}
        tone="text-accent"
        caption="Paid on its own"
      />
    </motion.div>
  );
}

function TotalsFailed({ onProofPage }: { onProofPage: boolean }) {
  if (onProofPage) {
    return (
      <p className="text-base leading-[1.6] text-ink-soft">
        The live proof could not be read just now. Reload the page to try again.
      </p>
    );
  }
  return (
    <p className="text-base leading-[1.6] text-ink-soft">
      The live proof could not be read just now. Open{' '}
      <Link href="/proof" className="nav-sweep font-medium text-ink">
        the proof page
      </Link>{' '}
      to try again.
    </p>
  );
}

/**
 * The four headline totals with their count-up, or the plain failure line when the first read failed.
 * It carries no margin of its own: the page that places it decides the space above. On the proof page
 * itself a link back to that page would go nowhere, so the failure line there asks for a reload instead.
 */
export function ProofTotalsGrid({ onProofPage = false }: { onProofPage?: boolean }) {
  const state = useProof();
  const still = usePrefersReducedMotion();
  if (state.status === 'error') return <TotalsFailed onProofPage={onProofPage} />;
  return <TotalsGrid totals={state.status === 'ready' ? state.data.totals : null} still={still} />;
}

/** The arrow turned to point up and to the right, for links that leave the site. */
function OutArrow({ small = false }: { small?: boolean }) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 -rotate-45 ${small ? '[&_svg]:size-3' : ''}`}>
      <ArrowRight />
    </span>
  );
}

/**
 * One row of a list. The link stretches over the whole row, so the hover fill, the underline on the
 * short id and the click area all belong to the same thing.
 */
function ProofRow({
  title,
  when,
  linkText,
  href,
  linkLabel,
}: {
  title: string;
  when: string;
  linkText: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <li className="group/row relative grid grid-cols-[1fr_auto] items-baseline gap-4 border-t border-mist py-[14px] transition-colors duration-[160ms] ease-out last:border-b hover:bg-bone motion-reduce:transition-none">
      <p className="min-w-0 text-base leading-[1.4] text-ink [overflow-wrap:anywhere]">{title}</p>
      <div className="flex flex-col items-end text-right font-plex text-xs">
        <span className="text-ink-soft">{when}</span>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={linkLabel}
          className="mt-1 inline-flex items-center gap-1.5 text-ink after:absolute after:inset-0 after:content-['']"
        >
          <span className="underline-offset-[3px] group-focus-within/row:underline group-hover/row:underline">
            {linkText}
          </span>
          <span className="text-accent-text">
            <OutArrow small />
          </span>
        </a>
      </div>
    </li>
  );
}

function PaymentRow({ payment, now }: { payment: ProofPayment; now: number }) {
  const amount = atomicToUsdc(payment.amountAtomic);
  return (
    <ProofRow
      title={`${amount} USDC to ${payment.sellerHost}`}
      when={formatAgo(payment.signedAt, now)}
      linkText={shortId(payment.digest)}
      href={payment.explorerUrl}
      linkLabel={`Payment of ${amount} USDC to ${payment.sellerHost}, transaction ${shortId(payment.digest)}, opens in a new tab`}
    />
  );
}

/** The words for a memory row: the answer and the seller when the server says them, the plain kind otherwise. */
function memoryTitle(memory: ProofMemory): string {
  if (memory.kind === 'owner_decision') {
    if (memory.host && memory.verdict === 'approve') return `Yes to ${memory.host}`;
    if (memory.host && memory.verdict === 'refuse') return `No to ${memory.host}`;
    return 'Owner answer';
  }
  return memory.host ? `Outcome for ${memory.host}` : 'Outcome';
}

function MemoryRow({ memory, now }: { memory: ProofMemory; now: number }) {
  const title = memoryTitle(memory);
  return (
    <ProofRow
      title={title}
      when={formatAgo(memory.confirmedAt, now)}
      linkText={`blob ${shortId(memory.blobId)}`}
      href={`${WALRUSCAN_BLOB}${encodeURIComponent(memory.blobId)}`}
      linkLabel={`${title}, Walrus blob ${shortId(memory.blobId)}, opens in a new tab`}
    />
  );
}

const SKELETON_WIDTHS = ['70%', '55%', '62%'] as const;

function SkeletonRows() {
  return (
    <ul aria-hidden className="mt-4">
      {SKELETON_WIDTHS.map((width) => (
        <li key={width} className="border-t border-mist py-[14px] last:border-b">
          <div className="h-[14px] rounded-[3px] bg-bone" style={{ width }} />
        </li>
      ))}
    </ul>
  );
}

/** `count` is null while the read is loading, so the heading never shows a number that is not real. */
function Column({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  return (
    <div className="min-w-0" aria-busy={count === null}>
      <h3 className={SMALL_CAPS}>
        {title}
        {count === null ? null : <span className="ml-2 text-ink"><span className="sr-only">, </span>{count} shown</span>}
      </h3>
      {children}
    </div>
  );
}

/** It mounts only when the read has not failed, so its in-view watch always finds its element. */
function ListColumns({ state, still, limit }: { state: ProofState; still: boolean; limit: number }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.15 });
  const shown = still || seen;
  const data = state.status === 'ready' ? state.data : null;
  const payments = data ? data.payments.slice(0, limit) : null;
  const memories = data ? data.memories.slice(0, limit) : null;
  // Read once per render: the lists re-render on every refresh, which keeps the "5 min ago" wording current.
  const now = Date.now();

  return (
    <motion.div ref={block} {...rise(shown, still)} className="grid gap-14 lg:grid-cols-2 lg:gap-12">
      <Column title="Latest payments" count={payments ? payments.length : null}>
        {!payments ? (
          <SkeletonRows />
        ) : payments.length === 0 ? (
          <p className="mt-4 text-[15px] leading-[1.5] text-ink-soft">None yet.</p>
        ) : (
          <ul className="mt-4">
            {payments.map((payment) => (
              <PaymentRow key={payment.digest} payment={payment} now={now} />
            ))}
          </ul>
        )}
      </Column>
      <Column title="Latest memories" count={memories ? memories.length : null}>
        {!memories ? (
          <SkeletonRows />
        ) : memories.length === 0 ? (
          <p className="mt-4 text-[15px] leading-[1.5] text-ink-soft">None yet.</p>
        ) : (
          <ul className="mt-4">
            {memories.map((memory) => (
              <MemoryRow key={memory.blobId} memory={memory} now={now} />
            ))}
          </ul>
        )}
      </Column>
    </motion.div>
  );
}

/**
 * Both columns of the live lists. `limit` caps the rows in each column; Infinity shows them all.
 * It carries no margin of its own: the page that places it decides the space above.
 */
export function LatestLists({ limit }: { limit: number }) {
  const state = useProof();
  const still = usePrefersReducedMotion();
  if (state.status === 'error') return null;
  return <ListColumns state={state} still={still} limit={limit} />;
}

const ISSUE_URL ='https://github.com/MystenLabs/walrus-memory/issues/1367';
const FIX_URL = 'https://github.com/MystenLabs/walrus-memory/pull/1368';

function GithubLink({
  href,
  kicker,
  line,
  shown,
  still,
  delay,
}: {
  href: string;
  kicker: string;
  line: string;
  shown: boolean;
  still: boolean;
  delay: number;
}) {
  return (
    <motion.a
      href={href}
      target="_blank"
      rel="noreferrer"
      {...rise(shown, still, delay)}
      className="group flex items-center justify-between gap-4 rounded-[12px] border border-mist bg-paper px-5 py-[18px] shadow-[0_1px_2px_rgba(26,26,26,0.05),0_12px_28px_-8px_rgba(26,26,26,0.14)] transition-[border-color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-accent"
    >
      <span className="min-w-0">
        <span className={`block ${SMALL_CAPS_12}`}>{kicker}</span>
        <span className="mt-1.5 block text-base leading-[1.4] text-ink">{line}</span>
        <span className="sr-only">, opens in a new tab</span>
      </span>
      <span className="inline-flex shrink-0 text-accent-text transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-safe:group-hover:-translate-y-[3px] motion-safe:group-hover:translate-x-[3px]">
        <OutArrow />
      </span>
    </motion.a>
  );
}

/** The issue and the fix as two link rows. The caller supplies the box that lays them out. */
export function FindingLinks({ shown, still }: { shown: boolean; still: boolean }) {
  return (
    <>
      <GithubLink
        href={ISSUE_URL}
        kicker="Issue #1367"
        line="Reproduced and confirmed by the Walrus team"
        shown={shown}
        still={still}
        delay={0.1}
      />
      <GithubLink
        href={FIX_URL}
        kicker="Pull request #1368"
        line="The fix, opened by the Walrus team"
        shown={shown}
        still={still}
        delay={0.2}
      />
    </>
  );
}

/** The real Walrus Memory bug found while building Ellai, with links to the report and the fix. */
export function WalrusBugCard() {
  const still = usePrefersReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const seen = useInView(card, { once: true, amount: 0.15 });
  const shown = still || seen;

  return (
    <motion.div
      ref={card}
      {...rise(shown, still)}
      className="mt-[72px] grid gap-7 rounded-[12px] border border-mist bg-bone p-6 md:mt-24 md:p-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-12"
    >
      <div>
        <SquareLabel className="text-ink-soft">Found while building</SquareLabel>
        <h3 className="mt-[18px] max-w-[24ch] font-grotesk text-[clamp(1.5rem,2.6vw,2.25rem)] font-bold leading-[1.15] tracking-[-0.02em] text-ink">
          We found a bug in Walrus Memory. The Walrus team confirmed it.
        </h3>
        <p className="mt-4 max-w-[40rem] text-[17px] leading-[1.6] text-ink-soft">
          A memory search could hang for good when one Sui read inside the SDK stalled, because the SDK&apos;s timeout did
          not cover that read. We filed it with a script that reproduces it. The Walrus Memory team reproduced it on SDK
          0.1.12, confirmed the cause and opened a fix.
        </p>
        <p className="mt-4 max-w-[40rem] text-base font-medium leading-[1.6] text-ink">
          Until the fix ships, Ellai never waits on a stuck search. It stops waiting and never pays on its own: it asks
          you instead, or refuses if too many questions are already waiting.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <FindingLinks shown={shown} still={still} />
        <Link
          href="/proof#walrus-finding"
          className="nav-sweep group mt-1 self-start font-grotesk text-[15px] font-medium text-ink"
        >
          <span className="inline-flex items-center gap-2">
            Read the whole finding
            <span className="inline-flex transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-safe:group-hover:translate-x-1">
              <ArrowRight />
            </span>
          </span>
        </Link>
      </div>
    </motion.div>
  );
}

/**
 * Landing section 6. Everything on it is read live from the public proof: the totals, the latest
 * payments and memories with their chain links, and the Walrus Memory bug we found and reported.
 */
export function CheckSection() {
  const state = useProof();
  const still = usePrefersReducedMotion();

  return (
    <section aria-labelledby="check-title" className="relative bg-paper">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="border-t border-mist pb-28 pt-24 md:pb-40 md:pt-32">
          <Header still={still} />
          <div className="mt-12 md:mt-[72px]">
            <ProofTotalsGrid />
          </div>
          {state.status === 'error' ? null : (
            <div className="mt-[88px]">
              <LatestLists limit={LIST_LIMIT} />
            </div>
          )}
          <div className="mt-7">
            <SiteButton href="/proof" variant="ghost" size="md" arrow="right">
              See all proof
            </SiteButton>
          </div>
          <WalrusBugCard />
        </div>
      </div>
    </section>
  );
}
