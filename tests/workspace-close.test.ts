import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCloseSnapshotUnsaved,
  WorkspaceCloseReview,
  type CloseDocument,
} from '../lib/workspace-close';

const document = (id: string): CloseDocument => ({
  id,
  native: { source: `project ${id}`, sourceDraft: null, dirty: true },
  ordinaryDraftRevision: null,
});

test("Don't save removes discarded projects from recovery before approving native quit", async () => {
  const documents = [document('A'), document('B')];
  documents[0].native.sourceDraft = '{invalid pending source';
  const review = new WorkspaceCloseReview();
  let approved = false;
  const writes: string[][] = [];
  const finish = () =>
    review.finish(
      () => documents,
      async (ids) => {
        writes.push([...ids]);
      },
      async () => {
        approved = true;
      },
    );
  review.accept('A', documents[0], 'discard');
  assert.equal(await finish(), false, 'Every unsaved project still needs a decision.');
  assert.deepEqual(writes, []);
  assert.equal(approved, false);
  assert.equal(review.pending(documents)?.id, 'B');
  review.accept('B', documents[1], 'discard');
  assert.equal(await finish(), true);
  assert.deepEqual(writes, [[]], 'An empty recovery list selects the DELETE operation.');
  assert.equal(approved, true);
  assert.equal(
    documents[0].native.sourceDraft,
    '{invalid pending source',
    'Review never edits live documents.',
  );
});

test('mixed save/discard decisions retain only saved and unchanged projects', async () => {
  const documents = [document('A'), document('B'), document('C')];
  documents[2].native.dirty = false;
  const review = new WorkspaceCloseReview();
  review.accept('A', documents[0], 'discard');
  review.accept('B', documents[1], 'save');
  let approved = false;
  await review.finish(
    () => documents,
    async (ids) => {
      assert.deepEqual([...ids], ['B', 'C']);
      assert.equal(approved, false, 'Recovery completes before native close approval.');
    },
    async () => {
      approved = true;
    },
  );
  assert.equal(approved, true);
  assert.equal(
    new WorkspaceCloseReview().pending(documents)?.id,
    'A',
    'Cancelling review does not carry discard decisions into a later quit attempt.',
  );
});

test('recovery failure is reported to the confirmation and can be retried', async () => {
  const documents = [document('A')];
  const review = new WorkspaceCloseReview();
  review.accept('A', documents[0], 'discard');
  let approved = false;
  const approve = async () => {
    approved = true;
  };
  await assert.rejects(
    review.finish(
      () => documents,
      async () => {
        throw new Error('Recovery write failed');
      },
      approve,
    ),
    /Recovery write failed/,
  );
  assert.equal(approved, false);
  assert.equal(
    await review.finish(
      () => documents,
      async () => {},
      approve,
    ),
    true,
  );
  assert.equal(approved, true);
});

test('background edits during recovery require another review before native quit', async () => {
  const documents = [document('A')];
  const review = new WorkspaceCloseReview();
  review.accept('A', documents[0], 'discard');
  let approved = false;
  assert.equal(
    await review.finish(
      () => documents,
      async () => {
        documents[0].native.source = 'Agent updated A';
      },
      async () => {
        approved = true;
      },
    ),
    false,
  );
  assert.equal(approved, false);
  assert.equal(review.pending(documents)?.id, 'A');
  assert.deepEqual(review.retained(documents), documents, 'Old discard cannot discard a new edit.');
  review.accept('A', documents[0], 'save');
  documents[0].native.sourceDraft = '{new pending draft';
  assert.equal(
    review.pending(documents)?.id,
    'A',
    'Source drafts also invalidate an old decision.',
  );
});

test('ordinary-file drafts require close review without marking the native project dirty', async () => {
  const item = document('A');
  item.native.dirty = false;
  assert.equal(isCloseSnapshotUnsaved(item), false);
  item.ordinaryDraftRevision = 1;

  const review = new WorkspaceCloseReview();
  assert.equal(review.pending([item]), item);
  review.accept(item.id, item, 'discard');
  assert.equal(
    await review.finish(
      () => [item],
      async () => {
        item.ordinaryDraftRevision = 2;
      },
      async () => assert.fail('A newer ordinary-file draft needs its own close decision.'),
    ),
    false,
  );
  assert.deepEqual(review.retained([item]), [item]);
  assert.equal(review.pending([item]), item);
  assert.equal(item.native.dirty, false);
});

test('a project that becomes clean during the recovery write is retained before quit', async () => {
  const item = document('A');
  item.native.dirty = false;
  item.ordinaryDraftRevision = 1;
  const review = new WorkspaceCloseReview();
  const persisted: string[][] = [];
  let approved = false;
  const finish = () =>
    review.finish(
      () => [item],
      async (ids) => {
        persisted.push([...ids]);
        item.ordinaryDraftRevision = null;
      },
      async () => {
        approved = true;
      },
    );
  review.accept(item.id, item, 'discard');
  assert.equal(await finish(), false);
  assert.equal(approved, false);
  assert.equal(review.pending([item]), undefined);
  assert.equal(await finish(), true);
  assert.deepEqual(persisted, [[], ['A']]);
  assert.equal(approved, true);
});
