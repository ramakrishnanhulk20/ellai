import { Landing } from '../../ui/Landing.js';

export const metadata = {
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return <Landing withSwitcher />;
}
