import { CAMERA_FOV, RING_FIT_MARGIN, RING_RADIUS } from './constants.js';

/**
 * How far back the camera must sit for the whole limit ring to fit the panel with a small
 * margin. The height decides on a wide panel and the width decides on a tall narrow one.
 */
export function fitDistance(aspect: number): number {
  const halfFov = (CAMERA_FOV * Math.PI) / 360;
  return (RING_RADIUS * RING_FIT_MARGIN) / (Math.tan(halfFov) * Math.min(1, aspect));
}
