// Isolated renderer regression: saved waveform visibility and restore races; no Electron/solver.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const flyBuckSource = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'))[
  'reference-lm25017-wson8-flybuck'
];
const bundle = await build({
  stdin: {
    contents: `
      import React, {useRef, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import SimulationDialog from './plugins/spice-simulation/renderer/SimulationDialog';
      import {switchingStageFixture} from './tests/fixtures/switching-stage';
      import {createProject, serializeProject, parseProject} from './lib/project';
      import {buildSpiceDeck, defaultTransient} from './plugins/spice-simulation/domain/spice';
      import {createCapabilityHost} from './api/capabilities';
      import { loadWorkbenchPlugins } from './lib/workbench-plugins';
      const original = serializeProject(createProject(switchingStageFixture()));
      const flyBuckOriginal = ${JSON.stringify(flyBuckSource)};
      function Harness({generation, renameInput=false, example='switching', fileId: initialFileId='00000000-0000-4000-8000-000000000001', visible: initiallyVisible=true, pending: initiallyPending=false}) {
        const [project, setProject] = useState(() => {
          const next = parseProject(example === 'flybuck' ? flyBuckOriginal : original);
          if (renameInput) {
            const input = defaultTransient(next.schematic).inputId;
            next.schematic.parts.find(part => part.id === input).value = 'Supply';
          }
          return next;
        });
        const [visible, setVisible] = useState(initiallyVisible);
        const [pending, setPending] = useState(initiallyPending);
        const [fileId, setFileId] = useState(initialFileId);
        const [probe, setProbe] = useState(null);
        const [waveformsVisible, setWaveformsVisible] = useState(false);
        const [host] = useState(createCapabilityHost);
        const settings = useRef(null);
        const waveforms = useRef(null);
        const context = useRef(null);
        window.fixture = {
          generation, source: () => serializeProject(project), context: () => context.current?.(),
          defaults: () => defaultTransient(project.schematic),
          defaultProbe: () => buildSpiceDeck(project.schematic, defaultTransient(project.schematic)).traces
            .find(trace => trace.unit === 'V' && trace.targets?.length)?.targets[0],
          waveformsVisible: () => waveformsVisible,
          setVisible, setPending, setProbe, setFileId,
          execute: (id, input) => host.execute(id, input, {actor:'agent'}),
          change: () => { const next = parseProject(serializeProject(project));
            next.name += ' changed'; setProject(next); },
          response: (body, savedConfig, value=7) => { const p = parseProject(body.source);
            const config = body.config ?? savedConfig ?? defaultTransient(p.schematic);
            const deck = buildSpiceDeck(p.schematic, config);
            return {config, result:{version:'fixture', log:'fixture', time:[0, deck.stop],
              traces: deck.traces.map(trace => ({...trace, values:[value, value]}))}}; },
        };
        return <><div className="fixture-surface schematic-surface"><div className="schematic-drawing">
          <div className="fixture-canvas"/>
          <div id="waveforms" ref={waveforms} className="simulation-host" hidden={!visible || !waveformsVisible}/>
        </div><div id="settings" ref={settings} className="simulation-settings-host" hidden={!visible}/></div>
          <SimulationDialog project={project} settingsHost={settings} waveformHost={waveforms}
          visible={visible} sourcePending={pending} probe={probe}
          fileId={fileId ?? undefined} agentContextRef={context}
          capabilityHost={host}
          onWaveformVisibilityChange={setWaveformsVisible} onCloseSettings={() => setVisible(false)} /></>;
      }
      let generation=0;
      const root = createRoot(document.getElementById('root'));
      window.remountSimulationFixture = (options={}) => {
        root.render(<Harness key={++generation} generation={generation} {...options}/>);
        return generation;
      };
      void loadWorkbenchPlugins().then(() => window.remountSimulationFixture());
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.savedResultStages = [];
    new MutationObserver(() => {
      const stage = document
        .querySelector('[data-saved-result-loading]')
        ?.getAttribute('data-saved-result-loading');
      if (stage) window.savedResultStages.push(stage);
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-saved-result-loading'],
    });
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
  });
  let runs = 0,
    miss = false,
    hold = false,
    holdStatus = false,
    statusResponses = 0,
    omitResponseConfig = false,
    legacyProbeMetadata = false,
    reboundProbe = null,
    storedConfig = null;
  const lookups = [];
  const held = [];
  const heldStatuses = [];
  const fixtureResponse = (body, value = 7) =>
    page.evaluate(({ body, config, value }) => window.fixture.response(body, config, value), {
      body,
      config: storedConfig,
      value,
    });
  const cachedResponse = async (body) => {
    // Explicit settings require an exact cache match. Omitted settings discover the
    // stored run, independently of the fresh renderer's default duration/step.
    if (
      miss ||
      (body.config &&
        storedConfig &&
        Object.keys(storedConfig).some((key) => storedConfig[key] !== body.config[key]))
    )
      return { result: null };
    const response = await fixtureResponse(body);
    if (legacyProbeMetadata) {
      const trace = response.result.traces.find((trace) => trace.targets?.length > 1);
      assert.ok(trace, 'LM25017 has a waveform with multiple current probe targets.');
      reboundProbe = {
        vector: trace.vector,
        target: trace.targets.at(-1),
        targets: trace.targets,
        label: trace.label,
      };
      trace.targets = trace.targets.slice(0, -1);
      trace.label = 'Legacy probe metadata';
    }
    if (omitResponseConfig) delete response.config;
    return response;
  };
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({
        json: {
          controlsVersion: 1,
          plugins: [{ id: 'spice-simulation@openpe', installed: true, enabled: true }],
          updatedAt: Date.now(),
        },
      });
    if (url.pathname === '/api/simulation/status') {
      if (holdStatus) {
        heldStatuses.push(route);
        return;
      }
      statusResponses++;
      return route.fulfill({ json: { available: true, version: 'fixture' } });
    }
    if (url.pathname === '/api/simulation/result') {
      const body = route.request().postDataJSON();
      lookups.push(body);
      assert.equal(
        await page.locator('[data-saved-result-loading="reading"]').isVisible(),
        true,
        'Loading UI paints before the saved-result request.',
      );
      if (hold) {
        held.push({ route, body });
        return;
      }
      return route.fulfill({ json: await cachedResponse(body) });
    }
    if (url.pathname === '/api/simulation/transient') {
      runs++;
      const body = route.request().postDataJSON();
      const response = await fixtureResponse(body, 9);
      storedConfig = body.config;
      return route.fulfill({ json: response.result });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div>',
    });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      '#root{height:100vh;padding:16px;display:flex}.fixture-surface{display:flex;flex:1;min-width:0;min-height:0}.fixture-canvas{flex:1;min-height:120px}#waveforms{height:400px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const complete = () =>
    page.waitForFunction(() => window.fixture?.context()?.status === 'completed');
  const remount = async (options = {}) => {
    const generation = await page.evaluate(
      (options) => window.remountSimulationFixture(options),
      options,
    );
    await page.waitForFunction(
      (generation) => window.fixture.generation === generation && !!window.fixture.context(),
      generation,
    );
  };
  const waitForHeld = async (count) => {
    for (let i = 0; held.length < count && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(held.length, count, 'Expected a deferred saved-result lookup.');
    return held[count - 1];
  };
  const deliver = async (entry, response) => {
    // Aborted browser requests may no longer accept a response. Either outcome
    // must leave the new source/settings/run untouched.
    await entry.route.fulfill({ json: response }).catch(() => {});
    await page.waitForTimeout(40);
  };
  const duration = page.getByRole('textbox', { name: 'Duration (ms)', exact: true });
  const step = page.getByRole('textbox', { name: 'Max. time step (µs)', exact: true });
  const assertTiming = async (stop, maxStep) => {
    assert.ok(Math.abs(Number(await duration.inputValue()) - stop * 1000) < 1e-10);
    assert.ok(Math.abs(Number(await step.inputValue()) - maxStep * 1e6) < 1e-10);
    const context = await page.evaluate(() => window.fixture.context());
    assert.ok(Math.abs(context.config.stop - stop) < 1e-15);
    assert.ok(Math.abs(context.config.step - maxStep) < 1e-15);
  };
  const assertPlot = async () => {
    assert.equal(
      await page.locator('.simulation-dock').isVisible(),
      true,
      'A restored completed result opens the waveform dock without a fresh canvas probe.',
    );
    assert.equal(await page.evaluate(() => window.fixture.waveformsVisible()), true);
    const bounds = await page
      .locator('.simulation-dock svg[aria-label$=" waveform"]')
      .first()
      .boundingBox();
    assert.ok(bounds?.width >= 220 && bounds.height >= 128, 'The waveform plot has visible area.');
    assert.ok(
      (await page
        .locator('.simulation-dock svg[aria-label$=" waveform"] .simulation-trace')
        .count()) > 0,
      'A restored result selects a trace and renders its waveform path.',
    );
  };
  const assertLookupBlocksRun = async () => {
    await page
      .locator('.simulation-settings-footer')
      .getByRole('progressbar', { name: 'Loading saved SPICE results…', exact: true })
      .waitFor();
    assert.equal(await page.locator('.simulation-settings-body').getAttribute('aria-busy'), 'true');
    const loadingBox = await page.locator('[data-saved-result-loading]').boundingBox();
    const runBox = await page.getByRole('button', { name: 'Run', exact: true }).boundingBox();
    assert.ok(loadingBox.x + loadingBox.width <= runBox.x, 'Loading progress sits left of Run.');
    assert.ok(
      Math.abs(loadingBox.y + loadingBox.height / 2 - runBox.y - runBox.height / 2) < 2,
      'Loading progress shares the Run row.',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Run', exact: true }).isDisabled(),
      true,
      'Run waits for the saved-result lookup.',
    );
    const message = await page.evaluate(() =>
      window.fixture.execute('simulation.run', {}).then(
        () => 'unexpected run',
        (error) => error.message,
      ),
    );
    assert.match(message, /saved simulation lookup to finish/);
    assert.equal(runs, 0, 'Agent Run cannot race a saved-result lookup.');
  };

  await complete();
  await assertPlot();
  assert.equal(await page.locator('[data-saved-result-loading]').count(), 0);
  assert.ok((await page.evaluate(() => window.savedResultStages)).includes('preparing'));
  assert.equal(lookups.length, 1);
  assert.equal('config' in lookups[0], false, 'Pristine settings discover saved timing.');
  assert.equal(runs, 0, 'Opening settings restores a result without Run.');
  const source = await page.evaluate(() => window.fixture.source());
  const defaults = await page.evaluate(() => window.fixture.defaults());
  const restored = await page.evaluate(() => window.fixture.context());
  assert.equal(restored.selected.length, 1, 'Restore opens one trace rather than every trace.');
  assert.ok(
    restored.result.traces
      .find((trace) => trace.selected)
      ?.targets.some((target) => target.kind === 'voltage' && target.id === defaults.outputId),
    'The restored default trace is output voltage when available.',
  );
  const additional = restored.result.traces.find(
    (trace) => !trace.selected && trace.targets.length,
  );
  assert.ok(additional);
  await page.evaluate((probe) => window.fixture.setProbe(probe), additional.targets[0]);
  await page.waitForFunction(() => window.fixture.context()?.selected.length === 2);
  await page.getByRole('button', { name: 'Close simulation settings', exact: true }).click();
  assert.equal(await page.locator('.simulation-dock').isVisible(), false);
  await page.evaluate(() => window.fixture.setVisible(true));
  await complete();
  await assertPlot();
  assert.equal(lookups.length, 1, 'Resident results and probes survive settings close/reopen.');
  assert.equal(await page.evaluate(() => window.fixture.context().selected.length), 2);
  assert.equal(await page.evaluate(() => window.fixture.source()), source);
  await page.waitForFunction(
    () => !document.querySelector('.simulation-settings-footer button').disabled,
  );

  holdStatus = true;
  hold = true;
  held.length = 0;
  const statusResponsesBeforeRestore = statusResponses;
  await remount();
  const parallelLookup = await waitForHeld(1);
  for (let i = 0; !heldStatuses.length && i < 200; i++) await page.waitForTimeout(10);
  assert.equal(heldStatuses.length, 1, 'The preliminary solver status request remains pending.');
  assert.equal(
    statusResponses,
    statusResponsesBeforeRestore,
    'Saved-result lookup starts without a completed solver status request.',
  );
  await page.evaluate(() => window.fixture.setProbe(window.fixture.defaultProbe()));
  await page.getByText('Loading saved simulation…', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.simulation-dock').innerText(), /Run the simulation/);
  await assertLookupBlocksRun();
  await deliver(parallelLookup, await cachedResponse(parallelLookup.body));
  await complete();
  await assertPlot();
  assert.equal(
    statusResponses,
    statusResponsesBeforeRestore,
    'Verified saved waveforms render before preliminary solver detection settles.',
  );
  holdStatus = false;
  statusResponses++;
  await heldStatuses.shift().fulfill({ json: { available: true, version: 'fixture' } });
  await page.waitForFunction(
    () => !document.querySelector('.simulation-settings-footer button').disabled,
  );

  held.length = 0;
  await remount();
  const detectedLookup = await waitForHeld(1);
  await page.waitForFunction(() => window.fixture.context()?.status === 'idle');
  await assertLookupBlocksRun();
  hold = false;
  await deliver(detectedLookup, await cachedResponse(detectedLookup.body));
  await complete();
  await assertPlot();

  storedConfig = { ...defaults, stop: 0.0073, step: 0.00000035 };
  await remount();
  await complete();
  await assertPlot();
  await assertTiming(storedConfig.stop, storedConfig.step);
  assert.deepEqual(await page.evaluate(() => window.fixture.context().resultConfig), storedConfig);
  assert.deepEqual(await page.evaluate(() => window.fixture.context().result.timeRange), [
    0,
    storedConfig.stop,
  ]);
  assert.equal('config' in lookups.at(-1), false);
  assert.equal(runs, 0, 'Custom saved timing restores after a fresh renderer mount without Run.');
  assert.equal(await page.evaluate(() => window.fixture.source()), source);

  // The saved config is valid even when terminal names cannot seed a usable
  // default deck. Discovery must reach the service before preview validation.
  await remount({ renameInput: true });
  assert.equal(await page.evaluate(() => window.fixture.defaults().inputId), '');
  const renamedSource = await page.evaluate(() => window.fixture.source());
  await complete();
  await assertPlot();
  await assertTiming(storedConfig.stop, storedConfig.step);
  assert.equal('config' in lookups.at(-1), false);
  assert.equal(
    await page.evaluate(() => window.fixture.context().config.inputId),
    storedConfig.inputId,
  );
  assert.match(
    await page.getByRole('combobox', { name: 'DC input', exact: true }).innerText(),
    /Supply/,
  );
  assert.equal(await page.getByRole('button', { name: 'Run', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.source()), renamedSource);
  assert.equal(runs, 0, 'Restoring a valid saved terminal selection does not run a new analysis.');

  storedConfig = null;
  const beforeLateGrant = lookups.length;
  await remount({ example: 'flybuck', fileId: null });
  await page.waitForFunction(() => window.fixture.context()?.status === 'idle');
  assert.equal(lookups.length, beforeLateGrant, 'Lookup waits for a project file grant.');
  await assertTiming(0.01, 0.0000002);
  await page.evaluate(() => window.fixture.setProbe(window.fixture.defaultProbe()));
  await page.waitForFunction(() => window.fixture.waveformsVisible());
  assert.match(await page.locator('.simulation-dock').innerText(), /Run the simulation to inspect/);
  await page.evaluate(() => window.fixture.setFileId('00000000-0000-4000-8000-000000000001'));
  await complete();
  await assertPlot();
  assert.equal(lookups.length, beforeLateGrant + 1);
  assert.equal(
    'config' in lookups.at(-1),
    false,
    'A pending probe does not implicitly edit settings.',
  );
  assert.doesNotMatch(
    await page.locator('.simulation-dock').innerText(),
    /Run the simulation to inspect/,
  );
  assert.equal(runs, 0, 'LM25017 restores when its grant arrives after opening and probing.');

  const beforeHiddenGrant = lookups.length;
  await remount({ example: 'flybuck', fileId: null, visible: false });
  await page.evaluate(() => window.fixture.setFileId('00000000-0000-4000-8000-000000000001'));
  await page.waitForTimeout(80);
  assert.equal(
    lookups.length,
    beforeHiddenGrant,
    'A late grant does not activate hidden simulation.',
  );
  await page.evaluate(() => window.fixture.setVisible(true));
  await complete();
  await assertPlot();
  await assertTiming(0.01, 0.0000002);
  assert.equal(lookups.length, beforeHiddenGrant + 1);

  // Saved samples can retain fewer probe aliases than the current deck. The
  // renderer binds every restored vector back to its current validated targets.
  legacyProbeMetadata = true;
  await remount({ example: 'flybuck' });
  await complete();
  await assertPlot();
  assert.ok(reboundProbe);
  const rebound = await page.evaluate(
    (vector) => window.fixture.context().result.traces.find((trace) => trace.vector === vector),
    reboundProbe.vector,
  );
  assert.deepEqual(rebound.targets, reboundProbe.targets);
  assert.equal(rebound.label, reboundProbe.label);
  await page.evaluate((target) => window.fixture.setProbe(target), reboundProbe.target);
  await page.waitForFunction(
    (vector) => window.fixture.context().selected.includes(vector),
    reboundProbe.vector,
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.context().probe), reboundProbe.target);
  assert.doesNotMatch(
    await page.locator('.simulation-dock').innerText(),
    /Run the simulation to inspect|No current trace/,
  );
  assert.equal(
    runs,
    0,
    'Restored LM25017 samples support current probe aliases without rerunning.',
  );
  legacyProbeMetadata = false;

  // Current saved-result responses must carry the complete run configuration.
  storedConfig = null;
  omitResponseConfig = true;
  await remount();
  await page
    .getByRole('alert')
    .filter({ hasText: 'The saved simulation settings are missing.' })
    .waitFor();
  const restoreAlert = page.locator('.simulation-settings-footer [role="alert"]');
  assert.equal(await restoreAlert.count(), 1, 'Restore errors stay in the settings footer.');
  const restoreAlertBox = await restoreAlert.boundingBox();
  const restoreRunBox = await page.getByRole('button', { name: 'Run', exact: true }).boundingBox();
  assert.ok(
    restoreAlertBox.y + restoreAlertBox.height <= restoreRunBox.y,
    'Restore errors wrap above Run in the fixed footer.',
  );
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  assert.equal(await page.locator('.simulation-dock').isVisible(), false);
  await assertTiming(defaults.stop, defaults.step);
  omitResponseConfig = false;

  storedConfig = { ...defaults, stop: 0.0073, step: 0.00000035 };
  hold = true;
  held.length = 0;
  await remount();
  const discovery = await waitForHeld(1);
  const delayed = await fixtureResponse(discovery.body, 100);
  await duration.fill('4.5');
  const edited = await waitForHeld(2);
  assert.ok(Math.abs(edited.body.config.stop - 0.0045) < 1e-15);
  await deliver(discovery, delayed);
  await deliver(edited, await cachedResponse(edited.body));
  await assertTiming(0.0045, defaults.step);
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  assert.equal(await page.locator('.simulation-dock').isVisible(), false);
  assert.equal(runs, 0, 'A late discovery cannot overwrite user input or start a run.');

  held.length = 0;
  await remount();
  const beforeAgent = await waitForHeld(1);
  const preAgentResponse = await fixtureResponse(beforeAgent.body, 100);
  await page.evaluate(() =>
    window.fixture.execute('simulation.configure', {
      config: { stop: 0.0061, step: 0.00000027 },
    }),
  );
  const afterAgent = await waitForHeld(2);
  assert.ok(Math.abs(afterAgent.body.config.stop - 0.0061) < 1e-15);
  assert.ok(Math.abs(afterAgent.body.config.step - 0.00000027) < 1e-15);
  await deliver(beforeAgent, preAgentResponse);
  await deliver(afterAgent, await cachedResponse(afterAgent.body));
  await assertTiming(0.0061, 0.00000027);
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  assert.equal(await page.evaluate(() => window.fixture.source()), source);
  assert.equal(runs, 0, 'Agent configuration also cancels discovery and uses exact lookup.');

  held.length = 0;
  await remount();
  const previousSource = await waitForHeld(1);
  const previousResponse = await fixtureResponse(previousSource.body, 100);
  await page.evaluate(() => window.fixture.change());
  const nextSource = await waitForHeld(2);
  assert.notEqual(previousSource.body.source, nextSource.body.source);
  await deliver(previousSource, previousResponse);
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  hold = false;
  await deliver(nextSource, await cachedResponse(nextSource.body));
  await complete();
  await assertPlot();

  held.length = 0;
  hold = true;
  await remount();
  const beforePending = await waitForHeld(1);
  const pendingResponse = await fixtureResponse(beforePending.body);
  await page.evaluate(() => window.fixture.setPending(true));
  await page.waitForFunction(() => window.fixture.context()?.status === 'blocked');
  const pendingLookups = lookups.length;
  await deliver(beforePending, pendingResponse);
  assert.equal(lookups.length, pendingLookups, 'Pending Source prevents result lookups.');
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  assert.equal(await page.locator('.simulation-dock').isVisible(), false);
  hold = false;
  await page.evaluate(() => window.fixture.setPending(false));
  await complete();
  await assertPlot();

  held.length = 0;
  hold = true;
  const beforeHidden = lookups.length;
  await remount({ visible: false });
  await page.waitForTimeout(80);
  assert.equal(lookups.length, beforeHidden, 'Hidden simulation does not look up saved results.');
  await page.evaluate(() => window.fixture.setVisible(true));
  const hiddenRequest = await waitForHeld(1);
  const hiddenResponse = await fixtureResponse(hiddenRequest.body);
  await page.evaluate(() => window.fixture.setVisible(false));
  await page.waitForFunction(() => !window.fixture.context()?.settingsVisible);
  await deliver(hiddenRequest, hiddenResponse);
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  hold = false;
  await page.evaluate(() => window.fixture.setVisible(true));
  await complete();
  await assertPlot();

  miss = true;
  await remount();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.fixture.context().result), null);
  assert.equal(await page.locator('.simulation-dock').isVisible(), false);
  assert.equal(runs, 0, 'A cache miss never starts a simulation.');
  held.length = 0;
  hold = true;
  await page.evaluate(() => window.fixture.change());
  const beforeRun = await waitForHeld(1);
  const oldResult = await fixtureResponse(beforeRun.body, 100);
  await assertLookupBlocksRun();
  await duration.fill('4.5');
  const editedBeforeRun = await waitForHeld(2);
  hold = false;
  await deliver(editedBeforeRun, { result: null });
  await page.waitForFunction(
    () => !document.querySelector('.simulation-settings-footer button').disabled,
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await complete();
  await deliver(beforeRun, oldResult);
  assert.equal(runs, 1);
  assert.equal(
    await page.evaluate(() => window.fixture.context().result.traces[0].statistics.first),
    9,
    'A late automatic result cannot replace an explicit run.',
  );
  assert.equal(
    await page.locator('.simulation-dock').isVisible(),
    false,
    'An explicit Run with no probe keeps the waveform dock closed.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: independent saved-result lookup, pending-lookup Run gates/loading message, visible saved waveforms/default probe, custom timing/terminal remount, LM25017 late grants/current probes, resident probes, incomplete-response rejection, user/Agent/source/hidden/Run races and cache-miss gates.',
  );
} finally {
  await browser.close();
}
