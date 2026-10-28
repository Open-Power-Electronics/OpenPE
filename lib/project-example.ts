import { createPart, emptyCircuit, pinPositions, uid } from './circuit';
import { createProject } from './project';

// A small format fixture, not a production-validated board or default workspace.
export function exampleProject() {
  const d = emptyCircuit();
  d.title = 'RC filter · format example';
  const r = createPart(d, 'R', 50.8, 40.64);
  r.rotation = 90;
  r.value = '1k';
  d.parts.push(r);
  const c = createPart(d, 'C', 66.04, 50.8);
  c.value = '100nF';
  const ground = createPart(d, 'GND', 66.04, 60.96);
  d.parts.push(c, ground);
  const [r1, r2] = pinPositions(r, d.libraries[r.libId]);
  const [c1, c2] = pinPositions(c, d.libraries[c.libId]);
  d.wires = [
    [40.64, 40.64, r1.x, r1.y],
    [r2.x, r2.y, 66.04, 40.64],
    [66.04, 40.64, c1.x, c1.y],
    [c2.x, c2.y, 66.04, 60.96],
  ].map(([x, y, bx, by]) => ({ id: uid(), a: { x, y }, b: { x: bx, y: by } }));
  d.labels = [
    { id: uid(), x: 40.64, y: 40.64, text: 'IN' },
    { id: uid(), x: 66.04, y: 40.64, text: 'OUT' },
  ];
  const p = createProject(d);
  const input = uid(),
    output = uid(),
    gnd = uid();
  p.pcb = {
    id: uid(),
    thickness: 1.6,
    layers: ['F.Cu', 'B.Cu'],
    nets: [
      { id: input, name: '/IN' },
      { id: output, name: '/OUT' },
      { id: gnd, name: 'GND' },
    ],
    footprints: [
      {
        id: uid(),
        symbolId: r.id,
        libraryId: 'OpenPE:R_P5.08',
        x: 20,
        y: 20,
        rotation: 0,
        side: 'front',
        pads: [input, output].map((netId, i) => ({
          id: uid(),
          number: String(i + 1),
          x: i ? 2.54 : -2.54,
          y: 0,
          rotation: 0,
          type: 'thru_hole',
          shape: 'circle',
          size: { x: 1.8, y: 1.8 },
          drill: 0.8,
          netId,
        })),
        graphics: [
          {
            id: uid(),
            start: { x: -1.5, y: -1 },
            end: { x: 1.5, y: -1 },
            width: 0.15,
            layer: 'F.SilkS',
          },
        ],
      },
      {
        id: uid(),
        symbolId: c.id,
        libraryId: 'OpenPE:C_P5.08',
        x: 30,
        y: 20,
        rotation: 90,
        side: 'back',
        pads: [output, gnd].map((netId, i) => ({
          id: uid(),
          number: String(i + 1),
          x: i ? 2.54 : -2.54,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 1.6, y: 1.2 },
          netId,
        })),
        graphics: [],
      },
    ],
    tracks: [
      {
        id: uid(),
        start: { x: 22.54, y: 20 },
        end: { x: 25, y: 20 },
        width: 0.5,
        layer: 'F.Cu',
        netId: output,
      },
      {
        id: uid(),
        start: { x: 25, y: 20 },
        end: { x: 30, y: 22.54 },
        width: 0.5,
        layer: 'B.Cu',
        netId: output,
      },
    ],
    vias: [{ id: uid(), x: 25, y: 20, diameter: 0.8, drill: 0.4, netId: output }],
    graphics: [
      [10, 10, 40, 10],
      [40, 10, 40, 30],
      [40, 30, 10, 30],
      [10, 30, 10, 10],
    ].map(([x, y, ex, ey]) => ({
      id: uid(),
      start: { x, y },
      end: { x: ex, y: ey },
      width: 0.05,
      layer: 'Edge.Cuts',
    })),
    zones: [
      {
        id: uid(),
        netId: gnd,
        layer: 'B.Cu',
        outline: [
          { x: 11, y: 11 },
          { x: 39, y: 11 },
          { x: 39, y: 29 },
          { x: 11, y: 29 },
        ],
        clearance: 0.3,
        minThickness: 0.2,
        thermalGap: 0.3,
        thermalBridge: 0.3,
      },
    ],
  };
  p.extensions = {
    'org.openpe.example': {
      description: 'Conceptual RC filter; refill zones and verify in KiCad.',
    },
  };
  return p;
}
