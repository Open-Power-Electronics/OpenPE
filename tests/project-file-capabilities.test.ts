import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import {
  createProjectFileAccess,
  registerProjectFileCapabilities,
  type ProjectFileRead,
} from '../lib/project-file-capabilities';
import { acceptProjectFileSave, type ProjectFileDraft } from '../lib/project-file-drafts';
import type { ProjectFilePreview } from '../lib/project-directory';

function fixture() {
  let scope = 'first',
    revision = '1',
    draftRevision = 0;
  let active = true,
    sourcePending = false,
    blocked = false;
  const disk = new Map<string, ProjectFilePreview>([
    [
      'notes.txt',
      { source: 'original', bytes: 8, binary: false, truncated: false, readOnly: false },
    ],
    ['other.md', { source: 'other', bytes: 5, binary: false, truncated: false, readOnly: false }],
    [
      'board.kicad_pcb',
      { source: 'native', bytes: 6, binary: false, truncated: false, readOnly: true },
    ],
    [
      'device.lib',
      { source: 'MODEL SECRET', bytes: 12, binary: false, truncated: false, readOnly: false },
    ],
    [
      'run.log',
      { source: 'LOG SECRET', bytes: 10, binary: false, truncated: false, readOnly: false },
    ],
    [
      'photo.png',
      {
        source: 'Binary file\nSize: 25 bytes\n',
        bytes: 25,
        binary: true,
        truncated: false,
        readOnly: false,
      },
    ],
    [
      'large.txt',
      { source: 'prefix', bytes: 2e6, binary: false, truncated: true, readOnly: false },
    ],
  ]);
  const drafts = new Map<string, ProjectFileDraft>();
  let reads = 0,
    writes = 0;
  let duringRead: (() => void) | undefined, beforeWrite: (() => void) | undefined;
  let duringWrite: (() => void) | undefined;
  const change = (name: string, source: string, preview = disk.get(name)!) => {
    const previous = drafts.get(name);
    const draft = previous
      ? { ...previous, source }
      : {
          source,
          expectedSource: preview.source,
          ...(preview.encoding ? { encoding: preview.encoding } : {}),
        };
    if (draft.source === draft.expectedSource) drafts.delete(name);
    else drafts.set(name, draft);
    draftRevision++;
  };
  const files = createProjectFileAccess({
    scope: () => scope,
    draftRevision: () => draftRevision,
    draft: (name) => drafts.get(name),
    list: async (guard) => {
      guard.check();
      return {
        entries: [...disk].map(([name, preview]) => ({
          name,
          kind: 'file' as const,
          id: `private-${name}`,
          bytes: preview.bytes,
        })),
        truncated: false,
      };
    },
    preview: async (id, guard) => {
      reads++;
      duringRead?.();
      guard.check();
      return { ...disk.get(id.slice('private-'.length))! };
    },
    change,
    save: async (name, guard) => {
      guard.check();
      const pending = drafts.get(name);
      if (!pending) return;
      await Promise.resolve();
      beforeWrite?.();
      guard.check();
      if (disk.get(name)!.source !== pending.expectedSource)
        throw new Error('The file changed on disk.');
      writes++;
      disk.set(name, { ...disk.get(name)!, source: pending.source });
      duringWrite?.();
      const accepted = acceptProjectFileSave(drafts.get(name), pending);
      if (accepted) drafts.set(name, accepted);
      else drafts.delete(name);
      draftRevision++;
      if (drafts.has(name)) throw new Error('A project file changed while saving.');
    },
    discard: (name) => {
      drafts.delete(name);
      draftRevision++;
    },
  });
  const host = createCapabilityHost({ revision: () => revision });
  const remove = registerProjectFileCapabilities(host, () => ({
    revision: () => revision,
    available: (write) =>
      !active
        ? 'Activate the originating project.'
        : blocked
          ? 'Project is closing.'
          : write && sourcePending
            ? 'Apply native Source first.'
            : true,
    files,
  }));
  const read = (name = 'notes.txt') =>
    host.query('project.files.read', { name }) as Promise<ProjectFileRead>;
  const update = (file: ProjectFileRead, source: string) =>
    host.execute(
      'project.files.update',
      {
        name: file.name,
        source,
        fileRevision: file.fileRevision,
      },
      { expectedRevision: revision },
    ) as Promise<ProjectFileRead>;
  const save = (file: ProjectFileRead) =>
    host.execute(
      'project.files.save',
      {
        name: file.name,
        fileRevision: file.fileRevision,
      },
      { expectedRevision: revision },
    );
  return {
    host,
    remove,
    disk,
    drafts,
    read,
    update,
    save,
    change,
    counts: () => ({ reads, writes }),
    deactivate: () => {
      active = false;
    },
    block: () => {
      blocked = true;
    },
    source: () => {
      sourcePending = true;
    },
    revise: () => {
      revision = '2';
    },
    relocate: () => {
      scope = 'second';
    },
    duringRead: (fn: () => void) => {
      duringRead = fn;
    },
    beforeWrite: (fn: () => void) => {
      beforeWrite = fn;
    },
    duringWrite: (fn: () => void) => {
      duringWrite = fn;
    },
  };
}

