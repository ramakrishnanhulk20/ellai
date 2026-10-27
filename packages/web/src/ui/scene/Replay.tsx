'use client';

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Vector3,
  type Color,
  type Mesh,
  type MeshBasicMaterial,
  type Object3D,
  type Sprite,
  type SpriteMaterial,
} from 'three';
import {
  APPROVE_GLOW_OPACITY,
  GLOW_SIZE,
  MEMORY_RADIUS,
  REPLAY_SECONDS,
  RING_GAP_CENTRE_DEGREES,
  RING_GAP_DEGREES,
  RING_RADIUS,
} from './constants.js';
import { clamp01, easeInCubic, easeInQuad, easeOutCubic, easeOutQuart } from './easing.js';
import { glowTexture } from './glow.js';
import type { SceneState } from './scene-state.js';
import type { ActiveReplay } from './useDecisionCycle.js';
import type { MemoryLayout } from './useMemoryLayout.js';

const FLIGHT = 1.4;
const PULSE = 0.9;
const PULSE_PEAK = 2.4;
const LINE_DRAW = 0.6;
const OUTCOME_DELAY = 0.3;
const OUTCOME_AT = FLIGHT + LINE_DRAW + OUTCOME_DELAY;
const FADE_OUT = 0.5;

const REQUEST_RADIUS = 0.05;
const ASK_RADIUS = 0.18;
const ASK_PULSE = 0.8;
const ASK_PULSES = 2;
// The brief gives no timing for the next four, so they borrow from numbers it does give:
// settling and fading take as long as a line draws, the trip out to the ring as long as the
// trip in, and an asking ring swells by under one of its own radii.
const SETTLE = LINE_DRAW;
const REFUSE_EXIT = FLIGHT;
const REFUSE_FADE = LINE_DRAW;
const ASK_GROWTH = 0.8;

const START = { x: 7.5, y: 2.2 };
const CONTROL = { x: 4.2, y: 0.6, z: 1.2 };

// A request that cites one memory would land exactly on it, leaving no line to draw, so it
// stops this far short of it along its approach.
const SINGLE_CITATION_STOP = 0.6;

const MAX_LINES = 12;
const LINE_WIDTH = 1.2;

// drei does not give its line type through this package's module settings, so the two fields used are spelled out.
type LineObject = Object3D & { material: { dashOffset: number; opacity: number } };

const UNIT_SEGMENT: Array<[number, number, number]> = [
  [0, 0, 0],
  [0, 0, 1],
];

const UNIT_CIRCLE: Array<[number, number, number]> = Array.from({ length: 49 }, (_, i) => {
  const angle = (i / 48) * 2 * Math.PI;
  return [Math.cos(angle), Math.sin(angle), 0];
});

const LINE_SLOTS = Array.from({ length: MAX_LINES }, (_, i) => i);

export type ReplayColors = {
  fg: Color;
  paid: Color;
  asked: Color;
  refused: Color;
};

type Plan = {
  /** Seconds on the page clock when this replay began. */
  startedAt: number;
  outcome: ActiveReplay['decision']['outcome'];
  start: Vector3;
  control: Vector3;
  /** Middle of the cited memories, in the field's own space. */
  centroid: Vector3;
  cited: Array<{ blobId: string; local: Vector3; lineOpacity: number }>;
  /** Where a refused request meets the ring; chosen the moment it turns back. */
  exit: Vector3 | null;
};

function lineOpacityFor(distance: number | null): number {
  if (distance === null) return 0.5;
  return Math.min(1, Math.max(0.25, 1 - distance / 0.5));
}

function buildPlan({ decision, step }: ActiveReplay, layout: MemoryLayout): Plan {
  const side = step % 2 === 0 ? 1 : -1;
  const cited: Plan['cited'] = [];
  for (const citation of decision.citations) {
    const local = layout.positions.get(citation.blobId);
    if (!local || cited.length >= MAX_LINES) continue;
    cited.push({ blobId: citation.blobId, local, lineOpacity: lineOpacityFor(citation.distance) });
  }
  const centroid = new Vector3();
  for (const entry of cited) centroid.add(entry.local);
  if (cited.length > 0) centroid.divideScalar(cited.length);
  return {
    startedAt: performance.now() / 1000,
    outcome: decision.outcome,
    start: new Vector3(START.x, START.y * side, 0),
    control: new Vector3(CONTROL.x, CONTROL.y * side, CONTROL.z),
    centroid,
    cited,
    exit: null,
  };
}

const target = new Vector3();
const position = new Vector3();
const memoryWorld = new Vector3();
const approach = new Vector3();

