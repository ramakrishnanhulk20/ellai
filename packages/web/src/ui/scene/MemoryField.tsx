'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Color,
  type Group,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import {
  APPROVE_CORE_OPACITY,
  APPROVE_GLOW_OPACITY,
  FIELD_SPIN,
  GLOW_SIZE,
  MEMORY_RADIUS,
  REFUSE_OPACITY,
} from './constants.js';
import { glowTexture } from './glow.js';
import { frameSeconds, type SceneState } from './scene-state.js';
import type { MemoryLayout } from './useMemoryLayout.js';

type Item = { blobId: string; position: Vector3 };

// The glow quad always faces the camera: only the instance's centre and scale are used,
// the quad's own corners are laid out in view space.
const BILLBOARD_PROJECTION = /* glsl */ `
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  mvPosition.xy += position.xy * length( instanceMatrix[ 0 ].xyz );
  gl_Position = projectionMatrix * mvPosition;
`;

const NO_ROTATION = new Quaternion();
const matrix = new Matrix4();
const scaleVector = new Vector3();

function createCluster(items: Item[], markScale: number) {
  const count = items.length;

  const sphereMaterial = new MeshBasicMaterial({ transparent: true });
  const spheres = new InstancedMesh(new SphereGeometry(MEMORY_RADIUS * markScale, 12, 12), sphereMaterial, count);

  const glowMaterial = new MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  glowMaterial.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', BILLBOARD_PROJECTION);
  };
  glowMaterial.customProgramCacheKey = () => 'ellai-billboard-glow';
  const glows = new InstancedMesh(new PlaneGeometry(GLOW_SIZE * markScale, GLOW_SIZE * markScale), glowMaterial, count);
  // Spheres and glows move together, so they read one shared matrix buffer.
  glows.instanceMatrix = spheres.instanceMatrix;

  spheres.frustumCulled = false;
  glows.frustumCulled = false;

  const slot = new Map<string, number>();
  items.forEach((item, i) => {
    slot.set(item.blobId, i);
    spheres.setMatrixAt(i, matrix.makeTranslation(item.position));
  });
  spheres.instanceMatrix.needsUpdate = true;

  let touched: number[] = [];

  function setScale(i: number, scale: number) {
    const item = items[i];
    if (!item) return;
    scaleVector.setScalar(scale);
    spheres.setMatrixAt(i, matrix.compose(item.position, NO_ROTATION, scaleVector));
  }

  /** Puts pulsing memories at their current size and everything else back to normal. */
  function applyPulses(pulses: Map<string, number>) {
    if (touched.length === 0 && pulses.size === 0) return;
    for (const i of touched) setScale(i, 1);
    touched = [];
    for (const [blobId, scale] of pulses) {
      const i = slot.get(blobId);
      if (i === undefined) continue;
      setScale(i, scale);
      touched.push(i);
    }
    spheres.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    spheres.geometry.dispose();
    sphereMaterial.dispose();
    glows.geometry.dispose();
    glowMaterial.dispose();
    spheres.dispose();
    glows.dispose();
  }

  return { spheres, glows, sphereMaterial, glowMaterial, applyPulses, dispose };
}

type ClusterProps = {
  items: Item[];
  markScale: number;
  color: Color;
  coreOpacity: number;
  glowOpacity: number;
  scene: SceneState;
};

function Cluster({ items, markScale, color, coreOpacity, glowOpacity, scene }: ClusterProps) {
  const invalidate = useThree((state) => state.invalidate);
  const cluster = useMemo(() => createCluster(items, markScale), [items, markScale]);

  useLayoutEffect(() => {
    cluster.sphereMaterial.color.copy(color);
    cluster.glowMaterial.color.copy(color);
    cluster.sphereMaterial.opacity = coreOpacity;
    cluster.glowMaterial.opacity = glowOpacity;
    invalidate();
  }, [cluster, color, coreOpacity, glowOpacity, invalidate]);

  useEffect(() => () => cluster.dispose(), [cluster]);

  useFrame(() => cluster.applyPulses(scene.pulses));

  return (
    <>
      <primitive object={cluster.spheres} />
      <primitive object={cluster.glows} />
    </>
  );
}

type Props = {
  layout: MemoryLayout;
  approveColor: Color;
  refuseColor: Color;
  scene: SceneState;
  spin: boolean;
  markScale: number;
};

export function MemoryField({ layout, approveColor, refuseColor, scene, spin, markScale }: Props) {
  const group = useRef<Group>(null);

  const { approve, refuse } = useMemo(() => {
    const approveItems: Item[] = [];
    const refuseItems: Item[] = [];
    const seen = new Set<string>();
    for (const memory of layout.memories) {
      const position = layout.positions.get(memory.blobId);
      if (!position || seen.has(memory.blobId)) continue;
      seen.add(memory.blobId);
      (memory.verdict === 'approve' ? approveItems : refuseItems).push({
        blobId: memory.blobId,
        position,
      });
    }
    return { approve: approveItems, refuse: refuseItems };
  }, [layout]);

  useFrame((_, delta) => {
    if (spin) scene.fieldAngle += FIELD_SPIN * frameSeconds(delta);
    if (group.current) group.current.rotation.y = scene.fieldAngle;
  });

  return (
    <group ref={group}>
      {approve.length > 0 && (
        <Cluster
          items={approve}
          markScale={markScale}
          color={approveColor}
          coreOpacity={APPROVE_CORE_OPACITY}
          glowOpacity={APPROVE_GLOW_OPACITY}
          scene={scene}
        />
      )}
      {refuse.length > 0 && (
        <Cluster
          items={refuse}
          markScale={markScale}
          color={refuseColor}
          coreOpacity={REFUSE_OPACITY}
          glowOpacity={REFUSE_OPACITY}
          scene={scene}
        />
      )}
    </group>
  );
}
