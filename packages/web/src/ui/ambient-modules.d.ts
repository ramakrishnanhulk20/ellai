// The web package resolves modules the strict Node way, which cannot find this entry point.
// Importing anything from the bare 'next' types is avoided on purpose: they make
// process.env.NODE_ENV read-only and break the prove scripts.
declare module 'next/font/google' {
  export * from 'next/dist/compiled/@next/font/dist/google/index.js';
}

declare module '*.css';
