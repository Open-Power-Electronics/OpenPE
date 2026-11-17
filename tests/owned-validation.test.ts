import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { ownProject, ownProjectData } from '../lib/immutable-project';
import validateEditor from '../lib/project-validator.mjs';
import validateDocument from '../lib/project-document-validator.mjs';
import { wasValidatedOwned } from '../lib/owned-validation.mjs';
import { ownedValidatorSource } from '../scripts/owned-validator-source.mjs';
import { createHomeExample } from '../lib/create-home-example';
import { homeExampleCatalog } from '../lib/home-examples';
import { toProjectDocument } from '../lib/project-document';
import { parseProject, serializeProject, validateProject } from '../lib/project';
import { validateProject as validateServiceProject } from '../server/project-format.mjs';

test('generated validator reuse requires internal ownership, keeps errors fresh and never accepts invalid roots', () => {
  const project = ownProject(createHomeExample(homeExampleCatalog[1].id, (id) => id));
  assert.equal(validateEditor(project), true);
  assert.equal(wasValidatedOwned(validateEditor, project), true);
  const document = ownProjectData(toProjectDocument(project));
  assert.equal(validateDocument(document), true);
  assert.equal(wasValidatedOwned(validateDocument, document), true);
  const foreign = Object.freeze(structuredClone(project));
  assert.equal(validateEditor(foreign), true);
  assert.equal(wasValidatedOwned(validateEditor, foreign), false);
  foreign.pcb!.tracks[0].width = -1;
  assert.equal(validateEditor(foreign), false);
  assert.ok(validateEditor.errors?.length);
  assert.equal(validateEditor(project), true);
  assert.equal(validateEditor.errors, null);
  const invalid = ownProject({ ...project, id: 'bad UUID' }, project);
  for (let index = 0; index < 3; index++) {
    assert.equal(validateEditor(invalid), false);
    assert.equal(wasValidatedOwned(validateEditor, invalid), false);
    assert.notEqual(validateEditor.errors, null);
    assert.throws(() => validateProject(invalid), /Invalid OpenPE project/);
  }
  const brokenDocument = ownProjectData({ ...document, units: 'inch' });
  assert.equal(validateDocument(brokenDocument), false);
  assert.equal(validateDocument(document), true);
  assert.equal(validateDocument.errors, null);
});

test('cached and uncached validation agree for every Home project and changed input', () => {
  for (const entry of homeExampleCatalog) {
    const original = createHomeExample(entry.id, (id) => id);
    const owned = ownProject(original);
    validateProject(owned);
    for (const variant of [
      owned,
      ownProject({ ...owned, name: 'Changed project name' }, owned),
      ownProject(
        {
          ...owned,
          schematic: {
            ...owned.schematic,
            parts: owned.schematic.parts.map((part, index) =>
              index ? part : { ...part, x: part.x + 1.27 },
            ),
          },
        },
        owned,
      ),
    ]) {
      const mutable = structuredClone(variant);
      assert.equal(validateEditor(variant), validateEditor(mutable), entry.id);
      assert.equal(serializeProject(variant), serializeProject(mutable), entry.id);
      validateServiceProject(mutable);
      const text = serializeProject(variant);
      assert.equal(serializeProject(parseProject(text)), text, entry.id);
    }
    for (const mutate of [
      (value: typeof original) => {
        value.id = 'invalid';
      },
      (value: typeof original) => {
        value.pcb!.tracks[0].width = -1;
      },
      (value: typeof original) => {
        value.schematic.parts[0].x = Number.NaN;
      },
      (value: typeof original) => {
        value.schematic.libraries[value.schematic.parts[0].libId][0] = 'not a symbol';
      },
    ]) {
      const mutable = structuredClone(original);
      mutate(mutable);
      let accepted = true;
      let acceptedOwned = true;
      try {
        validateProject(mutable);
      } catch {
        accepted = false;
      }
      try {
        validateProject(ownProject(mutable));
      } catch {
        acceptedOwned = false;
      }
      assert.equal(acceptedOwned, accepted, entry.id);
      assert.equal(accepted, false, entry.id);
    }
  }
});

test('browser bundles share the ownership registry without runtime code generation', async () => {
  const fixture = createHomeExample(homeExampleCatalog[1].id, (id) => id);
  const result = await build({
    stdin: {
      contents: `
    import { ownProject } from './lib/immutable-project';
    import validate from './lib/project-validator.mjs';
    import { wasValidatedOwned } from './lib/owned-validation.mjs';
    const owned=ownProject(${JSON.stringify(fixture)});
    globalThis.probe={accepted:validate(owned),reused:wasValidatedOwned(validate,owned)};
    const invalid=ownProject({...owned,id:'bad'});
    globalThis.probe.invalid=validate(invalid);
    globalThis.probe.failedReused=wasValidatedOwned(validate,invalid);
  `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(result.outputFiles[0].text).runInContext(context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.probe)), {
    accepted: true,
    reused: true,
    invalid: false,
    failedReused: false,
  });
});

test('validator generation rejects context-sensitive or unfamiliar generated validation', () => {
  assert.throws(
    () =>
      ownedValidatorSource(
        'function validate1(data){let errors=0;return rootData.allowed===data&&errors===0;}',
      ),
    /Context-sensitive/,
  );
  assert.throws(
    () => ownedValidatorSource('function validate1(data){return true;}'),
    /success return/,
  );
  assert.throws(
    () =>
      ownedValidatorSource(
        'function validate1(data){let errors=0;return this.accept(data)&&errors===0;}',
      ),
    /Context-sensitive/,
  );
});
