import { AccentSwitcher } from '../../ui/AccentSwitcher.js';
import { ExitStatement } from '../../ui/ExitStatement.js';
import { Hero } from '../../ui/Hero.js';
import { LenisProvider } from '../../ui/LenisProvider.js';
import { ScrollProgress } from '../../ui/ScrollProgress.js';
import { TopBar } from '../../ui/TopBar.js';

export const metadata = {
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <LenisProvider>
      <ScrollProgress />
      <TopBar />
      <main>
        <Hero />
        <ExitStatement />
      </main>
      <AccentSwitcher />
    </LenisProvider>
  );
}
