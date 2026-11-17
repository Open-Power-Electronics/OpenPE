import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import manifest from '../resources/example-catalog/manifest.json';
import {
  createProject,
  exportKiCad,
  parseProject,
  serializeProject,
  validateProject,
} from '../lib/project';
import { emptyCircuit, uid } from '../lib/circuit';
import { isOwnedProjectNode, ownProject } from '../lib/immutable-project';
import { exampleProject } from '../lib/project-example';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { buildSpiceDeck, defaultTransient } from '../plugins/spice-simulation/domain/spice';
import { child, children, parseSExpr, val, writeSExpr } from '../lib/sexpr';
import { materializedPCBTree } from '../lib/pcb';
import { ProjectCore } from '../core/project-core';
import { nativeProjectDirty } from '../lib/native-project-dirty';
import { toProjectDocument } from '../lib/project-document';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  projectNativeFilesSnapshot,
  replaceNativeProjectFile,
  validateKiCadProjectFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';

function nativeFixture(): KiCadProjectFiles {
  const project = exampleProject();
  const schematic = exportKiCad(project, 'schematic');
  const root = parseSExpr(exportKiCad(project, 'pcb'));
  child(root, 'setup')!.push(['allow_soldermask_bridges_in_footprints', 'no']);
  children(root, 'footprint')[0].push(['descr', '"Retained package metadata"']);
  root.push(['net', '"99"', '"Unused"']);
  return {
    entry: 'Filter.kicad_pro',
    files: [
      {
        name: 'Filter.kicad_pro',
        source:
          '{\n "meta": {"filename":"Filter.kicad_pro", "version":1}, "board": {"custom":true}, "text_variables":{"REVISION":"C"}\n}\n',
      },
      { name: 'Filter.kicad_sch', source: schematic },
      { name: 'Filter.kicad_pcb', source: writeSExpr(root) + '\n' },
      { name: 'fp-lib-table', source: '(fp_lib_table (version 7))\n' },
      { name: 'models/design.spice', source: '* Simulation source — unchanged bytes\r\n' },
    ],
  };
}

test('renaming a project persists through native files, Source, Save as and undo', () => {
  const bundle = nativeFixture();
  const core = new ProjectCore(projectFromNativeFiles(bundle));
  const initial = core.getSnapshot();
  const initialFiles = projectNativeFiles(initial.project!);
  core.commitProject({ ...initial.project!, name: 'Power stage review' });
  const renamed = core.getSnapshot();
  assert.equal(renamed.undoDepth, 1);
  assert.equal(nativeProjectDirty(renamed.project, initial.source, bundle.entry), true);
  const files = projectNativeFiles(renamed.project!);
  assert.deepEqual(
    files.files.map((file) => file.name),
    initialFiles.files.map((file) => file.name),
  );
  for (const file of bundle.files.slice(1))
    assert.equal(files.files.find((item) => item.name === file.name)!.source, file.source);
  const settings = JSON.parse(files.files[0].source);
  assert.equal(settings.text_variables.OPENPE_PROJECT_NAME, 'Power stage review');
  assert.equal(settings.text_variables.REVISION, 'C');
  assert.deepEqual(settings.board, { custom: true });
  assert.equal(projectFromNativeFiles(files).name, 'Power stage review');
  assert.equal(
    projectFromNativeFiles(projectNativeFiles(renamed.project!, 'Personal.kicad_pro')).name,
    'Power stage review',
  );
  settings.text_variables.OPENPE_PROJECT_NAME = 'Source name';
  core.updateNativeSource(files.entry, JSON.stringify(settings));
  assert.throws(
    () => core.commitProject({ ...core.getSnapshot().project!, name: 'Blocked' }),
    /Apply the Source/,
  );
  assert.equal(core.applySource()!.name, 'Source name');
  delete settings.text_variables.OPENPE_PROJECT_NAME;
  assert.equal(
    replaceNativeProjectFile(core.getSnapshot().project!, files.entry, JSON.stringify(settings))
      .name,
    'Filter',
  );
  core.undo();
  core.undo();
  assert.equal(core.getSnapshot().project!.name, initial.project!.name);
  assert.deepEqual(projectNativeFiles(core.getSnapshot().project!), initialFiles);
  assert.equal(nativeProjectDirty(core.getSnapshot().project, initial.source, bundle.entry), false);
  core.setEditingBlocked('This project is closing.');
  assert.throws(
    () => core.commitProject({ ...core.getSnapshot().project!, name: 'Blocked' }),
    /closing/,
  );
  for (const value of [null, 42, '', 'a'.repeat(4097)]) {
    settings.text_variables.OPENPE_PROJECT_NAME = value;
    assert.throws(
      () =>
        projectFromNativeFiles({
          ...files,
          files: files.files.map((file) =>
            file.name === files.entry ? { ...file, source: JSON.stringify(settings) } : file,
          ),
        }),
      /project name/,
    );
  }
});

function schematicPreparationFixture(): KiCadProjectFiles {
  const bundle = nativeFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_sch'))!;
  const root = parseSExpr(file.source);
  for (const symbol of children(root, 'symbol')) {
    const reference = children(symbol, 'property').find((node) => val(node) === 'Reference')![2];
    symbol.push([
      'instances',
      [
        'project',
        '"Filter"',
        [
          'path',
          JSON.stringify('/' + val(child(root, 'uuid'))),
          ['reference', reference],
          ['unit', '1'],
        ],
      ],
    ]);
  }
  file.source = writeSExpr(root) + '\n';
  return bundle;
}

function instancePathCopies(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((node) => Array.isArray(node) && node[0] === 'path')
  );
}

