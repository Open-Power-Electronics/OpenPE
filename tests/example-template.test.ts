import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExampleTemplate,
  validatedExampleTemplateSource,
} from '../server/example-template.mjs';
import { exampleProject } from '../lib/project-example';
import { serializeProject } from '../lib/project';

test('prepared example receipts bind fully validated canonical text and expose immutable templates', () => {
  const input = exampleProject();
  const source = serializeProject(input);
  const template = createExampleTemplate(source);
  const accepted = template.source;
  assert.equal(validatedExampleTemplateSource(template.receipt, accepted), accepted);
  assert.deepEqual(Object.keys(template.receipt), []);
  assert.ok(Object.isFrozen(template.receipt));
  assert.ok(Object.isFrozen(template));
  assert.ok(Object.isFrozen(template.project));
  assert.ok(Object.isFrozen(template.project.schematic.parts));
  assert.ok(Object.isFrozen(template.project.schematic.parts[0]));
  assert.throws(() => {
    template.project.schematic.parts[0].value = 'changed';
  }, TypeError);
  input.schematic.parts[0].value = '22k';
  assert.equal(validatedExampleTemplateSource(template.receipt, accepted), accepted);
  assert.equal(
    validatedExampleTemplateSource(template.receipt, serializeProject(input)),
    undefined,
  );
  assert.equal(validatedExampleTemplateSource(template.receipt, accepted + '\n'), undefined);
  for (const forged of [
    {},
    Object.freeze({}),
    { source: accepted },
    { ...template.receipt },
    structuredClone(template.receipt),
  ])
    assert.equal(validatedExampleTemplateSource(forged, accepted), undefined);
});

test('invalid example inputs cannot produce a receipt and remain retryable after repair', () => {
  for (const source of ['{', ' '.repeat(8_000_001)])
    assert.throws(() => createExampleTemplate(source));
  const invalid = JSON.parse(serializeProject(exampleProject()));
  invalid.project.id = invalid.schematic.id;
  assert.throws(() => createExampleTemplate(JSON.stringify(invalid)), /duplicate UUID/i);
  const repaired = createExampleTemplate(serializeProject(exampleProject()));
  assert.equal(validatedExampleTemplateSource({}, repaired.source), undefined);
  assert.equal(validatedExampleTemplateSource(repaired.receipt, '{'), undefined);
  assert.equal(validatedExampleTemplateSource(repaired.receipt, repaired.source), repaired.source);
});
