import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { source } from '../../lib/source.js';
import { DocsTopBar } from '../../ui/docs/DocsTopBar.js';
import 'fumadocs-ui/style.css';
import '../../ui/docs/docs.css';

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <div className="ellai-docs">
      {/* The theme switch is off because the docs are dark only. Search reads the index file the build writes. */}
      <RootProvider theme={{ enabled: false }} search={{ options: { type: 'static', api: '/docs/search-index' } }}>
        <DocsTopBar />
        <DocsLayout
          tree={source.getPageTree()}
          nav={{ title: <span className="ellai-sidebar-title">Ellai docs</span>, url: '/docs' }}
          themeSwitch={{ enabled: false }}
        >
          {children}
        </DocsLayout>
      </RootProvider>
    </div>
  );
}
