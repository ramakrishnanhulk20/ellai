'use client';

import { useSignTransaction } from '@mysten/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  buildOnboardingStep,
  confirmExistingStep,
  confirmOnboardingDigest,
  fetchOnboarding,
  isApiError,
  submitOnboardingStep,
  type BuiltStep,
  type OnboardingState,
  type OnboardingStepName,
} from './api.js';
import { ButtonLink } from './ButtonLink.js';
import { TextField } from './controls.js';
import { CheckIcon } from './icons.js';
import { ALLOWANCE_HINTS, checkAllowance, type AllowanceInput } from './limits.js';
import { ConnectWalletButton, WrongWalletNote, useOwnerWallet } from './OwnerWallet.js';
import { ONBOARDING_KEY, usePatchOverview, useReloadOverview } from './session.js';
import { Summary, Waiting } from './setup-parts.js';
import { Button, Card, ErrorLine, PageShell, Ring, Skeleton } from './ui.js';
import { DECLINED } from './wallet-messages.js';
import { WalletBlock } from './WalletBlock.js';

const POLL_MS = 5_000;
const MAX_CHECKS = 6;

type StepInfo = { step: OnboardingStepName; key: keyof Omit<OnboardingState, 'purseAddress'>; title: string; text: string };

const STEPS: readonly StepInfo[] = [
  {
    step: 'memory_account',
    key: 'memoryAccount',
    title: 'Create your Walrus Memory account',
    text: 'Your answers will live here, in an account you own. Ellai only gets a key to write to it.',
  },
  {
    step: 'add_delegate',
    key: 'delegate',
    title: 'Give Ellai a key to your account',
    text: 'Ellai writes your answers with its own key. You can remove it on Sui at any time.',
  },
  {
    step: 'allowance',
    key: 'allowance',
    title: 'Set your spending allowance',
    text: "Your USDC stays in your wallet. The allowance lets Ellai's purse draw up to your limits, and you can end it with one signature in Settings.",
  },
];

const DEFAULT_ALLOWANCE: AllowanceInput = { daily: '0.50', cap: '5.00', days: '30' };

type Flow =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'existing' }
  | { kind: 'linking' }
  | { kind: 'summary'; built: BuiltStep }
  | { kind: 'signing'; built: BuiltStep }
  | { kind: 'submitting'; built: BuiltStep }
  | { kind: 'checking'; digest: string }
  | { kind: 'stalled'; digest: string; message: string | null; busy: boolean };

function messageOf(caught: unknown): string {
  return isApiError(caught) ? caught.message : 'Something went wrong. Try again.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rate limits and a Sui that cannot be read say nothing about the transaction itself, so after a
// digest is in hand they leave the step waiting rather than sending the owner back to build again.
function isTransient(caught: unknown): boolean {
  return isApiError(caught) && (caught.status === 429 || caught.status === 503 || caught.code === 'network');
}

function AllowanceForm({
  value,
  onChange,
  showBounds,
  disabled,
}: {
  value: AllowanceInput;
  onChange: (next: AllowanceInput) => void;
  showBounds: boolean;
  disabled: boolean;
}) {
  const { bad } = checkAllowance(value);
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <TextField
        label="DAILY LIMIT (USDC)"
        hint={ALLOWANCE_HINTS.daily}
        invalid={showBounds && bad.daily}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={value.daily}
        onChange={(event) => onChange({ ...value, daily: event.target.value })}
      />
      <TextField
        label="TOTAL CAP (USDC)"
        hint={ALLOWANCE_HINTS.cap}
        invalid={showBounds && bad.cap}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={value.cap}
        onChange={(event) => onChange({ ...value, cap: event.target.value })}
      />
      <TextField
        label="ENDS AFTER (DAYS)"
        hint={ALLOWANCE_HINTS.days}
        invalid={showBounds && bad.days}
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        value={value.days}
        onChange={(event) => onChange({ ...value, days: event.target.value })}
      />
    </div>
  );
}

