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
    // The page already loaded Geist through next/font under a generated family name. Reading it back from the
    // body lets the diagram measure and show its words in the real font instead of a fallback.
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily || 'Geist, sans-serif';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Diagrams keep their real size and scroll inside their own box. Shrunk to the column, the wide ones are too small to read.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      theme: 'base',
      themeVariables: {
        background: '#0D0F11',
        primaryColor: '#0D0F11',
        primaryBorderColor: '#C8FF3D',
        primaryTextColor: '#F2F2EE',
        secondaryColor: '#0D0F11',
        secondaryBorderColor: 'rgba(242,242,238,0.32)',
        secondaryTextColor: '#F2F2EE',
        tertiaryColor: '#08090A',
        tertiaryBorderColor: 'rgba(242,242,238,0.32)',
        tertiaryTextColor: 'rgba(242,242,238,0.56)',
        lineColor: 'rgba(242,242,238,0.56)',
        textColor: '#F2F2EE',
        mainBkg: '#0D0F11',
        nodeBorder: '#C8FF3D',
        clusterBkg: '#08090A',
        clusterBorder: 'rgba(242,242,238,0.32)',
        edgeLabelBackground: '#0D0F11',
        noteBkgColor: '#0D0F11',
        noteBorderColor: 'rgba(242,242,238,0.32)',
        noteTextColor: '#F2F2EE',
        actorBkg: '#0D0F11',
        actorBorder: '#C8FF3D',
        actorTextColor: '#F2F2EE',
        actorLineColor: 'rgba(242,242,238,0.32)',
        signalColor: 'rgba(242,242,238,0.56)',
        signalTextColor: '#F2F2EE',
        labelBoxBkgColor: '#0D0F11',
        labelBoxBorderColor: 'rgba(242,242,238,0.32)',
        labelTextColor: '#F2F2EE',
        loopTextColor: '#F2F2EE',
        activationBkgColor: '#0D0F11',
        activationBorderColor: '#C8FF3D',
        sequenceNumberColor: '#08090A',
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
      {...(drawn.status === 'done' ? { tabIndex: 0, role: 'region', 'aria-label': 'Diagram, scrolls sideways' } : {})}
    >
      {drawn.status === 'done' ? (
        <div className="ellai-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      ) : (
        <noscript>
          <pre className="ellai-mermaid-source">{chart}</pre>
        </noscript>
      )}
    </figure>
  );
}
