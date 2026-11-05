import { LenisProvider } from '../LenisProvider.js';
import { MemoryMapProvider } from '../useMemoryMap.js';
import { ProofProvider } from '../useProof.js';
import { CheckSection } from './CheckSection.js';
import { ClosingPoster } from './ClosingPoster.js';
import { ConnectSection } from './ConnectSection.js';
import { JourneySection } from './JourneySection.js';
import { LearningSection } from './LearningSection.js';
import { PosterHero } from './PosterHero.js';
import { SiteFooter } from './SiteFooter.js';
import { SiteHeader } from './SiteHeader.js';
import { WalletSection } from './WalletSection.js';

/**
 * The home page, in Ram's approved order. The poster stays pinned under the page, so
 * the closing band and the footer sit outside its parent: the poster stops sticking where they begin.
 */
export function HomePage() {
  return (
    <div data-site>
      <ProofProvider>
        <MemoryMapProvider>
          <LenisProvider>
            <SiteHeader overPoster />
            <div className="relative">
              <PosterHero />
              <div
                id="journey"
                className="relative z-10 bg-paper text-ink sheet-shadow"
              >
                <JourneySection />
                <LearningSection />
                <WalletSection />
                <ConnectSection />
                <CheckSection />
              </div>
            </div>
            <ClosingPoster />
            <SiteFooter />
          </LenisProvider>
        </MemoryMapProvider>
      </ProofProvider>
    </div>
  );
}
