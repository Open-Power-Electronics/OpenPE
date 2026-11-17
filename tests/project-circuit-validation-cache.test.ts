import test from 'node:test';
import assert from 'node:assert/strict';
import { ownProject } from '../lib/immutable-project';
import { exampleProject } from '../lib/project-example';
import { serializeProject, validateProject, type Project } from '../lib/project';
import { child, children, quote, val } from '../lib/sexpr';

function failure(project: Project): string {
  let message = '';
  assert.throws(
    () => validateProject(project),
    (error) => {
      assert.ok(error instanceof Error);
      message = error.message;
      return true;
    },
  );
  return message;
}

function sameFailure(project: Project, expected: RegExp): void {
  const reference = failure(structuredClone(project));
  assert.match(reference, expected);
  assert.equal(failure(project), reference);
}

function multiUnitProject(): Project {
  const project = exampleProject();
  const [first, second] = project.schematic.parts;
  const library = project.schematic.libraries[first.libId];
  const unit = children(library, 'symbol').find((node) => /_1_1$/.test(val(node)))!;
  assert.ok(unit);
  const extra = structuredClone(unit);
  extra[1] = quote(val(unit).replace(/_1_1$/, '_2_1'));
  library.push(extra);
  second.libId = first.libId;
  second.value = first.value;
  second.fields = structuredClone(first.fields);
  second.unit = 2;
  return project;
}

test('a sheet accepted without a PCB remains valid when later used for copper commits and global UUID checks', () => {
  const project = ownProject(exampleProject());
  const schematicOnly = ownProject({ ...project, pcb: null }, project);
  validateProject(schematicOnly);
  const linked = ownProject({ ...schematicOnly, pcb: project.pcb }, schematicOnly);
  assert.equal(linked.schematic, schematicOnly.schematic);
  validateProject(linked);
  for (const width of [0.4, 0.6]) {
    const next = ownProject(
      {
        ...linked,
        pcb: {
          ...linked.pcb!,
          tracks: linked.pcb!.tracks.map((track, index) => (index ? track : { ...track, width })),
        },
      },
      linked,
    );
    assert.equal(next.schematic, linked.schematic);
    validateProject(next);
    assert.equal(serializeProject(next), serializeProject(structuredClone(next)));
    sameFailure(ownProject({ ...next, id: next.schematic.parts[0].id }, next), /duplicate UUID/);
  }
});

test('same-ID reference and symbol changes recheck a retained board and failed associations remain retryable', () => {
  const project = ownProject(multiUnitProject());
  validateProject(project);
  const [first, second, ground] = project.schematic.parts;
  const changed = (partId: string, update: Partial<typeof first>) =>
    ownProject(
      {
        ...project,
        schematic: {
          ...project.schematic,
          parts: project.schematic.parts.map((part) =>
            part.id === partId ? { ...part, ...update } : part,
          ),
        },
      },
      project,
    );
  const reference = changed(second.id, { ref: first.ref });
  assert.equal(reference.pcb, project.pcb);
  assert.notEqual(reference.schematic, project.schematic);
  for (let attempt = 0; attempt < 2; attempt++)
    sameFailure(reference, /multiple footprints refer to/);
  const symbol = changed(first.id, { libId: ground.libId });
  assert.equal(symbol.pcb, project.pcb);
  for (let attempt = 0; attempt < 2; attempt++) sameFailure(symbol, /has no pin/);
  const repaired = ownProject({ ...reference, schematic: project.schematic }, reference);
  validateProject(repaired);
  assert.equal(serializeProject(repaired), serializeProject(structuredClone(repaired)));
});

test('same-ID embedded library changes invalidate board pin associations independently of tuple equality', () => {
  const project = ownProject(exampleProject());
  validateProject(project);
  const draft = structuredClone(project);
  const part = draft.schematic.parts[0];
  const library = draft.schematic.libraries[part.libId];
  for (const unit of children(library, 'symbol'))
    for (const pin of children(unit, 'pin'))
      if (val(child(pin, 'number')) === '2') child(pin, 'number')![1] = quote('99');
  const changed = ownProject(draft, project);
  assert.equal(changed.pcb, project.pcb);
  assert.equal(changed.schematic.parts, project.schematic.parts);
  assert.notEqual(changed.schematic.libraries, project.schematic.libraries);
  for (let attempt = 0; attempt < 2; attempt++) sameFailure(changed, /has no pin 2/);
  validateProject(ownProject({ ...changed, schematic: project.schematic }, changed));
});

test('mutable and caller-frozen sheets cannot reuse old board association tuples', () => {
  for (const frozen of [false, true]) {
    const project = multiUnitProject();
    if (frozen) Object.freeze(project.schematic);
    validateProject(project);
    const [first, second] = project.schematic.parts;
    const originalReference = second.ref;
    second.ref = first.ref;
    for (let attempt = 0; attempt < 2; attempt++)
      sameFailure(project, /multiple footprints refer to/);
    second.ref = originalReference;
    validateProject(project);
    const libId = first.libId;
    first.libId = project.schematic.parts[2].libId;
    sameFailure(project, /has no pin/);
    first.libId = libId;
    validateProject(project);
  }
});
