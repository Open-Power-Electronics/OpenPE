export const layoutGridSpacingOptions = [0.1, 0.2, 0.25, 0.5, 1] as const;
export type LayoutGridSpacing = (typeof layoutGridSpacingOptions)[number];
export const defaultLayoutGridSpacing: LayoutGridSpacing = 0.5;
