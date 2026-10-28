import type { Circuit } from './circuit';
import { resolvePCBGraphic, type BoardLine, type PCB } from './pcb';
import { transformPCBGraphic } from './pcb-geometry';
import { footprintPoint } from './pcb-layout';

/** Resolve linked captions without changing the embedded native field content. */
export function pcbSilkscreen(board: PCB, schematic?: Circuit): BoardLine[] {
  return [
    ...board.graphics,
    ...board.footprints.flatMap((footprint) => {
      const part = schematic?.parts.find((p) => p.id === footprint.symbolId);
      const reference = part?.ref ?? footprint.reference ?? '';
      const graphics = [...footprint.graphics];
      if (reference && !graphics.some((g) => g.text?.property === 'Reference'))
        graphics.push({
          id: `display-reference-${footprint.id}`,
          kind: 'text',
          layer: footprint.side === 'front' ? 'F.SilkS' : 'B.SilkS',
          width: 0,
          start: { x: 0, y: -3 },
          end: { x: 0, y: -3 },
          text: {
            value: reference,
            rotation: 0,
            size: { x: 1, y: 1 },
            thickness: 0.15,
            justify: footprint.side === 'back' ? ['mirror'] : [],
          },
        });
      return graphics.map((graphic) =>
        transformPCBGraphic(
          resolvePCBGraphic(
            graphic,
            part?.ref ?? footprint.reference ?? '',
            part?.value ?? footprint.value ?? '',
          ),
          (point) => footprintPoint(footprint, point),
          (rotation) => rotation + footprint.rotation,
        ),
      );
    }),
  ].filter((g) => (g.layer === 'F.SilkS' || g.layer === 'B.SilkS') && !g.text?.hidden);
}
