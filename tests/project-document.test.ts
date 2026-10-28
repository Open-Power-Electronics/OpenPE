import test from 'node:test';
import assert from 'node:assert/strict';
import { createExample, projectExamples } from '../lib/examples';
import {
  appendSchematic,
  createProject,
  exportKiCad,
  parseProject,
  projectFilename,
  schematicFileFingerprint,
  schematicDocumentItems,
  serializeProject,
} from '../lib/project';
import { exampleProject } from '../lib/project-example';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { symbolAnnotation } from '../lib/library';
import { schematicTexts } from '../lib/schematic-text';

test('project files contain design sections, with no editor snapshots or application state', () => {
  for (const { id } of projectExamples) {
    const project = createExample(id);
    const document = JSON.parse(serializeProject(project));
    assert.equal(document.format, 'openpe');
    assert.deepEqual(Object.keys(document), [
      'format',
      'version',
      'units',
      'project',
      'schematic',
      'libraries',
      'extensions',
      ...(project.simulationModels?.length ? ['simulationModels'] : []),
    ]);
    assert.equal(document.project.id, project.id);
    assert.equal(document.schematic.name, project.schematic.title);
    assert.deepEqual(document.libraries.symbols, project.schematic.libraries);
    assert.equal(document.schematic.original, undefined);
    assert.equal(document.schematic.libraries, undefined);
    assert.equal(document.schematic.parts, undefined);
    assert.ok(document.schematic.components.every((p: any) => !('raw' in p)));
    assert.ok(
      document.schematic.kicad.every(
        (n: string[]) => !['lib_symbols', 'symbol', 'wire', 'text'].includes(n[0]),
      ),
    );
    const roundTrip = parseProject(serializeProject(project));
    assert.equal(serializeProject(roundTrip), serializeProject(project));
    assert.deepEqual(
      schematicTexts(roundTrip.schematic.original),
      schematicTexts(project.schematic.original),
    );
    for (const p of project.schematic.parts) {
      const reopened = roundTrip.schematic.parts.find((r) => r.id === p.id)!;
      for (const field of ['Reference', 'Value'] as const)
        assert.deepEqual(
          symbolAnnotation(reopened, roundTrip.schematic.libraries[p.libId], field),
          symbolAnnotation(p, project.schematic.libraries[p.libId], field),
        );
    }
  }
});

test('empty projects omit empty sections and accept explicit defaults without changing content', () => {
  const project = appendSchematic(createProject()).project;
  const source = serializeProject(project);
  const document = JSON.parse(source);
  for (const key of ['pcb', 'libraries', 'extensions']) assert.ok(!(key in document));
  for (const file of [document, ...document.additionalSchematics]) {
    for (const key of ['components', 'nets', 'noConnects', 'texts']) {
      assert.ok(!(key in file.schematic));
      file.schematic[key] = [];
    }
    file.libraries = { symbols: {} };
  }
  document.pcb = null;
  document.extensions = {};
  const reopened = parseProject(JSON.stringify(document));
  assert.equal(serializeProject(reopened), source);
  assert.equal(exportKiCad(reopened, 'schematic'), exportKiCad(parseProject(source), 'schematic'));
  assert.equal(reopened.additionalSchematics![0].id, project.additionalSchematics![0].id);
});

test('omitted component and label defaults equal explicit values, including file fingerprints', () => {
  const project = exampleProject();
  project.extensions.preserved = {
    empty: {},
    list: [],
    value: '',
    off: false,
    zero: 0,
    absent: null,
  };
  const source = serializeProject(project);
  const document = JSON.parse(source);
  assert.ok(document.schematic.components.some((p: any) => !('rotation' in p)));
  for (const p of document.schematic.components) {
    p.rotation ??= 0;
    p.unit ??= 1;
    p.fields ??= {};
    p.fieldLayout ??= {};
    p.kicad ??= [];
  }
  for (const p of schematicDocumentItems(document.schematic, 'labels') ?? []) {
    p.rotation ??= 0;
    p.scope ??= 'local';
    p.kicad ??= [];
  }
  const reopened = parseProject(JSON.stringify(document));
  assert.equal(serializeProject(reopened), source);
  assert.equal(
    schematicFileFingerprint(reopened, project.schematic.id),
    schematicFileFingerprint(project, project.schematic.id),
  );
  assert.deepEqual(reopened.extensions, project.extensions);
  assert.deepEqual(reopened.pcb, project.pcb);
  assert.equal(exportKiCad(reopened, 'schematic'), exportKiCad(parseProject(source), 'schematic'));
});

