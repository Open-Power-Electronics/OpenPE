import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { createEmptyPCB } from '../lib/pcb-layout';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';
import {
  agentProject,
  agentProjectSource,
  assertAgentSourceDraftSafe,
} from '../lib/agent-project-access';

const secret = '* MODEL_PRIVATE_BODY_4873\n.subckt device 1 2\nR1 1 2 1\n.ends\n';
function fixture(withModel = true) {
  const project = createProject();
  project.schematic.title = 'Original';
  project.pcb = createEmptyPCB();
  const native = projectNativeFiles(project, 'Example.kicad_pro');
  if (withModel) native.files.splice(1, 0, { name: 'circuits/device.lib', source: secret });
  native.files.push({ name: 'Example.kicad_dru', source: '(version 1)\n' });
  const core = new ProjectCore(projectFromNativeFiles(native));
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  registerProjectCapabilities(host, core);
  const query = (id: string, input?: unknown) => host.query(id, input, { actor: 'agent' });
  const execute = (id: string, input?: unknown) =>
    host.execute(id, input, {
      actor: 'agent',
      expectedRevision: String(core.getSnapshot().revision),
    });
  const protectedBytes = () =>
    core.getNativeFiles().files.find((file) => file.name === 'circuits/device.lib')!.source;
  return { core, host, query, execute, protectedBytes };
}

test('Agent canonical, native Source and command results omit model bodies while human Core data stays intact', async () => {
  const f = fixture();
  const project = f.core.getSnapshot().project!;
  for (const [id, input] of [
    ['project.get', undefined],
    ['project.snapshot', undefined],
    ['project.source', undefined],
    ['source.get', undefined],
    ['source.files', undefined],
    ['core.state', undefined],
    ['schematic.get', { schematicId: project.schematic.id }],
    ['layout.get', { boardId: project.pcb!.id }],
  ] as const) {
    assert.ok(!JSON.stringify(await f.query(id, input)).includes('MODEL_PRIVATE_BODY'), id);
  }
  const visible = await f.query('project.get');
  assert.equal((visible as Record<string, unknown>).nativeFiles, undefined);
  assert.doesNotThrow(() => parseProject(JSON.stringify(visible)));
  assert.doesNotThrow(() =>
    parseProject(agentProjectSource(f.core.query('project.source') as string)),
  );
  const files = (await f.query('source.files')) as KiCadProjectFiles;
  assert.ok(files.files.some((file) => file.name.endsWith('.kicad_sch')));
  assert.ok(!files.files.some((file) => file.name.endsWith('.lib')));
  assert.ok(
    JSON.stringify(await f.host.query('project.snapshot', {}, { actor: 'human' })).includes(
      'MODEL_PRIVATE_BODY',
    ),
  );
  assert.ok(
    !JSON.stringify(await f.execute('project.rename', { name: 'Renamed' })).includes(
      'MODEL_PRIVATE_BODY',
    ),
  );
  assert.equal(f.protectedBytes(), secret);
});

test('Agent canonical replacement preserves exact accepted native model bytes and ordinary Source remains editable', async () => {
  const f = fixture();
  const before = f.core.getSnapshot();
  const visible = (await f.query('project.get')) as Record<string, unknown>;
  (visible.project as Record<string, unknown>).name = 'Agent project';
  await f.execute('project.replace', { source: JSON.stringify(visible) });
  assert.equal(f.core.getSnapshot().project!.name, 'Agent project');
  assert.equal(f.protectedBytes(), secret);
  assert.equal(f.core.getSnapshot().undoDepth, before.undoDepth + 1);
  await f.execute('history.undo');
  assert.equal(f.protectedBytes(), secret);
  const native = (await f.query('source.files')) as KiCadProjectFiles;
  const sheet = native.files.find((file) => file.name.endsWith('.kicad_sch'))!;
  sheet.source = sheet.source.replace('"Original"', '"Agent Source"');
  const staged = await f.execute('source.update', { draft: JSON.stringify(native) });
  assert.ok(!JSON.stringify(staged).includes('MODEL_PRIVATE_BODY'));
  assert.ok(f.core.getSnapshot().sourceDraft!.includes('MODEL_PRIVATE_BODY'));
  await f.execute('source.apply');
  assert.equal(f.core.getSnapshot().project!.schematic.title, 'Agent Source');
  assert.equal(f.protectedBytes(), secret);
  const next = ((await f.query('source.files')) as KiCadProjectFiles).files.find(
    (file) => file.name === sheet.name,
  )!;
  await f.execute('source.updateFile', {
    name: next.name,
    source: next.source.replace('"Agent Source"', '"Single file"'),
  });
  await f.execute('source.apply');
  assert.equal(f.core.getSnapshot().project!.schematic.title, 'Single file');
  assert.equal(f.protectedBytes(), secret);
});

