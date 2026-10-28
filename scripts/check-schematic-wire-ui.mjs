import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

// Isolated real Canvas: no Electron, native files, solver or Agent requests.
const { emptyCircuit, createPart, pinPositions, snap, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { createProject, serializeProject, parseProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { projectNetGroups } = await tsImport('../lib/project-net-groups.ts', import.meta.url);
const circuit = emptyCircuit();
circuit.parts.push(createPart(circuit, 'R', 76.2, 25.4));
circuit.parts[0].x += 0.21;
circuit.parts[0].y += 0.23;
circuit.wires.push({
  id: uid(),
  a: { x: 40.64, y: 50.8 },
  b: { x: 91.44, y: 50.8 },
});
circuit.wires.push({
  id: uid(),
  a: { x: 40.64, y: 59.9 },
  b: { x: 91.44, y: 59.9 },
});
const baseline = parseProject(serializeProject(createProject(circuit))).schematic;
const terminal = pinPositions(baseline.parts[0], baseline.libraries[baseline.parts[0].libId])[0];
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import Canvas from './components/Canvas';
      import {defaultSchematicLayers} from './lib/schematic-layers';
      import {createProject, serializeProject, parseProject} from './lib/project';
      window.fixtureLayers = defaultSchematicLayers;
      function Test() {
        const [doc, setDoc] = useState(window.fixture);
        const [history, setHistory] = useState([]);
        const [tool, setTool] = useState('select');
        const [selection, setSelection] = useState([]);
        const [active, setActive] = useState(true);
        const [layers, setLayers] = useState(defaultSchematicLayers);
        window.wireCheck = {doc, historyLength: history.length, tool};
        window.setWireActive = setActive;
        window.replaceWireDoc = setDoc;
        window.setWireLayers = setLayers;
        return <>
          <button aria-label="Wire" onClick={()=>setTool('wire')}>Wire</button>
          <button aria-label="Undo" disabled={!history.length} onClick={()=>{
            setDoc(history.at(-1));setHistory(history.slice(0,-1));
          }}>Undo</button>
          <Canvas doc={doc} selection={selection} onSelection={setSelection}
            onSelect={id=>setSelection(id?[id]:[])} tool={tool} setTool={setTool}
            kind="R" active={active} initialViewport={{view:{x:0,y:0,width:120},ratio:2/3,canvasWidth:1200,zoomBaseWidth:1200}}
            fitKey={0} onPosition={()=>{}} grid={false} gridSpacing={2}
            layers={layers} annotations={[]} annotationSessionId="wire-check"
            onAnnotationsChange={()=>{}}
            onCommit={next=>{
              const validated=parseProject(serializeProject(createProject(next))).schematic;
              window.wireCommits++;
              setHistory([...history,doc]);setDoc(validated);return true;
            }}/>
        </>;
      }
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await mkdir('test-results/schematic-wire', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: '.canvas-wrap {width:1200px;height:800px;flex:none}' });
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.wireCommits = 0;
  }, baseline);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('schematic-canvas');
  const draft = canvas.locator('path[stroke-dasharray="0.55 0.35"]');
  const button = (name) => page.getByRole('button', { name, exact: true });
  await canvas.waitFor();
  const at = (point) =>
    canvas.evaluate((svg, p) => {
      const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, point);
  // Pointer updates schedule React preview state for the next paint. Keyboard
  // placement must observe that same visible state, including after undo/layers.
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const move = async (point) => {
    const screen = await at(point);
    await page.mouse.move(screen.x, screen.y);
    await settle();
  };
  const click = async (point) => {
    const screen = await at(point);
    await page.mouse.click(screen.x, screen.y);
    await settle();
  };
  const snapshot = () => page.evaluate(() => window.wireCheck);
  const commits = () => page.evaluate(() => window.wireCommits);
  const hasEndpoint = (doc, point) =>
    doc.wires.some((wire) => [wire.a, wire.b].some((p) => p.x === point.x && p.y === point.y));
  const undo = async () => {
    assert.equal((await snapshot()).historyLength, 1, 'One complete route is one undo edit.');
    await button('Undo').click();
    await settle();
    assert.deepEqual((await snapshot()).doc, baseline);
    assert.equal(await button('Undo').isDisabled(), true);
  };

  // Enter includes the very first live leg before a waypoint has been clicked.
  const firstStart = { x: 10.16, y: 10.16 };
  const firstEnd = { x: 22.86, y: 17.78 };
  await button('Wire').click();
  await click(firstStart);
  await move(firstEnd);
  assert.match(await draft.getAttribute('d'), /L 22\.86 17\.78$/);
  await page.keyboard.press('Enter');
  let current = (await snapshot()).doc;
  assert.equal(await commits(), 1);
  assert.equal(current.wires.length, baseline.wires.length + 2);
  assert.ok(hasEndpoint(current, firstStart));
  assert.ok(hasEndpoint(current, firstEnd), 'The committed wire reaches the visible live head.');
  assert.equal(await draft.count(), 0);
  await undo();

  // Existing waypoints and the final unclicked leg commit together.
  const waypoints = [
    { x: 10.16, y: 35.56 },
    { x: 25.4, y: 35.56 },
    { x: 25.4, y: 40.64 },
  ];
  const finalHead = { x: 35.56, y: 45.72 };
  await canvas.focus();
  for (const point of waypoints) await click(point);
  await move(finalHead);
  assert.match(await draft.getAttribute('d'), /L 35\.56 45\.72$/);
  await page.keyboard.press('Enter');
  current = (await snapshot()).doc;
  assert.equal(await commits(), 2);
  assert.equal(current.wires.length, baseline.wires.length + 4);
  for (const point of [...waypoints, finalHead]) assert.ok(hasEndpoint(current, point));
  assert.equal(await draft.count(), 0);
  await undo();

  // Finishing on the interior of an existing wire creates a deliberate T join.
  const join = { x: 60.96, y: 50.8 };
  await click({ x: join.x, y: 38.1 });
  await move(join);
  await page.keyboard.press('Enter');
  current = (await snapshot()).doc;
  assert.equal(await commits(), 3);
  assert.equal(current.wires.length, baseline.wires.length + 2);
  assert.equal(
    current.wires.filter((wire) => [wire.a, wire.b].some((p) => p.x === join.x && p.y === join.y))
      .length,
    3,
  );
  assert.ok(current.junctions.some((p) => p.x === join.x && p.y === join.y));
  assert.ok(current.wires.some((wire) => wire.id === baseline.wires[0].id));
  await undo();

  // Enter also connects the live head to an actual symbol terminal.
  const pinStart = { x: terminal.x - 12.7, y: terminal.y };
  await click(pinStart);
  await move(terminal);
  await page.keyboard.press('Enter');
  current = (await snapshot()).doc;
  assert.equal(await commits(), 4);
  assert.ok(hasEndpoint(current, terminal));
  assert.ok(
    projectNetGroups(current).some((group) => group.pins.length > 0 && group.wires.length > 0),
  );
  await undo();

  // Cancelling a route with a waypoint leaves validated content and undo untouched.
  await click(firstStart);
  await click({ x: 20.32, y: firstStart.y });
  await move(firstEnd);
  assert.equal(await draft.count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await draft.count(), 0);
  assert.deepEqual((await snapshot()).doc, baseline);
  assert.equal((await snapshot()).historyLength, 0);
  assert.equal(await commits(), 4);
  assert.equal((await snapshot()).tool, 'wire', 'Cancelling a live route retains Wire.');
  await canvas.dispatchEvent('keydown', { key: 'Escape', repeat: true });
  assert.equal((await snapshot()).tool, 'wire', 'Holding Escape cannot skip cancellation stages.');

  // The next click begins another route immediately, without reactivating Wire.
  await click(firstEnd);
  assert.equal(await draft.getAttribute('data-wire-start'), `${firstEnd.x},${firstEnd.y}`);
  await page.keyboard.press('Escape');
  assert.equal(await draft.count(), 0, 'A start without waypoints is also a cancellable route.');
  assert.equal((await snapshot()).tool, 'wire');
  await page.keyboard.press('Escape');
  assert.equal((await snapshot()).tool, 'select', 'Escape from idle Wire returns to Interaction.');
  assert.equal(await commits(), 4);

  // Enter at a zero-length start creates no empty edit.
  await button('Wire').click();
  await click(firstStart);
  await page.keyboard.press('Enter');
  assert.equal(await commits(), 4);
  assert.deepEqual((await snapshot()).doc, baseline);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // A hidden/inactive editor or changed source/layers cannot retain an old live route.
  for (const reason of ['deactivation', 'document replacement', 'layer change']) {
    // Escape above deliberately exits Wire; each scenario starts a new tool.
    await button('Wire').click();
    await click(firstStart);
    await click({ x: 20.32, y: firstStart.y });
    await move(firstEnd);
    assert.equal(await draft.count(), 1);
    await page.evaluate((reason) => {
      if (reason === 'deactivation') window.setWireActive(false);
      if (reason === 'document replacement') window.replaceWireDoc(structuredClone(window.fixture));
      if (reason === 'layer change')
        window.setWireLayers({ ...window.fixtureLayers, wires: false });
    }, reason);
    await draft.waitFor({ state: 'detached' });
    assert.equal(await commits(), 4, `${reason} cancels the draft without an edit.`);
    assert.equal((await snapshot()).historyLength, 0);
    assert.deepEqual((await snapshot()).doc, baseline);
    await page.evaluate(() => {
      window.setWireActive(true);
      window.setWireLayers(window.fixtureLayers);
    });
    await canvas.focus();
    await page.keyboard.press('Enter');
    assert.equal(await commits(), 4, `${reason} cannot commit stale route data after resuming.`);
  }

  // Shift disables connected-object magnetism while retaining the 1.27 mm grid.
  // Press/release updates the live preview even with a stationary pointer.
  const nearWire = { x: 60.96, y: 59.69 };
  await click({ x: 10.16, y: 58.42 });
  await move(nearWire);
  assert.ok((await draft.getAttribute('d')).endsWith('L 60.96 59.9'));
  await page.keyboard.down('Shift');
  await settle();
  assert.ok((await draft.getAttribute('d')).endsWith('L 60.96 59.69'));
  await page.keyboard.up('Shift');
  await settle();
  assert.ok((await draft.getAttribute('d')).endsWith('L 60.96 59.9'));
  assert.equal(await commits(), 4, 'Modifier changes only the preview.');
  await page.keyboard.down('Shift');
  await click(nearWire);
  assert.equal(
    await commits(),
    4,
    'Shift-click near a wire locks a grid waypoint without a T join.',
  );
  assert.equal(await draft.count(), 1);
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  current = (await snapshot()).doc;
  assert.equal(await commits(), 5);
  assert.ok(hasEndpoint(current, nearWire));
  assert.deepEqual(
    current.wires.find((wire) => wire.id === baseline.wires[1].id),
    baseline.wires[1],
    'Nearby native off-grid wire and its identity remain intact.',
  );
  await undo();

  // Pin hit targets must use the same modifier policy as the wire preview.
  const pinGrid = { x: snap(terminal.x), y: snap(terminal.y) };
  await click({ x: 60.96, y: 20.32 });
  await move(terminal);
  assert.ok((await draft.getAttribute('d')).endsWith(`L ${terminal.x} ${terminal.y}`));
  await page.keyboard.down('Shift');
  await settle();
  assert.ok((await draft.getAttribute('d')).endsWith(`L ${pinGrid.x} ${pinGrid.y}`));
  await click(terminal);
  assert.equal(await commits(), 5, 'Shift-clicking the pin target retains the grid waypoint.');
  assert.equal(await draft.count(), 1);
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  current = (await snapshot()).doc;
  assert.equal(await commits(), 6);
  assert.ok(hasEndpoint(current, pinGrid));
  assert.equal(hasEndpoint(current, terminal), false, 'The off-grid pin was not connected.');
  await undo();

  // Shift suppresses magnetism, not real connectivity at exact grid positions.
  await click({ x: join.x, y: 40.64 });
  await page.keyboard.down('Shift');
  await click(join);
  await page.keyboard.up('Shift');
  current = (await snapshot()).doc;
  assert.equal(await commits(), 7);
  assert.equal(await draft.count(), 0);
  assert.ok(current.junctions.some((point) => point.x === join.x && point.y === join.y));
  await undo();
  await page.screenshot({ path: 'test-results/schematic-wire/completed.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Schematic wiring: Enter commits complete routes once; Escape cancels a live route before exiting Wire, with no writes or held-key stage skipping; Shift toggles native target magnetism without pointer movement, retains grid placement through pin hit targets, and preserves exact joins; empty routes and document/layer/activation changes remain guarded.',
  );
} finally {
  await browser.close();
}
