import '@mysten/dapp-kit/dist/index.css';
import type { ReactNode } from 'react';
import { AppGate } from '../../ui/app/AppGate.js';
import { AppProviders } from '../../ui/app/Providers.js';
import '../../ui/app/app.css';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProviders>
      <AppGate>{children}</AppGate>
    </AppProviders>
  );
}
