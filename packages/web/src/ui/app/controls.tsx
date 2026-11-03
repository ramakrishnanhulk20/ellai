'use client';

import { useId, type ComponentProps, type CSSProperties } from 'react';
import { MinusIcon, PlusIcon } from './icons.js';

const INPUT =
  'block h-12 w-full rounded-button border border-line bg-panel px-4 font-sans text-[16px] text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-faint enabled:hover:border-fg/40 focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] disabled:cursor-not-allowed disabled:bg-[#f7f7f6] disabled:text-faint';

/** A labelled text input. The hint under it turns red when the value is outside what it allows. */
export function TextField({
  label,
  hint,
  invalid = false,
  className = '',
  ...rest
}: Omit<ComponentProps<'input'>, 'className'> & {
  label: string;
  hint?: string;
  invalid?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="block font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-muted">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`${INPUT} mt-2`}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-hint`} className={`mt-2 text-[13px] leading-[1.4] ${invalid ? 'text-refused' : 'text-faint'}`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** An on/off switch, 44px wide. The caller says what the two states mean through its label. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group relative h-6 w-11 shrink-0 rounded-full border border-line bg-[#dedfdf] transition-[background-color,border-color] duration-[160ms] ease-out hover:border-fg/60 disabled:cursor-not-allowed disabled:opacity-60 aria-checked:border-accent aria-checked:bg-accent"
    >
      <span
        aria-hidden="true"
        className="absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(26,26,26,0.2)] transition-[translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-aria-checked:translate-x-5"
      />
    </button>
  );
}

/** A whole number with a minus and a plus button, 40px each, and the number large between them. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
}) {
  const side =
    'grid h-10 w-10 place-items-center rounded-button border border-line bg-panel text-fg transition-[border-color] duration-[160ms] ease-out enabled:hover:border-fg disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-3">
      <button type="button" aria-label="One less" disabled={value <= min} onClick={() => onChange(value - 1)} className={side}>
        <MinusIcon />
      </button>
      <span aria-live="polite" className="w-12 text-center font-display text-[28px] font-medium leading-none tabular-nums text-fg">
        {value}
      </span>
      <button type="button" aria-label="One more" disabled={value >= max} onClick={() => onChange(value + 1)} className={side}>
        <PlusIcon />
      </button>
    </div>
  );
}

/** A slider with its ends named. The value is shown beside the label by the caller. */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  low,
  high,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  label: string;
  low: string;
  high: string;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Math.round(Number(event.target.value) * 100) / 100)}
        className="app-range"
        style={{ '--fill': fill } as CSSProperties}
      />
      <div className="mt-1 flex justify-between">
        <span className="font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-muted">{low}</span>
        <span className="font-mono text-[12px] font-medium uppercase tracking-[0.06em] text-muted">{high}</span>
      </div>
    </div>
  );
}
