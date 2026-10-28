import { Footer } from './Footer.js';
import { LenisProvider } from './LenisProvider.js';
import { ProofLists } from './ProofLists.js';
import { ProofTotals } from './ProofTotals.js';
import { Reveal } from './Reveal.js';
import { Paragraph, SectionLabel } from './SectionParts.js';
import { ScrollProgress } from './ScrollProgress.js';
import { TopBar } from './TopBar.js';
import { ProofProvider } from './useProof.js';

/** The full proof page: the same totals as the home page, then every payment and memory the server lists. */
export function ProofPage() {
  return (
    <LenisProvider>
      <ProofProvider>
        <ScrollProgress />
        <TopBar />
        <main className="px-4 pb-24 pt-24 md:px-8 md:pb-40 md:pt-40">
          <Reveal>
            <SectionLabel>PROOF</SectionLabel>
            <h1 className="mt-6 font-display text-[clamp(2.5rem,6vw,5rem)] font-medium leading-none tracking-[-0.02em] text-fg">
              Every payment, every memory.
            </h1>
          </Reveal>
          <Reveal index={1} className="mt-6">
            <Paragraph>
              Payments settled on Sui and read back through Tatum, and memories stored on Walrus, for every Ellai
              owner who chose to show them. Nothing here comes from anyone&apos;s word.
            </Paragraph>
          </Reveal>
          <Reveal index={2} className="mt-12">
            <ProofTotals />
          </Reveal>
          <Reveal index={3} className="mt-12">
            <ProofLists limit={Infinity} />
          </Reveal>
        </main>
        <Footer />
      </ProofProvider>
    </LenisProvider>
  );
}
