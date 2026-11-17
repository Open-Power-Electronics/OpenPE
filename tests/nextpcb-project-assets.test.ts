import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createPart } from '../lib/circuit';
import { createBlankProject } from '../lib/create-blank-project';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { attachNextPcbFootprint, projectFootprintSource } from '../lib/library-project-assets';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import type { FootprintSource } from '../lib/pcb-sync';
import { parseProject, serializeProject, validateProject, type Project } from '../lib/project';
import { child, children, parseSExpr, val, writeSExpr } from '../lib/sexpr';

const id = 'NextPCB:42_TestPart';
const filename = 'footprints/NextPCB.pretty/42_TestPart.kicad_mod';
const modelPath = '${KIPRJMOD}/models/' + 'a'.repeat(64) + '.step';

// Original synthetic native data exercises the vendor delivery grammar without
// redistributing a manufacturer package or requiring a network/model parser.
function detail(): FootprintSource {
  return {
    id,
    projectAssets: true,
    footprint: parseSExpr(`(footprint "42_TestPart" (version 20240108) (layer "F.Cu")
      (descr "Native test package")
      (fp_circle (center -1 1) (end -1 1.25) (stroke (width 0) (type default))
        (fill solid) (layer "F.SilkS"))
      (pad "1" smd oval (at -1 0) (size 1 1.5) (layers "F.Cu" "F.Paste" "F.Mask")
        (thermal_bridge_angle 45))
      (pad "2" smd oval (at 1 0) (size 1 1.5) (layers "F.Cu" "F.Paste" "F.Mask"))
      (model "${modelPath}" (offset (xyz 1 2 3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90))))`),
  };
}

function withPart(project: Project) {
  const schematic = structuredClone(project.schematic);
  const part = createPart(schematic, 'R', 12.7, 12.7);
  part.fields = { ...part.fields, Footprint: id };
  schematic.parts.push(part);
  return { ...project, schematic };
}

function fixture() {
  const project = withPart(createBlankProject());
  project.nativeFiles = projectNativeFiles(project, 'circuit.kicad_pro');
  return project;
}

function withTable(project: Project, source: string): Project {
  const bundle = projectNativeFiles(project);
  return {
    ...project,
    nativeFiles: {
      ...bundle,
      files: [
        ...bundle.files.filter((file) => file.name !== 'fp-lib-table'),
        { name: 'fp-lib-table', source },
      ],
    },
  };
}

test('prepared NextPCB packages add native files without changing IDs or existing library entries', () => {
  const originalTable = `(fp_lib_table\t(version 7)\r\n\t(lib (name "Existing") (type "KiCad") (uri "\${KIPRJMOD}/existing.pretty")\r\n      (options "") (descr "Retain this library"))  )  \r\n`;
  const project = withTable(fixture(), originalTable);
  const input = detail();
  const unchanged = serializeProject(project);
  const attached = attachNextPcbFootprint(project, input);
  validateProject(attached);
  assert.equal(attached.id, project.id);
  assert.equal(attached.schematic, project.schematic);
  assert.equal(attached.pcb, project.pcb);
  assert.equal(serializeProject(project), unchanged);
  const files = projectNativeFiles(attached);
  const tableSource = files.files.find((file) => file.name === 'fp-lib-table')!.source;
  const table = parseSExpr(tableSource);
  const closing = originalTable.lastIndexOf(')');
  assert.ok(tableSource.startsWith(originalTable.slice(0, closing)));
  assert.ok(tableSource.endsWith(originalTable.slice(closing)));
  assert.deepEqual(children(table, 'lib')[0], children(parseSExpr(originalTable), 'lib')[0]);
  const entry = children(table, 'lib')[1];
  assert.equal(val(child(entry, 'name')), 'NextPCB');
  assert.equal(val(child(entry, 'type')), 'KiCad');
  assert.equal(val(child(entry, 'uri')), '${KIPRJMOD}/footprints/NextPCB.pretty');
  const asset = files.files.find((file) => file.name === filename)!;
  assert.equal(asset.source, writeSExpr(input.footprint) + '\n');
  assert.equal(val(child(parseSExpr(asset.source), 'model')), modelPath);
  assert.equal(attachNextPcbFootprint(attached, input), attached);
  child(input.footprint, 'descr')![1] = '"Caller mutation"';
  assert.equal(
    projectNativeFiles(attached).files.find((file) => file.name === filename)!.source,
    asset.source,
  );
  const renamed = projectNativeFiles(attached, 'renamed.kicad_pro');
  assert.equal(renamed.files.find((file) => file.name === filename)!.source, asset.source);
  assert.equal(
    projectFromNativeFiles(renamed).schematic.parts[0].id,
    attached.schematic.parts[0].id,
  );
  assert.equal(projectFootprintSource(parseProject(serializeProject(attached)), id)!.id, id);
});

