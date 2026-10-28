'use client';

import { SuiClientProvider, WalletProvider, type ThemeVars } from '@mysten/dapp-kit';
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { isApiError } from './api.js';
import { SessionProvider } from './session.js';

// The wallet kit needs a network to start. Nothing in the app reads Sui from the browser: every
// chain read goes through Ellai's server.
const NETWORKS = {
  mainnet: { url: getJsonRpcFullnodeUrl('mainnet'), network: 'mainnet' },
} as const;

// The kit writes these values into CSS variables, so they can point at the page's own tokens.
const WALLET_THEME: ThemeVars = {
  blurs: { modalOverlay: 'blur(8px)' },
  backgroundColors: {
    primaryButton: 'var(--accent)',
    primaryButtonHover: 'color-mix(in srgb, var(--accent) 88%, var(--fg))',
    outlineButtonHover: 'rgba(242, 242, 238, 0.06)',
    walletItemHover: 'rgba(242, 242, 238, 0.06)',
    walletItemSelected: 'rgba(242, 242, 238, 0.06)',
    modalOverlay: 'rgba(8, 9, 10, 0.72)',
    modalPrimary: 'var(--panel)',
    modalSecondary: 'var(--bg)',
    iconButton: 'transparent',
    iconButtonHover: 'rgba(242, 242, 238, 0.06)',
    dropdownMenu: 'var(--panel)',
    dropdownMenuSeparator: 'var(--line)',
  },
  borderColors: { outlineButton: 'var(--line)' },
  colors: {
    primaryButton: 'var(--accent-ink)',
    outlineButton: 'var(--fg)',
    body: 'var(--fg)',
    bodyMuted: 'var(--muted)',
    bodyDanger: 'var(--refused)',
    iconButton: 'var(--fg)',
  },
  radii: { small: '8px', medium: '8px', large: '12px', xlarge: '16px' },
  shadows: { primaryButton: 'none', walletItemSelected: 'none' },
  fontWeights: { normal: '400', medium: '500', bold: '600' },
  fontSizes: { small: '14px', medium: '16px', large: '18px', xlarge: '20px' },
  typography: {
    fontFamily: 'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',
    fontStyle: 'normal',
    lineHeight: '1.4',
    letterSpacing: '0',
  },
};

// A 4xx answer is a decision by the server, so asking again changes nothing. A dropped connection
// or a server fault gets one more try.
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: shouldRetry, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={NETWORKS} defaultNetwork="mainnet">
        <WalletProvider autoConnect theme={WALLET_THEME} slushWallet={{ name: 'Ellai' }}>
          <SessionProvider>{children}</SessionProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
