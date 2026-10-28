import { mkdir, writeFile } from 'node:fs/promises';
import { exampleProject } from '../lib/project-example';
import { exportKiCad, parseProject, serializeProject } from '../lib/project';
import { createExample, type ExampleId } from '../lib/examples';
import manifest from '../tests/fixtures/kicad/manifest.json';
await mkdir('tests/fixtures/kicad', { recursive: true });
const project = parseProject(serializeProject(exampleProject()));
await writeFile('tests/fixtures/rc-filter.openpe.json', serializeProject(project), 'utf8');
await writeFile('tests/fixtures/rc-filter.kicad_sch', exportKiCad(project, 'schematic'), 'utf8');
await writeFile('tests/fixtures/rc-filter.kicad_pcb', exportKiCad(project, 'pcb'), 'utf8');
console.log('Generated RC filter private snapshot and native KiCad schematic / PCB.');
for (const entry of manifest.examples) {
  const official = parseProject(serializeProject(createExample(entry.id as ExampleId)));
  await writeFile(`tests/fixtures/kicad/${entry.id}.openpe.json`, serializeProject(official));
  await writeFile(`tests/fixtures/kicad/${entry.id}.kicad_sch`, exportKiCad(official, 'schematic'));
}
console.log('Generated official KiCad private fixtures and native schematic exports.');