/** One step's actions: review what will be signed, sign it in the wallet, send it, and wait until Sui shows it. */
function StepFlow({
  step,
  locked,
  onFinished,
}: {
  step: OnboardingStepName;
  locked: boolean;
  onFinished: () => Promise<void>;
}) {
  const wallet = useOwnerWallet();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AllowanceInput>(DEFAULT_ALLOWANCE);
  const [showBounds, setShowBounds] = useState(false);
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
    let terms;
    if (step === 'allowance') {
      setShowBounds(true);
      terms = checkAllowance(form).terms ?? undefined;
      if (terms === undefined) return;
    }
    setFlow({ kind: 'building' });
    try {
      const built = await buildOnboardingStep(step, terms);
      if (!alive.current) return;
      setFlow({ kind: 'summary', built });
    } catch (caught) {
      if (!alive.current) return;
      if (isApiError(caught) && caught.code === 'already_done' && step !== 'allowance') {
        setFlow({ kind: 'existing' });
        return;
      }
      fail(caught);
    }
  }

  async function link() {
    if (step === 'allowance') return;
    setError(null);
    setFlow({ kind: 'linking' });
    try {
      await confirmExistingStep(step);
      if (!alive.current) return;
      await onFinished();
    } catch (caught) {
      if (!alive.current) return;
      setError(messageOf(caught));
      setFlow({ kind: 'existing' });
    }
  }

  // Asks Sui once whether the digest has landed. 'waiting' means not yet; anything else has already been shown.
  async function confirmOnce(digest: string): Promise<'done' | 'waiting' | 'shown'> {
    try {
      await confirmOnboardingDigest(step, digest);
      if (!alive.current) return 'shown';
      await onFinished();
      return 'done';
    } catch (caught) {
      if (!alive.current) return 'shown';
      if (isApiError(caught) && caught.code === 'not_landed') return 'waiting';
      if (isTransient(caught)) {
        setFlow({ kind: 'stalled', digest, message: messageOf(caught), busy: false });
      } else {
        fail(caught);
      }
      return 'shown';
    }
  }

  async function watch(digest: string) {
    for (let check = 0; check < MAX_CHECKS; check += 1) {
      setFlow({ kind: 'checking', digest });
      await sleep(POLL_MS);
      if (!alive.current) return;
      const result = await confirmOnce(digest);
      if (result !== 'waiting') return;
    }
    if (alive.current) setFlow({ kind: 'stalled', digest, message: null, busy: false });
  }

  async function checkAgain(digest: string) {
    setFlow({ kind: 'stalled', digest, message: null, busy: true });
    const result = await confirmOnce(digest);
    if (result === 'waiting' && alive.current) setFlow({ kind: 'stalled', digest, message: null, busy: false });
  }

  async function sign(built: BuiltStep) {
    if (wallet.kind !== 'ready') return;
    setError(null);
    setFlow({ kind: 'signing', built });
    let signed;
    try {
      // The kit hands the wallet the server's base64 bytes as they are and signs those bytes only.
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
      // The signature is over the bytes the wallet returns. The server refuses any that differ from
      // the transaction it built, so a wallet that changed them gets an error, never a send.
      const sent = await submitOnboardingStep(step, signed.bytes, signed.signature);
      if (!alive.current) return;
      if (sent.recorded !== undefined) {
        await onFinished();
        return;
      }
      void watch(sent.digest);
    } catch (caught) {
      if (!alive.current) return;
      fail(caught);
    }
  }

  const summaryFlow = flow.kind === 'summary' || flow.kind === 'signing' || flow.kind === 'submitting' ? flow : null;
  const working = flow.kind === 'signing' || flow.kind === 'submitting';

  return (
    <div className="flex flex-col gap-5">
      {flow.kind === 'idle' || flow.kind === 'building' ? (
        <>
          {step === 'allowance' ? (
            <AllowanceForm value={form} onChange={setForm} showBounds={showBounds} disabled={locked || flow.kind === 'building'} />
          ) : null}
          <div>
            <Button
              variant="primary"
              size="lg"
              className="min-w-[160px]"
              disabled={locked}
              busy={flow.kind === 'building'}
              onClick={() => void review()}
            >
              Review
            </Button>
          </div>
        </>
      ) : null}

      {flow.kind === 'existing' || flow.kind === 'linking' ? (
        <>
          <p className="text-[15px] leading-[1.5] text-fg">This is already done on Sui.</p>
          <div>
            <Button variant="primary" size="lg" className="min-w-[160px]" busy={flow.kind === 'linking'} onClick={() => void link()}>
              Link it
            </Button>
          </div>
        </>
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

      {flow.kind === 'stalled' ? (
        <>
          <p className="text-[15px] leading-[1.5] text-fg">
            {flow.message ?? 'Sui has not shown it yet. Check again in a minute.'}
          </p>
          <div>
            <Button size="lg" busy={flow.busy} onClick={() => void checkAgain(flow.digest)}>
              Check again
            </Button>
          </div>
        </>
      ) : null}

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

function StepCard({
  index,
  info,
  done,
  locked,
  onFinished,
}: {
  index: number;
  info: StepInfo;
  done: boolean;
  locked: boolean;
  onFinished: () => Promise<void>;
}) {
  return (
    <Card className={`max-w-[720px] transition-opacity duration-300 ease-out ${locked ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-4">
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-[14px] leading-none ${
            done ? 'bg-accent text-accent-ink' : 'border border-line text-muted'
          }`}
        >
          {done ? <CheckIcon size={16} strokeWidth={2} /> : index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-medium leading-8 text-fg">{info.title}</h2>
          {done ? null : (
            <>
              <p className="mt-1 text-[15px] leading-[1.5] text-muted">{info.text}</p>
              <div className="mt-5 flex flex-col gap-5">
                {info.step === 'allowance' && !locked ? <WalletBlock /> : null}
                <StepFlow step={info.step} locked={locked} onFinished={onFinished} />
              </div>
            </>
          )}
        </div>
        {done ? <span className="font-mono text-[12px] leading-8 text-accent">Done</span> : null}
      </div>
    </Card>
  );
}

function ReadyCard() {
  return (
    <Card className="max-w-[720px]">
      <div className="h-12 w-12 text-accent">
        <Ring stroke={1.5} />
      </div>
      <h2 className="mt-5 font-display text-[28px] font-medium leading-[1.2] text-fg">Ellai is ready.</h2>
      <p className="mt-2 max-w-[520px] text-[15px] leading-[1.5] text-muted">
        Your purse is topped up within about ten minutes. Then give your agent a key, or try the built-in agent.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink href="/app/agents" variant="primary" size="lg">
          Add an agent
        </ButtonLink>
        <ButtonLink href="/app/run" size="lg">
          Try the built-in agent
        </ButtonLink>
      </div>
    </Card>
  );
}

export function SetupScreen() {
  const queryClient = useQueryClient();
  const patchOverview = usePatchOverview();
  const reloadOverview = useReloadOverview();
  const state = useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: fetchOnboarding,
    gcTime: 0,
    refetchOnMount: 'always',
  });

  // Reading the state costs no Sui call. The overview is read again only when the purse has just
  // become possible, because that is the one thing on it a new allowance changes.
  async function finished(): Promise<void> {
    const before = queryClient.getQueryData<OnboardingState>(ONBOARDING_KEY);
    await queryClient.refetchQueries({ queryKey: ONBOARDING_KEY });
    const after = queryClient.getQueryData<OnboardingState>(ONBOARDING_KEY);
    if (!after) return;
    patchOverview((overview) => ({ ...overview, onboarding: after }));
    if (before?.allowance !== 'present' && after.allowance === 'present') void reloadOverview();
  }

  const data = state.data;
  const firstMissing = data ? STEPS.findIndex((info) => data[info.key] !== 'present') : -1;

  return (
    <PageShell
      label="SETUP"
      title="Three signatures, once."
      intro="Each step is one signature in your wallet. Ellai sends it to Sui through Tatum and checks that it landed."
    >
      {data ? (
        <div className="flex flex-col gap-4">
          {STEPS.map((info, index) => {
            const done = data[info.key] === 'present';
            return (
              <StepCard
                key={info.step}
                index={index}
                info={info}
                done={done}
                locked={!done && firstMissing !== -1 && index > firstMissing}
                onFinished={finished}
              />
            );
          })}
          {firstMissing === -1 ? <ReadyCard /> : null}
        </div>
      ) : state.isError ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{state.error.message}</ErrorLine>
          <Button onClick={() => void state.refetch()}>Try again</Button>
        </div>
      ) : (
        <div className="flex max-w-[720px] flex-col gap-4">
          <Skeleton className="h-[120px]" />
          <Skeleton className="h-[120px]" />
          <Skeleton className="h-[120px]" />
        </div>
      )}
    </PageShell>
  );
}
