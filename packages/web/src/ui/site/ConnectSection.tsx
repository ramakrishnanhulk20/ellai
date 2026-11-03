'use client';

import Link from 'next/link';
import { animate, motion, useInView, useMotionValue } from 'motion/react';
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { AGENT_KEY_PLACEHOLDER, SNIPPETS, type SnippetId } from '../agent-snippets.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { ArrowRight } from './Arrow.js';
import { SquareLabel } from './SquareLabel.js';

const EASE = [0.16, 1, 0.3, 1] as const;

const ADVANCE_SECONDS = 6;
const NOTE_MS = 1500;

const SMALL_CAPS = 'font-plex text-xs font-medium uppercase tracking-[0.06em] text-ink-soft';

const CARD_SHADOW = 'shadow-[0_1px_2px_rgba(26,26,26,0.05),0_12px_28px_-8px_rgba(26,26,26,0.14)]';

// The marks match the legend in the learning section, so one colour means one outcome across the page.
const RESULTS = [
  { id: 'paid', mark: 'bg-accent', lead: 'Paid:', rest: "the seller's answer comes back to the agent." },
  {
    id: 'asked',
    mark: 'border-[1.5px] border-ink bg-paper',
    lead: 'Asked:',
    rest: 'the agent gets a decision id and checks back after you answer.',
  },
  { id: 'refused', mark: 'bg-[#E5342A]', lead: 'Refused:', rest: "the agent gets Ellai's reason." },
] as const;

function subscribeNever(): () => void {
  return () => {};
}

/** The address of the page the visitor is on. The server render has none, so the snippet starts without it. */
function useOrigin(): string {
  return useSyncExternalStore(subscribeNever, () => window.location.origin, () => '');
}

function rise(shown: boolean, still: boolean, delay: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    animate: shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 },
    transition: { duration: still ? 0 : 0.7, ease: EASE, delay: still ? 0 : delay },
  };
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.5 3.5v-.25A1.75 1.75 0 0 0 8.75 1.5h-5A1.75 1.75 0 0 0 2 3.25v5A1.75 1.75 0 0 0 3.75 10H4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-accent-text">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The key placeholder is picked out so it is clear what to replace.
function highlight(text: string) {
  const parts = text.split(AGENT_KEY_PLACEHOLDER);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? <span className="font-medium text-accent-text">{AGENT_KEY_PLACEHOLDER}</span> : null}
    </Fragment>
  ));
}

function Header({ still }: { still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.3 });
  const shown = still || seen;
  return (
    <div ref={block}>
      <motion.div {...rise(shown, still, 0)}>
        <SquareLabel className="text-ink-soft">Connect your agent</SquareLabel>
      </motion.div>
      <motion.h2
        id="connect-title"
        {...rise(shown, still, 0.08)}
        className="mt-6 max-w-[12ch] font-grotesk text-[clamp(2.25rem,6.1vw,5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink"
      >
        Any agent. One tool.
      </motion.h2>
      <motion.p {...rise(shown, still, 0.16)} className="mt-6 max-w-[36rem] text-lg leading-[1.6] text-ink-soft md:text-xl">
        Give your agent its own key in Ellai. It calls one tool, paid_fetch, with a URL and a plain reason. Ellai pays,
        refuses, or asks you first, and the agent never holds your money.
      </motion.p>
    </div>
  );
}

