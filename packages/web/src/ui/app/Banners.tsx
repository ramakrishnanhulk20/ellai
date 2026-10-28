'use client';

import type { Overview } from './api.js';
import { useOverview } from './session.js';

const AUTO_PAUSE_TEXT: Record<string, string> = {
  settlement_mismatch: 'A payment landed that did not match what was agreed. Check History, then resume in Settings.',
  settlement_unverifiable: 'Ellai could not confirm a payment on Sui. Check History, then resume in Settings.',
  purse_key_mismatch: "Ellai's key for your purse did not match. Payments stay paused until this is fixed on Ellai's side.",
};

function Banner({ border, title, text }: { border: string; title: string; text?: string }) {
  return (
    <div className={`rounded-panel border bg-panel px-6 py-4 ${border}`}>
      <p className="text-[16px] font-medium leading-[1.4] text-fg">{title}</p>
      {text ? <p className="mt-1 text-[15px] leading-[1.5] text-muted">{text}</p> : null}
    </div>
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
      />
    ) : null,
    owner.autoPausedReason !== null ? (
      <Banner
        key="auto-paused"
        border="border-refused"
        title="Automatic payments are paused"
        text={AUTO_PAUSE_TEXT[owner.autoPausedReason]}
      />
    ) : null,
    done < 3 ? (
      <Banner
        key="setup"
        border="border-accent/40"
        title="Finish setting up Ellai"
        text={`${done} of 3 steps done: your Walrus Memory account, Ellai's key on it, and your spending allowance.`}
      />
    ) : null,
  ].filter((banner) => banner !== null);
  if (banners.length === 0) return null;
  return <div className="mb-8 flex flex-col gap-3">{banners}</div>;
}
