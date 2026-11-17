import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createHomeExample } from '../lib/create-home-example';
import { createPart, emptyCircuit, serializeCircuit, uid } from '../lib/circuit';
import { ownProject } from '../lib/immutable-project';
import { createProject, projectNativeFiles, serializeProject, type Project } from '../lib/project';
import { child, children, parseSExpr, quote, val, writeSExpr } from '../lib/sexpr';
import { materializedPCBTree, serializePCB, type BoardZone } from '../lib/pcb';
import { homeExampleCatalog } from '../lib/home-examples';
import { nativeProjectDirty } from '../lib/native-project-dirty';

function schematicFixture() {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', 0, 0));
  circuit.wires.push({ id: uid(), a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
  circuit.original = parseSExpr(serializeCircuit(circuit));
  const textId = uid();
  circuit.original.push([
    'text',
    '"Retained note"',
    ['at', '0', '20', '0'],
    ['effects', ['font', ['size', '1', '1']]],
    ['uuid', `"${textId}"`],
  ]);
  return { project: ownProject(createProject(circuit)), textId };
}

test('owned clean Source preparation preserves imported bytes, state, history and dirty baselines', () => {
  const caller = createHomeExample('emc-flyback-demo', (id) => id);
  const source = serializeProject(caller);
  const native = projectNativeFiles(caller);
  const managed = projectNativeFiles(caller, 'project.kicad_pro');
  const callerBefore = JSON.stringify(caller);
  const core = new ProjectCore(caller, { nativeEntryName: 'project.kicad_pro' });
  const snapshot = core.getSnapshot();
  assert.equal(snapshot.source, source);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.undoDepth, 0);
  assert.equal(snapshot.redoDepth, 0);
  assert.equal(snapshot.sourceDraft, null);
  assert.equal(snapshot.sourceError, '');
  assert.deepEqual(projectNativeFiles(snapshot.project!), native);
  assert.deepEqual(core.getNativeFiles(), managed);
  assert.equal(nativeProjectDirty(snapshot.project, source, 'project.kicad_pro'), false);
  const escaped = core.getNativeFiles();
  escaped.files[0].source = 'Caller poisoned';
  escaped.files.length = 0;
  assert.deepEqual(core.getNativeFiles(), managed);
  assert.equal(serializeProject(snapshot.project!), source);
  assert.equal(core.getSnapshot(), snapshot, 'Pure preparation never publishes a revision.');
  assert.equal(JSON.stringify(caller), callerBefore);
});

test('owned schematic validation rechecks its complete UUID ledger against every new project', () => {
  const { project, textId } = schematicFixture();
  const source = serializeProject(project);
  for (const id of [
    project.schematic.id,
    project.schematic.parts[0].id,
    project.schematic.wires[0].id,
    textId,
  ])
    assert.throws(() => serializeProject(ownProject({ ...project, id })), /duplicate UUID/i);
  assert.throws(
    () => serializeProject(ownProject({ ...project, additionalSchematics: [project.schematic] })),
    /duplicate UUID/i,
  );
  const changed = ownProject({ ...project, extensions: { 'example.org': { changed: true } } });
  assert.equal(changed.schematic, project.schematic);
  assert.equal(serializeProject(changed), serializeProject(structuredClone(changed)));
  assert.equal(serializeProject(project), source);
});

test('changed and caller-frozen sheets cannot reuse local semantic acceptance', () => {
  const { project } = schematicFixture();
  serializeProject(project);
  const changed = ownProject({
    ...project,
    schematic: {
      ...project.schematic,
      parts: project.schematic.parts.map((part) => ({ ...part, libId: 'Missing:Library' })),
    },
  });
  for (let index = 0; index < 2; index++)
    assert.throws(
      () => serializeProject(ownProject({ ...changed, name: `Attempt ${index}` })),
      /missing embedded symbol/i,
    );
  const caller = structuredClone(project);
  Object.freeze(caller.schematic);
  serializeProject(caller);
  caller.schematic.parts[0].libId = 'Missing:Caller';
  assert.throws(() => serializeProject(caller), /missing embedded symbol/i);
});

test('warm owned PCB native merges remain byte-identical through geometry, captions, nets, locks, backing metadata and destinations', () => {
  const core = new ProjectCore(
    createHomeExample('emc-flyback-demo', (id) => id),
    {
      nativeEntryName: 'project.kicad_pro',
    },
  );
  const verify = (project: Project, destination?: string) => {
    const actual = projectNativeFiles(project, destination);
    const detached = structuredClone(project);
    // Recompute the cold oracle for every accepted pose and distinct destination.
    // Repeated owned reads below still exercise cache reuse and wrapper isolation.
    const expected = projectNativeFiles(detached, destination);
    const managedExpected =
      destination === 'project.kicad_pro'
        ? expected
        : projectNativeFiles(detached, 'project.kicad_pro');
    assert.deepEqual(actual, expected);
    assert.equal(serializeProject(project), serializeProject(detached));
    assert.deepEqual(core.getNativeFiles(), managedExpected);
    const first = actual.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
    first.source += '\nPoisoned public wrapper';
    assert.deepEqual(projectNativeFiles(project, destination), expected);
  };
  const shift = () => {
    const board = core.getSnapshot().project!.pcb!;
    core.replaceBoard({
      ...board,
      footprints: board.footprints.map((footprint, index) =>
        index ? footprint : { ...footprint, x: footprint.x + 1.27 },
      ),
    });
  };
  shift();
  shift();
  verify(core.getSnapshot().project!);
  const renamed = core.getSnapshot().project!;
  core.replaceSchematic({
    ...renamed.schematic,
    parts: renamed.schematic.parts.map((part) =>
      part.ref === 'R1' ? { ...part, value: '9.1k' } : part,
    ),
  });
  verify(core.getSnapshot().project!);
  const board = core.getSnapshot().project!.pcb!;
  core.replaceBoard({
    ...board,
    nets: board.nets.map((net, index) => (index ? net : { ...net, name: 'CACHE_RENAMED' })),
    tracks: board.tracks.map((track, index) => {
      if (index) return track;
      const { locked, ...unlocked } = track;
      return locked ? unlocked : { ...track, locked: true };
    }),
  });
  verify(core.getSnapshot().project!);
  const stack = core.getSnapshot().project!.pcb!;
  core.replaceBoard({ ...stack, layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] });
  verify(core.getSnapshot().project!);
  const beforeMetadata = core.getSnapshot().project!;
  assert.ok(beforeMetadata.nativeFiles);
  const files = beforeMetadata.nativeFiles.files.map((file) =>
    file.name.endsWith('.kicad_pcb')
      ? { ...file, source: file.source.replace('(descr "', '(descr "cache metadata ') }
      : file,
  );
  assert.notDeepEqual(files, beforeMetadata.nativeFiles.files);
  core.commitProject({ ...beforeMetadata, nativeFiles: { ...beforeMetadata.nativeFiles, files } });
  const metadata = core.getSnapshot().project!;
  verify(metadata);
  assert.match(
    projectNativeFiles(metadata).files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
    /cache metadata/,
  );
  verify(metadata, 'Renamed.kicad_pro');
  core.undo();
  verify(core.getSnapshot().project!);
  core.redo();
  verify(core.getSnapshot().project!);
});

