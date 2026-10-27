'use client';

import { useEffect, useState } from 'react';

const SWATCHES = [
  { name: 'lime', value: '#C8FF3D' },
  { name: 'ember', value: '#FF6A2B' },
  { name: 'ice', value: '#7CF3FF' },
] as const;

const STORAGE_KEY = 'ellai-lab-accent';

// The chosen swatch keeps this ring, also while hovered.
const SELECTED_RING = 'shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--fg)]';

function paint(value: string) {
  document.documentElement.style.setProperty('--accent', value);
}

/** Lab only: tries the three accent colours on the whole page. The choice survives a reload. */
export function AccentSwitcher() {
  const [current, setCurrent] = useState<string>(SWATCHES[0].value);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && SWATCHES.some((swatch) => swatch.value === saved)) {
        setCurrent(saved);
        paint(saved);
      }
    } catch {
      // Storage can be blocked; the page then simply starts on lime each time.
    }
  }, []);

  function choose(value: string) {
    setCurrent(value);
    paint(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Storage can be blocked; the choice still applies for this visit.
    }
  }

  return (
    <div
      role="group"
      aria-label="Accent colour"
      className="fixed right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-2 rounded-button border border-line bg-[rgba(8,9,10,0.72)] p-2 backdrop-blur-[12px]"
    >
      {SWATCHES.map((swatch) => (
        <button
          key={swatch.name}
          type="button"
          aria-label={`Accent ${swatch.name}`}
          aria-pressed={current === swatch.value}
          onClick={() => choose(swatch.value)}
          style={{ backgroundColor: swatch.value }}
          className={`size-5 rounded-button transition-[scale,box-shadow] duration-[160ms] ease-out hover:scale-115 focus-visible:scale-115 ${
            current === swatch.value
              ? SELECTED_RING
              : 'hover:shadow-[0_0_0_1px_var(--fg)] focus-visible:shadow-[0_0_0_1px_var(--fg)]'
          }`}
        />
      ))}
    </div>
  );
}