test('symbol, package and native sidecars share one Core transaction, undo and recovery', () => {
  const initial = createBlankProject();
  const sync = new PCBProjectSync(initial);
  sync.sources.set(id, detail());
  const core = new ProjectCore(initial, { prepare: (next) => sync.prepare(next)?.project ?? next });
  const before = core.getSnapshot();
  core.commitProject(withPart(before.project!));
  const accepted = core.getSnapshot();
  assert.equal(accepted.undoDepth, 1);
  assert.equal(accepted.project!.schematic.parts[0].fields!.Footprint, id);
  const footprint = accepted.project!.pcb!.footprints[0];
  assert.equal(footprint.libraryId, id);
  assert.equal(footprint.models![0].path, modelPath);
  assert.deepEqual(footprint.models![0].offset, { x: 1, y: 2, z: 3 });
  assert.equal(footprint.pads[0].thermalBridgeAngle, 45);
  assert.ok(core.getNativeFiles().files.some((file) => file.name === filename));
  const recovered = parseProject(accepted.source);
  assert.deepEqual(recovered.pcb, accepted.project!.pcb);
  const nativeByName = (project: Project) =>
    [...project.nativeFiles!.files].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(nativeByName(recovered), nativeByName(accepted.project!));
  core.undo();
  assert.equal(core.getSnapshot().source, before.source);
  assert.ok(!core.getNativeFiles().files.some((file) => file.name === filename));
  core.redo();
  assert.equal(core.getSnapshot().project!.pcb!.footprints[0].id, footprint.id);
  assert.ok(core.getNativeFiles().files.some((file) => file.name === filename));
  const native = projectNativeFiles(core.getSnapshot().project!, 'saved.kicad_pro');
  const reopened = projectFromNativeFiles(native);
  assert.equal(reopened.pcb!.footprints[0].id, footprint.id);
  assert.equal(reopened.pcb!.footprints[0].models![0].path, modelPath);
  assert.deepEqual(projectNativeFiles(reopened), native);
  core.updateNativeSource(filename, '(');
  assert.throws(() => core.commitProject(core.getSnapshot().project!), /Source/);
  core.discardSource();
});

test('local downloaded packages resolve offline and remain authoritative over cached remote details', async () => {
  const original = attachNextPcbFootprint(fixture(), detail());
  const changed = {
    ...original,
    nativeFiles: {
      ...original.nativeFiles!,
      files: original.nativeFiles!.files.map((file) =>
        file.name === filename
          ? { ...file, source: file.source.replace('(center -1 1)', '(center -2 1)') }
          : file,
      ),
    },
  };
  const first = projectFootprintSource(changed, id)!;
  child(child(first.footprint, 'fp_circle')!, 'center')![1] = '-99';
  assert.equal(
    val(child(child(projectFootprintSource(changed, id)!.footprint, 'fp_circle')!, 'center')),
    '-2',
  );
  const sync = new PCBProjectSync();
  sync.sources.set(id, detail());
  let requests = 0;
  const ready = await sync.resolve(
    changed,
    async () => {
      requests++;
      throw new Error('Network unavailable');
    },
    new AbortController().signal,
  );
  assert.equal(requests, 0);
  assert.equal(
    ready.project.pcb!.footprints[0].graphics.find((graphic) => graphic.kind === 'circle')!.start.x,
    -2,
  );
  assert.equal(
    ready.project.nativeFiles!.files.find((file) => file.name === filename)!.source,
    changed.nativeFiles.files.find((file) => file.name === filename)!.source,
  );
  const reopened = projectFromNativeFiles(projectNativeFiles(ready.project));
  const loaded = new PCBProjectSync(reopened);
  assert.equal(
    (
      await loaded.resolve(
        reopened,
        async () => {
          throw new Error('Viewing cannot fetch');
        },
        new AbortController().signal,
      )
    ).project,
    reopened,
  );
});

