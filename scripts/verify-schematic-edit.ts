import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPart, emptyCircuit, pinPositions, uid, type Circuit } from '../lib/circuit';
import { createProject, exportKiCad } from '../lib/project';
import { moveSelection, transformSelection } from '../lib/schematic-edit';
import { children, child, val } from '../lib/sexpr';
import { unitGraphics } from '../lib/library';
const exec = promisify(execFile),
  cli = process.env.KICAD_CLI || 'kicad-cli';
const options = {
  windowsHide: true,
  timeout: 30000,
  env: { ...process.env, KICAD_CONFIG_HOME: path.resolve('test-results/kicad-config') },
};
const version = (await exec(cli, ['--version'], options)).stdout.trim();
assert.match(version, /^10\./);
await mkdir('test-results/schematic-edit', { recursive: true });
async function netlist(d: Circuit, name: string) {
  const source = `test-results/schematic-edit/${name}.kicad_sch`,
    output = `test-results/schematic-edit/${name}.xml`;
  await writeFile(source, exportKiCad(createProject(d), 'schematic'));
  await exec(
    cli,
    ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', output, source],
    options,
  );
  const xml = await readFile(output, 'utf8');
  return [...xml.matchAll(/<net\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)].map((m) => ({
    name: m[1],
    nodes: [...m[2].matchAll(/<node\s+ref="([^"]*)"\s+pin="([^"]*)"/g)]
      .map((n) => n[1] + ':' + n[2])
      .sort(),
  }));
}
// Asymmetric geometry exercises the axis order independently of our parser.
const d = emptyCircuit();
for (const rotation of [0, 90, 180, 270])
  for (const mirror of [undefined, 'x', 'y'] as const) {
    const p = createPart(
      d,
      'NMOS',
      25.4 + (d.parts.length % 4) * 45.72,
      25.4 + Math.floor(d.parts.length / 4) * 45.72,
    );
    p.rotation = rotation;
    if (mirror) p.mirror = mirror;
    d.parts.push(p);
    const numbers = unitGraphics(d.libraries[p.libId], 1)
      .flatMap((s) => children(s, 'pin'))
      .map((n) => val(child(n, 'number')));
    pinPositions(p, d.libraries[p.libId]).forEach((pin, i) =>
      d.labels.push({
        id: uid(),
        ...pin,
        text: `${p.ref}_P${numbers[i]}`,
        scope: 'global',
        shape: 'input',
      }),
    );
  }
const nets = await netlist(d, 'mirrors');
for (const p of d.parts)
  for (const number of ['1', '2', '3'])
    assert.deepEqual(
      nets.find((n) => n.name === `${p.ref}_P${number}`)?.nodes,
      [`${p.ref}:${number}`],
      `${p.ref} rotation=${p.rotation} mirror=${p.mirror} pin=${number}`,
    );
const fixture = emptyCircuit(),
  r = createPart(fixture, 'R', 25.4, 25.4),
  c = createPart(fixture, 'C', 50.8, 25.4);
fixture.parts.push(r, c);
const rp = pinPositions(r, fixture.libraries[r.libId]),
  cp = pinPositions(c, fixture.libraries[c.libId]);
fixture.wires = [{ id: uid(), a: rp[0], b: cp[0] }];
fixture.noConnects = [
  { id: uid(), ...rp[1] },
  { id: uid(), ...cp[1] },
];
fixture.labels = [{ id: uid(), ...rp[0], text: 'SENSE', scope: 'global', shape: 'input' }];
const before = await netlist(fixture, 'before-drag'),
  moved = moveSelection(fixture, [r.id], { x: 5.08, y: 10.16 }, true),
  after = await netlist(moved, 'after-drag');
const topology = (nets: Awaited<ReturnType<typeof netlist>>) =>
  nets.map((n) => n.nodes.join(',')).sort();
assert.deepEqual(topology(after), topology(before));
assert.deepEqual(after.find((n) => n.name === 'SENSE')?.nodes, ['C1:1', 'R1:1']);
const middle = createPart(fixture, 'R', 38.1, 25.4);
fixture.parts.push(middle);
fixture.noConnects.push({ id: uid(), ...pinPositions(middle, fixture.libraries[middle.libId])[1] });
const teeBefore = await netlist(fixture, 'tee-before');
const movedWire = moveSelection(fixture, [fixture.wires[0].id], { x: 0, y: 10.16 }, true);
assert.deepEqual(
  topology(await netlist(movedWire, 'tee-wire-drag')),
  topology(teeBefore),
  'Dragging a wire does not attach an unrelated pin drawn over its interior',
);
fixture.junctions.push({ id: uid(), ...pinPositions(middle, fixture.libraries[middle.libId])[0] });
const connectedTee = await netlist(fixture, 'connected-tee');
assert.deepEqual(
  topology(
    await netlist(
      moveSelection(fixture, [fixture.wires[0].id], { x: 0, y: 10.16 }, true),
      'connected-tee-drag',
    ),
  ),
  topology(connectedTee),
  'An explicit interior junction retains its pin connection',
);
fixture.junctions.pop();
fixture.parts.pop();
fixture.noConnects.pop();
// Group rotation and both mirror operations preserve pin-to-wire alignment.
for (const operation of ['rotate', 'mirrorX', 'mirrorY'] as const) {
  const transformed = transformSelection(
    fixture,
    [...fixture.parts, ...fixture.wires, ...fixture.labels, ...fixture.noConnects].map((p) => p.id),
    operation,
  );
  assert.deepEqual(topology(await netlist(transformed, operation)), topology(before));
}
console.log(
  `PASS: KiCad ${version}: 36 mirrored/rotated pin labels, global labels, no-connects and connected drag/group transforms. Not ERC.`,
);
