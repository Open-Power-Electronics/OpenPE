import { memo, useId } from 'react';
import type { Circuit } from '@/lib/circuit';
import { pinPositions } from '@/lib/circuit';
import { partTransform } from '@/lib/schematic-edit';
import SymbolGraphic from './SymbolGraphic';
import SchematicText from './SchematicText';
import { schematicTexts, schematicPolylines, schematicNoteBoxCorners } from '@/lib/schematic-text';
import { schematicImageCorners } from '@/lib/schematic-image';
import { visibleJunctions } from '@/lib/schematic-view';
import { partFields } from '@/lib/library';
import { symbolRole } from '@/lib/symbol-role';

export default memo(function ExamplePreview({ circuit: d }: { circuit: Circuit }) {
  const instanceId = useId().replace(/[^\w-]/g, '');
  // Small Home cards reuse repeated source symbols instead of mounting every pin
  // and glyph for every instance. The editable schematic remains complete.
  const graphics = new Map<string, { id: string; part: Circuit['parts'][number] }>();
  const graphicId = (part: Circuit['parts'][number]) => {
    const key = JSON.stringify([
      part.libId, part.unit, part.rotation, part.mirror,
      symbolRole(d.libraries[part.libId], part), partFields(part)['Sim.Device'],
    ]);
    if (!graphics.has(key)) graphics.set(key, { id: `${instanceId}-${graphics.size}`, part });
    return graphics.get(key)!.id;
  };
  const instances = d.parts.map((part) => ({ part, id: graphicId(part) }));
  const points = [
    ...d.parts,
    ...d.parts.flatMap((p) => pinPositions(p, d.libraries[p.libId])),
    ...d.wires.flatMap((w) => [w.a, w.b]),
    ...d.labels,
    ...schematicTexts(d.original),
    ...schematicPolylines(d.original).flatMap((line) => line.points),
    ...schematicNoteBoxCorners(d.original),
    ...schematicImageCorners(d.original),
  ];
  if (!points.length) points.push({ x: 0, y: 0 });
  const left = Math.min(...points.map((p) => p.x)) - 10;
  const top = Math.min(...points.map((p) => p.y)) - 10;
  const width = Math.max(...points.map((p) => p.x)) - left + 10;
  const height = Math.max(...points.map((p) => p.y)) - top + 10;
  return (
    <svg viewBox={`${left} ${top} ${width} ${height}`}>
      <defs>
        {[...graphics.values()].map(({ id, part }) => (
          <g key={id} id={id}>
            <SymbolGraphic library={d.libraries[part.libId]} part={part} unit={part.unit}
              orientation={part} showPinNames={false} showPinNumbers={false} />
          </g>
        ))}
      </defs>
      <path stroke="var(--wire)" strokeWidth="0.5" strokeLinecap="square" fill="none"
        d={d.wires.map((wire) => `M${wire.a.x} ${wire.a.y}L${wire.b.x} ${wire.b.y}`).join(' ')} />
      {instances.map(({ part, id }) => (
        <use key={part.id} href={`#${id}`} transform={partTransform(part)} />
      ))}
      {visibleJunctions(d).map((j) => (
        <circle key={j.id} cx={j.x} cy={j.y} r="0.65" fill="var(--wire)" />
      ))}
      <SchematicText original={d.original} />
      <g fill="var(--schematic-net-label)" fontSize="2" fontFamily="var(--ui-font)">
        {d.labels.map((l) => (
          <text key={l.id} x={l.x} y={l.y - 1.5}>
            {l.text}
          </text>
        ))}
      </g>
    </svg>
  );
});