for (const owned of [false, true])
  test(`native field comparison preserves canonical data and current edits (${owned ? 'owned' : 'mutable'} input)`, () => {
    const bundle = nativeFixture();
    const file = bundle.files.find((item) => item.name.endsWith('.kicad_sch'))!;
    const tree = parseSExpr(file.source);
    const reference = children(children(tree, 'symbol')[0], 'property').find(
      (node) => val(node) === 'Reference',
    )!;
    const effects = child(reference, 'effects')!;
    effects.push('hide');
    child(effects, 'font')!.push('bold');
    child(reference, 'at')![1] = '29.21';
    file.source = writeSExpr(tree) + '\n';
    const imported = projectFromNativeFiles(bundle);
    const project = owned ? ownProject(imported) : imported;
    const projected = toProjectDocument({ ...project, pcb: null }, true);
    const before = JSON.stringify(projected);
    const modelBefore = JSON.stringify(project);

    const native = projectNativeFiles(project);
    assert.equal(native.entry, bundle.entry);
    assert.deepEqual(
      Object.fromEntries(native.files.map((file) => [file.name, file])),
      Object.fromEntries(bundle.files.map((file) => [file.name, file])),
    );
    assert.equal(JSON.stringify(projected), before, 'Shared canonical layouts remain unchanged.');
    assert.equal(
      JSON.stringify(project),
      modelBefore,
      'Comparison never rewrites raw field syntax.',
    );

    const changed = owned ? structuredClone(project) : project;
    const field = children(changed.schematic.parts[0].raw!, 'property').find(
      (node) => val(node) === 'Reference',
    )!;
    child(child(field, 'effects')!, 'font')!.push('italic');
    const current = projectNativeFiles(owned ? ownProject(changed, project) : changed);
    const source = current.files.find((item) => item.name.endsWith('.kicad_sch'))!.source;
    assert.notEqual(
      source,
      file.source,
      'New custom layout changes cannot reuse clean native bytes.',
    );
    const currentReference = children(children(parseSExpr(source), 'symbol')[0], 'property').find(
      (node) => val(node) === 'Reference',
    )!;
    assert.ok(child(child(currentReference, 'effects')!, 'font')!.includes('italic'));
    assert.ok(child(currentReference, 'hide'), 'Equivalent hidden syntax exports canonically.');
    if (owned) {
      assert.equal(JSON.stringify(projected), before);
      assert.equal(JSON.stringify(project), modelBefore);
    }
  });

test('clean owned schematics prepare private instances once while preserving bytes and public wrappers', () => {
  const bundle = schematicPreparationFixture();
  const original = ownProject(projectFromNativeFiles(bundle));
  const clone = globalThis.structuredClone;
  let copies = 0;
  globalThis.structuredClone = ((input: unknown) => {
    if (instancePathCopies(input)) copies++;
    return clone(input);
  }) as typeof structuredClone;
  try {
    const first = projectNativeFiles(original);
    assert.ok(copies > 0, 'Clean admission prepares the existing owned instance paths.');
    for (const file of bundle.files)
      assert.equal(first.files.find((item) => item.name === file.name)!.source, file.source);
    const preparedCopies = copies;
    let current = original;
    for (let index = 0; index < 3; index++) {
      current = ownProject(
        {
          ...current,
          pcb: {
            ...current.pcb!,
            tracks: current.pcb!.tracks.map((track, i) =>
              i ? track : { ...track, width: track.width + 0.05 },
            ),
          },
        },
        current,
      );
      assert.equal(current.schematic, original.schematic);
      const files = projectNativeFiles(current);
      assert.equal(
        files.files.find((file) => file.name === 'Filter.kicad_sch')!.source,
        bundle.files.find((file) => file.name === 'Filter.kicad_sch')!.source,
      );
    }
    assert.equal(
      copies,
      preparedCopies,
      'Board-only revisions do not rebuild prepared instance paths.',
    );
    first.files[0].source = 'Poisoned wrapper';
    first.files.splice(1);
    assert.deepEqual(projectNativeFiles(original), projectNativeFiles(structuredClone(original)));
    const caller = projectFromNativeFiles(bundle);
    Object.freeze(caller);
    Object.freeze(caller.schematic);
    const beforeCaller = copies;
    projectNativeFiles(caller);
    assert.equal(copies, beforeCaller, 'Caller freezing cannot opt into owned preparation.');
  } finally {
    globalThis.structuredClone = clone;
  }
});

test('failed optional schematic preparation remains retryable and never rejects unchanged Source', () => {
  const original = ownProject(projectFromNativeFiles(schematicPreparationFixture()));
  const clone = globalThis.structuredClone;
  let attempts = 0;
  let fail = true;
  globalThis.structuredClone = ((input: unknown) => {
    if (instancePathCopies(input)) {
      attempts++;
      if (fail) throw new Error('Optional instance preparation failed.');
    }
    return clone(input);
  }) as typeof structuredClone;
  try {
    const initial = projectNativeFiles(original);
    assert.equal(attempts, 1);
    fail = false;
    const retried = ownProject(
      { ...original, extensions: { 'example.org': { retry: true } } },
      original,
    );
    assert.deepEqual(projectNativeFiles(retried), initial);
    assert.ok(attempts > 1, 'A later native revision retries failed preparation.');
    const successful = attempts;
    const next = ownProject(
      { ...retried, extensions: { 'example.org': { retry: false } } },
      retried,
    );
    assert.deepEqual(projectNativeFiles(next), initial);
    assert.equal(attempts, successful);
  } finally {
    globalThis.structuredClone = clone;
  }
});

