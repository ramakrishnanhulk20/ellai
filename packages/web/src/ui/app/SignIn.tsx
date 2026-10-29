'use client';

import {
  ConnectModal,
  useCurrentAccount,
  useDisconnectWallet,
  useSignPersonalMessage,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { fetchOverview, isApiError, isSignedOut, requestNonce, verifySignIn } from './api.js';
import { EllaiMark } from '../EllaiMark.js';
import { shortAddress } from './format.js';
import { CheckIcon } from './icons.js';
import { OVERVIEW_KEY, useSession } from './session.js';
import { Button, ErrorLine, Ring } from './ui.js';

const DECLINED = 'You declined in your wallet. Sign in when you are ready.';

const HEADER_LINK =
  'label-mono inline-flex h-10 items-center rounded-button border border-line px-3 text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)] md:px-4';

type Phase = 'idle' | 'working' | 'waiting' | 'done';

function Step({ number, done, title, children }: { number: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[12px] leading-none ${
          done ? 'bg-accent text-accent-ink' : 'border border-line text-muted'
        }`}
      >
        {done ? <CheckIcon size={14} strokeWidth={2} /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium leading-6 text-fg">{title}</p>
        <div className="mt-3">{children}</div>
      </div>
    </li>
  );
}

/** Shown at /app and every /app route while no session is open. */
export function SignIn() {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const queryClient = useQueryClient();
  const session = useSession();
  const [modalOpen, setModalOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  function fail(message: string) {
    setError(message);
    setPhase('idle');
  }

  async function signIn() {
    if (!account) return;
    setError(null);
    setPhase('working');
    try {
      const { message } = await requestNonce(account.address);
      setPhase('waiting');
      let signature: string;
      try {
        ({ signature } = await signPersonalMessage({ message: new TextEncoder().encode(message) }));
      } catch {
        fail(DECLINED);
        return;
      }
      setPhase('working');
      await verifySignIn(message, signature);
      // The overview doubles as the check that the new session works, and loading it here keeps
      // this screen up until the app has something to show.
      queryClient.removeQueries({ queryKey: ['ellai'] });
      try {
        await queryClient.fetchQuery({ queryKey: OVERVIEW_KEY, queryFn: () => fetchOverview(), staleTime: Infinity });
      } catch (error) {
        if (isSignedOut(error)) {
          fail((error as Error).message);
          return;
        }
      }
      setPhase('done');
      session.markSignedIn();
    } catch (error) {
      fail(isApiError(error) ? error.message : 'Something went wrong. Try again.');
    }
  }

  const waiting = phase === 'waiting';
  const busy = phase === 'working' || waiting || phase === 'done';

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-[60px] items-center justify-between px-4 md:h-[104px] md:px-8">
        <a href="/" className="flex items-center gap-[10px]">
          <EllaiMark />
          <span className="font-display text-[18px] font-semibold tracking-[0.08em] text-fg">ELLAI</span>
        </a>
        <nav className="flex items-center gap-2">
          <a href="/proof" className={HEADER_LINK}>
            Proof
          </a>
          <a href="/docs" className={HEADER_LINK}>
            Docs
          </a>
        </nav>
      </header>
      <main className="flex-1 lg:grid lg:grid-cols-2">
        <section className="flex flex-col justify-center px-4 pb-8 pt-12 lg:p-16">
          <div className="h-[160px] w-[160px] text-accent lg:h-[280px] lg:w-[280px]">
            <Ring stroke={2} className="ring-turn" />
          </div>
          <h1 className="mt-10 font-display text-[clamp(2.5rem,5vw,4.5rem)] font-medium leading-none tracking-[-0.02em] text-fg">
            Give your agent
            <br />
            a <span className="text-accent">limit.</span>
          </h1>
          <p className="mt-6 max-w-[440px] text-[18px] leading-[1.5] text-muted">
            Sign in with your Sui wallet. Your wallet signs a one-time message, so Ellai never sees your keys, and your
            money stays in your wallet.
          </p>
        </section>

        <section className="flex items-center justify-center px-4 pb-12 lg:p-16">
          <div className="w-full max-w-[400px] rounded-panel border border-line bg-panel p-6 max-lg:max-w-none">
            <h2 className="font-display text-[28px] font-medium leading-[1.2] text-fg">Sign in</h2>
            <ol className="mt-6 flex flex-col gap-6">
              <Step number={1} done={account !== null} title="Connect a Sui wallet">
                <div className={account ? 'flex items-center justify-between gap-3' : ''}>
                  {account ? (
                    <span title={account.address} className="font-mono text-[14px] text-fg">
                      {shortAddress(account.address)}
                    </span>
                  ) : null}
                  <ConnectModal
                    open={modalOpen}
                    onOpenChange={setModalOpen}
                    trigger={
                      account ? (
                        <Button variant="text" disabled={busy} onClick={() => disconnect()}>
                          Change
                        </Button>
                      ) : (
                        <Button variant="primary" size="lg" full>
                          Connect wallet
                        </Button>
                      )
                    }
                  />
                </div>
              </Step>
              <Step number={2} done={phase === 'done'} title="Sign the sign-in message">
                <Button variant="primary" size="lg" full disabled={!account || busy} busy={busy} onClick={() => void signIn()}>
                  {waiting ? 'Waiting for your wallet...' : 'Sign in'}
                </Button>
                {error ? (
                  <div className="mt-3 flex flex-col items-start gap-2">
                    <ErrorLine>{error}</ErrorLine>
                    <Button variant="text" onClick={() => setError(null)}>
                      Try again
                    </Button>
                  </div>
                ) : null}
              </Step>
            </ol>
            <p className="label-mono mt-6 border-t border-line pt-4 text-muted">
              WORKS WITH ANY SUI WALLET, INCLUDING SLUSH SIGN-IN WITH GOOGLE.
            </p>
            <a
              href="https://slush.app"
              target="_blank"
              rel="noopener"
              className="label-mono link-draw mt-3 inline-block text-fg"
            >
              No wallet yet? Get Slush
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
