import { GhostLink, PrimaryLink } from './Buttons.js';
import { Reveal } from './Reveal.js';
import { Accent } from './SectionParts.js';

/**
 * Section 10. A left-aligned closing line over a big turning copy of the limit ring, half off the
 * right edge. The section is tall enough for the ring and clips whatever hangs outside it.
 */
export function Closing() {
  return (
    <section
      aria-labelledby="closing-heading"
      className="relative mt-24 flex min-h-[80svh] items-center overflow-hidden px-4 md:px-8 lg:mt-40"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-1/2 size-[70vh] translate-x-1/2 -translate-y-1/2"
      >
        <svg viewBox="0 0 20 20" fill="none" className="closing-ring size-full">
          <path
            d="M13.909 1.617A9.25 9.25 0 1 0 18.383 6.091"
            className="stroke-accent"
            strokeOpacity="0.3"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <div className="relative py-16">
        <Reveal>
          <h2
            id="closing-heading"
            className="font-display text-[clamp(3rem,10vw,9rem)] font-medium leading-none tracking-[-0.02em] text-fg"
          >
            <span className="block">Give your agent</span>
            <span className="block">
              a <Accent>limit.</Accent>
            </span>
          </h2>
        </Reveal>
        <Reveal index={1} className="mt-10 flex flex-wrap gap-2">
          <PrimaryLink href="/app" height="h-12">
            Open Ellai
          </PrimaryLink>
          <GhostLink href="/docs" height="h-12">
            Read the docs
          </GhostLink>
        </Reveal>
      </div>
    </section>
  );
}
