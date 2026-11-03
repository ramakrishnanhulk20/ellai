import { notFound } from 'next/navigation';
import { AppProviders } from '../../../ui/app/Providers.js';
import { QuestionPreview } from '../../../ui/app/QuestionsScreen.js';
import '../../../ui/app/app.css';

export const metadata = {
  robots: { index: false, follow: false },
};

// The lab is where Ram reviews visual changes on his own dev server; the live site has no use for it.
export default function QuestionPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <AppProviders>
      <div data-site data-app className="min-h-svh p-10">
        <QuestionPreview />
      </div>
    </AppProviders>
  );
}
