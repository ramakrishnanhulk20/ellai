'use client';

import type { ReactNode } from 'react';
import { isSignedOut } from './api.js';
import { Frame } from './Frame.js';
import { useOverview, useSession } from './session.js';
import { Ring } from './ui.js';
import { SignIn } from './SignIn.js';

/** Decides what /app shows: the sign-in screen, a short wait while the session is checked, or the app. */
export function AppGate({ children }: { children: ReactNode }) {
  const { signedOut } = useSession();
  const overview = useOverview();

  if (signedOut || isSignedOut(overview.error)) return <SignIn />;
  if (overview.isPending) {
    return (
      <div role="status" aria-label="Loading" className="grid min-h-svh place-items-center text-accent">
        <div className="h-10 w-10">
          <Ring stroke={2} className="ring-spin" />
        </div>
      </div>
    );
  }
  return <Frame>{children}</Frame>;
}
