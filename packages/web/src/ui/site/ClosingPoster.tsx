'use client';

import { useInView } from 'motion/react';
import { Fragment, useRef } from 'react';
import { PosterRing } from './PosterRing.js';
import { SiteButton } from './SiteButton.js';
import { SquareLabel } from './SquareLabel.js';

const TITLE_LINES = ['Give your agent', 'a limit.'] as const;

// The same noise tile as the top poster, so both dark bands share one film texture.
const GRAIN_IMAGE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n' x='0' y='0' width='100%25' height='100%25'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

/*
 * The entrance runs as CSS transitions switched by data-seen on the copy block. That way the hidden
 * start state is a plain class (so the server HTML and the first client render match at every screen
 * width), and the motion-safe prefix leaves everything visible for people who ask for less motion.
 */
const RISE =
  'motion-safe:translate-y-6 motion-safe:opacity-0 motion-safe:transition-[opacity,translate] motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] motion-safe:group-data-[seen=true]/closing:translate-y-0 motion-safe:group-data-[seen=true]/closing:opacity-100';

// Below 768px the title rises as one block, like the top poster. From 768px each line rises out of its own mask.
const TITLE_RISE =
  'max-md:motion-safe:translate-y-6 max-md:motion-safe:opacity-0 max-md:motion-safe:transition-[opacity,translate] max-md:motion-safe:duration-700 max-md:motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] max-md:motion-safe:group-data-[seen=true]/closing:translate-y-0 max-md:motion-safe:group-data-[seen=true]/closing:opacity-100';

const LINE_RISE =
  'md:motion-safe:translate-y-[105%] md:motion-safe:transition-[translate] md:motion-safe:duration-1000 md:motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] md:motion-safe:group-data-[seen=true]/closing:translate-y-0';

/**
 * The second dark poster, at the foot of the page. The limit ring is drawn large behind the copy and
 * the copy asks for the one action: open Ellai. The ring is not tied to scroll here; the page-load
 * entrance in PosterRing has long finished by the time a visitor reaches this band, so it sits drawn
 * with the dot circling.
 */
export function ClosingPoster() {
  const copy = useRef<HTMLDivElement>(null);
  const seen = useInView(copy, { once: true, amount: 0.35 });

  return (
    <section
      aria-labelledby="closing-title"
      className="relative isolate flex min-h-[max(88svh,640px)] items-center overflow-hidden bg-night text-night-fg [--focus:var(--night-fg)]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [--ring-d:120vw] [--ring-x:70%] [--ring-y:28%] md:[--ring-d:min(78svh,58vw)] md:[--ring-x:74%] md:[--ring-y:50%]"
      >
        <PosterRing />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden md:block"
        style={{ background: 'linear-gradient(to right, color-mix(in srgb, var(--night) 72%, transparent) 0%, transparent 48%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, color-mix(in srgb, var(--night) 94%, transparent) 0%, color-mix(in srgb, var(--night) 62%, transparent) 30%, transparent 60%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: GRAIN_IMAGE, backgroundSize: '240px 240px', mixBlendMode: 'screen', opacity: 0.045 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: GRAIN_IMAGE, backgroundSize: '240px 240px', mixBlendMode: 'overlay', opacity: 0.14 }}
      />

      <div className="relative z-10 mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div ref={copy} data-seen={seen} className="group/closing py-24 md:py-32">
          <div className={RISE}>
            <SquareLabel className="text-night-fg/(--poster-text-strong)">Ellai: Tamil for limit</SquareLabel>
          </div>

          <h2
            id="closing-title"
            className={`mt-7 font-grotesk text-[10.5vw] font-bold leading-[0.92] tracking-[-0.04em] text-night-fg md:text-[clamp(3rem,8.4vw,9.5rem)] ${TITLE_RISE}`}
            style={{ transitionDelay: '100ms' }}
          >
            {TITLE_LINES.map((line, index) => (
              <Fragment key={line}>
                {index > 0 ? ' ' : null}
                <span className="inline md:block md:overflow-hidden md:pb-[0.06em]">
                  <span
                    className={`inline-block md:block ${LINE_RISE}`}
                    style={{ transitionDelay: `${100 + index * 90}ms` }}
                  >
                    {line}
                  </span>
                </span>
              </Fragment>
            ))}
          </h2>

          <div className={`mt-7 ${RISE}`} style={{ transitionDelay: '480ms' }}>
            <p className="max-w-[34rem] text-pretty text-lg leading-[1.6] text-night-fg/(--poster-text-strong) md:text-xl">
              Sign in with your Sui wallet, set your limits and give your agent its key. Your USDC stays in your
              wallet, and only a few cents wait in the purse.
            </p>
          </div>

          <div className={`mt-9 flex flex-col gap-3 md:flex-row ${RISE}`} style={{ transitionDelay: '560ms' }}>
            <SiteButton href="/app" variant="primary" size="lg" arrow="right" className="w-full md:w-auto">
              Open Ellai
            </SiteButton>
            <SiteButton href="/docs" variant="ghost-dark" size="lg" arrow="none" className="w-full md:w-auto">
              Read the docs
            </SiteButton>
          </div>
        </div>
      </div>
    </section>
  );
}