test('raw preview details cannot bypass package preparation and failed downloads remain retryable', async () => {
  const project = fixture();
  const sync = new PCBProjectSync();
  const raw = detail();
  delete raw.projectAssets;
  sync.sources.set(id, raw);
  assert.equal(sync.prepare(project), null);
  await assert.rejects(
    sync.resolve(project, async () => raw, new AbortController().signal),
    /prepare the NextPCB project package/,
  );
  assert.ok(!project.nativeFiles!.files.some((file) => file.name === filename));
  const accepted = await sync.resolve(project, async () => detail(), new AbortController().signal);
  assert.equal(accepted.project.pcb!.footprints.length, 1);
  assert.ok(accepted.project.nativeFiles!.files.some((file) => file.name === filename));
});

test('new packages reject conflicting local files, mappings, identities and unprepared model references', () => {
  const project = fixture();
  const attached = attachNextPcbFootprint(project, detail());
  const before = serializeProject(attached);
  const modified = detail();
  child(child(modified.footprint, 'fp_circle')!, 'center')![1] = '-3';
  assert.throws(() => attachNextPcbFootprint(attached, modified), /existing changed footprint/);
  assert.equal(serializeProject(attached), before);
  for (const table of [
    '(not_a_library_table)',
    '(fp_lib_table (lib (name "NextPCB") (type "KiCad") (uri "${KIPRJMOD}/another.pretty")))',
    '(fp_lib_table (lib (name "nextpcb") (type "KiCad") (uri "${KIPRJMOD}/footprints/NextPCB.pretty")))',
    '(fp_lib_table (lib (name "NextPCB") (type "Legacy") (uri "${KIPRJMOD}/footprints/NextPCB.pretty")))',
    '(fp_lib_table (lib (name "NextPCB") (type "KiCad") (uri "${KIPRJMOD}/footprints/NextPCB.pretty") (uri "elsewhere")))',
  ])
    assert.throws(
      () => attachNextPcbFootprint(withTable(project, table), detail()),
      /NextPCB project library/,
    );
  for (const invalid of [
    'NextPCB:../Escape',
    'NextPCB:Name:Alias',
    'NextPCB:' + 'a'.repeat(151),
    'NextPCB:CON',
  ])
    assert.throws(
      () => attachNextPcbFootprint(project, { ...detail(), id: invalid }),
      /native footprint filename/,
    );
  const mismatched = detail();
  mismatched.footprint[1] = '"Other"';
  assert.throws(() => attachNextPcbFootprint(project, mismatched), /component identity/);
  const unprepared = detail();
  child(unprepared.footprint, 'model')![1] = '"${KICAD10_3DMODEL_DIR}/Test/Package.step"';
  assert.throws(() => attachNextPcbFootprint(project, unprepared), /project-relative STEP assets/);
  assert.equal(attachNextPcbFootprint(project, { ...detail(), projectAssets: undefined }), project);
});

test('supporting asset additions retain native file-set limits and reject unsupported local geometry atomically', () => {
  const project = fixture();
  project.nativeFiles!.files.push(
    ...Array.from({ length: 125 }, (_, i) => ({
      name: `support/${i}.kicad_mod`,
      source: '(footprint "Unused")',
    })),
  );
  assert.throws(() => attachNextPcbFootprint(project, detail()), /1–128 text files/);
  const valid = attachNextPcbFootprint(fixture(), detail());
  const unsupported = {
    ...valid,
    nativeFiles: {
      ...valid.nativeFiles!,
      files: valid.nativeFiles!.files.map((file) =>
        file.name === filename
          ? {
              ...file,
              source: file.source.replace('(size 1 1.5)', '(size 1 1.5) (options unsupported)'),
            }
          : file,
      ),
    },
  };
  const sync = new PCBProjectSync();
  assert.throws(() => sync.prepare(unsupported), /unsupported options/);
  assert.equal(unsupported.pcb!.footprints.length, 0);
});
