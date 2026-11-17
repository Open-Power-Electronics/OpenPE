import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyCircuit, createPart, circuitFingerprint } from '../lib/circuit';
import { createProject, serializeProject } from '../lib/project';
import {
  agentSimulationContext,
  type AgentSimulationState,
} from '../context/agent-simulation-context';
import {
  validateAgentWorkspaceContext,
  agentPromptContext,
  agentSource,
  type AgentWorkspaceContext,
} from '../context/agent-workspace-context';
import { validateAgentWorkspaceContext as validateNativeContext } from '../server/agent-context-format.mjs';
import { startServer } from '../server/index.mjs';
import { makePrompt } from '../server/agents.mjs';
import { readFile } from 'node:fs/promises';
import { parseProject } from '../lib/project';
import { projectDatasheetContext } from '../lib/example-datasheets';
import { agentProject } from '../lib/agent-project-access';
import { createDatasheetService } from '../server/datasheets.mjs';

function fixture() {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', 25.4, 25.4));
  const project = createProject(circuit);
  const basis = circuitFingerprint(circuit);
  const time = Array.from({ length: 10001 }, (_, i) => i / 10000);
  const state: AgentSimulationState = {
    circuitId: circuit.id,
    basis,
    settingsVisible: true,
    waveformsVisible: true,
    status: 'completed',
    config: null,
    settings: [{ label: 'Duration (ms)', value: '1000' }],
    errors: [],
    probe: null,
    selected: ['v(out)'],
    live: false,
    presentation: {
      layout: '2x1',
      linked: false,
      visibleCursors: [true, true],
      traces: {
        'v(out)': {
          time: { min: 0.4, max: 0.6 },
          values: { min: -5, max: 10 },
          cursors: [0.55, 0.45],
        },
      },
    },
    result: {
      version: 'private solver version',
      log: 'private diagnostics',
      time,
      traces: [
        {
          vector: 'v(out)',
          label: 'V(OUT)',
          unit: 'V',
          targets: [{ kind: 'voltage', id: circuit.parts[0].id, pin: 0 }],
          values: time.map((t, i) => (i === 5123 ? 1234 : i === 7891 ? -876 : t * 10)),
        },
        { vector: 'i(r1)', label: 'I(R1)', unit: 'A', values: time.map((t) => -t) },
      ],
    },
  };
  const workspace: AgentWorkspaceContext = {
    version: 1,
    capturedAt: new Date().toISOString(),
    project: JSON.parse(serializeProject(project)),
    source: agentSource(null, ''),
    ui: { activeSchematicId: circuit.id, view: 'canvas', mode: 'interaction' },
    simulation: agentSimulationContext(state),
  };
  return { circuit, basis, state, workspace };
}

test('initial provider context keeps attachment identity and omits unrelated navigation', () => {
  const { circuit, basis, workspace } = fixture();
  const layout = {
    id: 'board',
    circuitId: circuit.id,
    basis: 'board-basis',
    layers: ['F.Cu', 'B.Cu'],
    counts: { footprints: 2 },
  };
  const presentation = { text: 'Origin project controls', controls: [], drawings: [] };
  workspace.ui.presentation = presentation;
  workspace.ui.projects = [{ title: 'Unrelated project' }];
  for (const scopedTools of [false, true]) {
    const projected = agentPromptContext(
      { id: circuit.id, basis, layout, workspace },
      scopedTools,
    ) as { layout: unknown; workspace: AgentWorkspaceContext };
    assert.deepEqual(projected.layout, {
      id: layout.id,
      circuitId: circuit.id,
      basis: layout.basis,
    });
    assert.equal(projected.workspace.ui.projects, undefined);
    assert.deepEqual(projected.workspace.ui.presentation, scopedTools ? undefined : presentation);
  }
});

