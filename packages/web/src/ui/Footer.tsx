import { EllaiMark } from './EllaiMark.js';

const LINK =
  'label-mono link-draw text-muted transition-colors duration-[160ms] ease-out hover:text-fg focus-visible:text-fg';

/** The page foot: the name and its meaning, the four links, and what this was built for. */
export function Footer() {
  return (
    <footer className="border-t border-line px-4 py-12 md:px-8">
      <div className="flex flex-col gap-10 md:grid md:grid-cols-[1fr_auto_1fr] md:items-start md:gap-8">
        <div>
          <div className="flex items-center gap-[10px]">
            <EllaiMark />
            <span className="label-mono text-muted">ELLAI</span>
          </div>
          <p className="mt-3 text-[14px] leading-[1.5] text-muted">Ellai means limit in Tamil.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3">
          <a href="/docs" className={LINK}>
            Docs
          </a>
          <a href="/proof" className={LINK}>
            Proof
          </a>
          <a href="/app" className={LINK}>
            App
          </a>
          <a href="https://github.com/ramakrishnanhulk20/ellai" target="_blank" rel="noopener" className={LINK}>
            GitHub
          </a>
        </nav>
        <p className="label-mono text-muted md:justify-self-end md:text-right">BUILT FOR TOTAL RECALL / TATUM X WALRUS</p>
      </div>
    </footer>
  );
}
