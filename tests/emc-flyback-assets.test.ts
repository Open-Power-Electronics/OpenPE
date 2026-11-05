import { exampleModelPath, resolveExampleModelRelative } from '../lib/example-model-paths';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProject } from '../lib/project';
import { createHomeExample } from '../lib/create-home-example';
import { createEmptyPCB, createPCBFootprint } from '../lib/pcb-layout';
import { createPart, emptyCircuit, uid } from '../lib/circuit';
import { child, parseSExpr, val } from '../lib/sexpr';
import { footprintModels, resolveFootprintModels } from '../lib/pcb-models';
import { previewFootprint, type PreviewFootprint } from '../lib/pcb-preview-cache';
import {
  exampleFootprintDetail,
  exampleModelBytes,
  prepareExampleFootprints,
} from '../server/example-footprints.mjs';
import {
  appendEmcFootprintModels,
  emcProjectAssets,
  verifyEmcFlybackAssets,
} from '../server/emc-flyback-assets.mjs';
import emcManifest from '../resources/example-catalog/emc-flyback-assets.json';

const prefix = '${KIPRJMOD}/models/';

test('enclosure sources stay pinned without being exposed as PCB footprint resources', async () => {
  assert.equal(emcManifest.mechanicalSources.length, 2);
  assert.equal(Object.keys(emcManifest.models).length, 31);
  for (const name of ['Case_UChannel_revD', 'Cover_PMMA_revD']) {
    const id = `EMC_Demo:${name}`;
    assert.equal(
      emcManifest.footprints.some((entry) => entry.id === id),
      false,
    );
    assert.equal(await exampleFootprintDetail(id), null);
    assert.equal(await exampleModelBytes(id, `emc-flyback-demo/${name}.step`), null);
    const evidence = emcManifest.mechanicalSources.find((entry) =>
      entry.file.endsWith(`/${name}.kicad_mod`),
    )!;
    const bytes = await readFile(`resources/example-catalog/sources/emc-flyback/${evidence.file}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), evidence.sha256);
  }
});

test('EMC assets retain standard footprint identity and original fixed model choices', async () => {
  assert.equal(await verifyEmcFlybackAssets(), 40 + emcManifest.supplementalLicenses.length);
  const detail = {
    id: 'Diode_SMD:D_SMA',
    footprint: parseSExpr(`(footprint "D_SMA" (layer "F.Cu")
      (pad "1" smd rect (at -2 0))
      (model "\${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_SMA.step"
        (offset (xyz 1 2 3)) (scale (xyz 2 3 4)) (rotate (xyz 5 6 7))
        hide (opacity 0.25)))`),
    models: [{ path: '${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_SMA.step' }],
  };
  const before = structuredClone(detail);
  const amended = appendEmcFootprintModels(detail.id, detail);
  assert.equal(amended.id, detail.id);
  assert.equal(amended.footprint, detail.footprint);
  assert.equal(child(amended.footprint, 'pad'), child(detail.footprint, 'pad'));
  assert.equal(child(amended.footprint, 'model'), child(detail.footprint, 'model'));
  assert.deepEqual(detail, before, 'The official footprint and metadata remain unchanged.');
  assert.equal(detail.models.length, 1);
  assert.equal(amended.models.length, 2);
  assert.equal(amended.models[1].path, prefix + 'D_SMA.step');
  assert.deepEqual(footprintModels(amended.footprint), [
    {
      path: detail.models[0].path,
      offset: { x: 1, y: 2, z: 3 },
      scale: { x: 2, y: 3, z: 4 },
      rotation: { x: 5, y: 6, z: 7 },
      hidden: true,
      opacity: 0.25,
    },
  ]);
  assert.equal(appendEmcFootprintModels(detail.id, amended), amended);
  const bytes = await exampleModelBytes(detail.id, 'emc-flyback-demo/D_SMA.step');
  assert.deepEqual(
    bytes,
    await readFile(
      'resources/example-catalog/sources/emc-flyback/design/EMC_Demo.3dshapes/D_SMA.step',
    ),
  );
  assert.equal(await exampleModelBytes(detail.id, 'emc-flyback-demo/../D_SMA.step'), null);
  assert.equal(await exampleModelBytes('Unrelated:Package', 'emc-flyback-demo/D_SMA.step'), null);
  const custom = await exampleFootprintDetail('EMC_Demo:TO-220-3_BottomMount_CaseHeatsink');
  assert.equal(custom.id, 'EMC_Demo:TO-220-3_BottomMount_CaseHeatsink');
  assert.deepEqual(custom.pads, ['1', '2', '3']);
  assert.equal(val(child(custom.footprint, 'version')), '20260206');
  assert.equal(custom.models[0].path, prefix + 'TO-220-3_BottomMount_CaseHeatsink.step');
  assert.deepEqual(footprintModels(custom.footprint), []);
});

test('every EMC board model resolves and its exact bytes travel with a whole-project copy', async () => {
  const project = createHomeExample('emc-flyback-demo');
  const before = JSON.stringify(project);
  const previousFetch = globalThis.fetch;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-emc-complete-'));
  globalThis.fetch = async () => {
    throw new Error('Pinned EMC assets must remain available offline.');
  };
  try {
    const expected = new Map<string, Buffer>();
    const assigned = project.pcb!.footprints.filter((footprint) => footprint.models?.length);
    assert.equal(assigned.length, 83);
    assert.deepEqual(
      project
        .pcb!.footprints.filter((footprint) => !footprint.models?.length)
        .map((footprint) => footprint.reference ?? footprint.libraryId)
        .sort(),
      ['MH1', 'MH2', 'MH3', 'MH4', 'MountingHole:MountingHole_3.2mm_M3_Pad_Via'],
      'Mounting holes intentionally have no component model.',
    );
    for (const footprint of assigned)
      for (const model of footprint.models!) {
        const relative = resolveExampleModelRelative(Object.keys(emcManifest.models), model.path)!;
        const bytes = await exampleModelBytes(footprint.libraryId, relative);
        assert.ok(bytes, `${footprint.reference}: assigned model must resolve`);
        expected.set(relative, bytes);
        const entry = emcManifest.models[relative as keyof typeof emcManifest.models];
        assert.ok(entry, `${relative}: model must have a pinned hash`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
        assert.equal(bytes.length, entry.size);
      }
    assert.equal(expected.size, 29);
    const assets = await emcProjectAssets(project);
    assert.equal(assets.filter((asset) => asset.file.startsWith('models/')).length, 29);
    for (const entry of emcManifest.supplementalLicenses)
      assert.ok(
        assets.some(
          (asset) => asset.file === `licenses/emc-flyback-demo/manufacturer/${entry.file}`,
        ),
        'Manufacturer source and license notices accompany their models.',
      );
    await prepareExampleFootprints(project, path.join(directory, 'flyback.kicad_pro'));
    await assert.rejects(readFile(path.join(directory, 'NOTICE.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(directory, 'licenses/emc-flyback-demo/LICENSE')), {
      code: 'ENOENT',
    });
    for (const [relative, bytes] of expected)
      assert.deepEqual(
        await readFile(path.join(directory, exampleModelPath(relative))),
        bytes,
        `${relative}: native destination receives unchanged STEP bytes`,
      );
    assert.equal(JSON.stringify(project), before, 'Copying preserves native paths and transforms.');
  } finally {
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('EMC verification rejects missing or changed manufacturer assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-emc-incomplete-'));
  try {
    await assert.rejects(verifyEmcFlybackAssets(undefined, directory), /missing|ENOENT/i);
    const first = Object.values(emcManifest.models).find(
      (entry) => 'supplemental' in entry && entry.supplemental,
    )!;
    const file = path.join(directory, first.file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'changed manufacturer model');
    await assert.rejects(verifyEmcFlybackAssets(undefined, directory), /checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('board preview sees EMC standard links and every custom jack color without altering assignments', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const standard = appendEmcFootprintModels('Diode_SMD:D_SMA', {
    id: 'Diode_SMD:D_SMA',
    footprint: parseSExpr(`(footprint "D_SMA" (layer "F.Cu")
      (pad "1" smd rect (at -2 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
      (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
      (model "\${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_SMA.step"
        (offset (xyz 1 2 3)) (scale (xyz 2 3 4)) (rotate (xyz 5 6 7))
        hide (opacity 0.25)))`),
    models: [{ path: '${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_SMA.step' }],
  });
  const jack = await exampleFootprintDetail('EMC_Demo:Jack_4mm_RA_Cliff_FCR7350');
  const details = new Map<string, PreviewFootprint & { id: string }>(
    [standard, jack].map((detail) => [detail.id, detail]),
  );
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 12.7, 12.7);
  circuit.parts.push(part);
  const placed = createPCBFootprint(standard, circuit, part.id, { x: 25.4, y: 25.4 });
  assert.deepEqual(placed.models, footprintModels(standard.footprint));
  assert.equal(placed.models!.length, 1, 'Placement keeps the single official default model.');
  const before = JSON.stringify({ standard, jack, placed });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openpe: { connection: async () => ({ base: 'http://127.0.0.1:17342', token: 'test' }) },
    },
  });
  globalThis.fetch = async (url) => {
    const request = new URL(String(url));
    assert.equal(request.pathname, '/api/libraries/footprints');
    if (request.searchParams.get('id') === 'Test:DefaultModel')
      return Response.json({ footprint: standard.footprint });
    const detail = details.get(request.searchParams.get('id')!);
    assert.ok(detail);
    return Response.json(detail);
  };
  try {
    const signal = new AbortController().signal;
    for (const detail of details.values()) {
      const source = await previewFootprint(detail.id, signal);
      const models = source.models;
      assert.deepEqual(
        models.map((model) => model.path),
        detail.models.map((model) => model.path),
      );
      assert.deepEqual(source.footprint, detail.footprint);
      assert.deepEqual(Object.keys(source).sort(), ['footprint', 'models']);
      assert.equal(
        await previewFootprint(detail.id, signal),
        source,
        'Cached details keep choices.',
      );
      for (const model of models.filter((item) => item.path.startsWith(prefix))) {
        const assigned = {
          path: model.path,
          offset: { x: 1.25, y: -2.5, z: 3.75 },
          scale: { x: 2, y: 1, z: 0.5 },
          rotation: { x: 90, y: 180, z: 270 },
          opacity: 0.4,
        };
        const footprint = { ...placed, models: [assigned] };
        assert.equal(resolveFootprintModels(footprint, source.footprint), footprint.models);
        assert.equal(
          models.findIndex((item) => item.path === assigned.path),
          detail.models.findIndex((item) => item.path === assigned.path),
        );
      }
    }
    const fallback = await previewFootprint('Test:DefaultModel', signal);
    assert.deepEqual(fallback.models, [{ path: standard.models[0].path }]);
    assert.equal(jack.models.length, 3);
    assert.equal(JSON.stringify({ standard, jack, placed }), before);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('EMC model copying is exact, bounded to selected references and preserves differing assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-emc-assets-'));
  const project = createProject();
  project.pcb = createEmptyPCB();
  project.pcb.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Diode_SMD:D_SMA',
      reference: 'D1',
      value: 'D',
      x: 5,
      y: 5,
      rotation: 0,
      side: 'front',
      pads: [],
      graphics: [],
      models: [
        {
          path: prefix + 'D_SMA.step',
          offset: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      ],
    },
  ];
  const filename = path.join(directory, 'demo.kicad_pro');
  const before = JSON.stringify(project);
  try {
    const noticeFile = path.join(directory, 'NOTICE.txt');
    await prepareExampleFootprints(project, filename);
    await assert.rejects(readFile(noticeFile), { code: 'ENOENT' });
    await writeFile(noticeFile, 'Personal project note');
    await prepareExampleFootprints(project, filename);
    assert.equal(await readFile(noticeFile, 'utf8'), 'Personal project note');
    const copied = path.join(directory, 'models/D_SMA.step');
    assert.deepEqual(
      await readFile(copied),
      await exampleModelBytes('Diode_SMD:D_SMA', 'emc-flyback-demo/D_SMA.step'),
    );
    assert.equal(JSON.stringify(project), before);
    await assert.rejects(
      readFile(path.join(directory, 'models/Diode_SMD.3dshapes/D_SMA.step')),
      /ENOENT/,
    );
    await writeFile(copied, 'user asset');
    await assert.rejects(prepareExampleFootprints(project, filename), /Preserved unchanged/);
    assert.equal(await readFile(copied, 'utf8'), 'user asset');
    const linked = path.join(directory, 'linked');
    const target = path.join(directory, 'target');
    await mkdir(linked);
    await mkdir(target);
    await symlink(
      target,
      path.join(linked, 'models'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      prepareExampleFootprints(project, path.join(linked, 'demo.kicad_pro')),
      /real directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
