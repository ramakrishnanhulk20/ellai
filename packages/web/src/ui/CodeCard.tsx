'use client';

import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { AGENT_KEY_PLACEHOLDER, SNIPPETS, type SnippetId } from './agent-snippets.js';

const COPIED_MS = 1500;

function subscribeNever(): () => void {
  return () => {};
}

/** The address of the page the visitor is on. The server render has none, so the snippet starts without it. */
function useOrigin(): string {
  return useSyncExternalStore(subscribeNever, () => window.location.origin, () => '');
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.5 3.5v-.25A1.75 1.75 0 0 0 8.75 1.5h-5A1.75 1.75 0 0 0 2 3.25v5A1.75 1.75 0 0 0 3.75 10H4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-accent">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The key placeholder is picked out in the accent colour so it is clear what to replace.
function highlight(text: string) {
  const parts = text.split(AGENT_KEY_PLACEHOLDER);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? <span className="text-accent">{AGENT_KEY_PLACEHOLDER}</span> : null}
    </Fragment>
  ));
}

/** Three ways to connect an agent, one tab each, with a copy button. Long lines scroll inside the card. */
export function CodeCard() {
  const origin = useOrigin();
  const baseId = useId();
  const [active, setActive] = useState<SnippetId>('code');
  const [copied, setCopied] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const code = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const snippet = SNIPPETS.find((entry) => entry.id === active) ?? SNIPPETS[0];
  if (!snippet) return null;
  const text = snippet.build(origin);

  function choose(index: number) {
    const next = SNIPPETS[(index + SNIPPETS.length) % SNIPPETS.length];
    if (!next) return;
    setActive(next.id);
    setCopied(false);
    tabs.current[(index + SNIPPETS.length) % SNIPPETS.length]?.focus();
  }

  function onTabKey(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight') choose(index + 1);
    else if (event.key === 'ArrowLeft') choose(index - 1);
    else if (event.key === 'Home') choose(0);
    else if (event.key === 'End') choose(SNIPPETS.length - 1);
    else return;
    event.preventDefault();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Without clipboard access (an insecure page, a blocked permission) the code is selected so Ctrl+C finishes the job.
      const node = code.current;
      if (node) window.getSelection()?.selectAllChildren(node);
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div className="min-w-0 rounded-[16px] border border-line bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-line pr-1.5">
        <div role="tablist" aria-label="How to connect" className="flex h-10 min-w-0 overflow-x-auto [scrollbar-width:none]">
          {SNIPPETS.map((entry, index) => {
            const selected = entry.id === active;
            return (
              <button
                key={entry.id}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${entry.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  setActive(entry.id);
                  setCopied(false);
                }}
                onKeyDown={(event) => onTabKey(event, index)}
                className={`label-mono h-full shrink-0 border-b-2 px-1.5 transition-colors duration-[160ms] ease-out focus-visible:outline-offset-[-2px] sm:px-2 md:px-4 ${
                  selected ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
                }`}
              >
                {entry.tab}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy to clipboard"
          className="label-mono inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-2 rounded-button border border-line px-[7px] text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)]"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? <span>Copied</span> : null}
        </button>
        <span role="status" className="sr-only">
          {copied ? 'Copied to clipboard' : ''}
        </span>
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${snippet.id}`}>
        <pre
          ref={code}
          role="region"
          aria-label="Code, scrolls sideways"
          tabIndex={0}
          className="overflow-x-auto p-6 font-mono text-[14px] leading-[1.6] whitespace-pre text-fg [scrollbar-color:rgba(242,242,238,0.24)_transparent] [scrollbar-width:thin]"
        >
          <code>{highlight(text)}</code>
        </pre>
      </div>
    </div>
  );
}
