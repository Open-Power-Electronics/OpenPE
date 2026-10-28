import {
  emptyCircuit,
  libraries,
  pinPositions,
  uid,
  parseCircuit,
  serializeCircuit,
  type Part,
  type Point,
} from './circuit';
import { createLibraryPart, unitGraphics } from './library';
import { child, children, val } from './sexpr';
import { createProject } from './project';
import { tiPart, tiDatasheet, tiProduct } from './ti-dcdc';
import { arrangeExampleText } from './example-layout';
import { simulationModelDefinitions } from './simulation-models';

/** OpenPE-authored conceptual circuit; only symbol geometry comes from KiCad. */
export function createTiExample(id: string) {
  const entry = tiPart(id);
  if (!entry) throw new Error('No example is available for this TI component.');
  const d = emptyCircuit();
  d.title = `${entry.name} Buck converter`;
  const add = (libId: string, x: number, y: number, value?: string, rotation = 0) => {
    d.libraries[libId] = structuredClone(libraries[libId]);
    const p = createLibraryPart(d, d.libraries[libId], x, y);
    if (value) p.value = value;
    p.rotation = rotation;
    d.parts.push(p);
    return p;
  };
  const pin = (p: Part, number: string): Point => {
    const pins = unitGraphics(d.libraries[p.libId]).flatMap((u) => children(u, 'pin'));
    return pinPositions(p, d.libraries[p.libId])[
      pins.findIndex((p) => val(child(p, 'number')) === number)
    ];
  };
  const route = (...points: Point[]) => {
    for (let i = 1; i < points.length; i++)
      d.wires.push({ id: uid(), a: { ...points[i - 1] }, b: { ...points[i] } });
  };
  const point = (x: number, y: number) => ({ x, y });
  const terminal = (x: number, y: number, value: string) => {
    const p = add('Connector_Generic:Conn_01x01', x, y, value);
    // Internal legacy fixture terminals are the explicitly selected ideal sources/probe.
    p.excludeFromSimulation = false;
    const start = pin(p, '1');
    p.x += x - start.x;
    p.y += y - start.y;
    return p;
  };
  const input = terminal(30.48, 48.26, 'VIN');
  const regulator = add(id, 76.2, 50.8);
  const cin = add('Device:C', 43.18, 66.04, '470uF');
  const diode = add('Device:D_Schottky', 96.52, 68.58, 'Schottky', 270);
  const inductor = add('Device:L', 111.76, 53.34, '68uH', 90);
  const esr = add('Device:R', 134.62, 63.5, '0.08');
  const cout = add('Device:C', 134.62, 78.74, '220uF');
  const load = add('Device:R', 157.48, 71.12, String(entry.model.voltage));
  const output = terminal(175.26, 53.34, 'VOUT');
  const ground = add('power:GND', 76.2, 88.9);
  route(pin(input, '1'), pin(regulator, '1'));
  route(point(cin.x, 48.26), pin(cin, '1'));
  route(pin(regulator, '2'), pin(inductor, '1'));
  route(point(diode.x, 53.34), pin(diode, '1'));
  route(pin(inductor, '2'), pin(output, '1'));
  route(
    pin(regulator, '4'),
    point(91.44, 48.26),
    point(91.44, 35.56),
    point(144.78, 35.56),
    point(144.78, 53.34),
  );
  route(point(esr.x, 53.34), pin(esr, '1'));
  route(pin(esr, '2'), pin(cout, '1'));
  route(point(load.x, 53.34), pin(load, '1'));
  route(pin(regulator, '5'), point(58.42, 53.34), point(58.42, 88.9));
  route(pin(regulator, '3'), pin(ground, '1'));
  for (const p of [cin, diode, cout, load]) route(pin(p, '2'), point(p.x, 88.9));
  route(point(cin.x, 88.9), point(load.x, 88.9));
  for (const [x, y] of [
    [43.18, 48.26],
    [96.52, 53.34],
    [134.62, 53.34],
    [144.78, 53.34],
    [157.48, 53.34],
    [58.42, 88.9],
    [76.2, 88.9],
    [96.52, 88.9],
    [134.62, 88.9],
  ])
    d.junctions.push({ id: uid(), x, y });
  for (const [text, p, n] of [['SW', regulator, '2']] as const)
    d.labels.push({ id: uid(), text, ...pin(p, n) });
  const materialized = parseCircuit(serializeCircuit(d));
  arrangeExampleText(materialized, 'ti-lm2596');
  const project = createProject(materialized);
  project.simulationModels = simulationModelDefinitions
    .filter((model) => model.id === entry.model.id)
    .map((model) => ({ ...model }));
  project.extensions = {
    'openpe.ti-example': {
      manufacturer: 'Texas Instruments',
      component: entry.name,
      model: entry.model.id,
      product: tiProduct,
      datasheet: tiDatasheet,
      description:
        'OpenPE conceptual fixed-output Buck, 24 V input and nominal 1 A resistive load. Generic diode and ideal passives; explicit 80 mΩ output capacitor ESR. Not a TI reference design or production-validated circuit.',
    },
  };
  return project;
}
