import { EllaiMark } from '../EllaiMark.js';

const LINK =
  'label-mono link-draw text-muted transition-colors duration-[160ms] ease-out hover:text-fg focus-visible:text-fg';

/** The bar above the docs: the mark and name on the left, the other parts of the product on the right. */
export function DocsTopBar() {
  return (
    <header className="ellai-docs-bar sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line px-4 md:px-6">
      <a
        href="/"
        className="flex items-center gap-[10px] transition-opacity duration-[160ms] ease-out hover:opacity-80"
        aria-label="Ellai home"
      >
        <EllaiMark />
        <span className="font-display text-[18px] font-semibold tracking-[0.08em] text-fg">ELLAI</span>
      </a>
      <nav aria-label="Product" className="flex items-center gap-5 md:gap-6">
        <a href="/app" className={LINK}>
          App
        </a>
        <a href="/proof" className={LINK}>
          Proof
        </a>
        <a href="https://github.com/ramakrishnanhulk20/ellai" target="_blank" rel="noopener" className={LINK}>
          GitHub
        </a>
      </nav>
    </header>
  );
}
