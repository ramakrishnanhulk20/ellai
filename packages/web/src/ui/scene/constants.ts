export const CAMERA_FOV = 38;
// Where the camera starts, before the panel is measured. Once it is, the fit below takes over.
export const CAMERA_DISTANCE = 9.5;
// The ring is kept this much inside the smaller side of the panel.
export const RING_FIT_MARGIN = 1.06;

export const RING_RADIUS = 3.4;
export const RING_SEGMENTS = 256;
export const RING_GAP_DEGREES = 40;
// Centre of the gap, measured counter-clockwise from the right-hand side: top right.
export const RING_GAP_CENTRE_DEGREES = 45;
export const RING_OPACITY = 0.42;
export const RING_LINE_WIDTH = 1.2;
// A wide, faint copy of the ring drawn underneath gives it a soft halo.
export const RING_HALO_WIDTH = 6;
export const RING_HALO_OPACITY = 0.08;
export const RING_SPIN = 0.015;

export const FIELD_RADIUS = 2.8;
export const FIELD_FLATTEN = 0.55;
export const FIELD_SPIN = 0.02;

export const MEMORY_RADIUS = 0.035;
export const GLOW_SIZE = 0.7;
// The core of an approved memory is solid; its glow is softer. Refused memories are dimmer throughout.
export const APPROVE_CORE_OPACITY = 1;
export const APPROVE_GLOW_OPACITY = 0.85;
export const REFUSE_OPACITY = 0.6;

export const PARALLAX_YAW_DEGREES = 4;
export const PARALLAX_PITCH_DEGREES = 2;
export const PARALLAX_DAMPING = 0.08;

export const REPLAY_SECONDS = 6.5;
export const REDUCED_REPLAY_SECONDS = 8;

// Memory points and glows are drawn this much larger on a phone, where the camera sits further back.
export const COMPACT_MARK_SCALE = 1.4;
