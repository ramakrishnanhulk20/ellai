'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { EllaiMark } from '../EllaiMark.js';
import { isApiError, logout } from './api.js';
import { shortAddress } from './format.js';
import {
  AgentsIcon,
  ChevronIcon,
  HistoryIcon,
  MemoriesIcon,
  MoreIcon,
  OverviewIcon,
  QuestionsIcon,
  RunIcon,
  SettingsIcon,
} from './icons.js';
import { useOverview, useQuestions, useSession } from './session.js';
import { Button, CopyButton, ErrorLine, Ring } from './ui.js';

type NavItem = { href: string; label: string; Icon: ComponentType<{ size?: number }> };

const NAV: NavItem[] = [
  { href: '/app', label: 'Overview', Icon: OverviewIcon },
  { href: '/app/questions', label: 'Questions', Icon: QuestionsIcon },
  { href: '/app/history', label: 'History', Icon: HistoryIcon },
  { href: '/app/memories', label: 'Memories', Icon: MemoriesIcon },
  { href: '/app/agents', label: 'Agents', Icon: AgentsIcon },
  { href: '/app/run', label: 'Run', Icon: RunIcon },
  { href: '/app/settings', label: 'Settings', Icon: SettingsIcon },
];

// The tab bar holds the four pages used most; the rest sit in the More sheet.
const TAB_HREFS = ['/app', '/app/questions', '/app/history', '/app/agents'];
const TABS: NavItem[] = NAV.filter((item) => TAB_HREFS.includes(item.href));
const OVERFLOW: NavItem[] = NAV.filter((item) => !TAB_HREFS.includes(item.href));

// Setup is reached from the banner and the ready card, not from the menu, but its page still has a title.
const TITLED: NavItem[] = [...NAV, { href: '/app/setup', label: 'Setup', Icon: SettingsIcon }];

function isActive(pathname: string, href: string): boolean {
  return href === '/app' ? pathname === '/app' : pathname === href || pathname.startsWith(`${href}/`);
}

function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] bg-accent px-1.5 font-mono text-[11px] font-medium leading-none text-accent-ink ${className}`}
    >
      {count}
    </span>
  );
}

function TopLink({ item, active, count }: { item: NavItem; active: boolean; count: number }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex h-full items-center gap-2 font-sans text-[15px] font-medium transition-colors duration-[160ms] ease-out ${
        active ? 'text-fg' : 'text-muted hover:text-fg'
      }`}
    >
      <span>{item.label}</span>
      {item.href === '/app/questions' ? <CountBadge count={count} /> : null}
      {active ? <span aria-hidden="true" className="absolute inset-x-0 bottom-[-1px] h-0.5 bg-accent" /> : null}
    </Link>
  );
}

function SheetLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex h-11 items-center px-4 font-sans text-[16px] font-medium transition-colors duration-[160ms] ease-out ${
        active ? 'text-fg' : 'text-muted hover:text-fg'
      }`}
    >
      {item.label}
      {active ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
    </Link>
  );
}

function TabLink({ item, active, count }: { item: NavItem; active: boolean; count: number }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex flex-col items-center justify-center gap-1 text-[12px] leading-none transition-colors duration-[160ms] ease-out hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] ${
        active ? "text-fg before:absolute before:inset-x-5 before:top-0 before:h-0.5 before:bg-accent before:content-['']" : 'text-muted'
      }`}
    >
      <span className="relative">
        <item.Icon size={20} />
        {item.href === '/app/questions' ? <CountBadge count={count} className="absolute -right-3 -top-3" /> : null}
      </span>
      <span>{item.label}</span>
    </Link>
  );
}

function OwnerAddress({ address }: { address: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span title={address} className="font-mono text-[13px] text-muted">
        {shortAddress(address)}
      </span>
      <CopyButton text={address} label="Copy address" />
    </div>
  );
}

