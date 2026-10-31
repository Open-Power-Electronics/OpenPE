import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentFileChanges from '../components/AgentFileChanges';
import { changedAgentFiles, mergeAgentFileChanges } from '../lib/agent-file-changes';
import type { KiCadProjectFiles } from '../lib/kicad-project';

const files = (items: KiCadProjectFiles['files']): KiCadProjectFiles => ({
  entry: 'circuit.kicad_pro',
  files: items,
});

test('Agent file summaries compare actual native names, text and encoding without guessing from revisions', () => {
  const before = files([
    { name: 'circuit.kicad_pro', source: '{}' },
    { name: 'circuit.kicad_sch', source: 'old' },
    { name: 'old.kicad_pcb', source: 'board' },
  ]);
  const after = files([
    { name: 'circuit.kicad_sch', source: 'new' },
    { name: 'circuit.kicad_pro', source: '{}' },
    { name: 'new.kicad_pcb', source: 'board' },
  ]);
  assert.deepEqual(changedAgentFiles(before, after), [
    { name: 'circuit.kicad_sch', status: 'modified' },
    { name: 'new.kicad_pcb', status: 'added' },
    { name: 'old.kicad_pcb', status: 'removed' },
  ]);
  assert.deepEqual(changedAgentFiles(before, structuredClone(before)), []);
  assert.deepEqual(
    changedAgentFiles(
      files([{ name: 'vendor.lib', source: 'é' }]),
      files([{ name: 'vendor.lib', source: 'é', encoding: 'latin1' }]),
    ),
    [{ name: 'vendor.lib', status: 'modified' }],
  );
});

test('one reply deduplicates changes while preserving added/removed meaning and bounding retained metadata', () => {
  const first = mergeAgentFileChanges({ files: [], truncated: false }, [
    { name: 'new.kicad_sch', status: 'added' },
    { name: 'main.kicad_sch', status: 'modified' },
  ]);
  const next = mergeAgentFileChanges(first, [
    { name: 'new.kicad_sch', status: 'modified' },
    { name: 'main.kicad_sch', status: 'modified' },
  ]);
  assert.equal(next.files.length, 2);
  assert.equal(next.files.find((file) => file.name === 'new.kicad_sch')?.status, 'added');
  assert.equal(
    mergeAgentFileChanges(next, [{ name: 'new.kicad_sch', status: 'removed' }]).files.length,
    1,
  );
  assert.equal(first.files.length, 2);
  const bounded = mergeAgentFileChanges(
    first,
    Array.from({ length: 300 }, (_, i) => ({ name: `sheet-${i}.kicad_sch`, status: 'modified' })),
  );
  assert.equal(bounded.files.length, 256);
  assert.equal(bounded.truncated, true);
});

test('file footer stays compact and distinguishes no edits from an unavailable observation', () => {
  const render = (changes: Parameters<typeof AgentFileChanges>[0]['changes']) =>
    renderToStaticMarkup(createElement(AgentFileChanges, { changes }));
  assert.equal(render({ files: [], truncated: false }), '');
  const missing = render({ files: [], truncated: false, unavailable: true });
  assert.match(missing, /File changes unavailable/);
  assert.doesNotMatch(missing, /No file changes/);
  const changed = render({
    files: [{ name: '<script>.kicad_sch', status: 'modified' }],
    truncated: false,
  });
  assert.match(changed, /Modified/);
  assert.doesNotMatch(changed, /<script>/);
});
