import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createLibraryService } from '../server/libraries.mjs';
import {
  createProject,
  createLibraryPart,
  validateProject,
  parseSExpr,
  children,
  child,
  val,
} from '../server/library-format.mjs';
import { exportKiCad, parseProject, serializeProject } from '../server/project-format.mjs';
const service = createLibraryService({ dataDir: '.openpe/library-check' });
try {
  const status = await service.request({ action: 'status' });
  assert.ok(status.symbols > 20000);
  assert.ok(status.footprints > 15000);
  const starters = JSON.parse(await readFile('lib/kicad-starter-symbols.json', 'utf8'));
  for (const [id, symbol] of Object.entries(starters)) {
    const official = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(official.error, undefined);
    assert.deepEqual(symbol, official.symbol, `${id} must match the downloaded official library`);
  }
  const project = createProject();
  for (const id of [
    'Device:R',
    'Device:C',
    'Transistor_FET:2N7002',
    'Amplifier_Operational:LM358',
    'Connector_Generic:Conn_01x04',
  ]) {
    const detail = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(detail.error, undefined, `${id}: ${detail.error}`);
    project.schematic.libraries[id] = detail.symbol;
    for (let unit = 1; unit <= detail.units; unit++)
      project.schematic.parts.push(
        createLibraryPart(
          project.schematic,
          detail.symbol,
          25.4 + project.schematic.parts.length * 25.4,
          50.8,
          unit,
        ),
      );
  }
  project.schematic.parts[0].fields.Footprint = 'Resistor_SMD:R_0805_2012Metric';
  validateProject(project);
  const recovered = parseProject(serializeProject(project));
  const exported = parseSExpr(exportKiCad(recovered, 'schematic'));
  assert.equal(children(exported, 'symbol').length, project.schematic.parts.length);
  const field = children(children(exported, 'symbol')[0], 'property').find(
    (p) => val(p) === 'Footprint',
  );
  assert.equal(val(field, 2), 'Resistor_SMD:R_0805_2012Metric');
  for (const id of [
    'Resistor_SMD:R_0805_2012Metric',
    'Capacitor_SMD:C_0805_2012Metric',
    'Package_TO_SOT_SMD:SOT-23',
  ]) {
    const f = await service.request({ action: 'detail', kind: 'footprints', id });
    assert.ok(f.pads.length >= 2);
    assert.ok(f.models.length);
    const model = await service.model(id, 0);
    assert.ok(model.meshes.length);
    assert.ok(model.meshes.every((m) => m.index.array.length > 0));
    console.log(`${id}: ${f.pads.length} pads, ${model.meshes.length} real STEP mesh(es)`);
  }
  assert.equal(val(child(exported, 'version')), '20260306');
  if (process.env.KICAD_CLI) {
    const dir = path.resolve('test-results/library-cli');
    await mkdir(dir, { recursive: true });
    const input = path.join(dir, 'official-library.kicad_sch'),
      output = path.join(dir, 'official-library.xml');
    await writeFile(input, exportKiCad(recovered, 'schematic'));
    const exec = promisify(execFile),
      options = {
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, KICAD_CONFIG_HOME: path.join(dir, 'config') },
      };
    const version = (await exec(process.env.KICAD_CLI, ['--version'], options)).stdout.trim();
    assert.match(version, /^10\./);
    await exec(
      process.env.KICAD_CLI,
      ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', output, input],
      options,
    );
    const netlist = await readFile(output, 'utf8');
    assert.ok(netlist.includes('R_0805_2012Metric'));
    assert.ok(netlist.includes('LM358'));
    console.log(
      `KiCad CLI ${version}: self-contained official-symbol export accepted. This is not ERC.`,
    );
  }
  console.log(
    `PASS: ${status.symbols} official symbols, ${status.footprints} official footprints; inheritance, multi-unit placement, project/field round trips, STEP parsing. No installed KiCad resources used.`,
  );
} finally {
  service.close();
}
