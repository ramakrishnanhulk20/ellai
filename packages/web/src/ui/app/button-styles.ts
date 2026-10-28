// Class lists shared by the button and by the links that look like buttons.
export type Variant = 'primary' | 'ghost' | 'refuse' | 'danger' | 'text';

export const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-button font-sans text-[15px] font-medium leading-none whitespace-nowrap transition-[translate,box-shadow,background-color,border-color,color,opacity] duration-[160ms] ease-out disabled:cursor-not-allowed disabled:opacity-40';

export const BUTTON_VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent px-4 text-accent-ink enabled:hover:-translate-y-px enabled:hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_24%,transparent)]',
  ghost: 'border border-line px-4 text-fg enabled:hover:border-fg enabled:hover:bg-[rgba(242,242,238,0.06)]',
  refuse:
    'border border-refused/40 px-4 text-refused enabled:hover:border-refused enabled:hover:bg-refused/10',
  danger: 'border border-line px-4 text-refused enabled:hover:border-refused enabled:hover:bg-refused/10',
  text: 'app-underline px-0 text-muted enabled:hover:text-fg',
};

// A link cannot be disabled, so these use plain hover rather than the enabled-only hover of a button.
export const LINK_VARIANT: Record<'primary' | 'ghost' | 'text', string> = {
  primary:
    'bg-accent px-4 text-accent-ink hover:-translate-y-px hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_24%,transparent)]',
  ghost: 'border border-line px-4 text-fg hover:border-fg hover:bg-[rgba(242,242,238,0.06)]',
  text: 'app-underline px-0 text-fg',
};
