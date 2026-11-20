import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHomeExample } from '../lib/create-home-example';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  replaceNativeProjectFile,
} from '../lib/project';
import { parseSExpr, child, children, val } from '../lib/sexpr';
import { prepareExampleFootprints } from '../server/example-footprints.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';
import { ownProject } from '../lib/immutable-project';

const { readNativeProject, writeNativeProject } = createRequire(import.meta.url)(
  '../electron/native-project.cjs',
);

test('Home libraries are native Source files with project-bound names and stable library IDs', async () => {
  let customProjects = 0;
  for (const entry of homeExampleCatalog) {
    const nativePath = homeExampleNativePath(entry.id);
    const project = ownProject(
      projectFromNativeFiles(await readNativeProject(path.resolve(nativePath))),
    );
    const original = projectNativeFiles(project, path.basename(nativePath));
    if (!original.files.some((file) => file.name.includes('.pretty/'))) continue;
    for (const file of original.files)
      assert.equal(
        await readFile(path.join(path.dirname(nativePath), file.name), file.encoding ?? 'utf8'),
        file.source,
      );
    customProjects++;
    for (const stem of ['project', 'my-supply', 'other-supply', 'renamed', 'project']) {
      const renamed = projectNativeFiles(project, `${stem}.kicad_pro`);
      for (const file of original.files) {
        if (file.name.startsWith(`footprints/${entry.file}.pretty/`))
          assert.equal(
            renamed.files.find((item) => item.name === file.name.replace(entry.file, stem))?.source,
            file.source,
          );
        if (/\.kicad_(?:sym|dru)$/.test(file.name))
          assert.equal(
            renamed.files.find((item) => item.name === file.name.replace(entry.file, stem))?.source,
            file.source,
          );
        if (!['fp-lib-table', 'sym-lib-table'].includes(file.name)) continue;
        const before = children(parseSExpr(file.source), 'lib');
        const after = children(
          parseSExpr(renamed.files.find((item) => item.name === file.name)!.source),
          'lib',
        );
        assert.deepEqual(
          after.map((lib) => val(child(lib, 'name'))),
          before.map((lib) => val(child(lib, 'name'))),
        );
        for (const lib of after) {
          const uri = val(child(lib, 'uri')).replace('${KIPRJMOD}/', '');
          assert.ok(uri === `footprints/${stem}.pretty` || uri === `symbols/${stem}.kicad_sym`);
          assert.ok(
            renamed.files.some((item) => item.name === uri || item.name.startsWith(uri + '/')),
          );
        }
      }
      assert.equal(
        renamed.files.find((item) => item.name.endsWith('.kicad_pcb'))!.source,
        original.files.find((item) => item.name.endsWith('.kicad_pcb'))!.source,
      );
    }
  }
  assert.equal(customProjects, 2, 'LM25017 and EMC both retain their actual custom packages.');
});

test('Save as preserves unrelated library names and table descriptions and rejects collisions', () => {
  const project = structuredClone(createHomeExample('emc-flyback-demo', (id) => id));
  const files = project.nativeFiles!.files;
  const symbols = files.find((file) => file.name.endsWith('.kicad_sym'))!;
  files.push({ ...symbols, name: 'vendor.kicad_sym' });
  const table = files.find((file) => file.name === 'sym-lib-table')!;
  table.source = table.source.replace(
    'EMC demo custom',
    '${KIPRJMOD}/symbols/emc-flyback.kicad_sym',
  );
  table.source = table.source.replace(
    JSON.stringify('${KIPRJMOD}/symbols/emc-flyback.kicad_sym'),
    '${KIPRJMOD}/symbols/emc-flyback.kicad_sym',
  );
  const renamed = projectNativeFiles(project, 'personal.kicad_pro');
  assert.equal(
    renamed.files.find((file) => file.name === 'vendor.kicad_sym')!.source,
    symbols.source,
  );
  const lib = children(
    parseSExpr(renamed.files.find((file) => file.name === 'sym-lib-table')!.source),
    'lib',
  )[0];
  assert.equal(val(child(lib, 'descr')), '${KIPRJMOD}/symbols/emc-flyback.kicad_sym');
  assert.equal(val(child(lib, 'uri')), '${KIPRJMOD}/symbols/personal.kicad_sym');
  files.push({ name: 'personal.kicad_dru', source: '(version 1)\n' });
  assert.throws(() => projectNativeFiles(project, 'personal.kicad_pro'));
});

test('custom footprint Source edits survive native Save as and host asset preparation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-custom-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = createHomeExample('reference-lm25017-wson8-flybuck', (id) => id);
  const source = projectNativeFiles(project);
  const custom = source.files.find((file) => file.name.endsWith('.kicad_mod'))!;
  assert.ok(custom);
  const editedSource = custom.source.replace(
    'Shielded Coupled Inductor',
    'Edited coupled inductor',
  );
  assert.notEqual(editedSource, custom.source);
  const edited = replaceNativeProjectFile(project, custom.name, editedSource);
  const destination = path.join(directory, 'my-supply.kicad_pro');
  await prepareExampleFootprints(edited, destination);
  await assert.rejects(readFile(path.join(directory, 'fp-lib-table')), { code: 'ENOENT' });
  const bundle = projectNativeFiles(edited, path.basename(destination));
  await writeNativeProject(destination, bundle, atomicWrite);
  await prepareExampleFootprints(edited, destination);
  assert.equal(
    await readFile(
      path.join(directory, 'footprints', 'my-supply.pretty', path.basename(custom.name)),
      'utf8',
    ),
    editedSource,
  );
  assert.match(
    await readFile(path.join(directory, 'fp-lib-table'), 'utf8'),
    /\$\{KIPRJMOD\}\/footprints\/my-supply\.pretty/,
  );
  await assert.rejects(
    readFile(
      path.join(directory, 'footprints', 'Inductor_SMD_Wurth.pretty', path.basename(custom.name)),
    ),
    { code: 'ENOENT' },
  );
});
