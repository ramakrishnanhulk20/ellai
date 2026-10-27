import { EllaiMark } from './EllaiMark.js';
import { Statement } from './Statement.js';

export function TopBar() {
  return (
    <header className="enter-fade top-bar fixed inset-x-0 top-0 z-20 flex h-[60px] items-center justify-between px-4 md:h-[104px] md:px-8">
      <div className="flex items-center gap-[10px]">
        <EllaiMark />
        <span className="font-display text-[18px] font-semibold tracking-[0.08em] text-fg">ELLAI</span>
      </div>

      <Statement className="absolute left-[33.333%] top-1/2 hidden max-w-[420px] -translate-y-1/2 text-[22px] font-normal leading-[1.2] text-fg lg:block" />

      <nav className="flex items-center gap-2">
        <a
          href="/docs"
          className="label-mono hidden h-10 items-center rounded-button border border-line px-4 text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)] md:inline-flex"
        >
          Docs
        </a>
        <a
          href="/app"
          className="label-mono inline-flex h-10 items-center rounded-button bg-accent px-4 text-accent-ink transition-[translate,box-shadow] duration-[160ms] ease-out hover:-translate-y-px hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_24%,transparent)]"
        >
          Open Ellai
        </a>
      </nav>
    </header>
  );
}