test('ordered native merges retain metadata across mixed cached records and reordered footprint children', () => {
  const caller = createHomeExample('emc-flyback-demo', (id) => id);
  const localZones: BoardZone[] = [0, 3].map((x) => ({
    id: uid(),
    netId: null,
    layer: 'F.Cu',
    outline: [
      { x, y: 0 },
      { x: x + 1, y: 0 },
      { x: x + 1, y: 1 },
      { x, y: 1 },
    ],
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    keepout: { tracks: true, vias: true, pads: false, copperpour: true, footprints: false },
  }));
  caller.pcb = {
    ...caller.pcb!,
    footprints: caller.pcb!.footprints.map((footprint, index, all) =>
      index === all.length - 1 ? { ...footprint, zones: localZones } : footprint,
    ),
  };
  const native = projectNativeFiles(caller);
  const boardFile = native.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  const original = parseSExpr(boardFile.source);
  const uuid = (node: ReturnType<typeof parseSExpr>) => val(child(node, 'uuid'));
  const descriptions = new Map<string, string>();
  const zoneNames = new Map<string, string>();
  for (const footprint of children(original, 'footprint')) {
    const marker = `Retained metadata ${uuid(footprint)}`;
    descriptions.set(uuid(footprint), marker);
    const description = child(footprint, 'descr');
    if (description) description[1] = quote(marker);
    else footprint.push(['descr', quote(marker)]);
    for (const zone of children(footprint, 'zone')) {
      const name = `Local rule area ${uuid(zone)}`;
      zoneNames.set(uuid(zone), name);
      zone.push(['name', quote(name)]);
    }
  }
  assert.equal(zoneNames.size, 2);
  boardFile.source = writeSExpr(original) + '\n';
  let project = ownProject({ ...caller, nativeFiles: native });
  serializeProject(project);
  for (let revision = 0; revision < 2; revision++) {
    const board = project.pcb!;
    project = ownProject(
      {
        ...project,
        pcb: {
          ...board,
          tracks: board.tracks
            .slice()
            .reverse()
            .map((track, index) =>
              index === revision ? { ...track, width: track.width + 0.01 } : track,
            ),
          vias: board.vias.slice().reverse(),
          footprints: board.footprints
            .slice()
            .reverse()
            .map((footprint, index) =>
              index
                ? footprint
                : {
                    ...footprint,
                    x: footprint.x + 0.1,
                    pads: footprint.pads.slice().reverse(),
                    graphics: footprint.graphics.slice().reverse(),
                    ...(footprint.zones ? { zones: footprint.zones.slice().reverse() } : {}),
                  },
            ),
        },
      },
      project,
    );
    const files = projectNativeFiles(project);
    assert.deepEqual(files, projectNativeFiles(structuredClone(project)));
    assert.equal(serializeProject(project), serializeProject(structuredClone(project)));
    const root = parseSExpr(files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source);
    for (const [tag, records] of [
      ['segment', project.pcb!.tracks],
      ['via', project.pcb!.vias],
      ['footprint', project.pcb!.footprints],
    ] as const)
      assert.deepEqual(
        children(root, tag).map(uuid),
        records.map((record) => record.id),
      );
    const footprints = new Map(children(root, 'footprint').map((node) => [uuid(node), node]));
    for (const footprint of project.pcb!.footprints) {
      const node = footprints.get(footprint.id)!;
      assert.equal(val(child(node, 'descr')), descriptions.get(footprint.id));
      assert.deepEqual(
        children(node, 'pad').map(uuid),
        footprint.pads.map((pad) => pad.id),
      );
      assert.deepEqual(
        children(node, 'zone').map(uuid),
        (footprint.zones ?? []).map((zone) => zone.id),
      );
      for (const zone of children(node, 'zone'))
        assert.equal(val(child(zone, 'name')), zoneNames.get(uuid(zone)));
      const graphicIds = footprint.graphics.map((graphic) => graphic.id);
      const expectedGraphics = new Set(graphicIds);
      assert.deepEqual(
        node
          .filter(Array.isArray)
          .map(uuid)
          .filter((id) => expectedGraphics.has(id)),
        graphicIds,
      );
    }
  }
});

