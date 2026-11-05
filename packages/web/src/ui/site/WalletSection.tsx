'use client';

import { motion, useInView } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { SquareLabel } from './SquareLabel.js';

const EASE = [0.16, 1, 0.3, 1] as const;

const FLOW_LABEL =
  "Your wallet gives Ellai's purse a Sui allowance with a daily limit, a cap and an end date. The purse holds at most 0.20 USDC and pays a seller when the seller asks to be paid.";

const FACTS: readonly { title: string; body: string }[] = [
  { title: 'Daily limit', body: 'You choose it. Sui enforces it, not Ellai.' },
  { title: 'Cap and end date', body: 'The allowance stops at your total cap or your end date, whichever comes first.' },
  { title: 'The purse', body: "At most 0.20 USDC sits ready to pay at any time. Sui's limits cap everything else." },
  {
    title: 'End it any time',
    body: 'One signature in your wallet ends the allowance. Your purse can draw nothing more from your wallet after that.',
  },
  {
    title: 'Sign to loosen',
    body: "Raising a limit or adding an agent needs your wallet's signature, so a stolen login cannot do either.",
  },
];

const SMALL_CAPS = 'font-plex text-xs font-medium uppercase tracking-[0.06em]';
const BIG = 'mt-5 font-grotesk text-[40px] font-bold leading-[1.1] tracking-[-0.03em] text-ink';
const FOOT = 'mt-3 text-sm leading-[1.5] text-ink-soft';
const CARD =
  'flex flex-col justify-between rounded-[12px] bg-paper p-6 card-shadow lg:min-h-[200px] lg:self-stretch';

/** Seconds a card takes to settle, so a line can start drawing as the card to its left lands. */
const LINE_AFTER_CARD = 0.3;
/** The money starts moving once the cards and lines have finished their entrance. */
const MONEY_START = 1;

function Header({ still }: { still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const shown = still || seen;
  const rise = (delay: number) => ({
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    animate: shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 },
    transition: { duration: still ? 0 : 0.7, ease: EASE, delay: still ? 0 : delay },
  });
  return (
    <div ref={block}>
      <motion.div {...rise(0)}>
        <SquareLabel className="text-ink-soft">Your limits, on Sui</SquareLabel>
      </motion.div>
      <motion.h2
        id="wallet-title"
        {...rise(0.08)}
        className="mt-6 max-w-[14ch] font-grotesk text-[clamp(2.25rem,6.1vw,5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink"
      >
        Your money stays in your wallet.
      </motion.h2>
      <motion.p {...rise(0.16)} className="mt-6 max-w-[36rem] text-lg leading-[1.6] text-ink-soft md:text-xl">
        Ellai keeps a few cents ready to pay. The rest stays in your own wallet, behind a Sui allowance you set and can
        end with one signature.
      </motion.p>
    </div>
  );
}

