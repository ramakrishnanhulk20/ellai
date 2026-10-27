// The web package resolves modules the strict Node way, which cannot find these two entry
// points. Importing anything from the bare 'next' types is avoided on purpose: they make
// process.env.NODE_ENV read-only and break the prove scripts.
declare module 'next/font/google' {
  export * from 'next/dist/compiled/@next/font/dist/google/index.js';
}

declare module 'geist/font/sans' {
  import type { NextFontWithVariable } from 'next/dist/compiled/@next/font/dist/types.js';
  export const GeistSans: NextFontWithVariable;
}

declare module 'geist/font/mono' {
  import type { NextFontWithVariable } from 'next/dist/compiled/@next/font/dist/types.js';
  export const GeistMono: NextFontWithVariable;
}

declare module '*.css';
