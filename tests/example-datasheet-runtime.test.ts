import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import manifest from '../resources/example-catalog/manifest.json';
import {
  parseProject,
  serializeProject,
  projectNativeFiles,
  projectFromNativeFiles,
  appendSchematic,
  createProject,
} from '../lib/project';
import { ProjectCore } from '../core/project-core';
import { createCapabilityHost } from '../api/capabilities';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';
import { projectDatasheetContext } from '../lib/example-datasheets';
import { validateAgentWorkspaceContext } from '../context/agent-workspace-context';
import { validateAgentWorkspaceContext as validateServiceContext } from '../server/agent-context-format.mjs';
import { circuitFingerprint } from '../lib/circuit';
import { makePrompt } from '../server/agents.mjs';

async function example(index = 0) {
  const entry = manifest.examples[index];
  return parseProject(await readFile(`tests/fixtures/reference/${entry.file}.json`, 'utf8'));
}

test('EMC Flyback exposes the ST controller record and rejects changed variants and packages', async () => {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const before = serializeProject(project);
  const result = projectDatasheetContext(project);
  assert.equal(result.status, 'available');
  assert.equal(result.exampleId, 'emc-flyback-demo');
  assert.equal(result.record!.ic.family, 'UC3845B');
  assert.equal(result.record!.ic.manufacturer, 'STMicroelectronics');
  assert.equal(serializeProject(project), before);
  for (const property of ['value', 'footprint']) {
    const changed = structuredClone(project);
    const part = changed.schematic.parts.find((part) => part.ref === 'U1')!;
    if (property === 'value') part.value = 'UC3843B';
    else part.fields!.Footprint = 'Package_DIP:DIP-8_W7.62mm';
    assert.equal(projectDatasheetContext(changed).status, 'controller-mismatch');
    assert.equal(projectDatasheetContext(changed).record, null);
  }
});

test('all nine controllers expose the exact reviewed JSON and sources without mutating designs or native files', async () => {
  for (let index = 0; index < manifest.examples.length; index++) {
    const project = await example(index);
    const before = serializeProject(project);
    const native = projectNativeFiles(project);
    // Native files do not acquire private example provenance or reference JSON.
    assert.equal(projectDatasheetContext(projectFromNativeFiles(native)).status, 'available');
    const context = projectDatasheetContext(project);
    const expected = JSON.parse(
      await readFile('resources/example-catalog/ic-datasheets.json', 'utf8'),
    ).find(
      (record: { example: { id: string } }) => record.example.id === manifest.examples[index].id,
    );
    assert.equal(context.status, 'available');
    assert.equal(context.projectId, project.id);
    assert.deepEqual(context.record, expected);
    assert.deepEqual(context.bindings, [
      {
        schematicId: project.schematic.id,
        partId: project.schematic.parts.find((part) => part.ref === 'U1')!.id,
        reference: 'U1',
      },
    ]);
    assert.equal(serializeProject(project), before);
    assert.deepEqual(projectNativeFiles(project), native);
    context.record!.parameters.input_voltage.values.max = -100;
    assert.equal(
      projectDatasheetContext(project).record!.parameters.input_voltage.values.max,
      expected.parameters.input_voltage.values.max,
    );
  }
});

