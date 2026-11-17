import { uid } from '../lib/circuit';
import { createProject } from '../lib/project';
import { createEmptyPCB } from '../lib/pcb-layout';

export function manufacturingProject() {
  const project = createProject();
  const board = createEmptyPCB();
  const points = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
  ];
  board.graphics = points.map((start, i) => ({
    id: uid(),
    start,
    end: points[(i + 1) % 4],
    layer: 'Edge.Cuts',
    width: 0.05,
  }));
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Resistor_SMD:R_0603_1608Metric',
      reference: 'R1',
      value: '10k',
      x: 10,
      y: 12,
      rotation: 90,
      side: 'front',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: -1,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'roundrect',
          roundrectRatio: 0.2,
          size: { x: 1, y: 1.5 },
          netId: null,
        },
      ],
    },
    {
      id: uid(),
      symbolId: null,
      libraryId: 'MountingHole:MountingHole_2mm',
      reference: 'H1',
      value: 'MountingHole',
      x: 5,
      y: 5,
      rotation: 0,
      side: 'back',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'np_thru_hole',
          shape: 'circle',
          size: { x: 2, y: 2 },
          drill: 2,
          netId: null,
          layers: ['*.Cu', '*.Mask'],
        },
      ],
    },
  ];
  project.pcb = board;
  return project;
}
