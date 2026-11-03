'use client';

import {
  ConnectModal,
  useCurrentAccount,
  useDisconnectWallet,
  useSignPersonalMessage,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { fetchOverview, isApiError, isSignedOut, requestNonce, verifySignIn } from './api.js';
import { EllaiMark } from '../EllaiMark.js';
import { PosterRing } from '../site/PosterRing.js';
import { usePrefersReducedMotion } from '../useMediaQuery.js';
import { shortAddress } from './format.js';
import { CheckIcon } from './icons.js';
import { OVERVIEW_KEY, useSession } from './session.js';
import { Button, Card, ErrorLine } from './ui.js';

const DECLINED = 'You declined in your wallet. Sign in when you are ready.';

const SMALL_CAPS = 'font-mono text-[12px] font-medium uppercase leading-[1.5] tracking-[0.06em]';
const SIDE_LINK =
  'font-sans text-[15px] font-medium text-muted transition-colors duration-[160ms] ease-out hover:text-fg';

type Phase = 'idle' | 'working' | 'waiting' | 'done';

function Step({
  number,
  done,
  active,
  title,
  children,
}: {
  number: number;
  done: boolean;
  active: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-px grid h-6 w-6 shrink-0 place-items-center rounded-[6px] font-mono text-[12px] leading-none ${
          done ? 'bg-accent text-accent-ink' : active ? 'bg-accent text-white' : 'border border-line text-muted'
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
  const reduceMotion = usePrefersReducedMotion();
  const rise = (delay: number) =>
    reduceMotion
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 24 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const, delay },
        };

  return (
    <main className="flex min-h-svh flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section
        aria-label="Ellai"
        className="relative isolate flex min-h-[46svh] flex-col justify-between overflow-hidden bg-[#07080a] p-6 text-[#f4f2ec] [--focus:#f4f2ec] lg:min-h-0 lg:p-14"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(60% 60% at 60% 40%, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 70%)',
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [--ring-d:110vw] [--ring-x:72%] [--ring-y:32%] lg:[--ring-d:min(62svh,40vw)] lg:[--ring-x:62%] lg:[--ring-y:42%]"
        >
          <PosterRing />
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(7,8,10,0.92) 0%, rgba(7,8,10,0) 55%)' }}
        />

        <div className="relative z-10">
          <a href="/" aria-label="Ellai home" className="inline-flex items-center gap-[10px]">
            <EllaiMark />
            <span className="font-display text-[17px] font-bold tracking-[0.08em]">ELLAI</span>
          </a>
        </div>

        <motion.div className="relative z-10" {...rise(0)}>
          <h1 className="font-display text-[10vw] font-bold leading-[0.95] tracking-[-0.04em] lg:text-[clamp(2.75rem,5vw,5rem)]">
            Give your agent
            <br />
            a <span className="text-[#8c9bff]">limit.</span>
          </h1>
          <p className="mt-6 max-w-[30rem] text-[17px] leading-[1.6] text-[rgba(244,242,236,0.72)]">
            Sign in with your Sui wallet. Your wallet signs a one-time message, so Ellai never sees your keys, and your
            money stays in your wallet.
          </p>
        </motion.div>
      </section>

      <section className="relative flex flex-col items-center justify-center bg-[#f5f5f4] px-5 py-8 lg:p-14">
        <motion.div className="w-full max-w-[420px]" {...rise(0.12)}>
          <Card className="w-full">
            <h2 className="font-display text-[28px] font-bold leading-[1.2] text-fg">Sign in</h2>
            <ol className="mt-6 flex flex-col gap-6">
              <Step number={1} done={account !== null} active={account === null} title="Connect a Sui wallet">
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
              <Step number={2} done={phase === 'done'} active={account !== null && phase !== 'done'} title="Sign the sign-in message">
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
            <p className={`${SMALL_CAPS} mt-6 border-t border-line pt-4 text-muted`}>
              WORKS WITH ANY SUI WALLET, INCLUDING SLUSH SIGN-IN WITH GOOGLE.
            </p>
            <a
              href="https://slush.app"
              target="_blank"
              rel="noopener"
              className={`${SMALL_CAPS} app-underline mt-3 inline-block text-fg`}
            >
              No wallet yet? Get Slush
            </a>
          </Card>
        </motion.div>

        <nav aria-label="Ellai pages" className="mt-8 flex items-center gap-6 lg:absolute lg:right-8 lg:top-6 lg:mt-0">
          <a href="/proof" className={SIDE_LINK}>
            Proof
          </a>
          <a href="/docs" className={SIDE_LINK}>
            Docs
          </a>
        </nav>
      </section>
    </main>
  );
}
