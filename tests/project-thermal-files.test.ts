import test from 'node:test';
import assert from 'node:assert/strict';
import fileSystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  defaultThermalConfig,
  thermalFingerprint,
  type ThermalModel,
  type ThermalResult,
} from '../plugins/layout-thermal/domain/thermal';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProjectThermalStore, thermalRunKey } from '../server/project-thermal-files.mjs';
import { withAnalysisFiles } from '../server/flat-analysis-files.mjs';
import { runThermalSimulation } from '../plugins/layout-thermal/host/thermal-runtime.mjs';

const signal = () => new AbortController().signal;
const solver = { gmsh: '4.15.2', elmer: '26.1', identity: 'a'.repeat(64) };
const staticFiles = [
  'board.geo',
  'planar.msh',
  'board.msh',
  'case.sif',
  'gmsh.log',
  'gmsh-output.log',
  'elmer-grid.log',
  'solver.log',
];
const meshFiles = ['mesh.header', 'mesh.nodes', 'mesh.elements', 'mesh.boundary'];
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const testParent = path.resolve('test-results');

function model(meshSizeMm = 2): ThermalModel {
  const polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [],
  };
  const body = {
    version: 1 as const,
    boardId: 'board',
    units: 'mm' as const,
    config: {
      ...defaultThermalConfig(createEmptyPCB()),
      convection: { top: 10, bottom: 10, edge: 0 },
      heatSources: [{ footprintId: 'heater', powerW: 0.01 }],
      meshSizeMm,
    },
    board: [polygon],
    layers: [
      { layer: 'F.Cu' as const, zMin: 0.465, zMax: 0.5, polygons: [polygon] },
      { layer: 'B.Cu' as const, zMin: -0.5, zMax: -0.465, polygons: [polygon] },
    ],
    dielectricLayers: [{ zMin: -0.465, zMax: 0.465 }],
    barrels: [],
    sources: [
      {
        footprintId: 'heater',
        powerW: 0.01,
        reference: 'U1',
        side: 'front' as const,
        polygons: [polygon],
        areaMm2: 100,
      },
    ],
    notices: [],
    assumptions: ['Test material and cooling assumptions.'],
  };
  return { ...body, basis: thermalFingerprint(body) };
}

function result(input: ThermalModel): ThermalResult {
  return {
    version: 1,
    status: 'completed',
    basis: input.basis,
    solver: { gmsh: solver.gmsh, elmer: solver.elmer },
    points: [
      { x: 0, y: 0, z: 0.5, temperatureC: 30 },
      { x: 10, y: 0, z: 0.5, temperatureC: 30 },
      { x: 0, y: 10, z: 0.5, temperatureC: 30 },
    ],
    triangles: [[0, 1, 2]],
    statistics: {
      minC: 30,
      maxC: 30,
      meanC: 30,
      inputPowerW: 0.01,
      outputPowerW: 0.01,
      energyImbalanceRelative: 0,
      nodeCount: 3,
      elementCount: 1,
    },
    assumptions: [...input.assumptions],
    diagnostics: ['Fixture completed.'],
  };
}

