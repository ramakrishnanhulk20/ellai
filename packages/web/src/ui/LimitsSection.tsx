import { LimitsDiagram } from './LimitsDiagram.js';
import { Reveal } from './Reveal.js';
import { Accent, Headline, Line, Paragraph, SectionLabel } from './SectionParts.js';

const FACTS = [
  { label: 'DAILY LIMIT', text: 'You choose it. Sui enforces it, not Ellai.' },
  { label: 'CAP AND END DATE', text: 'The allowance stops at your total cap or your end date, whichever comes first.' },
  { label: 'THE PURSE', text: "At most 0.20 USDC sits ready to pay at any time. Sui's limits cap everything else." },
  { label: 'END IT ANY TIME', text: 'One signature in your wallet ends the allowance. Your purse can draw nothing more from your wallet after that.' },
  {
    label: 'SIGN TO LOOSEN',
    text: "Raising a limit or adding an agent needs your wallet's signature, so a stolen login cannot do either.",
  },
] as const;

/** Section 9. The limits live on Sui: a drawing of wallet, purse and seller, and the five facts behind it. */
export function LimitsSection() {
  return (
    <section aria-labelledby="limits-heading" className="mt-24 px-4 md:px-8 lg:mt-40">
      <Reveal>
        <SectionLabel>09 / YOUR LIMITS, ON SUI</SectionLabel>
        <Headline id="limits-heading">
          <Line>Your money stays</Line>
          <Line>
            in <Accent>your wallet.</Accent>
          </Line>
        </Headline>
      </Reveal>
      <Reveal index={1} className="mt-6">
        <Paragraph>
          Ellai keeps a few cents ready to pay. The rest stays in your own wallet, behind a Sui allowance you set
          and can end with one signature.
        </Paragraph>
      </Reveal>
      <div className="mt-12 grid gap-12 lg:mt-16 lg:grid-cols-[minmax(0,55fr)_minmax(0,45fr)] lg:gap-16">
        <Reveal index={2} className="min-w-0">
          <LimitsDiagram />
        </Reveal>
        <dl className="space-y-6">
          {FACTS.map((fact, index) => (
            <Reveal key={fact.label} index={index + 2}>
              <dt className="label-mono text-accent">{fact.label}</dt>
              <dd className="mt-2 text-[16px] leading-[1.5] text-fg">{fact.text}</dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