function FlowCard({
  index,
  shown,
  still,
  accent = false,
  children,
}: {
  index: number;
  shown: boolean;
  still: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={`${CARD} ${accent ? 'border-[1.5px] border-accent' : 'border border-mist'}`}
      initial={still ? false : { opacity: 0, y: 24 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: still ? 0 : 0.7, ease: EASE, delay: still ? 0 : index * 0.12 }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The line between two cards, with its chip and one square of money travelling along it. The line and the moving
 * layer change direction with the card layout through CSS alone, so no script has to know which layout is showing.
 */
function Connector({
  chip,
  caption,
  index,
  shown,
  moving,
  still,
}: {
  chip: string;
  caption?: string;
  index: number;
  shown: boolean;
  moving: boolean;
  still: boolean;
}) {
  const lineDelay = still ? 0 : index * 0.12 + LINE_AFTER_CARD;
  // The second square leaves 1.4s after the first, so a refill reaches the purse and then a payment leaves it.
  const travel = {
    duration: 1.6,
    ease: 'easeInOut' as const,
    repeat: Infinity,
    repeatDelay: 1.2,
    delay: MONEY_START + index * 1.4,
  };
  const fade = {
    initial: still ? (false as const) : { opacity: 0 },
    animate: { opacity: shown ? 1 : 0 },
    transition: { duration: still ? 0 : 0.3, delay: lineDelay + 0.3 },
  };
  return (
    <div className="relative h-[96px] lg:h-px">
      <motion.span
        className="absolute left-1/2 top-0 h-full w-px bg-mist lg:left-0 lg:w-full"
        style={{ originX: 0, originY: 0 }}
        initial={still ? false : { scale: 0 }}
        animate={{ scale: shown ? 1 : 0 }}
        transition={{ duration: still ? 0 : 0.5, ease: EASE, delay: lineDelay }}
      />
      {/* Beside the line in the stacked layout, above it in the row layout, so nothing ever sits on the line the money rides. */}
      <motion.span
        {...fade}
        className="absolute left-[calc(50%+13px)] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-[6px] border border-mist bg-paper px-[7px] py-[3px] font-plex text-[11px] font-medium uppercase leading-[14px] tracking-[0.06em] text-ink-soft lg:bottom-full lg:left-1/2 lg:top-auto lg:mb-[10px] lg:-translate-x-1/2 lg:translate-y-0"
      >
        {chip}
      </motion.span>
      {/* A layer with no height in the row layout and no width in the column layout: moving it 100% of its own size travels the line along whichever axis has length. */}
      <motion.span
        data-moving-money=""
        className="absolute left-1/2 top-0 z-[2] h-full w-0 lg:left-0 lg:top-1/2 lg:h-0 lg:w-full"
        initial={{ x: '0%', y: '0%', opacity: 0 }}
        animate={
          moving
            ? { x: ['0%', '100%'], y: ['0%', '100%'], opacity: [0, 1, 1, 0] }
            : { x: '0%', y: '0%', opacity: 0 }
        }
        transition={
          moving
            ? { x: travel, y: travel, opacity: { ...travel, times: [0, 0.15, 0.85, 1] } }
            : { duration: 0.2 }
        }
      >
        <span className="absolute -left-1 -top-1 block size-2 rounded-[2px] bg-accent" />
      </motion.span>
      {caption ? (
        <motion.p
          {...fade}
          className="absolute left-[calc(50%+13px)] top-[calc(50%+15px)] w-max max-w-[calc(50%-13px)] text-balance font-plex text-[11px] uppercase leading-[1.4] text-ink-soft lg:left-1/2 lg:top-full lg:-ml-[75px] lg:mt-[10px] lg:w-[150px] lg:max-w-none lg:text-center"
        >
          {caption}
        </motion.p>
      ) : null}
    </div>
  );
}

function Flow({ still }: { still: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const seen = useInView(frame, { once: true, amount: 0.3 });
  const live = useInView(frame, { amount: 0.3 });
  const shown = still || seen;
  const moving = live && !still;
  return (
    <div ref={frame} role="img" aria-label={FLOW_LABEL}>
      <div aria-hidden className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)_160px_minmax(0,1fr)] lg:items-center">
        <FlowCard index={0} shown={shown} still={still}>
          <div>
            <p className={`${SMALL_CAPS} text-ink-soft`}>Your wallet</p>
            <p className={BIG}>USDC</p>
          </div>
          <p className={FOOT}>Stays here, behind your Sui allowance.</p>
        </FlowCard>

        <Connector
          chip="Allowance"
          caption="Daily limit / cap / end date"
          index={0}
          shown={shown}
          moving={moving}
          still={still}
        />

        <FlowCard index={1} shown={shown} still={still} accent>
          <div>
            <p className={`${SMALL_CAPS} text-accent-text`}>{"Ellai's purse"}</p>
            <p className={BIG}>
              0.20{' '}
              <span className="whitespace-nowrap text-sm font-normal tracking-normal text-ink-soft">USDC max</span>
            </p>
          </div>
          <p className={FOOT}>A few cents, ready to pay.</p>
        </FlowCard>

        <Connector chip="402 / pay" index={1} shown={shown} moving={moving} still={still} />

        <FlowCard index={2} shown={shown} still={still}>
          <div>
            <p className={`${SMALL_CAPS} text-ink-soft`}>Seller</p>
            <p className="mt-5 font-grotesk text-[26px] font-bold leading-[1.15] tracking-[-0.03em] text-ink">
              Paid per request
            </p>
          </div>
          <p className={FOOT}>{"Only after Ellai's checks pass."}</p>
        </FlowCard>
      </div>
    </div>
  );
}

function Facts({ still }: { still: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const seen = useInView(list, { once: true, amount: 0.15 });
  const shown = still || seen;
  return (
    <ol ref={list} className="m-0 list-none p-0 lg:grid lg:grid-cols-5 lg:gap-8">
      {FACTS.map((fact, index) => (
        <motion.li
          key={fact.title}
          className="group grid grid-cols-[48px_1fr] items-baseline gap-x-2 border-t border-mist py-5 last:border-b lg:block lg:min-w-0 lg:pb-0 lg:pt-5 lg:last:border-b-0"
          initial={still ? false : { opacity: 0, y: 24 }}
          animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
          transition={{ duration: still ? 0 : 0.7, ease: EASE, delay: still ? 0 : index * 0.08 }}
        >
          <span className="font-plex text-[13px] font-medium text-ink-soft transition-colors duration-[160ms] group-hover:text-accent-text lg:block">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div>
            <h3 className="font-grotesk text-xl font-semibold leading-[1.25] text-ink lg:mt-3">{fact.title}</h3>
            <p className="mt-[6px] text-base leading-[1.55] text-ink-soft lg:mt-2 lg:text-[15px]">{fact.body}</p>
          </div>
        </motion.li>
      ))}
    </ol>
  );
}

/**
 * Landing section 4. A drawing of wallet, purse and seller with money moving between them, above the five facts
 * that hold it together. Everything here is fixed product fact, so it reads no live data.
 */
export function WalletSection() {
  const still = usePrefersReducedMotion();
  return (
    <section aria-labelledby="wallet-title" className="relative bg-paper">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="border-t border-mist pb-28 pt-24 md:pb-40 md:pt-32">
          <Header still={still} />
          <div className="mt-12 md:mt-[72px]">
            <Flow still={still} />
            <div className="mt-14 lg:mt-20">
              <Facts still={still} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
