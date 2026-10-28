'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AGENT_KEY_PLACEHOLDER, SNIPPETS, type SnippetId } from '../agent-snippets.js';
import { CheckIcon, CopyIcon } from './icons.js';
import { Modal } from './Modal.js';
import { Button } from './ui.js';

const COPIED_MS = 1500;

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    return true;
  }

  return { copied, copy, reset: () => setCopied(false) };
}

const COPY_BUTTON =
  'label-mono inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-2 rounded-button border border-line px-[7px] text-fg transition-[border-color,background-color] duration-[160ms] ease-out hover:border-fg hover:bg-[rgba(242,242,238,0.06)]';

function CopyLabelButton({ copied, onClick, label }: { copied: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={COPY_BUTTON}>
      {copied ? <CheckIcon className="text-accent" /> : <CopyIcon />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function TokenBlock({ token }: { token: string }) {
  const { copied, copy } = useCopy(token);
  return (
    <div className="flex items-start justify-between gap-3 rounded-button border border-line bg-bg p-3">
      <p className="min-w-0 break-all font-mono text-[15px] leading-[1.5] text-fg">{token}</p>
      <CopyLabelButton copied={copied} onClick={() => void copy()} label="Copy the agent key" />
    </div>
  );
}

/** The three ways to connect, from the landing page, with this key in place of the placeholder and this site's address. */
function ConnectTabs({ token }: { token: string }) {
  const baseId = useId();
  const [active, setActive] = useState<SnippetId>('code');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const snippet = SNIPPETS.find((entry) => entry.id === active) ?? SNIPPETS[0];
  const text = snippet ? snippet.build(window.location.origin).replaceAll(AGENT_KEY_PLACEHOLDER, token) : '';
  const { copied, copy, reset } = useCopy(text);
  const code = useRef<HTMLPreElement>(null);

  if (!snippet) return null;

  function choose(index: number) {
    const count = SNIPPETS.length;
    const wrapped = (index + count) % count;
    const next = SNIPPETS[wrapped];
    if (!next) return;
    setActive(next.id);
    reset();
    tabs.current[wrapped]?.focus();
  }

  function onTabKey(event: KeyboardEvent, index: number) {
    if (event.key === 'ArrowRight') choose(index + 1);
    else if (event.key === 'ArrowLeft') choose(index - 1);
    else if (event.key === 'Home') choose(0);
    else if (event.key === 'End') choose(SNIPPETS.length - 1);
    else return;
    event.preventDefault();
  }

  async function copyCode() {
    const done = await copy();
    // Without clipboard access the code is selected, so Ctrl+C finishes the job.
    if (!done && code.current) window.getSelection()?.selectAllChildren(code.current);
  }

  return (
    <div className="min-w-0 rounded-button border border-line bg-bg">
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
                  reset();
                }}
                onKeyDown={(event) => onTabKey(event, index)}
                className={`label-mono h-full shrink-0 border-b-2 px-2 transition-colors duration-[160ms] ease-out focus-visible:outline-offset-[-2px] ${
                  selected ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
                }`}
              >
                {entry.tab}
              </button>
            );
          })}
        </div>
        <CopyLabelButton copied={copied} onClick={() => void copyCode()} label="Copy this code" />
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${snippet.id}`}>
        <pre
          ref={code}
          role="region"
          aria-label="Code, scrolls sideways"
          tabIndex={0}
          className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.6] whitespace-pre text-fg"
        >
          <code>{text}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Shows a new agent key once. The key lives only in the props of this dialog: it is never put in
 * the cache, local storage or the address, and closing the dialog lets the screen drop it. Neither
 * Escape nor a click outside closes it, because a key closed unseen is lost for good.
 */
export function KeyDialog({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <Modal title="Your agent key">
      <div className="mt-4 flex flex-col gap-4">
        <TokenBlock token={token} />
        <ConnectTabs token={token} />
        <p className="rounded-button border border-asked p-3 text-[14px] leading-[1.5] text-fg">
          Ellai shows this key once. Put it in your agent now. If you lose it, revoke it and create another.
        </p>
        <Button variant="primary" size="lg" full onClick={onClose}>
          I&apos;ve saved it
        </Button>
      </div>
    </Modal>
  );
}
