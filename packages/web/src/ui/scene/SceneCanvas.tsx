'use client';

import { Canvas } from '@react-three/fiber';
import { useMemo, useState } from 'react';
import type { MapMemory } from '../memory-map.js';
import { CameraRig } from './CameraRig.js';
import { CAMERA_DISTANCE, CAMERA_FOV, COMPACT_MARK_SCALE } from './constants.js';
import { LimitRing } from './LimitRing.js';
import { MemoryField } from './MemoryField.js';
import { Replay } from './Replay.js';
import { createSceneState } from './scene-state.js';
import { readColor, useAccentColor } from './tokens.js';
import type { ActiveReplay } from './useDecisionCycle.js';
import { useMemoryLayout } from './useMemoryLayout.js';

export type SceneProps = {
  memories: MapMemory[];
  active: ActiveReplay | null;
  /** Draws one still frame and nothing moves. */
  reducedMotion: boolean;
  /** The panel is scrolled out of view, so frames stop until it returns. */
  paused: boolean;
  parallax: boolean;
  maxDpr: number;
  /** A phone-sized panel: points and glows are drawn larger. */
  compact: boolean;
};

export function SceneCanvas({ memories, active, reducedMotion, paused, parallax, maxDpr, compact }: SceneProps) {
  const layout = useMemoryLayout(memories);
  const [scene] = useState(createSceneState);
  const accent = useAccentColor();
  const markScale = compact ? COMPACT_MARK_SCALE : 1;
  const colors = useMemo(
    () => ({
      fg: readColor('--fg'),
      paid: readColor('--paid'),
      asked: readColor('--asked'),
      refused: readColor('--refused'),
      approved: accent,
    }),
    [accent],
  );

  return (
    <Canvas
      flat
      dpr={[1, maxDpr]}
      gl={{ antialias: true, alpha: true }}
      camera={{ fov: CAMERA_FOV, position: [0, 0, CAMERA_DISTANCE], near: 0.1, far: 60 }}
      frameloop={reducedMotion || paused ? 'demand' : 'always'}
      style={{ position: 'absolute', inset: 0 }}
      aria-hidden="true"
    >
      <CameraRig enabled={parallax && !reducedMotion} />
      <LimitRing color={accent} scene={scene} spin={!reducedMotion} />
      <MemoryField
        layout={layout}
        approveColor={accent}
        refuseColor={colors.refused}
        scene={scene}
        spin={!reducedMotion}
        markScale={markScale}
      />
      {!reducedMotion && (
        <Replay active={active} layout={layout} scene={scene} colors={colors} markScale={markScale} />
      )}
    </Canvas>
  );
}
