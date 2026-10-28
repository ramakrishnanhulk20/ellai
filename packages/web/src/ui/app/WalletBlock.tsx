'use client';

import { useSignTransaction } from '@mysten/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { buildOnboardingStep, fetchWalletFunds, isApiError, submitOnboardingStep, type BuiltStep } from './api.js';
import { atomicToUsdc, mistToSui, shortAddress } from './format.js';
import { ConnectWalletButton, WrongWalletNote, useOwnerWallet } from './OwnerWallet.js';
import { APP_KEY, useOverview } from './session.js';
import { Summary, Waiting } from './setup-parts.js';
import { Button, CopyButton, ErrorLine, Skeleton } from './ui.js';
import { DECLINED } from './wallet-messages.js';

const WALLET_KEY = [APP_KEY, 'wallet'] as const;
// A setup transaction pays its fee from the owner's own SUI. Below this the build refuses, so the page says so first.
const FEE_FLOOR_MIST = 50_000_000n;
const MOVED_MS = 3_000;
const RECHECK_MS = 10_000;

function amount(text: string): bigint {
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

function messageOf(caught: unknown): string {
  return isApiError(caught) ? caught.message : 'Something went wrong. Try again.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Flow =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'summary'; built: BuiltStep }
  | { kind: 'signing'; built: BuiltStep }
  | { kind: 'submitting'; built: BuiltStep }
  | { kind: 'checking' };

/** Moves the owner's USDC coins into their address balance: review, sign in the wallet, send, then read the wallet again. */
function MoveUsdc({ coinsText, onMoved, onSent }: { coinsText: string; onMoved: () => Promise<void>; onSent: () => Promise<void> }) {
  const wallet = useOwnerWallet();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function fail(caught: unknown) {
    setError(messageOf(caught));
    setFlow({ kind: 'idle' });
  }

  async function review() {
    setError(null);
    setFlow({ kind: 'building' });
    try {
      const built = await buildOnboardingStep('usdc_to_address');
      if (!alive.current) return;
      setFlow({ kind: 'summary', built });
    } catch (caught) {
      if (alive.current) fail(caught);
    }
  }

  async function sign(built: BuiltStep) {
    if (wallet.kind !== 'ready') return;
    setError(null);
    setFlow({ kind: 'signing', built });
    let signed;
    try {
      signed = await signTransaction({ transaction: built.txBytesBase64 });
    } catch {
      if (!alive.current) return;
      setError(DECLINED);
      setFlow({ kind: 'summary', built });
      return;
    }
    if (!alive.current) return;
    setFlow({ kind: 'submitting', built });
    try {
      const sent = await submitOnboardingStep('usdc_to_address', signed.bytes, signed.signature);
      if (!alive.current) return;
      if (sent.recorded !== undefined) {
        setFlow({ kind: 'idle' });
        await onMoved();
        return;
      }
      // Nothing records this move, so there is no confirm to ask: Sui is given a moment, then the wallet is read again.
      setFlow({ kind: 'checking' });
      await sleep(RECHECK_MS);
      if (!alive.current) return;
      setFlow({ kind: 'idle' });
      await onSent();
    } catch (caught) {
      if (alive.current) fail(caught);
    }
  }

  const summaryFlow = flow.kind === 'summary' || flow.kind === 'signing' || flow.kind === 'submitting' ? flow : null;
  const working = flow.kind === 'signing' || flow.kind === 'submitting';

  return (
    <div className="flex flex-col gap-4">
      {flow.kind === 'idle' || flow.kind === 'building' ? (
        <div>
          <Button variant="primary" busy={flow.kind === 'building'} onClick={() => void review()}>
            Move {coinsText} USDC
          </Button>
        </div>
      ) : null}

      {summaryFlow ? (
        <>
          <Summary rows={summaryFlow.built.summary} />
          <div className="flex flex-wrap items-center gap-3">
            {wallet.kind !== 'ready' && !working ? (
              <ConnectWalletButton wallet={wallet} />
            ) : (
              <Button
                variant="primary"
                size="lg"
                className="min-w-[160px]"
                busy={working}
                onClick={() => void sign(summaryFlow.built)}
              >
                {flow.kind === 'signing' ? 'Waiting for your wallet...' : 'Sign in wallet'}
              </Button>
            )}
            <Button size="lg" disabled={working} onClick={() => setFlow({ kind: 'idle' })}>
              Back
            </Button>
          </div>
          {wallet.kind === 'wrong' && !working ? <WrongWalletNote wallet={wallet} /> : null}
        </>
      ) : null}

      {flow.kind === 'checking' ? <Waiting>Sent. Checking Sui...</Waiting> : null}

      {error ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{error}</ErrorLine>
          <Button variant="text" onClick={() => setError(null)}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <p className="label-mono text-muted">{label}</p>
      <p className="text-[20px] leading-[1.3] tabular-nums text-fg">{children}</p>
    </div>
  );
}

/**
 * What the owner's wallet holds, above the allowance form: the USDC an allowance can draw from, the
 * SUI that pays the setup fees, and the move that turns USDC coins into address balance. It reads Sui
 * once when it appears and again after a move, never on a timer, because each read costs Sui calls.
 */
export function WalletBlock() {
  const queryClient = useQueryClient();
  const { data: overview } = useOverview();
  const query = useQuery({
    queryKey: WALLET_KEY,
    queryFn: fetchWalletFunds,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnMount: 'always',
    retry: false,
  });
  const [moved, setMoved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function readAgain() {
    await queryClient.refetchQueries({ queryKey: WALLET_KEY });
  }

  async function onMoved() {
    setMoved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoved(false), MOVED_MS);
    await readAgain();
  }

  const funds = query.data;
  const owner = overview?.owner.suiAddress;
  const usdcAddress = funds ? amount(funds.usdcAddressAtomic) : 0n;
  const usdcCoins = funds ? amount(funds.usdcCoinAtomic) : 0n;
  const suiTotal = funds ? amount(funds.suiAddressMist) + amount(funds.suiCoinMist) : 0n;

  return (
    <div className="flex flex-col gap-4 rounded-card border border-line p-4">
      <p className="text-[15px] font-medium leading-[1.4] text-fg">Your wallet</p>

      {funds ? (
        <>
          <Row label="USDC READY FOR THE ALLOWANCE">{atomicToUsdc(funds.usdcAddressAtomic)} USDC</Row>
          <div className="flex flex-col gap-2">
            <Row label="SUI FOR FEES">{mistToSui(suiTotal)} SUI</Row>
            {suiTotal < FEE_FLOOR_MIST ? (
              <p className="text-[14px] leading-[1.4] text-refused">Your wallet needs about 0.05 SUI to pay setup fees.</p>
            ) : null}
          </div>

          {usdcCoins > 0n ? (
            <>
              <p className="rounded-button border border-asked p-3 text-[14px] leading-[1.5] text-fg">
                {atomicToUsdc(funds.usdcCoinAtomic)} USDC in your wallet is held as coins. A Sui allowance can only draw from
                your address balance, so move it first. One signature.
              </p>
              <MoveUsdc coinsText={atomicToUsdc(funds.usdcCoinAtomic)} onMoved={onMoved} onSent={readAgain} />
            </>
          ) : null}

          {usdcAddress === 0n && usdcCoins === 0n && owner !== undefined ? (
            <div className="flex items-start gap-1">
              <p className="min-w-0 text-[14px] leading-[1.5] text-fg">
                Your wallet has no USDC on Sui yet. Send some to {shortAddress(owner)} first.
              </p>
              <CopyButton text={owner} label="Copy your address" />
            </div>
          ) : null}

          {moved ? <p role="status" className="font-mono text-[12px] leading-none text-accent">Moved.</p> : null}
        </>
      ) : query.isError ? null : (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7" />
          <Skeleton className="h-7" />
        </div>
      )}

      {query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{query.error.message}</ErrorLine>
          <Button disabled={query.isFetching} busy={query.isFetching} onClick={() => void query.refetch()}>
            Check again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
