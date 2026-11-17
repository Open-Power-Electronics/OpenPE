import test from 'node:test';
import assert from 'node:assert/strict';
import { ownProjectData } from '../lib/immutable-project';
import { formatProjectJson } from '../lib/project-json';

test('owned long-string packets preserve exact JSON through depth changes and cache eviction', () => {
  for (const size of [1023, 1024, 1025, 8192]) {
    const source = ('\"\\\r\n\t\u2028\u00e9\u03a9'.repeat(size) + 'tail').slice(0, size);
    for (const input of [{ source }, { name: 'Current.kicad_pcb', source }]) {
      const packet = ownProjectData(input);
      for (const depth of [0, 1, 4, 8, 2, 0, 4, 1]) {
        let nested: unknown = packet;
        for (let level = 0; level < depth; level++) nested = { child: nested };
        const expected = formatProjectJson(structuredClone(nested));
        assert.equal(formatProjectJson(nested), expected);
        assert.deepEqual(JSON.parse(expected), nested);
      }
    }
  }
});

test('long-string formatting follows mutable descendants of caller-frozen containers', () => {
  const caller = Object.freeze({ file: { name: 'Current.kicad_sch', source: 'x'.repeat(2048) } });
  const before = formatProjectJson(caller);
  caller.file.source += '\nCurrent edit "value"';
  const after = formatProjectJson(caller);
  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).file.source, caller.file.source);
  assert.equal(formatProjectJson(caller), formatProjectJson(structuredClone(caller)));
});
