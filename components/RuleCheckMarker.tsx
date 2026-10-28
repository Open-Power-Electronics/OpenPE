import type { Point } from '@/lib/circuit';

export default function RuleCheckMarker({
  location,
  radius,
}: {
  location?: Point;
  radius: number;
}) {
  if (!location) return null;
  return (
    <g
      data-rule-check-marker
      data-export-exclude
      data-selection-only
      pointerEvents="none"
      fill="none"
      stroke="var(--error)"
      strokeWidth="1.5"
    >
      <circle cx={location.x} cy={location.y} r={radius} vectorEffect="non-scaling-stroke" />
      <path
        d={`M ${location.x - radius * 1.5} ${location.y} h ${radius * 3} M ${location.x} ${location.y - radius * 1.5} v ${radius * 3}`}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}
