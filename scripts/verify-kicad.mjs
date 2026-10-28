import { tsImport } from 'tsx/esm/api';
const { switchingStageSource } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const cli = process.env.KICAD_CLI || 'kicad-cli';
await mkdir('test-results/kicad-svg', { recursive: true });
await writeFile('test-results/switching-stage.kicad_sch', switchingStageSource());
const options = {
  windowsHide: true,
  timeout: 30000,
  env: { ...process.env, KICAD_CONFIG_HOME: path.resolve('test-results/kicad-config') },
};
const version = (await exec(cli, ['--version'], options)).stdout.trim();
assert.match(
  version,
  /^10\./,
  `KiCad 10 is required for this compatibility check; found ${version}`,
);
// Compare real KiCad connectivity before/after conversion of official demos.
const manifest = JSON.parse(await readFile('tests/fixtures/kicad/manifest.json', 'utf8'));
const connectivity = (xml) =>
  [...xml.matchAll(/<net\s[^>]*>([\s\S]*?)<\/net>/g)]
    .map((m) =>
      [...m[1].matchAll(/<node\s+ref="([^"]*)"\s+pin="([^"]*)"/g)]
        .map((n) => `${n[1]}:${n[2]}`)
        .sort()
        .join(','),
    )
    .filter(Boolean)
    .sort();
for (const entry of manifest.examples) {
  const netlists = [];
  for (const [label, source] of [
    ['upstream', `tests/fixtures/kicad/upstream/${entry.file}`],
    ['export', `tests/fixtures/kicad/${entry.id}.kicad_sch`],
  ]) {
    const output = `test-results/${entry.id}-${label}.xml`;
    await exec(
      cli,
      ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', output, source],
      options,
    );
    netlists.push(connectivity(await readFile(output, 'utf8')));
  }
  assert.ok(netlists[0].length > 0);
  assert.deepEqual(netlists[1], netlists[0], `${entry.id}: exported electrical nets changed`);
  await exec(
    cli,
    [
      'sch',
      'export',
      'svg',
      '-e',
      '-o',
      'test-results/kicad-svg',
      `tests/fixtures/kicad/${entry.id}.kicad_sch`,
    ],
    options,
  );
}
console.log(
  `PASS: KiCad ${version} preserves official demo pin connectivity and exports their SVGs (not simulation/ERC).`,
);
await exec(
  cli,
  [
    'sch',
    'export',
    'netlist',
    '--format',
    'kicadxml',
    '-o',
    'test-results/switching-stage-netlist.xml',
    'test-results/switching-stage.kicad_sch',
  ],
  options,
);
await exec(
  cli,
  [
    'sch',
    'export',
    'svg',
    '-e',
    '-o',
    'test-results/kicad-svg',
    'test-results/switching-stage.kicad_sch',
  ],
  options,
);
const xml = await readFile('test-results/switching-stage-netlist.xml', 'utf8');
const nets = [...xml.matchAll(/<net\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)].map((m) => ({
  name: m[1],
  nodes: [...m[2].matchAll(/<node\s+ref="([^"]*)"\s+pin="([^"]*)"/g)]
    .map((n) => n[1] + ':' + n[2])
    .sort(),
}));
assert.equal(nets.length, 5);
for (const group of [
  ['C1:1', 'J1:1', 'Q1:2'],
  ['D1:1', 'L1:1', 'Q1:3'],
  ['C2:1', 'J2:1', 'L1:2', 'R1:1'],
  ['C1:2', 'C2:2', 'D1:2', 'R1:2'],
  ['J3:1', 'Q1:1'],
])
  assert.ok(
    nets.some((n) => JSON.stringify(n.nodes) === JSON.stringify(group.sort())),
    `Missing net: ${group}`,
  );
console.log('PASS: KiCad schematic loading, SVG export and all five expected electrical nets.');
await exec(
  cli,
  [
    'sch',
    'export',
    'netlist',
    '--format',
    'kicadxml',
    '-o',
    'test-results/rc-filter-netlist.xml',
    'tests/fixtures/rc-filter.kicad_sch',
  ],
  options,
);
await exec(
  cli,
  [
    'pcb',
    'export',
    'svg',
    '--layers',
    'F.Cu,B.Cu,Edge.Cuts',
    '--page-size-mode',
    '2',
    '--mode-single',
    '-o',
    'test-results/rc-filter-pcb.svg',
    'tests/fixtures/rc-filter.kicad_pcb',
  ],
  options,
);
await exec(
  cli,
  [
    'pcb',
    'export',
    'ipc2581',
    '-o',
    'test-results/rc-filter-pcb.xml',
    'tests/fixtures/rc-filter.kicad_pcb',
  ],
  options,
);
const rcNets = await readFile('test-results/rc-filter-netlist.xml', 'utf8');
assert.match(rcNets, /name="\/OUT"/);
assert.match(rcNets, /ref="R1" pin="2"/);
assert.match(rcNets, /ref="C1" pin="1"/);
const pcbXml = await readFile('test-results/rc-filter-pcb.xml', 'utf8');
assert.match(pcbXml, /IPC-2581/);
assert.match(pcbXml, /refDes="R1"/);
assert.match(pcbXml, /refDes="C1"/);
const copperPads = [];
for (const layer of pcbXml.matchAll(
  /<LayerFeature layerRef="([FB]\.Cu)">([\s\S]*?)<\/LayerFeature>/g,
)) {
  for (const set of layer[2].matchAll(/<Set net="([^"]+)"[^>]*>([\s\S]*?)<\/Set>/g)) {
    for (const pad of set[2].matchAll(/<Pad\s[^>]*>([\s\S]*?)<\/Pad>/g)) {
      const pin = pad[1].match(/<PinRef componentRef="([^"]+)" pin="([^"]+)"/);
      const location = pad[1].match(/<Location x="([^"]+)" y="([^"]+)"/);
      if (pin && location)
        copperPads.push({
          layer: layer[1],
          net: set[1],
          pin: pin[1] + ':' + pin[2],
          x: Number(location[1]),
          y: -Number(location[2]),
        });
    }
  }
}
for (const expected of [
  { layer: 'F.Cu', net: '/IN', pin: 'R1:1', x: 17.46, y: 20 },
  { layer: 'F.Cu', net: '/OUT', pin: 'R1:2', x: 22.54, y: 20 },
  { layer: 'B.Cu', net: '/OUT', pin: 'C1:1', x: 30, y: 22.54 },
  { layer: 'B.Cu', net: 'GND', pin: 'C1:2', x: 30, y: 17.46 },
])
  assert.ok(
    copperPads.some((p) => Object.entries(expected).every(([k, v]) => p[k] === v)),
    `KiCad changed pad placement or net: ${JSON.stringify(expected)}`,
  );
console.log(
  `PASS: KiCad ${version} reads native schematic and PCB exports and generates netlist, board SVG and IPC-2581 manufacturing exchange data (not ERC/DRC validation).`,
);
