'use client';

import { useSignTransaction } from '@mysten/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  buildOnboardingStep,
  confirmOnboardingDigest,
  endEverySession,
  fetchOnboarding,
  fetchSettings,
  isApiError,
  patchSettings,
  submitOnboardingStep,
  type ApiError,
  type BuiltStep,
  type Settings,
  type SettingsChange,
} from './api.js';
import { AUTO_PAUSE_TEXT } from './Banners.js';
import { ButtonLink } from './ButtonLink.js';
import { Slider, Stepper, Switch, TextField } from './controls.js';
import { yesesLikeIt } from './format.js';
import {
  SPENDING_HINTS,
  checkSpending,
  cutoffText,
  loosens,
  sameCutoff,
  usdcInputText,
} from './limits.js';
import { ConnectWalletButton, WrongWalletNote, useOwnerWallet } from './OwnerWallet.js';
import { APP_KEY, ONBOARDING_KEY, usePatchOverview, useReloadOverview, useSession } from './session.js';
import { Summary, Waiting } from './setup-parts.js';
import { StepUpDialog } from './StepUpDialog.js';
import { Button, Card, ErrorLine, PageShell, Skeleton } from './ui.js';
import { DECLINED } from './wallet-messages.js';

const SETTINGS_KEY = [APP_KEY, 'settings'] as const;
const SAVED_MS = 2_000;
const CONFIRM_WINDOW_MS = 6_000;
const POLL_MS = 5_000;
const MAX_CHECKS = 6;
const EXPLORER_TX = 'https://suiscan.xyz/mainnet/tx/';

function failure(caught: unknown): string {
  return isApiError(caught) ? caught.message : 'Something went wrong. Try again.';
}

/**
 * Saving one card's change. A change that lets Ellai do more than it does now goes through the
 * wallet dialog first and is sent with its proof; any other change is sent as it is, and never
 * with a proof, because the server refuses a proof for a change that needs none.
 */
function useSaveChange(settings: Settings, onSaved: (next: Settings) => void) {
  const queryClient = useQueryClient();
  const patchOverview = usePatchOverview();
  const [asking, setAsking] = useState<SettingsChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function applied(next: Settings) {
    queryClient.setQueryData(SETTINGS_KEY, next);
    patchOverview((overview) => ({ ...overview, owner: { ...overview.owner, ...next } }));
    onSaved(next);
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), SAVED_MS);
  }

  async function save(change: SettingsChange) {
    setError(null);
    if (loosens(settings, change)) {
      setAsking(change);
      return;
    }
    setBusy(true);
    try {
      applied(await patchSettings(change));
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  function handoff(caught: ApiError): boolean {
    if (caught.code !== 'out_of_bounds') return false;
    setError(caught.message);
    return true;
  }

  const dialog =
    asking === null ? null : (
      <StepUpDialog
        request={{ action: 'loosen_settings', change: asking }}
        send={async (proof) => applied(await patchSettings(asking, proof))}
        handoff={handoff}
        onDone={() => setAsking(null)}
        onCancel={() => setAsking(null)}
      />
    );

  return { save, busy: busy || asking !== null, error, saved, dialog };
}

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span role="status" className="font-mono text-[12px] leading-none text-accent">
      Saved
    </span>
  ) : null;
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-[18px] font-medium leading-[1.4] text-fg">{children}</h2>;
}

function SaveRow({
  disabled,
  busy,
  saved,
  error,
  onSave,
}: {
  disabled: boolean;
  busy: boolean;
  saved: boolean;
  error: string | null;
  onSave: () => void;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-4">
        <Button variant="primary" disabled={disabled} busy={busy} onClick={onSave}>
          Save
        </Button>
        <Saved show={saved} />
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
    </div>
  );
}

function spendingDraft(settings: Settings) {
  return {
    perPayment: usdcInputText(settings.perPaymentMaxAtomic),
    daily: usdcInputText(settings.dailyBudgetAtomic),
  };
}

