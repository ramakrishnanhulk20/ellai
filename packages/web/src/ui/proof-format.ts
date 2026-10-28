import { formatUsdc } from './format-usdc.js';

const USDC_DECIMALS = 6;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The first four and last four characters, for example "DC9N...d9wF". Short ids are shown whole. */
export function shortId(id: string): string {
  return id.length <= 11 ? id : `${id.slice(0, 4)}...${id.slice(-4)}`;
}

/** Turns whole USDC units (millionths) into the amount people read, for example "10000" into "0.01". */
export function atomicToUsdc(atomic: string): string {
  const padded = atomic.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const fraction = padded.slice(-USDC_DECIMALS);
  return formatUsdc(`${whole}.${fraction}`);
}

/**
 * Relative under a day ("just now", "5 min ago", "3 h ago"), then the short date in the viewer's
 * own locale ("28 Oct"). A time a little in the future, from clocks that disagree, reads as "just now".
 */
export function formatAgo(isoTime: string, now: number): string {
  const age = now - Date.parse(isoTime);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(isoTime));
}
