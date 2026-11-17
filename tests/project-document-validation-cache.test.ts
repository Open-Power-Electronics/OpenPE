import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import type { Project } from '../lib/project';
import type { ProjectDocument } from '../lib/project-document';
import type { ObjectSchematic } from '../lib/project-objects';

type FlatComponent = NonNullable<
  ReturnType<typeof import('../lib/project-objects').ungroupProjectSchematic>['components']
>[number];
type TestAPI = {
  validateDocumentForTest(input: unknown, reuse?: boolean): void;
  acceptedComponentForTest(component: FlatComponent): boolean;
  ownProjectData<T>(input: T, previous?: T): T;
  ownProject(input: Project, previous?: Project): Project;
  ungroupProjectSchematic(
    sheet: ObjectSchematic,
    reuse?: boolean,
  ): {
    components?: FlatComponent[];
  };
  exampleProject(): Project;
  serializeProject(project: Project): string;
  toProjectDocument(project: Project, reuse?: boolean): ProjectDocument;
};

// Expose private acceptance only in an in-memory correctness-test bundle. This
// verifies eligibility/publication without timing, counters or production hooks.
const bundle = await build({
  stdin: {
    contents: `
      export { validateDocumentForTest, acceptedComponentForTest, serializeProject } from './lib/project';
      export { ownProjectData, ownProject } from './lib/immutable-project';
      export { ungroupProjectSchematic } from './lib/project-objects';
      export { exampleProject } from './lib/project-example';
      export { toProjectDocument } from './lib/project-document';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'private-document-validation-test',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]lib[\\/]project\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          return {
            contents: `${source}
              export { validateFileDocument as validateDocumentForTest };
              export const acceptedComponentForTest = (component: FlatDocumentComponent) =>
                validatedOwnedDocumentComponents.has(component);
            `,
            loader: 'ts',
            resolveDir: dirname(path),
          };
        });
      },
    },
  ],
});
const api = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)) as TestAPI;

function documentFixture(): ProjectDocument {
  return {
    format: 'openpe',
    version: 1,
    units: 'mm',
    project: { id: '00000000-0000-4000-8000-000000000001', name: 'Local checks' },
    schematic: {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Local checks',
      components: ['R1', 'R2'].map((reference, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index + 3}`,
        position: { x: index * 10, y: 0 },
        symbol: 'Device:R',
        reference,
        value: '1k',
        fields: { Tolerance: '1%' },
        fieldLayout: { Tolerance: [['at', '0', '0', '0']] },
      })),
    },
  };
}
const components = (document: ProjectDocument, reuse = true) =>
  api.ungroupProjectSchematic(document.schematic, reuse).components!;
function failure(document: ProjectDocument, reuse = true): string {
  let message = '';
  assert.throws(
    () => api.validateDocumentForTest(document, reuse),
    (error) => {
      assert.ok(error instanceof Error);
      message = error.message;
      return true;
    },
  );
  return message;
}

test('unchanged owned flat components reuse only their successful local acceptance', () => {
  const document = api.ownProjectData(documentFixture());
  const flat = components(document);
  assert.equal(api.acceptedComponentForTest(flat[0]), false);
  api.validateDocumentForTest(document, true);
  assert.ok(flat.every(api.acceptedComponentForTest));
  const changed = api.ownProjectData(
    { ...document, project: { ...document.project, name: 'Different project metadata' } },
    document,
  );
  assert.equal(components(changed)[0], flat[0]);
  api.validateDocumentForTest(changed, true);
  assert.deepEqual(changed.schematic, document.schematic);
});

test('changed same-ID component values and field layouts receive fresh checks', () => {
  const original = api.ownProjectData(documentFixture());
  api.validateDocumentForTest(original, true);
  for (const patch of [
    { fields: {} },
    { simulation: { valueFormat: 'X=${VALUE}' }, value: '1 2' },
    { simulation: { valueFormat: '${VALUE}' }, value: '${UNRESOLVED}' },
    { simulation: { valueFormat: `${'p'.repeat(4080)}=\${VALUE}` }, value: 'v'.repeat(16) },
  ]) {
    const candidate = api.ownProjectData(
      {
        ...original,
        schematic: {
          ...original.schematic,
          components: original.schematic.components!.map((component, index) =>
            index ? component : { ...component, ...patch },
          ),
        },
      },
      original,
    );
    const changed = components(candidate)[0];
    assert.equal(changed.id, components(original)[0].id);
    assert.equal(api.acceptedComponentForTest(changed), false);
    const reference = failure(structuredClone(candidate), false);
    assert.match(reference, /field layout|invalid simulation value binding/);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(failure(candidate), reference);
      assert.equal(api.acceptedComponentForTest(changed), false);
    }
  }
});