function SpendingCard({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState(() => spendingDraft(settings));
  const { save, busy, error, saved, dialog } = useSaveChange(settings, (next) => setDraft(spendingDraft(next)));
  const check = checkSpending(draft);

  const change: SettingsChange = {};
  if (check.perPayment !== null && check.perPayment !== settings.perPaymentMaxAtomic) {
    change.perPaymentMaxAtomic = check.perPayment;
  }
  if (check.daily !== null && check.daily !== settings.dailyBudgetAtomic) change.dailyBudgetAtomic = check.daily;
  const changed = Object.keys(change).length > 0;

  return (
    <Card className="max-w-[720px]">
      <CardTitle>Spending</CardTitle>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <TextField
          label="PER PAYMENT (USDC)"
          hint={SPENDING_HINTS.perPayment}
          invalid={check.bad.perPayment}
          inputMode="decimal"
          autoComplete="off"
          value={draft.perPayment}
          onChange={(event) => setDraft({ ...draft, perPayment: event.target.value })}
        />
        <TextField
          label="PER DAY (USDC)"
          hint={SPENDING_HINTS.daily}
          invalid={check.bad.daily}
          inputMode="decimal"
          autoComplete="off"
          value={draft.daily}
          onChange={(event) => setDraft({ ...draft, daily: event.target.value })}
        />
      </div>
      <SaveRow
        disabled={!changed || check.bad.perPayment || check.bad.daily}
        busy={busy}
        saved={saved}
        error={error}
        onSave={() => void save(change)}
      />
      {dialog}
    </Card>
  );
}

type EndFlow =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'summary'; built: BuiltStep }
  | { kind: 'signing'; built: BuiltStep }
  | { kind: 'submitting'; built: BuiltStep }
  | { kind: 'checking'; digest: string }
  | { kind: 'stalled'; digest: string; busy: boolean }
  | { kind: 'ended'; digest: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function EndedBody({ digest }: { digest: string }) {
  return (
    <div className="mt-3">
      <p role="status" className="label-mono text-accent">
        ENDED
      </p>
      <p className="mt-2 text-[15px] leading-[1.5] text-fg">
        Your allowance has ended. Your purse can draw nothing more from your wallet.
      </p>
      <a
        href={`${EXPLORER_TX}${encodeURIComponent(digest)}`}
        target="_blank"
        rel="noopener"
        className="app-underline mt-2 inline-block text-[14px] text-fg transition-colors duration-[160ms] ease-out hover:text-accent"
      >
        See it on Sui
      </a>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ButtonLink href="/app/setup" className="w-full sm:w-auto">
          Set up a new one
        </ButtonLink>
      </div>
    </div>
  );
}

function MissingBody() {
  return (
    <>
      <p className="mt-3 text-[15px] leading-[1.5] text-muted">
        You have no allowance. Your purse cannot draw from your wallet.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ButtonLink href="/app/setup" className="w-full sm:w-auto">
          Set one up
        </ButtonLink>
      </div>
    </>
  );
}

/**
 * Ends the Sui allowance with one wallet signature: ask twice, review what will be signed, sign the
 * exact bytes the server built, send, and wait until Sui no longer shows the allowance.
 */
function AllowanceCard() {
  const queryClient = useQueryClient();
  const reloadOverview = useReloadOverview();
  const wallet = useOwnerWallet();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const state = useQuery({ queryKey: ONBOARDING_KEY, queryFn: fetchOnboarding, gcTime: 0, refetchOnMount: 'always' });
  const [flow, setFlow] = useState<EndFlow>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  function refreshAccount() {
    void queryClient.invalidateQueries({ queryKey: ONBOARDING_KEY });
    void reloadOverview();
  }

  function stopConfirming() {
    clearTimeout(timer.current);
    setConfirming(false);
  }

  function fail(caught: unknown) {
    // The server has already forgotten an allowance that Sui no longer shows, so the card must read it again.
    if (isApiError(caught) && caught.code === 'already_done') refreshAccount();
    setError(failure(caught));
    setFlow({ kind: 'idle' });
  }

  function finishEnded(digest: string) {
    setFlow({ kind: 'ended', digest });
    refreshAccount();
  }

  async function review() {
    setError(null);
    setFlow({ kind: 'building' });
    try {
      const built = await buildOnboardingStep('end_allowance');
      if (!alive.current) return;
      setFlow({ kind: 'summary', built });
    } catch (caught) {
      if (alive.current) fail(caught);
    }
  }

  // Ending the allowance cannot be undone, so the first press only asks again.
  function press() {
    if (!confirming) {
      setConfirming(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
      return;
    }
    stopConfirming();
    void review();
  }

  // Asks Sui once whether the allowance is gone. 'waiting' means not yet; anything else has already been shown.
  async function confirmOnce(digest: string): Promise<'done' | 'waiting' | 'shown'> {
    try {
      await confirmOnboardingDigest('end_allowance', digest);
      if (!alive.current) return 'shown';
      finishEnded(digest);
      return 'done';
    } catch (caught) {
      if (!alive.current) return 'shown';
      if (isApiError(caught) && caught.code === 'not_landed') return 'waiting';
      fail(caught);
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
    if (alive.current) setFlow({ kind: 'stalled', digest, busy: false });
  }

  async function checkAgain(digest: string) {
    setFlow({ kind: 'stalled', digest, busy: true });
    const result = await confirmOnce(digest);
    if (result === 'waiting' && alive.current) setFlow({ kind: 'stalled', digest, busy: false });
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
      setFlow({ kind: 'idle' });
      return;
    }
    if (!alive.current) return;
    setFlow({ kind: 'submitting', built });
    try {
      // The signature is over the bytes the wallet returns. The server refuses any that differ from
      // the transaction it built, so a wallet that changed them gets an error, never a send.
      const sent = await submitOnboardingStep('end_allowance', signed.bytes, signed.signature);
      if (!alive.current) return;
      if (sent.ended === true) {
        finishEnded(sent.digest);
        return;
      }
      void watch(sent.digest);
    } catch (caught) {
      if (alive.current) fail(caught);
    }
  }

  const summaryFlow = flow.kind === 'summary' || flow.kind === 'signing' || flow.kind === 'submitting' ? flow : null;
  const working = flow.kind === 'signing' || flow.kind === 'submitting';
  // A flow under way keeps its own screen even if a background read says the allowance is already gone.
  const underWay = flow.kind !== 'idle' && flow.kind !== 'ended';

  const presentBody = (
    <>
      <p className="mt-3 text-[15px] leading-[1.5] text-muted">
        Ending the allowance stops your purse drawing from your wallet. What the purse already holds, at most 0.20
        USDC, stays there, and Ellai can still pay from it under your rules.
      </p>

      {flow.kind === 'idle' || flow.kind === 'building' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="danger" className="w-full sm:w-auto" busy={flow.kind === 'building'} onClick={press}>
            {confirming ? 'End it for good?' : 'End allowance'}
          </Button>
          {confirming && flow.kind === 'idle' ? (
            <Button variant="text" className="max-sm:mx-auto" onClick={stopConfirming}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}

      {summaryFlow ? (
        <div className="mt-4 flex flex-col gap-4">
          <Summary rows={summaryFlow.built.summary} />
          <div className="flex flex-wrap items-center gap-3">
            {wallet.kind !== 'ready' && !working ? (
              <ConnectWalletButton wallet={wallet} />
            ) : (
              <Button
                variant="primary"
                size="lg"
                className="w-full sm:w-auto sm:min-w-[160px]"
                busy={working}
                onClick={() => void sign(summaryFlow.built)}
              >
                {flow.kind === 'signing' ? 'Waiting for your wallet...' : 'Sign in wallet'}
              </Button>
            )}
            <Button size="lg" className="w-full sm:w-auto" disabled={working} onClick={() => setFlow({ kind: 'idle' })}>
              Back
            </Button>
          </div>
          {wallet.kind === 'wrong' && !working ? <WrongWalletNote wallet={wallet} /> : null}
        </div>
      ) : null}

      {flow.kind === 'checking' ? (
        <div className="mt-4">
          <Waiting>Sent. Checking Sui...</Waiting>
        </div>
      ) : null}

      {flow.kind === 'stalled' ? (
        <div className="mt-4 flex flex-col items-start gap-3">
          <p className="text-[15px] leading-[1.5] text-muted">Sui has not shown it yet. Check again in a minute.</p>
          <Button className="w-full sm:w-auto" busy={flow.busy} onClick={() => void checkAgain(flow.digest)}>
            Check again
          </Button>
        </div>
      ) : null}
    </>
  );

  let body: ReactNode;
  if (flow.kind === 'ended') {
    body = <EndedBody digest={flow.digest} />;
  } else if (!underWay && state.data === undefined) {
    body = state.isError ? (
      <div className="mt-3">
        <ErrorLine>{state.error.message}</ErrorLine>
      </div>
    ) : (
      <Skeleton className="mt-3 h-[72px]" />
    );
  } else if (underWay || state.data?.allowance === 'present') {
    body = presentBody;
  } else {
    body = <MissingBody />;
  }

  return (
    <Card className="max-w-[720px]">
      <CardTitle>Allowance</CardTitle>
      {body}
      {error ? (
        <div className="mt-3 flex flex-col items-start gap-2">
          <ErrorLine>{error}</ErrorLine>
          <Button variant="text" onClick={() => setError(null)}>
            Try again
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function LearningCard({ settings }: { settings: Settings }) {
  const [approvals, setApprovals] = useState(settings.approvalsNeeded);
  const [cutoff, setCutoff] = useState(settings.distanceCutoff);
  const { save, busy, error, saved, dialog } = useSaveChange(settings, (next) => {
    setApprovals(next.approvalsNeeded);
    setCutoff(next.distanceCutoff);
  });

  const change: SettingsChange = {};
  if (approvals !== settings.approvalsNeeded) change.approvalsNeeded = approvals;
  if (!sameCutoff(cutoff, settings.distanceCutoff)) change.distanceCutoff = cutoff;
  const changed = Object.keys(change).length > 0;

  return (
    <Card className="max-w-[720px]">
      <CardTitle>Learning</CardTitle>
      <div className="mt-4">
        <p className="label-mono text-muted">PAYS ON ITS OWN AFTER</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Stepper value={approvals} min={1} max={10} onChange={setApprovals} label="Yeses needed before Ellai pays on its own" />
          <span className="text-[13px] text-faint">{yesesLikeIt(approvals)}</span>
        </div>
      </div>
      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-4">
          <p className="label-mono text-muted">HOW ALIKE</p>
          <p className="font-mono text-[15px] leading-none tabular-nums text-fg">{cutoffText(cutoff)}</p>
        </div>
        <div className="mt-2">
          <Slider
            value={Math.round(cutoff * 100) / 100}
            min={0.05}
            max={1}
            step={0.05}
            onChange={setCutoff}
            label="How alike a past yes must be"
            low="STRICTER"
            high="LOOSER"
          />
        </div>
      </div>
      <SaveRow disabled={!changed} busy={busy} saved={saved} error={error} onSave={() => void save(change)} />
      {dialog}
    </Card>
  );
}

function AutomaticPaymentsCard({ settings }: { settings: Settings }) {
  const { save, busy, error, saved, dialog } = useSaveChange(settings, () => {});
  const on = !settings.paused;
  const reason = settings.autoPausedReason;
  return (
    <Card className="max-w-[720px]">
      <div className="flex items-center justify-between gap-4">
        <CardTitle>Automatic payments</CardTitle>
        <div className="flex items-center gap-3">
          <Saved show={saved} />
          <span className="text-[15px] leading-none text-fg">{on ? 'On' : 'Paused'}</span>
          <Switch
            checked={on}
            disabled={busy}
            label="Automatic payments"
            onChange={(next) => void save({ paused: !next })}
          />
        </div>
      </div>
      {reason !== null ? (
        <div className="mt-4 flex flex-col items-start gap-4">
          <p className="text-[15px] leading-[1.5] text-muted">
            {AUTO_PAUSE_TEXT[reason] ?? 'Ellai paused automatic payments on its own.'}
          </p>
          <Button busy={busy} onClick={() => void save({ clearAutoPause: true })}>
            Clear this pause
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
      {dialog}
    </Card>
  );
}

function PublicProofCard({ settings }: { settings: Settings }) {
  const { save, busy, error, saved, dialog } = useSaveChange(settings, () => {});
  return (
    <Card className="max-w-[720px]">
      <CardTitle>Public proof</CardTitle>
      <div className="mt-3 flex items-center justify-between gap-4">
        <p className="min-w-0 text-[15px] leading-[1.5] text-muted">
          Show my verified payments and memories on Ellai&apos;s public proof page and memory map.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <Saved show={saved} />
          <Switch
            checked={settings.publicProof}
            disabled={busy}
            label="Show my verified payments and memories on Ellai's public proof page and memory map."
            onChange={(next) => void save({ publicProof: next })}
          />
        </div>
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
      {dialog}
    </Card>
  );
}

function SessionsCard() {
  const session = useSession();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function stopConfirming() {
    clearTimeout(timer.current);
    setConfirming(false);
  }

  // Ending every session also ends this one, so the first press only asks again.
  async function press() {
    if (!confirming) {
      setConfirming(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
      return;
    }
    stopConfirming();
    setError(null);
    setBusy(true);
    try {
      await endEverySession();
      session.markSignedOut();
    } catch (caught) {
      setError(failure(caught));
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-[720px]">
      <CardTitle>Sessions</CardTitle>
      <p className="mt-3 text-[15px] leading-[1.5] text-muted">
        Signed in on another device you do not trust? End every session at once.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="danger" busy={busy} onClick={() => void press()}>
          {confirming ? 'Sign out everywhere?' : 'Sign out everywhere'}
        </Button>
        {confirming && !busy ? (
          <Button variant="text" onClick={stopConfirming}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
    </Card>
  );
}

export function SettingsScreen() {
  const query = useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings, gcTime: 0, refetchOnMount: 'always' });
  const settings = query.data;
  return (
    <PageShell label="SETTINGS" title="Your limits">
      {settings ? (
        <div className="flex flex-col gap-4">
          <SpendingCard settings={settings} />
          <AllowanceCard />
          <LearningCard settings={settings} />
          <AutomaticPaymentsCard settings={settings} />
          <PublicProofCard settings={settings} />
          <SessionsCard />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorLine>{query.error.message}</ErrorLine>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : (
        <div className="flex max-w-[720px] flex-col gap-4">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[96px]" />
        </div>
      )}
    </PageShell>
  );
}
