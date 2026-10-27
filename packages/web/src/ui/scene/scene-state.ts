/**
 * Numbers that several parts of the scene read every frame. They live in a plain object,
 * not React state, so animating them never re-renders anything.
 */
export type SceneState = {
  /** Rotation of the memory field around the vertical axis, in radians. */
  fieldAngle: number;
  /** Rotation of the limit ring around the viewing axis, in radians. */
  ringAngle: number;
  /** Extra scale for memories that are pulsing right now, by blob id. */
  pulses: Map<string, number>;
};

export function createSceneState(): SceneState {
  return { fieldAngle: 0, ringAngle: 0, pulses: new Map() };
}

/** A long gap between frames (hidden tab, paused scene) must not make anything jump. */
export function frameSeconds(delta: number): number {
  return Math.min(delta, 0.1);
}
