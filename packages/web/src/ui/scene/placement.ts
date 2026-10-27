import { FIELD_FLATTEN, FIELD_RADIUS } from './constants.js';

/** FNV-1a, 32 bit, over the UTF-8 bytes of the text. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Mulberry32 turns the one 32-bit hash into as many uniform numbers as a point needs.
function uniformNumbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where a memory sits in the field. Only the blob id decides it, so a memory keeps its
 * place across reloads and across everyone who opens the page.
 */
export function placeMemory(blobId: string): [number, number, number] {
  const next = uniformNumbers(fnv1a(blobId));
  const u1 = next();
  const u2 = next();
  const u3 = next();
  const r = FIELD_RADIUS * Math.cbrt(u1);
  const theta = 2 * Math.PI * u2;
  const phi = Math.acos(2 * u3 - 1);
  return [
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi) * FIELD_FLATTEN,
  ];
}
