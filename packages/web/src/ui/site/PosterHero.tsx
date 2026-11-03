'use client';

import { Fragment, useRef, type CSSProperties } from 'react';
import { BillingBlock } from './BillingBlock.js';
import { PosterRing } from './PosterRing.js';
import { SiteButton } from './SiteButton.js';
import { SquareLabel } from './SquareLabel.js';
import { POSTER_HEADLINE, POSTER_SUB } from './headlines.js';
import { usePosterProgress } from './usePosterProgress.js';

// The same noise tile the old page-wide grain used, so the poster keeps its film texture.
const GRAIN_IMAGE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n' x='0' y='0' width='100%25' height='100%25'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

/**
 * The dark movie-poster first screen. It stays pinned while the white page rises over it. Every
 * word is in the server HTML, so a visitor reads the pitch whatever the ring animation is doing.
 */
export function PosterHero() {
  const sectionRef = useRef<HTMLElement>(null);
  usePosterProgress(sectionRef);

  return (
    <section
      ref={sectionRef}
      aria-labelledby="poster-title"
      data-poster
      className="sticky top-0 z-0 h-[100svh] min-h-[600px] overflow-hidden bg-night text-night-fg [--focus:#F4F2EC]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 55% at 64% 48%, color-mix(in srgb, var(--accent) 10%, transparent) 0%, transparent 70%)',
        }}
      />
      <div aria-hidden className="poster-ring pointer-events-none absolute inset-0">
        <PosterRing />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden md:block"
        style={{ background: 'linear-gradient(to right, rgba(7,8,10,0.72) 0%, rgba(7,8,10,0) 48%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(7,8,10,0.94) 0%, rgba(7,8,10,0.62) 30%, rgba(7,8,10,0) 60%)',
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-night"
        style={{ opacity: 'calc(var(--p, 0) * 0.8)' }}
      />

      <div className="poster-copy relative z-10 mx-auto flex h-full w-full max-w-[100rem] flex-col px-5 pt-[60px] sm:px-8 md:pt-[72px] lg:px-14">
        <div className="poster-eyebrow">
          <div
            className="enter-rise mt-6 flex items-center justify-between md:mt-10"
            style={{ animationDelay: '120ms' }}
          >
            <SquareLabel className="text-night-fg/[0.72]">Agent payments on Sui Mainnet</SquareLabel>
            <p className="hidden font-plex text-[13px] font-medium uppercase tracking-[0.06em] text-night-fg/[0.56] md:block">
              Ellai: Tamil for limit
            </p>
          </div>
        </div>

        <div className="flex-1" />

        <h1 id="poster-title" className="poster-title font-grotesk font-bold leading-[0.92] tracking-[-0.04em] text-night-fg">
          {POSTER_HEADLINE.map((line, index) => (
            <Fragment key={`${index}-${line}`}>
              {index > 0 ? ' ' : null}
              <span className="poster-mask">
                <span className="poster-line" style={{ '--i': index } as CSSProperties}>
                  {line}
                </span>
              </span>
            </Fragment>
          ))}
        </h1>

        <p
          className="enter-rise mt-6 max-w-[38rem] text-pretty font-grotesk text-[17px] leading-[1.6] text-night-fg/[0.72] md:mt-8 md:text-xl"
          style={{ animationDelay: '520ms' }}
        >
          {POSTER_SUB}
        </p>

        <div
          className="enter-rise mt-8 flex flex-col gap-3 md:mt-10 md:flex-row"
          style={{ animationDelay: '620ms' }}
        >
          <SiteButton href="/app" variant="primary" size="lg" arrow="right" className="w-full md:w-auto">
            Open Ellai
          </SiteButton>
          <SiteButton href="#journey" variant="ghost-dark" size="lg" arrow="down" className="w-full md:w-auto">
            Watch a payment
          </SiteButton>
        </div>

        <div
          className="enter-fade mt-8 md:mt-10"
          style={{ animationDuration: '600ms', animationDelay: '900ms' }}
        >
          <BillingBlock />
        </div>
      </div>
    </section>
  );
}
