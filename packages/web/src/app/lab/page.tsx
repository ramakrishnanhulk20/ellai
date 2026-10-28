import { notFound } from 'next/navigation';
import { Landing } from '../../ui/Landing.js';

export const metadata = {
  robots: { index: false, follow: false },
};

// The lab is where Ram reviews visual changes on his own dev server; the live site has no use for it.
export default function LabPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Landing withSwitcher />;
}