test('later document errors publish no new component certificates and remain retryable', () => {
  for (const late of ['component', 'label', 'title', 'network-order'] as const) {
    const mutable = documentFixture();
    if (late === 'component') mutable.schematic.components![1].fields = {};
    if (late === 'label' || late === 'network-order')
      mutable.schematic.nets = [
        {
          id: 'schematic:00000000-0000-4000-8000-000000000005',
          schematic: {
            labels: [
              {
                id: '00000000-0000-4000-8000-000000000005',
                position: { x: 0, y: 0 },
                text: 'NODE',
                scope: 'global',
                order: 0,
              },
            ],
          },
        },
      ];
    if (late === 'network-order') {
      mutable.schematic.nets![0].schematic!.labels![0].shape = 'input';
      mutable.schematic.nets![0].schematic!.labels!.push({
        ...mutable.schematic.nets![0].schematic!.labels![0],
        id: '00000000-0000-4000-8000-000000000006',
      });
    }
    if (late === 'title')
      mutable.schematic.kicad = [['title_block', ['title', '"Unsupported title"']]];
    const invalid = api.ownProjectData(mutable),
      first = components({ ...invalid, schematic: { ...invalid.schematic, nets: undefined } })[0];
    assert.equal(api.acceptedComponentForTest(first), false);
    const reference = failure(structuredClone(invalid), false);
    assert.equal(failure(invalid), reference);
    assert.equal(failure(invalid), reference);
    assert.equal(api.acceptedComponentForTest(first), false);
    const fixedInput: ProjectDocument = {
      ...invalid,
      schematic: {
        ...invalid.schematic,
        components: invalid.schematic.components!.map((component, index) =>
          late === 'component' && index === 1
            ? documentFixture().schematic.components![1]
            : component,
        ),
      },
    };
    delete fixedInput.schematic.nets;
    delete fixedInput.schematic.kicad;
    const fixed = api.ownProjectData(fixedInput, invalid);
    api.validateDocumentForTest(fixed, true);
    assert.equal(components(fixed)[0], first);
    assert.ok(components(fixed).every(api.acceptedComponentForTest));
  }
});

test('mutable and caller-frozen nested fields never establish local acceptance', () => {
  for (const freeze of [false, true]) {
    const caller = documentFixture();
    if (freeze) {
      Object.freeze(caller);
      Object.freeze(caller.schematic.components![0]);
    }
    api.validateDocumentForTest(caller, true);
    assert.equal(api.acceptedComponentForTest(components(caller)[0]), false);
    delete caller.schematic.components![0].fields!.Tolerance;
    assert.match(failure(caller), /field layout Tolerance has no matching component field/);
  }
  const owned = api.ownProjectData(documentFixture());
  api.validateDocumentForTest(owned, false);
  assert.ok(components(owned).every((component) => !api.acceptedComponentForTest(component)));
});

test('track-only Source serialization retains the certificate without bypassing global validation', () => {
  const project = api.ownProject(api.exampleProject());
  const original = api.serializeProject(project);
  const flat = components(api.toProjectDocument(project, true));
  assert.ok(flat.every(api.acceptedComponentForTest));
  const next = api.ownProject(
    {
      ...project,
      pcb: {
        ...project.pcb!,
        tracks: project.pcb!.tracks.map((track, index) =>
          index ? track : { ...track, start: { ...track.start, x: track.start.x + 0.1 } },
        ),
      },
    },
    project,
  );
  const nextFlat = components(api.toProjectDocument(next, true));
  assert.equal(next.schematic, project.schematic);
  assert.equal(nextFlat[0], flat[0]);
  assert.equal(api.serializeProject(next), api.serializeProject(structuredClone(next)));
  assert.equal(api.serializeProject(project), original);
  assert.throws(
    () => api.serializeProject(api.ownProject({ ...next, id: next.schematic.parts[0].id }, next)),
    /duplicate UUID/,
  );
  const invalid = api.ownProject(
    {
      ...next,
      pcb: {
        ...next.pcb!,
        tracks: next.pcb!.tracks.map((track, index) =>
          index ? track : { ...track, netId: '00000000-0000-4000-8000-000000000099' },
        ),
      },
    },
    next,
  );
  assert.throws(() => api.serializeProject(invalid), /missing PCB net/);
  assert.equal(api.serializeProject(next), api.serializeProject(structuredClone(next)));
});
