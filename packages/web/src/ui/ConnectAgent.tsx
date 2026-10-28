import { CodeCard } from './CodeCard.js';
import { Reveal } from './Reveal.js';
import { Accent, Headline, Line, Paragraph, SectionLabel } from './SectionParts.js';

const RESULTS = [
  { tone: 'bg-paid', text: "Paid: the seller's answer comes back to the agent." },
  { tone: 'bg-asked', text: 'Asked: the agent gets a decision id and checks back after you answer.' },
  { tone: 'bg-refused', text: "Refused: the agent gets Ellai's reason." },
] as const;

/** Section 8. How an agent connects: the three outcomes on the left, the code to paste on the right. */
export function ConnectAgent() {
  return (
    <section aria-labelledby="connect-heading" className="mt-24 px-4 md:px-8 lg:mt-40">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,45fr)_minmax(0,55fr)] lg:items-start lg:gap-16">
        <div>
          <Reveal>
            <SectionLabel>08 / CONNECT YOUR AGENT</SectionLabel>
            <Headline id="connect-heading">
              <Line>Any agent.</Line>
              <Line>
                <Accent>One tool.</Accent>
              </Line>
            </Headline>
          </Reveal>
          <Reveal index={1} className="mt-6">
            <Paragraph>
              Give your agent its own key in Ellai. It calls one tool, paid_fetch, with a URL and a plain reason.
              Ellai pays, refuses, or asks you first, and the agent never holds your money.
            </Paragraph>
          </Reveal>
          <ul className="mt-10 space-y-4">
            {RESULTS.map((result, index) => (
              <li key={result.tone}>
                <Reveal index={index + 2} className="flex items-start gap-3 text-[15px] leading-[1.5] text-fg">
                  <span aria-hidden="true" className={`mt-[6px] size-[10px] shrink-0 rounded-full ${result.tone}`} />
                  <span>{result.text}</span>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
        <Reveal index={2} className="min-w-0">
          <CodeCard />
          <p className="label-mono mt-4 text-muted">GET YOUR AGENT KEY IN ELLAI UNDER AGENTS. IT IS SHOWN ONCE.</p>
        </Reveal>
      </div>
    </section>
  );
}