test('prepared schematic syntax still exports current captions, titles, identities, footprints and backing files', () => {
  const bundle = schematicPreparationFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_sch'))!;
  const root = parseSExpr(file.source);
  for (const symbol of children(root, 'symbol'))
    for (const field of children(symbol, 'property').filter((node) => val(node) === 'Footprint'))
      symbol.splice(symbol.indexOf(field), 1);
  file.source = writeSExpr(root) + '\n';
  const original = ownProject(projectFromNativeFiles(bundle));
  const initial = projectNativeFiles(original);
  const firstPart = original.schematic.parts[0];
  const verify = (input: typeof original) => {
    const owned = ownProject(input, original);
    const actual = projectNativeFiles(owned);
    assert.deepEqual(actual, projectNativeFiles(structuredClone(owned)));
    return parseSExpr(actual.files.find((file) => file.name.endsWith('.kicad_sch'))!.source);
  };
  const changedCaption = verify({
    ...original,
    schematic: {
      ...original.schematic,
      parts: original.schematic.parts.map((part) =>
        part === firstPart ? { ...part, value: 'Fresh caption', ref: 'R99' } : part,
      ),
    },
  });
  assert.match(writeSExpr(changedCaption), /"Value" "Fresh caption"/);
  assert.match(writeSExpr(changedCaption), /\(reference "R99"\)/);
  const changedTitle = verify({
    ...original,
    schematic: { ...original.schematic, title: 'Fresh title' },
  });
  assert.equal(val(child(child(changedTitle, 'title_block')!, 'title')), 'Fresh title');
  const schematicId = uid();
  const changedIdentity = verify({
    ...original,
    schematic: {
      ...original.schematic,
      id: schematicId,
      original: original.schematic.original!.map((node) =>
        Array.isArray(node) && node[0] === 'uuid' ? ['uuid', JSON.stringify(schematicId)] : node,
      ),
    },
  });
  assert.equal(val(child(changedIdentity, 'uuid')), schematicId);
  assert.match(writeSExpr(changedIdentity), new RegExp(`\\(path "/${schematicId}"`));
  const changedBoard = ownProject(
    {
      ...original,
      pcb: {
        ...original.pcb!,
        footprints: original.pcb!.footprints.map((footprint, index) =>
          index ? footprint : { ...footprint, libraryId: 'Changed:ImplicitFootprint' },
        ),
      },
    },
    original,
  );
  projectNativeFiles(changedBoard);
  assert.equal(changedBoard.schematic, original.schematic);
  const footprintEdit = verify({
    ...changedBoard,
    schematic: {
      ...changedBoard.schematic,
      parts: changedBoard.schematic.parts.map((part) =>
        part === firstPart ? { ...part, x: part.x + 1.27 } : part,
      ),
    },
  });
  assert.match(writeSExpr(footprintEdit), /"Footprint" "Changed:ImplicitFootprint"/);
  const replacedBacking = ownProject(
    {
      ...original,
      nativeFiles: {
        ...original.nativeFiles!,
        files: original.nativeFiles!.files.map((item) =>
          item.name === file.name ? { ...item, source: item.source + '\n' } : item,
        ),
      },
    },
    original,
  );
  assert.equal(
    projectNativeFiles(replacedBacking).files.find((item) => item.name === file.name)!.source,
    file.source + '\n',
  );
  assert.throws(
    () => projectNativeFiles(ownProject({ ...original, id: firstPart.id }, original)),
    /duplicate UUID/,
  );
  assert.throws(
    () =>
      projectNativeFiles(
        ownProject(
          {
            ...original,
            nativeFiles: {
              ...original.nativeFiles!,
              files: [...original.nativeFiles!.files, original.nativeFiles!.files[0]],
            },
          },
          original,
        ),
      ),
    /duplicate file/,
  );
  assert.deepEqual(projectNativeFiles(original), initial);
});

test('native project retains every file byte and unknown project settings on an unchanged round trip', () => {
  const files = nativeFixture();
  const project = projectFromNativeFiles(files);
  assert.equal(project.pcb!.footprints.length, 2);
  assert.ok(project.pcb!.nets.some((net) => net.name === 'Unused'));
  const written = projectNativeFiles(project);
  assert.equal(written.entry, files.entry);
  assert.deepEqual(
    new Map(written.files.map((file) => [file.name, file.source])),
    new Map(files.files.map((file) => [file.name, file.source])),
  );
});

test('native bytes survive private snapshots and recovery normalization', () => {
  const bundle = nativeFixture();
  const project = projectFromNativeFiles(bundle);
  const reopened = parseProject(serializeProject(project));
  const files = projectNativeFiles(reopened);
  for (const original of bundle.files)
    assert.equal(
      files.files.find((file) => file.name === original.name)?.source,
      original.source,
      original.name,
    );
});

test('edited native Source and IPC saves retain identical explicit instance defaults', () => {
  const bundle = nativeFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_sch'))!;
  const root = parseSExpr(file.source);
  const symbol = children(root, 'symbol')[0];
  for (const [key, value] of [
    ['body_style', '1'],
    ['exclude_from_sim', 'no'],
    ['in_bom', 'yes'],
    ['on_board', 'yes'],
    ['in_pos_files', 'yes'],
    ['dnp', 'no'],
  ]) {
    for (const old of children(symbol, key)) symbol.splice(symbol.indexOf(old), 1);
    symbol.splice(4, 0, [key, value]);
  }
  file.source = writeSExpr(root) + '\n';
  const edited = projectFromNativeFiles(bundle);
  edited.schematic.parts[0].value = '2k';
  const displayed = projectNativeFiles(edited);
  const saved = projectNativeFiles(parseProject(serializeProject(edited)));
  assert.deepEqual(saved, displayed);
  const written = children(
    parseSExpr(saved.files.find((item) => item.name === file.name)!.source),
    'symbol',
  )[0];
  for (const key of ['body_style', 'exclude_from_sim', 'in_bom', 'on_board', 'in_pos_files', 'dnp'])
    assert.deepEqual(child(written, key), child(symbol, key), key);
  const excluded = structuredClone(edited);
  excluded.schematic.parts[0].excludeFromSimulation = true;
  const changed = projectNativeFiles(parseProject(serializeProject(excluded)));
  const changedSymbol = children(
    parseSExpr(changed.files.find((item) => item.name === file.name)!.source),
    'symbol',
  )[0];
  assert.equal(val(child(changedSymbol, 'exclude_from_sim')), 'yes');
});

test('schematic and PCB edits serialize native files and retain board setup and auxiliary text', () => {
  const project = projectFromNativeFiles(nativeFixture());
  project.schematic.parts[0].value = '2k';
  project.pcb!.footprints[0].x += 1;
  const files = projectNativeFiles(project);
  const reopened = projectFromNativeFiles(files);
  assert.equal(reopened.schematic.parts[0].value, '2k');
  assert.equal(reopened.pcb!.footprints[0].x, project.pcb!.footprints[0].x);
  const board = parseSExpr(files.files.find((file) => file.name === 'Filter.kicad_pcb')!.source);
  assert.equal(val(child(child(board, 'setup')!, 'allow_soldermask_bridges_in_footprints')), 'no');
  assert.equal(val(child(children(board, 'footprint')[0], 'descr')), 'Retained package metadata');
  assert.equal(
    files.files.find((file) => file.name === 'models/design.spice')!.source,
    '* Simulation source — unchanged bytes\r\n',
  );
});

