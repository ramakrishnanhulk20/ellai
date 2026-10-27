'use client';

import { useMemo } from 'react';
import { Vector3 } from 'three';
import type { MapMemory } from '../memory-map.js';
import { placeMemory } from './placement.js';

export type MemoryLayout = {
  memories: MapMemory[];
  /** Position of each memory in the field's own space, by blob id. */
  positions: Map<string, Vector3>;
};

/**
 * Places every memory once. The key is the list of blob ids and verdicts, so a refresh that
 * brings back the same memories keeps the same objects and the field does not rebuild.
 */
export function useMemoryLayout(memories: MapMemory[]): MemoryLayout {
  const key = memories.map((memory) => `${memory.blobId}:${memory.verdict}`).join('|');
  // The key stands in for the list: same key, same memories.
  return useMemo(() => buildLayout(memories), [key]);
}

function buildLayout(memories: MapMemory[]): MemoryLayout {
  const positions = new Map<string, Vector3>();
  for (const memory of memories) {
    if (!positions.has(memory.blobId)) {
      positions.set(memory.blobId, new Vector3(...placeMemory(memory.blobId)));
    }
  }
  return { memories, positions };
}