test('matching uses native IC variant/package without provenance; names and secondary-sheet lookalikes cannot select a record', async () => {
  const project = await example(2);
  const controller = project.schematic.parts.find((part) => part.ref === 'U1')!;
  assert.equal(projectDatasheetContext(createProject()).status, 'not-example');
  assert.equal(projectDatasheetContext(null).record, null);
  const renamed = structuredClone(project);
  renamed.name = 'Personal converter';
  renamed.schematic.parts.find((part) => part.ref === 'U1')!.ref = 'U7';
  assert.equal(projectDatasheetContext(renamed).bindings[0].reference, 'U7');
  for (const alter of [
    (p: typeof project) => {
      p.schematic.parts.find((part) => part.id === controller.id)!.value = 'LM2735X';
    },
    (p: typeof project) => {
      p.schematic.parts.find((part) => part.id === controller.id)!.fields!.Footprint =
        'Other:Package';
    },
    (p: typeof project) => {
      p.schematic.parts = p.schematic.parts.filter((part) => part.id !== controller.id);
    },
  ]) {
    const changed = appendSchematic(structuredClone(project)).project;
    changed.additionalSchematics![0].parts.push(structuredClone(controller));
    alter(changed);
    const context = projectDatasheetContext(changed);
    assert.equal(
      context.status,
      changed.schematic.parts.some((part) => part.id === controller.id)
        ? 'controller-mismatch'
        : 'not-example',
    );
    assert.equal(context.record, null);
  }
  project.extensions = {};
  assert.equal(projectDatasheetContext(project).status, 'available');
});

test('workspace observations reject forged specifications, cross-project bindings and hidden extra fields in renderer and service', async () => {
  const project = await example(2);
  const context = {
    version: 1,
    capturedAt: new Date().toISOString(),
    project: JSON.parse(serializeProject(project)),
    source: { pending: false, draft: null, error: '' },
    ui: { activeSchematicId: project.schematic.id },
    simulation: { status: 'disabled' },
    icDatasheet: projectDatasheetContext(project),
  };
  for (const validate of [validateAgentWorkspaceContext, validateServiceContext]) {
    assert.doesNotThrow(() =>
      validate(context, project.schematic.id, circuitFingerprint(project.schematic)),
    );
    for (const mutate of [
      (c: any) => {
        c.icDatasheet.record.parameters.switching_frequency.values.typ = 1600000;
      },
      (c: any) => {
        c.icDatasheet.record.datasheet.source_url = 'https://example.invalid/model';
      },
      (c: any) => {
        c.icDatasheet.bindings[0].partId = crypto.randomUUID();
      },
      (c: any) => {
        c.icDatasheet.record.unreviewed = 'extra';
      },
      (c: any) => {
        c.icDatasheet.status = 'not-example';
      },
    ]) {
      const forged = structuredClone(context);
      mutate(forged);
      assert.throws(() => validate(forged, project.schematic.id), /Invalid Agent workspace/);
    }
  }
  const prompt = makePrompt({
    prompt: 'Check frequency',
    context: { workspace: context },
    capabilities: true,
  });
  assert.match(prompt, /project\.datasheet/);
  assert.match(prompt, /Peak switch-current limits are not output-current ratings/);
  assert.match(prompt, /520000/);
  assert.match(prompt, /SNVS485I/);
});

test('the host exposes an origin-bound read query while pending Source stays independent', async () => {
  const first = new ProjectCore(await example(0));
  const second = new ProjectCore(await example(6));
  for (const core of [first, second]) {
    const host = createCapabilityHost();
    const ports = {
      datasheet: () => projectDatasheetContext(core.getSnapshot().project),
      state: () => null,
    } as unknown as WorkbenchCapabilityPorts;
    const remove = registerWorkbenchCapabilities(host, () => ports);
    const source = core.getSnapshot().source;
    const result = (await host.query('project.datasheet')) as ReturnType<
      typeof projectDatasheetContext
    >;
    const item = host.catalog().find((entry) => entry.id === 'project.datasheet')!;
    assert.equal(item.owner, 'host');
    assert.equal(item.mutation, false);
    assert.equal(item.review, 'none');
    await assert.rejects(
      host.query('project.datasheet', { exampleId: manifest.examples[0].id }),
      /input/,
    );
    core.updateSource('{invalid draft');
    assert.deepEqual(await host.query('project.datasheet'), result);
    assert.equal(core.getSnapshot().source, source);
    assert.equal(core.getSnapshot().undoDepth, 0);
    remove();
    await assert.rejects(host.query('project.datasheet'), /Unknown query/);
  }
  assert.notEqual(
    projectDatasheetContext(first.getSnapshot().project).record!.ic.family,
    projectDatasheetContext(second.getSnapshot().project).record!.ic.family,
  );
});
