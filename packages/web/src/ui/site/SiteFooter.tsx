import Link from 'next/link';
import { EllaiMark } from '../EllaiMark.js';

/** The last dark band. It runs on from the closing poster, split from it by one thin rule. */
export function SiteFooter() {
  return (
    <footer className="bg-night text-night-fg [--focus:#F4F2EC]">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="border-t border-night-fg/[0.14] pb-10 pt-12">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_auto_1fr] md:items-start">
            <div>
              <Link href="/" aria-label="Ellai home" className="site-logo flex w-fit items-center gap-[10px]">
                <EllaiMark />
                <span className="font-grotesk text-[15px] font-bold tracking-[0.08em]">ELLAI</span>
              </Link>
              <p className="mt-3 text-sm leading-[1.5] text-night-fg/[0.56]">Ellai means limit in Tamil.</p>
            </div>

            <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-3 font-grotesk text-[15px] font-medium">
              <Link href="/app" className="nav-sweep">
                App
              </Link>
              <Link href="/proof" className="nav-sweep">
                Proof
              </Link>
              <Link href="/docs" className="nav-sweep">
                Docs
              </Link>
              <a
                href="https://github.com/ramakrishnanhulk20/ellai"
                target="_blank"
                rel="noopener"
                className="nav-sweep"
              >
                GitHub
              </a>
            </nav>

            <p className="font-plex text-xs font-medium uppercase leading-[1.7] tracking-[0.06em] text-night-fg/50 md:text-right">
              <span className="block">Built for Total Recall</span>
              <span className="block">
                Tatum <span className="normal-case">x</span> Walrus
              </span>
            </p>
          </div>

          <p className="mt-10 font-plex text-[11px] uppercase tracking-[0.06em] text-night-fg/[0.36]">
            Walrus Memory / Tatum Sui RPC / Sui Mainnet / <span className="normal-case">x402</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
