import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPart, emptyCircuit, circuitFingerprint } from '../lib/circuit';
import { createProject, projectFromNativeFiles, serializeProject } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { agentPromptContext } from '../context/agent-prompt-context';
import { makePrompt, runAgent } from '../server/agents.mjs';

const promptContext = (text: string) =>
  JSON.parse(text.split('<circuit>\n')[1].split('\n</circuit>')[0]);

test('the native EMC Flyback prompt fits provider input while preserving electrical and observed state', async () => {
  const names = ['emc-flyback.kicad_pro', 'emc-flyback.kicad_sch', 'emc-flyback.kicad_pcb'];
  const project = projectFromNativeFiles({
    entry: names[0],
    files: await Promise.all(
      names.map(async (name) => ({
        name,
        source: await readFile(`recent/emc-flyback/${name}`, 'utf8'),
      })),
    ),
  });
  const native = serializeProject(project);
  const document = JSON.parse(native);
  const circuit = project.schematic;
  const context = {
    title: circuit.title,
    id: circuit.id,
    basis: circuitFingerprint(circuit),
    parts: circuit.parts.map(({ raw: _raw, ...part }) => part),
    wires: circuit.wires,
    labels: circuit.labels,
    junctions: circuit.junctions,
    workspace: {
      version: 1,
      capturedAt: new Date().toISOString(),
      project: document,
      source: { pending: false, draft: null, error: '' },
      ui: { activeSchematicId: circuit.id, view: 'canvas', revision: '12' },
      simulation: { status: 'not-opened' },
    },
  };
  const original = JSON.stringify(context);
  assert.ok(
    original.length > 1_048_576,
    'The actual native project reproduces the oversized input.',
  );
  const text = makePrompt({ prompt: '这个电路中的功率管是哪个', context, capabilities: true });
  assert.ok(text.length < 70_000, 'Send semantic context with ample headroom for a conversation.');
  const sent = promptContext(text);
  const observed = sent.workspace.project;
  const sheet = observed.schematics[0];
  const q1 = sheet.components.items.find((part: any) => part.ref === 'Q1');
  assert.equal(q1.value, 'IRF520NPBF');
  assert.equal(q1.simulation['Sim.Pins'], '2=D 1=G 3=S');
  assert.equal(
    q1.footprint,
    document.schematic.components.find((part: any) => part.reference === 'Q1').fields.Footprint,
  );
  assert.deepEqual(sent.workspace.source, { pending: false, error: '', draftCharacters: 0 });
  assert.deepEqual(sent.workspace.ui, context.workspace.ui);
  assert.deepEqual(sent.workspace.simulation, context.workspace.simulation);
  assert.deepEqual(observed.nativeFileNames, names);
  assert.equal(observed.nativeFiles, undefined);
  assert.equal(sheet.kicad, undefined);
  assert.equal(sent.parts, undefined, 'Do not duplicate the active sheet at the top level.');
  assert.equal(sent.wires, undefined);
  assert.equal(observed.extensions, undefined);
  assert.equal(observed.pcb.tracks, undefined);
  assert.equal(observed.pcb.footprints, undefined, 'Defer PCB placement details outside Layout.');
  assert.deepEqual(
    sheet.components.items.map(({ id, ref, value }: any) => ({
      id,
      ref,
      value,
    })),
    circuit.parts.map(({ id, ref, value }) => ({
      id,
      ref,
      value,
    })),
  );
  const byId = new Map(circuit.parts.map((part) => [part.id, part.ref]));
  assert.deepEqual(
    sheet.connections.items,
    projectNetGroups(circuit).map((group) => ({
      labels: [...new Set(group.labels.map((index) => circuit.labels[index].text))],
      pins: group.pins
        .filter((key) => !key.startsWith('physical:'))
        .map((key) => {
          const [id, pin] = JSON.parse(key);
          return [byId.get(id), pin];
        }),
    })),
  );
  assert.deepEqual(
    sheet.symbolPins[q1.libId].items.map(({ number, name }: any) => [number, name]),
    [
      ['1', 'G'],
      ['2', 'D'],
      ['3', 'S'],
    ],
  );
  assert.equal(observed.pcb.counts.tracks, project.pcb!.tracks.length);
  assert.equal(
    JSON.stringify(context),
    original,
    'Projection must not mutate the captured workspace.',
  );
  assert.equal(serializeProject(project), native, 'Native source and design stay unchanged.');
});

