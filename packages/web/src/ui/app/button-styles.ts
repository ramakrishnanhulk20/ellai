// Class lists shared by the button and by the links that look like buttons.
export type Variant = 'primary' | 'ghost' | 'refuse' | 'danger' | 'text';

export const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-button font-sans text-[15px] font-medium leading-none whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-[160ms] ease-out disabled:cursor-not-allowed disabled:opacity-40';

export const BUTTON_VARIANT: Record<Variant, string> = {
  primary: 'bg-accent px-4 text-accent-ink enabled:hover:bg-[#3049e8]',
  ghost: 'border border-line bg-panel px-4 text-fg enabled:hover:border-fg',
  refuse:
    'border border-[color-mix(in_srgb,var(--refused)_40%,transparent)] bg-panel px-4 text-refused enabled:hover:border-refused enabled:hover:bg-[#fdeceb]',
  danger: 'border border-line bg-panel px-4 text-refused enabled:hover:border-refused enabled:hover:bg-[#fdeceb]',
  text: 'app-underline px-0 text-muted enabled:hover:text-fg',
};

// A link cannot be disabled, so these use plain hover rather than the enabled-only hover of a button.
export const LINK_VARIANT: Record<'primary' | 'ghost' | 'text', string> = {
  primary: 'bg-accent px-4 text-accent-ink hover:bg-[#3049e8]',
  ghost: 'border border-line bg-panel px-4 text-fg hover:border-fg',
  text: 'app-underline px-0 text-fg',
};