async function fixture(fieldInMesh = false) {
  await mkdir(testParent, { recursive: true });
  const root = await mkdtemp(path.join(testParent, 'project-thermal-'));
  const file = path.join(root, 'buck.kicad_pro');
  await writeFile(file, 'native bytes');
  const source = path.join(root, 'temporary-run');
  await mkdir(path.join(source, 'mesh'), { recursive: true });
  for (const name of staticFiles) await writeFile(path.join(source, name), `${name}\n`);
  for (const name of meshFiles) await writeFile(path.join(source, 'mesh', name), `${name}\n`);
  await writeFile(
    path.join(source, fieldInMesh ? 'mesh/thermal_t0001.vtu' : 'thermal_t0001.vtu'),
    '<VTKFile/>\n',
  );
  await writeFile(path.join(source, 'ignored-user-note.txt'), 'Not an analysis artifact.');
  const input = model();
  return {
    root,
    file,
    source,
    input,
    output: result(input),
    parent: path.join(root, 'layout-thermal'),
    store: createProjectThermalStore(() => file),
    async cleanup() {
      assert.equal(path.dirname(path.resolve(root)), testParent);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function savedKey(parent: string) {
  return JSON.parse(await readFile(path.join(parent, 'buck.manifest.json'), 'utf8')).key as string;
}

async function expectedFiles(source: string, input: ThermalModel, output: ThermalResult) {
  const names = [
    ...staticFiles,
    ...(await readdir(source)).filter((name) => /^thermal.*\.(?:vtu|pvd|pvtu)$/.test(name)),
    ...(await readdir(path.join(source, 'mesh'))).map((name) => 'mesh/' + name),
  ];
  const files = [];
  for (const name of names) {
    const bytes = await readFile(path.join(source, name));
    files.push({
      name,
      file: 'buck.' + path.posix.basename(name),
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  for (const [name, text] of [
    ['input.json', JSON.stringify(input)],
    ['result.json', JSON.stringify(output)],
  ])
    files.push({ name, file: 'buck.' + name, size: Buffer.byteLength(text), sha256: sha256(text) });
  return files.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

async function contents(parent: string) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(parent)).map(async (name) => [name, await readFile(path.join(parent, name))]),
    ),
  );
}

test('Layout Thermal saves complete flat artifacts with original logical names, exact bytes and the existing run key', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.read(signal()), null);
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const files = await expectedFiles(f.source, f.input, f.output);
    const logical = files.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
    const key = thermalRunKey(f.input, solver, files);
    assert.equal(
      key,
      sha256(
        JSON.stringify({ format: 'openpe-thermal-v1', model: f.input, solver, files: logical }),
      ),
    );
    assert.equal(key, thermalRunKey(f.input, solver, logical));
    const manifest = JSON.parse(await readFile(path.join(f.parent, 'buck.manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'openpe-thermal-v2');
    assert.equal(manifest.project, 'buck.kicad_pro');
    assert.equal(manifest.key, key);
    assert.deepEqual(manifest.files, files);
    assert.deepEqual(
      (await readdir(f.parent)).sort(),
      [...files.map((file) => file.file), 'buck.manifest.json'].sort(),
    );
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(f.parent, entry.file));
      assert.equal(bytes.length, entry.size);
      assert.equal(sha256(bytes), entry.sha256);
    }
    assert.deepEqual(await createProjectThermalStore(() => f.file).read(signal()), {
      model: f.input,
      result: f.output,
      solver,
    });
    assert.equal(await readFile(f.file, 'utf8'), 'native bytes');
  } finally {
    await f.cleanup();
  }
});

test('flat Layout Thermal results isolate native projects sharing a directory', async () => {
  const f = await fixture();
  try {
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const first = await readFile(path.join(f.parent, 'buck.manifest.json'));
    const otherFile = path.join(f.root, 'other.kicad_pro');
    const other = createProjectThermalStore(() => otherFile);
    assert.equal(await other.read(signal()), null);
    const input = model(3),
      output = result(input);
    await other.write(f.source, input, output, solver, signal());
    assert.deepEqual((await other.read(signal()))?.result, output);
    assert.deepEqual((await f.store.read(signal()))?.result, f.output);
    assert.deepEqual(await readFile(path.join(f.parent, 'buck.manifest.json')), first);
    assert.ok((await readdir(f.parent)).includes('other.mesh.nodes'));
  } finally {
    await f.cleanup();
  }
});

test('Layout Thermal flattens mesh fields and VTK sidecars while retaining original solver input bytes', async () => {
  const f = await fixture(true);
  try {
    const sif = 'Header\n Mesh DB "." "mesh"\nEnd\n';
    await writeFile(path.join(f.source, 'case.sif'), sif);
    for (const name of ['mesh.names', 'thermal.pvd', 'thermal.pvtu'])
      await writeFile(path.join(f.source, 'mesh', name), name);
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const manifest = JSON.parse(await readFile(path.join(f.parent, 'buck.manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest.files.find((entry: { name: string }) => entry.name === 'mesh/thermal_t0001.vtu'),
      {
        name: 'mesh/thermal_t0001.vtu',
        file: 'buck.thermal_t0001.vtu',
        size: 11,
        sha256: sha256('<VTKFile/>\n'),
      },
    );
    assert.equal(await readFile(path.join(f.parent, 'buck.case.sif'), 'utf8'), sif);
    for (const name of [
      ...meshFiles,
      'mesh.names',
      'thermal.pvd',
      'thermal.pvtu',
      'thermal_t0001.vtu',
    ])
      assert.ok((await readFile(path.join(f.parent, 'buck.' + name))).length >= 0);
    assert.deepEqual((await f.store.read(signal()))?.result, f.output);
  } finally {
    await f.cleanup();
  }
});

test('flat Layout Thermal publication preserves unknown sidecars and rejects unowned filename collisions', async () => {
  const f = await fixture();
  try {
    await mkdir(f.parent);
    await writeFile(path.join(f.parent, 'summary.json'), 'user report');
    await writeFile(path.join(f.parent, 'temperature-front.png'), 'user image');
    await writeFile(path.join(f.parent, 'buck.board.geo'), 'unknown geometry');
    await assert.rejects(
      f.store.write(f.source, f.input, f.output, solver, signal()),
      /unknown|unowned|preserve|already exists/i,
    );
    assert.equal(await readFile(path.join(f.parent, 'buck.board.geo'), 'utf8'), 'unknown geometry');
    await rm(path.join(f.parent, 'buck.board.geo'));
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const input = model(3);
    await f.store.write(f.source, input, result(input), solver, signal());
    assert.equal(await readFile(path.join(f.parent, 'summary.json'), 'utf8'), 'user report');
    assert.equal(
      await readFile(path.join(f.parent, 'temperature-front.png'), 'utf8'),
      'user image',
    );
    assert.deepEqual((await f.store.read(signal()))?.model, input);
  } finally {
    await f.cleanup();
  }
});

test('Layout Thermal publication retries sharing locks and rolls back every prior file if manifest publication fails', async (context) => {
  const f = await fixture();
  const originalRename = fileSystem.rename;
  try {
    await f.store.write(f.source, f.input, f.output, solver, signal());
    let attempts = 0,
      denied = false;
    context.mock.method(
      fileSystem,
      'rename',
      async (
        from: Parameters<typeof fileSystem.rename>[0],
        to: Parameters<typeof fileSystem.rename>[1],
      ) => {
        if (
          String(to) === path.join(f.parent, 'buck.manifest.json') &&
          path.basename(path.dirname(String(from))).startsWith('.pending-')
        ) {
          attempts++;
          if (denied || attempts < 3)
            throw Object.assign(new Error('Manifest publication denied.'), { code: 'EACCES' });
        }
        return originalRename(from, to);
      },
    );
    syncBuiltinESMExports();
    const input = model(3);
    await f.store.write(f.source, input, result(input), solver, signal());
    assert.equal(attempts, 3);
    const before = await contents(f.parent);
    denied = true;
    attempts = 0;
    const rejected = model(4);
    await assert.rejects(
      f.store.write(f.source, rejected, result(rejected), solver, signal()),
      /Manifest publication denied/,
    );
    assert.equal(attempts, 5);
    assert.deepEqual(await contents(f.parent), before);
    assert.deepEqual((await f.store.read(signal()))?.model, input);
    assert.equal(
      (await readdir(f.root)).some((name) => name.endsWith('-backups')),
      false,
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('Layout Thermal preserves external edits made after prior-record verification', async (context) => {
  const f = await fixture();
  const originalOpen = fileSystem.open;
  try {
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const before = await contents(f.parent);
    let edited = false;
    context.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
      if (!edited && String(args[0]) === path.join(f.source, 'case.sif')) {
        edited = true;
        await writeFile(path.join(f.parent, 'buck.solver.log'), 'External user edit.');
      }
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    const input = model(3);
    await assert.rejects(
      f.store.write(f.source, input, result(input), solver, signal()),
      /artifact changed.*publication/i,
    );
    assert.equal(edited, true);
    assert.deepEqual(await contents(f.parent), {
      ...before,
      'buck.solver.log': Buffer.from('External user edit.'),
    });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('Layout Thermal replaces obsolete owned field filenames only after a new complete success', async () => {
  const f = await fixture();
  try {
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const first = await savedKey(f.parent);
    await rm(path.join(f.source, 'thermal_t0001.vtu'));
    await writeFile(path.join(f.source, 'thermal_t0002.vtu'), '<VTKFile>new</VTKFile>');
    const input = model(3);
    await f.store.write(f.source, input, result(input), solver, signal());
    assert.notEqual(await savedKey(f.parent), first);
    assert.equal((await readdir(f.parent)).includes('buck.thermal_t0001.vtu'), false);
    assert.equal(
      await readFile(path.join(f.parent, 'buck.thermal_t0002.vtu'), 'utf8'),
      '<VTKFile>new</VTKFile>',
    );
  } finally {
    await f.cleanup();
  }
});

test('incomplete, cancelled and colliding mesh artifacts preserve every prior successful Layout Thermal byte', async () => {
  const f = await fixture();
  try {
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const before = await contents(f.parent);
    const input = model(3);
    await rm(path.join(f.source, 'mesh', 'mesh.nodes'));
    await assert.rejects(
      f.store.write(f.source, input, result(input), solver, signal()),
      /incomplete|missing/,
    );
    await writeFile(path.join(f.source, 'mesh', 'mesh.nodes'), 'mesh.nodes\n');
    await assert.rejects(
      f.store.write(f.source, input, result(input), solver, AbortSignal.abort()),
      /abort/i,
    );
    await writeFile(path.join(f.source, 'thermal.pvd'), 'top field index');
    await writeFile(path.join(f.source, 'mesh', 'thermal.pvd'), 'nested field index');
    await assert.rejects(
      f.store.write(f.source, input, result(input), solver, signal()),
      /collide/i,
    );
    assert.deepEqual(await contents(f.parent), before);
    assert.deepEqual((await f.store.read(signal()))?.result, f.output);
  } finally {
    await f.cleanup();
  }
});

test('flat Layout Thermal validates every artifact, project identity and physical filename before reading or replacement', async () => {
  const f = await fixture();
  try {
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const manifestFile = path.join(f.parent, 'buck.manifest.json');
    const text = await readFile(manifestFile, 'utf8');
    const manifest = JSON.parse(text);
    for (const entry of manifest.files) {
      const file = path.join(f.parent, entry.file);
      const bytes = await readFile(file);
      const bad = Buffer.concat([bytes, Buffer.from('changed')]);
      await writeFile(file, bad);
      await assert.rejects(f.store.read(signal()), /integrity|large|changed/);
      await assert.rejects(
        f.store.write(f.source, f.input, f.output, solver, signal()),
        /integrity|large|changed/,
      );
      assert.deepEqual(await readFile(file), bad);
      await writeFile(file, bytes);
    }
    for (const change of [
      (value: any) => (value.project = 'other.kicad_pro'),
      (value: any) => (value.files[0].file = '../outside'),
      (value: any) => (value.format = 'unknown'),
    ]) {
      const bad = JSON.parse(text);
      change(bad);
      await writeFile(manifestFile, JSON.stringify(bad));
      await assert.rejects(f.store.read(signal()), /manifest/i);
      await assert.rejects(
        f.store.write(f.source, f.input, f.output, solver, signal()),
        /manifest/i,
      );
    }
    await writeFile(manifestFile, text);
    assert.deepEqual((await f.store.read(signal()))?.result, f.output);
  } finally {
    await f.cleanup();
  }
});

test('Layout Thermal ignores retired nested records and preserves their files', async () => {
  const f = await fixture();
  try {
    const files = (await expectedFiles(f.source, f.input, f.output)).map(
      ({ name, size, sha256 }) => ({ name, size, sha256 }),
    );
    const key = thermalRunKey(f.input, solver, files);
    const legacy = path.join(f.parent, 'buck'),
      folder = path.join(legacy, key);
    await mkdir(path.join(folder, 'mesh'), { recursive: true });
    for (const entry of files) {
      if (entry.name === 'input.json')
        await writeFile(path.join(folder, entry.name), JSON.stringify(f.input));
      else if (entry.name === 'result.json')
        await writeFile(path.join(folder, entry.name), JSON.stringify(f.output));
      else await copyFile(path.join(f.source, entry.name), path.join(folder, entry.name));
    }
    await writeFile(
      path.join(folder, 'manifest.json'),
      JSON.stringify({
        format: 'openpe-thermal-v1',
        key,
        createdAt: new Date().toISOString(),
        solver,
        files,
      }),
    );
    await writeFile(
      path.join(legacy, 'latest.json'),
      JSON.stringify({ format: 'openpe-thermal-latest-v1', key }),
    );
    const before = await readFile(path.join(folder, 'manifest.json'));
    assert.equal(await f.store.read(signal()), null);
    await f.store.write(f.source, f.input, f.output, solver, signal());
    assert.equal(await savedKey(f.parent), key);
    assert.deepEqual(await readFile(path.join(folder, 'manifest.json')), before);
  } finally {
    await f.cleanup();
  }
});

test('a cancelled queued Layout Thermal lookup does not observe an empty destination', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const occupied = withAnalysisFiles(f.parent, async () => {
    entered();
    await gate;
  });
  try {
    await started;
    let resolutions = 0;
    const store = createProjectThermalStore(() => {
      resolutions++;
      return f.file;
    });
    const control = new AbortController();
    const pending = store.read(control.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    control.abort();
    release();
    await occupied;
    await rejected;
    assert.equal(resolutions, 1, 'Cancellation is checked before resolving the destination again.');
    await assert.rejects(readdir(f.parent), { code: 'ENOENT' });
  } finally {
    release();
    await occupied;
    await f.cleanup();
  }
});

test('Layout Thermal rechecks live grants before flat publication and preserves the prior result', async () => {
  const f = await fixture();
  try {
    assert.throws(() => createProjectThermalStore(() => null), /Save the project/);
    await f.store.write(f.source, f.input, f.output, solver, signal());
    const before = await contents(f.parent);
    let calls = 0;
    let granted: string | null = f.file;
    const store = createProjectThermalStore(() => {
      if (++calls === 3) granted = null;
      return granted;
    });
    const input = model(3);
    await assert.rejects(
      store.write(f.source, input, result(input), solver, signal()),
      /grant or destination changed/,
    );
    assert.deepEqual(await contents(f.parent), before);
    assert.deepEqual((await f.store.read(signal()))?.result, f.output);
  } finally {
    await f.cleanup();
  }
});

test('Layout Thermal rejects linked source files and destination folders without touching targets', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, 'untouched');
    await mkdir(outside);
    await writeFile(path.join(outside, 'notes.txt'), 'user data');
    await symlink(
      outside,
      path.join(f.root, 'layout-thermal'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(f.store.read(signal()), /without links/);
    await assert.rejects(
      f.store.write(f.source, f.input, f.output, solver, signal()),
      /without links/,
    );
    await rm(path.join(f.root, 'layout-thermal'));
    await rm(path.join(f.source, 'solver.log'));
    await link(path.join(outside, 'notes.txt'), path.join(f.source, 'solver.log'));
    await assert.rejects(
      f.store.write(f.source, f.input, f.output, solver, signal()),
      /without links/,
    );
    assert.equal(await readFile(path.join(outside, 'notes.txt'), 'utf8'), 'user data');
  } finally {
    await f.cleanup();
  }
});

test(
  'real Layout Thermal completion saves flat slab artifacts before temporary cleanup',
  { skip: process.env.OPENPE_TEST_THERMAL !== '1' },
  async () => {
    const f = await fixture();
    let completedDirectory = '';
    try {
      const input = model(5);
      const output = await runThermalSimulation(
        input,
        signal(),
        undefined,
        undefined,
        async ({
          directory,
          result: completed,
          solver: runtime,
        }: {
          directory: string;
          result: ThermalResult;
          solver: typeof solver;
        }) => {
          completedDirectory = directory;
          await f.store.write(directory, input, completed, runtime, signal());
        },
      );
      assert.deepEqual((await f.store.read(signal()))?.result, output);
      for (const name of [
        ...staticFiles,
        'input.json',
        'result.json',
        'manifest.json',
        ...meshFiles,
      ])
        assert.ok((await readFile(path.join(f.parent, 'buck.' + name))).length >= 0, name);
      await assert.rejects(readdir(completedDirectory), { code: 'ENOENT' });
    } finally {
      await f.cleanup();
    }
  },
);
