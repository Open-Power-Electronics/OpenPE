import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptProjectFileSave, type ProjectFileDraft } from '../lib/project-file-drafts';

test('ordinary file saves retain edits typed during the write against the accepted bytes', () => {
  const saved: ProjectFileDraft = { source: 'cube([12, 20, 30]);', expectedSource: 'cube(10);' };
  assert.equal(acceptProjectFileSave({ ...saved }, saved), undefined);
  assert.deepEqual(acceptProjectFileSave({ ...saved, source: 'cube([15, 20, 30]);' }, saved), {
    source: 'cube([15, 20, 30]);',
    expectedSource: saved.source,
  });
  assert.deepEqual(
    acceptProjectFileSave({ ...saved, source: saved.expectedSource, encoding: 'latin1' }, saved),
    { source: saved.expectedSource, expectedSource: saved.source, encoding: 'latin1' },
    'Reverting while a write runs remains a pending edit after the write succeeds.',
  );
});

test('ordinary file save completion cannot restore discarded work or rebase another baseline', () => {
  const saved = { source: 'new', expectedSource: 'old' };
  assert.equal(acceptProjectFileSave(undefined, saved), undefined);
  const other = { source: 'draft after refresh', expectedSource: 'external replacement' };
  assert.equal(acceptProjectFileSave(other, saved), other);
});
