import type { BuiltStep } from './api.js';
import { Ring } from './ui.js';

/** The plain lines a transaction does, shown before the wallet is asked to sign it. The text comes from the server. */
export function Summary({ rows }: { rows: BuiltStep['summary'] }) {
  return (
    <div>
      <p className="label-mono text-muted">WHAT YOU WILL SIGN</p>
      <dl className="mt-2 rounded-button border border-line bg-bg px-4">
        {rows.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:gap-4"
          >
            <dt className="shrink-0 text-[14px] leading-[1.5] text-muted sm:w-[160px]">{row.label}</dt>
            <dd className="min-w-0 font-mono text-[14px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Waiting({ children }: { children: string }) {
  return (
    <p role="status" className="flex items-center gap-3 text-[15px] leading-[1.5] text-fg">
      <span className="h-4 w-4 shrink-0 text-accent">
        <Ring stroke={2} className="ring-spin" />
      </span>
      {children}
    </p>
  );
}