function Results({ still }: { still: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const seen = useInView(list, { once: true, amount: 0.3 });
  const shown = still || seen;
  return (
    <ul ref={list}>
      {RESULTS.map((result, index) => (
        <motion.li
          key={result.id}
          {...rise(shown, still, index * 0.08)}
          className={`flex items-start gap-[14px] border-t border-mist py-[18px] ${
            index === RESULTS.length - 1 ? 'border-b' : ''
          }`}
        >
          <span aria-hidden className={`mt-[5px] size-3 shrink-0 rounded-[3px] ${result.mark}`} />
          <p className="text-base leading-[1.55] text-ink">
            <span className="font-grotesk font-semibold">{result.lead}</span> {result.rest}
          </p>
        </motion.li>
      ))}
    </ul>
  );
}

type Note = 'copied' | 'failed';

/** Three ways to connect an agent, one tab each. It cycles through them on its own until the visitor takes over. */
function ConnectCard({ still }: { still: boolean }) {
  const origin = useOrigin();
  const baseId = useId();
  const card = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const code = useRef<HTMLPreElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const progress = useMotionValue(0);
  const panelHeight = useMotionValue(0);
  const heightMove = useRef<ReturnType<typeof animate> | undefined>(undefined);
  const hasHeight = useRef(false);
  const inView = useInView(card, { amount: 0.4 });
  const [sized, setSized] = useState(false);
  const [active, setActive] = useState<SnippetId>('code');
  const [swaps, setSwaps] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [stopped, setStopped] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const running = !still && !stopped && inView && !hovered && !focused;

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  // The bar and the timer are one animation, so pausing freezes the bar and resuming finishes the time that was left.
  useEffect(() => {
    if (!running) return;
    const controls = animate(progress, 1, {
      duration: ADVANCE_SECONDS * (1 - progress.get()),
      ease: 'linear',
      onComplete: () => {
        progress.set(0);
        const next = SNIPPETS[(SNIPPETS.findIndex((entry) => entry.id === active) + 1) % SNIPPETS.length];
        if (!next) return;
        setActive(next.id);
        setSwaps((count) => count + 1);
        setNote(null);
      },
    });
    return () => controls.stop();
  }, [running, active, progress]);

  // Each snippet has its own number of lines, so the panel follows the height of the one on show. The first
  // measurement sets it outright; after that it glides, or jumps for people who asked for less motion.
  useEffect(() => {
    const node = code.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      heightMove.current?.stop();
      if (!hasHeight.current || still) {
        panelHeight.set(height);
      } else {
        heightMove.current = animate(panelHeight, height, { duration: 0.3, ease: EASE });
      }
      if (!hasHeight.current) {
        hasHeight.current = true;
        setSized(true);
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      heightMove.current?.stop();
    };
  }, [active, still, panelHeight]);

  const snippet = SNIPPETS.find((entry) => entry.id === active) ?? SNIPPETS[0];
  if (!snippet) return null;
  const text = snippet.build(origin);

  function takeOver() {
    setStopped(true);
    progress.set(0);
  }

  function choose(index: number, moveFocus: boolean) {
    const wrapped = (index + SNIPPETS.length) % SNIPPETS.length;
    const next = SNIPPETS[wrapped];
    if (!next) return;
    takeOver();
    setActive(next.id);
    setSwaps((count) => count + 1);
    setNote(null);
    if (moveFocus) tabs.current[wrapped]?.focus();
  }

  function onTabKey(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight') choose(index + 1, true);
    else if (event.key === 'ArrowLeft') choose(index - 1, true);
    else if (event.key === 'Home') choose(0, true);
    else if (event.key === 'End') choose(SNIPPETS.length - 1, true);
    else return;
    event.preventDefault();
  }

  async function copy() {
    takeOver();
    clearTimeout(noteTimer.current);
    let result: Note = 'copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Without clipboard access (an insecure page, a blocked permission) the code is selected so Ctrl+C finishes the job.
      result = 'failed';
      const node = code.current;
      if (node) window.getSelection()?.selectAllChildren(node);
    }
    setNote(result);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  }

  return (
    <div
      ref={card}
      className={`min-w-0 overflow-hidden rounded-[12px] border border-mist bg-paper ${CARD_SHADOW}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div
        role="tablist"
        aria-label="How to connect"
        className="flex overflow-x-auto border-b border-mist px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SNIPPETS.map((entry, index) => {
          const selected = entry.id === active;
          return (
            <button
              key={entry.id}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${entry.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(index, false)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={`relative shrink-0 px-3 py-[14px] font-plex text-xs font-medium uppercase tracking-[0.06em] transition-colors duration-[160ms] ease-out focus-visible:outline-offset-[-2px] ${
                selected ? 'text-ink' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {entry.tab}
              {selected ? (
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-accent">
                  {still || stopped ? null : (
                    <motion.span
                      className="absolute inset-0 bg-accent-deep"
                      style={{ scaleX: progress, originX: 0 }}
                    />
                  )}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <motion.div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${snippet.id}`}
        className="relative overflow-hidden bg-bone"
        style={{ height: sized ? panelHeight : 'auto' }}
      >
        {/* At every width the code stops short of the copy button, so a long first line never runs under it. */}
        <motion.pre
          key={snippet.id}
          ref={code}
          role="region"
          aria-label="Code, scrolls sideways"
          tabIndex={0}
          initial={swaps === 0 || still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: still ? 0 : 0.2 }}
          className="mr-14 overflow-x-auto px-5 pb-6 pt-5 font-plex text-[13px] leading-[1.7] whitespace-pre text-ink [scrollbar-color:#A7AAAA_transparent] [scrollbar-width:thin] focus-visible:outline-offset-[-2px]"
        >
          <code>{highlight(text)}</code>
        </motion.pre>
        <div className="absolute right-3 top-3 flex items-center gap-2">
          {note ? (
            <span
              aria-hidden
              className={`rounded-[6px] bg-bone px-2 py-1 font-plex text-[11px] font-medium uppercase tracking-[0.06em] ${
                note === 'copied' ? 'text-accent-text' : 'text-ink-soft'
              }`}
            >
              {note === 'copied' ? 'Copied' : 'Copy failed'}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy command"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-mist bg-paper text-ink-soft transition-[border-color,color] duration-[160ms] ease-out hover:border-ink hover:text-ink"
          >
            {note === 'copied' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        <span role="status" className="sr-only">
          {note === 'copied' ? 'Copied to clipboard' : note === 'failed' ? 'Copy failed' : ''}
        </span>
      </motion.div>
    </div>
  );
}

function ConnectColumn({ still }: { still: boolean }) {
  const block = useRef<HTMLDivElement>(null);
  const seen = useInView(block, { once: true, amount: 0.2 });
  const shown = still || seen;
  return (
    <motion.div ref={block} {...rise(shown, still, 0.1)} className="min-w-0">
      <ConnectCard still={still} />
      <p className={`mt-[14px] ${SMALL_CAPS}`}>Get your agent key in Ellai under Agents. It is shown once.</p>
      <Link href="/docs" className="nav-sweep mt-5 font-grotesk text-base font-medium text-ink">
        How agents connect
        <span className="ml-2 inline-block align-[-2px]">
          <ArrowRight />
        </span>
      </Link>
    </motion.div>
  );
}

/** Landing section 5. One tool, three possible results, and the exact text to paste to connect an agent. */
export function ConnectSection() {
  const still = usePrefersReducedMotion();
  return (
    <section aria-labelledby="connect-title" className="relative bg-paper">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="border-t border-mist pb-28 pt-24 md:pb-40 md:pt-32">
          <Header still={still} />
          <div className="mt-12 grid grid-cols-1 gap-12 md:mt-[72px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-16">
            <Results still={still} />
            <ConnectColumn still={still} />
          </div>
        </div>
      </div>
    </section>
  );
}
