import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Isolated renderer: no desktop, service, provider or solver is launched.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useMemo, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import Canvas from './components/Canvas';
      import {createExample} from './lib/examples';
      import {defaultSchematicLayers} from './lib/schematic-layers';
      import {createProject, serializeProject, parseProject} from './lib/project';
      const initial = createExample('kicad-buck').schematic;
      function Fixture() {
        const [doc, setDoc] = useState(initial);
        const [history, setHistory] = useState([]);
        const [selection, setSelection] = useState([]);
        const [tool, setTool] = useState('select');
        const [probing, setProbing] = useState(false);
        const [values, setValues] = useState(true);
        const [fields, setFields] = useState(defaultSchematicLayers.fields);
        const layers = useMemo(() => ({...defaultSchematicLayers, values, fields}), [values, fields]);
        const commit = next => {setHistory(h => [...h, doc]); setDoc(next); return true;};
        window.fieldState = {doc, selection, commits: history.length};
        return <>
          <button onClick={() => setTool('select')}>Interaction</button>
          <button onClick={() => setProbing(true)}>Simulation</button>
          <button onClick={() => setTool('annotate')}>Annotation</button>
          <button onClick={() => setTool('wire')}>Wire</button>
          <button onClick={() => setValues(v => !v)}>Values</button>
          <button onClick={() => setFields(v => !v)}>Other fields</button>
          <button onClick={() => {setDoc(history.at(-1)); setHistory(h => h.slice(0,-1));}}>Undo</button>
          <button onClick={() => setDoc(parseProject(serializeProject(createProject(doc))).schematic)}>Reopen</button>
          <Canvas doc={doc} selection={selection} onSelection={setSelection}
            onSelect={id => setSelection(id ? [id] : [])} tool={tool} setTool={setTool}
            probing={probing} onProbe={target => {window.lastProbe = target;}}
            kind="resistor" annotations={[]} annotationSessionId="fixture"
            onAnnotationsChange={() => {}} onCommit={commit} fitKey={0} onPosition={() => {}}
            grid={false} gridSpacing={1} layers={layers} />
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
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
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addStyleTag({ content: '#root {height:100vh} .canvas-wrap {height:820px}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const field = page.getByTestId('annotation-field-V101-Sim.Params');
  await page.getByTestId('schematic-canvas').waitFor();
  await field.waitFor({ state: 'visible' });
  assert.equal(
    await page.locator('[data-testid^="annotation-field-"][data-testid$="-Sim.Pins"]').count(),
    0,
    'Component metadata is hidden by default',
  );
  const initialDocument = await page.evaluate(() => JSON.stringify(window.fieldState.doc));
  await page.getByRole('button', { name: 'Other fields', exact: true }).click();
  assert.ok(
    (await page.locator('[data-testid^="annotation-field-"][data-testid$="-Sim.Pins"]').count()) >
      0,
    'Other fields reveals component metadata',
  );
  await page.getByRole('button', { name: 'Other fields', exact: true }).click();
  assert.equal(
    await page.locator('[data-testid^="annotation-field-"][data-testid$="-Sim.Pins"]').count(),
    0,
  );
  assert.equal(await page.evaluate(() => JSON.stringify(window.fieldState.doc)), initialDocument);
  assert.equal(await page.evaluate(() => window.fieldState.commits), 0);
  await page.getByRole('button', { name: 'SPICE Simulation', exact: true }).click();
  await field.waitFor({ state: 'visible' });
  const pinTargets = page.locator('[data-probe-pin]');
  assert.ok((await pinTargets.count()) > 0, 'Pin probe targets remain available');
  const pin = page.getByTestId('part-L101').locator('[data-probe-pin="0"]');
  const assertInvisiblePin = async (message) =>
    assert.deepEqual(
      await pin.evaluate((node) => ({
        fill: getComputedStyle(node).fill,
        stroke: getComputedStyle(node).stroke,
        pointerEvents: getComputedStyle(node).pointerEvents,
      })),
      { fill: 'rgba(0, 0, 0, 0)', stroke: 'none', pointerEvents: 'all' },
      message,
    );
  const pinPart = await pin.getAttribute('data-probe-part');
  await pin.click();
  assert.deepEqual(
    await page.evaluate(() => window.lastProbe),
    {
      kind: 'voltage',
      id: pinPart,
      pin: 0,
    },
    'Invisible pins still receive voltage probes',
  );
  assert.deepEqual(await page.evaluate(() => window.fieldState.selection), [pinPart]);
  await assertInvisiblePin('Selecting a probed component does not draw terminal rings');
  assert.equal(await page.evaluate(() => window.fieldState.commits), 0);
  await page.getByRole('button', { name: 'Interaction', exact: true }).click();
  await assertInvisiblePin('Interaction selection does not draw terminal rings');
  await page.getByRole('button', { name: 'SPICE Simulation', exact: true }).click();
  const state = () =>
    page.evaluate(() => {
      const { doc, selection, commits } = window.fieldState;
      const part = doc.parts.find((p) => p.ref === 'V101');
      return { part, wires: doc.wires, selection, commits };
    });
  const coordinates = () =>
    field.evaluate((node) => ({
      x: Number(node.getAttribute('x')),
      y: Number(node.getAttribute('y')),
    }));
  const original = await state();
  const originalAt = await coordinates();
  const text = await field.textContent();
  assert.match(text, /y1=0 y2=15/);
  await field.click();
  assert.deepEqual((await state()).selection, ['field/' + original.part.id + '/Sim.Params']);
  assert.equal((await state()).commits, 0);
  await page.getByRole('button', { name: 'Interaction', exact: true }).click();
  await field.waitFor({ state: 'visible' });
  await page.getByTestId('schematic-canvas').press('ArrowRight');
  assert.equal((await state()).commits, 1, 'Interaction mode can move parameter text');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.deepEqual(await coordinates(), originalAt);
  await page.getByRole('button', { name: 'SPICE Simulation', exact: true }).click();
  assert.equal(await field.textContent(), text);
  const bounds = await field.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 35, {
    steps: 8,
  });
  assert.equal(await page.getByTestId('field-owner-guide').count(), 1);
  await page.mouse.up();
  const moved = await state();
  const movedAt = await coordinates();
  assert.equal(moved.commits, 1, 'one gesture is one undo transaction');
  assert.notDeepEqual(movedAt, originalAt);
  assert.equal(moved.part.x, original.part.x);
  assert.equal(moved.part.y, original.part.y);
  assert.equal(moved.part.value, original.part.value);
  assert.deepEqual(moved.part.fields, original.part.fields);
  assert.deepEqual(moved.wires, original.wires);
  await page.getByRole('button', { name: 'Interaction', exact: true }).click();
  await field.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'SPICE Simulation', exact: true }).click();
  assert.deepEqual(await coordinates(), movedAt, 'mode changes preserve the moved position');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.deepEqual(await coordinates(), originalAt);
  assert.equal((await state()).commits, 0);
  await field.click();
  await page.getByTestId('schematic-canvas').press('ArrowRight');
  const nudged = await coordinates();
  assert.ok(Math.abs(nudged.x - originalAt.x - 1.27) < 0.0001);
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  const reopened = await coordinates();
  assert.ok(Math.abs(reopened.x - nudged.x) < 0.0001);
  assert.ok(Math.abs(reopened.y - nudged.y) < 0.0001);
  assert.equal(await field.textContent(), text);
  await page.getByRole('button', { name: 'Values', exact: true }).click();
  assert.equal(await field.count(), 0);
  await page.getByRole('button', { name: 'Values', exact: true }).click();
  await field.waitFor({ state: 'visible' });
  const beforeGestures = await page.evaluate(() => JSON.stringify(window.fieldState.doc));
  const beforeCommits = await page.evaluate(() => window.fieldState.commits);
  await page.getByRole('button', { name: 'Annotation', exact: true }).click();
  await page.evaluate(() => {
    window.lastProbe = null;
  });
  await pin.click();
  assert.deepEqual(
    await page.evaluate(() => window.lastProbe),
    { kind: 'voltage', id: pinPart, pin: 0 },
    'Annotation mode can directly probe a pin.',
  );
  assert.equal(await page.evaluate(() => JSON.stringify(window.fieldState.doc)), beforeGestures);
  await page.getByRole('button', { name: 'Interaction', exact: true }).click();
  const body = page.getByTestId('symbol-hit-L101');
  await body.click({ force: true });
  const bodyBox = await body.boundingBox();
  await page.evaluate(() => {
    window.lastProbe = null;
  });
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bodyBox.x + bodyBox.width / 2 + 35, bodyBox.y + bodyBox.height / 2 + 20, {
    steps: 6,
  });
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => window.lastProbe),
    null,
    'Dragging a component never probes.',
  );
  assert.equal(
    await page.evaluate(() => window.fieldState.commits),
    beforeCommits + 1,
    'Interaction can still edit geometry with simulation enabled.',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.stringify(window.fieldState.doc)), beforeGestures);
  const cancelledBox = await body.boundingBox();
  await page.mouse.move(
    cancelledBox.x + cancelledBox.width / 2,
    cancelledBox.y + cancelledBox.height / 2,
  );
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.lastProbe), null, 'Cancelled clicks never probe.');
  await page.getByRole('button', { name: 'Wire', exact: true }).click();
  await pin.click();
  assert.equal(
    await page.evaluate(() => window.lastProbe),
    null,
    'Explicit Wire keeps its pin connection gesture.',
  );
  await page.keyboard.press('Escape');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/simulation-fields.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Simulation field visibility, mode selection, drag, undo, nudge and project round trip passed.',
  );
} finally {
  await browser.close();
}
