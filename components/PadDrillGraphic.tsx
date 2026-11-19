import type { Point } from '@/lib/circuit';
import type { Pad } from '@/lib/pcb';
import { padDrillSize } from '@/lib/pcb-drill';
import type { SVGProps } from 'react';

export function PadDrillGraphic({
  pad,
  offset = pad.drillOffset,
  ...appearance
}: Pick<SVGProps<SVGElement>, 'fill' | 'stroke' | 'strokeWidth'> & {
  pad: Pick<Pad, 'drill' | 'drillSlot' | 'drillOffset'>;
  offset?: Point;
  'data-pad-drill'?: string;
}) {
  const x = offset?.x ?? 0;
  const y = offset?.y ?? 0;
  const radius = (pad.drill ?? 0) / 2;
  if (!pad.drillSlot) return <circle {...appearance} cx={x} cy={y} r={radius} />;
  const { x: width, y: height } = padDrillSize(pad);
  return (
    <rect
      {...appearance}
      x={x - width / 2}
      y={y - height / 2}
      width={width}
      height={height}
      rx={radius}
    />
  );
}
