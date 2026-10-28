import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';
import { pruneValidatorSchemaSource } from '../scripts/prune-validator-schema-source.mjs';
import { optimizeStaticMaxLength } from '../scripts/ajv-length-guard.mjs';

type Validator = ((data: unknown) => boolean) & { errors: unknown };
async function load(source: string) {
  const result = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'validator',
    minify: true,
  });
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(result.outputFiles[0].text).runInContext(context);
  // Native layer enums contain arrays; fast-deep-equal compares their realm's
  // constructors, so fixtures enter the same realm as the static schema.
  const parse = new vm.Script('JSON.parse').runInContext(context) as typeof JSON.parse;
  const compiled = context.validator.default as Validator;
  const validate = ((data: unknown) => compiled(parse(JSON.stringify(data)))) as Validator;
  Object.defineProperty(validate, 'errors', { get: () => compiled.errors });
  return {
    validate,
    bytes: result.outputFiles[0].contents.length,
  };
}

function compare(reference: Validator, pruned: Validator, value: unknown) {
  assert.equal(pruned(value), reference(value));
  assert.deepEqual(
    JSON.parse(JSON.stringify(pruned.errors)),
    JSON.parse(JSON.stringify(reference.errors)),
  );
}

test('static schema pruning preserves complete native snapshot validation and errors', async () => {
  const schema = JSON.parse(
    await readFile('schemas/internal-project-snapshot.schema.json', 'utf8'),
  );
  const ajv = optimizeStaticMaxLength(
    new Ajv({
      code: { source: true, esm: true },
      inlineRefs: false,
      strict: true,
      strictTuples: false,
      multipleOfPrecision: 4,
    }),
  );
  const source = standalone(ajv, ajv.compile(schema));
  const reference = await load(source);
  const pruned = await load(pruneValidatorSchemaSource(source));
  assert.ok(reference.bytes - pruned.bytes > 40_000, 'Unobserved schema branches are omitted.');
  const boost = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
  const fixtures = [
    JSON.parse(await readFile('lib/emc-flyback-example.json', 'utf8')),
    ...Object.values(boost).map((value) => JSON.parse(String(value))),
  ];
  for (const fixture of fixtures) {
    assert.equal(reference.validate(fixture), true);
    compare(reference.validate, pruned.validate, fixture);
    for (const path of [
      ['units'],
      ['project', 'id'],
      ['schematic', 'components', 0, 'position', 'x'],
      ['schematic', 'components', 0, 'footprints', 0, 'side'],
      ['schematic', 'components', 0, 'footprints', 0, 'pads', 0, 'shape'],
      ['pcb', 'graphics', 0, 'layer'],
    ]) {
      const changed = structuredClone(fixture);
      let parent = changed;
      for (const key of path.slice(0, -1)) parent = parent?.[key];
      if (!parent) continue;
      parent[path.at(-1)!] = 'unsupported';
      assert.equal(reference.validate(changed), false);
      compare(reference.validate, pruned.validate, changed);
    }
    for (const path of [[], ['schematic'], ['schematic', 'components', 0]]) {
      const changed = structuredClone(fixture);
      let parent = changed;
      for (const key of path) parent = parent[key];
      parent.unexpected = true;
      assert.equal(reference.validate(changed), false);
      compare(reference.validate, pruned.validate, changed);
    }
    const missing = structuredClone(fixture);
    delete missing.project.id;
    compare(reference.validate, pruned.validate, missing);
  }
});

test('property membership retains all keys while enum error values retain their complete arrays', async () => {
  const source = `
    const schema1 = {"properties":{"__proto__":{},"colour":{"enum":["red","green"],"description":"unused"},"other":{"type":"string"}},"description":"unused"};
    const own = Object.prototype.hasOwnProperty;
    export default function validate(data) {
      return {
        keys: Object.keys(data).map(key => own.call(schema1.properties, key)),
        error: {allowedValues: schema1.properties.colour.enum}
      };
    }
  `;
  const pruned = pruneValidatorSchemaSource(source);
  assert.doesNotMatch(pruned, /unused|"type"/);
  const original = await load(source);
  const optimized = await load(pruned);
  const value = JSON.parse('{"__proto__":true,"colour":"blue","other":0,"unknown":true}');
  assert.deepEqual(
    JSON.parse(JSON.stringify(optimized.validate(value))),
    JSON.parse(JSON.stringify(original.validate(value))),
  );
});

test('unfamiliar generated schema syntax and uses require review', () => {
  for (const source of [
    'const schema1 = {;',
    'let schema1 = {};',
    'const schema1 = {}; console.log(schema1);',
    'const schema1 = {}; console.log(schema1[dynamic]);',
    'const schema1 = {}; schema1.properties = {};',
    'const schema1 = {}; unknown.call(schema1.properties, key);',
    'const schema1 = {}; const error={allowedValues:schema1.properties.missing.enum};',
  ])
    assert.throws(() => pruneValidatorSchemaSource(source));
});
