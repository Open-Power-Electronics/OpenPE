import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Isolated presentation checks: no Electron, provider, service or solver.
const bundle = await build({
  stdin: {
    contents: `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import Waveforms from './components/SimulationWaveforms';
      import {createCapabilityHost} from './api/capabilities';
      const host = createCapabilityHost();
      window.waveformCapabilities = host;
      const time = Array.from({length: 101}, (_, i) => i / 10000);
      const result = {time, version: 'fixture', log: 'Private solver fixture log',
        traces: Array.from({length: 6}, (_, n) => ({vector: 'v' + n,
          label: n === 4 ? 'I(V102) · into source' : 'V(net_' + n + ')', unit: n === 4 ? 'A' : 'V',
          values: time.map(t => Math.sin(t * 1000 + n) * (n === 4 ? 0.001 : 1))}))};
      function App() {
        const presentation = React.useRef(null);
        const [selected, setSelected] = useState(result.traces.map(t => t.vector));
        const [currentResult, setCurrentResult] = useState(result);
        React.useEffect(() => { window.resetWaveformResult = () => setCurrentResult({...result, time: result.time.map(t => t / 2)}); }, []);
        return <Waveforms visible result={currentResult} selected={selected} onSelected={setSelected}
          capabilityHost={host} presentationRef={presentation}
          frequency={2000} running={false} message=""/>;
      }
      createRoot(document.getElementById('root')).render(<App/>);`,
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
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root" style="display:flex;width:1100px;height:700px"></div>');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const plots = page.locator('.simulation-plots');
  await plots.waitFor();
  assert.equal(await page.getByText('Solver log', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Private solver fixture log').count(), 0);
  assert.equal(await page.getByText(/samples/).count(), 0);
  assert.equal(await page.locator('input[type="range"], .simulation-cursor-bar').count(), 0);
  const controls = page.getByRole('group', { name: 'Waveform controls' });
  assert.equal(await controls.getByRole('combobox').count(), 2);
  for (const control of await controls.locator('button').all()) {
    assert.equal(await control.innerText(), '');
    const box = await control.boundingBox();
    assert.equal(box.width, 30);
    assert.equal(box.height, 30);
    const name = await control.getAttribute('aria-label');
    assert.ok(name);
    assert.equal(
      await control.getAttribute('title'),
      name === 'Link waveform cursors' ? 'Link cursors' : name,
      'Icon-only waveform controls use concise names without selected-state details.',
    );
  }
  async function layout(name) {
    await page.getByRole('combobox', { name: 'Waveform layout', exact: true }).click();
    await page.getByRole('gridcell', { name, exact: true }).click();
  }
  async function fillsArea(full = true) {
    await page.waitForFunction((full) => {
      const plots = document.querySelector('.simulation-plots');
      const rows = [...plots.querySelectorAll('.simulation-plot-row')];
      const bounds = plots.getBoundingClientRect();
      return (
        Math.abs(rows.at(-1).getBoundingClientRect().bottom - bounds.bottom) < 2 &&
        (!full ||
          rows.every(
            (row) =>
              Math.abs(row.lastElementChild.getBoundingClientRect().right - bounds.right) < 2,
          ))
      );
    }, full);
    assert.equal(
      await plots.evaluate(
        (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      ),
      false,
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.simulation-waveform > svg')].every((svg) => {
        const box = svg.getBoundingClientRect();
        return box.width > 100 && box.height > 80;
      }),
    );
  }
  const picker = page.getByRole('combobox', { name: 'Waveform layout', exact: true });
  await picker.click();
  await page.getByRole('gridcell', { name: '3 columns × 2 rows', exact: true }).hover();
  assert.equal(await page.locator('.waveform-layout-cell.highlighted').count(), 6);
  // Hover previews the rectangle without committing the chart layout.
  assert.equal(await picker.getAttribute('aria-description'), 'Waveform layout: Auto');
  await picker.press('Escape');
  assert.equal(await page.getByRole('grid').count(), 0);
  assert.equal(await picker.evaluate((el) => el === document.activeElement), true);
  await layout('3 columns × 2 rows');
  assert.equal(await page.locator('.simulation-plot-row').count(), 2);
  await fillsArea();
  for (const plot of await page.locator('.simulation-waveform > svg').all()) {
    assert.ok((await plot.locator('.simulation-grid-minor.simulation-grid-time').count()) > 0);
    assert.ok((await plot.locator('.simulation-grid-minor.simulation-grid-value').count()) > 0);
    assert.equal(
      await plot.locator('text.simulation-tick-time').count(),
      await plot.locator('.simulation-grid-minor.simulation-grid-time').count(),
    );
    assert.equal(
      await plot.locator('text.simulation-tick-value').count(),
      await plot.locator('.simulation-grid-minor.simulation-grid-value').count(),
    );
  }
  const zoomMode = page.getByRole('button', { name: 'Zoom V(net_0) region', exact: true });
  for (const [name, hint] of [
    ['Zoom in V(net_0)', 'Zoom in'],
    ['Zoom out V(net_0)', 'Zoom out'],
    ['Remove V(net_0)', 'Remove waveform'],
    ['Zoom V(net_0) region', 'Zoom region'],
    ['Previous V(net_0) view', 'Previous view'],
    ['Next V(net_0) view', 'Next view'],
    ['Auto scale V(net_0)', 'Auto scale'],
  ])
    assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('title'), hint);
  assert.equal(
    await page
      .getByRole('combobox', { name: 'V(net_0) time range', exact: true })
      .getAttribute('title'),
    'Time range',
  );
  await zoomMode.click();
  const cursor = page.getByRole('slider', { name: 'V(net_0) cursor A' });
  const cursorB = page.getByRole('slider', { name: 'V(net_0) cursor B' });
  const chart = page.getByRole('group', { name: 'V(net_0) waveform', exact: true });
  assert.equal(await controls.getByRole('button', { name: 'Cursor A', exact: true }).count(), 0);
  assert.equal(await controls.locator('.simulation-cursor-toggle').count(), 1);
  const toggleB = controls.getByRole('button', { name: /^(Add|Remove) second cursor$/ });
  assert.equal(await toggleB.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.getByRole('slider', { name: /cursor A$/ }).count(), 6);
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.01');
  assert.equal(await page.getByRole('slider', { name: /cursor B$/ }).count(), 0);
  await chart.click({ position: { x: 100, y: 50 } });
  assert.equal(
    await page.getByRole('slider').count(),
    6,
    'Background dragging cannot create a second cursor.',
  );
  await zoomMode.click();
  await chart.click({ position: { x: 100, y: 50 } });
  assert.equal(
    await page.getByRole('slider').count(),
    6,
    'A zoom-mode click cannot create a second cursor.',
  );
  await zoomMode.click();
  await toggleB.press('Enter');
  assert.equal(await toggleB.getAttribute('aria-label'), 'Remove second cursor');
  assert.equal(await toggleB.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('slider', { name: /cursor A$/ }).count(), 6);
  assert.equal(await page.getByRole('slider', { name: /cursor B$/ }).count(), 6);
  for (const secondCursor of await page.getByRole('slider', { name: /cursor B$/ }).all())
    assert.equal(await secondCursor.getAttribute('aria-valuenow'), '0');
  await cursor.press('End');
  await cursorB.press('Home');
  await cursorB.press('ArrowRight');
  await toggleB.press('Space');
  assert.equal(await toggleB.getAttribute('aria-label'), 'Add second cursor');
  assert.equal(await toggleB.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.getByRole('slider', { name: /cursor A$/ }).count(), 6);
  assert.equal(await page.getByRole('slider', { name: /cursor B$/ }).count(), 0);
  assert.equal(
    await cursor.getAttribute('aria-valuenow'),
    '0.01',
    'Removing the second cursor preserves the first cursor.',
  );
  await toggleB.click();
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.0001');
  await cursorB.press('End');
  await cursor.press('Home');
  assert.equal(
    await page.locator('.simulation-trace-heading strong').nth(4).innerText(),
    'I(V102)',
  );
  assert.equal(
    await page.locator('.simulation-trace-heading strong').nth(4).getAttribute('aria-description'),
    'I(V102) · into source',
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.simulation-waveform')].every((wave) => {
      const heading = wave
        .querySelector('.simulation-trace-heading strong')
        .getBoundingClientRect();
      const bounds = wave.getBoundingClientRect();
      return Math.abs((heading.left + heading.right) / 2 - (bounds.left + bounds.right) / 2) < 1;
    }),
  );
  const valueLabel = cursor.locator('.simulation-cursor-value');
  const firstValue = await valueLabel.textContent();
  async function valuesWithinPlots() {
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.simulation-waveform > svg')].every((svg) => {
        const bounds = svg.getBoundingClientRect();
        const values = [...svg.querySelectorAll('.simulation-cursor-value')].map((value) =>
          value.getBoundingClientRect(),
        );
        return values.every(
          (value) =>
            value.left >= bounds.left && value.right <= bounds.right && value.top >= bounds.top,
        );
      }),
    );
  }
  await valuesWithinPlots();
  await cursor.focus();
  await cursor.press('End');
  assert.notEqual(await valueLabel.textContent(), firstValue);
  await valuesWithinPlots();
  await layout('2 columns × 3 rows');
  assert.equal(await page.locator('.simulation-plot-row').count(), 3);
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.01');
  await cursor.press('ArrowLeft');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.0099');
  for (const plot of await page.getByRole('slider', { name: /cursor A$/ }).all())
    assert.equal(await plot.getAttribute('aria-valuenow'), '0.0099');
  await cursor.press('Home');
  const hit = cursor.locator('.simulation-cursor-hit');
  await hit.hover();
  assert.equal(await hit.evaluate((el) => getComputedStyle(el).cursor), 'ew-resize');
  const bounds = await chart.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  assert.equal(await chart.evaluate((el) => getComputedStyle(el).cursor), 'crosshair');
  await page.mouse.down();
  assert.equal(await chart.evaluate((el) => getComputedStyle(el).cursor), 'ew-resize');
  const cursorPosition = await cursor.locator('.simulation-cursor-hit').getAttribute('x');
  assert.ok(
    Math.abs(Number(await valueLabel.getAttribute('x')) - (Number(cursorPosition) + 8)) < 1,
  );
  await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + 30);
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.01');
  await page.mouse.up();
  assert.equal(await chart.evaluate((el) => getComputedStyle(el).cursor), 'crosshair');
  await page.mouse.move(bounds.x + 80, bounds.y + 30);
  await page.mouse.down();
  await chart.dispatchEvent('pointercancel', { pointerId: 1 });
  assert.equal(await chart.evaluate((el) => getComputedStyle(el).cursor), 'crosshair');
  await page.mouse.up();
  const beforeB = await cursor.getAttribute('aria-valuenow');
  await cursorB.press('Home');
  await cursorB.press('ArrowRight');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.0001');
  assert.equal(await cursor.getAttribute('aria-valuenow'), beforeB);
  for (const other of await page.getByRole('slider', { name: /cursor B$/ }).all())
    assert.equal(await other.getAttribute('aria-valuenow'), '0.0001');
  // Drag B through A and beyond the plot; identities and the untouched cursor stay stable.
  await cursorB.locator('.simulation-cursor-hit').hover();
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + 90);
  await page.mouse.up();
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.01');
  assert.equal(await cursor.getAttribute('aria-valuenow'), beforeB);
  // Overlapping cursors can still be separated with independent keyboard controls.
  await cursor.press('End');
  await valuesWithinPlots();
  await cursor.press('Home');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.01');
  const labelA = await cursor.locator('.simulation-cursor-value').boundingBox();
  await page.mouse.move(labelA.x + labelA.width / 2, labelA.y + labelA.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 100, labelA.y + labelA.height / 2);
  await page.mouse.up();
  assert.ok(Number(await cursor.getAttribute('aria-valuenow')) < 0.005);
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.01');
  const beforeRange = await cursor.getAttribute('aria-valuenow');
  const range = page.getByRole('combobox', { name: 'V(net_0) time range', exact: true });
  await range.click();
  await page.getByRole('option', { name: 'Last 10 cycles', exact: true }).click();
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.005');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.01');
  await range.click();
  await page.getByRole('option', { name: 'Full duration', exact: true }).click();
  assert.equal(await cursor.getAttribute('aria-valuenow'), beforeRange);
  await fillsArea();
  await page.getByRole('button', { name: 'Remove V(net_5)', exact: true }).click();
  await fillsArea(false);
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.01');
  assert.equal(
    await page.locator('.simulation-plot-row').last().locator('.simulation-plot').count(),
    1,
  );
  await layout('4 columns × 1 row');
  assert.equal(await page.locator('.simulation-plot-row').count(), 2);
  await fillsArea(false);
  await cursor.press('Home');
  await valuesWithinPlots();
  await cursor.press('End');
  await valuesWithinPlots();
  await layout('1 column × 3 rows');
  await page.locator('#root').evaluate((el) => {
    el.style.height = '600px';
  });
  assert.equal(await page.locator('.simulation-plot-row').count(), 5);
  // Small areas scroll rather than clip axes or remove traces.
  assert.equal(await plots.evaluate((el) => el.scrollHeight > el.clientHeight), true);
  await layout('Auto');
  await picker.press('ArrowDown');
  await picker.press('ArrowDown');
  await picker.press('ArrowRight');
  await picker.press('ArrowDown');
  await picker.press('Enter');
  assert.equal(
    await picker.getAttribute('aria-description'),
    'Waveform layout: 2 columns × 2 rows',
  );
  assert.equal(await page.locator('.simulation-plot-row').count(), 3);
  await picker.click();
  await picker.press('Home');
  await picker.press('Enter');
  assert.equal(await picker.getAttribute('aria-description'), 'Waveform layout: Auto');
  await picker.click();
  await page.locator('.simulation-dock-header > strong').click();
  assert.equal(await page.getByRole('grid').count(), 0);
  await page.locator('#root').evaluate((el) => {
    el.style.width = '1100px';
    el.style.height = '500px';
  });
  await fillsArea();
  const wideRows = await page.locator('.simulation-plot-row').count();
  await page.locator('#root').evaluate((el) => {
    el.style.width = '500px';
    el.style.height = '850px';
  });
  await fillsArea();
  await page.waitForFunction(
    (count) => document.querySelectorAll('.simulation-plot-row').length > count,
    wideRows,
  );
  await page.locator('#root').evaluate((el) => {
    el.style.width = '1100px';
    el.style.height = '700px';
  });
  await layout('3 columns × 2 rows');
  await fillsArea(false);
  const link = page.getByRole('button', { name: 'Link waveform cursors', exact: true });
  assert.equal(await page.locator('.simulation-link').count(), 1);
  assert.equal(await page.locator('.simulation-result-controls .simulation-link').count(), 1);
  assert.equal(await page.locator('.simulation-plot-tools .simulation-link').count(), 0);
  const otherA = page.getByRole('slider', { name: 'V(net_1) cursor A' });
  const otherB = page.getByRole('slider', { name: 'V(net_1) cursor B' });
  const thirdB = page.getByRole('slider', { name: 'V(net_2) cursor B' });
  assert.equal(await link.getAttribute('aria-pressed'), 'true');
  const sharedA = await otherA.getAttribute('aria-valuenow');
  const sharedB = await otherB.getAttribute('aria-valuenow');
  await link.click();
  assert.equal(await link.getAttribute('aria-pressed'), 'false');
  assert.equal(await cursor.getAttribute('aria-valuenow'), sharedA);
  await cursor.press('Home');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0');
  assert.equal(await otherA.getAttribute('aria-valuenow'), sharedA);
  await otherB.press('Home');
  assert.equal(await otherB.getAttribute('aria-valuenow'), '0');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), sharedB);
  assert.equal(
    await thirdB.getAttribute('aria-valuenow'),
    sharedB,
    'The global switch unlinks every waveform.',
  );
  await layout('2 columns × 3 rows');
  assert.equal(await link.getAttribute('aria-pressed'), 'false');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0');
  assert.equal(await otherA.getAttribute('aria-valuenow'), sharedA);
  assert.equal(await otherB.getAttribute('aria-valuenow'), '0');
  await layout('3 columns × 2 rows');
  await chart.click({ position: { x: 180, y: 100 } });
  assert.ok(Number(await cursor.getAttribute('aria-valuenow')) > 0);
  assert.equal(await otherA.getAttribute('aria-valuenow'), sharedA);
  assert.equal(await otherB.getAttribute('aria-valuenow'), '0');
  const lastA = await cursor.getAttribute('aria-valuenow');
  const lastB = await cursorB.getAttribute('aria-valuenow');
  await link.press('Enter');
  assert.equal(await link.getAttribute('aria-pressed'), 'true');
  for (const slider of await page.getByRole('slider', { name: /cursor A$/ }).all())
    assert.equal(
      await slider.getAttribute('aria-valuenow'),
      lastA,
      'Relinking adopts the most recently adjusted waveform.',
    );
  for (const slider of await page.getByRole('slider', { name: /cursor B$/ }).all())
    assert.equal(await slider.getAttribute('aria-valuenow'), lastB);
  await otherB.press('Home');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0');
  assert.equal(await thirdB.getAttribute('aria-valuenow'), '0');
  await link.click();
  await cursorB.press('End');
  assert.equal(await otherB.getAttribute('aria-valuenow'), '0');
  assert.equal(await thirdB.getAttribute('aria-valuenow'), '0');
  await link.click();
  assert.equal(
    await otherB.getAttribute('aria-valuenow'),
    await cursorB.getAttribute('aria-valuenow'),
  );
  await mkdir('test-results', { recursive: true });
  await picker.click();
  await page.getByRole('gridcell', { name: '3 columns × 2 rows', exact: true }).hover();
  await page.screenshot({ path: 'test-results/waveform-layout.png' });
  await picker.press('Escape');
  await chart.click({ position: { x: 180, y: 100 } });
  await valuesWithinPlots();
  await page.screenshot({ path: 'test-results/waveform-cursors.png' });
  await zoomMode.click();
  await cursor.press('Home');
  await cursorB.press('End');
  const previousView = page.getByRole('button', { name: 'Previous V(net_0) view' });
  const nextView = page.getByRole('button', { name: 'Next V(net_0) view' });
  const autoScale = page.getByRole('button', { name: 'Auto scale V(net_0)' });
  const zoomIn = page.getByRole('button', { name: 'Zoom in V(net_0)', exact: true });
  const zoomOut = page.getByRole('button', { name: 'Zoom out V(net_0)', exact: true });
  const valueSpan =
    Number(await chart.getAttribute('data-value-max')) -
    Number(await chart.getAttribute('data-value-min'));
  await zoomIn.click();
  assert.equal(Number(await chart.getAttribute('data-time-min')), 0.0025);
  assert.equal(Number(await chart.getAttribute('data-time-max')), 0.0075);
  assert.ok(
    Math.abs(
      Number(await chart.getAttribute('data-value-max')) -
        Number(await chart.getAttribute('data-value-min')) -
        valueSpan / 2,
    ) < 1e-10,
    'Zoom in scales the vertical axis too.',
  );
  await previousView.click();
  assert.equal(await chart.getAttribute('data-time-min'), '0');
  await nextView.click();
  assert.equal(Number(await chart.getAttribute('data-time-min')), 0.0025);
  await zoomOut.click();
  assert.equal(await chart.getAttribute('data-time-min'), '0');
  assert.equal(await chart.getAttribute('data-time-max'), '0.01');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.01');
  for (const svg of (await page.locator('.simulation-waveform > svg').all()).slice(1)) {
    assert.equal(await svg.getAttribute('data-time-min'), '0');
    assert.equal(await svg.getAttribute('data-time-max'), '0.01');
  }
  await autoScale.click();
  await zoomIn.click();
  const panStart = {
    time: Number(await chart.getAttribute('data-time-min')),
    value: Number(await chart.getAttribute('data-value-min')),
  };
  async function panPlot(end = 'commit') {
    const box = await chart.boundingBox();
    const area = await chart.locator('clipPath rect').evaluate((el) => ({
      x: +el.getAttribute('x'),
      y: +el.getAttribute('y'),
      width: +el.getAttribute('width'),
      height: +el.getAttribute('height'),
    }));
    await page.mouse.move(box.x + area.x + area.width * 0.4, box.y + area.y + area.height * 0.4);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + area.x + area.width * 0.5, box.y + area.y + area.height * 0.5, {
      steps: 5,
    });
    assert.equal(await chart.evaluate((el) => getComputedStyle(el).cursor), 'grabbing');
    assert.ok(Number(await chart.getAttribute('data-time-min')) < panStart.time);
    assert.ok(Number(await chart.getAttribute('data-value-min')) > panStart.value);
    if (end === 'escape') await page.keyboard.press('Escape');
    if (end === 'cancel') await chart.dispatchEvent('pointercancel', { pointerId: 1 });
    if (end === 'lost') await chart.dispatchEvent('lostpointercapture', { pointerId: 1 });
    await page.mouse.up({ button: 'right' });
    assert.equal(await chart.evaluate((el) => getComputedStyle(el).cursor), 'crosshair');
  }
  for (const end of ['escape', 'cancel', 'lost']) {
    await panPlot(end);
    assert.equal(Number(await chart.getAttribute('data-time-min')), panStart.time);
    assert.equal(Number(await chart.getAttribute('data-value-min')), panStart.value);
  }
  await panPlot();
  const pannedMin = Number(await chart.getAttribute('data-time-min'));
  assert.ok(
    Math.abs(Number(await chart.getAttribute('data-time-max')) - pannedMin - 0.005) < 1e-10,
  );
  await previousView.click();
  assert.equal(
    Number(await chart.getAttribute('data-time-min')),
    panStart.time,
    'One undo restores the entire pan.',
  );
  assert.equal(Number(await chart.getAttribute('data-value-min')), panStart.value);
  await nextView.click();
  assert.equal(Number(await chart.getAttribute('data-time-min')), pannedMin);
  for (const svg of (await page.locator('.simulation-waveform > svg').all()).slice(1))
    assert.equal(await svg.getAttribute('data-time-min'), '0');
  await autoScale.click();
  assert.equal(
    await page.locator('.simulation-plot-tools').count(),
    await page.locator('.simulation-plot').count(),
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Zoom V(net_1) region', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  async function zoomBox(cancel = false) {
    const box = await chart.boundingBox();
    const area = await chart.locator('clipPath rect').evaluate((el) => ({
      x: +el.getAttribute('x'),
      y: +el.getAttribute('y'),
      width: +el.getAttribute('width'),
      height: +el.getAttribute('height'),
    }));
    await page.mouse.move(box.x + area.x + area.width * 0.2, box.y + area.y + area.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + area.x + area.width * 0.8, box.y + area.y + area.height * 0.75, {
      steps: 5,
    });
    assert.equal(await chart.locator('.simulation-zoom-region').count(), 1);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await zoomBox(true);
  assert.equal(await chart.getAttribute('data-time-min'), '0');
  assert.equal(await chart.getAttribute('data-time-max'), '0.01');
  await zoomBox();
  const zoomMin = Number(await chart.getAttribute('data-time-min'));
  const zoomMax = Number(await chart.getAttribute('data-time-max'));
  assert.ok(zoomMin > 0.0019 && zoomMax < 0.0081);
  for (const svg of (await page.locator('.simulation-waveform > svg').all()).slice(1)) {
    assert.equal(Number(await svg.getAttribute('data-time-min')), 0);
    assert.equal(Number(await svg.getAttribute('data-time-max')), 0.01);
  }
  const otherChart = page.getByRole('group', { name: 'V(net_1) waveform', exact: true });
  const otherPrevious = page.getByRole('button', { name: 'Previous V(net_1) view', exact: true });
  assert.equal(await otherPrevious.isDisabled(), true);
  await page
    .getByRole('button', { name: 'V(net_1) time axis', exact: true })
    .click({ button: 'right' });
  const otherTimeDialog = page.getByRole('dialog', { name: 'Time axis', exact: true });
  async function fillQuantity(input, value) {
    await input.focus();
    // Focus restores the complete draft before Playwright selects/replaces it.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await input.fill(value);
    assert.equal(await input.inputValue(), value);
  }
  await fillQuantity(otherTimeDialog.getByLabel('Minimum (s)', { exact: true }), '2m');
  await fillQuantity(otherTimeDialog.getByLabel('Maximum (s)', { exact: true }), '8m');
  await otherTimeDialog.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await otherChart.getAttribute('data-time-min'), '0.002');
  await layout('2 columns × 3 rows');
  assert.equal(Number(await chart.getAttribute('data-time-min')), zoomMin);
  assert.equal(await otherChart.getAttribute('data-time-min'), '0.002');
  await layout('3 columns × 2 rows');
  await previousView.click();
  assert.equal(await chart.getAttribute('data-time-min'), '0');
  assert.equal(await otherChart.getAttribute('data-time-min'), '0.002');
  await nextView.click();
  assert.equal(Number(await chart.getAttribute('data-time-min')), zoomMin);
  await page.getByRole('button', { name: 'Auto scale V(net_1)', exact: true }).click();
  assert.equal(await otherChart.getAttribute('data-time-min'), '0');
  assert.equal(Number(await chart.getAttribute('data-time-min')), zoomMin);
  await otherChart.press('Control+z');
  assert.equal(await otherChart.getAttribute('data-time-min'), '0.002');
  assert.equal(Number(await chart.getAttribute('data-time-min')), zoomMin);
  const timeAxisControl = page.getByRole('button', { name: 'V(net_0) time axis', exact: true });
  const axisBox = await timeAxisControl.boundingBox();
  await timeAxisControl.click({ position: { x: 35, y: 8 } });
  let axisDialog = page.getByRole('dialog', { name: 'Time axis', exact: true });
  assert.equal(await axisDialog.getAttribute('aria-modal'), 'false');
  assert.equal(await axisDialog.evaluate((el) => el.matches(':modal')), false);
  const editorBox = await axisDialog.boundingBox();
  const point = { x: axisBox.x + 35, y: axisBox.y + 8 };
  assert.ok(
    Math.abs(editorBox.x - point.x - 8) < 2,
    'Axis settings open beside the clicked tick instead of the chart corner.',
  );
  assert.ok(
    Math.min(
      Math.abs(editorBox.y - point.y - 8),
      Math.abs(editorBox.y + editorBox.height - point.y + 8),
    ) < 2,
  );
  assert.ok(editorBox.width <= 232 && editorBox.height < 240);
  const minimumInput = axisDialog.getByLabel('Minimum (s)', { exact: true });
  assert.match(await minimumInput.inputValue(), /^[\d.e+-]+$/i);
  const minimumUnit = axisDialog.getByRole('combobox', { name: 'Minimum (s) unit', exact: true });
  await minimumUnit.click();
  await page.getByRole('option', { name: 'µs', exact: true }).click();
  assert.ok(Math.abs(Number(await minimumInput.inputValue()) * 1e-6 - zoomMin) < 1e-7);
  assert.equal(
    Number(await chart.getAttribute('data-time-min')),
    zoomMin,
    'Changing the display unit does not apply an axis edit.',
  );
  assert.ok((await minimumInput.inputValue()).length < 16, 'Engineering values stay concise.');
  await page.screenshot({ path: 'test-results/waveform-axis-local.png' });
  for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
    await minimumInput.evaluate(
      (input, options) =>
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        ),
      options,
    );
    assert.equal(await axisDialog.count(), 1, 'IME Enter cannot apply axis drafts.');
  }
  await minimumInput.dispatchEvent('compositionstart');
  await minimumInput.press('Escape');
  assert.equal(await axisDialog.count(), 1, 'IME Escape cannot dismiss axis drafts.');
  await minimumInput.dispatchEvent('compositionend');
  await minimumInput.press('Enter');
  assert.equal(Number(await chart.getAttribute('data-time-min')), zoomMin);
  assert.equal(
    Number(await chart.getAttribute('data-time-max')),
    zoomMax,
    'Applying untouched short values preserves exact axis bounds.',
  );
  await timeAxisControl.press('Enter');
  await page.keyboard.press('Escape');
  assert.equal(await axisDialog.count(), 0);
  assert.equal(
    await page
      .getByRole('button', { name: 'V(net_0) time axis', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  // Another waveform remains clickable and opens its own editor in one click.
  await page.getByRole('button', { name: 'V(net_0) time axis', exact: true }).click();
  await page.getByRole('button', { name: 'V(net_1) vertical axis', exact: true }).click();
  assert.equal(await axisDialog.count(), 0);
  const otherDialog = page.getByRole('dialog', { name: 'V(net_1) axis', exact: true });
  await fillQuantity(otherDialog.getByLabel('Minimum (V)', { exact: true }), '123');
  await page.getByRole('button', { name: 'V(net_0) time axis', exact: true }).click();
  assert.equal(await otherDialog.count(), 0);
  assert.notEqual(await axisDialog.getByLabel('Minimum (s)', { exact: true }).inputValue(), '123');
  await fillQuantity(axisDialog.getByLabel('Minimum (s)', { exact: true }), '9m');
  await fillQuantity(axisDialog.getByLabel('Maximum (s)', { exact: true }), '1m');
  await axisDialog.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await axisDialog.getByRole('alert').count(), 1);
  assert.equal(Number(await chart.getAttribute('data-time-min')), zoomMin);
  await fillQuantity(axisDialog.getByLabel('Minimum (s)', { exact: true }), '1m');
  await fillQuantity(axisDialog.getByLabel('Maximum (s)', { exact: true }), '9m');
  await fillQuantity(axisDialog.getByLabel('Tick spacing (s)', { exact: true }), '2m');
  await axisDialog.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await chart.getAttribute('data-time-min'), '0.001');
  assert.equal(await chart.getAttribute('data-time-max'), '0.009');
  assert.equal(
    await chart.locator('.simulation-grid-minor.simulation-grid-time').count(),
    0,
    'Explicit time tick spacing determines the grid without automatic subdivisions.',
  );
  await page.getByRole('button', { name: 'V(net_0) vertical axis', exact: true }).click();
  axisDialog = page.getByRole('dialog', { name: 'V(net_0) axis', exact: true });
  await fillQuantity(axisDialog.getByLabel('Minimum (V)', { exact: true }), '-500m');
  await fillQuantity(axisDialog.getByLabel('Maximum (V)', { exact: true }), '500m');
  await fillQuantity(axisDialog.getByLabel('Tick spacing (V)', { exact: true }), '100m');
  await axisDialog.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await chart.getAttribute('data-value-min'), '-0.5');
  assert.equal(await chart.getAttribute('data-value-max'), '0.5');
  assert.equal(await chart.locator('.simulation-grid-minor.simulation-grid-value').count(), 0);
  assert.notEqual(
    await page
      .getByRole('group', { name: 'V(net_1) waveform', exact: true })
      .getAttribute('data-value-max'),
    '0.5',
  );
  assert.ok(await chart.locator('.simulation-trace').getAttribute('clip-path'));
  await page.screenshot({ path: 'test-results/waveform-zoom.png' });
  await autoScale.click();
  assert.equal(await chart.getAttribute('data-time-min'), '0');
  assert.equal(await chart.getAttribute('data-time-max'), '0.01');
  await page.evaluate(() => {
    window.waveformUndoEscaped = false;
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'z') window.waveformUndoEscaped = true;
    });
  });
  await chart.press('Control+z');
  assert.equal(await chart.getAttribute('data-time-min'), '0.001');
  assert.equal(await chart.getAttribute('data-value-max'), '0.5');
  await chart.press('Control+Shift+z');
  assert.equal(await chart.getAttribute('data-time-min'), '0');
  assert.equal(await page.evaluate(() => window.waveformUndoEscaped), false);
  await chart.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.waitForFunction(
    () =>
      +document.querySelector('.simulation-waveform > svg').dataset.timeMax -
        +document.querySelector('.simulation-waveform > svg').dataset.timeMin <
      0.01,
  );
  await page.evaluate(() => window.resetWaveformResult());
  await page.waitForFunction(
    () => document.querySelector('.simulation-waveform > svg').dataset.timeMax === '0.005',
  );
  assert.equal(await previousView.isDisabled(), true);
  assert.equal(await nextView.isDisabled(), true);
  const agentPresentation = await page.evaluate(() =>
    window.waveformCapabilities.execute(
      'simulation.presentation',
      {
        layout: '3x2',
        linked: true,
        visibleCursors: [true, true],
        cursor: { vector: 'v0', which: 0, time: 0.002 },
        view: { vector: 'v0', time: { min: 0.001, max: 0.004 }, values: { min: -2, max: 2 } },
      },
      { actor: 'agent' },
    ),
  );
  assert.equal(agentPresentation.layout, '3x2');
  assert.equal(agentPresentation.traces.v0.cursors[0], 0.002);
  assert.equal(await chart.getAttribute('data-time-min'), '0.001');
  assert.equal(await chart.getAttribute('data-time-max'), '0.004');
  assert.equal(await chart.getAttribute('data-value-min'), '-2');
  assert.equal(await chart.getAttribute('data-value-max'), '2');
  const invalidAxis = await page.evaluate(async () => {
    try {
      await window.waveformCapabilities.execute(
        'simulation.presentation',
        {
          layout: '1x1',
          view: { vector: 'v0', time: { min: 0.004, max: 0.001 } },
        },
        { actor: 'agent' },
      );
      return null;
    } catch (error) {
      return error.message;
    }
  });
  assert.match(invalidAxis, /time axis/);
  assert.equal(await chart.getAttribute('data-time-min'), '0.001');
  assert.equal(await page.locator('.simulation-plot-row').count(), 3);
  const removeButtons = page.getByRole('button', { name: /^Remove (?:V|I)\(/ });
  while (await removeButtons.count()) await removeButtons.first().click();
  assert.equal(await page.locator('.simulation-plot').count(), 0);
  await page
    .getByText('Click a wire for voltage or a component for current.', { exact: true })
    .waitFor();
  const add = page.getByRole('combobox', { name: 'Add waveform', exact: true });
  await add.press('ArrowDown');
  await add.press('ArrowDown');
  await add.press('Enter');
  assert.equal(await page.locator('.simulation-plot').count(), 1);
  assert.deepEqual(errors, []);
  console.log('Waveform layout checks passed.');
} finally {
  await browser.close();
}
