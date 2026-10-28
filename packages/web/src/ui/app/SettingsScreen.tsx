'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  endEverySession,
  fetchSettings,
  isApiError,
  patchSettings,
  type ApiError,
  type Settings,
  type SettingsChange,
} from './api.js';
import { AUTO_PAUSE_TEXT } from './Banners.js';
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
import { APP_KEY, usePatchOverview, useSession } from './session.js';
import { StepUpDialog } from './StepUpDialog.js';
import { Button, Card, ErrorLine, PageShell, Skeleton } from './ui.js';

const SETTINGS_KEY = [APP_KEY, 'settings'] as const;
const SAVED_MS = 2_000;
const CONFIRM_WINDOW_MS = 6_000;

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
