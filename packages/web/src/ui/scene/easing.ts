export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
export const easeInCubic = (u: number): number => u ** 3;
export const easeOutQuart = (u: number): number => 1 - (1 - u) ** 4;
export const easeInQuad = (u: number): number => u * u;