/** The signed-in wallet in the top bar. It discloses a small panel with the full address and Sign out. */
function WalletMenu({
  address,
  pathname,
  signOut,
  signingOut,
  signOutError,
}: {
  address: string | null;
  pathname: string;
  signOut: () => void;
  signingOut: boolean;
  signOutError: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const panelId = useId();
  const labelId = useId();

  const close = useCallback(() => setOpen(false), []);
  useEffect(close, [pathname, close]);

  // Focus goes into the panel on open and back to the button on close. After a click elsewhere the
  // focus already sits on whatever was clicked, so it is only moved back when it would otherwise be lost.
  useEffect(() => {
    if (open) {
      panel.current?.focus();
    } else if (wasOpen.current) {
      const active = document.activeElement;
      if (active === null || active === document.body || wrapper.current?.contains(active)) trigger.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Node && wrapper.current && !wrapper.current.contains(event.target)) close();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close]);

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={address ? undefined : 'Account menu'}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-10 items-center gap-2.5 rounded-button border border-line bg-panel px-3 font-mono text-[13px] text-fg transition-[border-color] duration-[160ms] ease-out hover:border-fg"
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-accent" />
        {address ? <span>{shortAddress(address)}</span> : <span className="opacity-40">{'···'}</span>}
        <ChevronIcon
          size={12}
          strokeWidth={2}
          className={`transition-transform duration-[160ms] ease-out motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div
          ref={panel}
          id={panelId}
          tabIndex={-1}
          className="menu-drop absolute right-0 top-[calc(100%+8px)] w-[260px] rounded-[12px] border border-line bg-panel p-2 shadow-[0_1px_2px_rgba(26,26,26,0.05),0_12px_28px_-8px_rgba(26,26,26,0.14)] outline-none"
        >
          {address ? (
            <>
              <div role="group" aria-labelledby={labelId} className="flex items-start justify-between gap-2 p-[10px]">
                <div className="min-w-0">
                  <p id={labelId} className="label-mono text-muted">
                    Signed in as
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] leading-[1.5] text-fg">{address}</p>
                </div>
                <CopyButton text={address} label="Copy address" />
              </div>
              <div role="separator" className="my-1 h-px bg-line" />
            </>
          ) : null}
          <button
            type="button"
            disabled={signingOut}
            aria-busy={signingOut || undefined}
            onClick={signOut}
            className="flex h-10 w-full items-center gap-2 rounded-button px-2.5 text-left font-sans text-[15px] text-fg transition-colors duration-[160ms] ease-out hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {signingOut ? <Ring size={16} className="ring-spin" /> : null}
            Sign out
          </button>
          {signOutError ? (
            <div className="px-2.5 pb-2 pt-1">
              <ErrorLine>{signOutError}</ErrorLine>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MoreSheet({
  onClose,
  pathname,
  address,
  signOut,
  signingOut,
  signOutError,
}: {
  onClose: () => void;
  pathname: string;
  address: string | null;
  signOut: () => void;
  signingOut: boolean;
  signOutError: string | null;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="sheet-backdrop absolute inset-0 bg-[rgba(26,26,26,0.32)]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="More"
        tabIndex={-1}
        className="sheet-panel absolute inset-x-0 bottom-0 rounded-t-[16px] border-t border-line bg-panel px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-4 outline-none"
      >
        <nav aria-label="More" className="flex flex-col">
          {OVERFLOW.map((item) => (
            <SheetLink key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </nav>
        <div className="mt-4 flex flex-col gap-4 border-t border-line pt-5">
          {address ? <OwnerAddress address={address} /> : null}
          {signOutError ? <ErrorLine>{signOutError}</ErrorLine> : null}
          <Button full busy={signingOut} onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The signed-in app: a top bar on wide screens, and a top bar, a tab bar and a More sheet on small ones. */
export function Frame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const session = useSession();
  const { data: overview } = useOverview();
  const { waiting } = useQuestions();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const address = overview?.owner.suiAddress ?? null;
  const title = TITLED.find((item) => isActive(pathname, item.href))?.label ?? '';
  const moreActive = OVERFLOW.some((item) => isActive(pathname, item.href));
  const count = waiting.length;

  const closeSheet = useCallback(() => setSheetOpen(false), []);
  useEffect(closeSheet, [pathname, closeSheet]);

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
      session.markSignedOut();
    } catch (error) {
      setSignOutError(isApiError(error) ? error.message : 'Could not sign out. Try again.');
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-svh">
      <header className="app-glass sticky top-0 z-30 hidden h-[72px] border-b border-line lg:block">
        <div className="mx-auto flex h-full max-w-[100rem] items-center gap-8 px-14 xl:gap-10">
          <Link href="/app" className="flex shrink-0 items-center gap-[10px] transition-opacity duration-[160ms] ease-out hover:opacity-80">
            <EllaiMark />
            <span className="font-display text-[17px] font-bold tracking-[0.08em] text-fg">ELLAI</span>
          </Link>
          <nav aria-label="Main" className="flex h-full gap-6 xl:gap-7">
            {NAV.map((item) => (
              <TopLink key={item.href} item={item} active={isActive(pathname, item.href)} count={count} />
            ))}
          </nav>
          <div className="ml-auto">
            <WalletMenu
              address={address}
              pathname={pathname}
              signOut={() => void signOut()}
              signingOut={signingOut}
              signOutError={signOutError}
            />
          </div>
        </div>
      </header>

      <header className="app-glass sticky top-0 z-20 flex h-[60px] items-center gap-[10px] border-b border-line px-5 sm:px-8 lg:hidden">
        <EllaiMark />
        <span className="font-sans text-[16px] font-semibold text-fg">{title}</span>
      </header>

      <main className="mx-auto w-full max-w-[100rem] px-5 pb-28 pt-6 sm:px-8 lg:px-14 lg:pb-32 lg:pt-12">
        <div key={pathname} className="app-enter mx-auto max-w-[80rem]">
          {children}
        </div>
      </main>

      <nav aria-label="Tabs" className="app-glass fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-5 border-t border-line lg:hidden">
        {TABS.map((item) => (
          <TabLink key={item.href} item={item} active={isActive(pathname, item.href)} count={count} />
        ))}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          className={`relative flex flex-col items-center justify-center gap-1 text-[12px] leading-none transition-colors duration-[160ms] ease-out hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] ${
            moreActive ? "text-fg before:absolute before:inset-x-5 before:top-0 before:h-0.5 before:bg-accent before:content-['']" : 'text-muted'
          }`}
        >
          <MoreIcon size={20} />
          <span>More</span>
        </button>
      </nav>

      {sheetOpen ? (
        <MoreSheet
          onClose={closeSheet}
          pathname={pathname}
          address={address}
          signOut={() => void signOut()}
          signingOut={signingOut}
          signOutError={signOutError}
        />
      ) : null}
    </div>
  );
}
