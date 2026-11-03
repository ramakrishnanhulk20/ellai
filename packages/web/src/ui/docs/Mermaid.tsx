'use client';

import { useEffect, useId, useState } from 'react';

type Drawn = { status: 'drawing' } | { status: 'done'; svg: string } | { status: 'failed' };

// One drawing per diagram source, kept for the life of the page. React runs effects twice in development
// and again when a reader comes back to a page, and the second visit should not draw the diagram again.
const drawings = new Map<string, Promise<string>>();
let configured = false;

// A dropped connection can leave the diagram library half downloaded and never finished. After this long
// the reader gets the diagram source as text instead of an empty box.
const DRAW_LIMIT_MS = 15_000;

async function draw(chart: string, id: string): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  if (!configured) {
    // The page already loaded Space Grotesk through next/font under a generated family name. Reading it back from the
    // body lets the diagram measure and show its words in the real font instead of a fallback.
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily || '"Space Grotesk", ui-sans-serif, sans-serif';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // On wide screens diagrams keep their real size and scroll inside their own box, because shrunk to the column the wide ones are too small to read. On phones the stylesheet fits them to the width instead.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      theme: 'base',
      themeVariables: {
        background: '#ffffff',
        primaryColor: '#f7f7f6',
        primaryBorderColor: '#dedfdf',
        primaryTextColor: '#1a1a1a',
        secondaryColor: '#eef1ff',
        secondaryBorderColor: '#dedfdf',
        secondaryTextColor: '#1a1a1a',
        tertiaryColor: '#ffffff',
        tertiaryBorderColor: '#dedfdf',
        tertiaryTextColor: '#656b6b',
        lineColor: '#656b6b',
        textColor: '#1a1a1a',
        mainBkg: '#f7f7f6',
        nodeBorder: '#4a63ff',
        clusterBkg: '#ffffff',
        clusterBorder: '#dedfdf',
        edgeLabelBackground: '#ffffff',
        noteBkgColor: '#f7f7f6',
        noteBorderColor: '#dedfdf',
        noteTextColor: '#1a1a1a',
        actorBkg: '#f7f7f6',
        actorBorder: '#4a63ff',
        actorTextColor: '#1a1a1a',
        actorLineColor: '#a7aaaa',
        signalColor: '#656b6b',
        signalTextColor: '#1a1a1a',
        labelBoxBkgColor: '#f7f7f6',
        labelBoxBorderColor: '#dedfdf',
        labelTextColor: '#1a1a1a',
        loopTextColor: '#1a1a1a',
        activationBkgColor: '#f7f7f6',
        activationBorderColor: '#4a63ff',
        sequenceNumberColor: '#ffffff',
        fontFamily: family,
        fontSize: '14px',
      },
    });
    configured = true;
  }
  const { svg } = await mermaid.render(`mermaid-${id}`, chart);
  return svg;
}

function drawWithinLimit(chart: string, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The diagram took too long to draw')), DRAW_LIMIT_MS);
    draw(chart, id)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** Draws one mermaid diagram in the browser. If drawing fails the reader sees the diagram source as plain text. */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [drawn, setDrawn] = useState<Drawn>({ status: 'drawing' });

  useEffect(() => {
    let current = true;
    let pending = drawings.get(chart);
    if (!pending) {
      pending = drawWithinLimit(chart, id);
      drawings.set(chart, pending);
    }
    pending.then(
      (svg) => {
        if (current) setDrawn({ status: 'done', svg });
      },
      () => {
        drawings.delete(chart);
        if (current) setDrawn({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [chart, id]);

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
