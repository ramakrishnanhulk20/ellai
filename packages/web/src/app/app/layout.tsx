import '@mysten/dapp-kit/dist/index.css';
import type { ReactNode } from 'react';
import { AppGate } from '../../ui/app/AppGate.js';
import { AppProviders } from '../../ui/app/Providers.js';
import '../../ui/app/app.css';

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f4' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0e' },
  ],
  colorScheme: 'light dark',
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProviders>
      <div data-site data-app className="min-h-svh">
        <AppGate>{children}</AppGate>
      </div>
    </AppProviders>
  );
}