test('optional fields reject invalid explicit values and missing required design data', () => {
  const mutations: ((p: any) => void)[] = [
    (p) => {
      p.extensions = null;
    },
    (p) => {
      p.libraries = null;
    },
    (p) => {
      p.schematic.nets[0].schematic.wires = null;
    },
    (p) => {
      p.schematic.kicad = {};
    },
    (p) => {
      p.schematic.components[0].rotation = null;
    },
    (p) => {
      p.schematic.components[0].unit = 0;
    },
    (p) => {
      p.schematic.components[0].fields = null;
    },
    (p) => {
      p.schematic.components[0].fieldLayout = null;
    },
    (p) => {
      schematicDocumentItems(p.schematic, 'labels')[0].scope = 'unknown' as never;
    },
    (p) => {
      delete p.schematic.components[0].position;
    },
    (p) => {
      delete p.libraries;
    },
    (p) => {
      delete p.schematic.name;
    },
    (p) => {
      delete p.schematic.components[0].fields;
      p.schematic.components[0].fieldLayout.Missing = [];
    },
  ];
  for (const mutate of mutations) {
    const document = JSON.parse(serializeProject(exampleProject()));
    mutate(document);
    assert.throws(() => parseProject(JSON.stringify(document)), /Invalid OpenPE project/);
  }
});