test('projected canonical replacement also preserves ordinary native backing without model resources', async () => {
  const f = fixture(false);
  const before = f.core.getNativeFiles();
  const projected = (await f.query('project.get')) as Record<string, unknown>;
  (projected.project as Record<string, unknown>).name = 'Name edit';
  await f.execute('project.replace', { source: JSON.stringify(projected) });
  const after = f.core.getNativeFiles();
  assert.deepEqual(
    after.files.find((file) => file.name === 'Example.kicad_dru'),
    before.files.find((file) => file.name === 'Example.kicad_dru'),
  );
  assert.equal(f.core.getSnapshot().project!.name, 'Name edit');
});

test('Agent raw snapshot, Source and paste inputs cannot introduce or change protected bodies', async () => {
  const f = fixture();
  const current = f.core.query('project.get') as Record<string, unknown>;
  const native = f.core.getNativeFiles();
  const before = f.core.getSnapshot();
  for (const [id, input] of [
    ['project.replace', { source: JSON.stringify(current) }],
    ['source.update', { draft: JSON.stringify(current) }],
    ['source.update', { draft: JSON.stringify(native) }],
    ['source.updateFile', { name: 'circuits/device.lib', source: 'changed' }],
    [
      'schematic.paste',
      {
        schematicId: before.project!.schematic.id,
        source: JSON.stringify(current),
        ids: [],
        delta: { x: 0, y: 0 },
      },
    ],
  ] as const) {
    await assert.rejects(f.execute(id, input), /model contents/);
    assert.equal(f.core.getSnapshot().revision, before.revision, id);
    assert.equal(f.core.getSnapshot().sourceDraft, null, id);
    assert.equal(f.protectedBytes(), secret, id);
  }
  const introduced = agentProject(current);
  introduced.nativeFiles = {
    entry: native.entry,
    files: [{ name: 'new.lib', source: 'new body' }],
  };
  await assert.rejects(
    f.execute('project.replace', { source: JSON.stringify(introduced) }),
    /model contents/,
  );
  assert.equal(f.protectedBytes(), secret);
});

test('pending GUI model edits and malformed private drafts stay private and cannot be applied or discarded by Agents', async () => {
  const f = fixture();
  await f.host.execute(
    'source.updateFile',
    { name: 'circuits/device.lib', source: secret + '* GUI edit\n' },
    { actor: 'human' },
  );
  const before = f.core.getSnapshot();
  for (const id of ['project.snapshot', 'source.get', 'source.files', 'core.state'])
    assert.ok(!JSON.stringify(await f.query(id)).includes('MODEL_PRIVATE_BODY'), id);
  for (const id of ['source.apply', 'source.discard'])
    await assert.rejects(f.execute(id), /Review model or log/);
  assert.throws(() => assertAgentSourceDraftSafe(before), /Review model or log/);
  assert.equal(f.core.getSnapshot().sourceDraft, before.sourceDraft);
  assert.equal(f.core.getSnapshot().revision, before.revision);
  await f.host.execute('source.discard', {}, { actor: 'human' });
  f.core.updateSource('MODEL_PRIVATE_BODY malformed JSON');
  f.core.applySource();
  for (const id of ['project.snapshot', 'source.get', 'core.state']) {
    const result = (await f.query(id)) as Record<string, unknown>;
    assert.equal(result.sourceDraft, null, id);
    assert.equal(result.sourcePending, true, id);
    assert.ok(!JSON.stringify(result).includes('MODEL_PRIVATE_BODY'), id);
  }
  await assert.rejects(f.execute('source.apply'), /invalid Source draft/);
});

test('canonical Source updates retain protected backing without adding a private format or sentinel', async () => {
  const f = fixture();
  const projected = parseProject(
    agentProjectSource(serializeProject(f.core.getSnapshot().project!)),
  );
  projected.name = 'Canonical edit';
  await f.execute('source.update', { draft: serializeProject(projected) });
  await f.execute('source.apply');
  assert.equal(f.core.getSnapshot().project!.name, 'Canonical edit');
  assert.equal(f.protectedBytes(), secret);
  assert.doesNotThrow(() => parseProject(f.core.query('project.source') as string));
});
