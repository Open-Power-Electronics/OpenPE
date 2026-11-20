// Isolated renderer + streaming HTTP fixture. No Electron, solver or provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
const { switchingStageFixture } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { buildSpiceDeck, defaultTransient } = await tsImport(
  '../plugins/spice-simulation/domain/spice.ts',
  import.meta.url,
);
const { simulationModelDefinitions } = await tsImport(
  '../lib/simulation-models.ts',
  import.meta.url,
);
const project = createProject(switchingStageFixture());
const source = serializeProject(project);
const deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
const target = project.schematic.parts.find((part) => part.ref === 'J3');
const sessions = [];
let detectionError = '';
const event = (res, value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
const server = createServer(async (req, res) => {
  if (req.url === '/api/simulation/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ available: !detectionError, version: 'fixture', error: detectionError }),
    );
  }
  if (req.url === '/api/simulation/transient') {
    assert.equal(req.headers.accept, 'text/event-stream');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(JSON.parse(body).source), JSON.parse(source));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const session = { res, closed: false };
    res.on('close', () => {
      session.closed = true;
    });
    sessions.push(session);
    event(res, { type: 'started' });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<div id="root"></div>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react'; import {createRoot} from 'react-dom/client';
    import SimulationDialog from './plugins/spice-simulation/renderer/SimulationDialog'; import {parseProject} from './lib/project';
    const project=parseProject(${JSON.stringify(source)});
    window.simulationModelStores=0;
    function Fixture(){const settings=useRef(null), waveforms=useRef(null), context=useRef(null); const [probe,setProbe]=useState(null); const [open,setOpen]=useState(false); const [visible,setVisible]=useState(true); const [pending,setPending]=useState(false);
      window.readSimulationContext=()=>context.current?.();
      return <><div className="fixture-controls"><button onClick={()=>setProbe({kind:'voltage',id:${JSON.stringify(target.id)},pin:0})}>Probe output</button>
        <button onClick={()=>setVisible(current=>!current)}>Toggle settings visibility</button>
        <button onClick={()=>setPending(current=>!current)}>Toggle pending Source</button></div>
        <div className="fixture-surface schematic-surface"><div className="schematic-drawing">
          <div className="fixture-canvas"/>
          <div ref={waveforms} className="simulation-host" style={{height:440}} hidden={!visible || !open}/>
        </div><div ref={settings} className="simulation-settings-host" hidden={!visible}/></div>
        <SimulationDialog project={project} settingsHost={settings} waveformHost={waveforms} visible={visible} sourcePending={pending}
          onParticipationChange={()=>true}
          probe={probe} onWaveformVisibilityChange={setOpen} agentContextRef={context}
          onStoreModels={()=>{window.simulationModelStores++;return true;}}/></>;}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
function samples(offset, end) {
  const time = Array.from({ length: end - offset }, (_, i) => ((offset + i) * deck.stop) / 800);
  return {
    type: 'samples',
    offset,
    time,
    values: deck.traces.map((trace) =>
      time.map((t) => (trace.unit === 'V' ? 10 : 1) * (1 - Math.exp(-t / 0.0002))),
    ),
  };
}
async function started(count) {
  const until = Date.now() + 5000;
  while (sessions.length < count && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sessions.length, count);
  return sessions.at(-1);
}
async function disconnected(session) {
  const until = Date.now() + 5000;
  while (!session.closed && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.closed, true, 'Cancellation disconnects the solver stream.');
}
try {
  await mkdir('test-results', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript((base) => {
    window.openpe = { connection: async () => ({ base, token: 'fixture' }) };
  }, base);
  await page.goto(base);
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      '#root {height:100vh;padding:16px;display:flex;flex-direction:column;gap:12px}.fixture-controls {display:flex;flex-wrap:wrap;gap:8px}.fixture-surface {display:flex;flex:1;min-width:0;min-height:0}.fixture-canvas {flex:1;min-height:120px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const settings = page.getByRole('region', { name: 'Simulation settings' });
  const dock = page.getByRole('region', { name: 'Simulation waveforms' });
  async function footerError(message) {
    const alert = settings.getByRole('alert').filter({ hasText: message });
    await alert.waitFor();
    assert.equal(await settings.locator('.simulation-settings-footer [role="alert"]').count(), 1);
    const alertBox = await alert.boundingBox();
    const runBox = await button('Run').boundingBox();
    assert.ok(
      alertBox.y + alertBox.height <= runBox.y,
      'Simulation errors wrap above Run in the fixed footer.',
    );
    assert.equal(
      await dock.getByRole('alert').count(),
      0,
      'The waveform dock does not repeat setup or solver errors.',
    );
  }
  await settings.waitFor();
  const participation = settings.getByRole('switch').first();
  assert.equal(await participation.isEnabled(), true);
  await button('Probe output').click();
  await dock.waitFor();
  await button('Run').click();
  const first = await started(1);
  assert.equal(await participation.isDisabled(), true, 'Running blocks participation edits.');
  event(first.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  assert.equal(
    await button('Stop').isVisible(),
    true,
    'The waveform is already drawn while the solver response remains open.',
  );
  assert.match(await dock.getByRole('status').first().innerText(), /Live/);
  const a = dock.getByRole('slider', { name: /cursor A$/ });
  const b = dock.getByRole('slider', { name: /cursor B$/ });
  const display = async () => ({
    path: await dock.locator('.simulation-trace').getAttribute('d'),
    view: await dock
      .locator('.simulation-waveform > svg')
      .evaluate((svg) =>
        ['data-time-min', 'data-time-max', 'data-value-min', 'data-value-max'].map((key) =>
          svg.getAttribute(key),
        ),
      ),
    cursorA: await a.getAttribute('aria-valuenow'),
    cursorB: await b.getAttribute('aria-valuenow'),
  });
  assert.equal(await a.count(), 1, 'Live plots start with the first cursor.');
  assert.equal(await b.count(), 0, 'The second cursor starts hidden.');
  assert.equal(Number(await a.getAttribute('aria-valuenow')), deck.stop / 4);
  event(first.res, samples(201, 301));
  await page.waitForFunction(
    (time) =>
      document.querySelector('[aria-label$="cursor A"]')?.getAttribute('aria-valuenow') ===
      String(time),
    (deck.stop * 3) / 8,
  );
  const following = await page.evaluate(() => window.readSimulationContext());
  assert.equal(
    following.result.traces.find((trace) => trace.selected).visibleWindow.cursors[0].time,
    (deck.stop * 3) / 8,
    'Agent observations match the first cursor following the latest sample.',
  );
  await button('Add second cursor').click();
  assert.equal(await b.getAttribute('aria-valuenow'), '0');
  await a.press('End');
  const chosen = await a.getAttribute('aria-valuenow');
  event(first.res, samples(301, 401));
  await page.waitForFunction(() => window.readSimulationContext()?.result?.sampleCount === 401);
  assert.equal(
    await a.getAttribute('aria-valuenow'),
    chosen,
    'Live updates preserve a manually positioned cursor.',
  );
  assert.equal(
    Number(await b.getAttribute('aria-valuenow')),
    0,
    'The second cursor stays at time zero as new samples arrive.',
  );
  await page.screenshot({ path: 'test-results/simulation-live-progress.png' });
  event(first.res, { type: 'retry' });
  await page.waitForFunction(() => !window.readSimulationContext()?.result);
  assert.equal(
    await dock.locator('.simulation-trace').count(),
    0,
    'Retry discards the failed attempt preview.',
  );
  event(first.res, samples(0, 401));
  await page.waitForFunction(() => window.readSimulationContext()?.result?.sampleCount === 401);
  // The newly mounted plot measures its viewport through ResizeObserver.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await settings.getByRole('alert').count(),
    0,
    'Retry accepts new samples from offset zero.',
  );
  const partialDisplay = await display();
  await button('Stop').click();
  await button('Run').waitFor();
  assert.equal(await participation.isEnabled(), true, 'Stop restores participation editing.');
  await dock.getByText('Stopped · Partial results', { exact: true }).waitFor();
  await disconnected(first);
  assert.deepEqual(
    await display(),
    partialDisplay,
    'Stop preserves the streamed curve, requested-duration axes and cursor positions.',
  );
  const stopped = await page.evaluate(() => window.readSimulationContext());
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.result.status, 'partial', 'A user-stopped preview is never completed.');
  assert.equal(stopped.result.sampleCount, 401);
  assert.deepEqual(stopped.result.timeRange, [0, deck.stop / 2]);
  assert.deepEqual(stopped.errors, [], 'Stop is a normal action, without a cancellation error.');
  assert.equal(await page.evaluate(() => window.simulationModelStores), 0);
  assert.equal(await settings.getByRole('alert').count(), 0);
  assert.equal(await dock.getByText('Live · Running…', { exact: true }).count(), 0);
  const duration = settings.getByLabel('Duration (ms)', { exact: true });
  const originalDuration = await duration.inputValue();
  await duration.fill(String((deck.stop * 2) / 0.001));
  assert.deepEqual(
    await display(),
    partialDisplay,
    'Setup duration edits preserve stopped samples, their original axes and cursors.',
  );
  const reconfigured = await page.evaluate(() => window.readSimulationContext());
  assert.equal(reconfigured.status, 'stopped');
  assert.equal(reconfigured.result.status, 'partial');
  assert.equal(reconfigured.config.stop, deck.stop * 2);
  assert.equal(reconfigured.resultConfig.stop, deck.stop);
  await button('Toggle settings visibility').click();
  await settings.waitFor({ state: 'hidden' });
  await dock.waitFor({ state: 'hidden' });
  const hiddenPartial = await page.evaluate(() => window.readSimulationContext());
  assert.equal(hiddenPartial.status, 'stopped');
  assert.equal(hiddenPartial.settingsVisible, false);
  assert.equal(hiddenPartial.waveformsVisible, false);
  assert.deepEqual(hiddenPartial.result, reconfigured.result);
  await button('Toggle settings visibility').click();
  await settings.waitFor();
  await dock.waitFor();
  assert.deepEqual(
    await display(),
    partialDisplay,
    'Reopening settings restores the stopped curve, axes and cursor positions.',
  );
  await duration.fill(originalDuration);
  assert.equal(sessions.length, 1, 'Editing or reopening a stopped result never starts a run.');
  await button('Run').click();
  const second = await started(2);
  assert.equal(
    await dock.locator('.simulation-trace').count(),
    0,
    'Run clears the stopped partial curve before new samples arrive.',
  );
  assert.equal(await dock.getByText('Stopped · Partial results', { exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.readSimulationContext())).result, null);
  event(second.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  second.res.end(
    `data: ${JSON.stringify({ type: 'error', message: 'Fixture solver failed.' })}\n\n`,
  );
  await footerError('Fixture solver failed.');
  assert.equal(
    await dock.locator('.simulation-trace').count(),
    0,
    'Failed previews are discarded.',
  );
  await button('Run').click();
  const third = await started(3);
  event(third.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  third.res.end();
  await footerError('disconnected before completion');
  assert.equal(
    await dock.locator('.simulation-trace').count(),
    0,
    'EOF cannot promote a preview to a result.',
  );
  await button('Run').click();
  const fourth = await started(4);
  event(fourth.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  const data = samples(0, 801);
  event(fourth.res, {
    type: 'result',
    result: {
      version: 'fixture',
      log: 'fixture',
      time: data.time,
      traces: deck.traces.map((trace, i) => ({ ...trace, values: data.values[i] })),
      simulationModels: [simulationModelDefinitions[0]],
    },
  });
  fourth.res.end();
  await button('Run').waitFor();
  assert.equal(await dock.locator('.simulation-trace').count(), 1);
  assert.equal(await dock.getByText('Live · Running…', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.simulationModelStores), 1);
  assert.equal(
    (await page.evaluate(() => window.readSimulationContext())).result.status,
    'completed',
  );
  const range = dock.getByRole('combobox', { name: / time range$/ });
  await range.click();
  await page.getByRole('option', { name: 'Last 10 cycles', exact: true }).click();
  await a.press('Home');
  await b.press('End');
  const completedDisplay = await display();
  for (const [label, value] of [
    ['Duration (ms)', '4'],
    ['Max. time step (µs)', '0.2'],
    ['PWM frequency (kHz)', '50'],
  ]) {
    await settings.getByLabel(label, { exact: true }).fill(value);
    assert.deepEqual(
      await display(),
      completedDisplay,
      'Setup edits preserve completed samples, the last-cycle view and cursor positions.',
    );
  }
  await settings.getByLabel('Duration (ms)', { exact: true }).fill('invalid');
  await footerError('Duration must be a finite number greater than 0 ms.');
  assert.equal(await button('Run').isDisabled(), true);
  assert.deepEqual(
    await display(),
    completedDisplay,
    'Invalid timing leaves prior waveforms visible.',
  );
  assert.equal(sessions.length, 4, 'Setup edits do not start another run.');
  await settings.getByLabel('Duration (ms)', { exact: true }).fill('4');
  await button('Run').click();
  const fifth = await started(5);
  assert.equal(
    await dock.locator('.simulation-trace').count(),
    0,
    'Run clears the previous waveforms before new samples arrive.',
  );
  event(fifth.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  fifth.res.end(
    `data: ${JSON.stringify({ type: 'error', message: 'The retry could not converge. Check the circuit and timing, then try again.' })}\n\n`,
  );
  await footerError('The retry could not converge.');
  assert.equal(await dock.locator('.simulation-trace').count(), 0);
  await button('Run').click();
  const sixth = await started(6);
  event(sixth.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  await button('Toggle pending Source').click();
  await disconnected(sixth);
  await button('Run').waitFor();
  assert.equal(
    await participation.isDisabled(),
    true,
    'Pending Source blocks participation edits.',
  );
  await dock.waitFor({ state: 'detached' });
  const invalidated = await page.evaluate(() => window.readSimulationContext());
  assert.equal(invalidated.status, 'blocked');
  assert.equal(invalidated.result, null, 'Source invalidation still discards partial samples.');
  assert.equal(await page.evaluate(() => window.simulationModelStores), 1);
  await button('Toggle pending Source').click();
  await button('Run').click();
  const seventh = await started(7);
  await button('Stop').click();
  await button('Run').waitFor();
  await disconnected(seventh);
  const emptyStop = await page.evaluate(() => window.readSimulationContext());
  assert.equal(emptyStop.status, 'stopped');
  assert.equal(emptyStop.result, null, 'Stop before the first packet creates no result.');
  assert.deepEqual(emptyStop.errors, [], 'Stop before samples is a normal action.');
  assert.equal(await settings.getByRole('alert').count(), 0);
  assert.equal(await page.evaluate(() => window.simulationModelStores), 1);
  await button('Probe output').click();
  await dock.waitFor();
  assert.equal(await dock.locator('.simulation-trace').count(), 0);
  assert.equal(
    await dock.getByText('Stopped · Partial results', { exact: true }).count(),
    0,
    'Stopping without samples never exposes partial results.',
  );
  await dock.getByText('Stopped', { exact: true }).waitFor();
  await button('Run').click();
  const eighth = await started(8);
  event(eighth.res, samples(0, 201));
  await dock.locator('.simulation-trace').waitFor();
  await button('Toggle settings visibility').click();
  await disconnected(eighth);
  await page.waitForFunction(() => {
    const context = window.readSimulationContext();
    return context.status !== 'running' && context.result === null;
  });
  await button('Toggle settings visibility').click();
  await settings.waitFor();
  await dock.waitFor();
  await button('Run').waitFor();
  await footerError('Simulation cancelled.');
  assert.equal(
    await dock.locator('.simulation-trace').count(),
    0,
    'Hiding settings during a live run discards its streamed preview.',
  );
  assert.equal(await dock.getByText('Stopped · Partial results', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.simulationModelStores), 1);
  await button('Toggle settings visibility').click();
  detectionError = 'The bundled solver is unavailable. Repair the installation and try again.';
  await button('Toggle settings visibility').click();
  await footerError(detectionError);
  assert.equal(await button('Run').isDisabled(), true, 'Solver detection failures disable Run.');
  assert.deepEqual(errors, []);
  console.log(
    'Live simulation renderer: incremental plots, cursor intent, Stop partial-result retention through setup edits and reopening, Stop before samples, Run replacement, Source/visibility cancellation, solver failure, unexpected EOF, completed-result retention through setup edits and footer errors passed.',
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