test('compact JSON keeps Unicode, escaped strings, arrays and coordinates lossless', () => {
  const project = createExample('kicad-buck');
  project.extensions.strings = ['汉字 Ω', '"quoted"', '\\path\\', 'line\nfeed', '\t', '[null,{}]'];
  const source = serializeProject(project);
  const document = JSON.parse(source);
  assert.ok(source.length < JSON.stringify(document, null, 2).length * 0.7);
  assert.match(source, /"position": \{ "x":/);
  assert.deepEqual(parseProject(source).extensions, project.extensions);
  assert.equal(serializeProject(parseProject(source)), source);
});

test('instance defaults compact identically across files without changing libraries or board data', () => {
  const project = exampleProject();
  project.additionalSchematics = [createExample('kicad-rectifier').schematic];
  const before = structuredClone(project);
  const source = serializeProject(project);
  const document = JSON.parse(source);
  for (const file of [document, ...document.additionalSchematics]) {
    for (const component of file.schematic.components) {
      const native = (component.kicad ??= []);
      for (const node of [
        ['body_style', '1'],
        ['exclude_from_sim', 'no'],
        ['in_bom', 'yes'],
        ['on_board', 'yes'],
        ['in_pos_files', 'yes'],
        ['dnp', 'no'],
      ]) {
        if (!native.some((n: string[]) => n[0] === node[0])) native.push(node);
      }
      for (const layout of Object.values(component.fieldLayout ?? {}) as string[][][])
        layout.push(['show_name', 'no'], ['do_not_autoplace', 'no']);
    }
    for (const wire of schematicDocumentItems(file.schematic, 'wires') ?? [])
      wire.kicad ??= [['stroke', ['width', '0'], ['type', 'default']]];
    for (const junction of schematicDocumentItems(file.schematic, 'junctions') ?? []) {
      const native = (junction.kicad ??= []);
      for (const node of [
        ['diameter', '0'],
        ['color', '0', '0', '0', '0'],
      ])
        if (!native.some((n) => n[0] === node[0])) native.push(node);
    }
  }
  const explicit = JSON.stringify(document);
  const reopened = parseProject(explicit);
  assert.equal(serializeProject(reopened), source);
  assert.deepEqual(project, before, 'Serialization must not mutate the live editor.');
  assert.deepEqual(reopened.pcb, before.pcb);
  assert.deepEqual(reopened.extensions, before.extensions);
  for (const [index, schematic] of [
    reopened.schematic,
    ...reopened.additionalSchematics!,
  ].entries()) {
    const original = [before.schematic, ...before.additionalSchematics!][index];
    assert.deepEqual(schematic.libraries, original.libraries);
    assert.equal(
      schematicFileFingerprint(reopened, schematic.id),
      schematicFileFingerprint(before, schematic.id),
    );
  }
});

test('hidden default field layouts are derived while custom and explicitly empty layouts survive', () => {
  const project = exampleProject();
  const document = JSON.parse(serializeProject(project));
  const component = document.schematic.components[0];
  assert.equal(component.fieldLayout.Description, undefined);
  component.fieldLayout.Description = [
    ['at', String(component.position.x), String(component.position.y), '0'],
    ['hide', 'yes'],
    ['show_name', 'no'],
    ['do_not_autoplace', 'no'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
  ];
  const reopened = parseProject(JSON.stringify(document));
  assert.equal(serializeProject(reopened), serializeProject(project));
  const part = children(parseSExpr(exportKiCad(reopened, 'schematic')), 'symbol').find(
    (n) => val(child(n, 'uuid')) === component.id,
  )!;
  const description = children(part, 'property').find((n) => val(n) === 'Description')!;
  assert.deepEqual(child(description, 'at'), component.fieldLayout.Description[0]);
  assert.ok(child(description, 'hide') || child(child(description, 'effects')!, 'hide'));
  component.fields.Custom = 'Retained after a derived hidden field';
  component.fieldLayout.Custom = [
    ['at', String(component.position.x), String(component.position.y + 1.27), '0'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
  ];
  const custom = serializeProject(parseProject(JSON.stringify(document)));
  assert.equal(serializeProject(parseProject(custom)), custom, 'Field order must stay stable.');
  component.fieldLayout.Description[0][1] = String(component.position.x + 1.27);
  const moved = JSON.parse(serializeProject(parseProject(JSON.stringify(document))));
  assert.deepEqual(
    moved.schematic.components[0].fieldLayout.Description[0],
    component.fieldLayout.Description[0],
  );
  component.fieldLayout.Description = [];
  const empty = JSON.parse(serializeProject(parseProject(JSON.stringify(document))));
  assert.deepEqual(empty.schematic.components[0].fieldLayout.Description, []);
});

test('nondefault native flags, styles, pin UUIDs and field values remain authoritative', () => {
  const project = exampleProject();
  const document = JSON.parse(serializeProject(project));
  const component = document.schematic.components[0];
  component.kicad = [
    ['in_bom', 'no'],
    ['on_board', 'no'],
    ['in_pos_files', 'no'],
    ['dnp', 'yes'],
    ['fields_autoplaced', 'yes'],
    ['pin', '"1"', ['uuid', '"090fd541-459e-4ac5-8778-f30eb39536b8"']],
  ];
  component.simulation = { excluded: true };
  component.fields.Empty = '';
  component.fieldLayout.Value.push(['show_name', 'yes'], ['do_not_autoplace', 'yes']);
  schematicDocumentItems(document.schematic, 'wires')[0].kicad = [
    ['stroke', ['width', '0.254'], ['type', 'dash'], ['color', '25', '50', '75', '1']],
  ];
  const reopened = parseProject(JSON.stringify(document));
  const saved = JSON.parse(serializeProject(reopened));
  assert.deepEqual(saved.schematic.components[0], component);
  assert.deepEqual(
    schematicDocumentItems(saved.schematic, 'wires')[0],
    schematicDocumentItems(document.schematic, 'wires')[0],
  );
  assert.deepEqual(reopened.pcb, project.pcb);
  const native = parseSExpr(exportKiCad(reopened, 'schematic'));
  const part = children(native, 'symbol').find((n) => val(child(n, 'uuid')) === component.id)!;
  for (const node of component.kicad)
    assert.ok(part.some((n) => JSON.stringify(n) === JSON.stringify(node)));
});

test('default cleanup preserves repeated metadata and complete stroke attributes', () => {
  const document = JSON.parse(serializeProject(exampleProject()));
  document.schematic.components[0].kicad = [
    ['in_bom', 'yes'],
    ['in_bom', 'no'],
  ];
  schematicDocumentItems(document.schematic, 'wires')[0].kicad = [
    ['stroke', ['width', '0'], ['type', 'default'], ['color', '0', '0', '0', '1']],
  ];
  const saved = JSON.parse(serializeProject(parseProject(JSON.stringify(document))));
  assert.deepEqual(saved.schematic.components[0].kicad, document.schematic.components[0].kicad);
  assert.deepEqual(
    schematicDocumentItems(saved.schematic, 'wires')[0].kicad,
    schematicDocumentItems(document.schematic, 'wires')[0].kicad,
  );
});

test('current private project snapshots preserve the complete project and reject legacy format markers', () => {
  const project = appendSchematic(exampleProject()).project;
  project.name = 'Controller design';
  project.extensions.roundTrip = {
    labels: ['温度 Ω', 'line\nfeed', '"quoted"'],
    values: [0, false, null, {}, []],
  };
  const source = serializeProject(project);
  const document = JSON.parse(source);
  assert.equal(document.format, 'openpe');
  assert.equal(projectFilename(project.name), 'Controller design.kicad_pro');
  assert.equal(document.additionalSchematics.length, 1);
  assert.match(source, /"position": \{ "x":/);
  const reopened = parseProject(source);
  assert.equal(serializeProject(reopened), source);
  assert.deepEqual(reopened.pcb, project.pcb);
  assert.deepEqual(reopened.extensions, project.extensions);
  assert.deepEqual(reopened.schematic.libraries, project.schematic.libraries);
  assert.equal(reopened.additionalSchematics![0].id, project.additionalSchematics![0].id);
  const oldDocument = { ...document, format: 'unsupported-format' };
  assert.throws(
    () => parseProject(JSON.stringify(oldDocument)),
    /unsupported internal snapshot format/i,
  );
  assert.equal(serializeProject(project), source);
});

test('structured Source fields are authoritative and removed fields cannot reappear from snapshots', () => {
  const original = exampleProject();
  const document = JSON.parse(serializeProject(original));
  document.project.name = 'Power supply project';
  document.schematic.name = 'Output filter';
  const component = document.schematic.components[0];
  component.reference = 'R42';
  component.value = '2k';
  component.position = { x: 76.2, y: 50.8 };
  component.fields.Review = 'Approved';
  const edited = parseProject(JSON.stringify(document));
  assert.equal(edited.name, 'Power supply project');
  assert.equal(edited.schematic.title, 'Output filter');
  assert.equal(edited.schematic.parts[0].x, 76.2);
  const native = parseSExpr(exportKiCad(edited, 'schematic'));
  const node = children(native, 'symbol').find((n) => val(child(n, 'uuid')) === component.id)!;
  const fields = Object.fromEntries(children(node, 'property').map((p) => [val(p), val(p, 2)]));
  assert.equal(fields.Reference, 'R42');
  assert.equal(fields.Value, '2k');
  assert.equal(fields.Review, 'Approved');
  assert.deepEqual(edited.pcb, original.pcb);
  const saved = JSON.parse(serializeProject(edited));
  delete saved.schematic.components[0].fields.Review;
  delete saved.schematic.components[0].fieldLayout.Review;
  assert.ok(!exportKiCad(parseProject(JSON.stringify(saved)), 'schematic').includes('Approved'));
});

test('old structures, unknown fields and redundant authoritative native data are rejected', () => {
  assert.throws(() => parseProject(JSON.stringify(createProject())), /Invalid OpenPE project/);
  const mutations: ((p: any) => void)[] = [
    (p) => {
      p.version = 3;
    },
    (p) => {
      p.sessions = [];
    },
    (p) => {
      p.appearance = {};
    },
    (p) => {
      p.project.path = 'C:/private/design.json';
    },
    (p) => {
      p.schematic.selected = [];
    },
    (p) => {
      p.schematic.original = ['kicad_sch'];
    },
    (p) => {
      p.schematic.components[0].raw = ['symbol'];
    },
    (p) => {
      (p.schematic.components[0].kicad ??= []).push(['at', '0', '0', '0']);
    },
    (p) => {
      (schematicDocumentItems(p.schematic, 'wires')[0].kicad ??= []).push([
        'pts',
        ['xy', '0', '0'],
      ]);
    },
    (p) => {
      p.schematic.components[0].fieldLayout.Missing = [];
    },
    (p) => {
      p.schematic.kicad.push(['title_block', ['title', '"duplicate"']]);
    },
    (p) => {
      p.schematic.kicad.push(['unsupported_sheet']);
    },
    (p) => {
      schematicDocumentItems(p.schematic, 'labels')[0].scope = 'global';
    },
    (p) => {
      p.schematic.components[0].footprints[0].symbolId = p.project.id;
    },
  ];
  for (const mutate of mutations) {
    const document = JSON.parse(serializeProject(exampleProject()));
    mutate(document);
    assert.throws(() => parseProject(JSON.stringify(document)));
  }
});

test('native metadata conversion rejects duplicate fields and unsupported atoms instead of losing them', () => {
  const duplicate = createExample('kicad-rectifier');
  const part = duplicate.schematic.parts[0];
  part.raw!.push(structuredClone(children(part.raw!, 'property')[0]));
  assert.throws(() => serializeProject(duplicate), /Duplicate KiCad component fields/);
  const unsupported = createExample('kicad-rectifier');
  unsupported.schematic.parts[0].raw!.push('unsupported_attribute');
  assert.throws(() => serializeProject(unsupported), /Unsupported KiCad metadata atom/);
});
