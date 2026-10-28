import { AccentSwitcher } from '../../ui/AccentSwitcher.js';
import { ExitStatement } from '../../ui/ExitStatement.js';
import { Hero } from '../../ui/Hero.js';
import { HowEllaiDecides } from '../../ui/HowEllaiDecides.js';
import { LenisProvider } from '../../ui/LenisProvider.js';
import { ScrollProgress } from '../../ui/ScrollProgress.js';
import { TopBar } from '../../ui/TopBar.js';
import { MemoryMapProvider } from '../../ui/useMemoryMap.js';
import { WatchItLearn } from '../../ui/WatchItLearn.js';

export const metadata = {
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <LenisProvider>
      <MemoryMapProvider>
        <ScrollProgress />
        <TopBar />
        <main>
          <Hero />
          <ExitStatement />
          <WatchItLearn />
          <HowEllaiDecides />
        </main>
        <AccentSwitcher />
      </MemoryMapProvider>
    </LenisProvider>
  );
}