test('schematic section observations retain the exact view and reject unsupported values', () => {
  const { workspace, circuit, basis } = fixture();
  for (const validate of [validateAgentWorkspaceContext, validateNativeContext]) {
    for (const schematicSection of ['hardware', 'simulation', 'all']) {
      const observed = { ...workspace, ui: { ...workspace.ui, schematicSection } };
      assert.doesNotThrow(() => validate(observed, circuit.id, basis));
      const prompt = agentPromptContext({ id: circuit.id, basis, workspace: observed }) as {
        workspace: AgentWorkspaceContext;
      };
      assert.equal(prompt.workspace.ui.schematicSection, schematicSection);
    }
    for (const schematicSection of ['other', '', null, ['hardware'], 0])
      assert.throws(
        () =>
          validate({ ...workspace, ui: { ...workspace.ui, schematicSection } }, circuit.id, basis),
        /Invalid Agent workspace context/,
      );
  }
});

test('workspace context retains Source metadata and rejects private native files, drafts and parser excerpts', () => {
  const { workspace, circuit, basis } = fixture();
  const privateText = '.subckt PRIVATE_MODEL A B\nprivate model implementation\n.ends';
  const observed = agentSource(privateText, `Unexpected token: ${privateText}`);
  assert.deepEqual(observed, {
    pending: true,
    draft: null,
    error: 'Source edits are invalid. Review them in Source.',
    draftCharacters: privateText.length,
  });
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_MODEL|implementation|Unexpected token/);
  for (const validate of [validateAgentWorkspaceContext, validateNativeContext]) {
    const safe = { ...workspace, source: observed, simulation: { status: 'disabled' } };
    assert.doesNotThrow(() => validate(safe, circuit.id, basis));
    for (const source of [
      { ...observed, draft: privateText },
      { ...observed, error: privateText },
      { ...observed, log: privateText },
      { ...observed, draftCharacters: -1 },
      { ...observed, draftCharacters: 8 * 1024 * 1024 + 1 },
    ])
      assert.throws(() => validate({ ...safe, source }, circuit.id, basis));
    assert.throws(() =>
      validate(
        {
          ...safe,
          project: {
            ...(safe.project as object),
            nativeFiles: {
              entry: 'project.kicad_pro',
              files: [{ name: 'models/private.lib', source: privateText }],
            },
          },
        },
        circuit.id,
        basis,
      ),
    );
  }
});

