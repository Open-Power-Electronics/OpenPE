import assert from 'node:assert/strict';
import test from 'node:test';
import { createPart, emptyCircuit, pinPositions } from '../lib/circuit';
import { ownProjectData } from '../lib/immutable-project';
import { child, children, type SExpr } from '../lib/sexpr';

function fixture() {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 25.4, 25.4);
  return { part, library: circuit.libraries[part.libId] };
}
function firstPin(library: SExpr) {
  return children(library, 'symbol').flatMap((node) => children(node, 'pin'))[0];
}
function countCosines<T>(operation: () => T) {
  const cosine = Math.cos;
  let count = 0;
  Math.cos = (value) => {
    count++;
    return cosine(value);
  };
  try {
    return { result: operation(), count };
  } finally {
    Math.cos = cosine;
  }
}

test('owned pin geometry keeps its initial and repeated public arrays and every Point independent', () => {
  const initial = fixture();
  const part = ownProjectData(initial.part);
  const library = ownProjectData(initial.library);
  const first = countCosines(() => pinPositions(part, library));
  assert.equal(first.count, 1, 'One angle transform supplies every pin in this Part.');
  const expected = structuredClone(first.result);
  first.result[0].x += 100;
  first.result.splice(1);
  const second = countCosines(() => pinPositions(part, library));
  assert.equal(second.count, 0);
  assert.deepEqual(second.result, expected);
  const third = pinPositions(part, library);
  assert.notEqual(third, second.result);
  for (let index = 0; index < third.length; index++)
    assert.notEqual(third[index], second.result[index]);
  second.result[1].y -= 100;
  assert.deepEqual(pinPositions(part, library), expected);
  const posed = ownProjectData({ ...part, x: part.x + 1.27 });
  const changed = countCosines(() => pinPositions(posed, library));
  assert.equal(changed.count, 1);
  assert.equal(changed.result[0].x, 26.67);
});

test('pin geometry admits only double-owned pairs and rechecks mutable or caller-frozen inputs', () => {
  for (const ownedPart of [false, true])
    for (const ownedLibrary of [false, true]) {
      if (ownedPart && ownedLibrary) continue;
      const initial = fixture();
      const part = ownedPart ? ownProjectData(initial.part) : Object.freeze(initial.part);
      const library = ownedLibrary ? ownProjectData(initial.library) : initial.library;
      if (!ownedLibrary) Object.freeze(library);
      const repeated = countCosines(() => [
        pinPositions(part, library),
        pinPositions(part, library),
      ]);
      assert.equal(repeated.count, 2, `Ownership pair: ${ownedPart}/${ownedLibrary}`);
      assert.deepEqual(repeated.result[0], repeated.result[1]);
      if (!ownedLibrary) {
        const at = child(firstPin(library), 'at')!;
        at[1] = String(Number(at[1]) + 2.54);
        assert.notDeepEqual(pinPositions(part, library), repeated.result[0]);
      }
    }
  const initial = fixture();
  const library = ownProjectData(initial.library);
  const before = pinPositions(initial.part, library);
  initial.part.rotation = 90;
  assert.notDeepEqual(pinPositions(initial.part, library), before);
});

test('one owned Part retains only its current exact library geometry and never certifies invalid results', () => {
  const initial = fixture();
  const part = ownProjectData(initial.part);
  const firstLibrary = ownProjectData(initial.library);
  const alternate = structuredClone(initial.library);
  const at = child(firstPin(alternate), 'at')!;
  at[1] = String(Number(at[1]) + 2.54);
  const secondLibrary = ownProjectData(alternate);
  const before = pinPositions(part, firstLibrary);
  const changed = countCosines(() => pinPositions(part, secondLibrary));
  assert.equal(changed.count, 1);
  assert.notDeepEqual(changed.result, before);
  assert.equal(countCosines(() => pinPositions(part, secondLibrary)).count, 0);
  const returned = countCosines(() => pinPositions(part, firstLibrary));
  assert.equal(returned.count, 1, 'A library replacement evicts the preceding single entry.');
  assert.deepEqual(returned.result, before);

  for (const invalid of ['NaN', 'Infinity', '-Infinity']) {
    const malformed = structuredClone(initial.library);
    child(firstPin(malformed), 'at')![1] = invalid;
    const library = ownProjectData(malformed);
    const repeated = countCosines(() => [pinPositions(part, library), pinPositions(part, library)]);
    assert.equal(repeated.count, 2, invalid);
    assert.ok(
      repeated.result[0].some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)),
    );
  }
  const malformed = structuredClone(initial.library);
  child(firstPin(malformed), 'at')![1] = '"unterminated';
  const library = ownProjectData(malformed);
  const failed = countCosines(() => {
    for (let attempt = 0; attempt < 2; attempt++)
      assert.throws(() => pinPositions(part, library), SyntaxError);
  });
  assert.equal(failed.count, 2, 'Failed geometry remains retryable.');
  assert.throws(() => pinPositions(part, undefined as unknown as SExpr), /filter/);
  const empty = ownProjectData(['symbol', '"No pins"'] as SExpr);
  assert.deepEqual(pinPositions(part, empty), []);
  assert.equal(countCosines(() => pinPositions(part, empty)).count, 0);
});