test('unrelated board edits retain native via copper settings, locks, fonts and zone display metadata', () => {
  const bundle = nativeFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_pcb'))!;
  const root = parseSExpr(file.source);
  children(root, 'via')[0].push(['remove_unused_layers', 'yes'], ['free', 'yes']);
  children(root, 'segment')[0].push('locked');
  const footprint = children(root, 'footprint')[0];
  footprint.push(['embedded_fonts', 'yes']);
  children(footprint, 'pad')[0].push('locked');
  children(footprint, 'property')[0].push('unlocked');
  child(children(root, 'zone')[0], 'hatch')!.splice(1, 2, 'full', '0.8');
  file.source = writeSExpr(root) + '\n';
  const project = projectFromNativeFiles(bundle);
  project.pcb!.footprints[1].x += 1;
  const recovered = parseProject(serializeProject(project));
  const board = parseSExpr(
    projectNativeFiles(recovered).files.find((item) => item.name === file.name)!.source,
  );
  assert.equal(val(child(children(board, 'via')[0], 'remove_unused_layers')), 'yes');
  assert.equal(val(child(children(board, 'via')[0], 'free')), 'yes');
  assert.ok(children(board, 'segment')[0].includes('locked'));
  const savedFootprint = children(board, 'footprint')[0];
  assert.equal(val(child(savedFootprint, 'embedded_fonts')), 'yes');
  assert.ok(children(savedFootprint, 'pad')[0].includes('locked'));
  assert.ok(children(savedFootprint, 'property')[0].includes('unlocked'));
  assert.deepEqual(child(children(board, 'zone')[0], 'hatch'), ['hatch', 'full', '0.8']);
});

test('owned native metadata merging copies only containers and retains frozen nested geometry', () => {
  const bundle = nativeFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_pcb'))!;
  const root = parseSExpr(file.source);
  const footprint = children(root, 'footprint')[0];
  footprint.push(['embedded_fonts', 'yes']);
  children(footprint, 'pad')[0].push('locked');
  const property = children(footprint, 'property')[0];
  property.push('unlocked');
  child(property, 'layer')!.push('knockout');
  children(root, 'via')[0].push(['remove_unused_layers', 'yes'], ['free', 'yes']);
  child(children(root, 'zone')[0], 'hatch')!.splice(1, 2, 'full', '0.8');
  file.source = writeSExpr(root) + '\n';
  const project = ownProject(projectFromNativeFiles(bundle));
  const board = project.pcb!;
  const next = ownProject({
    ...project,
    pcb: {
      ...board,
      footprints: board.footprints.map((item, index) =>
        index ? item : { ...item, x: item.x + 1 },
      ),
    },
  });
  const generated = materializedPCBTree(next.pcb!, next.schematic);
  const generatedBefore = writeSExpr(generated);
  assert.ok(isOwnedProjectNode(generated));
  const files = projectNativeFiles(next);
  assert.deepEqual(files, projectNativeFiles(structuredClone(next)));
  assert.equal(
    writeSExpr(generated),
    generatedBefore,
    'Merge cannot mutate its frozen generated basis.',
  );
  const saved = parseSExpr(files.files.find((item) => item.name === file.name)!.source);
  const retained = children(saved, 'footprint')[0];
  assert.equal(val(child(retained, 'embedded_fonts')), 'yes');
  assert.ok(children(retained, 'pad')[0].includes('locked'));
  assert.ok(children(retained, 'property')[0].includes('unlocked'));
  assert.ok(child(children(retained, 'property')[0], 'layer')!.includes('knockout'));
  assert.equal(val(child(children(saved, 'via')[0], 'free')), 'yes');
  assert.deepEqual(child(children(saved, 'zone')[0], 'hatch'), ['hatch', 'full', '0.8']);
});

test('optional clean native preparation cannot reject accepted backing metadata beyond its owned syntax limit', () => {
  const bundle = nativeFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_pcb'))!;
  const root = parseSExpr(file.source);
  let metadata = ['retained'] as ReturnType<typeof parseSExpr>;
  for (let index = 0; index < 82; index++) metadata = ['retained', metadata];
  root.push(['embedded_fonts', metadata]);
  file.source = writeSExpr(root) + '\n';
  const accepted = projectFromNativeFiles(bundle);
  const source = serializeProject(accepted);
  const core = new ProjectCore(accepted);
  const snapshot = core.getSnapshot();
  assert.equal(snapshot.source, source);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.undoDepth, 0);
  assert.equal(snapshot.sourceDraft, null);
  assert.equal(
    projectNativeFiles(snapshot.project!).files.find((item) => item.name === file.name)!.source,
    file.source,
  );
  for (const x of [0.1, 0.2]) {
    const board = snapshot.project!.pcb!;
    assert.throws(
      () =>
        core.replaceBoard({
          ...board,
          tracks: board.tracks.map((track, index) =>
            index ? track : { ...track, start: { ...track.start, x: track.start.x + x } },
          ),
        }),
      /nesting or object count/,
    );
    assert.equal(core.getSnapshot(), snapshot, 'A real failed edit remains atomic and retryable.');
    assert.equal(core.getSnapshot().source, source);
  }
});

test('native Source replacement validates the complete project and preserves project identity', () => {
  const project = projectFromNativeFiles(nativeFixture());
  const source = projectNativeFiles(project).files.find((file) =>
    file.name.endsWith('.kicad_sch'),
  )!.source;
  const next = replaceNativeProjectFile(
    project,
    'Filter.kicad_sch',
    source.replace('"1k"', '"3k"'),
  );
  assert.equal(next.id, project.id);
  assert.equal(next.schematic.parts[0].value, '3k');
  assert.equal(project.schematic.parts[0].value, '1k');
  assert.equal(replaceNativeProjectFile(project, 'Filter.kicad_sch', source), project);
  assert.throws(
    () => replaceNativeProjectFile(project, 'Filter.kicad_sch', source + ')'),
    /trailing/,
  );
  assert.throws(() => replaceNativeProjectFile(project, 'Filter.kicad_pro', '{'), /valid JSON/);
});

