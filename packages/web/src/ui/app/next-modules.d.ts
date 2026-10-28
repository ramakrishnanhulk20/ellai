// The web package resolves modules the strict Node way, which cannot find Next's extensionless
// entry points. These two point at the real type files so the /app screens can use client-side links.
// Next ships CommonJS type files, so the component sits one level down from the default import.
declare module 'next/link' {
  import type LinkModule from 'next/dist/client/link.js';
  const Link: (typeof LinkModule)['default'];
  export default Link;
}

declare module 'next/navigation' {
  export { usePathname } from 'next/dist/client/components/navigation.js';
}
