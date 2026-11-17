export const modelScaleRadius = 42;
const scaleSteps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/** Engineering reference that stays within the compact widget at any camera scale. */
export function modelScaleLength(unitsPerPixel: number) {
  const reference = unitsPerPixel * modelScaleRadius;
  if (!(reference > 0) || !Number.isFinite(reference)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(reference));
  const ratio = reference / magnitude;
  const step = scaleSteps.findLast((value) => value <= ratio)!;
  return Number((step * magnitude).toPrecision(12));
}
