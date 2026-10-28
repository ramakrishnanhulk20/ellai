import { Landing } from '../ui/Landing.js';

export const metadata = {
  title: 'Ellai: let your AI agent pay for things',
  description:
    'Ellai lets your AI agent pay for things on Sui and learns when to ask you. Every answer is a memory on Walrus.',
};

export default function HomePage() {
  return <Landing withSwitcher={false} />;
}