test('a greeting starts every runnable Agent without preparing the reviewed PDF', async () => {
  const project = parseProject(
    await readFile('tests/fixtures/reference/lm2735-msop8-sepic.json', 'utf8'),
  );
  const circuit = project.schematic;
  const workspace: AgentWorkspaceContext = {
    version: 1,
    capturedAt: new Date().toISOString(),
    project: agentProject(JSON.parse(serializeProject(project))),
    source: agentSource(null, ''),
    ui: { activeSchematicId: circuit.id },
    simulation: { status: 'disabled' },
  };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-datasheet-context-'));
  const prompts: string[] = [];
  const service = await startServer({
    dataDir,
    datasheetFetcher: async () => assert.fail('Send cannot fetch the datasheet PDF'),
    datasheetServiceFactory: (options) =>
      createDatasheetService({
        ...options,
        render: async () => assert.fail('Send cannot render the datasheet PDF'),
      }),
    agentRunner: async (provider, request, _cwd, emit, _signal, options) => {
      const capabilities = !!options?.capabilities && ['codex', 'claude'].includes(provider);
      const prompt = makePrompt({ ...request, capabilities });
      assert.match(prompt, /SNVS485I/);
      assert.doesNotMatch(prompt, /<datasheet-pdf>/);
      const context = JSON.parse(prompt.split('<circuit>\n')[1].split('\n</circuit>')[0]);
      if (capabilities) {
        assert.equal(context.workspace.icDatasheet.record, undefined);
        assert.equal(context.workspace.project.schematics[0].connections, undefined);
      } else {
        assert.ok(context.workspace.icDatasheet.record.parameters.switching_frequency);
        assert.ok(context.workspace.project.schematics[0].connections);
      }
      prompts.push(prompt);
      emit({ type: 'text', text: 'Fixture greeting' });
      return { outcome: 'completed' };
    },
  });
  try {
    const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
    const request = {
      sessionId: 'datasheet-session',
      prompt: 'hello',
      history: [],
      capabilities: true,
    };
    for (const provider of ['codex', 'claude', 'deepseek', 'pi']) {
      const response = await fetch(service.base + '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...request,
          provider,
          context: { id: circuit.id, basis: circuitFingerprint(circuit), workspace },
        }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Fixture greeting/);
    }
    assert.equal(prompts.length, 4);
    const forged = projectDatasheetContext(project);
    forged.record!.parameters.switching_frequency.values.typ = 1600000;
    const response = await fetch(service.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...request,
        provider: 'codex',
        context: {
          id: circuit.id,
          basis: circuitFingerprint(circuit),
          workspace: { ...workspace, icDatasheet: forged },
        },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(prompts.length, 4);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
test('Agent receives every trace with native extrema, endpoints, visible ranges and exact crossed cursors', () => {
  const { workspace } = fixture();
  const simulation = workspace.simulation;
  assert.ok('result' in simulation && simulation.result);
  const result = simulation.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.traces.length, 2);
  const trace = result.traces[0];
  assert.deepEqual(trace.statistics, { min: -876, max: 1234, first: 0, last: 10 });
  assert.ok(trace.samples.some(([, value]) => value === 1234));
  assert.ok(trace.samples.some(([, value]) => value === -876));
  assert.deepEqual(trace.samples[0], [0, 0]);
  assert.deepEqual(trace.samples.at(-1), [1, 10]);
  assert.ok(trace.samples.length < result.sampleCount);
  assert.match(result.sampling, /not the full sample series/);
  assert.deepEqual(trace.visibleWindow?.cursors, [
    { time: 0.55, value: 5.5 },
    { time: 0.45, value: 4.5 },
  ]);
  assert.ok(Math.abs(trace.visibleWindow!.delta!.time + 0.1) < 1e-12);
  assert.equal(trace.visibleWindow!.delta!.value, -1);
  assert.equal(result.traces[1].selected, false);
  assert.doesNotMatch(JSON.stringify(workspace), /private solver|private diagnostics/);
});

test('Live results and absent results remain explicit; hidden cursors do not become measurements', () => {
  const { state } = fixture();
  state.live = true;
  state.status = 'running';
  state.presentation!.visibleCursors = [false, false];
  const live = agentSimulationContext(state);
  assert.equal(live.result?.status, 'live');
  assert.deepEqual(live.result?.traces[0].visibleWindow?.cursors, [null, null]);
  assert.equal(live.result?.traces[0].visibleWindow?.delta, null);
  assert.equal(agentSimulationContext({ ...state, result: null }).result, null);
  assert.equal(agentSimulationContext({ ...state, partial: true }).result?.status, 'live');
});

test('Stopped results retain reduced native measurements and their run settings without private diagnostics', () => {
  const { state } = fixture();
  state.status = 'stopped';
  state.partial = true;
  state.config = {
    inputId: 'input',
    pwmId: 'pwm',
    outputId: 'output',
    switchId: 'switch',
    currentId: 'current',
    voltage: 12,
    frequency: 100000,
    duty: 50,
    stop: 2,
    step: 0.0002,
  };
  state.resultConfig = { ...state.config, stop: 1, step: 0.0001 };
  state.result = {
    ...state.result!,
    time: state.result!.time.slice(0, 6001),
    traces: state.result!.traces.map((trace) => ({
      ...trace,
      values: trace.values.slice(0, 6001),
    })),
  };
  const stopped = agentSimulationContext(state);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.result?.status, 'partial');
  assert.equal(stopped.result?.sampleCount, 6001);
  assert.deepEqual(stopped.result?.timeRange, [0, 0.6]);
  assert.deepEqual(stopped.resultConfig, { ...state.config, stop: 1, step: 0.0001 });
  assert.equal(stopped.config?.stop, 2);
  const trace = stopped.result!.traces[0];
  assert.deepEqual(trace.statistics, { min: 0, max: 1234, first: 0, last: 6 });
  assert.deepEqual(trace.samples[0], [0, 0]);
  assert.deepEqual(trace.samples.at(-1), [0.6, 6]);
  assert.ok(trace.samples.some(([, value]) => value === 1234));
  assert.ok(trace.samples.length < stopped.result!.sampleCount);
  assert.deepEqual(trace.visibleWindow?.cursors, [
    { time: 0.55, value: 5.5 },
    { time: 0.45, value: 4.5 },
  ]);
  assert.equal(trace.visibleWindow?.delta?.value, -1);
  assert.doesNotMatch(JSON.stringify(stopped), /private solver|private diagnostics/);
  assert.equal('partial' in stopped, false);
  const empty = agentSimulationContext({ ...state, result: null });
  assert.equal(empty.result, null);
  assert.equal('partial' in empty, false);
});

test('Renderer and generated service accept stopped partial results and reject mismatched result states', () => {
  const { workspace, circuit, basis, state } = fixture();
  workspace.simulation = agentSimulationContext({ ...state, status: 'stopped', partial: true });
  for (const validate of [validateAgentWorkspaceContext, validateNativeContext]) {
    assert.doesNotThrow(() => validate(workspace, circuit.id, basis));
    const empty = structuredClone(workspace);
    empty.simulation = agentSimulationContext({ ...state, status: 'stopped', result: null });
    assert.doesNotThrow(() => validate(empty, circuit.id, basis));
    for (const status of ['idle', 'running', 'completed', 'failed']) {
      const mismatched = structuredClone(workspace) as any;
      mismatched.simulation.status = status;
      assert.throws(() => validate(mismatched, circuit.id, basis));
    }
    for (const resultStatus of ['live', 'completed']) {
      const mismatched = structuredClone(workspace) as any;
      mismatched.simulation.result.status = resultStatus;
      assert.throws(() => validate(mismatched, circuit.id, basis));
    }
  }
});

test('Renderer and generated service reject stale identities, malformed results, retired formats and Source/result conflicts', () => {
  const { workspace, circuit, basis } = fixture();
  for (const validate of [validateAgentWorkspaceContext, validateNativeContext]) {
    assert.doesNotThrow(() => validate(workspace, circuit.id, basis));
    const reject = (change: (value: any) => void) => {
      const value = structuredClone(workspace);
      change(value);
      assert.throws(() => validate(value, circuit.id, basis));
    };
    reject((value) => {
      value.simulation.basis = 'old circuit';
    });
    reject((value) => {
      value.simulation.circuitId = crypto.randomUUID();
    });
    reject((value) => {
      value.source.pending = true;
      value.source.draft = '{invalid';
    });
    reject((value) => {
      value.simulation.status = 'failed';
    });
    reject((value) => {
      value.simulation.result.status = 'live';
    });
    reject((value) => {
      value.simulation.result.traces[0].samples[0][1] = null;
    });
    reject((value) => {
      value.simulation.result.log = 'unexpected private log';
    });
    reject((value) => {
      value.project.format = 'unsupported-format';
    });
    const draft = structuredClone(workspace);
    draft.source = agentSource('{invalid', 'Invalid JSON');
    draft.simulation = { status: 'disabled' };
    assert.doesNotThrow(() => validate(draft, circuit.id, basis));
  }
});

test('Authenticated chat forwards the complete workspace to the selected provider only on a submitted request', async () => {
  const { workspace, circuit, basis } = fixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-agent-context-'));
  const received: any[] = [];
  const service = await startServer({
    dataDir,
    agentRunner: async (provider, request, _cwd, emit) => {
      received.push({ provider, request });
      emit({ type: 'text', text: 'Fixture reply' });
      return { outcome: 'completed' };
    },
  });
  try {
    const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
    for (const provider of ['codex', 'claude']) {
      const body = {
        sessionId: 'context-session',
        provider,
        prompt: 'Explain these results',
        history: [],
        context: { id: circuit.id, basis, workspace },
      };
      const response = await fetch(service.base + '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(
        received.at(-1).request.context.workspace,
        JSON.parse(JSON.stringify(workspace)),
      );
      const prompt = makePrompt(received.at(-1).request);
      assert.match(prompt, /Live samples are provisional/);
      assert.match(prompt, /V\(OUT\)/);
      assert.doesNotMatch(prompt, /private diagnostics/);
    }
    const bad = structuredClone(workspace) as any;
    bad.simulation.basis = 'stale';
    const response = await fetch(service.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'context-session',
        provider: 'codex',
        prompt: 'Invalid',
        history: [],
        context: { id: circuit.id, basis, workspace: bad },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(received.length, 2);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
