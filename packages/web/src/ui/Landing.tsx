import { AccentSwitcher } from './AccentSwitcher.js';
import { Closing } from './Closing.js';
import { ConnectAgent } from './ConnectAgent.js';
import { ExitStatement } from './ExitStatement.js';
import { Footer } from './Footer.js';
import { Hero } from './Hero.js';
import { HowEllaiDecides } from './HowEllaiDecides.js';
import { LenisProvider } from './LenisProvider.js';
import { LimitsSection } from './LimitsSection.js';
import { ProofSection } from './ProofSection.js';
import { ScrollProgress } from './ScrollProgress.js';
import { TopBar } from './TopBar.js';
import { MemoryMapProvider } from './useMemoryMap.js';
import { ProofProvider } from './useProof.js';
import { WatchItLearn } from './WatchItLearn.js';

/** The whole landing story in order. The lab page adds the accent colour switcher; the real home page does not. */
export function Landing({ withSwitcher }: { withSwitcher: boolean }) {
  return (
    <LenisProvider>
      <MemoryMapProvider>
        <ProofProvider>
          <ScrollProgress />
          <TopBar />
          <main>
            <Hero />
            <ExitStatement />
            <WatchItLearn />
            <HowEllaiDecides />
            <ProofSection />
            <ConnectAgent />
            <LimitsSection />
            <Closing />
          </main>
          <Footer />
          {withSwitcher ? <AccentSwitcher /> : null}
        </ProofProvider>
      </MemoryMapProvider>
    </LenisProvider>
  );
}