test('Save as renames matching root files while retaining extra schematic names and settings', () => {
  const bundle = nativeFixture();
  const additional = createProject(emptyCircuit());
  bundle.files.push({ name: 'Driver.kicad_sch', source: exportKiCad(additional, 'schematic') });
  const project = projectFromNativeFiles(bundle);
  const files = projectNativeFiles(project, 'Personal.kicad_pro');
  assert.equal(files.entry, 'Personal.kicad_pro');
  assert.ok(files.files.some((file) => file.name === 'Personal.kicad_sch'));
  assert.ok(files.files.some((file) => file.name === 'Personal.kicad_pcb'));
  assert.ok(files.files.some((file) => file.name === 'Driver.kicad_sch'));
  const settings = JSON.parse(files.files.find((file) => file.name === files.entry)!.source);
  assert.equal(settings.meta.filename, 'Personal.kicad_pro');
  assert.equal(settings.board.custom, true);
  assert.equal(settings.text_variables.REVISION, 'C');
});

test('new projects and Save as bind owning instances to the native stem while preserving foreign roots', () => {
  const fresh = exampleProject();
  const generated = projectNativeFiles(fresh, 'Native Name.kicad_pro');
  const generatedSchematic = parseSExpr(
    generated.files.find((file) => file.name.endsWith('.kicad_sch'))!.source,
  );
  for (const symbol of children(generatedSchematic, 'symbol'))
    assert.equal(val(children(child(symbol, 'instances')!, 'project')[0]), 'Native Name');
  const bundle = nativeFixture();
  const file = bundle.files.find((item) => item.name.endsWith('.kicad_sch'))!;
  const root = parseSExpr(file.source);
  const foreign = [
    'project',
    '"Foreign Project"',
    ['path', '"/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"', ['reference', '"R999"'], ['unit', '1']],
  ];
  const first = children(root, 'symbol')[0];
  child(first, 'instances')!.push(foreign);
  file.source = writeSExpr(root) + '\n';
  const project = projectFromNativeFiles(bundle);
  assert.equal(
    projectNativeFiles(project).files.find((item) => item.name === file.name)!.source,
    file.source,
  );
  const renamed = projectNativeFiles(project, 'Renamed.kicad_pro');
  const renamedSymbol = children(
    parseSExpr(renamed.files.find((item) => item.name === 'Renamed.kicad_sch')!.source),
    'symbol',
  )[0];
  const renamedInstances = child(renamedSymbol, 'instances')!;
  assert.ok(children(renamedInstances, 'project').some((block) => val(block) === 'Renamed'));
  assert.deepEqual(
    children(renamedInstances, 'project').find((block) => val(block) === 'Foreign Project'),
    foreign,
  );
  for (const target of ['Filter.kicad_pro', 'Renamed.kicad_pro']) {
    const edited = structuredClone(project);
    edited.schematic.parts[0].ref = 'R42';
    const files = projectNativeFiles(parseProject(serializeProject(edited)), target);
    const saved = parseSExpr(files.files.find((item) => item.name.endsWith('.kicad_sch'))!.source);
    const instances = child(children(saved, 'symbol')[0], 'instances')!;
    assert.deepEqual(
      children(instances, 'project').find((block) => val(block) === 'Foreign Project'),
      foreign,
    );
    const owner = children(instances, 'project').find(
      (block) => val(block) === target.replace('.kicad_pro', ''),
    )!;
    assert.equal(val(child(children(owner, 'path')[0], 'reference')), 'R42');
  }
});

test('standalone native PCB files receive stable unlinked editor identities', () => {
  const native = nativeFixture().files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  const bundle = { entry: native.name, files: [native] };
  const first = projectFromNativeFiles(bundle),
    second = projectFromNativeFiles(bundle);
  assert.equal(first.id, second.id);
  assert.equal(first.schematic.id, second.schematic.id);
  assert.deepEqual(first.pcb, second.pcb);
  assert.equal(first.pcb!.footprints[0].symbolId, null);
  const files = projectNativeFiles(first);
  assert.equal(files.files.find((file) => file.name === native.name)!.source, native.source);
  const recovered = parseProject(serializeProject(first));
  assert.equal(
    projectNativeFiles(recovered).files.find((file) => file.name === native.name)!.source,
    native.source,
  );
});

test('new projects generate only native KiCad files and preserve pinned simulation references', () => {
  const project = exampleProject();
  project.simulationModels = [{ ...simulationModelDefinitions[0] }];
  const files = projectNativeFiles(project, 'Power.kicad_pro');
  assert.deepEqual(
    files.files.map((file) => file.name),
    ['Power.kicad_pro', 'Power.kicad_sch', 'Power.kicad_pcb'],
  );
  const reopened = projectFromNativeFiles(files);
  assert.deepEqual(reopened.simulationModels, project.simulationModels);
  const settings = JSON.parse(files.files[0].source);
  assert.equal(typeof settings.text_variables.OPENPE_SIMULATION_MODELS, 'string');
  assert.ok(!files.files.some((file) => file.name.endsWith('.openpe.json')));
  delete settings.text_variables.OPENPE_SIMULATION_MODELS;
  const edited = replaceNativeProjectFile(reopened, 'Power.kicad_pro', JSON.stringify(settings));
  assert.equal(edited.simulationModels, undefined);
});

test('rejects traversal, Windows aliases, duplicate files and unsupported native objects atomically', () => {
  for (const name of [
    '../escape.txt',
    '/root.txt',
    'folder/../escape',
    'C:/escape',
    'file\\name',
    'CON.txt',
    'file.',
  ]) {
    const files = nativeFixture();
    files.files.push({ name, source: 'text' });
    assert.throws(() => validateKiCadProjectFiles(files), /relative name/);
  }
  const files = nativeFixture();
  for (const name of [
    'spice/project/circuit.cir',
    'SpIcE/project/model.lib',
    'thermal/project/circuit.cir',
    'upstream/input.kicad_sch',
    'upstream/simulation/model.lib',
    'ThErMaL/project/model.lib',
    'spice-simulation/board.circuit.cir',
    'spice-simulation/board.example-model-0.lib',
    'layout-thermal/input.kicad_sch',
    'pe-layout-skill/input.kicad_sch',
    'layout-parasitics/input.lib',
    'summary@example/input.kicad_sch',
  ]) {
    const cached = nativeFixture();
    cached.files.push({ name, source: '* private simulation artifact' });
    assert.throws(() => validateKiCadProjectFiles(cached), /relative name/);
  }
  files.files.push({ name: 'FILTER.KICAD_PRO', source: '{}' });
  assert.throws(() => projectFromNativeFiles(files), /duplicate/);
  const conflict = nativeFixture();
  conflict.files.push({ name: 'models/design.spice/child.lib', source: 'overlapping file' });
  assert.throws(() => projectFromNativeFiles(conflict), /overlap/);
  const unsupported = nativeFixture();
  const board = unsupported.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  board.source = board.source.replace('(kicad_pcb', '(kicad_pcb (mystery_geometry yes)');
  assert.throws(() => projectFromNativeFiles(unsupported), /unsupported mystery_geometry/);
});

