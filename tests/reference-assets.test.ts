import { modelReferenceKey, resolveExampleModelRelative } from '../lib/example-model-paths';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import manifest from '../resources/example-catalog/manifest.json';
import { homeExampleCatalog } from '../lib/home-examples';
import assets from '../resources/example-catalog/footprints/manifest.json';
import { parseProject, projectNativeFiles } from '../lib/project';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import {
  exampleFootprintDetail,
  exampleModelBytes,
  prepareExampleFootprints,
} from '../server/example-footprints.mjs';

const root = 'resources/example-catalog/footprints';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('examples and sibling project contain the ten self-contained projects and pinned assets', async () => {
  assert.equal(existsSync('examples/project'), false);
  assert.equal(existsSync('recent'), false);
  assert.deepEqual(readdirSync('project'), ['emc-flyback']);
  const stems = manifest.examples.map((entry) => entry.file).sort();
  const rootEntries = readdirSync('examples', { withFileTypes: true });
  assert.deepEqual(
    rootEntries.map((entry) => entry.name).sort(),
    Array.from(
      new Set(
        homeExampleCatalog
          .filter((entry) => entry.root === 'examples')
          .map((entry) => entry.directory.split('/')[0]),
      ),
    ).sort(),
  );
  assert.ok(rootEntries.every((entry) => entry.isDirectory()));
  for (const extension of ['kicad_pro', 'kicad_sch', 'kicad_pcb']) {
    assert.deepEqual(
      rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(`.${extension}`))
        .map((entry) => entry.name)
        .sort(),
      [],
      `Native ${extension} files belong in individual circuit directories.`,
    );
  }
  for (const entry of homeExampleCatalog) {
    assert.ok(existsSync(`${entry.root}/${entry.directory}`));
    assert.deepEqual(
      readdirSync(`${entry.root}/${entry.directory}`)
        .filter((file) => /\.kicad_(?:pro|sch|pcb)$/.test(file))
        .sort(),
      ['kicad_pcb', 'kicad_pro', 'kicad_sch'].map((extension) => `${entry.file}.${extension}`),
    );
    const directory = `${entry.root}/${entry.directory}`;
    assert.ok(JSON.parse(readFileSync(`${directory}/${entry.file}.kicad_pro`, 'utf8')).meta);
    const board = parseSExpr(readFileSync(`${directory}/${entry.file}.kicad_pcb`, 'utf8'));
    let linkedModels = 0;
    for (const footprint of children(board, 'footprint'))
      for (const model of children(footprint, 'model')) {
        const reference = val(model);
        assert.match(reference, /^\$\{KIPRJMOD\}\/models\/[^/]+\.step$/, entry.file);
        const pinnedHash = modelReferenceKey(reference);
        assert.match(pinnedHash, /^[a-f0-9]{64}$/, reference);
        assert.equal(
          digest(readFileSync(`${directory}/${reference.slice('${KIPRJMOD}/'.length)}`)),
          pinnedHash,
          `${entry.file}: native STEP reference retains pinned bytes`,
        );
        linkedModels++;
      }
    assert.ok(linkedModels > 0, `${entry.file}: actual native board retains model assignments`);
  }
  for (const stem of stems)
    assert.equal(existsSync(`examples/${stem}/datasheets/parameters.json`), false);
  for (const entry of homeExampleCatalog)
    assert.ok(readdirSync(`resources/example-catalog/sources/${entry.file}`).length > 0);
  assert.deepEqual(
    readdirSync('resources/example-catalog/sources').sort(),
    homeExampleCatalog.map((entry) => entry.file).sort(),
  );
  const exampleFiles = homeExampleCatalog.map((entry) => entry.file + '.kicad_pro');
  assert.ok(exampleFiles.every((file) => !file.includes('reference')));
  assert.equal(exampleFiles.length, 10);
  assert.equal(readdirSync('examples').filter((file) => file.endsWith('.openpe.json')).length, 0);
  assert.equal(assets.footprints.length, 46);
  assert.equal(Object.keys(assets.models).length, 46);
  for (const model of Object.values(assets.models)) {
    const bytes = readFileSync(`${root}/${model.file}`);
    assert.equal(digest(bytes), model.sha256, model.file);
    assert.match(bytes.subarray(0, 100).toString(), /ISO-10303-21/);
  }
  for (const entry of manifest.examples) {
    const project = parseProject(
      readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8'),
    );
    for (const footprint of project.pcb!.footprints) {
      const asset = assets.footprints.find((item) => item.id === footprint.libraryId);
      assert.ok(asset, footprint.libraryId);
      assert.ok(footprint.models?.length, footprint.libraryId);
      for (const model of footprint.models) {
        const relative = resolveExampleModelRelative(asset.models, model.path)!;
        assert.ok(asset.models.includes(relative));
        assert.ok(await exampleModelBytes(footprint.libraryId, relative));
      }
    }
  }
  assert.equal(await exampleModelBytes('Unknown:Part', '../secret.step'), null);
  assert.equal(await exampleFootprintDetail('../secret'), null);
});

