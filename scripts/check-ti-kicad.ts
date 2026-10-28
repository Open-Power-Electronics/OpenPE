import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tiDcdcParts } from '../lib/ti-dcdc';
const exec = promisify(execFile);
const cli = process.env.KICAD_CLI || 'kicad-cli';
const root = 'test-results/ti-validation';
await mkdir(root, { recursive: true });
const options = {
  windowsHide: true,
  timeout: 30000,
  env: { ...process.env, KICAD_CONFIG_HOME: path.resolve(`${root}/kicad-config`) },
};
const version = (await exec(cli, ['--version'], options)).stdout.trim();
assert.match(version, /^10\./);
const expected = [
  ['C1:1', 'J1:1', 'U1:1'],
  ['D1:1', 'L1:1', 'U1:2'],
  ['J2:1', 'L1:2', 'R1:1', 'R2:1', 'U1:4'],
  ['C2:1', 'R1:2'],
  ['C1:2', 'C2:2', 'D1:2', 'R2:2', 'U1:3', 'U1:5'],
]
  .map((group) => group.sort().join(','))
  .sort();
for (const entry of tiDcdcParts) {
  const source = `tests/fixtures/ti/${entry.name}.kicad_sch`,
    output = `${root}/${entry.name}.xml`;
  await exec(
    cli,
    ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', output, source],
    options,
  );
  const xml = await readFile(output, 'utf8');
  const nets = [...xml.matchAll(/<net\s[^>]*>([\s\S]*?)<\/net>/g)]
    .map((m) =>
      [...m[1].matchAll(/<node\s+ref="([^"]*)"\s+pin="([^"]*)"/g)]
        .map((n) => `${n[1]}:${n[2]}`)
        .sort()
        .join(','),
    )
    .filter(Boolean)
    .sort();
  assert.deepEqual(nets, expected, entry.name);
  await exec(cli, ['sch', 'export', 'svg', '-e', '-o', `${root}/svg`, source], options);
}
console.log(
  `PASS: KiCad ${version}, six TI exports and all five electrical nets match expected physical pins (not ERC/DRC).`,
);
