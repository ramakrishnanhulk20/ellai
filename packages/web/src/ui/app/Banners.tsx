'use client';

import type { ReactNode } from 'react';
import type { Overview } from './api.js';
import { useOverview } from './session.js';
import { ButtonLink } from './ButtonLink.js';

export const AUTO_PAUSE_TEXT: Record<string, string> = {
  settlement_mismatch: 'A payment landed that did not match what was agreed. Check History, then resume in Settings.',
  settlement_unverifiable: 'Ellai could not confirm a payment on Sui. Check History, then resume in Settings.',
  purse_key_mismatch: "Ellai's key for your purse did not match. Payments stay paused until this is fixed on Ellai's side.",
};

function Banner({ border, title, text, action }: { border: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-panel border bg-panel px-6 py-4 ${border}`}>
      <div className="min-w-0 flex-1 basis-[280px]">
        <p className="text-[16px] font-medium leading-[1.4] text-fg">{title}</p>
        {text ? <p className="mt-1 text-[15px] leading-[1.5] text-muted">{text}</p> : null}
      </div>
      {action}
    </div>
  );
}

function SettingsLink() {
  return (
    <ButtonLink href="/app/settings" variant="text">
      Settings
    </ButtonLink>
  );
}

function stepsDone(onboarding: Overview['onboarding']): number {
  return [onboarding.memoryAccount, onboarding.delegate, onboarding.allowance].filter((step) => step === 'present').length;
}

/** What the whole account needs you to know, shown under every page's header. Reads the overview once; it never polls. */
export function Banners() {
  const { data } = useOverview();
  if (!data) return null;
  const { owner, onboarding } = data;
  const done = stepsDone(onboarding);
  const banners = [
    owner.paused ? (
      <Banner
        key="paused"
        border="border-asked"
        title="Automatic payments are paused"
        text="You paused them. Ellai refuses every payment until you resume in Settings."
        action={<SettingsLink />}
      />
    ) : null,
    owner.autoPausedReason !== null ? (
      <Banner
        key="auto-paused"
        border="border-refused"
        title="Automatic payments are paused"
        text={AUTO_PAUSE_TEXT[owner.autoPausedReason]}
        action={<SettingsLink />}
      />
    ) : null,
    done < 3 ? (
      <Banner
        key="setup"
        border="border-accent/40"
        title="Finish setting up Ellai"
        text={`${done} of 3 steps done: your Walrus Memory account, Ellai's key on it, and your spending allowance.`}
        action={<ButtonLink href="/app/setup" variant="primary">Continue setup</ButtonLink>}
      />
    ) : null,
  ].filter((banner) => banner !== null);
  if (banners.length === 0) return null;
  return <div className="mb-8 flex flex-col gap-3">{banners}</div>;
}
