import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createProject,
  parseProject,
  serializeProject,
  appendSchematic,
  schematicFileFingerprint,
  projectFromNativeFiles,
  projectNativeFiles,
} from '../lib/project';
import {
  simulationModelDefinitions,
  simulationModelReferenceForFile,
  validateSimulationModels,
} from '../lib/simulation-models';
import {
  prepareProjectModelFiles,
  readProjectModelFile,
  writeProjectModelFile,
} from '../server/project-model-files.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { fetchModelResponse } from '../server/model-download.mjs';
import { startServer } from '../server/index.mjs';
import { createTiExample } from '../lib/ti-examples';
import { defaultTransient } from '../lib/spice';

const model = simulationModelDefinitions[0];

test('model filenames identify component variants and remain unique on case-insensitive filesystems', () => {
  for (const [id, filename] of Object.entries({
    'lm2596-3.3': 'LM2596-3.3.lib',
    'lm2596-5': 'LM2596-5.lib',
    'lm2596-12': 'LM2596-12.lib',
    'reference-lm2735y': 'LM2735Y.lib',
    'reference-lm5001': 'LM5001.lib',
    'reference-lm27761': 'LM27761.lib',
    'reference-lm25017': 'LM25017.lib',
    'reference-tps61046': 'TPS61046.lib',
    'reference-lmr12010x': 'LMR12010X.lib',
    'reference-lmr70503': 'LMR70503.lib',
    'reference-lm2598-adj': 'LM2598-ADJ.lib',
  }))
    assert.equal(
      simulationModelDefinitions.find((definition) => definition.id === id)?.file,
      `circuits/${filename}`,
    );
  const filenames = simulationModelDefinitions.map((definition) => definition.file);
  for (const filename of filenames) {
    assert.match(filename, /^circuits\/[A-Za-z0-9_.-]+\.lib$/);
    assert.doesNotMatch(filename, /reference-|-[a-f0-9]{64}\.lib$/);
  }
  assert.equal(new Set(filenames.map((filename) => filename.toLowerCase())).size, filenames.length);
});

test('native imports and Save as retain current component model filenames and reject retired aliases', () => {
  const reference = { ...model };
  validateSimulationModels([reference]);
  assert.deepEqual(simulationModelReferenceForFile(model.file), reference);
  const project = createProject();
  project.simulationModels = [reference];
  const imported = projectFromNativeFiles(projectNativeFiles(project, 'original.kicad_pro'));
  assert.deepEqual(imported.simulationModels, [reference]);
  const copy = projectNativeFiles(imported, 'copy.kicad_pro');
  assert.deepEqual(projectFromNativeFiles(copy).simulationModels, [reference]);
  for (const directory of ['circuits', 'circuit', 'models']) {
    const file = directory + '/' + model.id + '-' + model.sha256 + '.lib';
    assert.equal(simulationModelReferenceForFile(file), undefined);
    assert.throws(() => validateSimulationModels([{ ...model, file }]), /simulation model/i);
    const retired = structuredClone(copy);
    const entry = retired.files.find((file) => file.name === retired.entry)!;
    const settings = JSON.parse(entry.source);
    settings.text_variables.OPENPE_SIMULATION_MODELS = JSON.stringify([file]);
    entry.source = JSON.stringify(settings);
    assert.throws(() => projectFromNativeFiles(retired), /simulation model/i);
  }
});

test('model references roundtrip as design content while keeping all schematic data intact', () => {
  const project = appendSchematic(createProject()).project;
  const fingerprint = schematicFileFingerprint(project, project.schematic.id);
  const before = serializeProject(project);
  project.simulationModels = [{ ...model }];
  const source = serializeProject(project),
    restored = parseProject(source);
  assert.notEqual(source, before);
  assert.deepEqual(restored.simulationModels, [model]);
  assert.equal(schematicFileFingerprint(restored, project.schematic.id), fingerprint);
  assert.deepEqual(restored.additionalSchematics, parseProject(before).additionalSchematics);
  assert.equal(serializeProject(restored), source);
  assert.doesNotMatch(source, /"(?:data|encoding)"/);
});

