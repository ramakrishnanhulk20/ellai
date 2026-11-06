'use client';

import { useEffect, useId, useState } from 'react';
import { currentTheme, type Theme } from '../site/theme.js';

type Drawn = { status: 'drawing' } | { status: 'done'; svg: string } | { status: 'failed' };

// One drawing per diagram source and mode, kept for the life of the page. React runs effects twice in development
// and again when a reader comes back to a page, and the second visit should not draw the diagram again.
const drawings = new Map<string, Promise<string>>();
let configuredFor: Theme | null = null;
// The library keeps one global setting, so draws run one after another: a draw for one mode never meets the setting of the other.
let queue: Promise<unknown> = Promise.resolve();

// A dropped connection can leave the diagram library half downloaded and never finished. After this long
// the reader gets the diagram source as text instead of an empty box.
const DRAW_LIMIT_MS = 15_000;

// Each diagram colour and the page token it reads. The tokens hold the colours of whichever mode is showing, so the
// diagram always matches the page. The library does maths on these colours, so it needs real values, not var() text.
const DIAGRAM_COLOURS = {
  background: '--paper',
  primaryColor: '--color-fd-card',
  primaryBorderColor: '--mist',
  primaryTextColor: '--ink',
  secondaryColor: '--accent-wash',
  secondaryBorderColor: '--mist',
  secondaryTextColor: '--ink',
  tertiaryColor: '--paper',
  tertiaryBorderColor: '--mist',
  tertiaryTextColor: '--ink-soft',
  lineColor: '--ink-soft',
  textColor: '--ink',
  mainBkg: '--color-fd-card',
  nodeBorder: '--accent',
  clusterBkg: '--paper',
  clusterBorder: '--mist',
  edgeLabelBackground: '--paper',
  noteBkgColor: '--color-fd-card',
  noteBorderColor: '--mist',
  noteTextColor: '--ink',
  actorBkg: '--color-fd-card',
  actorBorder: '--accent',
  actorTextColor: '--ink',
  actorLineColor: '--ink-faint',
  signalColor: '--ink-soft',
  signalTextColor: '--ink',
  labelBoxBkgColor: '--color-fd-card',
  labelBoxBorderColor: '--mist',
  labelTextColor: '--ink',
  loopTextColor: '--ink',
  activationBkgColor: '--color-fd-card',
  activationBorderColor: '--accent',
  sequenceNumberColor: '--accent-ink',
} as const;

function diagramColours(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const colours: Record<string, string> = {};
  for (const [name, token] of Object.entries(DIAGRAM_COLOURS)) {
    const value = root.getPropertyValue(token).trim();
    if (value !== '') colours[name] = value;
  }
  return colours;
}

async function draw(chart: string, id: string, mode: Theme): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  if (configuredFor !== mode) {
    // The page already loaded Space Grotesk through next/font under a generated family name. Reading it back from the
    // body lets the diagram measure and show its words in the real font instead of a fallback.
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily || '"Space Grotesk", ui-sans-serif, sans-serif';
    // A quick double switch can leave this draw behind the page; the colours would then be for the wrong mode.
    if (currentTheme() !== mode) throw new Error('The mode changed before the diagram was drawn');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // The library draws each diagram at a fixed size. The stylesheet scales it to the box from 1024px up and on phones, and between those widths it keeps its size and scrolls inside the box. The sequence diagram is drawn tighter so the scaled text stays readable.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false, width: 120, actorMargin: 24 },
      theme: 'base',
      themeVariables: {
        ...diagramColours(),
        fontFamily: family,
        fontSize: '14px',
      },
    });
    configuredFor = mode;
  }
  const { svg } = await mermaid.render(`mermaid-${id}-${mode}`, chart);
  return svg;
}

function drawWithinLimit(chart: string, id: string, mode: Theme): Promise<string> {
  const turn = queue.then(() => draw(chart, id, mode));
  queue = turn.catch(() => undefined);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The diagram took too long to draw')), DRAW_LIMIT_MS);
    turn.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Draws one mermaid diagram in the browser. If drawing fails the reader sees the diagram source as plain text. */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [drawn, setDrawn] = useState<Drawn>({ status: 'drawing' });
  const [mode, setMode] = useState<Theme | null>(null);

  // The mode is read on the client only, so the server markup and the first client render match. When the
  // reader switches mode the page changes data-theme on <html>, and the diagram is drawn again in the new colours.
  useEffect(() => {
    setMode(currentTheme());
    const watcher = new MutationObserver(() => setMode(currentTheme()));
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watcher.disconnect();
  }, []);

  // The old drawing stays on show until the new one is ready, so a switch never blanks the box.
  useEffect(() => {
    if (mode === null) return;
    let current = true;
    const key = `${mode}
${chart}`;
    let pending = drawings.get(key);
    if (!pending) {
      pending = drawWithinLimit(chart, id, mode);
      drawings.set(key, pending);
    }
    pending.then(
      (svg) => {
        if (current) setDrawn({ status: 'done', svg });
      },
      () => {
        drawings.delete(key);
        if (current) setDrawn({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [chart, id, mode]);

  if (drawn.status === 'failed') {
    return <pre className="ellai-mermaid-source">{chart}</pre>;
  }

  return (
    <figure
      className="ellai-mermaid"
      aria-busy={drawn.status === 'drawing'}
      {...(drawn.status === 'done' ? { tabIndex: 0, role: 'region', 'aria-label': 'Diagram' } : {})}
    >
      {drawn.status === 'done' ? (
        <>
          <div className="ellai-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
          <figcaption className="ellai-mermaid-hint">Pinch to zoom</figcaption>
        </>
      ) : (
        <noscript>
          <pre className="ellai-mermaid-source">{chart}</pre>
        </noscript>
      )}
    </figure>
  );
}