/** Turns a point from the field's own space into scene space for the field's current spin. */
function spin(point: Vector3, angle: number, out: Vector3): Vector3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return out.set(point.x * cos + point.z * sin, point.y, -point.x * sin + point.z * cos);
}

function quadraticBezier(a: Vector3, b: Vector3, c: Vector3, k: number, out: Vector3): Vector3 {
  const inverse = 1 - k;
  return out
    .set(0, 0, 0)
    .addScaledVector(a, inverse * inverse)
    .addScaledVector(b, 2 * inverse * k)
    .addScaledVector(c, k * k);
}

/** The spot on the ring in the request's direction. A spot inside the gap moves to the gap's nearer edge. */
function ringExit(from: Vector3, ringAngle: number): Vector3 {
  let angle = Math.atan2(from.y, from.x);
  const gapCentre = (RING_GAP_CENTRE_DEGREES * Math.PI) / 180 + ringAngle;
  const halfGap = (RING_GAP_DEGREES * Math.PI) / 360;
  const offset = Math.atan2(Math.sin(angle - gapCentre), Math.cos(angle - gapCentre));
  if (Math.abs(offset) < halfGap) angle = gapCentre + (offset < 0 ? -halfGap : halfGap);
  return new Vector3(RING_RADIUS * Math.cos(angle), RING_RADIUS * Math.sin(angle), 0);
}

/** Size of a pulsing memory, given 0 to 1 through the pulse: up with easeOutQuart, back with easeInQuad. */
function pulseScale(progress: number): number {
  if (progress < 0.5) return 1 + (PULSE_PEAK - 1) * easeOutQuart(progress / 0.5);
  return PULSE_PEAK - (PULSE_PEAK - 1) * easeInQuad((progress - 0.5) / 0.5);
}

type Props = {
  active: ActiveReplay | null;
  layout: MemoryLayout;
  scene: SceneState;
  colors: ReplayColors;
  markScale: number;
};

/**
 * Plays one real decision at a time: the request flies in, the past answers it matched light
 * up, then the outcome shows. Every object is made once and reused for each replay.
 */
