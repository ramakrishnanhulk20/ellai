'use client';

import { motion, useInView } from 'motion/react';
import { useEffect, useRef } from 'react';
import { LenisProvider } from '../LenisProvider.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { ProofProvider, useProof } from '../useProof.js';
import { LatestLists, ProofTotalsGrid, rise } from './CheckSection.js';
import { SiteFooter } from './SiteFooter.js';
import { SiteHeader } from './SiteHeader.js';
import { SquareLabel } from './SquareLabel.js';
import { WalrusFinding } from './WalrusFinding.js';

function ProofHeader() {
  const still = usePrefersReducedMotion();
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const shown = still || seen;

  return (
    <div ref={block}>
      <motion.div {...rise(shown, still, 0)}>
        <SquareLabel className="text-ink-soft">Proof</SquareLabel>
      </motion.div>
      <motion.h1
        id="proof-title"
        {...rise(shown, still, 0.08)}
        className="mt-6 max-w-[14ch] font-grotesk text-[clamp(2.75rem,7.2vw,6.5rem)] font-bold leading-[1.02] tracking-[-0.035em] text-ink"
      >
        Latest payments and memories.
      </motion.h1>
      <motion.p
        {...rise(shown, still, 0.16)}
        className="mt-7 max-w-[40rem] text-lg leading-[1.6] text-ink-soft md:text-xl"
      >
        Payments settled on Sui and read back through Tatum, and memories stored on Walrus, for every Ellai owner who
        chose to show them. Nothing here comes from anyone&apos;s word. The totals count every payment and owner
        answer; the lists show up to the 20 newest of each.
      </motion.p>
    </div>
  );
}

/** The element id a link's hash points at. A hash that is not valid percent text, such as #%E0, points at nothing. */
export function hashTargetId(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}

/**
 * A link such as /proof#walrus-finding scrolls while the lists are still empty skeletons, and the real
 * rows then push the target down the page. Once the first read settles, this puts the target back at
 * the top, unless the visitor has already started scrolling on their own.
 */
function KeepHashTargetInView() {
  const state = useProof();
  const settled = state.status !== 'loading';
  const visitorMoved = useRef(false);

  useEffect(() => {
    const mark = () => {
      visitorMoved.current = true;
    };
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    window.addEventListener('keydown', mark);
    return () => {
      window.removeEventListener('wheel', mark);
      window.removeEventListener('touchmove', mark);
      window.removeEventListener('keydown', mark);
    };
  }, []);

  useEffect(() => {
    if (!settled || visitorMoved.current) return;
    const id = hashTargetId(window.location.hash);
    const target = id ? document.getElementById(id) : null;
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [settled]);

  return null;
}

/** When the first read fails the totals already say so, and empty lists under it would only repeat that. */
function FullLists() {
  const state = useProof();
  if (state.status === 'error') return null;
  return (
    <div className="mt-24">
      <h2 className="sr-only">Latest payments and memories</h2>
      <LatestLists limit={Infinity} />
    </div>
  );
}

/** The full proof page: every total, payment and memory the server lists, then the Walrus Memory finding. */
export function ProofBoard() {
  return (
    <div data-site>
      <ProofProvider>
        <LenisProvider>
          <KeepHashTargetInView />
          <SiteHeader overPoster={false} />
          <main aria-labelledby="proof-title" className="bg-paper pb-28 pt-32 md:pb-40 md:pt-40">
            <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
              <ProofHeader />
              <div className="mt-20">
                <ProofTotalsGrid onProofPage />
              </div>
              <FullLists />
              <WalrusFinding />
            </div>
          </main>
          <SiteFooter />
        </LenisProvider>
      </ProofProvider>
    </div>
  );
}
