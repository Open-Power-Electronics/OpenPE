import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAdmissions } from '../lib/project-admission';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createProject, serializeProject } from '../lib/project';
import { isOwnedProject } from '../lib/immutable-project';
import { ProjectCore } from '../core/project-core';

function fixture() {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', 0, 0));
  return createProject(circuit);
}

test('initial project admission detaches and validates input, binds exact Source and survives repeated mount reads', () => {
  const admissions = createProjectAdmissions();
  const input = fixture();
  Object.freeze(input);
  const source = admissions.stage('first', input);
  const project = admissions.get('first', source)!;
  assert.ok(isOwnedProject(project));
  assert.notEqual(project, input);
  assert.equal(admissions.get('first', source), project);
  assert.equal(admissions.get('other', source), undefined);
  assert.equal(admissions.get('first', `${source}\n`), undefined);
  input.schematic.parts[0].x = 99;
  assert.equal(project.schematic.parts[0].x, 0);
  assert.throws(() => (project.schematic.parts[0].x = 99), TypeError);
  for (let index = 0; index < 2; index++) {
    const core = new ProjectCore(admissions.get('first', source)!);
    assert.equal(core.getSnapshot().project, project);
    assert.equal(core.getSnapshot().source, source);
    assert.equal(core.getSnapshot().undoDepth, 0);
  }
  admissions.release('first');
  assert.equal(admissions.get('first', source), undefined);
  assert.equal(serializeProject(project), source);
});

test('admission rejects malformed frozen data without replacing accepted entries', () => {
  const admissions = createProjectAdmissions();
  const source = admissions.stage('first', fixture());
  const invalid = fixture();
  invalid.schematic.parts[0].id = invalid.schematic.id;
  Object.freeze(invalid);
  assert.throws(() => admissions.stage('first', invalid), /duplicate UUID/i);
  assert.ok(admissions.get('first', source));
  invalid.schematic.parts[0].x = NaN;
  assert.throws(() => admissions.stage('other', invalid), /finite/i);
  assert.equal(admissions.size, 1);
});

test('pending admissions are bounded and close/recovery cleanup removes only unretained handoffs', () => {
  assert.throws(() => createProjectAdmissions(13), /at most 12/);
  const admissions = createProjectAdmissions();
  const project = fixture();
  const sources = Array.from({ length: 12 }, (_, index) =>
    admissions.stage(String(index), project),
  );
  assert.equal(admissions.size, 12);
  assert.throws(() => admissions.stage('overflow', project), /Too many/);
  admissions.retain(new Set(['1', '9']));
  assert.equal(admissions.size, 2);
  assert.ok(admissions.get('1', sources[1]));
  assert.ok(admissions.get('9', sources[9]));
  assert.equal(admissions.get('0', sources[0]), undefined);
  admissions.release('1');
  admissions.stage('replacement', project);
  assert.equal(admissions.size, 2);
  admissions.retain(new Set());
  assert.equal(admissions.size, 0);
});