test('prompt projection summarizes other sheets and pending Source while retaining observed results', () => {
  const primary = emptyCircuit();
  const secondary = emptyCircuit();
  primary.parts.push(createPart(primary, 'R', 25.4, 25.4));
  secondary.parts.push(createPart(secondary, 'C', 50.8, 25.4));
  primary.parts[0].fields = { InternalNote: 'unnecessary automatic context' };
  const project = createProject(primary);
  project.additionalSchematics = [secondary];
  const context = {
    workspace: {
      project: JSON.parse(serializeProject(project)),
      source: {
        pending: true,
        draft: '(invalid native draft'.repeat(60_000),
        error: 'Unclosed list',
      },
      simulation: { status: 'disabled' },
      thermal: { status: 'disabled' },
      icDatasheet: { status: 'not-example', record: null },
      ui: { activeSchematicId: secondary.id, view: 'source' },
    },
  };
  const sent = promptContext(makePrompt({ prompt: 'Review the draft', context }));
  assert.deepEqual(sent.workspace.source, {
    pending: true,
    error: 'Unclosed list',
    draftCharacters: context.workspace.source.draft.length,
  });
  assert.equal(sent.workspace.source.draft, undefined);
  assert.deepEqual(sent.workspace.icDatasheet, context.workspace.icDatasheet);
  assert.deepEqual(sent.workspace.thermal, context.workspace.thermal);
  assert.deepEqual(sent.workspace.ui, context.workspace.ui);
  const sheets = sent.workspace.project.schematics;
  assert.equal(sheets[0].id, primary.id);
  assert.equal(sheets[0].counts.components, 1);
  assert.equal(sheets[0].components, undefined);
  assert.equal(sheets[1].id, secondary.id);
  assert.equal(sheets[1].components.items[0].value, secondary.parts[0].value);
  assert.ok(Object.keys(sheets[1].symbolPins).length);
  assert.doesNotMatch(JSON.stringify(sent), /invalid native draft|unnecessary automatic context/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(agentPromptContext(context))),
    sent,
    'Renderer and generated host projections agree.',
  );
});

test('large sheet summaries disclose omissions and retain the current selection', () => {
  const circuit = emptyCircuit();
  for (let index = 0; index < 260; index++)
    circuit.parts.push(createPart(circuit, 'R', index * 12.7, 25.4));
  const selected = circuit.parts.at(-1)!;
  const context = {
    workspace: {
      project: JSON.parse(serializeProject(createProject(circuit))),
      source: { pending: false, draft: null, error: '' },
      ui: { activeSchematicId: circuit.id, selection: [selected.id] },
    },
  };
  const sheet = (agentPromptContext(context) as any).workspace.project.schematics[0];
  assert.equal(sheet.components.total, 260);
  assert.equal(sheet.components.items.length, 256);
  assert.equal(sheet.components.truncated, true);
  assert.equal(sheet.components.items[0].id, selected.id);
  assert.ok(
    sheet.connections.items.some((group: any) =>
      group.pins.some(([ref]: string[]) => ref === selected.ref),
    ),
  );
  assert.equal(sheet.selectedGeometry.pins[0].componentId, selected.id);
  assert.equal(sheet.selectedGeometry.pins[0].pins.items.length, 2);
});

test('assembled prompt limits include context, history and instructions and fail before provider launch', async () => {
  const request = {
    prompt: 'Explain Q1',
    context: { title: 'Fixture' },
    history: [] as { role: string; text: string }[],
  };
  assert.throws(
    () => makePrompt({ ...request, context: { source: 'x'.repeat(1_048_576) } }),
    /assembled Agent request exceeds/,
  );
  assert.throws(
    () => makePrompt({ ...request, history: [{ role: 'assistant', text: 'x'.repeat(1_048_576) }] }),
    /assembled Agent request exceeds/,
  );
  assert.throws(
    () => makePrompt(request, 'x'.repeat(1_048_576)),
    /assembled Agent request exceeds/,
  );
  await assert.rejects(
    runAgent(
      'codex',
      { ...request, context: { source: 'x'.repeat(1_048_576) } },
      process.cwd(),
      () => {},
      new AbortController().signal,
      {
        resolve: async () => {
          throw new Error('The provider must not launch.');
        },
      },
    ),
    /assembled Agent request exceeds/,
  );
});