export function Replay({ active, layout, scene, colors, markScale }: Props) {
  const texture = useMemo(glowTexture, []);
  const plan = useRef<Plan | null>(null);
  const latestLayout = useRef(layout);
  latestLayout.current = layout;
  const idle = useRef(true);
  const tint = useRef(colors.fg.clone());

  const requestMesh = useRef<Mesh>(null);
  const requestMaterial = useRef<MeshBasicMaterial>(null);
  const requestGlow = useRef<Sprite>(null);
  const requestGlowMaterial = useRef<SpriteMaterial>(null);
  const flash = useRef<Sprite>(null);
  const flashMaterial = useRef<SpriteMaterial>(null);
  const askRing = useRef<LineObject | null>(null);
  const lines = useRef<Array<LineObject | null>>([]);

  useEffect(() => {
    scene.pulses.clear();
    plan.current = active ? buildPlan(active, latestLayout.current) : null;
    return () => scene.pulses.clear();
  }, [active, scene]);

  function hideAll() {
    for (const node of [requestMesh.current, requestGlow.current, flash.current, askRing.current]) {
      if (node) node.visible = false;
    }
    for (const line of lines.current) if (line) line.visible = false;
    scene.pulses.clear();
  }

  useFrame(() => {
    const current = plan.current;
    const t = current ? performance.now() / 1000 - current.startedAt : Infinity;
    if (!current || t >= REPLAY_SECONDS) {
      if (!idle.current) {
        hideAll();
        idle.current = true;
      }
      return;
    }
    idle.current = false;

    const mesh = requestMesh.current;
    const meshMaterial = requestMaterial.current;
    const glow = requestGlow.current;
    const glowMaterial = requestGlowMaterial.current;
    const ring = askRing.current;
    const flashNode = flash.current;
    const flashFill = flashMaterial.current;
    if (!mesh || !meshMaterial || !glow || !glowMaterial || !ring || !flashNode || !flashFill) return;

    const fade = 1 - clamp01((t - (REPLAY_SECONDS - FADE_OUT)) / FADE_OUT);
    spin(current.centroid, scene.fieldAngle, target);
    if (current.cited.length === 1) {
      approach.copy(target).sub(current.control).normalize();
      target.addScaledVector(approach, -SINGLE_CITATION_STOP);
    }

    if (t < FLIGHT) {
      quadraticBezier(current.start, current.control, target, easeOutCubic(t / FLIGHT), position);
    } else {
      position.copy(target);
    }

    const startRadius = REQUEST_RADIUS * markScale;
    let radius = startRadius;
    let alpha = fade;
    let asking = -1;
    let flashing = -1;
    tint.current.copy(colors.fg);

    const sinceOutcome = t - OUTCOME_AT;
    if (sinceOutcome >= 0) {
      if (current.outcome === 'approved') {
        const k = easeOutCubic(clamp01(sinceOutcome / SETTLE));
        tint.current.lerp(colors.paid, k);
        radius = startRadius + (MEMORY_RADIUS * markScale - startRadius) * k;
      } else if (current.outcome === 'asked') {
        if (sinceOutcome < ASK_PULSE * ASK_PULSES) asking = (sinceOutcome % ASK_PULSE) / ASK_PULSE;
      } else {
        current.exit ??= ringExit(target, scene.ringAngle);
        const k = easeInCubic(clamp01(sinceOutcome / REFUSE_EXIT));
        position.lerpVectors(target, current.exit, k);
        tint.current.lerp(colors.refused, k);
        if (sinceOutcome >= REFUSE_EXIT) {
          flashing = clamp01((sinceOutcome - REFUSE_EXIT) / REFUSE_FADE);
          alpha *= 1 - flashing;
        }
      }
    }

    mesh.visible = alpha > 0.002;
    mesh.position.copy(position);
    mesh.scale.setScalar(radius);
    meshMaterial.color.copy(tint.current);
    meshMaterial.opacity = alpha;
    glow.visible = mesh.visible;
    glow.position.copy(position);
    glow.scale.setScalar(GLOW_SIZE * markScale);
    glowMaterial.color.copy(tint.current);
    glowMaterial.opacity = APPROVE_GLOW_OPACITY * alpha;

    ring.visible = asking >= 0;
    if (asking >= 0) {
      ring.position.copy(position);
      ring.scale.setScalar(ASK_RADIUS * (1 + ASK_GROWTH * easeOutCubic(asking)));
      ring.material.opacity = 0.9 * (1 - asking) * fade;
    }

    flashNode.visible = flashing >= 0 && current.exit !== null;
    if (flashing >= 0 && current.exit) {
      flashNode.position.copy(current.exit);
      flashNode.scale.setScalar(GLOW_SIZE * markScale * (1 + 2 * flashing));
      flashFill.opacity = (1 - flashing) * fade;
    }

    const drawn = easeOutCubic(clamp01((t - FLIGHT) / LINE_DRAW));
    lines.current.forEach((line, i) => {
      if (!line) return;
      const entry = current.cited[i];
      if (!entry || t < FLIGHT) {
        line.visible = false;
        return;
      }
      spin(entry.local, scene.fieldAngle, memoryWorld);
      const length = position.distanceTo(memoryWorld);
      line.visible = length > 1e-4;
      line.position.copy(position);
      line.lookAt(memoryWorld);
      line.scale.set(1, 1, length);
      line.material.dashOffset = 1 - drawn;
      line.material.opacity = entry.lineOpacity * fade;
    });

    const pulseProgress = (t - FLIGHT) / PULSE;
    if (pulseProgress > 0 && pulseProgress < 1) {
      const scale = pulseScale(pulseProgress);
      for (const entry of current.cited) scene.pulses.set(entry.blobId, scale);
    } else if (scene.pulses.size > 0) {
      scene.pulses.clear();
    }
  });

  // drei hands every prop of <Line> to its material as well as the line, and a hidden material never
  // draws again, so the lines are hidden through their refs instead of a visible prop.
  return (
    <group>
      <mesh ref={requestMesh} visible={false} frustumCulled={false}>
        <sphereGeometry args={[1, 20, 20]} />
        <meshBasicMaterial ref={requestMaterial} transparent />
      </mesh>
      <sprite ref={requestGlow} visible={false} frustumCulled={false}>
        <spriteMaterial
          ref={requestGlowMaterial}
          map={texture}
          blending={AdditiveBlending}
          transparent
          depthWrite={false}
        />
      </sprite>
      <sprite ref={flash} visible={false} frustumCulled={false}>
        <spriteMaterial
          ref={flashMaterial}
          map={texture}
          color={colors.refused}
          blending={AdditiveBlending}
          transparent
          depthWrite={false}
        />
      </sprite>
      <Line
        ref={(node: LineObject | null) => {
          askRing.current = node;
          if (node) node.visible = false;
        }}
        points={UNIT_CIRCLE}
        color={colors.asked}
        lineWidth={1.5}
        transparent
        opacity={0}
      />
      {LINE_SLOTS.map((slot) => (
        <Line
          key={slot}
          ref={(node: LineObject | null) => {
            lines.current[slot] = node;
            if (node) node.visible = false;
          }}
          points={UNIT_SEGMENT}
          color={colors.fg}
          lineWidth={LINE_WIDTH}
          dashed
          dashSize={1}
          gapSize={1}
          transparent
          opacity={0}
        />
      ))}
    </group>
  );
}
