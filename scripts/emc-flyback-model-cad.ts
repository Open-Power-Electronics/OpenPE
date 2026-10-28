import {
  modelCadBoardBounds,
  validateModelCad,
  type ModelCAD,
  type ModelCadObject,
} from '../lib/model-cad';
import type { PCB } from '../lib/pcb';
import { padDrillPosition } from '../lib/pcb-layout';

/** Editable construction recipe using the same boxes and holes as the Model tools. */
export function emcFlybackModelCad(board: PCB, identity: (key: string) => string): ModelCAD {
  const bounds = modelCadBoardBounds(board),
    round = (value: number) => Number(value.toFixed(6)),
    center = {
      x: round((bounds.minX + bounds.maxX) / 2),
      y: round((bounds.minY + bounds.maxY) / 2),
    },
    length = round(Math.max(112, bounds.maxX - bounds.minX + 12)),
    width = round(Math.max(94, bounds.maxY - bounds.minY + 18)),
    wall = 3,
    height = 33,
    floor = -board.thickness / 2 - 8 - wall;
  const panel = (
    key: string,
    name: string,
    size: ModelCadObject['size'],
    position: ModelCadObject['position'],
    material: ModelCadObject['material'] = 'aluminium',
  ): ModelCadObject => ({
    id: identity(`model-cad:${key}`),
    name,
    kind: 'box',
    position: {
      x: round(position.x),
      y: round(position.y),
      z: round(position.z),
    },
    rotation: { x: 0, y: 0, z: 0 },
    size,
    material,
    opacity: material === 'pmma' ? 0.3 : 1,
    holes: [],
  });
  const base = panel(
    'base',
    'Aluminium base',
    { x: length, y: width, z: wall },
    { ...center, z: floor + wall / 2 },
  );
  for (const footprint of board.footprints.filter((fp) => /^MH[1-4]$/.test(fp.reference ?? '')))
    for (const pad of footprint.pads.filter(
      (pad) => pad.type === 'np_thru_hole' && pad.drill && pad.drill >= 3 && pad.drill <= 4,
    )) {
      const at = padDrillPosition(footprint, pad);
      base.holes.push({
        id: identity(`model-cad:base:${pad.id}`),
        x: round(at.x - center.x),
        y: round(at.y - center.y),
        diameterMm: pad.drill!,
      });
    }
  const cover = panel(
    'cover',
    'Transparent cover',
    { x: length, y: width, z: wall },
    { ...center, z: floor + height + wall / 2 },
    'pmma',
  );
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      cover.holes.push({
        id: identity(`model-cad:cover:${x}:${y}`),
        x: round(x * (length / 2 - 8)),
        y: round(y * (width / 2 - 6)),
        diameterMm: 3.2,
      });
  return validateModelCad({
    version: 1,
    objects: [
      base,
      panel(
        'wall-front',
        'Aluminium front wall',
        { x: length, y: wall, z: height - wall },
        { x: center.x, y: center.y - (width - wall) / 2, z: floor + (height + wall) / 2 },
      ),
      panel(
        'wall-back',
        'Aluminium back wall',
        { x: length, y: wall, z: height - wall },
        { x: center.x, y: center.y + (width - wall) / 2, z: floor + (height + wall) / 2 },
      ),
      cover,
    ],
  });
}
