import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, pinPositions, serializeCircuit, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { createProject, serializeProject, parseProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { fieldId, objectPosition } = await tsImport('../lib/schematic-edit.ts', import.meta.url);
const { projectNetGroups } = await tsImport('../lib/project-net-groups.ts', import.meta.url);
const { child, children, parseSExpr, val } = await tsImport('../lib/sexpr.ts', import.meta.url);
const { defaultSchematicLayers } = await tsImport('../lib/schematic-layers.ts', import.meta.url);

// A controlled real Canvas validates every proposed edit through the complete
// canonical project format. It never starts Electron, a service, an Agent or a solver.
const seed = emptyCircuit();
seed.title = 'Move regression';
seed.parts.push(createPart(seed, 'R', 25.4, 25.4));
seed.parts.push(createPart(seed, 'R', 76.2, 25.4));
const [leftPin, rightPin] = seed.parts.map(
  (part) => pinPositions(part, seed.libraries[part.libId])[1],
);
seed.wires = [
  { id: uid(), a: leftPin, b: { x: leftPin.x, y: 45.72 } },
  { id: uid(), a: { x: leftPin.x, y: 45.72 }, b: { x: rightPin.x, y: 45.72 } },
  { id: uid(), a: { x: rightPin.x, y: 45.72 }, b: rightPin },
];
seed.labels = [
  { id: uid(), x: 50.8, y: 45.72, text: 'SIGNAL' },
  { id: uid(), x: 15.24, y: 60.96, text: 'TEST' },
];
seed.noConnects = seed.parts.map((part) => ({
  id: uid(),
  ...pinPositions(part, seed.libraries[part.libId])[0],
}));
const noteId = uid();
seed.original = [
  'kicad_sch',
  ['uuid', JSON.stringify(seed.id)],
  [
    'text',
    '"Move note"',
    ['at', '80.01', '66.04', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
    ['uuid', JSON.stringify(noteId)],
  ],
];
const native = parseSExpr(serializeCircuit(seed));
for (const [index, part] of seed.parts.entries()) {
  part.raw = children(native, 'symbol').find((symbol) => val(child(symbol, 'uuid')) === part.id);
  for (const name of ['Reference', 'Value']) {
    const property = children(part.raw, 'property').find((item) => val(item) === name);
    const at = child(property, 'at');
    at[1] = String(index ? 85.09 : 40.64);
    at[2] = name === 'Reference' ? '11.43' : '17.78';
  }
}
seed.original = [
  ...parseSExpr(serializeCircuit({ ...seed, original: undefined })),
  ...children(seed.original, 'text'),
];
const project = parseProject(serializeProject(createProject(seed)));
const baselineSource = serializeProject(project);
const doc = project.schematic;
const [first, second] = doc.parts;
const middle = doc.wires.find((wire) => wire.a.y === 45.72 && wire.b.y === 45.72);
const firstReference = fieldId(first.id, 'Reference');
const firstValue = fieldId(first.id, 'Value');
const topology = (circuit) =>
  projectNetGroups(circuit)
    .map((group) => [...group.pins].sort())
    .filter((pins) => pins.length)
    .sort();
const baselineTopology = topology(doc);

const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import Canvas from './components/Canvas';
      import {serializeProject,parseProject} from './lib/project';
      function Fixture(){const [project,setProject]=useState(window.fixture.project);
        const [history,setHistory]=useState([]);const [selection,setSelection]=useState([]);
        const [tool,setTool]=useState('select');const [active,setActive]=useState(true);
        const [layers,setLayers]=useState(window.fixture.layers);const [probing,setProbing]=useState(false);
        const [blocked,setBlocked]=useState(false);const [moveRequest,setMoveRequest]=useState(null);
        const source=serializeProject(project);
        window.moveState={project,doc:project.schematic,source,selection,tool,active,
          history:history.length,dirty:source!==window.fixture.source};
        window.undoFixture=()=>{if(history.length){setProject(history.at(-1));setHistory(h=>h.slice(0,-1));}};
        window.setFixtureTool=setTool;window.setFixtureActive=setActive;window.setFixtureProbing=setProbing;
        window.setFixtureEditingBlocked=setBlocked;
        window.requestFixtureMove=(connected=false)=>{setTool('select');setMoveRequest({
          id:++window.moveRequestId,schematicId:project.schematic.id,connected});};
        window.setFixtureLayers=changes=>setLayers(previous=>({...previous,...changes}));
        window.replaceFixtureDoc=next=>setProject({...project,schematic:next});
        return <Canvas leftButtonDrag="drag-any" doc={project.schematic} selection={selection} onSelection={setSelection}
          onSelect={id=>setSelection(id?[id]:[])} tool={tool} setTool={setTool} active={active}
          editingBlocked={blocked} moveRequest={moveRequest}
          initialViewport={{view:{x:0,y:0,width:110},ratio:2/3,canvasWidth:1320,zoomBaseWidth:1320}}
          kind="R" annotations={[]} annotationSessionId="move" onAnnotationsChange={()=>{}}
          probing={probing}
          onProbe={target=>window.probes.push(target)}
          onNotify={message=>window.moveNotices.push(message)}
          onCommit={next=>{window.commitAttempts++;try{
            const candidate={...project,schematic:next};const text=serializeProject(candidate);
            const validated=parseProject(text);if(text===source)return true;
            window.commits++;setHistory(h=>[...h,project]);setProject(validated);return true;
          }catch(error){window.commitErrors.push(error.message);return false;}}}
          fitKey={0} onPosition={()=>{}} grid={false} gridSpacing={1.27} layers={layers}/>}
      createRoot(document.getElementById('root')).render(window.fixture.strict?<React.StrictMode><Fixture/></React.StrictMode>:<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css'].map((file) => readFile(file, 'utf8')),
);
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const closeTo = (actual, expected, message) => {
  assert.ok(Math.abs(actual.x - expected.x) < 0.001, `${message}: X ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 0.001, `${message}: Y ${actual.y} != ${expected.y}`);
};
const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;

async function run(name, check, fixtureOptions = {}) {
  if (casePattern && !casePattern.test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1320, height: 880 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(
    (fixture) => {
      window.fixture = fixture;
      window.commits = 0;
      window.commitAttempts = 0;
      window.commitErrors = [];
      window.probes = [];
      window.moveNotices = [];
      window.moveRequestId = 0;
    },
    { project, source: baselineSource, layers: defaultSchematicLayers, ...fixtureOptions },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.canvas-wrap{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  await canvas.focus();
  const screen = (point) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
  const move = async (point) => {
    const at = await screen(point);
    await page.mouse.move(at.x, at.y, { steps: 4 });
  };
  const click = async (point, keys = []) => {
    for (const key of keys) await page.keyboard.down(key);
    try {
      const at = await screen(point);
      await page.mouse.click(at.x, at.y);
    } finally {
      for (const key of [...keys].reverse()) await page.keyboard.up(key);
    }
  };
  const state = () =>
    page.evaluate(() => ({
      ...window.moveState,
      commits: window.commits,
      attempts: window.commitAttempts,
      errors: window.commitErrors,
      probes: window.probes,
      notices: window.moveNotices,
    }));
  const preview = () => page.locator('[data-move-preview]');
  const expectPreview = async (mode) => {
    assert.equal(await preview().getAttribute('data-move-preview'), mode);
  };
  const expectNoEdit = async (source = baselineSource) => {
    const current = await state();
    assert.equal(current.source, source, `${name}: preview/cancellation preserves canonical bytes`);
    assert.equal(current.commits, 0);
    assert.equal(current.history, 0);
    assert.deepEqual(current.errors, []);
  };
  const bodyPosition = (reference) =>
    canvas.getByTestId(`symbol-hit-${reference}`).evaluate((node) => {
      const svg = node.ownerSVGElement;
      const b = node.getBoundingClientRect();
      const p = new DOMPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2).matrixTransform(
        svg.getScreenCTM().inverse(),
      );
      return { x: p.x, y: p.y };
    });
  const glyphPosition = (testId) =>
    canvas.getByTestId(testId).evaluate((node) => {
      const b = node.getBoundingClientRect();
      const p = new DOMPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2).matrixTransform(
        node.ownerSVGElement.getScreenCTM().inverse(),
      );
      return { x: p.x, y: p.y };
    });
  const wireGeometry = (id) =>
    canvas.locator(`[data-selection-id="${id}"] > g > line`).evaluate((node) => ({
      a: { x: Number(node.getAttribute('x1')), y: Number(node.getAttribute('y1')) },
      b: { x: Number(node.getAttribute('x2')), y: Number(node.getAttribute('y2')) },
    }));
  const undo = async () => {
    await page.evaluate(() => window.undoFixture());
    await page.waitForFunction(() => window.moveState.history === 0);
    const current = await state();
    assert.equal(
      current.source,
      baselineSource,
      'One undo restores the complete canonical project.',
    );
    assert.equal(current.dirty, false);
  };
  const expectOneEdit = async () => {
    const current = await state();
    assert.equal(current.commits, 1, 'Placement creates exactly one validated transaction.');
    assert.equal(current.history, 1);
    assert.equal(current.dirty, true);
    assert.deepEqual(current.errors, []);
    assert.equal(await preview().count(), 0);
    parseProject(current.source);
    return current.doc;
  };
  try {
    await check({
      page,
      canvas,
      move,
      click,
      state,
      preview,
      expectPreview,
      expectNoEdit,
      screen,
      bodyPosition,
      glyphPosition,
      wireGeometry,
      undo,
      expectOneEdit,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors`);
    assert.deepEqual((await state()).errors, [], `${name}: no invalid commits`);
    console.log(`Schematic move: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run('direct component drag keeps wires and markers connected with one undo', async (t) => {
    const target = { x: 30.48, y: 27.94 };
    await t.move(first);
    await t.page.mouse.down();
    await t.move(target);
    closeTo(await t.bodyPosition(first.ref), target, 'Direct component preview');
    const shown = await t.wireGeometry(doc.wires[0].id);
    assert.notDeepEqual(shown, { a: doc.wires[0].a, b: doc.wires[0].b });
    await t.expectNoEdit();
    assert.equal((await t.state()).attempts, 0);
    await t.page.mouse.up();
    const next = await t.expectOneEdit();
    assert.deepEqual(topology(next), baselineTopology);
    assert.deepEqual(next.parts[1], second);
    const placed = next.wires.find((wire) => wire.id === doc.wires[0].id);
    assert.deepEqual({ a: placed.a, b: placed.b }, shown);
    closeTo(next.noConnects[0], { x: target.x, y: target.y - 3.81 }, 'No-connect follows its pin');
    await t.undo();
  });

  await run(
    'direct multi-component drag retains their offsets and shared connections',
    async (t) => {
      await t.click(first);
      await t.click(second, ['Shift']);
      await t.move(first);
      await t.page.mouse.down();
      await t.move({ x: first.x + 5.08, y: first.y + 5.08 });
      await t.expectNoEdit();
      await t.page.mouse.up();
      const next = await t.expectOneEdit();
      assert.deepEqual(topology(next), baselineTopology);
      for (const previous of doc.parts)
        closeTo(
          next.parts.find((part) => part.id === previous.id),
          {
            x: previous.x + 5.08,
            y: previous.y + 5.08,
          },
          'Selected component follows the group',
        );
      await t.undo();
    },
  );

  await run('component arrow nudges preserve the same connections', async (t) => {
    await t.click(first);
    await t.canvas.press('ArrowRight');
    const next = await t.expectOneEdit();
    closeTo(next.parts[0], { x: first.x + 1.27, y: first.y }, 'Component nudge');
    assert.deepEqual(topology(next), baselineTopology);
    assert.notDeepEqual(next.wires, doc.wires);
    await t.undo();
  });

  await run(
    'returning a component drag to its origin creates neither an edit nor a probe',
    async (t) => {
      await t.page.evaluate(() => window.setFixtureProbing(true));
      await t.move(first);
      await t.page.mouse.down();
      await t.move({ x: first.x + 5.08, y: first.y + 2.54 });
      await t.move(first);
      await t.page.mouse.up();
      await t.expectNoEdit();
      assert.equal((await t.state()).attempts, 0);
      assert.deepEqual((await t.state()).probes, []);
    },
  );

  await run(
    'a blocked pointer drag discards its preview and never commits a stale pose',
    async (t) => {
      await t.move(first);
      await t.page.mouse.down();
      await t.move({ x: first.x + 5.08, y: first.y + 2.54 });
      const connectedPin = pinPositions(first, doc.libraries[first.libId])[1];
      const foreignPin = pinPositions(second, doc.libraries[second.libId])[0];
      await t.move({
        x: foreignPin.x - (connectedPin.x - first.x),
        y: foreignPin.y - (connectedPin.y - first.y),
      });
      closeTo(await t.bodyPosition(first.ref), first, 'Blocked drag restores canonical drawing');
      assert.ok((await t.state()).notices.some((message) => /another net/i.test(message)));
      await t.canvas.press('ArrowRight');
      await t.canvas.press('r');
      await t.page.mouse.up();
      await t.expectNoEdit();
      assert.equal((await t.state()).attempts, 0);
      assert.deepEqual((await t.state()).selection, [first.id]);
    },
  );

  await run('a blocked pointer drag can resume at a valid position before release', async (t) => {
    await t.move(first);
    await t.page.mouse.down();
    const connectedPin = pinPositions(first, doc.libraries[first.libId])[1];
    const foreignPin = pinPositions(second, doc.libraries[second.libId])[0];
    await t.move({
      x: foreignPin.x - (connectedPin.x - first.x),
      y: foreignPin.y - (connectedPin.y - first.y),
    });
    assert.ok((await t.state()).notices.some((message) => /another net/i.test(message)));
    const target = { x: first.x + 5.08, y: first.y + 2.54 };
    await t.move(target);
    closeTo(await t.bodyPosition(first.ref), target, 'Valid drag resumes its preview');
    await t.expectNoEdit();
    await t.page.mouse.up();
    const next = await t.expectOneEdit();
    closeTo(next.parts[0], target, 'Release commits the valid retry');
    assert.deepEqual(topology(next), baselineTopology);
    await t.undo();
  });

  for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture', 'deactivate', 'source']) {
    await run(`direct component drag cancels on ${cancel} without writes`, async (t) => {
      await t.move(first);
      await t.page.mouse.down();
      await t.move({ x: first.x + 5.08, y: first.y + 2.54 });
      if (cancel === 'Escape') await t.canvas.press('Escape');
      else if (cancel === 'deactivate') await t.page.evaluate(() => window.setFixtureActive(false));
      else if (cancel === 'source')
        await t.page.evaluate(() => window.setFixtureEditingBlocked(true));
      else await t.canvas.dispatchEvent(cancel, { pointerId: 1 });
      await t.move({ x: first.x + 10.16, y: first.y + 5.08 });
      await t.page.mouse.up();
      await t.expectNoEdit();
      closeTo(await t.bodyPosition(first.ref), first, 'Cancelled component stays in place');
    });
  }

  await run('M picks up the hovered symbol and click commits the preview once', async (t) => {
    const target = { x: 30.48, y: 27.94 };
    await t.move(first);
    await t.canvas.press('m');
    await t.expectPreview('move');
    await t.move(target);
    closeTo(await t.bodyPosition(first.ref), target, 'Symbol preview follows the cursor');
    await t.expectNoEdit();
    assert.equal((await t.state()).attempts, 0, 'Preview never proposes a document write.');
    await t.click(target);
    const next = await t.expectOneEdit();
    closeTo(
      next.parts.find((part) => part.id === first.id),
      target,
      'Placed symbol',
    );
    assert.deepEqual(next.wires, doc.wires, 'M leaves all existing wires in place.');
    await t.undo();
  });

  await run('G picks up the hovered symbol and Enter preserves its connected net', async (t) => {
    const target = { x: 30.48, y: 27.94 };
    await t.move(first);
    await t.canvas.press('g');
    await t.expectPreview('drag');
    await t.move(target);
    closeTo(await t.bodyPosition(first.ref), target, 'Connected drag preview');
    assert.notDeepEqual(await t.wireGeometry(doc.wires[0].id), {
      a: doc.wires[0].a,
      b: doc.wires[0].b,
    });
    await t.expectNoEdit();
    await t.canvas.press('Enter');
    const next = await t.expectOneEdit();
    closeTo(
      next.parts.find((part) => part.id === first.id),
      target,
      'Dragged symbol',
    );
    assert.deepEqual(topology(next), baselineTopology);
    assert.notDeepEqual(next.wires, doc.wires);
    await t.undo();
  });

  await run(
    'a rejected G position cannot commit the last valid preview and permits a valid retry',
    async (t) => {
      await t.move(first);
      await t.canvas.press('g');
      await t.move({ x: 30.48, y: 27.94 });
      await t.expectPreview('drag');
      await t.expectNoEdit();
      const connectedPin = pinPositions(first, doc.libraries[first.libId])[1];
      const foreignPin = pinPositions(second, doc.libraries[second.libId])[0];
      const rejected = {
        x: foreignPin.x - (connectedPin.x - first.x),
        y: foreignPin.y - (connectedPin.y - first.y),
      };
      // The two bottom pins already share SIGNAL. Target the foreign top pin
      // instead, so accepting this pose would join two originally distinct nets.
      await t.move(rejected);
      const rejectedPreview = await t.bodyPosition(first.ref);
      assert.ok(
        Math.hypot(rejectedPreview.x - rejected.x, rejectedPreview.y - rejected.y) > 0.001,
        'The conflicting pose is not shown as accepted.',
      );
      assert.ok(
        (await t.state()).notices.some((message) => /another net.*move.*farther/i.test(message)),
        'Rejected connected movement reports why it failed and how to retry.',
      );
      await t.canvas.press('Enter');
      await t.expectPreview('drag');
      await t.expectNoEdit();
      closeTo(
        await t.bodyPosition(first.ref),
        rejectedPreview,
        'Enter keeps the rejected move open',
      );
      await t.click(rejected);
      await t.expectPreview('drag');
      await t.expectNoEdit();
      assert.equal(
        (await t.state()).attempts,
        0,
        'Rejected placement never proposes the stale preview.',
      );
      const retry = { x: 35.56, y: 30.48 };
      await t.move(retry);
      closeTo(await t.bodyPosition(first.ref), retry, 'A valid retry updates the preview');
      await t.expectNoEdit();
      await t.canvas.press('Enter');
      const next = await t.expectOneEdit();
      closeTo(
        next.parts.find((part) => part.id === first.id),
        retry,
        'The valid retry is committed',
      );
      assert.deepEqual(topology(next), baselineTopology);
      await t.undo();
    },
  );

  await run('an existing selection takes priority over the hovered object', async (t) => {
    await t.click(first);
    await t.move(second);
    await t.canvas.press('m');
    closeTo(
      await t.bodyPosition(first.ref),
      second,
      'Single selected symbol attaches to the cursor',
    );
    const target = { x: 81.28, y: 27.94 };
    await t.move(target);
    await t.expectNoEdit();
    await t.canvas.press('Enter');
    const next = await t.expectOneEdit();
    closeTo(
      next.parts.find((part) => part.id === first.id),
      target,
      'Selection receives the edit',
    );
    assert.deepEqual(
      next.parts.find((part) => part.id === second.id),
      second,
    );
    assert.deepEqual((await t.state()).selection, [first.id]);
    await t.undo();
  });

  await run('multiple selected objects retain their relative offsets and one undo', async (t) => {
    await t.click(first);
    await t.click(second, ['Shift']);
    const pickup = { x: 50.8, y: 12.7 };
    await t.move(pickup);
    await t.canvas.press('m');
    closeTo(await t.bodyPosition(first.ref), first, 'Group pickup does not jump');
    closeTo(await t.bodyPosition(second.ref), second, 'Group pickup does not jump');
    await t.move({ x: pickup.x + 5.08, y: pickup.y + 5.08 });
    await t.expectNoEdit();
    await t.canvas.press('Enter');
    const next = await t.expectOneEdit();
    for (const previous of doc.parts)
      closeTo(
        next.parts.find((part) => part.id === previous.id),
        { x: previous.x + 5.08, y: previous.y + 5.08 },
        'Group translation',
      );
    assert.deepEqual(next.wires, doc.wires);
    await t.undo();
  });

  for (const key of ['m', 'g']) {
    await run(
      `${key.toUpperCase()} moves a hovered wire with the correct connectivity rule`,
      async (t) => {
        const pickup = { x: 38.1, y: 45.72 };
        await t.move(pickup);
        await t.canvas.press(key);
        await t.expectPreview(key === 'm' ? 'move' : 'drag');
        await t.move({ x: pickup.x + 5.08, y: pickup.y + 5.08 });
        const expected = {
          a: { x: middle.a.x + (key === 'm' ? 5.08 : 0), y: 50.8 },
          b: { x: middle.b.x + (key === 'm' ? 5.08 : 0), y: 50.8 },
        };
        const shown = await t.wireGeometry(middle.id);
        closeTo(shown.a, expected.a, 'Wire preview start');
        closeTo(shown.b, expected.b, 'Wire preview end');
        await t.expectNoEdit();
        await t.canvas.press('Enter');
        const next = await t.expectOneEdit();
        const placed = next.wires.find((wire) => wire.id === middle.id);
        closeTo(placed.a, shown.a, 'Committed wire matches preview start');
        closeTo(placed.b, shown.b, 'Committed wire matches preview end');
        assert.deepEqual(next.parts, doc.parts);
        if (key === 'm') {
          assert.deepEqual(
            next.wires.filter((wire) => wire.id !== middle.id),
            doc.wires.filter((wire) => wire.id !== middle.id),
          );
          assert.deepEqual(next.labels, doc.labels);
        } else {
          assert.deepEqual(topology(next), baselineTopology);
          assert.equal(next.labels.find((label) => label.text === 'SIGNAL').y, 50.8);
        }
        await t.undo();
      },
    );
  }

  await run('floating rotation and mirrors remain preview-only until one placement', async (t) => {
    const target = { x: 35.56, y: 30.48 };
    await t.move(first);
    await t.canvas.press('m');
    await t.move(target);
    await t.canvas.press('r');
    await t.expectNoEdit();
    await t.canvas.press('Shift+r');
    await t.canvas.press('x');
    await t.canvas.press('y');
    await t.canvas.press('r');
    await t.expectNoEdit();
    await t.canvas.press('Enter');
    const next = await t.expectOneEdit();
    const placed = next.parts.find((part) => part.id === first.id);
    closeTo(placed, target, 'Transform pivot remains at the pickup cursor');
    assert.equal(placed.rotation, 270);
    assert.equal(placed.mirror, undefined);
    const pins = pinPositions(placed, next.libraries[placed.libId]);
    closeTo(pins[0], { x: target.x + 3.81, y: target.y }, 'Rotated pin 1');
    closeTo(pins[1], { x: target.x - 3.81, y: target.y }, 'Rotated pin 2');
    assert.deepEqual(next.wires, doc.wires);
    await t.undo();
  });

  await run(
    'G rotation and mirror keep the original attached pin net through one commit',
    async (t) => {
      await t.move(first);
      await t.canvas.press('g');
      await t.move({ x: 35.56, y: 30.48 });
      await t.canvas.press('r');
      await t.canvas.press('x');
      await t.expectNoEdit();
      const shown = await t.wireGeometry(doc.wires[0].id);
      await t.canvas.press('Enter');
      const next = await t.expectOneEdit();
      assert.deepEqual(topology(next), baselineTopology);
      const placedWire = next.wires.find((wire) => wire.id === doc.wires[0].id);
      closeTo(placedWire.a, shown.a, 'Connected transform commits the rendered lead start');
      closeTo(placedWire.b, shown.b, 'Connected transform commits the rendered lead end');
      await t.undo();
    },
  );

  for (const item of [
    {
      name: 'Reference',
      id: firstReference,
      testId: `annotation-ref-${first.ref}`,
      target: { x: 45.72, y: 12.7 },
    },
    {
      name: 'Value',
      id: firstValue,
      testId: `annotation-value-${first.ref}`,
      target: { x: 45.72, y: 19.05 },
    },
    { name: 'label', id: doc.labels[1].id, testId: 'label-TEST', target: { x: 20.32, y: 63.5 } },
    {
      name: 'note',
      id: noteId,
      testId: `schematic-text-${noteId}`,
      target: { x: 85.09, y: 68.58 },
    },
  ]) {
    await run(`M moves a hovered ${item.name} without editing other objects`, async (t) => {
      await t.move(await t.glyphPosition(item.testId));
      await t.canvas.press('m');
      await t.expectPreview('move');
      await t.move(item.target);
      await t.expectNoEdit();
      await t.canvas.press('Enter');
      const next = await t.expectOneEdit();
      closeTo(objectPosition(next, item.id), item.target, `Placed ${item.name}`);
      for (const part of next.parts) {
        const previous = doc.parts.find((original) => original.id === part.id);
        closeTo(part, previous, `${item.name} leaves symbol origin unchanged`);
        assert.equal(part.rotation, previous.rotation);
      }
      assert.deepEqual(next.wires, doc.wires);
      await t.undo();
    });
  }

  await run('Escape cancels floating transforms while retaining selection', async (t) => {
    await t.click(first);
    await t.move(first);
    await t.canvas.press('m');
    await t.move({ x: 35.56, y: 30.48 });
    await t.canvas.press('r');
    await t.canvas.press('x');
    await t.canvas.press('Escape');
    assert.equal(await t.preview().count(), 0);
    closeTo(await t.bodyPosition(first.ref), first, 'Cancelled preview restores original geometry');
    assert.deepEqual((await t.state()).selection, [first.id]);
    await t.expectNoEdit();
  });

  for (const cancellation of ['tool switch', 'blur', 'deactivation', 'layers', 'replacement']) {
    await run(`${cancellation} cancels a floating move before writes`, async (t) => {
      await t.click(first);
      await t.move(first);
      await t.canvas.press('m');
      await t.move({ x: 35.56, y: 30.48 });
      await t.expectPreview('move');
      let expectedSource = baselineSource;
      if (cancellation === 'tool switch')
        await t.page.evaluate(() => window.setFixtureTool('wire'));
      else if (cancellation === 'blur') await t.canvas.evaluate((svg) => svg.blur());
      else if (cancellation === 'deactivation')
        await t.page.evaluate(() => window.setFixtureActive(false));
      else if (cancellation === 'layers')
        await t.page.evaluate(() => window.setFixtureLayers({ values: false }));
      else {
        const next = { ...doc, title: 'Replacement schematic' };
        expectedSource = serializeProject({ ...project, schematic: next });
        await t.page.evaluate((replacement) => window.replaceFixtureDoc(replacement), next);
      }
      await t.preview().waitFor({ state: 'detached' });
      await t.move({ x: 40.64, y: 35.56 });
      assert.equal(
        await t.preview().count(),
        0,
        'Further pointer events cannot revive the gesture.',
      );
      assert.deepEqual((await t.state()).selection, [first.id]);
      await t.expectNoEdit(expectedSource);
    });
  }

  await run('placing a floating symbol does not trigger a transient probe', async (t) => {
    await t.page.evaluate(() => window.setFixtureProbing(true));
    await t.move(first);
    await t.canvas.press('m');
    await t.move(second);
    await t.expectNoEdit();
    await t.click(second);
    await t.expectOneEdit();
    assert.deepEqual((await t.state()).probes, []);
    await t.undo();
  });

  await run('hidden geometry cannot start a hover move', async (t) => {
    await t.page.evaluate(() =>
      window.setFixtureLayers({ symbols: false, references: false, values: false }),
    );
    await t.move(first);
    await t.canvas.press('m');
    assert.equal(await t.preview().count(), 0);
    await t.expectNoEdit();
  });

  for (const key of ['m', 'g']) {
    await run(
      `${key.toUpperCase()} can pick up an exact hovered pin without starting a wire`,
      async (t) => {
        const pin = pinPositions(first, doc.libraries[first.libId])[1];
        const target = { x: 35.56, y: 19.05 };
        await t.move(pin);
        await t.canvas.press(key);
        await t.expectPreview(key === 'm' ? 'move' : 'drag');
        closeTo(
          await t.bodyPosition(first.ref),
          first,
          'Pin pickup keeps the original body position',
        );
        await t.move(target);
        closeTo(
          await t.bodyPosition(first.ref),
          { x: target.x, y: target.y - 3.81 },
          'Pin remains the pickup anchor',
        );
        await t.expectNoEdit();
        await t.click(target);
        const next = await t.expectOneEdit();
        closeTo(
          pinPositions(
            next.parts.find((part) => part.id === first.id),
            next.libraries[first.libId],
          )[1],
          target,
          'Placed pin',
        );
        assert.equal((await t.state()).tool, 'select');
        await t.undo();
      },
    );
  }

  await run('placing on another symbol pin finishes the move without starting Wire', async (t) => {
    const target = pinPositions(second, doc.libraries[second.libId])[1];
    await t.move(pinPositions(first, doc.libraries[first.libId])[1]);
    await t.canvas.press('m');
    await t.move(target);
    await t.click(target);
    const next = await t.expectOneEdit();
    closeTo(
      pinPositions(
        next.parts.find((part) => part.id === first.id),
        next.libraries[first.libId],
      )[1],
      target,
      'Placement snaps to the other pin',
    );
    assert.equal((await t.state()).tool, 'select');
    assert.deepEqual(next.wires, doc.wires);
    await t.undo();
  });

  for (const button of ['middle', 'right']) {
    await run(`${button} mouse panning retains the floating move on release`, async (t) => {
      await t.move(first);
      await t.canvas.press('m');
      await t.move({ x: 35.56, y: 30.48 });
      const shown = await t.bodyPosition(first.ref);
      const beforeView = await t.canvas.getAttribute('viewBox');
      const start = await t.screen({ x: 35.56, y: 30.48 });
      await t.page.mouse.move(start.x, start.y);
      await t.page.mouse.down({ button });
      await t.page.mouse.move(start.x + 60, start.y + 36, { steps: 4 });
      await t.page.mouse.up({ button });
      await t.expectPreview('move');
      assert.notEqual(await t.canvas.getAttribute('viewBox'), beforeView);
      closeTo(
        await t.bodyPosition(first.ref),
        shown,
        'Panning changes the view and preserves floating geometry',
      );
      await t.expectNoEdit();
      await t.canvas.press('Escape');
      await t.expectNoEdit();
    });
  }

  await run(
    'switching M and G updates the wire axis while preserving the current preview',
    async (t) => {
      const pickup = { x: 38.1, y: 45.72 };
      await t.move(pickup);
      await t.canvas.press('m');
      await t.move({ x: pickup.x + 5.08, y: pickup.y + 2.54 });
      await t.canvas.press('g');
      await t.expectPreview('drag');
      await t.move({ x: pickup.x + 10.16, y: pickup.y + 5.08 });
      const constrained = await t.wireGeometry(middle.id);
      closeTo(
        constrained.a,
        { x: middle.a.x + 5.08, y: middle.a.y + 5.08 },
        'G constrains future tangential motion',
      );
      closeTo(
        constrained.b,
        { x: middle.b.x + 5.08, y: middle.b.y + 5.08 },
        'G preserves the existing tangential offset',
      );
      await t.canvas.press('m');
      await t.expectPreview('move');
      await t.move({ x: pickup.x + 10.16, y: pickup.y + 7.62 });
      const shown = await t.wireGeometry(middle.id);
      closeTo(
        shown.a,
        { x: middle.a.x + 10.16, y: middle.a.y + 7.62 },
        'M releases the tangential constraint',
      );
      await t.expectNoEdit();
      await t.canvas.press('Enter');
      const next = await t.expectOneEdit();
      const placed = next.wires.find((wire) => wire.id === middle.id);
      closeTo(placed.a, shown.a, 'Switched move commits the preview start');
      closeTo(placed.b, shown.b, 'Switched move commits the preview end');
      await t.undo();
    },
  );

  await run(
    'modified, repeated and composing hotkeys do not start or transform a move',
    async (t) => {
      await t.move(first);
      for (const key of ['m', 'g']) {
        for (const modifier of ['ctrlKey', 'metaKey', 'altKey'])
          await t.canvas.dispatchEvent('keydown', { key, [modifier]: true });
        await t.canvas.dispatchEvent('keydown', { key, shiftKey: true });
        await t.canvas.dispatchEvent('keydown', { key, repeat: true });
        await t.canvas.dispatchEvent('keydown', { key, isComposing: true });
      }
      assert.equal(await t.preview().count(), 0);
      await t.canvas.press('m');
      const transform = await t.canvas
        .getByTestId(`symbol-hit-${first.ref}`)
        .getAttribute('transform');
      for (const key of ['r', 'x', 'y']) {
        for (const modifier of ['ctrlKey', 'metaKey', 'altKey'])
          await t.canvas.dispatchEvent('keydown', { key, [modifier]: true });
        await t.canvas.dispatchEvent('keydown', { key, repeat: true });
        await t.canvas.dispatchEvent('keydown', { key, isComposing: true });
      }
      assert.equal(
        await t.canvas.getByTestId(`symbol-hit-${first.ref}`).getAttribute('transform'),
        transform,
      );
      await t.expectNoEdit();
      await t.canvas.press('Escape');
    },
  );

  await run('pending Source blocks pickup and cancels a floating edit', async (t) => {
    await t.page.evaluate(() => window.setFixtureEditingBlocked(true));
    await t.move(first);
    for (const key of ['m', 'g']) await t.canvas.press(key);
    assert.equal(await t.preview().count(), 0);
    await t.page.evaluate(() => window.setFixtureEditingBlocked(false));
    await t.move(first);
    await t.canvas.press('m');
    await t.move({ x: 35.56, y: 30.48 });
    await t.expectPreview('move');
    await t.page.evaluate(() => window.setFixtureEditingBlocked(true));
    await t.preview().waitFor({ state: 'detached' });
    await t.canvas.press('Enter');
    await t.expectNoEdit();
  });

  for (const key of ['m', 'g']) {
    await run(
      `${key.toUpperCase()} with a selected component ignores a pointer outside the canvas`,
      async (t) => {
        await t.click(first);
        await t.page.mouse.move(-10, -10);
        await t.canvas.focus();
        await t.canvas.press(key);
        await t.expectPreview(key === 'm' ? 'move' : 'drag');
        closeTo(await t.bodyPosition(first.ref), first, 'Pickup retains the original pose');
        await t.canvas.press('Enter');
        assert.equal(await t.preview().count(), 0);
        await t.expectNoEdit();
        assert.equal((await t.state()).attempts, 0, 'Unmoved placement never proposes an edit.');
      },
    );
  }

  for (const tool of ['wire', 'drag']) {
    await run(
      `a menu move request restores Select after ${tool} and focuses the canvas`,
      async (t) => {
        await t.click(first);
        await t.page.evaluate((nextTool) => window.setFixtureTool(nextTool), tool);
        await t.canvas.evaluate((svg) => svg.blur());
        await t.move(first);
        await t.page.evaluate(() => window.requestFixtureMove(false));
        await t.preview().waitFor();
        await t.expectPreview('move');
        assert.equal(await t.canvas.evaluate((svg) => document.activeElement === svg), true);
        assert.equal((await t.state()).tool, 'select');
        await t.move({ x: 35.56, y: 30.48 });
        await t.expectNoEdit();
        await t.canvas.press('Enter');
        await t.expectOneEdit();
        await t.undo();
      },
    );
  }

  await run(
    'StrictMode consumes a menu request once and does not restart it after cancellation',
    async (t) => {
      await t.click(first);
      await t.move(first);
      await t.page.evaluate(() => window.requestFixtureMove(false));
      await t.preview().waitFor();
      await t.canvas.press('Escape');
      await t.page.evaluate(() => window.setFixtureProbing(true));
      await t.move({ x: 35.56, y: 30.48 });
      assert.equal(await t.preview().count(), 0);
      await t.expectNoEdit();
      await t.page.evaluate(() => window.requestFixtureMove(false));
      await t.preview().waitFor();
      await t.move({ x: 40.64, y: 35.56 });
      await t.canvas.press('Enter');
      await t.expectOneEdit();
      await t.undo();
    },
    { strict: true },
  );

  for (const cancellation of ['deactivation', 'replacement']) {
    await run(`a queued menu request cannot start after ${cancellation}`, async (t) => {
      await t.click(first);
      await t.move(first);
      let expectedSource = baselineSource;
      if (cancellation === 'deactivation')
        await t.page.evaluate(async () => {
          window.requestFixtureMove(false);
          await new Promise((resolve) =>
            requestAnimationFrame(() => {
              window.setFixtureActive(false);
              resolve();
            }),
          );
        });
      else {
        const next = { ...doc, title: 'Replacement schematic' };
        expectedSource = serializeProject({ ...project, schematic: next });
        await t.page.evaluate(async (replacement) => {
          window.requestFixtureMove(false);
          await new Promise((resolve) =>
            requestAnimationFrame(() => {
              window.replaceFixtureDoc(replacement);
              resolve();
            }),
          );
        }, next);
      }
      await t.page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await t.preview().count(), 0);
      await t.expectNoEdit(expectedSource);
    });
  }
} finally {
  await browser.close();
}
