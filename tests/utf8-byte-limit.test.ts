import test from 'node:test';
import assert from 'node:assert/strict';
import { exceedsUtf8ByteLimit } from '../lib/utf8-byte-limit';

const encoder = new TextEncoder();
function assertEquivalent(source: string) {
  const bytes = encoder.encode(source).length;
  for (const limit of new Set([0, source.length, Math.max(0, bytes - 1), bytes, bytes + 1]))
    assert.equal(
      exceedsUtf8ByteLimit(source, limit),
      bytes > limit,
      `${JSON.stringify(source.slice(0, 32))}: UTF-16 ${source.length}, UTF-8 ${bytes}, limit ${limit}`,
    );
}

test('UTF-8 limit matches TextEncoder for ASCII, Unicode and malformed UTF-16', () => {
  for (const source of [
    '',
    'ASCII\0\r\n',
    'µΩ Ελληνικά',
    '中文\u0800\uffff',
    '😀𝄞𐐷',
    '\ud800',
    '\udc00',
    '\ud800x\udc00',
    '\ud800\ud800\udc00',
    '\udc00\ud800\udc00',
    '{"broken":"\ud800',
    '{"lone":"\udc00"}',
  ])
    assertEquivalent(source);

  let seed = 0x5eed;
  const pieces = ['a', '\0', 'µ', 'Ω', '中', '\ud800', '\udbff', '\udc00', '\udfff', '😀'];
  for (let index = 0; index < 160; index++) {
    let source = '';
    for (let part = 0; part < 1 + (index % 97); part++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) | 0;
      source += pieces[(seed >>> 0) % pieces.length];
    }
    assertEquivalent(source);
  }
});

test('UTF-8 limit preserves surrogate pairs and lone surrogates across scratch boundaries', () => {
  for (let prefix = 65_532; prefix <= 65_538; prefix++)
    for (const tail of ['😀z', '\ud800z', '\udc00z', '\ud800\ud800\udc00z'])
      assertEquivalent('x'.repeat(prefix) + tail);
  // Several chunks, alternating between early rejection and complete counting,
  // reuse the private scratch without retaining a previous call's byte count.
  for (const tail of ['😀', '\ud800', '\udc00', 'Ω中']) {
    const source = ('a'.repeat(65_535) + tail).repeat(3);
    assertEquivalent(source);
    assert.equal(exceedsUtf8ByteLimit('a', 1), false);
  }
});

test('UTF-8 limit keeps the inclusive 8 MB boundary for every encoding width', () => {
  const limit = 8_000_000;
  for (const source of [
    'a'.repeat(limit),
    'µ'.repeat(4_000_000),
    '中'.repeat(2_666_666) + 'aa',
    '😀'.repeat(2_000_000),
    '\ud800'.repeat(2_666_666) + 'aa',
    'a'.repeat(limit - 3) + '\udc00',
  ]) {
    assert.equal(encoder.encode(source).length, limit);
    for (const boundary of [limit - 1, limit, limit + 1])
      assert.equal(exceedsUtf8ByteLimit(source, boundary), limit > boundary);
    assert.equal(exceedsUtf8ByteLimit(source + 'a', limit), true);
  }
});

test('UTF-8 limits reject invalid budgets before taking a fast path', () => {
  for (const limit of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => exceedsUtf8ByteLimit('', limit), {
      name: 'RangeError',
      message: 'UTF-8 byte limit must be a nonnegative safe integer.',
    });
  assert.equal(exceedsUtf8ByteLimit('', 0), false);
  assert.equal(exceedsUtf8ByteLimit('a', -0), true);
  assert.equal(exceedsUtf8ByteLimit('😀\ud800中', Number.MAX_SAFE_INTEGER), false);
});
