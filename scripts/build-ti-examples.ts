import { mkdir, writeFile } from 'node:fs/promises';
import { createTiExample } from '../lib/ti-examples';
import { tiDcdcParts } from '../lib/ti-dcdc';
import { parseProject, serializeProject, exportKiCad } from '../lib/project';
await mkdir('tests/fixtures/ti', { recursive: true });
for (const entry of tiDcdcParts) {
  const project = parseProject(serializeProject(createTiExample(entry.id)));
  await writeFile(`tests/fixtures/ti/${entry.name}.openpe.json`, serializeProject(project));
  await writeFile(`tests/fixtures/ti/${entry.name}.kicad_sch`, exportKiCad(project, 'schematic'));
}
console.log(
  'Generated six TI DC/DC conceptual examples with official KiCad symbols and package assignments.',
);