test('default Source and a managed destination share PCB bytes but retain their own settings and schematic instances', () => {
  const core = new ProjectCore(
    createHomeExample('emc-flyback-demo', (id) => id),
    {
      nativeEntryName: 'project.kicad_pro',
    },
  );
  const board = core.getSnapshot().project!.pcb!;
  core.replaceBoard({
    ...board,
    footprints: board.footprints.map((footprint, index) =>
      index ? footprint : { ...footprint, x: footprint.x + 1.27 },
    ),
  });
  const project = core.getSnapshot().project!;
  const source = serializeProject(project);
  const original = projectNativeFiles(project);
  const managed = core.getNativeFiles();
  assert.equal(original.entry, 'emc-flyback.kicad_pro');
  assert.equal(managed.entry, 'project.kicad_pro');
  const native = (files: typeof managed, suffix: string) =>
    files.files.find((file) => file.name.endsWith(suffix))!;
  assert.equal(native(original, '.kicad_pcb').name, 'emc-flyback.kicad_pcb');
  assert.equal(native(managed, '.kicad_pcb').name, 'project.kicad_pcb');
  assert.equal(native(managed, '.kicad_pcb').source, native(original, '.kicad_pcb').source);
  assert.equal(JSON.parse(native(managed, '.kicad_pro').source).meta.filename, 'project.kicad_pro');
  const originalSchematic = native(original, '.kicad_sch');
  const managedSchematic = native(managed, '.kicad_sch');
  assert.equal(originalSchematic.name, 'emc-flyback.kicad_sch');
  assert.equal(managedSchematic.name, 'project.kicad_sch');
  assert.notEqual(originalSchematic.source, managedSchematic.source);
  const symbol = children(parseSExpr(managedSchematic.source), 'symbol')[0];
  assert.ok(
    children(child(symbol, 'instances')!, 'project').some((node) => val(node) === 'project'),
  );
  native(managed, '.kicad_pcb').source += '\nPoisoned public destination';
  managed.files.length = 0;
  assert.deepEqual(
    core.getNativeFiles(),
    projectNativeFiles(structuredClone(project), managed.entry),
  );
  assert.equal(serializeProject(project), source);
});

