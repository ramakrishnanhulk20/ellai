'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { EllaiMark } from '../EllaiMark.js';
import { isApiError, logout } from './api.js';
import { shortAddress } from './format.js';
import { HistoryIcon, MemoriesIcon, MoreIcon, OverviewIcon, QuestionsIcon } from './icons.js';
import { useOverview, useQuestions, useSession } from './session.js';
import { Button, CopyButton, ErrorLine } from './ui.js';

type NavItem = { href: string; label: string; Icon: ComponentType<{ size?: number }> };

// Agents and Settings join this list when part 2 of the app lands.
const NAV: NavItem[] = [
  { href: '/app', label: 'Overview', Icon: OverviewIcon },
  { href: '/app/questions', label: 'Questions', Icon: QuestionsIcon },
  { href: '/app/history', label: 'History', Icon: HistoryIcon },
  { href: '/app/memories', label: 'Memories', Icon: MemoriesIcon },
];

const TABS: NavItem[] = NAV.filter((item) => item.href !== '/app/memories');
const OVERFLOW: NavItem[] = NAV.filter((item) => item.href === '/app/memories');

function isActive(pathname: string, href: string): boolean {
  return href === '/app' ? pathname === '/app' : pathname === href || pathname.startsWith(`${href}/`);
}

function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-button bg-accent px-1.5 font-mono text-[12px] leading-none text-accent-ink ${className}`}
    >
      {count}
    </span>
  );
}

function SidebarLink({ item, active, count }: { item: NavItem; active: boolean; count: number }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex h-10 items-center gap-3 rounded-button px-3 text-[15px] transition-colors duration-[160ms] ease-out hover:bg-[rgba(242,242,238,0.04)] ${
        active
          ? "bg-[rgba(242,242,238,0.06)] text-fg before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent before:content-['']"
          : 'text-muted hover:text-fg'
      }`}
    >
      <item.Icon size={16} />
      <span>{item.label}</span>
      {item.href === '/app/questions' ? <CountBadge count={count} className="ml-auto" /> : null}
    </Link>
  );
}

function TabLink({ item, active, count }: { item: NavItem; active: boolean; count: number }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`relative flex flex-col items-center justify-center gap-1 text-[12px] leading-none transition-colors duration-[160ms] ease-out hover:bg-[rgba(242,242,238,0.04)] ${
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
      <div className="sheet-backdrop absolute inset-0 bg-[rgba(8,9,10,0.64)]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="More"
        tabIndex={-1}
        className="sheet-panel absolute inset-x-0 bottom-0 rounded-t-panel border-t border-line bg-panel px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-6 outline-none"
      >
        <nav aria-label="More" className="flex flex-col gap-1">
          {OVERFLOW.map((item) => (
            <SidebarLink key={item.href} item={item} active={isActive(pathname, item.href)} count={0} />
          ))}
        </nav>
        <div className="mt-6 flex flex-col gap-4 border-t border-line pt-6">
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

/** The signed-in app: a fixed sidebar on wide screens, a top bar, a tab bar and a More sheet on small ones. */
export function Frame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const session = useSession();
  const { data: overview } = useOverview();
  const { waiting } = useQuestions();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const address = overview?.owner.suiAddress ?? null;
  const title = NAV.find((item) => isActive(pathname, item.href))?.label ?? '';
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
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-line bg-bg px-4 py-6 lg:flex">
        <Link href="/app" className="flex items-center gap-[10px] px-3">
          <EllaiMark />
          <span className="font-display text-[18px] font-semibold tracking-[0.08em] text-fg">ELLAI</span>
        </Link>
        <nav aria-label="Main" className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => (
            <SidebarLink key={item.href} item={item} active={isActive(pathname, item.href)} count={count} />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-1">
          {address ? <OwnerAddress address={address} /> : null}
          {signOutError ? <ErrorLine>{signOutError}</ErrorLine> : null}
          <Button full busy={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </aside>

      <header className="app-glass sticky top-0 z-20 flex h-[60px] items-center gap-[10px] border-b border-line px-4 lg:hidden">
        <EllaiMark />
        <span className="text-[16px] font-medium text-fg">{title}</span>
      </header>

      <main className="px-4 pb-24 pt-4 lg:ml-[248px] lg:p-12">
        <div key={pathname} className="app-enter mx-auto max-w-[1080px]">
          {children}
        </div>
      </main>

      <nav aria-label="Tabs" className="app-glass fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-4 border-t border-line lg:hidden">
        {TABS.map((item) => (
          <TabLink key={item.href} item={item} active={isActive(pathname, item.href)} count={count} />
        ))}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          className={`relative flex flex-col items-center justify-center gap-1 text-[12px] leading-none transition-colors duration-[160ms] ease-out hover:bg-[rgba(242,242,238,0.04)] ${
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
