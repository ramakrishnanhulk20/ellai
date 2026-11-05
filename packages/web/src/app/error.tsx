'use client';

import Link from 'next/link';

/** Shown in place of a page whose render threw, so one bad row of data cannot leave a blank screen. */
export default function PageError({ reset }: { reset: () => void }) {
  return (
    <div data-site className="flex min-h-screen items-center bg-paper">
      <main className="mx-auto w-full max-w-[100rem] px-5 py-24 sm:px-8 lg:px-14">
        <h1 className="max-w-[16ch] font-grotesk text-[clamp(2.25rem,6.1vw,5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
          Something went wrong on this page.
        </h1>
        <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-5">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-12 items-center justify-center rounded-[8px] bg-accent px-6 font-grotesk text-base font-medium text-accent-ink transition-[background-color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-deep"
          >
            Try again
          </button>
          <Link href="/" className="nav-sweep font-grotesk text-base font-medium text-ink">
            Home
          </Link>
          <Link href="/docs" className="nav-sweep font-grotesk text-base font-medium text-ink">
            Docs
          </Link>
        </div>
      </main>
    </div>
  );
}
