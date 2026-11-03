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

// The wallet pop-up is drawn outside the app's wrapper, so the page tokens do not reach it: every
// colour here is a literal value taken from the light palette.
const WALLET_THEME: ThemeVars = {
  blurs: { modalOverlay: 'blur(8px)' },
  backgroundColors: {
    primaryButton: '#4a63ff',
    primaryButtonHover: '#3049e8',
    outlineButtonHover: 'rgba(26, 26, 26, 0.06)',
    walletItemHover: 'rgba(26, 26, 26, 0.06)',
    walletItemSelected: 'rgba(26, 26, 26, 0.06)',
    modalOverlay: 'rgba(26, 26, 26, 0.4)',
    modalPrimary: '#ffffff',
    modalSecondary: '#f5f5f4',
    iconButton: 'transparent',
    iconButtonHover: 'rgba(26, 26, 26, 0.06)',
    dropdownMenu: '#ffffff',
    dropdownMenuSeparator: '#dedfdf',
  },
  borderColors: { outlineButton: '#dedfdf' },
  colors: {
    primaryButton: '#ffffff',
    outlineButton: '#1a1a1a',
    body: '#1a1a1a',
    bodyMuted: '#656b6b',
    bodyDanger: '#b42318',
    iconButton: '#1a1a1a',
  },
  radii: { small: '8px', medium: '8px', large: '8px', xlarge: '12px' },
  shadows: { primaryButton: 'none', walletItemSelected: 'none' },
  fontWeights: { normal: '400', medium: '500', bold: '600' },
  fontSizes: { small: '14px', medium: '16px', large: '18px', xlarge: '20px' },
  typography: {
    // The font loader gives Space Grotesk a private family name, so the page's font variable comes first.
    fontFamily: 'var(--font-space-grotesk), "Space Grotesk", ui-sans-serif, system-ui, sans-serif',
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
