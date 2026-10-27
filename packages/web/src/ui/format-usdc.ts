/**
 * Shows a USDC amount the way a person writes money: trailing zeros trimmed, never fewer than
 * two decimals. "0.010000" becomes "0.01", "0.250000" becomes "0.25", "1.000000" becomes "1.00".
 * Works on the digits as text, so no rounding can creep in. Anything that is not a plain
 * decimal is returned unchanged.
 */
export function formatUsdc(amount: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return amount;
  const whole = match[1] ?? '0';
  const trimmed = (match[2] ?? '').replace(/0+$/, '');
  return `${whole}.${trimmed.padEnd(2, '0')}`;
}
