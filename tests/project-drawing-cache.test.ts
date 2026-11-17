import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, uid } from '../lib/circuit';
import { ownProject } from '../lib/immutable-project';
import { createHomeExample } from '../lib/create-home-example';
import { homeExampleCatalog } from '../lib/home-examples';
import { createProject, projectNativeFiles, serializeProject } from '../lib/project';
import { toProjectDocument } from '../lib/project-document';
import { schematicDocumentItems } from '../lib/project-objects';
import { child, parseSExpr } from '../lib/sexpr';

function fixture() {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', 0, 0));
  circuit.wires = [0, 20].map((y) => ({
    id: uid(),
    a: { x: -10, y },
    b: { x: 10, y },
    raw: parseSExpr(`(wire (pts (xy -10 ${y}) (xy 10 ${y}))
      (stroke (width 0.1) (type dash)) (uuid "${uid()}"))`),
  }));
  circuit.junctions = [{ id: uid(), x: 0, y: 0 }];
  circuit.labels = [
    { id: uid(), x: -10, y: 0, text: 'A' },
    { id: uid(), x: -10, y: 20, text: 'B', scope: 'global', shape: 'input' },
  ];
  circuit.noConnects = [{ id: uid(), x: 100, y: 100 }];
  // Native records retain the same identity as their editor objects.
  circuit.wires.forEach((wire) => (child(wire.raw!, 'uuid')![1] = `"${wire.id}"`));
  return createProject(circuit);
}

test('private drawing reuse equals public conversion for every Home project and changed poses', () => {
  for (const example of homeExampleCatalog) {
    const project = ownProject(createHomeExample(example.id, (id) => id));
    assert.deepEqual(toProjectDocument(project, true), toProjectDocument(project));
    const part = project.schematic.parts.find((part) => !part.ref.startsWith('#'))!;
    const next = ownProject({
      ...project,
      schematic: {
        ...project.schematic,
        parts: project.schematic.parts.map((item) =>
          item === part ? { ...item, x: item.x + 1.27 } : item,
        ),
      },
    });
    assert.deepEqual(toProjectDocument(next, true), toProjectDocument(next), example.id);
    assert.equal(serializeProject(next), serializeProject(structuredClone(next)), example.id);
    assert.deepEqual(
      projectNativeFiles(next),
      projectNativeFiles(structuredClone(next)),
      example.id,
    );
  }
});

test('drawing packets retain unchanged identities while regrouping, metadata and order remain current', () => {
  const project = ownProject(fixture());
  const before = toProjectDocument(project, true);
  const first = schematicDocumentItems(before.schematic, 'wires')[0];
  const next = ownProject({
    ...project,
    schematic: { ...project.schematic, title: 'Changed title' },
  });
  const title = toProjectDocument(next, true);
  assert.equal(schematicDocumentItems(title.schematic, 'wires')[0], first);
  assert.equal(
    schematicDocumentItems(title.schematic, 'labels')[0],
    schematicDocumentItems(before.schematic, 'labels')[0],
  );
  assert.equal(
    schematicDocumentItems(title.schematic, 'junctions')[0],
    schematicDocumentItems(before.schematic, 'junctions')[0],
  );
  assert.equal(title.schematic.noConnects![0], before.schematic.noConnects![0]);

  const merged = ownProject({
    ...next,
    schematic: {
      ...next.schematic,
      wires: [...next.schematic.wires, { id: uid(), a: { x: 10, y: 0 }, b: { x: 10, y: 20 } }],
    },
  });
  const mergedDocument = toProjectDocument(merged, true);
  assert.deepEqual(mergedDocument, toProjectDocument(merged));
  assert.equal(mergedDocument.schematic.nets!.filter((net) => net.schematic?.wires).length, 1);
  assert.equal(schematicDocumentItems(mergedDocument.schematic, 'wires')[0], first);

  const changed = structuredClone(merged);
  changed.schematic.wires.reverse();
  child(child(changed.schematic.wires[2].raw!, 'stroke')!, 'width')![1] = '0.3';
  changed.schematic.labels[0].text = 'RENAMED';
  const edited = ownProject(changed, merged);
  const actual = toProjectDocument(edited, true);
  assert.deepEqual(actual, toProjectDocument(edited));
  assert.deepEqual(
    schematicDocumentItems(actual.schematic, 'wires').map((wire) => wire.id),
    changed.schematic.wires.map((wire) => wire.id),
  );
  assert.deepEqual(schematicDocumentItems(actual.schematic, 'wires')[2].kicad, [
    ['stroke', ['width', '0.3'], ['type', 'dash']],
  ]);
  assert.equal(serializeProject(edited), serializeProject(structuredClone(edited)));
});

test('public drawing containers and caller freezing cannot poison private cached records', () => {
  const project = ownProject(fixture());
  const expected = structuredClone(toProjectDocument(project, true));
  const native = projectNativeFiles(project);
  const publicDocument = toProjectDocument(project);
  const wire = schematicDocumentItems(publicDocument.schematic, 'wires')[0];
  wire.start.x += 100;
  wire.kicad![0].push('changed');
  schematicDocumentItems(publicDocument.schematic, 'labels')[0].text = 'POISON';
  publicDocument.schematic.noConnects![0].position.x += 100;
  publicDocument.schematic.nets!.reverse();
  assert.deepEqual(toProjectDocument(project, true), expected);
  assert.deepEqual(projectNativeFiles(project), native);
  assert.throws(
    () =>
      serializeProject(
        ownProject({
          ...project,
          schematic: {
            ...project.schematic,
            junctions: project.schematic.junctions.map((junction) => ({
              ...junction,
              id: project.schematic.wires[0].id,
            })),
          },
        }),
      ),
    /duplicate UUID/i,
  );
  assert.deepEqual(toProjectDocument(project, true), expected);
  assert.deepEqual(projectNativeFiles(project), native);

  const caller = fixture();
  Object.freeze(caller);
  const previous = toProjectDocument(caller, true);
  caller.schematic.wires[0].a.x -= 10;
  child(child(caller.schematic.wires[0].raw!, 'stroke')!, 'type')![1] = 'dot';
  caller.schematic.labels[0].text = 'CURRENT';
  assert.notDeepEqual(toProjectDocument(caller, true), previous);
  assert.deepEqual(toProjectDocument(caller, true), toProjectDocument(caller));
});