test('ordinary file capabilities share drafts, selective save/discard and metadata without grants', async () => {
  const f = fixture();
  const catalog = f.host.catalog().filter((entry) => entry.id.startsWith('project.files.'));
  assert.deepEqual(
    catalog.map((entry) => [entry.id, entry.mutation]),
    [
      ['project.files.list', false],
      ['project.files.read', false],
      ['project.files.update', 'session'],
      ['project.files.save', 'external'],
      ['project.files.discard', 'session'],
    ],
  );
  assert.ok(catalog.every((entry) => entry.owner === 'host' && !entry.level));
  const listing = JSON.stringify(await f.host.query('project.files.list'));
  assert.ok(!listing.includes('private-') && !listing.includes('SECRET'));
  assert.match(listing, /model contents and logs/);
  const initial = await f.read();
  const staged = await f.update(initial, 'edited');
  assert.equal(f.drafts.get('notes.txt')?.source, 'edited');
  assert.equal(f.disk.get('notes.txt')?.source, 'original');
  assert.equal(staged.pending, true);
  assert.equal((await f.read()).source, 'edited');
  f.change('other.md', 'other draft');
  const current = await f.read();
  await f.save(current);
  assert.equal(f.disk.get('notes.txt')?.source, 'edited');
  assert.equal(f.drafts.get('other.md')?.source, 'other draft');
  const other = await f.read('other.md');
  await f.host.execute('project.files.discard', {
    name: other.name,
    fileRevision: other.fileRevision,
  });
  assert.equal(f.drafts.size, 0);
  assert.equal(f.disk.get('other.md')?.source, 'other');
  f.remove();
  assert.equal(f.host.catalog().filter((entry) => entry.id.startsWith('project.files.')).length, 0);
});

test('stale GUI drafts, wrong files and replaced destinations cannot overwrite current work', async () => {
  const f = fixture();
  const old = await f.read();
  f.change('notes.txt', 'human edit');
  await assert.rejects(f.update(old, 'stale agent edit'), /draft changed/);
  assert.equal(f.drafts.get('notes.txt')?.source, 'human edit');
  const current = await f.read();
  await assert.rejects(
    f.host.execute('project.files.discard', {
      name: 'other.md',
      fileRevision: current.fileRevision,
    }),
    /draft changed/,
  );
  f.relocate();
  await assert.rejects(f.save(current), /draft changed/);
  assert.equal(f.counts().writes, 0);
});

test('a newer explicit read invalidates earlier file observations even without a Core edit', async () => {
  const f = fixture();
  const original = await f.read();
  f.disk.get('notes.txt')!.source = 'external replacement';
  const current = await f.read();
  await assert.rejects(f.update(original, 'stale text'), /draft changed/);
  const staged = await f.update(current, 'current edit');
  await f.save(staged);
  assert.equal(f.disk.get('notes.txt')?.source, 'current edit');
});

