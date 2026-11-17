import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, pinPositions, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { fieldId } = await tsImport('../lib/schematic-edit.ts', import.meta.url);
const { defaultSchematicLayers } = await tsImport('../lib/schematic-layers.ts', import.meta.url);
const { defaultSchematicSelectionFilters } = await tsImport(
  '../lib/schematic-selection-filters.ts',
  import.meta.url,
);

// Each case mounts a real renderer with controlled Canvas state. It never starts
// Electron, a service, an Agent or a solver, and never opens the user's files.
const doc = emptyCircuit();
doc.parts.push(createPart(doc, 'R', 25.4, 25.4));
doc.parts.push(createPart(doc, 'R', 60.96, 25.4));
for (const [index, part] of doc.parts.entries()) {
  const textX = index ? 65 : 40;
  part.raw = [
    'symbol',
    ['at', String(part.x), String(part.y), '0'],
    ['property', '"Reference"', JSON.stringify(part.ref), ['at', String(textX), '12', '0']],
    ['property', '"Value"', JSON.stringify(part.value), ['at', String(textX), '18', '0']],
  ];
}
doc.wires = [
  { id: uid(), a: { x: 10, y: 45 }, b: { x: 45, y: 45 } },
  { id: uid(), a: { x: 50, y: 40 }, b: { x: 70, y: 60 } },
];
doc.junctions = [{ id: uid(), x: 80, y: 50 }];
doc.labels = [{ id: uid(), x: 75, y: 20, text: 'SIGNAL' }];
doc.noConnects = [{ id: uid(), x: 80, y: 30 }];
const noteId = uid();
doc.original = [
  'kicad_sch',
  [
    'text',
    '"Note"',
    ['at', '80', '65', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
    ['uuid', JSON.stringify(noteId)],
  ],
];
const [first, second] = doc.parts;
const firstReference = fieldId(first.id, 'Reference');
const firstValue = fieldId(first.id, 'Value');
const secondValue = fieldId(second.id, 'Value');
const firstBox = [
  { x: 23.8, y: 20.5 },
  { x: 27, y: 30.2 },
];
const secondBox = [
  { x: 59.3, y: 20.5 },
  { x: 62.6, y: 30.2 },
];

const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import Canvas from './components/Canvas';
      function Fixture(){const [doc,setDoc]=useState(window.fixture.doc);
        const [selection,setSelection]=useState([]);const [tool,setTool]=useState('select');
        const [layers,setLayers]=useState(window.fixture.layers);const [active,setActive]=useState(true);
        const [selectionFilters,setSelectionFilters]=useState(window.fixture.selectionFilters);
        const [leftButtonDrag,setLeftButtonDrag]=useState('drag-selected');
        window.setFixtureLeftButtonDrag=setLeftButtonDrag;
        window.selectionState={doc,selection,tool,active};window.replaceFixtureDoc=setDoc;
        window.setFixtureTool=setTool;
        window.setFixtureActive=setActive;
        window.setFixtureLayers=changes=>setLayers(previous=>({...previous,...changes}));
        window.setFixtureSelectionFilters=changes=>setSelectionFilters(previous=>({...previous,...changes}));
        return <Canvas doc={doc} selection={selection} onSelection={setSelection}
          onSelect={id=>setSelection(id?[id]:[])} tool={tool} setTool={setTool} active={active}
          initialViewport={{view:{x:0,y:0,width:100},ratio:2/3,canvasWidth:1200,zoomBaseWidth:1200}}
          kind="R" annotations={[]} annotationSessionId="selection" onAnnotationsChange={()=>{}}
          onCommit={next=>{window.commits++;setDoc(next);return true}}
          fitKey={0} onPosition={()=>{}} grid={false} gridSpacing={1.27} layers={layers}
          selectionFilters={selectionFilters} leftButtonDrag={leftButtonDrag}/>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
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

async function run(name, check) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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
    },
    { doc, layers: defaultSchematicLayers, selectionFilters: defaultSchematicSelectionFilters },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.canvas-wrap{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  await canvas.focus();
  await canvas.evaluate((svg) => {
    window.selectionPointerTrace = [];
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'gotpointercapture',
      'lostpointercapture',
    ])
      svg.addEventListener(type, (event) => {
        window.selectionPointerTrace.push({
          type: event.type,
          pointerId: event.pointerId,
          target: event.target.tagName,
          captured: svg.hasPointerCapture(event.pointerId),
        });
      });
    svg.addEventListener('pointerdown', (event) => {
      window.selectionPointerId = event.pointerId;
    });
  });
  const screen = (point) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
  const move = async (point) => {
    const at = await screen(point);
    await page.mouse.move(at.x, at.y, { steps: 4 });
  };
  const modifiers = async (keys, action) => {
    for (const key of keys) await page.keyboard.down(key);
    try {
      await action();
    } finally {
      for (const key of [...keys].reverse()) await page.keyboard.up(key);
    }
  };
  const click = (point, keys = []) =>
    modifiers(keys, async () => {
      const at = await screen(point);
      await page.mouse.click(at.x, at.y);
    });
  const beginBox = async (start, end) => {
    await move(start);
    await page.mouse.down();
    await move(end);
  };
  const box = (start, end, keys = []) =>
    modifiers(keys, async () => {
      await beginBox(start, end);
      await page.mouse.up();
    });
  const glyphBounds = (testId) =>
    canvas.evaluate((svg, id) => {
      const node = svg.querySelector('[data-testid="' + id + '"]');
      const rect = node.getBoundingClientRect();
      const inverse = svg.getScreenCTM().inverse();
      const a = new DOMPoint(rect.left, rect.top).matrixTransform(inverse);
      const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse);
      return { left: a.x, top: a.y, right: b.x, bottom: b.y };
    }, testId);
  const selected = () => page.evaluate(() => [...window.selectionState.selection].sort());
  const expectSelection = async (ids, message) =>
    assert.deepEqual(await selected(), [...ids].sort(), message);
  const snapshot = () =>
    page.evaluate(() => ({ doc: window.selectionState.doc, commits: window.commits }));
  const expectUnchanged = async (expected = doc) =>
    assert.deepEqual(await snapshot(), { doc: expected, commits: 0 }, `${name}: no design edit`);
  const captured = () => canvas.evaluate((svg) => svg.hasPointerCapture(window.selectionPointerId));
  const releaseCapture = async (point) => {
    const before = await page.evaluate(() => window.selectionPointerTrace.length);
    await canvas.evaluate((svg) => svg.releasePointerCapture(window.selectionPointerId));
    // Chromium applies a pending capture change before the next pointer event.
    await move(point);
    const trace = await page.evaluate(
      (offset) => window.selectionPointerTrace.slice(offset),
      before,
    );
    assert.ok(
      trace.some((event) => event.type === 'lostpointercapture' && !event.captured),
      `Native capture loss must reach the Canvas before cancellation is checked: ${JSON.stringify(trace)}`,
    );
  };
  try {
    await check({
      page,
      canvas,
      move,
      click,
      box,
      beginBox,
      glyphBounds,
      expectSelection,
      expectUnchanged,
      captured,
      releaseCapture,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors`);
    console.log(`Schematic selection: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'left drag selects unselected objects and moves only selected objects by default',
    async (t) => {
      await t.beginBox(first, { x: 63, y: 31 });
      assert.equal(await t.canvas.getByTestId('schematic-selection-box').count(), 1);
      await t.page.mouse.up();
      await t.expectSelection([], 'Neither partially contained symbol moves or selects.');
      await t.expectUnchanged();
      await t.click(first);
      await t.move(first);
      await t.page.mouse.down();
      await t.move({ x: first.x + 5.08, y: first.y + 2.54 });
      assert.equal(await t.canvas.getByTestId('schematic-selection-box').count(), 0);
      await t.canvas.press('Escape');
      await t.page.mouse.up();
      await t.expectSelection([first.id]);
      await t.expectUnchanged();
    },
  );

  await run(
    'selection-rectangle preference draws over selected objects and retains click modifiers',
    async (t) => {
      await t.click(first);
      await t.page.evaluate(() => window.setFixtureLeftButtonDrag('select'));
      await t.beginBox(first, { x: 63, y: 31 });
      assert.equal(await t.canvas.getByTestId('schematic-selection-box').count(), 1);
      await t.canvas.press('Escape');
      await t.page.mouse.up();
      await t.expectSelection([first.id]);
      await t.click(second, ['Shift']);
      await t.expectSelection([first.id, second.id]);
      await t.click(first, ['Control', 'Shift']);
      await t.expectSelection([second.id]);
      await t.expectUnchanged();
    },
  );

  await run('containment requires the complete symbol body and pins', async (t) => {
    await t.box({ x: 23.8, y: 24 }, { x: 27, y: 26.8 });
    await t.expectSelection([], 'An origin inside the box does not contain the symbol.');
    await t.box({ x: 23.8, y: 22.2 }, { x: 27, y: 28.5 });
    await t.expectSelection([], 'Containing the body alone does not contain its pin leads.');
    await t.box(...firstBox);
    await t.expectSelection([first.id]);
    await t.expectUnchanged();
  });

  await run('marquee feedback distinguishes containment from crossing', async (t) => {
    await t.beginBox(...firstBox);
    const marquee = t.canvas.getByTestId('schematic-selection-box');
    assert.equal(await marquee.getAttribute('data-crossing'), 'false');
    assert.equal(await marquee.getAttribute('stroke-dasharray'), null);
    await t.canvas.press('Escape');
    await t.page.mouse.up();
    await t.beginBox(firstBox[1], firstBox[0]);
    assert.equal(await marquee.getAttribute('data-crossing'), 'true');
    assert.ok(await marquee.getAttribute('stroke-dasharray'));
    await t.canvas.press('Escape');
    await t.page.mouse.up();
    await t.expectSelection([]);
    await t.expectUnchanged();
  });

  await run(
    'crossing selects intersecting wires and rejects diagonal bounding boxes',
    async (t) => {
      await t.box({ x: 30, y: 43 }, { x: 25, y: 47 });
      await t.expectSelection([doc.wires[0].id], 'Neither wire endpoint lies inside this box.');
      await t.box({ x: 25, y: 43 }, { x: 30, y: 47 });
      await t.expectSelection([], 'Containment requires both wire endpoints.');
      await t.box({ x: 60, y: 40 }, { x: 55, y: 43 });
      await t.expectSelection([], 'A diagonal segment does not occupy every point of its bounds.');
      await t.box({ x: 61, y: 49 }, { x: 59, y: 51 });
      await t.expectSelection([doc.wires[1].id]);
      await t.expectUnchanged();
    },
  );

  await run('Reference and Value glyphs select independently of the body', async (t) => {
    for (const [testId, id] of [
      [`annotation-ref-${first.ref}`, firstReference],
      [`annotation-value-${first.ref}`, firstValue],
    ]) {
      const b = await t.glyphBounds(testId);
      await t.box({ x: b.left - 0.2, y: b.top - 0.2 }, { x: b.right + 0.2, y: b.bottom + 0.2 });
      await t.expectSelection([id]);
      await t.box(
        { x: b.right + 0.1, y: b.top + (b.bottom - b.top) / 3 },
        { x: b.left + (b.right - b.left) / 2, y: b.bottom - 0.1 },
      );
      await t.expectSelection([id], 'Crossing any glyph portion selects only that field.');
    }
    await t.expectUnchanged();
  });

  await run('click modifiers add, toggle and subtract without moving objects', async (t) => {
    await t.click(first);
    await t.click(first, ['Shift']);
    await t.expectSelection([first.id], 'Shift on an already selected object keeps it selected.');
    await t.click(second, ['Shift']);
    await t.expectSelection([first.id, second.id]);
    await t.click(first, ['Control']);
    await t.expectSelection([second.id]);
    await t.click(first, ['Control']);
    await t.expectSelection([first.id, second.id]);
    await t.click(first, ['Control', 'Shift']);
    await t.expectSelection([second.id]);
    await t.click(first, ['Control', 'Shift']);
    await t.expectSelection([second.id], 'Subtracting an unselected object does not add it.');
    await t.expectUnchanged();
  });

  await run('rectangle modifiers match click selection', async (t) => {
    await t.click(first);
    await t.box(...firstBox, ['Shift']);
    await t.expectSelection([first.id]);
    await t.box(...secondBox, ['Shift']);
    await t.expectSelection([first.id, second.id]);
    await t.box(...firstBox, ['Control']);
    await t.expectSelection([second.id]);
    await t.box(...firstBox, ['Control']);
    await t.expectSelection([first.id, second.id]);
    await t.box(secondBox[1], secondBox[0], ['Control', 'Shift']);
    await t.expectSelection([first.id]);
    await t.box(...secondBox, ['Control', 'Shift']);
    await t.expectSelection([first.id]);
    await t.expectUnchanged();
  });

  await run(
    'rectangle modifiers preserve independent field hits until subtraction and toggle',
    async (t) => {
      const b = await t.glyphBounds(`annotation-ref-${first.ref}`);
      const reference = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
      await t.click(reference);
      await t.expectSelection([firstReference]);
      await t.box({ x: 22, y: 9 }, { x: 43, y: 31 }, ['Control', 'Shift']);
      await t.expectSelection(
        [],
        'Subtracting the owner and field removes an independently selected field.',
      );
      await t.click(reference);
      await t.expectSelection([firstReference]);
      await t.box({ x: 22, y: 9 }, { x: 43, y: 31 }, ['Control']);
      await t.expectSelection(
        [first.id],
        'Toggling the owner and fields leaves no redundant field selection.',
      );
      await t.box({ x: 22, y: 9 }, { x: 43, y: 31 }, ['Control']);
      await t.expectSelection(
        [],
        'Toggling a complete selected symbol off does not newly select its fields.',
      );
      await t.expectUnchanged();
    },
  );

  await run('modifier clicks on pin handles select the owner', async (t) => {
    await t.click(second);
    await t.click(pinPositions(first, doc.libraries[first.libId])[0], ['Shift']);
    await t.expectSelection([first.id, second.id]);
    assert.equal(await t.page.evaluate(() => window.selectionState.tool), 'select');
    await t.click(pinPositions(first, doc.libraries[first.libId])[0], ['Control', 'Shift']);
    await t.expectSelection([second.id]);
    assert.equal(await t.page.evaluate(() => window.selectionState.tool), 'select');
    await t.expectUnchanged();
  });

  await run('hidden layers stay out of clicks, rectangles and Select all', async (t) => {
    await t.page.evaluate(() =>
      window.setFixtureLayers({ symbols: false, references: false, wires: false }),
    );
    await t.click(first);
    await t.expectSelection([]);
    await t.click({ x: 20, y: 45 });
    await t.expectSelection([]);
    const b = await t.glyphBounds(`annotation-value-${first.ref}`);
    await t.box({ x: b.left - 0.2, y: b.top - 0.2 }, { x: b.right + 0.2, y: b.bottom + 0.2 });
    await t.expectSelection(
      [firstValue],
      'A visible field remains selectable with its body hidden.',
    );
    const visible = [firstValue, secondValue, doc.labels[0].id, doc.noConnects[0].id, noteId];
    await t.box({ x: 1, y: 1 }, { x: 92, y: 72 });
    await t.expectSelection(visible);
    await t.canvas.press('Control+a');
    await t.expectSelection(visible);
    await t.expectUnchanged();
  });

  await run(
    'selection filters leave drawing visible while excluding clicks, rectangles and Select all',
    async (t) => {
      const count = await t.canvas.locator('[data-selection-id]').count();
      await t.page.evaluate(() =>
        window.setFixtureSelectionFilters({
          symbols: false,
          wires: false,
          labels: false,
          noConnects: false,
        }),
      );
      await t.click(first);
      await t.expectSelection([]);
      await t.click({ x: 20, y: 45 });
      await t.expectSelection([]);
      const fields = [
        firstReference,
        firstValue,
        fieldId(second.id, 'Reference'),
        secondValue,
        noteId,
      ];
      await t.box({ x: 1, y: 1 }, { x: 92, y: 72 });
      await t.expectSelection(fields);
      await t.canvas.press('Control+a');
      await t.expectSelection(fields);
      assert.equal(await t.canvas.locator('[data-selection-id]').count(), count);
      assert.equal(await t.canvas.getByTestId(`symbol-hit-${first.ref}`).isVisible(), true);
      await t.expectUnchanged();
    },
  );

  await run(
    'text filters exclude independent fields and notes while symbols remain selectable',
    async (t) => {
      await t.page.evaluate(() => window.setFixtureSelectionFilters({ text: false }));
      const b = await t.glyphBounds(`annotation-ref-${first.ref}`);
      await t.click({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
      await t.expectSelection([]);
      await t.click(first);
      await t.expectSelection([first.id]);
      await t.canvas.press('Control+a');
      await t.expectSelection([
        first.id,
        second.id,
        ...doc.wires.map((wire) => wire.id),
        doc.junctions[0].id,
        doc.labels[0].id,
        doc.noConnects[0].id,
      ]);
      await t.expectUnchanged();
    },
  );

  await run('filtered hover cannot start a keyboard pickup or transform', async (t) => {
    await t.page.evaluate(() => window.setFixtureSelectionFilters({ symbols: false }));
    await t.move(first);
    await t.canvas.press('m');
    assert.equal(await t.canvas.getAttribute('data-move-preview'), null);
    await t.canvas.press('r');
    await t.expectSelection([]);
    await t.expectUnchanged();
  });

  await run('selection filters retain pin wiring targets', async (t) => {
    await t.page.evaluate(() =>
      window.setFixtureSelectionFilters({
        symbols: false,
        wires: false,
        labels: false,
        text: false,
        noConnects: false,
      }),
    );
    const targets = t.canvas.locator('[data-probe-pin]');
    assert.ok((await targets.count()) > 0);
    for (const tool of ['select', 'wire', 'no-connect']) {
      await t.page.evaluate((tool) => window.setFixtureTool(tool), tool);
      await t.page.waitForFunction((tool) => window.selectionState.tool === tool, tool);
      const paint = await targets.evaluateAll((nodes) =>
        nodes.map((node) => ({
          fill: getComputedStyle(node).fill,
          stroke: getComputedStyle(node).stroke,
          pointerEvents: getComputedStyle(node).pointerEvents,
          excludedFromExport: node.hasAttribute('data-export-exclude'),
        })),
      );
      assert.ok(
        paint.every(
          (target) =>
            target.fill === 'rgba(0, 0, 0, 0)' &&
            target.stroke === 'none' &&
            target.pointerEvents === 'all' &&
            target.excludedFromExport,
        ),
        `${tool}: pin targets remain usable without drawing terminal rings.`,
      );
    }
    await t.page.evaluate(() => window.setFixtureTool('select'));
    await t.page.waitForFunction(() => window.selectionState.tool === 'select');
    await t.click(pinPositions(first, doc.libraries[first.libId])[0]);
    assert.equal(await t.page.evaluate(() => window.selectionState.tool), 'wire');
    await t.expectSelection([]);
    await t.expectUnchanged();
  });

  await run(
    'Select all includes visible design objects with owner fields deduplicated',
    async (t) => {
      await t.canvas.press('Control+a');
      await t.expectSelection([
        first.id,
        second.id,
        ...doc.wires.map((wire) => wire.id),
        doc.junctions[0].id,
        doc.labels[0].id,
        doc.noConnects[0].id,
        noteId,
      ]);
      await t.expectUnchanged();
      assert.equal(
        await t.canvas
          .locator('[data-selection-id]')
          .evaluateAll((nodes) =>
            nodes.some((node) => node.dataset.selectionId.startsWith('field/')),
          ),
        true,
        'The fixture contains independently selectable fields.',
      );
    },
  );

  for (const cancellation of [
    'Escape',
    'pointer cancel',
    'lost capture',
    'deactivation',
    'layers',
    'filters',
    'replacement',
  ]) {
    await run(`${cancellation} cancels a rectangle before selection or data changes`, async (t) => {
      await t.click(first);
      await t.beginBox(...secondBox);
      assert.equal(await t.captured(), true);
      assert.equal(await t.canvas.getByTestId('schematic-selection-box').count(), 1);
      let expected = doc;
      if (cancellation === 'Escape') await t.canvas.press('Escape');
      else if (cancellation === 'pointer cancel')
        await t.canvas.evaluate((svg) =>
          svg.dispatchEvent(
            new PointerEvent('pointercancel', {
              bubbles: true,
              pointerId: window.selectionPointerId,
            }),
          ),
        );
      else if (cancellation === 'lost capture') {
        await t.releaseCapture({ x: 64, y: 32 });
      } else if (cancellation === 'deactivation')
        await t.page.evaluate(() => window.setFixtureActive(false));
      else if (cancellation === 'layers')
        await t.page.evaluate(() => window.setFixtureLayers({ values: false }));
      else if (cancellation === 'filters')
        await t.page.evaluate(() => window.setFixtureSelectionFilters({ text: false }));
      else {
        expected = { ...doc, title: 'Replacement schematic' };
        await t.page.evaluate((next) => window.replaceFixtureDoc(next), expected);
      }
      await t.canvas.getByTestId('schematic-selection-box').waitFor({ state: 'detached' });
      await t.page.mouse.up();
      await t.expectSelection([first.id]);
      assert.equal(await t.captured(), false);
      await t.expectUnchanged(expected);
    });
  }

  await run('Escape cancels a symbol move preview without a commit', async (t) => {
    await t.click(first);
    await t.move(first);
    await t.page.mouse.down();
    await t.move({ x: first.x + 5.08, y: first.y + 2.54 });
    assert.equal(await t.captured(), true);
    await t.canvas.press('Escape');
    await t.page.mouse.up();
    await t.expectSelection([first.id]);
    await t.expectUnchanged();
  });

  await run(
    'native capture loss cancels a symbol move before further motion or commit',
    async (t) => {
      const hit = t.canvas.getByTestId(`symbol-hit-${first.ref}`);
      const originalTransform = await hit.getAttribute('transform');
      await t.click(first);
      await t.move(first);
      await t.page.mouse.down();
      await t.move({ x: first.x + 5.08, y: first.y + 2.54 });
      assert.equal(await t.captured(), true);
      assert.notEqual(await hit.getAttribute('transform'), originalTransform);
      await t.releaseCapture({ x: first.x + 10.16, y: first.y + 5.08 });
      await t.page.mouse.up();
      assert.equal(await hit.getAttribute('transform'), originalTransform);
      assert.equal(await t.captured(), false);
      await t.expectSelection([first.id]);
      await t.expectUnchanged();
    },
  );
} finally {
  await browser.close();
}
