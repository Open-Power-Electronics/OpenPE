import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPart, emptyCircuit, circuitFingerprint } from '../lib/circuit';
import { createProject, projectFromNativeFiles, serializeProject } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { agentPromptContext } from '../context/agent-prompt-context';
import { agentSource } from '../context/agent-workspace-context';
import { makePrompt, runAgent } from '../server/agents.mjs';
import {
  agentCapabilityTools,
  agentRevisionGuidance,
  agentDiscoveryGuidance,
  agentSimulationGuidance,
} from '../server/agent-capabilities.mjs';

const promptContext = (text: string) =>
  JSON.parse(text.split('<circuit>\n')[1].split('\n</circuit>')[0]);
const draftingGuidance = (text: string) =>
  text.split('<schematic-drafting-guidance>\n')[1].split('\n</schematic-drafting-guidance>')[0];

test('live schematic drafting guidance works without the optional PCB guide and preserves edit scope', () => {
  const request = {
    prompt: 'Redraw the feedback circuit with readable connections.',
    context: { title: 'Feedback circuit' },
    capabilities: true,
  };
  const text = makePrompt(request);
  const guidance = draftingGuidance(text);
  assert.doesNotMatch(text, /<bundled-pcb-design-guidance>/);
  assert.match(guidance, /continuous, short orthogonal wires/);
  assert.match(guidance, /Do not give every pin a short wire and a repeated net label/);
  assert.match(
    guidance,
    /Reserve labels for power\/ground notation, external or off-sheet interfaces/,
  );
  assert.match(guidance, /schematic\.drafting/);
  assert.match(guidance, /canonical annotation ID returned by schematic\.drafting/);
  assert.match(guidance, /schematic\.wires/);
  assert.doesNotMatch(guidance, /schematic\.(position|connections|arrange|batch)/);
  assert.match(guidance, /omit repeated coordinate lists and raw tool argument dumps/);
  assert.match(guidance, /does not search for paths or autoroute/);
  assert.match(
    guidance,
    /retain exact imported pin or junction anchors even when they are off-grid/,
  );
  assert.match(guidance, /Preserve the existing drawing for value-only/);
  assert.match(guidance, /Do not replace the whole project merely to avoid/);
  assert.match(guidance, /schematic\.erc separately/);
  assert.doesNotMatch(guidance, /This integration has no live schematic drafting tools/);
  assert.equal(
    draftingGuidance(makePrompt(request, 'Optional PCB engineering methodology')),
    guidance,
    'Optional PCB guidance must not gate or alter the fixed schematic workflow.',
  );
});

test('context-only drafting guidance keeps unsupported wiring outside the proposal transport', () => {
  const guidance = draftingGuidance(
    makePrompt({ prompt: 'Redraw the feedback circuit.', context: { title: 'Feedback circuit' } }),
  );
  assert.match(guidance, /This integration has no live schematic drafting tools/);
  assert.match(guidance, /emit only the documented supported proposal operations/);
  assert.match(guidance, /Do not invent wire\/label proposal kinds/);
  assert.match(guidance, /unwired part placements/);
  assert.doesNotMatch(guidance, /schematic\.(drafting|wire|wires|erc)/);
  assert.match(guidance, /readable trunks and branches/);
});

test('live prompts and command discovery share explicit accepted-edit revision reuse', () => {
  const text = makePrompt({ prompt: 'Redraw the circuit.', context: {}, capabilities: true });
  assert.ok(text.includes(agentRevisionGuidance));
  assert.ok(text.includes(agentDiscoveryGuidance));
  assert.ok(
    agentCapabilityTools
      .find((tool) => tool.name === 'openpe_query')!
      .description.includes(agentDiscoveryGuidance),
  );
  assert.ok(draftingGuidance(text).includes(agentRevisionGuidance));
  assert.ok(
    agentCapabilityTools
      .find((tool) => tool.name === 'openpe_execute')!
      .description.includes(agentRevisionGuidance),
  );
  assert.match(
    agentRevisionGuidance,
    /explicitly pass the fresh revision returned by the preceding accepted edit/,
  );
  assert.match(
    agentRevisionGuidance,
    /Re-query core.state after a stale-revision rejection, any error/,
  );
  assert.match(agentRevisionGuidance, /Never guess or increment revisions/);
  assert.ok(
    !makePrompt({ prompt: 'Explain the circuit.', context: {} }).includes(agentRevisionGuidance),
  );
});

test('live Agent instructions reuse discovery within a turn and inspect simulation state on demand', () => {
  const prompt = makePrompt({ prompt: 'Run the transient.', context: {}, capabilities: true });
  assert.ok(prompt.includes(agentDiscoveryGuidance));
  assert.ok(prompt.includes(agentSimulationGuidance));
  assert.match(
    agentDiscoveryGuidance,
    /Reuse the discovered index and full tool definitions for the rest of this turn/,
  );
  assert.match(agentDiscoveryGuidance, /batch those ids in one request/);
  assert.match(agentDiscoveryGuidance, /Do not repeat the same discovery query/);
  assert.match(agentDiscoveryGuidance, /Refresh discovery only for an unseen capability/);
  assert.match(agentDiscoveryGuidance, /host rechecks it on every invocation/);
  assert.match(
    agentSimulationGuidance,
    /Await its result and reuse that returned simulation state/,
  );
  assert.match(agentSimulationGuidance, /simulation.status only when current progress/);
  assert.match(
    agentSimulationGuidance,
    /Never use capabilities.list as a simulation progress check/,
  );
  for (const name of ['openpe_query', 'openpe_execute'])
    assert.ok(
      agentCapabilityTools
        .find((tool) => tool.name === name)!
        .description.includes(agentSimulationGuidance),
    );
  const contextOnly = makePrompt({ prompt: 'Explain the circuit.', context: {} });
  assert.equal(contextOnly.includes(agentDiscoveryGuidance), false);
  assert.equal(contextOnly.includes(agentSimulationGuidance), false);
});

test('the native EMC Flyback prompt fits provider input while preserving electrical and observed state', async () => {
  const names = ['emc-flyback.kicad_pro', 'emc-flyback.kicad_sch', 'emc-flyback.kicad_pcb'];
  const project = projectFromNativeFiles({
    entry: names[0],
    files: await Promise.all(
      names.map(async (name) => ({
        name,
        source: await readFile(`project/emc-flyback/${name}`, 'utf8'),
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
      source: agentSource(null, ''),
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
      source: agentSource('(invalid native draft'.repeat(60_000), 'Unclosed list'),
      simulation: { status: 'disabled' },
      thermal: { status: 'disabled' },
      icDatasheet: { status: 'not-example', record: null },
      ui: { activeSchematicId: secondary.id, view: 'source' },
    },
  };
  const sent = promptContext(makePrompt({ prompt: 'Review the draft', context }));
  assert.deepEqual(sent.workspace.source, {
    pending: true,
    error: 'Source edits are invalid. Review them in Source.',
    draftCharacters: context.workspace.source.draftCharacters,
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
      source: agentSource(null, ''),
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