test('native/model/log paths and arbitrary names reject before reading or mutating', async () => {
  const f = fixture();
  for (const name of [
    'board.kicad_pcb',
    'fp-lib-table',
    'device.lib',
    'run.log',
    'run.log.1',
    'device.lib.bak',
    'stderr.txt',
    'vendor/model.MOD',
    'model.ckt',
    'circuit.sp',
    'model.inc',
    'run.stderr.txt',
    'mesh.geo',
    'notes/trace.RAW',
    'models/notes.txt',
    'vendor/3D/shape.txt',
    'circuits/custom.txt',
    'spice/result.csv',
    'thermal/result.csv',
    'assembly.scad',
    '../notes.txt',
    '/notes.txt',
    'C:/notes.txt',
    'folder\\notes.txt',
    'missing.txt',
  ]) {
    await assert.rejects(f.read(name));
    for (const command of ['update', 'save', 'discard'])
      await assert.rejects(
        f.host.execute(`project.files.${command}`, {
          name,
          fileRevision: 'forged',
          ...(command === 'update' ? { source: 'changed' } : {}),
        }),
      );
  }
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  assert.equal(f.drafts.size, 0);
});

test('read-only metadata/prefixes cannot become drafts and text size uses actual encoding', async () => {
  const f = fixture();
  for (const name of ['photo.png', 'large.txt']) {
    const value = await f.read(name);
    await assert.rejects(f.update(value, 'changed'), /fully loaded/);
    await assert.rejects(f.save(value), /fully loaded/);
  }
  const text = await f.read();
  for (const invalid of ['\0', '\ud800', 'é'.repeat(600_000)])
    await assert.rejects(f.update(text, invalid), /1 MiB/);
  f.disk.set('notes.txt', { ...f.disk.get('notes.txt')!, encoding: 'latin1' });
  const latin1 = await f.read();
  await f.update(latin1, 'é'.repeat(600_000));
  assert.equal(f.drafts.get('notes.txt')?.source.length, 600_000);
});

test('asynchronous reads and pre-write phases recheck origin, Core revision and close/Source gates', async () => {
  for (const action of ['deactivate', 'revise', 'block', 'relocate'] as const) {
    const f = fixture();
    f.duringRead(f[action]);
    await assert.rejects(f.read(), /project|Project/);
  }
  for (const action of ['deactivate', 'revise', 'block', 'source', 'relocate'] as const) {
    const f = fixture();
    const staged = await f.update(await f.read(), 'edited');
    f.beforeWrite(f[action]);
    await assert.rejects(f.save(staged));
    assert.equal(f.counts().writes, 0);
    assert.equal(f.drafts.get('notes.txt')?.source, 'edited');
  }
  const pending = fixture();
  pending.source();
  const readable = await pending.read();
  await assert.rejects(pending.update(readable, 'edited'), /Source/);
});

test('changed disk and edits during native completion retain retryable drafts', async () => {
  const f = fixture();
  const staged = await f.update(await f.read(), 'agent edit');
  f.disk.get('notes.txt')!.source = 'external edit';
  await assert.rejects(f.save(staged), /changed on disk/);
  assert.equal(f.drafts.get('notes.txt')?.source, 'agent edit');
  f.disk.get('notes.txt')!.source = 'original';
  f.duringWrite(() => f.change('notes.txt', 'newer human edit'));
  await assert.rejects(f.save(staged), /changed while saving/);
  assert.deepEqual(f.drafts.get('notes.txt'), {
    source: 'newer human edit',
    expectedSource: 'agent edit',
  });
  assert.equal(f.disk.get('notes.txt')?.source, 'agent edit');
});

test('cancelled reads, suspended hosts and stale expected revisions cannot write', async () => {
  const f = fixture();
  const control = new AbortController();
  f.duringRead(() => control.abort());
  await assert.rejects(
    f.host.query('project.files.read', { name: 'notes.txt' }, { signal: control.signal }),
  );
  const g = fixture();
  const file = await g.read();
  await assert.rejects(
    g.host.execute(
      'project.files.update',
      {
        name: file.name,
        source: 'edit',
        fileRevision: file.fileRevision,
      },
      { expectedRevision: 'old' },
    ),
  );
  g.host.suspend('Project is closing.');
  await assert.rejects(g.save(file), /closing/);
  assert.equal(g.drafts.size, 0);
});
