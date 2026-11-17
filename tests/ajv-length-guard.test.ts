import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Ajv, { type Options } from 'ajv';
import { optimizeStaticMaxLength } from '../scripts/ajv-length-guard.mjs';

const require = createRequire(import.meta.url);
const { _, Name, CodeGen, ValueScope } = require('ajv/dist/compile/codegen/index.js');
const ucs2length = require('ajv/dist/runtime/ucs2length.js').default;
const atoms = [
  'a',
  'é',
  '中',
  '😀',
  '\ud800',
  '\udfff',
  '\ud800A',
  '\ud800\ud800\udfff',
  '\udfff\ud800',
  '\\"\n\t',
];

function pair(schema: object, options: Options = {}) {
  const configured = { strict: true, code: { source: true }, logger: false as const, ...options };
  return [
    new Ajv(configured).compile(structuredClone(schema)),
    optimizeStaticMaxLength(new Ajv(configured)).compile(structuredClone(schema)),
  ];
}
function compare(validators: ReturnType<typeof pair>, value: unknown) {
  const [reference, optimized] = validators;
  const valid = reference(value);
  const errors = structuredClone(reference.errors);
  assert.equal(optimized(value), valid);
  assert.deepEqual(optimized.errors, errors);
}

test('static maximum guards preserve Unicode, malformed UTF-16, types and complete error objects', () => {
  for (const maxLength of [0, 1, 2, 3, 8, 32, 4096]) {
    const values: unknown[] = [null, false, 2, {}, [], '', ...atoms];
    for (const atom of atoms)
      for (const count of [Math.max(0, maxLength - 1), maxLength, maxLength + 1])
        values.push(atom.repeat(count));
    const schemas = [
      { type: 'string', maxLength },
      { type: 'string', minLength: 3, maxLength, pattern: '^[a-z]*$' },
      {
        type: 'object',
        properties: { text: { type: 'string', maxLength, minLength: 1 } },
        required: ['text'],
        additionalProperties: false,
      },
      { type: 'array', items: { type: 'string', maxLength } },
      { type: 'object', propertyNames: { maxLength } },
    ];
    for (const options of [{}, { allErrors: true }])
      for (const [index, schema] of schemas.entries()) {
        const validators = pair(schema, options);
        for (const value of values)
          compare(
            validators,
            index === 2
              ? { text: value }
              : index === 3
                ? [value]
                : index === 4
                  ? { [String(value)]: 1 }
                  : value,
          );
      }
  }
  const validators = pair({ type: 'string', maxLength: 12, minLength: 2 }, { allErrors: true });
  let random = 173;
  for (let index = 0; index < 2500; index++) {
    let value = '';
    random = (random * 1664525 + 1013904223) >>> 0;
    const length = random % 30;
    for (let i = 0; i < length; i++) {
      random = (random * 1664525 + 1013904223) >>> 0;
      value += String.fromCharCode(random & 0xffff);
    }
    compare(validators, value);
  }
  const nativeBound = pair({ type: 'string', maxLength: 8000000 });
  for (const value of ['x'.repeat(8000000), 'x'.repeat(8000001), '😀'.repeat(500000)])
    compare(nativeBound, value);
});

test('dynamic limits, minimum checks and unicode=false keep original code and error priority', () => {
  const schemas: [object, Options][] = [
    [
      {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 0 },
          text: { type: 'string', maxLength: { $data: '1/limit' }, minLength: 1 },
        },
      },
      { $data: true },
    ],
    [{ type: 'string', minLength: 3, maxLength: 1, pattern: '^a+$' }, { unicode: false }],
    [{ type: 'string', minLength: 3, pattern: '^a+$' }, {}],
  ];
  for (const [schema, options] of schemas) {
    const validators = pair(schema, options);
    assert.equal(validators[1].source!.validateCode, validators[0].source!.validateCode);
    for (const value of atoms)
      if (options.$data)
        for (const limit of [0, 1, 2, 8]) compare(validators, { limit, text: value });
      else compare(validators, value);
  }
  const validators = pair({ type: 'string', maxLength: 1, minLength: 3, pattern: '^a+$' });
  compare(validators, 'xx');
  assert.equal(validators[1].errors![0].keyword, 'maxLength');
  compare(validators, '😀');
  assert.equal(validators[1].errors![0].keyword, 'minLength');
});

test('getter-backed data and non-identifier expressions are sampled exactly as before', () => {
  const validators = pair({
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 1, minLength: 1, pattern: '^[a-z]*$' },
    },
    required: ['text'],
  });
  for (const sequence of [
    ['a', 'a', 'a'],
    ['😀', 'a', 'xx'],
    ['xx', '😀', 'a'],
    [undefined, 'a', '😀'],
  ]) {
    const observed = validators.map((validator) => {
      let reads = 0;
      const value = {
        get text() {
          return sequence[Math.min(reads++, sequence.length - 1)];
        },
      };
      const valid = validator(value);
      return { valid, reads, errors: structuredClone(validator.errors) };
    });
    assert.deepEqual(observed[1], observed[0]);
  }
  for (const guarded of [false, true]) {
    const ajv = guarded ? optimizeStaticMaxLength(new Ajv()) : new Ajv();
    const definition = ajv.getKeyword('maxLength');
    assert.ok(typeof definition === 'object' && definition !== null && 'code' in definition);
    const gen = new CodeGen(new ValueScope({ scope: {} }), { lines: true });
    gen.scopeValue = () => new Name('countCodepoints');
    definition.code({
      keyword: 'maxLength',
      data: _`nextValue()`,
      schemaCode: _`2`,
      schema: 2,
      gen,
      it: { opts: {} },
      $data: false,
      fail$data(condition: unknown) {
        gen.return(_`!(${condition})`);
      },
    } as never);
    gen.optimize(2);
    const run = new Function('nextValue', 'countCodepoints', gen.toString());
    let reads = 0;
    assert.equal(
      run(() => {
        reads++;
        return reads === 1 ? '😀😀' : 'too long';
      }, ucs2length),
      true,
    );
    assert.equal(reads, 1);
  }
});

test('configuration remains instance-local and unfamiliar keyword definitions fail generation', () => {
  const reference = new Ajv();
  const optimized = new Ajv();
  const original = reference.getKeyword('maxLength');
  assert.ok(typeof original === 'object' && original !== null && 'code' in original);
  const code = original.code;
  optimizeStaticMaxLength(optimized);
  assert.equal(reference.getKeyword('maxLength'), original);
  assert.equal(original.code, code);
  const foreign = new Ajv();
  foreign.removeKeyword('maxLength');
  assert.throws(() => optimizeStaticMaxLength(foreign), /require review/);
  assert.throws(() => optimizeStaticMaxLength(optimized), /require review/);
});
