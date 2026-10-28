import { GhostLink } from './Buttons.js';
import { ProofLists } from './ProofLists.js';
import { ProofTotals } from './ProofTotals.js';
import { Reveal } from './Reveal.js';
import { Accent, Headline, Line, Paragraph, SectionLabel } from './SectionParts.js';

const LATEST_ROWS = 8;

/** Section 7. Real totals and the latest payments and memories, each one a link to the chain. */
export function ProofSection() {
  return (
    <section aria-labelledby="proof-heading" className="mt-24 px-4 md:px-8 lg:mt-40">
      <Reveal>
        <SectionLabel>07 / PROOF</SectionLabel>
        <Headline id="proof-heading">
          <Line>Don&apos;t trust us.</Line>
          <Line>
            <Accent>Check.</Accent>
          </Line>
        </Headline>
      </Reveal>
      <Reveal index={1} className="mt-6">
        <Paragraph>
          Every payment below settled on Sui and was read back through Tatum. Every memory is a Walrus blob
          owned by the person who made it. Open any of them.
        </Paragraph>
      </Reveal>
      <Reveal index={2} className="mt-12">
        <ProofTotals />
      </Reveal>
      <Reveal index={3} className="mt-12">
        <ProofLists limit={LATEST_ROWS} />
      </Reveal>
      <Reveal index={4} className="mt-8">
        <GhostLink href="/proof" height="h-10">
          See all proof
        </GhostLink>
      </Reveal>
    </section>
  );
}
