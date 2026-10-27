'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { DecisionCard } from './DecisionCard.js';
import { LiveCaption } from './LiveCaption.js';
import { MarkerRow } from './MarkerRow.js';
import type { MapDecision, MapMemory } from './memory-map.js';
import { ParallaxLayer } from './ParallaxLayer.js';
import { REDUCED_REPLAY_SECONDS, REPLAY_SECONDS } from './scene/constants.js';
import { SceneBoundary } from './scene/SceneBoundary.js';
import type { SceneProps } from './scene/SceneCanvas.js';
import { useDecisionCycle } from './scene/useDecisionCycle.js';
import { Statement } from './Statement.js';
import { useMediaQuery, usePrefersReducedMotion } from './useMediaQuery.js';
import { useMemoryMap } from './useMemoryMap.js';
import { useOnScreen } from './useOnScreen.js';

const NO_MEMORIES: MapMemory[] = [];
const NO_DECISIONS: MapDecision[] = [];

/** The scene pulls in three.js, so it loads after the page is up and never on the server. */
function useSceneComponent(): ComponentType<SceneProps> | null {
  const [Scene, setScene] = useState<ComponentType<SceneProps> | null>(null);
  useEffect(() => {
    let alive = true;
    void import('./scene/SceneCanvas.js').then((module) => {
      if (alive) setScene(() => module.SceneCanvas);
    });
    return () => {
      alive = false;
    };
  }, []);
  return Scene;
}

/** The first screen: the scene panel, the marker row, and on small screens the pitch and the card. */
export function Hero() {
  const state = useMemoryMap();
  const reduced = usePrefersReducedMotion();
  const mobile = useMediaQuery('(max-width: 767px)');
  const finePointer = useMediaQuery('(pointer: fine)');
  const Scene = useSceneComponent();
  const panel = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(panel);

  const data = state.status === 'ready' ? state.data : null;
  const memories = data?.memories ?? NO_MEMORIES;
  const active = useDecisionCycle(
    data?.decisions ?? NO_DECISIONS,
    reduced ? REDUCED_REPLAY_SECONDS : REPLAY_SECONDS,
    memories.length > 0,
  );
  const card = active?.decision ?? null;

  return (
    <div className="pt-[72px] md:pt-[120px]">
      <div
        ref={panel}
        className="enter-reveal relative mx-4 h-[max(68svh,420px)] overflow-hidden rounded-panel border border-line bg-panel md:mx-8 md:h-[calc(100svh-120px-56px)]"
      >
        <ParallaxLayer disabled={reduced}>
          {Scene ? (
            <SceneBoundary>
              <Scene
                memories={memories}
                active={active}
                reducedMotion={reduced}
                paused={!onScreen}
                parallax={finePointer && !mobile}
                maxDpr={mobile ? 1.5 : 2}
                compact={mobile}
              />
            </SceneBoundary>
          ) : null}
        </ParallaxLayer>

        <div className="pointer-events-none absolute bottom-4 left-4 md:bottom-6 md:left-6 md:max-w-[calc(100%-392px)]">
          <LiveCaption state={state} />
        </div>
        <div className="absolute bottom-6 right-6 hidden w-[320px] md:block">
          <DecisionCard decision={card} />
        </div>
      </div>

      <MarkerRow />

      <div className="px-4 md:px-8 lg:hidden">
        <Statement className="pt-6 text-[20px] leading-[1.25] text-fg" />
      </div>
      <div className="px-4 pt-8 md:hidden">
        <DecisionCard decision={card} />
      </div>
    </div>
  );
}
