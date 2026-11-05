'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EllaiMark } from '../EllaiMark.js';
import { SiteButton } from './SiteButton.js';
import { ThemeToggle } from './ThemeToggle.js';

type Tone = 'poster' | 'paper';

const DESKTOP_QUERY_WIDTH = 768;
const HEADER_HEIGHT_PHONE = 60;
const HEADER_HEIGHT_DESKTOP = 72;

/**
 * Sits on the poster as bare text, then turns into a frosted bar once the poster has
 * scrolled out from under it. The server and the first client render are always the poster tone,
 * so the two match and nothing flickers.
 */
export function SiteHeader({ overPoster }: { overPoster: boolean }) {
  const [scrolledPast, setScrolledPast] = useState(false);
  const tone: Tone = overPoster && !scrolledPast ? 'poster' : 'paper';

  useEffect(() => {
    if (!overPoster) return;
    let frame = 0;

    function update() {
      frame = 0;
      const headerHeight = window.innerWidth >= DESKTOP_QUERY_WIDTH ? HEADER_HEIGHT_DESKTOP : HEADER_HEIGHT_PHONE;
      setScrolledPast(window.scrollY >= window.innerHeight - headerHeight);
    }

    function onScroll() {
      if (frame === 0) frame = requestAnimationFrame(update);
    }

    frame = requestAnimationFrame(update);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [overPoster]);

  return (
    <header data-tone={tone} className="site-header fixed inset-x-0 top-0 z-40 h-[60px] md:h-[72px]">
      <div className="mx-auto flex h-full w-full max-w-[100rem] items-center justify-between px-5 sm:px-8 lg:px-14">
        <Link href="/" aria-label="Ellai home" className="site-logo flex items-center gap-[10px]">
          <EllaiMark />
          <span className="font-grotesk text-[17px] font-bold tracking-[0.08em] max-[400px]:hidden">ELLAI</span>
        </Link>

        <div className="flex items-center gap-2 md:gap-6">
          <nav aria-label="Main" className="flex items-center gap-4 font-grotesk text-[14px] font-medium md:gap-8 md:text-[15px]">
            {/* The journey lives on the landing, so other pages link back to it there. The important marks
                are needed because .nav-sweep sets its own display, which would otherwise beat the hiding. */}
            <a href={overPoster ? '#journey' : '/#journey'} className="nav-sweep hidden! md:inline!">
              How it works
            </a>
            <Link href="/proof" className="nav-sweep">
              Proof
            </Link>
            <Link href="/docs" className="nav-sweep">
              Docs
            </Link>
          </nav>
          <ThemeToggle />
          <SiteButton href="/app" variant="primary" size="md" arrow="right" className="max-md:[&>span]:hidden">
            Open Ellai
          </SiteButton>
        </div>
      </div>
    </header>
  );
}
