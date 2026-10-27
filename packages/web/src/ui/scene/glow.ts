import { CanvasTexture, SRGBColorSpace } from 'three';

let shared: CanvasTexture | null = null;

/** One soft white dot, drawn once and tinted per use by the material colour. */
export function glowTexture(): CanvasTexture {
  if (shared) return shared;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A 2D canvas is needed to draw the glow texture');
  const half = size / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.18, 'rgba(255, 255, 255, 0.55)');
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.14)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  shared = new CanvasTexture(canvas);
  shared.colorSpace = SRGBColorSpace;
  return shared;
}
