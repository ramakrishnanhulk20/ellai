'use client';

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Color, Group } from 'three';
import {
  RING_GAP_CENTRE_DEGREES,
  RING_GAP_DEGREES,
  RING_HALO_OPACITY,
  RING_HALO_WIDTH,
  RING_LINE_WIDTH,
  RING_OPACITY,
  RING_RADIUS,
  RING_SEGMENTS,
  RING_SPIN,
} from './constants.js';
import { frameSeconds, type SceneState } from './scene-state.js';

type Props = {
  color: Color;
  scene: SceneState;
  spin: boolean;
};

/** The arc of the ring, running the long way round from one side of the gap to the other. */
function ringPoints(): Array<[number, number, number]> {
  const gap = (RING_GAP_DEGREES * Math.PI) / 180;
  const centre = (RING_GAP_CENTRE_DEGREES * Math.PI) / 180;
  const start = centre + gap / 2;
  const sweep = 2 * Math.PI - gap;
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i <= RING_SEGMENTS; i += 1) {
    const angle = start + (sweep * i) / RING_SEGMENTS;
    points.push([RING_RADIUS * Math.cos(angle), RING_RADIUS * Math.sin(angle), 0]);
  }
  return points;
}

export function LimitRing({ color, scene, spin }: Props) {
  const group = useRef<Group>(null);
  const points = useMemo(ringPoints, []);

  useFrame((_, delta) => {
    if (!spin || !group.current) return;
    scene.ringAngle += RING_SPIN * frameSeconds(delta);
    group.current.rotation.z = scene.ringAngle;
  });

  return (
    <group ref={group}>
      <Line
        points={points}
        color={color}
        lineWidth={RING_HALO_WIDTH}
        transparent
        opacity={RING_HALO_OPACITY}
      />
      <Line
        points={points}
        color={color}
        lineWidth={RING_LINE_WIDTH}
        transparent
        opacity={RING_OPACITY}
      />
    </group>
  );
}
