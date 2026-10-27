'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { fitDistance } from './camera-fit.js';
import {
  CAMERA_DISTANCE,
  PARALLAX_DAMPING,
  PARALLAX_PITCH_DEGREES,
  PARALLAX_YAW_DEGREES,
} from './constants.js';

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Keeps the whole ring in view at any panel shape, and orbits the camera a few degrees
 * toward the mouse. The pointer is measured against the whole window, so it keeps working
 * while the mouse is over the panel's overlays.
 */
export function CameraRig({ enabled }: { enabled: boolean }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const pointer = useRef({ x: 0, y: 0 });
  const orbit = useRef({ yaw: 0, pitch: 0 });
  const distance = useRef(CAMERA_DISTANCE);

  function place() {
    const { yaw, pitch } = orbit.current;
    camera.position.set(
      distance.current * Math.cos(pitch) * Math.sin(yaw),
      distance.current * Math.sin(pitch),
      distance.current * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(0, 0, 0);
  }

  useLayoutEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    distance.current = fitDistance(size.width / size.height);
    if (!enabled) orbit.current = { yaw: 0, pitch: 0 };
    place();
    invalidate();
    // place only reads refs and the camera, so the size and the switch are the real inputs.
  }, [size.width, size.height, enabled, camera, invalidate]);

  useEffect(() => {
    if (!enabled) return;
    function onMove(event: PointerEvent) {
      if (event.pointerType !== 'mouse') return;
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = 1 - (event.clientY / window.innerHeight) * 2;
    }
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [enabled]);

  useFrame((_, delta) => {
    if (!enabled) return;
    // The damping factor is per frame at 60 fps; scaling it keeps the feel on faster screens.
    const follow = 1 - (1 - PARALLAX_DAMPING) ** (Math.min(delta, 0.1) * 60);
    orbit.current.yaw += (pointer.current.x * toRadians(PARALLAX_YAW_DEGREES) - orbit.current.yaw) * follow;
    orbit.current.pitch +=
      (pointer.current.y * toRadians(PARALLAX_PITCH_DEGREES) - orbit.current.pitch) * follow;
    place();
  });

  return null;
}
