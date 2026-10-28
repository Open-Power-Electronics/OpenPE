import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceCloseReview, type CloseDocument } from '../lib/workspace-close';

const document = (id: string): CloseDocument => ({
  id,
  source: `project ${id}`,
  sourceDraft: null,
  unsaved: true,
});

test("Don't save removes discarded projects from recovery before approving native quit", async () => {
  const documents = [document('A'), document('B')];
  documents[0].sourceDraft = '{invalid pending source';
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
    documents[0].sourceDraft,
    '{invalid pending source',
    'Review never edits live documents.',
  );
});

test('mixed save/discard decisions retain only saved and unchanged projects', async () => {
  const documents = [document('A'), document('B'), { ...document('C'), unsaved: false }];
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
        documents[0].source = 'Agent updated A';
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
  documents[0].sourceDraft = '{new pending draft';
  assert.equal(
    review.pending(documents)?.id,
    'A',
    'Source drafts also invalidate an old decision.',
  );
});
