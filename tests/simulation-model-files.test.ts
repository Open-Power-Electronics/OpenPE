import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  prepareBoundTiModelFiles,
  readProjectModelFile,
  writeProjectModelFile,
} from '../server/project-model-files.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { fetchModelResponse } from '../server/model-download.mjs';
import { startServer } from '../server/index.mjs';
import { createReferenceExample } from '../lib/reference-examples';
import { exportZip } from '../lib/export-zip';
import { partFields } from '../lib/library';
import { buildSpiceDeck, defaultTransient } from '../plugins/spice-simulation/domain/spice';

const model = simulationModelDefinitions[0];

test('model filenames identify component variants and remain unique on case-insensitive filesystems', () => {
  for (const [id, filename] of Object.entries({
    'lm2596-5': 'LM2596-5.lib',
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
      `models/${filename}`,
    );
  const filenames = simulationModelDefinitions.map((definition) => definition.file);
  for (const filename of filenames) {
    assert.match(filename, /^models\/[A-Za-z0-9_.-]+\.lib$/);
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
  for (const directory of ['spice-simulation/models', 'circuit', 'models']) {
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
    { file: 'models/custom.lib' },
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
    await mkdir(path.join(root, 'models'), { recursive: true });
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
      path.join(root, 'models'),
      path.join(other, 'models'),
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
    for (const directory of ['spice-simulation/models', 'circuit', 'models']) {
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
    const project = createReferenceExample('reference-lm2596-to220-5-buck');
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

test('TI packages require a current search and return only bounded declared models', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-ti-selection-'));
  const bytes = await readFile('examples/lm5001-soic8-boost/models/LM5001.lib');
  const fileId = '8d748757-960d-4b0a-a2b5-f5d320e74839';
  const id = 'reference-lm5001';
  const file = 'models/LM5001.lib';
  const archive = 'SNVM921';
  const modelSource =
    '* original TI test library\n.subckt example A B\nR1 A B 1k\n.ends DifferentName\n';
  const fixtureZip = Buffer.concat([
    exportZip([
      { name: 'example.lib', source: modelSource },
      {
        name: 'dependent.lib',
        source: '.include "other.lib"\n.subckt dependent A B\n.ends dependent\n',
      },
      { name: 'encrypted.lib', source: '.subckt encrypted A B\n$CDNENCSTART\n.ends encrypted\n' },
      { name: 'metadata.txt', source: 'TI model package' },
    ]),
    Buffer.from([0xff]),
  ]);
  let granted = true;
  let colocated = true;
  let downloads = 0;
  let encryptedDownloads = 0;
  let location: string | null = null;
  let changeLocation = false;
  const searches: string[] = [];
  const card = (link: string, file: string, title: string) => `
    <div class="u-font-size-small">Simulation model</div>
    <h4 class="u-text-breakword"><a href="${link}">${title}</a></h4>
    <div>${file}.ZIP (27 KB) - PSpice model</div>
  `;
  const server = await startServer({
    dataDir: root,
    simulationModelFiles: {
      location: (grant: string) => {
        if (grant !== fileId || !granted) throw new Error('The project grant expired.');
        return location;
      },
      read: async (grant: string, model: { id: string; file: string }) => {
        assert.equal(grant, fileId);
        assert.equal(model.id, id);
        assert.equal(model.file, file);
        if (changeLocation) location = path.join(root, 'changed.kicad_pro');
        return colocated ? bytes : null;
      },
      write: async () => assert.fail('Selecting a TI model must not write project files.'),
    },
    simulationModelFetcher: async (url, options) => {
      if (String(url).includes('/product/')) {
        searches.push(String(url));
        assert.equal(options?.redirect, 'error');
        assert.equal(options?.cache, 'no-store');
        assert.equal(options?.credentials, 'omit');
        if (String(url).includes('UNKNOWN-PART')) return new Response(null, { status: 404 });
        if (String(url).includes('LM25017'))
          return new Response(`
          <meta name="idio:page-subtype" content="product" />
          ${card('/lit/zip/SNVM209', 'SNVM209', 'LM25017 PSpice Transient Model')}
          ${card('/lit/zip/SNVMAM0', 'SNVMAM0', 'LM25017 Unencrypted PSpice Transient Model')}
          ${card('/lit/zip/CYPHER', 'CYPHER', 'Encrypted PSpice model')}
          ${card('/lit/zip/UNKNWN', 'UNKNWN', 'PSpice model without an encryption label')}
        `);
        if (String(url).includes('LM5001'))
          return new Response(`
          <meta name="idio:page-subtype" content="product" />
          ${card('/lit/zip/SNVM921', 'SNVM921', 'LM5001 PSpice transient model')}
        `);
        return new Response(`
          <meta name="idio:page-subtype" content="product" />
          ${card('https://www.ti.com/lit/zip/SLVMB38', 'SLVMB38A', 'Unencrypted TPS61046 PSpice Transient Model Package (Rev. A)')}
          ${card('/lit/zip/SLVMB38', 'SLVMB38A', 'Duplicate')}
          ${card('/lit/zip/ABCDEF', 'ABCDEF', 'New &amp; unreviewed PSpice model')}
          ${card('https://other.test/lit/zip/BADZIP', 'BADZIP', 'Foreign model')}
          ${card('/lit/zip/INVALI', 'UNRELATED', 'Unrelated filename')}
        `);
      }
      if (String(url) === 'https://www.ti.com/lit/zip/UNKNWN') {
        encryptedDownloads++;
        return new Response(
          Buffer.from(
            exportZip([
              {
                name: 'encrypted.lib',
                source: '.subckt encrypted A B\n$CDNENCSTART\n.ends encrypted\n',
              },
            ]),
          ),
        );
      }
      downloads++;
      assert.equal(options?.redirect, 'manual');
      if (String(url) === 'https://www.ti.com/lit/zip/ABCDEF') return new Response(fixtureZip);
      assert.equal(String(url), 'https://www.ti.com/lit/zip/snvm921');
      return new Response('Changed archive.');
    },
  });
  const select = (body: unknown, token = server.token, extraHeaders = {}) =>
    fetch(server.base + '/api/simulation/ti-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': token, ...extraHeaders },
      body: JSON.stringify(body),
    });
  const search = (body: unknown) =>
    fetch(server.base + '/api/simulation/ti-model-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await search({ fileId, partNumber: '../bad' })).status, 400);
    assert.equal(
      (await search({ fileId, partNumber: 'TPS61046', url: 'https://other.test' })).status,
      400,
    );
    assert.deepEqual(searches, []);
    const live = await search({ fileId, partNumber: 'tps61046' });
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), {
      partNumber: 'TPS61046',
      models: [
        {
          archive: 'SLVMB38A',
          title: 'Unencrypted TPS61046 PSpice Transient Model Package (Rev. A)',
          encryption: 'unencrypted',
          modelId: 'reference-tps61046',
        },
        { archive: 'ABCDEF', title: 'New & unreviewed PSpice model', encryption: 'unknown' },
      ],
    });
    assert.equal(downloads, 0, 'Online search reads only the TI product page.');
    const imported = await select({ fileId, archive: 'ABCDEF' });
    assert.equal(imported.status, 200);
    const sha256 = createHash('sha256').update(modelSource).digest('hex');
    const library = `models/ti/${sha256}/example.lib`;
    assert.deepEqual(await imported.json(), {
      libraries: [
        {
          path: library,
          models: [{ name: 'example', kind: 'subcircuit', pins: ['A', 'B'] }],
          issues: [],
        },
      ],
    });
    const project = createReferenceExample('reference-lm5001-soic8-boost');
    delete project.simulationModels;
    const controller = project.schematic.parts.find(({ ref }) => ref === 'U1')!;
    controller.fields = {
      ...partFields(controller),
      'Sim.Library': library,
      'Sim.Name': 'example',
    };
    const bundle = projectNativeFiles(project, 'imported.kicad_pro');
    const destination = path.join(root, 'imported.kicad_pro');
    await prepareBoundTiModelFiles(project, bundle, destination, null, root);
    const sidecar = bundle.files.find(({ name }) => name === library)!;
    assert.equal(sidecar.source, modelSource);
    assert.equal(projectFromNativeFiles(bundle).simulationModels, undefined);
    assert.throws(() => buildSpiceDeck(project.schematic, defaultTransient(project.schematic)));
    sidecar.source += '* modified';
    await assert.rejects(
      prepareBoundTiModelFiles(project, bundle, destination, null, root),
      /has changed/,
    );
    const noPart = await search({ fileId, partNumber: 'UNKNOWN-PART' });
    assert.equal(noPart.status, 200);
    assert.deepEqual(await noPart.json(), { partNumber: 'UNKNOWN-PART', models: [] });
    assert.deepEqual(searches, [
      'https://www.ti.com/product/TPS61046?locale=en-US',
      'https://www.ti.com/product/UNKNOWN-PART?locale=en-US',
    ]);
    const lm25017 = () =>
      search({ fileId, partNumber: 'LM25017' }).then((response) => response.json());
    assert.deepEqual(
      (await lm25017()).models.map(
        ({ archive, encryption }: { archive: string; encryption: string }) => [archive, encryption],
      ),
      [
        ['SNVM209', 'encrypted'],
        ['SNVMAM0', 'unencrypted'],
        ['CYPHER', 'encrypted'],
        ['UNKNWN', 'unknown'],
      ],
    );
    const blocked = async (archive: string) => {
      const response = await select({ fileId, archive });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, 'OPENPE_TI_MODEL_ENCRYPTED');
    };
    await blocked('SNVM209');
    await blocked('CYPHER');
    assert.equal(encryptedDownloads, 0);
    await blocked('UNKNWN');
    assert.equal((await lm25017()).models.at(-1).encryption, 'encrypted');
    await blocked('UNKNWN');
    assert.equal(encryptedDownloads, 1, 'Known encrypted packages do not fetch an archive again.');
    assert.equal(downloads, 1);
    assert.equal((await select({ fileId, archive }, 'invalid')).status, 401);
    assert.equal(
      (await select({ fileId, archive }, server.token, { Origin: 'https://other.test' })).status,
      403,
    );
    assert.equal((await select({ fileId, archive, url: 'https://other.test' })).status, 400);
    assert.equal((await select({ fileId, archive: 'emc-flyback-control' })).status, 400);
    assert.equal((await select({ fileId, archive })).status, 422);
    assert.equal((await search({ fileId, partNumber: 'LM5001' })).status, 200);
    const response = await select({ fileId, archive });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      libraries: [
        {
          path: file,
          models: [
            {
              name: 'LM5001_TRANS',
              kind: 'subcircuit',
              pins: ['SW', 'VIN', 'VCC', 'GND', 'RT', 'FB', 'COMP', 'EN'],
            },
          ],
          issues: [],
        },
      ],
    });
    assert.equal(downloads, 1);
    changeLocation = true;
    const stale = await select({ fileId, archive });
    assert.equal(stale.status, 422);
    assert.match((await stale.json()).error, /location changed/);
    changeLocation = false;
    granted = false;
    assert.equal((await select({ fileId, archive })).status, 422);
    assert.equal(downloads, 1);
    granted = true;
    colocated = false;
    const changed = await select({ fileId, archive });
    assert.equal(changed.status, 422);
    assert.match((await changed.json()).error, /integrity/);
    assert.equal(downloads, 2);
    const disable = await fetch(server.base + '/api/workbench-plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token },
      body: JSON.stringify({ action: 'disable', id: 'spice-simulation@openpe' }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await select({ fileId, archive })).status, 403);
    assert.equal((await search({ fileId, partNumber: 'TPS61046' })).status, 403);
    assert.equal(downloads, 2);
  } finally {
    server.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('TI bindings carry verified sidecars into Save as before the first completed run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-ti-save-'));
  try {
    const project = createReferenceExample('reference-lm5001-soic8-boost');
    delete project.simulationModels;
    const bundle = projectNativeFiles(project, 'copy.kicad_pro');
    const bytes = await readFile('examples/lm5001-soic8-boost/models/LM5001.lib');
    const file = 'models/LM5001.lib';
    const source = path.join(root, 'original', 'original.kicad_pro');
    const destination = path.join(root, 'copy.kicad_pro');
    await mkdir(path.join(root, 'original', 'models'), { recursive: true });
    await writeFile(path.join(root, 'original', file), bytes);
    await prepareBoundTiModelFiles(project, bundle, destination, source, root);
    const added = bundle.files.find(({ name }) => name === file);
    assert.ok(added);
    assert.deepEqual(Buffer.from(added.source, added.encoding), bytes);
    assert.equal(projectFromNativeFiles(bundle).simulationModels, undefined);
    assert.equal(project.simulationModels, undefined);
    const previous = structuredClone(bundle);
    await prepareBoundTiModelFiles(project, bundle, destination, source, root);
    assert.deepEqual(bundle, previous);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
