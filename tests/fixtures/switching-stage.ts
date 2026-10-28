// Test-only electrical fixture; never included in the application example catalog.
import {
  emptyCircuit,
  createPart,
  pinPositions,
  uid,
  type Circuit,
  type Kind,
  type Part,
  type Point,
} from '../../lib/circuit';
import { unitGraphics } from '../../lib/library';
import { children, child, val } from '../../lib/sexpr';
import { createProject, exportKiCad } from '../../lib/project';

export function switchingStageFixture(): Circuit {
  const d = emptyCircuit();
  d.title = 'Switching-stage test fixture';
  const add = (kind: Kind, ref: string, value: string, x: number, y: number, rotation = 0) => {
    const p = createPart(d, kind, x, y);
    Object.assign(p, { ref, value, rotation });
    // These terminals explicitly represent the setup's ideal sources/probe.
    if (kind === 'Port') p.excludeFromSimulation = false;
    d.parts.push(p);
    return p;
  };
  const input = add('Port', 'J1', 'VIN · 24V', 25.4, 50.8, 180);
  const cin = add('C', 'C1', '47uF / 50V', 40.64, 66.04);
  const mos = add('NMOS', 'Q1', 'N-MOSFET', 66.04, 58.42, 90);
  const diode = add('D', 'D1', 'Schottky', 83.82, 71.12, 270);
  const inductor = add('L', 'L1', '22uH', 104.14, 55.88, 90);
  const cout = add('C', 'C2', '100uF / 25V', 124.46, 71.12);
  const load = add('R', 'R1', '10Ω / 5W', 144.78, 71.12);
  const output = add('Port', 'J2', 'VOUT · 12V', 162.56, 55.88);
  const pwm = add('Port', 'J3', 'PWM', 66.04, 83.82, 270);
  const g1 = add('GND', '#PWR1', 'GND', 40.64, 96.52);
  const g2 = add('GND', '#PWR2', 'GND', 124.46, 96.52);
  // Derive wire endpoints from the official geometry and pin numbers.
  const pin = (p: Part, number: string) => {
    const pins = unitGraphics(d.libraries[p.libId], 1).flatMap((s) => children(s, 'pin'));
    const index = pins.findIndex((s) => val(child(s, 'number')) === number);
    if (index < 0) throw new Error('Missing official pin: ' + p.libId + ':' + number);
    return pinPositions(p, d.libraries[p.libId])[index];
  };
  const at = (x: number, y: number): Point => ({ x, y });
  const route = (...points: Point[]) => {
    for (let i = 1; i < points.length; i++)
      d.wires.push({ id: uid(), a: points[i - 1], b: points[i] });
  };
  route(pin(input, '1'), at(40.64, 50.8), at(60.96, 50.8), pin(mos, '2'));
  route(at(40.64, 50.8), pin(cin, '1'));
  route(pin(mos, '3'), at(83.82, 55.88), pin(inductor, '1'));
  route(at(83.82, 55.88), pin(diode, '1'));
  route(pin(inductor, '2'), at(124.46, 55.88), at(144.78, 55.88), pin(output, '1'));
  route(at(124.46, 55.88), pin(cout, '1'));
  route(at(144.78, 55.88), pin(load, '1'));
  route(pin(cin, '2'), pin(g1, '1'), at(83.82, 96.52), pin(g2, '1'), at(144.78, 96.52));
  route(pin(diode, '2'), at(83.82, 96.52));
  route(pin(cout, '2'), pin(g2, '1'));
  route(pin(load, '2'), at(144.78, 96.52));
  route(pin(mos, '1'), pin(pwm, '1'));
  d.junctions = [
    [40.64, 50.8],
    [83.82, 55.88],
    [124.46, 55.88],
    [144.78, 55.88],
    [83.82, 96.52],
    [124.46, 96.52],
  ].map(([x, y]) => ({ id: uid(), x, y }));
  d.labels = [{ id: uid(), x: 83.82, y: 55.88, text: 'SW' }];
  return d;
}

export function switchingStageSource() {
  return exportKiCad(createProject(switchingStageFixture()), 'schematic');
}
