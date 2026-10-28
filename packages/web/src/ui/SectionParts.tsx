import type { ReactNode } from 'react';

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="label-mono text-muted">{children}</p>;
}

/** The big two-line headline every landing section uses. Children are the lines, each in its own block. */
export function Headline({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-6 font-display text-[clamp(2.5rem,6vw,6rem)] font-medium leading-none tracking-[-0.02em] text-fg"
    >
      {children}
    </h2>
  );
}

export function Line({ children }: { children: ReactNode }) {
  return <span className="block">{children}</span>;
}

export function Accent({ children }: { children: ReactNode }) {
  return <span className="text-accent">{children}</span>;
}

export function Paragraph({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`max-w-[520px] text-[18px] leading-[1.5] text-muted ${className}`}>{children}</p>;
}
