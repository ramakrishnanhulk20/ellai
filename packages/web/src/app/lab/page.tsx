import { notFound } from 'next/navigation';
import { HomePage } from '../../ui/site/HomePage.js';

export const metadata = {
  robots: { index: false, follow: false },
};

// The lab is for reviewing visual changes on a local dev server; the live site has no use for it.
export default function LabPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <HomePage />;
}
