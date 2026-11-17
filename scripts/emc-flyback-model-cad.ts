import {
  modelCadBoardBounds,
  validateModelCad,
  type ModelCAD,
  type ModelCadObject,
} from '../lib/model-cad';
import { extrudeModelCadSketch, type ModelCadSketchContour } from '../lib/model-cad-sketch';
import type { PCB } from '../lib/pcb';
import { padDrillPosition } from '../lib/pcb-layout';

/** Editable construction recipe using sketch contour differences and the shared Model extrusion preparation. */
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
  });
  let base = panel(
    'base',
    'Aluminium base',
    { x: length, y: width, z: wall },
    { ...center, z: floor + wall / 2 },
  );
  const baseCuts: ModelCadSketchContour[] = [];
  const cutPanel = (body: ModelCadObject, cuts: ModelCadSketchContour[]) =>
    extrudeModelCadSketch({
      id: body.id,
      name: body.name,
      plane: 'XY',
      origin: body.position,
      distance: body.size.z,
      direction: 'symmetric',
      material: body.material,
      opacity: body.opacity,
      contours: [
        {
          operation: 'union',
          profile: { kind: 'rectangle' },
          size: { x: body.size.x, y: body.size.y },
          position: { x: 0, y: 0 },
        },
        ...cuts,
      ],
    });
  for (const footprint of board.footprints.filter((fp) => /^MH[1-4]$/.test(fp.reference ?? '')))
    for (const pad of footprint.pads.filter(
      (pad) => pad.type === 'np_thru_hole' && pad.drill && pad.drill >= 3 && pad.drill <= 4,
    )) {
      const at = padDrillPosition(footprint, pad);
      baseCuts.push({
        operation: 'difference',
        profile: { kind: 'circle' },
        position: { x: round(at.x - center.x), y: round(at.y - center.y) },
        size: { x: pad.drill!, y: pad.drill! },
      });
    }
  base = cutPanel(base, baseCuts);
  let cover = panel(
    'cover',
    'Transparent cover',
    { x: length, y: width, z: wall },
    { ...center, z: floor + height + wall / 2 },
    'pmma',
  );
  const coverCuts: ModelCadSketchContour[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      coverCuts.push({
        operation: 'difference',
        profile: { kind: 'circle' },
        position: { x: round(x * (length / 2 - 8)), y: round(y * (width / 2 - 6)) },
        size: { x: 3.2, y: 3.2 },
      });
  cover = cutPanel(cover, coverCuts);
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
