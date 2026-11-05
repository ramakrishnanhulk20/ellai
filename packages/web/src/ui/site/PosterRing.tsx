import { useId } from 'react';

const RING_PATH = 'M695.45 80.85 A462.5 462.5 0 1 0 919.15 304.55';

/**
 * Keeps the tight glow off the gap so the ring reads as open there. The wide haze stays whole: masked,
 * it left a dark wedge that read as a shadow where the beam should read as light. The black in the
 * masks is only a stencil: a mask reads alpha, not colour, so it is the same in both modes.
 */
const GAP_MASK = 'conic-gradient(from 0deg, #000 0deg 22deg, transparent 30deg 60deg, #000 68deg 360deg)';

/**
 * The limit ring, the same shape as the logo mark, drawn large. Its size and position come from
 * --ring-d, --ring-x and --ring-y, which the .poster-ring wrapper sets for each screen width.
 *
 * The glows sit in a box half again the ring's size: the mask clips a blurred layer at its own
 * edges, and in a box the ring's size that cut showed as a faint square. The ring is at 61.67% of
 * the larger box's half width (462.5 of 750).
 */
export function PosterRing() {
  // The ring is drawn twice on the page (the poster and the closing band), so its gradient id must be its own.
  const haloId = `${useId()}-halo`;
  return (
    <div className="poster-ring-box">
      <div
        className="enter-fade absolute -inset-[25%] blur-[28px] md:blur-[48px]"
        style={{
          background:
            'radial-gradient(circle closest-side, transparent 46.67%, color-mix(in srgb, var(--accent) calc(18% * var(--poster-glow)), transparent) 61.67%, transparent 66.67%)',
          animationDuration: '1400ms',
          animationDelay: '900ms',
        }}
      />
      <div
        className="enter-fade absolute -inset-[25%] blur-[12px] md:blur-[18px]"
        style={{
          background:
            'radial-gradient(circle closest-side, transparent 57.33%, color-mix(in srgb, var(--accent) calc(55% * var(--poster-glow)), transparent) 61.67%, transparent 66%)',
          maskImage: GAP_MASK,
          WebkitMaskImage: GAP_MASK,
          animationDuration: '1400ms',
          animationDelay: '900ms',
        }}
      />
      <div
        className="enter-fade absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 blur-[14px]"
        style={{
          width: 'calc(var(--ring-d) * 2.4)',
          height: 'calc(var(--ring-d) * 2.4)',
          background:
            'conic-gradient(from 0deg at 50% 50%, transparent 0deg 20deg, color-mix(in srgb, var(--accent) calc(30% * var(--poster-glow)), transparent) 45deg, transparent 70deg 360deg)',
          maskImage: 'radial-gradient(circle closest-side at 50% 50%, transparent 38%, #000 42%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(circle closest-side at 50% 50%, transparent 38%, #000 42%, transparent 100%)',
          animationDuration: '1200ms',
          animationDelay: '1700ms',
        }}
      />
      <svg viewBox="0 0 1000 1000" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <radialGradient id={haloId}>
            <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 'calc(0.55 * var(--poster-glow))' }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        <path
          d={RING_PATH}
          fill="none"
          className="poster-ring-path stroke-accent [stroke-width:1.5px] md:[stroke-width:2px]"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          pathLength={1}
        />
        <path
          d={RING_PATH}
          fill="none"
          opacity={0.7}
          className="poster-ring-path stroke-night-fg [stroke-width:0.75px]"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          pathLength={1}
        />
        <g className="poster-orbit">
          <circle cx="695.45" cy="80.85" r="26" fill={`url(#${haloId})`} />
          <circle cx="695.45" cy="80.85" r="6" className="fill-night-fg" />
        </g>
        <circle
          className="poster-pulse stroke-accent"
          cx="919.15"
          cy="304.55"
          r="10"
          fill="none"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
