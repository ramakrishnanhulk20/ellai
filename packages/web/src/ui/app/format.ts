'use client';

import { useSyncExternalStore } from 'react';
import { formatUsdc } from '../format-usdc.js';

/** Atomic USDC (6 decimals, as text) to the way a person writes it: "50000" becomes "0.05". */
export function atomicToUsdc(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return atomic;
  const padded = atomic.padStart(7, '0');
  return formatUsdc(`${padded.slice(0, -6)}.${padded.slice(-6)}`);
}

/** The word after a count of approvals: "yes like it" for one, "yeses like it" for any other number. */
export function yesesLikeIt(count: number): string {
  return count === 1 ? 'yes like it' : 'yeses like it';
}

/** "last payment" for one, "last 12 payments" for any other number, so a sentence about a count reads right. */
export function lastPayments(count: number): string {
  return count === 1 ? 'last payment' : `last ${count} payments`;
}

/** "0x1234...abcd" from a full Sui address. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Relative under 24 hours, a short date and time in the viewer's locale after that. */
export function formatWhen(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const age = now - time;
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return new Date(time).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let clock = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    clock = Date.now();
    timer = setInterval(() => {
      clock = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time, refreshed every 30 seconds, so "4 min ago" keeps up without each row running a timer. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => clock, () => 0);
}

/** The memory page on Walruscan for a blob id. Blob ids are url-safe base64, encoded anyway. */
export function walruscanUrl(blobId: string): string {
  return `https://walruscan.com/mainnet/blob/${encodeURIComponent(blobId)}`;
}

/** Mist (9 decimals) as SUI with three decimals, cut rather than rounded, so a total under a threshold never reads as the threshold. */
export function mistToSui(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const thousandths = (mist % 1_000_000_000n) / 1_000_000n;
  return `${whole}.${thousandths.toString().padStart(3, '0')}`;
}