test('owned PCB record chunks match complete text parsing through copper, caption, model and ordering changes', () => {
  let project = ownProject(createHomeExample('emc-flyback-demo', (id) => id));
  const verify = () => {
    const board = project.pcb!;
    const source = serializePCB(board, project.schematic);
    assert.equal(source, serializePCB(structuredClone(board), structuredClone(project.schematic)));
    assert.deepEqual(materializedPCBTree(board, project.schematic), parseSExpr(source));
    assert.deepEqual(
      projectNativeFiles(project, 'project.kicad_pro'),
      projectNativeFiles(structuredClone(project), 'project.kicad_pro'),
    );
    assert.equal(serializeProject(project), serializeProject(structuredClone(project)));
  };
  verify();
  const board = project.pcb!;
  project = ownProject({
    ...project,
    pcb: {
      ...board,
      tracks: board.tracks.map((track, index) =>
        index ? track : { ...track, start: { ...track.start, x: track.start.x + 0.1 } },
      ),
      vias: board.vias.map((via, index) => (index ? via : { ...via, x: via.x + 0.2 })),
      zones: board.zones.map((zone, index) =>
        index ? zone : { ...zone, clearance: zone.clearance + 0.01 },
      ),
      graphics: board.graphics.map((graphic, index) =>
        index ? graphic : { ...graphic, width: graphic.width + 0.01 },
      ),
      footprints: board.footprints.map((footprint, index) =>
        index
          ? footprint
          : {
              ...footprint,
              models: footprint.models?.map((model) => ({ ...model, opacity: 0.75 })),
            },
      ),
    },
  });
  verify();
  const edited = project.pcb!;
  project = ownProject({
    ...project,
    pcb: {
      ...edited,
      nets: edited.nets.slice().reverse(),
      tracks: edited.tracks.slice().reverse(),
    },
    schematic: {
      ...project.schematic,
      title: 'Record cache title',
      parts: project.schematic.parts.map((part) =>
        part.ref === 'R1' ? { ...part, value: '8.2k' } : part,
      ),
    },
  });
  verify();
  const mutable = structuredClone(project.pcb!);
  Object.freeze(mutable);
  const first = materializedPCBTree(mutable, project.schematic);
  first.length = 0;
  mutable.tracks[0].start.x += 1;
  assert.deepEqual(
    materializedPCBTree(mutable, project.schematic),
    parseSExpr(serializePCB(mutable, project.schematic)),
  );
});

test('prepared Home PCB output has identical private tree and independent mutable text paths', () => {
  for (const { id } of homeExampleCatalog) {
    const project = ownProject(createHomeExample(id, (id) => id));
    assert.ok(project.pcb);
    const source = serializePCB(project.pcb, project.schematic);
    assert.deepEqual(materializedPCBTree(project.pcb, project.schematic), parseSExpr(source));
    assert.equal(source, serializePCB(structuredClone(project.pcb), project.schematic));
  }
});

test('owned schematic instance reuse retains changed foreign roots, native backing, identity and component metadata', () => {
  const base = schematicFixture().project;
  let project = ownProject({
    ...base,
    nativeFiles: projectNativeFiles(base, 'Original.kicad_pro'),
  });
  const verify = () => {
    for (const entry of [undefined, 'project.kicad_pro', 'Personal.kicad_pro'])
      assert.deepEqual(
        projectNativeFiles(project, entry),
        projectNativeFiles(structuredClone(project), entry),
      );
  };
  verify();
  const files = project.nativeFiles!.files.map((file) => {
    if (!file.name.endsWith('.kicad_sch')) return file;
    const root = parseSExpr(file.source);
    child(children(root, 'symbol')[0], 'instances')!.push([
      'project',
      '"Foreign cache owner"',
      ['path', '"/foreign-cache-root"', ['reference', '"X42"'], ['unit', '1']],
    ]);
    return { ...file, source: writeSExpr(root) + '\n' };
  });
  project = ownProject({ ...project, nativeFiles: { ...project.nativeFiles!, files } });
  verify();
  assert.match(
    projectNativeFiles(project, 'project.kicad_pro').files.find((file) =>
      file.name.endsWith('.kicad_sch'),
    )!.source,
    /Foreign cache owner/,
  );
  const id = uid();
  project = ownProject({
    ...project,
    schematic: {
      ...project.schematic,
      id,
      title: 'Changed native identity',
      original: project.schematic.original!.map((node) =>
        Array.isArray(node) && node[0] === 'uuid' ? ['uuid', quote(id)] : node,
      ),
      parts: project.schematic.parts.map((part) => ({
        ...part,
        value: '6.8k',
        fields: { ...part.fields, 'Cache field': 'retained' },
      })),
    },
  });
  verify();
  assert.match(
    projectNativeFiles(project, 'project.kicad_pro').files.find((file) =>
      file.name.endsWith('.kicad_sch'),
    )!.source,
    /Cache field/,
  );
});
