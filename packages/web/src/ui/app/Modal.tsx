'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over a dimmed, blurred page: centred on wide screens, a bottom sheet on small ones.
 * Focus stays inside it. Escape calls onEscape when one is given; a click on the backdrop does
 * nothing, so a stray click can never throw away what the dialog is showing. It is drawn straight
 * into the page body because the page content sits inside an animated, transformed box, which
 * would otherwise become the frame a fixed overlay measures itself against.
 */
export function Modal({
  title,
  onEscape,
  children,
}: {
  title: string;
  onEscape?: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (escape.current) {
          event.preventDefault();
          escape.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.current.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 max-md:items-end max-md:p-0">
      <div
        aria-hidden="true"
        className="dialog-backdrop absolute inset-0 bg-[rgba(0,0,0,0.6)] backdrop-blur-[4px]"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="dialog-panel relative max-h-[calc(100svh-32px)] w-full max-w-[480px] overflow-y-auto rounded-panel border border-line bg-panel p-6 outline-none max-md:max-h-[92svh] max-md:max-w-none max-md:rounded-b-none max-md:pb-[calc(24px+env(safe-area-inset-bottom))]"
      >
        <h2 id={titleId} className="font-display text-[24px] font-medium leading-[1.2] text-fg">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
