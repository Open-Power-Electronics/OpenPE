import type { Point } from '@/lib/circuit';
import type { Pad } from '@/lib/pcb';
import { padDrillSize, pcbPadMachiningOpening } from '@/lib/pcb-drill';
import type { SVGProps } from 'react';

export function PadDrillGraphic({
  pad,
  offset = pad.drillOffset,
  surface,
  ...appearance
}: Pick<SVGProps<SVGElement>, 'fill' | 'stroke' | 'strokeWidth'> & {
  pad: Pick<Pad, 'drill' | 'drillSlot' | 'drillOffset' | 'postMachining'>;
  offset?: Point;
  surface?: 'front' | 'back';
  'data-pad-drill'?: string;
}) {
  const x = offset?.x ?? 0;
  const y = offset?.y ?? 0;
  const radius = (pad.drill ?? 0) / 2;
  if (!pad.drillSlot) {
    const opening = surface ? pcbPadMachiningOpening(pad, surface) : undefined;
    return <circle {...appearance} cx={x} cy={y} r={Math.max(radius, (opening ?? 0) / 2)} />;
  }
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