test('project validation rejects arbitrary paths, hashes, IDs, duplicate references and embedded bytes', () => {
  for (const patch of [
    { file: '../model.lib' },
    { file: 'C:/model.lib' },
    { file: 'models/custom.lib' },
    { file: 'circuit/custom.lib' },
    { file: 'circuits/custom.lib' },
    { sha256: '0'.repeat(64) },
    { id: 'custom' },
    { data: 'ZXhlYw==' },
  ]) {
    const document = JSON.parse(serializeProject(createProject()));
    document.simulationModels = [{ ...model, ...patch }];
    assert.throws(
      () => parseProject(JSON.stringify(document)),
      /simulation model|additional properties/i,
    );
  }
  assert.throws(() => validateSimulationModels([model, model]), /duplicate/);
  assert.throws(() => validateSimulationModels(new Array(33).fill(model)), /32/);
});

test('sidecar reads are bounded, preserve invalid files and reject model-directory junctions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-files-'));
  try {
    const projectFile = path.join(root, 'project.openpe.json');
    assert.equal(await readProjectModelFile(projectFile, model), null);
    await mkdir(path.join(root, 'circuits'));
    const file = path.join(root, model.file);
    await writeFile(file, 'corrupt original');
    await assert.rejects(readProjectModelFile(projectFile, model), /integrity/);
    await assert.rejects(
      writeProjectModelFile(projectFile, model, Buffer.from('replacement')),
      /integrity/,
    );
    assert.equal(await readFile(file, 'utf8'), 'corrupt original');
    await writeFile(file, new Uint8Array(128 * 1024 + 1));
    await assert.rejects(readProjectModelFile(projectFile, model), /128 KB/);
    const other = path.join(root, 'another-project');
    await mkdir(other);
    await symlink(
      path.join(root, 'circuits'),
      path.join(other, 'circuits'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      readProjectModelFile(path.join(other, 'project.openpe.json'), model),
      /real directory/,
    );
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('current source models copy offline and retired aliases cannot supply project models', async () => {
  const pinned = simulationModelDefinitions.find((definition) => definition.id === 'lm2596-5')!;
  const bytes = await readFile(
    path.join(
      'resources/example-catalog/simulation/models',
      pinned.id + '-' + pinned.sha256 + '.lib',
    ),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-portability-'));
  try {
    const source = path.join(root, 'source', 'source.kicad_pro');
    const destination = path.join(root, 'destination', 'copy.kicad_pro');
    for (const file of [source, destination]) await mkdir(path.dirname(file), { recursive: true });
    const retainedModel = path.join(path.dirname(destination), 'models', 'personal.step');
    await mkdir(path.dirname(retainedModel), { recursive: true });
    await writeFile(retainedModel, 'personal STEP geometry');
    const store = async () => {
      throw new Error('Source copy must remain offline.');
    };
    for (const directory of ['circuits', 'circuit', 'models']) {
      const file = directory + '/' + pinned.id + '-' + pinned.sha256 + '.lib';
      const alias = path.join(path.dirname(source), file);
      await mkdir(path.dirname(alias), { recursive: true });
      await writeFile(alias, bytes);
      await assert.rejects(
        prepareProjectModelFiles(
          { simulationModels: [pinned] },
          destination,
          source,
          store,
          new AbortController().signal,
        ),
        /Source copy must remain offline/,
      );
      await assert.rejects(readProjectModelFile(source, { ...pinned, file }), /simulation model/i);
      assert.deepEqual(await readFile(alias), bytes);
    }
    await writeProjectModelFile(source, pinned, bytes);
    await prepareProjectModelFiles(
      { simulationModels: [pinned] },
      destination,
      source,
      store,
      new AbortController().signal,
    );
    assert.deepEqual(await readProjectModelFile(destination, pinned), bytes);
    const referenced: string[] = [];
    const scoped = projectSimulationModels(
      { simulationModels: [pinned] },
      store,
      {
        read: async (_grant: string, reference: typeof pinned) => {
          referenced.push(reference.file);
          return bytes;
        },
        write: async (_grant: string, reference: typeof pinned) => {
          referenced.push(reference.file);
        },
      },
      'opaque-grant',
    );
    assert.deepEqual(await scoped.store(pinned.id, new AbortController().signal), bytes);
    assert.deepEqual(referenced, [pinned.file, pinned.file]);
    assert.equal(await readFile(retainedModel, 'utf8'), 'personal STEP geometry');
    const target = path.join(path.dirname(destination), pinned.file);
    await writeFile(target, 'personal model changes');
    await assert.rejects(
      prepareProjectModelFiles(
        { simulationModels: [pinned] },
        destination,
        source,
        store,
        new AbortController().signal,
      ),
      /integrity/,
    );
    assert.equal(await readFile(target, 'utf8'), 'personal model changes');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('unverified downloads and revoked grants cannot create project references or model files', async () => {
  const project = createProject();
  let writes = 0,
    downloads = 0;
  const files = {
    read: async () => {
      throw new Error('Grant revoked.');
    },
    write: async () => {
      writes++;
    },
  };
  const store = async () => {
    downloads++;
    return Buffer.from('unverified');
  };
  const scoped = projectSimulationModels(project, store, files, 'opaque-grant');
  await assert.rejects(scoped.store(model.id, new AbortController().signal), /revoked/);
  assert.equal(downloads, 0);
  const invalid = projectSimulationModels(project, store);
  await assert.rejects(invalid.store(model.id, new AbortController().signal), /integrity/);
  assert.deepEqual(invalid.models, []);
  assert.equal(writes, 0);
  assert.equal(project.simulationModels, undefined);
});

test('download failures distinguish connectivity, timeout and cancellation', async () => {
  const failure = new TypeError('fetch failed');
  const fetcher = async () => {
    throw failure;
  };
  await assert.rejects(
    fetchModelResponse(fetcher, 'https://www.ti.com', {}, 'TI'),
    /TI simulation model download could not connect.*system proxy/,
  );
  const timeout = AbortSignal.abort(new DOMException('timeout', 'TimeoutError'));
  await assert.rejects(
    fetchModelResponse(fetcher, 'https://www.ti.com', { signal: timeout }, 'TI'),
    /timed out/,
  );
  const cancelled = AbortSignal.abort();
  await assert.rejects(
    fetchModelResponse(fetcher, 'https://www.ti.com', { signal: cancelled }, 'TI'),
    (error) => error === failure,
  );
});

test('simulation HTTP uses the injected desktop downloader and returns an actionable network failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-api-'));
  let downloads = 0;
  const server = await startServer({
    dataDir: root,
    simulationModelFetcher: async (url, options) => {
      downloads++;
      assert.match(String(url), /^https:\/\/www\.ti\.com\/lit\/zip\//);
      assert.equal(options?.redirect, 'manual');
      throw new TypeError('fetch failed');
    },
    simulationRunner: async (
      _deck: unknown,
      signal: AbortSignal,
      store: (id: string, signal: AbortSignal) => Promise<Buffer>,
    ) => {
      await store('lm2596-5', signal);
      throw new Error('The runner must not reach the solver after a failed model download.');
    },
  });
  try {
    const project = createTiExample('Regulator_Switching:LM2596S-5');
    const referenced = serializeProject(project);
    delete project.simulationModels;
    const response = await fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token },
      body: JSON.stringify({
        source: serializeProject(project),
        config: defaultTransient(project.schematic),
      }),
    });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /model download could not connect.*system proxy/);
    assert.equal(downloads, 1);
    const missing = await fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token },
      body: JSON.stringify({ source: referenced, config: defaultTransient(project.schematic) }),
    });
    assert.equal(missing.status, 422);
    assert.match((await missing.json()).error, /Run does not download referenced models/);
    assert.equal(downloads, 1, 'A referenced model cannot trigger a runtime download.');
  } finally {
    server.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
