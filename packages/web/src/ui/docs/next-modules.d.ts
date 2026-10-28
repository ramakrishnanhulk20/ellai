// Adds the not-found call to the narrow next/navigation typing in src/ui/app/next-modules.d.ts,
// which only exposes usePathname. Same reason: the strict Node module rules cannot find Next's entry point.
declare module 'next/navigation' {
  export { notFound } from 'next/dist/client/components/not-found.js';
}
