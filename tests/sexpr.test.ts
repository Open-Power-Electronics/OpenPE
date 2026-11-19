import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnedProjectNode, ownProjectData } from '../lib/immutable-project';
import { parseOwnedSExpr, parseSExpr, val, writeSExpr, type SExpr } from '../lib/sexpr';

test('KiCad quoted properties accept literal tabs without normalizing native syntax', () => {
  const source = '(property "Description" "\tConnector\\\"\\\\\twith tap")';
  for (const parse of [parseSExpr, parseOwnedSExpr]) {
    const record = parse(source);
    assert.equal(val(record, 2), '\tConnector"\\\twith tap');
    assert.equal(writeSExpr(record), source);
    assert.throws(() => parse('(property "Description" "invalid\u0000value")'), /Invalid string/);
  }
});

test('owned S-expression text preserves exact indentation through depth changes and cache eviction', () => {
  const source =
    '(root (property "Escapes \\" \\\\ Ω" (at 1.27 -2.54) (effects (font (size 1 1)) (hide yes))) (empty) (points (xy 0 1) (xy 2 3)))';
  const mutable = parseSExpr(source);
  const owned = ownProjectData(mutable);
  for (const depth of [0, 1, 4, 8, 2, 0, 16, 4, 1]) {
    assert.equal(writeSExpr(owned, depth), writeSExpr(structuredClone(mutable), depth));
    assert.deepEqual(parseSExpr(writeSExpr(owned, depth)), mutable);
  }
  const nested: SExpr = ['outer', ['branch', owned], ['other', owned]];
  assert.equal(writeSExpr(nested), writeSExpr(structuredClone(nested)));
});

test('caller freezing never certifies mutable S-expression descendants', () => {
  const caller = parseSExpr('(root (value "before") (at 1 2))');
  Object.freeze(caller);
  const before = writeSExpr(caller);
  (caller[1] as SExpr)[1] = '"after"';
  const after = writeSExpr(caller);
  assert.notEqual(after, before);
  assert.match(after, /"after"/);
  const first = parseSExpr(after);
  const second = parseSExpr(after);
  (first[1] as SExpr)[1] = '"independent"';
  assert.equal(writeSExpr(second), after);
});

test('private owned parsing creates independent frozen arrays with identical syntax and bytes', () => {
  const source =
    '(root (property "Escapes \\" \\\\ Ω 😀" (at 1.27 -2.54)) (empty) (points (xy 0 1) (xy 2 3)))';
  const mutable = parseSExpr(source);
  const owned = parseOwnedSExpr(source);
  assert.deepEqual(owned, ownProjectData(mutable));
  const check = (node: SExpr) => {
    assert.ok(Object.isFrozen(node));
    assert.ok(isOwnedProjectNode(node));
    for (const child of node) if (Array.isArray(child)) check(child);
  };
  check(owned);
  for (const depth of [0, 1, 4, 2, 0])
    assert.equal(writeSExpr(owned, depth), writeSExpr(mutable, depth));
  assert.throws(() => (owned[1] as SExpr).push('poison'), TypeError);
  const another = parseOwnedSExpr(source);
  assert.notEqual(another, owned);
  assert.notEqual(another[1], owned[1]);
  (mutable[1] as SExpr)[1] = '"Caller changed"';
  assert.notEqual(writeSExpr(mutable), writeSExpr(owned));
  assert.equal(writeSExpr(another), writeSExpr(owned));
});

test('private owned parsing retains malformed-text rejection and never adopts caller objects', () => {
  for (const source of ['', 'root', '(root', '(root))', '(root) (extra)', '(root "bad\\q")']) {
    assert.throws(() => parseSExpr(source));
    assert.throws(() => parseOwnedSExpr(source));
  }
  assert.throws(() => parseOwnedSExpr('(root)', 5), /8 MB/);
  let touched = false;
  const foreign = Object.freeze({
    length: 0,
    match() {
      touched = true;
      return ['(', 'caller', ')'];
    },
  });
  assert.throws(() => parseOwnedSExpr(foreign as unknown as string), /primitive/);
  assert.throws(() => parseOwnedSExpr(new String('(root)') as unknown as string), /primitive/);
  assert.equal(touched, false);
  assert.equal(isOwnedProjectNode(foreign), false);
  assert.deepEqual(parseOwnedSExpr('(root (valid))'), parseSExpr('(root (valid))'));
});

test('private owned parsing preserves detachment node and atom-depth bounds while public parsing stays mutable', () => {
  const oldPipeline = (source: string) => ownProjectData(parseSExpr(source));
  for (const [lists, atom, accepted] of [
    [80, 'x', true],
    [81, 'x', false],
    [81, '', true],
    [82, '', false],
  ] as const) {
    const source = '('.repeat(lists) + atom + ')'.repeat(lists);
    assert.ok(parseSExpr(source));
    if (accepted) assert.deepEqual(parseOwnedSExpr(source), oldPipeline(source));
    else {
      assert.throws(() => oldPipeline(source), /nesting or object count/);
      assert.throws(() => parseOwnedSExpr(source), /nesting or object count/);
    }
  }
  const maximum = '(' + 'x '.repeat(299999) + ')';
  assert.equal(parseOwnedSExpr(maximum).length, 299999);
  assert.equal(oldPipeline(maximum).length, 299999);
  const tooMany = '(' + 'x '.repeat(300000) + ')';
  assert.throws(() => oldPipeline(tooMany), /nesting or object count/);
  assert.throws(() => parseOwnedSExpr(tooMany), /nesting or object count/);
  const publicDepth = '('.repeat(100) + 'atom' + ')'.repeat(100);
  const mutable = parseSExpr(publicDepth);
  assert.equal(isOwnedProjectNode(mutable), false);
  mutable.push('still mutable');
  assert.throws(() => parseOwnedSExpr(publicDepth), /nesting or object count/);
});