test('owned native file cache never trusts caller freeze and never exposes cached mutation', () => {
  const project = projectFromNativeFiles(nativeFixture());
  Object.freeze(project.nativeFiles);
  Object.freeze(project);
  const original = project.nativeFiles!.files[1].source;
  for (const name of [undefined, 'Renamed.kicad_pro']) projectNativeFiles(project, name);
  project.nativeFiles!.files[1].source = original + ')';
  for (const name of [undefined, 'Renamed.kicad_pro'])
    assert.throws(() => projectNativeFiles(project, name), /trailing/);
  project.nativeFiles!.files[1].source = original;
  const owned = ownProject(project);
  for (const name of [undefined, 'First.kicad_pro', 'Second.kicad_pro', 'Third.kicad_pro']) {
    const first = projectNativeFiles(owned, name);
    const expected = structuredClone(first);
    first.entry = 'corrupted';
    first.files[0].source = 'corrupted';
    first.files[0].name = 'corrupted';
    first.files.length = 1;
    assert.deepEqual(projectNativeFiles(owned, name), expected);
    assert.equal(projectFromNativeFiles(expected).schematic.id, owned.schematic.id);
  }
  assert.equal(projectNativeFiles(owned).entry, 'Filter.kicad_pro');
  assert.throws(() => projectNativeFiles(owned, '../bad.kicad_pro'), /destination/);
});