test('custom WE-DD package retains its four physical terminals and loads from the fixed asset registry', async () => {
  const id = 'Inductor_SMD_Wurth:L_Wurth_WE-DD-7345straight';
  const detail = await exampleFootprintDetail(id);
  assert.ok(detail);
  assert.deepEqual(detail.pads.sort(), ['1', '2', '3', '4']);
  assert.equal(val(child(detail.footprint, 'descr')).includes('7.3x7.3x4.5mm'), true);
  assert.ok(
    children(detail.footprint, 'pad').every(
      (pad: Parameters<typeof child>[0]) => !child(pad, 'net'),
    ),
  );
  assert.equal(detail.models.length, 1);
  assert.equal(detail.models[0].path, '${KIPRJMOD}/models/L_Wurth_WE-DD-7345straight.step');
});

test('other Reference regression inputs retain current-format projects and accurate pinned source paths outside examples', () => {
  const directory = 'tests/fixtures/reference-retired';
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.openpe.json'))) {
    const project = parseProject(readFileSync(`${directory}/${file}`, 'utf8'));
    const provenance = project.extensions['org.openpe.reference-example'] as {
      source: {
        schematic: { path: string; sha256: string };
        pcb: { path: string; sha256: string };
      };
    };
    for (const source of [provenance.source.schematic, provenance.source.pcb]) {
      assert.ok(source.path.startsWith(`${directory}/upstream/`));
      assert.equal(digest(readFileSync(source.path)), source.sha256);
    }
  }
});

test('native example assets copy offline, remain idempotent and preserve invalid existing files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-footprints-'));
  try {
    const project = parseProject(
      readFileSync('tests/fixtures/reference/lm25017-wson8-flybuck.json', 'utf8'),
    );
    const file = path.join(directory, 'project.openpe.json');
    await prepareExampleFootprints(project, file);
    await prepareExampleFootprints(project, file);
    const native = projectNativeFiles(project, 'project.kicad_pro');
    assert.match(
      native.files.find((file) => file.name === 'fp-lib-table')!.source,
      /KIPRJMOD.*project\.pretty/,
    );
    assert.ok(native.files.some((file) => file.name.startsWith('footprints/project.pretty/')));
    await assert.rejects(readFile(path.join(directory, 'fp-lib-table')), { code: 'ENOENT' });
    const model = project.pcb!.footprints[0].models![0].path.replace('${KIPRJMOD}/', '');
    const target = path.join(directory, model);
    assert.match((await readFile(target)).subarray(0, 100).toString(), /ISO-10303-21/);
    await writeFile(target, 'keep invalid original');
    await assert.rejects(prepareExampleFootprints(project, file), /Preserved unchanged/);
    assert.equal(await readFile(target, 'utf8'), 'keep invalid original');
    const linked = path.join(directory, 'linked');
    await mkdir(linked);
    const linkedModelDirectory = model.split('/')[0];
    await symlink(
      path.join(directory, linkedModelDirectory),
      path.join(linked, linkedModelDirectory),
      'junction',
    );
    await assert.rejects(
      prepareExampleFootprints(project, path.join(linked, 'project.openpe.json')),
      /real directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
