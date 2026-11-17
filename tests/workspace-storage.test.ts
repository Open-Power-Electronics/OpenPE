import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceRecovery, workspaceFilename } from '../server/workspace-storage.mjs';
import { appendSchematic, createProject, serializeProject } from '../lib/project';
import { createPart } from '../lib/circuit';
import { createSession } from '../lib/chat-sessions';
import { defaultAgentPreferences, restoreWorkspace } from '../lib/workspace-state';

function componentSource(additional: boolean) {
  const project = additional ? appendSchematic(createProject()).project : createProject();
  const schematic = additional ? project.additionalSchematics![0] : project.schematic;
  schematic.parts.push(createPart(schematic, 'C', 0, 0));
  return JSON.parse(serializeProject(project));
}

test('retired recovery is deleted without import, backup or a Home error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-recovery-reset-'));
  try {
    const source = JSON.parse(serializeProject(createProject()));
    source.format = 'unsupported-format';
    const oldFile = path.join(dir, 'workspace.json');
    for (const old of [JSON.stringify({ source: JSON.stringify(source) }), '{broken old cache']) {
      await writeFile(oldFile, old);
      assert.equal(await readWorkspaceRecovery(dir), null);
      assert.deepEqual(await readdir(dir), []);
    }
    assert.equal(await readWorkspaceRecovery(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('current recovery, pending drafts and preferences survive retired-cache cleanup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-recovery-current-'));
  try {
    const current = {
      version: 2,
      documents: [
        {
          source: serializeProject(createProject()),
          sourceDraft: '{unfinished',
        },
      ],
    };
    const bytes = JSON.stringify(current);
    const file = path.join(dir, workspaceFilename);
    await writeFile(file, bytes);
    await writeFile(path.join(dir, 'appearance-v1.json'), '{existing preferences}');
    await writeFile(path.join(dir, 'workspace.json'), '{retired}');
    assert.deepEqual(await readWorkspaceRecovery(dir), current);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(
      await readFile(path.join(dir, 'appearance-v1.json'), 'utf8'),
      '{existing preferences}',
    );
    assert.deepEqual((await readdir(dir)).sort(), ['appearance-v1.json', workspaceFilename].sort());
    assert.deepEqual(await readWorkspaceRecovery(dir), current);
    // A deliberate close stays closed across another startup.
    await writeFile(file, 'null');
    assert.equal(await readWorkspaceRecovery(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retired recovery layouts are preserved for validation without conversion or deletion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-retired-project-recovery-'));
  try {
    const source = JSON.parse(serializeProject(createProject()));
    source.schematic.wires = [];
    const file = path.join(dir, workspaceFilename);
    for (const retired of [
      { source: serializeProject(createProject()) },
      {
        version: 2,
        documents: [{ source: JSON.stringify(source), sourceDraft: '{pending' }],
      },
    ]) {
      const bytes = JSON.stringify(retired);
      await writeFile(file, bytes);
      const restored = await readWorkspaceRecovery(dir);
      assert.deepEqual(restored, retired);
      assert.throws(() => restoreWorkspace(restored));
      assert.equal(await readFile(file, 'utf8'), bytes);
      assert.deepEqual(await readdir(dir), [workspaceFilename]);
    }
    delete source.schematic.wires;
    source.schematic.unexpected = true;
    const invalidCurrent = JSON.stringify({
      version: 2,
      documents: [{ source: JSON.stringify(source) }],
    });
    await writeFile(file, invalidCurrent);
    await readWorkspaceRecovery(dir);
    assert.equal(
      await readFile(file, 'utf8'),
      invalidCurrent,
      'Invalid current data is not mistaken for a retired format.',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown snapshot formats preserve recovery bytes and report validation failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-unknown-format-recovery-'));
  try {
    const file = path.join(dir, workspaceFilename);
    const source = JSON.parse(serializeProject(createProject()));
    source.format = 'unsupported-format';
    // Even an unknown format with retired geometry cannot authorize deletion.
    source.schematic.wires = [];
    const session = createSession();
    const document = {
      id: crypto.randomUUID(),
      source: JSON.stringify(source),
      sourceDraft: '{pending',
      dirty: true,
      filename: 'design.kicad_pro',
      sessions: [session],
      activeSessionId: session.id,
    };
    const recovery = {
      version: 2,
      documents: [document],
      activeDocumentId: document.id,
      ...defaultAgentPreferences,
    };
    const bytes = JSON.stringify(recovery);
    await writeFile(file, bytes);
    const restored = await readWorkspaceRecovery(dir);
    assert.deepEqual(restored, recovery);
    assert.throws(() => restoreWorkspace(restored), /unsupported internal snapshot format/i);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.deepEqual(await readdir(dir), [workspaceFilename]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt current recovery still reports failure and retains its exact bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-recovery-invalid-'));
  try {
    const file = path.join(dir, workspaceFilename);
    await writeFile(file, '{broken current cache');
    await assert.rejects(readWorkspaceRecovery(dir), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), '{broken current cache');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retired simulation field caches remain unsupported without conversion or deletion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-retired-simulation-recovery-'));
  try {
    const file = path.join(dir, workspaceFilename);
    for (const additional of [false, true])
      for (const name of ['OpenPE.SeriesResistance', 'OpenPE.InitialVoltage', 'OpenPE.Coupling']) {
        const source = componentSource(additional);
        const sheet = additional ? source.additionalSchematics[0].schematic : source.schematic;
        sheet.components[0].fields = { ...sheet.components[0].fields, [name]: '50m' };
        const bytes = JSON.stringify({
          version: 2,
          documents: [{ source: JSON.stringify(source), sourceDraft: '{pending' }],
        });
        await writeFile(file, bytes);
        const restored = await readWorkspaceRecovery(dir);
        assert.throws(() => restoreWorkspace(restored));
        assert.equal(await readFile(file, 'utf8'), bytes);
        assert.deepEqual(
          await readdir(dir),
          [workspaceFilename],
          'Unsupported recovery creates no replacement or backup.',
        );
      }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('current simulation recovery and malformed duplicate sources retain their exact bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-current-simulation-recovery-'));
  try {
    const file = path.join(dir, workspaceFilename);
    const settings = [
      ['seriesResistance', 'OpenPE.SeriesResistance'],
      ['initialVoltage', 'OpenPE.InitialVoltage'],
      ['coupling', 'OpenPE.Coupling'],
    ] as const;
    for (const additional of [false, true])
      for (const [canonical, native] of settings)
        for (const kind of ['typed', 'duplicate', 'mixed', 'invalid', 'custom', 'future']) {
          const source = componentSource(additional);
          const sheet = additional ? source.additionalSchematics[0].schematic : source.schematic;
          const component = sheet.components[0];
          if (kind === 'typed' || kind === 'duplicate')
            component.simulation = { [canonical]: '50m' };
          if (kind === 'mixed') {
            const other = settings.find(([key]) => key !== canonical)![0];
            (source.schematic.components ??= []).push({ simulation: { [other]: '1' } });
          }
          if (['duplicate', 'mixed', 'invalid', 'future'].includes(kind))
            component.fields = {
              ...component.fields,
              [native]: kind === 'invalid' ? 50 : '50m',
            };
          if (kind === 'custom') component.fields = { 'OpenPE.Note': 'Keep this design note.' };
          if (kind === 'future') source.version = 2;
          const recovery = {
            version: 2,
            documents: [{ source: JSON.stringify(source), sourceDraft: '{pending' }],
          };
          const bytes = JSON.stringify(recovery);
          await writeFile(file, bytes);
          assert.deepEqual(await readWorkspaceRecovery(dir), recovery);
          assert.equal(await readFile(file, 'utf8'), bytes);
          assert.deepEqual(await readdir(dir), [workspaceFilename]);
        }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