test('private native snapshots reuse unchanged owned text packets and materialize current edits', () => {
  const bundle = nativeFixture();
  bundle.files.reverse();
  bundle.files.push({
    name: 'models/vendor.lib',
    source: '* Vendor bytes \u00e9\r\n',
    encoding: 'latin1',
  });
  const original = ownProject(projectFromNativeFiles(bundle));
  const before = projectNativeFilesSnapshot(original);
  assert.ok(isOwnedProjectNode(before));
  assert.ok(isOwnedProjectNode(before.files));
  for (const file of before.files) {
    assert.equal(
      file,
      original.nativeFiles!.files.find((item) => item.name === file.name),
    );
    assert.ok(isOwnedProjectNode(file));
  }
  assert.notDeepEqual(
    before.files.map((file) => file.name),
    original.nativeFiles!.files.map((file) => file.name),
  );
  assert.throws(() => {
    before.files[0].source = 'poisoned snapshot';
  }, /read only|readonly|Cannot assign/);

  const part = original.schematic.parts[0];
  const edited = ownProject(
    {
      ...original,
      schematic: {
        ...original.schematic,
        parts: original.schematic.parts.map((item) =>
          item.id === part.id ? { ...item, x: part.x + 1.27 } : item,
        ),
      },
    },
    original,
  );
  const current = projectNativeFilesSnapshot(edited);
  for (const file of current.files) {
    const previous = before.files.find((item) => item.name === file.name)!;
    if (file.name.endsWith('.kicad_sch')) assert.notEqual(file, previous);
    else assert.equal(file, previous);
  }
  const currentPart = projectFromNativeFiles(current).schematic.parts[0];
  assert.equal(currentPart.x, part.x + 1.27);
  assert.equal(currentPart.value, part.value);
  assert.equal(serializeProject(edited), serializeProject(structuredClone(edited)));
  const recovered = parseProject(serializeProject(edited));
  assert.deepEqual(projectNativeFiles(recovered), projectNativeFiles(edited));

  const valueEdit = ownProject(
    {
      ...edited,
      schematic: {
        ...edited.schematic,
        parts: edited.schematic.parts.map((item) =>
          item.id === part.id ? { ...item, value: 'Current edit' } : item,
        ),
      },
    },
    edited,
  );
  const valueSnapshot = projectNativeFilesSnapshot(valueEdit);
  assert.notEqual(
    valueSnapshot.files.find((file) => file.name.endsWith('.kicad_pcb')),
    current.files.find((file) => file.name.endsWith('.kicad_pcb')),
  );
  assert.match(
    valueSnapshot.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
    /\(property "Value" "Current edit"/,
  );
  assert.equal(serializeProject(valueEdit), serializeProject(structuredClone(valueEdit)));

  for (const name of ['Personal.kicad_pro', 'Other.kicad_pro', 'Third.kicad_pro', undefined]) {
    const snapshot = projectNativeFilesSnapshot(valueEdit, name);
    const exported = projectNativeFiles(valueEdit, name);
    assert.deepEqual(snapshot, exported);
    assert.notEqual(snapshot, exported);
    assert.notEqual(snapshot.files, exported.files);
    assert.equal(snapshot.entry, name ?? 'Filter.kicad_pro');
    assert.equal(
      snapshot.files.find((file) => file.name === 'models/vendor.lib')!.encoding,
      'latin1',
    );
    exported.files[0].source = 'caller mutation';
    assert.deepEqual(projectNativeFiles(valueEdit, name), snapshot);
    assert.equal(projectFromNativeFiles(snapshot).schematic.parts[0].value, 'Current edit');
  }
  assert.deepEqual(projectNativeFilesSnapshot(original), before);
});

test('private native snapshots do not certify foreign frozen projects or stale source text', () => {
  const caller = projectFromNativeFiles(nativeFixture());
  Object.freeze(caller);
  Object.freeze(caller.nativeFiles);
  const first = projectNativeFilesSnapshot(caller);
  assert.equal(isOwnedProjectNode(first), false);
  first.files[0].source = 'discarded caller result';
  assert.notEqual(projectNativeFilesSnapshot(caller).files[0].source, first.files[0].source);
  caller.nativeFiles!.files.find((file) => file.name.endsWith('.kicad_sch'))!.source += ')';
  assert.throws(() => projectNativeFilesSnapshot(caller), /trailing/);
  assert.throws(() => serializeProject(caller), /trailing/);
});

test('renamed native packets retain local byte validation across schematic pose edits without exposing cached wrappers', () => {
  const original = ownProject(projectFromNativeFiles(nativeFixture()));
  const part = original.schematic.parts[0];
  const before = projectNativeFilesSnapshot(original, 'Managed.kicad_pro');
  const boardFile = before.files.find((file) => file.name === 'Managed.kicad_pcb')!;
  const edited = ownProject(
    {
      ...original,
      schematic: {
        ...original.schematic,
        parts: original.schematic.parts.map((item) =>
          item.id === part.id ? { ...item, x: part.x + 1.27 } : item,
        ),
      },
    },
    original,
  );
  let boardEncodings = 0;
  const encode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (input?: string) {
    if (input === boardFile.source) boardEncodings++;
    return encode.call(this, input);
  };
  let current: KiCadProjectFiles;
  try {
    current = projectNativeFilesSnapshot(edited, 'Managed.kicad_pro');
  } finally {
    TextEncoder.prototype.encode = encode;
  }
  assert.equal(
    current.files.find((file) => file.name === boardFile.name),
    boardFile,
    'The renamed packet is the same internally owned immutable native file.',
  );
  assert.equal(boardEncodings, 0, 'Unchanged native board bytes are not encoded again.');
  assert.notEqual(
    current.files.find((file) => file.name === 'Managed.kicad_sch')!.source,
    before.files.find((file) => file.name === 'Managed.kicad_sch')!.source,
    'The edited schematic still materializes current geometry.',
  );
  assert.equal(projectFromNativeFiles(current).schematic.parts[0].x, part.x + 1.27);
  const exported = projectNativeFiles(edited, 'Managed.kicad_pro');
  const exportedBoard = exported.files.find((file) => file.name === boardFile.name)!;
  exportedBoard.source = 'caller mutation';
  exportedBoard.name = 'caller-name.kicad_pcb';
  assert.equal(boardFile.name, 'Managed.kicad_pcb');
  assert.equal(projectNativeFilesSnapshot(edited, 'Managed.kicad_pro'), current);
  assert.deepEqual(projectNativeFiles(edited, 'Managed.kicad_pro'), current);

  const valueEdit = ownProject(
    {
      ...edited,
      schematic: {
        ...edited.schematic,
        parts: edited.schematic.parts.map((item) =>
          item.id === part.id ? { ...item, value: 'Changed caption' } : item,
        ),
      },
    },
    edited,
  );
  const changedBoard = projectNativeFilesSnapshot(valueEdit, 'Managed.kicad_pro').files.find(
    (file) => file.name === boardFile.name,
  )!;
  assert.notEqual(changedBoard, boardFile);
  assert.match(changedBoard.source, /\(property "Value" "Changed caption"/);
});

test('renamed native packet caching bounds destinations and preserves complete bundle checks', () => {
  const original = ownProject(projectFromNativeFiles(nativeFixture()));
  const first = projectNativeFilesSnapshot(original, 'First.kicad_pro');
  const firstBoard = first.files.find((file) => file.name === 'First.kicad_pcb');
  for (const name of ['Second', 'Third', 'Fourth'])
    projectNativeFilesSnapshot(original, `${name}.kicad_pro`);
  const edited = ownProject({ ...original, name: 'Current title' }, original);
  const refreshed = projectNativeFilesSnapshot(edited, 'First.kicad_pro');
  assert.notEqual(
    refreshed.files.find((file) => file.name === 'First.kicad_pcb'),
    firstBoard,
    'Superseded destination wrappers are evicted instead of accumulating.',
  );
  assert.deepEqual(
    refreshed.files.find((file) => file.name === 'First.kicad_pcb'),
    firstBoard,
  );
  const duplicated = ownProject(
    {
      ...original,
      nativeFiles: {
        ...original.nativeFiles!,
        files: [...original.nativeFiles!.files, original.nativeFiles!.files[0]],
      },
    },
    original,
  );
  assert.throws(() => projectNativeFilesSnapshot(duplicated, 'First.kicad_pro'), /duplicate file/);
});

test('default and explicit native destinations retain current bytes across edits and Save as', () => {
  const original = ownProject(projectFromNativeFiles(nativeFixture()));
  serializeProject(original);
  const initial = projectNativeFiles(original);
  const explicit = projectNativeFiles(original, initial.entry);
  assert.deepEqual(explicit, initial);
  assert.notEqual(explicit.files, initial.files);
  assert.notEqual(explicit.files[0], initial.files[0]);
  explicit.files[0].source = 'caller mutation';
  assert.deepEqual(projectNativeFiles(original), initial);

  const firstPart = original.schematic.parts[0];
  const edited = ownProject(
    {
      ...original,
      schematic: {
        ...original.schematic,
        parts: original.schematic.parts.map((part) =>
          part.id === firstPart.id ? { ...part, x: part.x + 1.27, value: 'Current value' } : part,
        ),
      },
    },
    original,
  );
  serializeProject(edited);
  const current = projectNativeFiles(edited, initial.entry);
  assert.deepEqual(current, projectNativeFiles(edited));
  const reopened = projectFromNativeFiles(current).schematic.parts[0];
  assert.equal(reopened.x, firstPart.x + 1.27);
  assert.equal(reopened.value, 'Current value');
  const renamed = projectNativeFiles(edited, 'Personal.kicad_pro');
  assert.equal(renamed.entry, 'Personal.kicad_pro');
  assert.ok(renamed.files.some((file) => file.name === 'Personal.kicad_sch'));
  assert.deepEqual(projectNativeFiles(edited, initial.entry), current);
  assert.deepEqual(projectNativeFiles(original, initial.entry), initial);

  const explicitFirst = ownProject(projectFromNativeFiles(nativeFixture()));
  assert.deepEqual(
    projectNativeFiles(explicitFirst, 'Filter.kicad_pro'),
    projectNativeFiles(explicitFirst),
  );
});

test('mutable imports cannot expose or change private parsed native baselines', () => {
  const owned = ownProject(projectFromNativeFiles(nativeFixture()));
  validateProject(owned);
  const imported = projectFromNativeFiles(owned.nativeFiles!);
  const second = projectFromNativeFiles(owned.nativeFiles!);
  assert.notEqual(imported.schematic, second.schematic);
  assert.notEqual(imported.schematic.libraries, second.schematic.libraries);
  assert.notEqual(imported.pcb, second.pcb);
  imported.schematic.parts[0].value = 'Poisoned import';
  imported.pcb!.tracks[0].width = 9;
  assert.equal(second.schematic.parts[0].value, owned.schematic.parts[0].value);
  assert.equal(second.pcb!.tracks[0].width, owned.pcb!.tracks[0].width);
  const byName = (bundle: KiCadProjectFiles) => ({
    ...bundle,
    files: [...bundle.files].sort((a, b) => a.name.localeCompare(b.name)),
  });
  assert.deepEqual(byName(projectNativeFiles(owned)), byName(owned.nativeFiles!));
  const next = ownProject({ ...owned, extensions: { 'example.org': { edited: true } } }, owned);
  assert.deepEqual(byName(projectNativeFiles(next)), byName(owned.nativeFiles!));
});

test('private model validation rejects malformed retained native sources before a state commit', () => {
  for (const update of [
    (project: ReturnType<typeof projectFromNativeFiles>) => {
      project.nativeFiles!.files[0].source = '{';
    },
    (project: ReturnType<typeof projectFromNativeFiles>) => {
      project.nativeFiles!.files[1].source += ')';
    },
    (project: ReturnType<typeof projectFromNativeFiles>) => {
      project.nativeFiles!.files[2].source = '(kicad_pcb';
    },
    (project: ReturnType<typeof projectFromNativeFiles>) => {
      (project.nativeFiles!.files[1] as { name: unknown }).name = null;
    },
    (project: ReturnType<typeof projectFromNativeFiles>) => {
      project.nativeFiles!.files[1].source += '\0';
    },
  ]) {
    const project = projectFromNativeFiles(nativeFixture());
    update(project);
    assert.throws(
      () => serializeProject(project),
      /Invalid|JSON|trailing|parentheses|relative|UTF-8/,
    );
  }
  const project = projectFromNativeFiles(nativeFixture());
  Object.freeze(project);
  serializeProject(project);
  project.nativeFiles!.files[0].source = '{';
  assert.throws(() => serializeProject(project), /valid JSON/);
});

test('Latin-1 vendor source bytes retain their private encoding metadata through edits and recovery', () => {
  const bundle = nativeFixture();
  const vendor = {
    name: 'models/vendor.lib',
    source: '* Vendor Caf\u00e9 \u00ff\r\n.SUBCKT DEMO A B\r\n.ENDS\r\n',
    encoding: 'latin1' as const,
  };
  bundle.files.push(vendor);
  const project = projectFromNativeFiles(bundle);
  const recovered = parseProject(serializeProject(project));
  assert.deepEqual(
    projectNativeFiles(recovered).files.find((file) => file.name === vendor.name),
    vendor,
  );
  const edited = replaceNativeProjectFile(
    recovered,
    vendor.name,
    vendor.source + '* \u00a9 Vendor\r\n',
  );
  assert.deepEqual(
    projectNativeFiles(edited).files.find((file) => file.name === vendor.name),
    { ...vendor, source: vendor.source + '* \u00a9 Vendor\r\n' },
  );
  assert.throws(
    () => replaceNativeProjectFile(recovered, vendor.name, vendor.source + '\u03a9'),
    /representable/,
  );
  for (const suffix of ['.kicad_pro', '.kicad_sch', '.kicad_pcb']) {
    const invalid = nativeFixture();
    invalid.files.find((file) => file.name.endsWith(suffix))!.encoding = 'latin1';
    assert.throws(() => validateKiCadProjectFiles(invalid), /must be UTF-8/);
  }
});

test('all nine curated native schematic and PCB pairs reopen without changing their bytes', () => {
  for (const entry of manifest.examples) {
    const bundle = {
      entry: entry.file + '.kicad_sch',
      files: ['.kicad_sch', '.kicad_pcb'].map((suffix) => ({
        name: entry.file + suffix,
        source: readFileSync(
          new URL(`../examples/${entry.file}/${entry.file}${suffix}`, import.meta.url),
          'utf8',
        ),
      })),
    };
    const project = projectFromNativeFiles(bundle);
    const files = projectNativeFiles(project);
    for (const original of bundle.files)
      assert.equal(
        files.files.find((file) => file.name === original.name)?.source,
        original.source,
        entry.id,
      );
  }
});

test('all nine native Home projects retain their simulation decks through Source and recovery', () => {
  for (const entry of manifest.examples) {
    const original = parseProject(
      readFileSync(new URL(`fixtures/reference/${entry.file}.json`, import.meta.url), 'utf8'),
    );
    const bundle = {
      entry: entry.file + '.kicad_pro',
      files: ['.kicad_pro', '.kicad_sch', '.kicad_pcb'].map((suffix) => ({
        name: entry.file + suffix,
        source: readFileSync(
          new URL(`../examples/${entry.file}/${entry.file}${suffix}`, import.meta.url),
          'utf8',
        ),
      })),
    };
    const native = projectFromNativeFiles(bundle);
    const recovered = parseProject(serializeProject(native));
    assert.deepEqual(
      defaultTransient(recovered.schematic),
      defaultTransient(original.schematic),
      entry.id,
    );
    assert.deepEqual(
      buildSpiceDeck(recovered.schematic, defaultTransient(recovered.schematic)),
      buildSpiceDeck(original.schematic, defaultTransient(original.schematic)),
      entry.id,
    );
    const files = projectNativeFiles(recovered);
    for (const file of bundle.files)
      assert.equal(
        files.files.find((item) => item.name === file.name)?.source,
        file.source,
        entry.id + ': ' + file.name,
      );
  }
});
