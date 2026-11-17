import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, pinPositions, snap, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { defaultSchematicLayers } = await tsImport('../lib/schematic-layers.ts', import.meta.url);
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { schematicTexts } = await tsImport('../lib/schematic-text.ts', import.meta.url);
const doc = emptyCircuit();
for (let index = 0; index < 40; index++)
  doc.parts.push(
    createPart(doc, 'R', 25.4 + (index % 10) * 15.24, 25.4 + Math.floor(index / 10) * 20.32),
  );
const first = doc.parts[0];
const firstPins = pinPositions(first, doc.libraries[first.libId]);
doc.wires = [{ id: uid(), a: firstPins[1], b: { x: firstPins[1].x, y: 38.1 } }];
// Exercise separate stationary leads on both resistor terminals.
doc.wires.push({
  id: uid(),
  a: { x: firstPins[0].x + 0.00005, y: firstPins[0].y },
  b: { x: firstPins[0].x + 5.08, y: firstPins[0].y },
});
const emc = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).schematic;
const fixtures = [
  { name: '40-part fixture', doc, first },
  { name: 'EMC Flyback', doc: emc, first: emc.parts.find((part) => part.ref === 'R1') },
];
const renderMode = process.env.OPENPE_RENDER_MODE === 'development' ? 'development' : 'production';

// Count real render/geometry work while driving the real Canvas. All data stays
// in memory; no Electron, service, provider, solver or user files are involved.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import Canvas from './components/Canvas';
      function Fixture(){
        const [doc,setDoc]=useState(window.fixture.doc),[selection,setSelection]=useState([]),
          [tool,setTool]=useState('select'),[layers,setLayers]=useState(window.fixture.layers);
        const [moveRequest,setMoveRequest]=useState(null);
        window.canvasState={doc,selection,tool};
        window.setCanvasSelection=setSelection;
        window.setCanvasTool=setTool;
        window.requestCanvasMove=connected=>setMoveRequest({id:++window.moveRequestId,schematicId:doc.id,connected});
        window.updateCanvasPart=changes=>setDoc(previous=>({...previous,parts:previous.parts.map(
          part=>part.id===window.fixture.first.id?{...part,...changes}:part)}));
        window.setCanvasLayers=changes=>setLayers(previous=>({...previous,...changes}));
        window.refreshCanvasWrappers=()=>setDoc(previous=>({...previous,
          junctions:previous.junctions.map(junction=>({...junction})),
          original:previous.original?[...previous.original]:undefined}));
        window.updateCanvasNativeNote=text=>setDoc(previous=>{
          let changed=false;
          return {...previous,original:previous.original?.map(node=>{
            if(changed||!Array.isArray(node)||node[0]!=='text') return node;
            changed=true; return [node[0],JSON.stringify(text),...node.slice(2)];
          })};
        });
        return <Canvas leftButtonDrag="drag-any" active doc={doc} selection={selection} onSelection={setSelection}
          onSelect={id=>setSelection(id?[id]:[])} tool={tool} setTool={setTool} kind="R"
          moveRequest={moveRequest}
          initialViewport={{view:{x:0,y:0,width:200},ratio:2/3,canvasWidth:1200,zoomBaseWidth:1200}}
          annotations={[]} annotationSessionId="performance" onAnnotationsChange={()=>{}} fitKey={0} onPosition={point=>{window.pointerReadout=point}}
          onCommit={next=>{window.commitAttempts++;window.attemptedPreview=next;
            if(window.rejectCommit) return false;
            window.commits++;flushSync(()=>setDoc(next));return true}}
          grid={false} gridSpacing={1.27} layers={layers}/>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
  jsxDev: renderMode === 'development',
  define: { 'process.env.NODE_ENV': JSON.stringify(renderMode) },
  plugins: [
    {
      name: 'count-canvas-work',
      setup(plugin) {
        plugin.onLoad(
          {
            filter:
              /[\\/](Canvas\.tsx|CanvasAnnotations\.tsx|SchematicDrawing\.tsx|SchematicText\.tsx|useRetainedElements\.ts|SymbolGraphic\.tsx|circuit\.ts|library\.ts|schematic-text\.ts|schematic-view\.ts|schematic-wire-target\.ts)$/,
          },
          async ({ path: file }) => {
            const original = await readFile(file, 'utf8');
            const counters = {
              'SymbolGraphic.tsx': [
                [
                  '    return symbolGraphic(',
                  'if(part) window.canvasWork.symbols[part.id]=(window.canvasWork.symbols[part.id]||0)+1;',
                ],
              ],
              'schematic-view.ts': [
                ['  const pins = doc.parts.flatMap', 'window.canvasWork.junctions++;'],
              ],
              'schematic-wire-target.ts': [
                ['  const positions = pinPositions(part, library),', 'window.canvasWork.pins++;'],
              ],
              'library.ts': [
                [
                  "  const property = children(part.raw || library, 'property').find",
                  'window.canvasWork.annotations++;',
                ],
              ],
              'schematic-text.ts': [
                ["  return children(original || [], 'text').map", 'window.canvasWork.notes++;'],
                [
                  "  return children(original || [], 'polyline').map",
                  'window.canvasWork.polylines++;',
                ],
              ],
              'Canvas.tsx': [
                ['    for (const target of snapTargets) {', 'window.canvasObjects.snapSearches++;'],
                [
                  '  const svg = useRef<SVGSVGElement>(null);',
                  'window.canvasObjects.canvasRenders++; useCanvasCommitCounter(()=>{window.canvasObjects.canvasCommits++;});',
                ],
                [
                  '  const drawingIsDocument = drawing === doc;',
                  'window.canvasLive={drawing,doc,drag}; if(window.releaseSnapshots) window.releaseSnapshots.push({drawing,doc,drag});',
                ],
              ],
              'CanvasAnnotations.tsx': [
                ['    const shown = [', 'window.canvasObjects.annotationPresentations++;'],
              ],
              'circuit.ts': [
                ['  const source = serializeCircuit(d);', 'window.canvasObjects.fingerprints++;'],
              ],
              'SchematicDrawing.tsx': [
                ['  const x1 = wire.a.x + dx,', 'window.canvasObjects.wires++;'],
                ['  const hitPadding = useContext(HitPadding);', 'window.canvasObjects.hits++;'],
                ['  const part = useMemo(', 'window.canvasObjects.parts++;'],
                ['        const pin = dx || dy', 'window.canvasObjects.pins++;'],
                ['  const wires = useMemo(', 'window.canvasObjects.layers++;'],
              ],
              'useRetainedElements.ts': [
                ['    const element = render(props);', 'window.canvasObjects.elements++;'],
              ],
              'SchematicText.tsx': [
                ['  const lines = text.replace', 'window.canvasObjects.nativeTexts++;'],
              ],
            }[path.basename(file)];
            let contents =
              path.basename(file) === 'Canvas.tsx'
                ? `import {useLayoutEffect as useCanvasCommitCounter} from 'react';\n${original}`
                : original;
            if (path.basename(file) === 'Canvas.tsx') {
              const start = '  function move(e: React.PointerEvent<SVGSVGElement>) {';
              const end =
                '  }\n  function probeTarget(e: React.PointerEvent): ProbeTarget | null {';
              assert.ok(contents.includes(start) && contents.includes(end));
              contents = contents.replace(
                start,
                start + '\nconst panSample=Boolean(pan.current),panStarted=performance.now();try{',
              );
              contents = contents.replace(
                end,
                '    }finally{if(panSample)window.canvasPanDurations.push(performance.now()-panStarted);}\n' +
                  end,
              );
            }
            for (const [marker, counter] of counters) {
              assert.ok(
                contents.includes(marker),
                `Instrumentation is attached to ${path.basename(file)}.`,
              );
              contents = contents.replace(marker, `${counter}\n${marker}`);
            }
            return {
              contents,
              loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  for (const { name, doc, first } of fixtures) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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
        window.moveRequestId = 0;
        window.rejectCommit = false;
        window.canvasPanDurations = [];
        window.canvasWork = {
          symbols: {},
          junctions: 0,
          pins: 0,
          annotations: 0,
          notes: 0,
          polylines: 0,
        };
        window.canvasObjects = {
          wires: 0,
          parts: 0,
          hits: 0,
          pins: 0,
          layers: 0,
          fingerprints: 0,
          annotationPresentations: 0,
          elements: 0,
          nativeTexts: 0,
          canvasRenders: 0,
          canvasCommits: 0,
          clientRects: 0,
          snapSearches: 0,
          bboxes: 0,
        };
        const bounds = SVGSVGElement.prototype.getBoundingClientRect;
        SVGSVGElement.prototype.getBoundingClientRect = function (...args) {
          if (this.dataset.testid === 'schematic-canvas') window.canvasObjects.clientRects++;
          return bounds.apply(this, args);
        };
        const bbox = SVGGraphicsElement.prototype.getBBox;
        SVGGraphicsElement.prototype.getBBox = function (...args) {
          window.canvasObjects.bboxes++;
          return bbox.apply(this, args);
        };
      },
      { doc, first, layers: defaultSchematicLayers },
    );
    for (const file of ['app/globals.css', 'app/workspace.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addStyleTag({ content: 'html,body,#root,.canvas-wrap{height:100%;margin:0}' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('schematic-canvas');
    await canvas.waitFor();
    await page.waitForTimeout(100);
    const work = () => page.evaluate(() => structuredClone(window.canvasWork));
    const nextFrame = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    const before = await work();
    const objects = () => page.evaluate(() => structuredClone(window.canvasObjects));
    const beforeSelection = await objects();
    assert.equal(
      beforeSelection.fingerprints,
      0,
      'An empty inactive overlay does not fingerprint the document.',
    );
    assert.equal(
      beforeSelection.annotationPresentations,
      0,
      'An empty inactive overlay does not build hidden annotation controls.',
    );
    assert.equal(Object.keys(before.symbols).length, doc.parts.length);
    assert.ok(before.annotations >= doc.parts.length * 2);
    const originalView = await canvas.getAttribute('viewBox');
    for (let index = 0; index < 8; index++) {
      await page.evaluate((id) => window.setCanvasSelection([id]), doc.parts[index].id);
      await nextFrame();
    }
    const afterSelection = await objects();
    assert.equal(
      afterSelection.wires,
      beforeSelection.wires,
      'Part selection retains every wire SVG tree.',
    );
    assert.equal(
      afterSelection.parts - beforeSelection.parts,
      15,
      'Only selected/deselected parts redraw.',
    );
    assert.equal(
      afterSelection.elements - beforeSelection.elements,
      30,
      'Selection rebuilds only the affected part and annotation elements.',
    );
    assert.equal(
      afterSelection.nativeTexts,
      beforeSelection.nativeTexts,
      'Selecting parts retains the complete native text subtree.',
    );
    const beforeCamera = await objects();
    for (let index = 0; index < 3; index++) {
      await runCanvasAction(page, 'Zoom in');
      await runCanvasAction(page, 'Zoom out');
    }
    await page.mouse.move(600, 500);
    await page.mouse.down({ button: 'middle' });
    await nextFrame();
    const beforePan = await objects();
    await page.mouse.move(630, 520, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    await nextFrame();
    const afterCamera = await objects();
    assert.equal(
      afterCamera.snapSearches,
      beforePan.snapSearches,
      'Camera panning never searches electrical snap targets.',
    );
    assert.equal(afterCamera.fingerprints, 0);
    assert.equal(afterCamera.annotationPresentations, 0);
    assert.equal(afterCamera.wires, beforeCamera.wires, 'Camera changes retain wire SVG trees.');
    assert.equal(afterCamera.parts, beforeCamera.parts, 'Camera changes retain part SVG trees.');
    assert.equal(
      afterCamera.elements,
      beforeCamera.elements,
      'Camera changes retain drawing elements.',
    );
    assert.equal(
      afterCamera.pins,
      beforeCamera.pins,
      'Camera changes retain pin target SVG trees.',
    );
    assert.notEqual(
      await canvas.getAttribute('viewBox'),
      originalView,
      'Zoom controls update the camera.',
    );
    assert.deepEqual(
      await work(),
      before,
      'Selection, zoom and pan reuse glyphs, annotations, native notes and pin geometry.',
    );
    assert.equal(
      await canvas.locator('.part.is-selected').count(),
      1,
      'Selection styling still follows selection changes.',
    );
    assert.equal(await page.evaluate(() => window.commits), 0);

    // Panning navigates the current world pose without editing a live tool
    // preview. Exercise the actual wire and placement tools on both fixtures.
    for (const tool of ['wire', 'place']) {
      await page.evaluate((tool) => window.setCanvasTool(tool), tool);
      await nextFrame();
      const bounds = await canvas.boundingBox();
      const start = { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5 };
      await page.mouse.move(start.x, start.y);
      if (tool === 'wire') await page.mouse.click(start.x, start.y);
      await page.mouse.move(start.x + 38, start.y - 24);
      await nextFrame();
      const preview =
        tool === 'wire'
          ? canvas.getByTestId('schematic-wire-preview')
          : canvas.locator('g[data-export-exclude][opacity="0.55"]');
      const attribute = tool === 'wire' ? 'd' : 'transform';
      const pose = await preview.getAttribute(attribute);
      assert.ok(pose, `${tool} has a visible preview before camera navigation.`);
      const view = (await canvas.getAttribute('viewBox')).split(' ').map(Number);
      const from = { x: start.x + 38, y: start.y - 24 };
      await page.mouse.down({ button: 'middle' });
      await nextFrame();
      const before = await objects();
      await page.mouse.move(from.x + 45, from.y + 30, { steps: 8 });
      await page.mouse.up({ button: 'middle' });
      await nextFrame();
      assert.equal(
        await preview.getAttribute(attribute),
        pose,
        `${tool} retains its exact world-space preview during pan.`,
      );
      assert.equal((await objects()).snapSearches, before.snapSearches);
      const after = (await canvas.getAttribute('viewBox')).split(' ').map(Number);
      assert.ok(
        Math.abs(after[0] - view[0] + (45 * view[2]) / bounds.width) < 1e-9,
        'Pan uses the original pickup viewport without accumulated drift.',
      );
      assert.ok(Math.abs(after[1] - view[1] + (30 * view[2]) / bounds.width) < 1e-9);
      assert.deepEqual(
        await page.evaluate(() => window.pointerReadout),
        {
          x: snap(after[0] + ((from.x + 45 - bounds.x) / bounds.width) * after[2]),
          y: snap(after[1] + ((from.y + 30 - bounds.y) / bounds.width) * after[2]),
        },
        'The coordinate readout uses the displayed viewport.',
      );
      assert.equal(await page.evaluate(() => window.commits), 0);
      await canvas.press('Escape');
      await page.evaluate(() => window.setCanvasTool('select'));
      await nextFrame();
    }

    const beforeWrappers = await objects();
    await page.evaluate(() => window.refreshCanvasWrappers());
    await nextFrame();
    assert.equal(
      (await objects()).elements,
      beforeWrappers.elements,
      'Independent unchanged junction and native-note wrappers retain their SVG elements.',
    );
    assert.equal(
      (await objects()).nativeTexts,
      beforeWrappers.nativeTexts,
      'Native-root replacements with unchanged notes retain rendered text geometry.',
    );

    const beforeProperty = await objects();
    const previousRole = await canvas
      .getByTestId(`part-${first.ref}`)
      .locator('.symbol-graphic')
      .getAttribute('data-symbol-role');
    await page.evaluate(() => window.updateCanvasPart({ fields: { Footprint: 'Fixture:R' } }));
    await nextFrame();
    assert.equal(
      await canvas
        .getByTestId(`part-${first.ref}`)
        .locator('.symbol-graphic')
        .getAttribute('data-symbol-role'),
      'physical',
    );
    const changed = await work();
    assert.equal(
      (await objects()).elements - beforeProperty.elements,
      2,
      'One property edit rebuilds its part and annotation, retaining unrelated elements.',
    );
    assert.equal(
      changed.symbols[first.id],
      before.symbols[first.id] + Number(previousRole !== 'physical'),
      'Role changes redraw the glyph; assignments with the same role retain it.',
    );
    for (const part of doc.parts.filter((part) => part.id !== first.id))
      assert.equal(
        changed.symbols[part.id],
        before.symbols[part.id],
        'Unchanged parts retain their rendered glyphs.',
      );

    await page.evaluate(() => window.setCanvasLayers({ pinNumbers: false }));
    await nextFrame();
    const layersChanged = await work();
    for (const part of doc.parts)
      assert.equal(
        layersChanged.symbols[part.id],
        changed.symbols[part.id] + 1,
        'Pin display settings redraw every affected symbol.',
      );
    assert.equal(
      layersChanged.pins,
      changed.pins,
      'Display settings preserve physical pin geometry.',
    );
    assert.equal(layersChanged.annotations, changed.annotations);

    const notes = schematicTexts(doc.original);
    if (notes.length) {
      const beforeNoteChange = await work();
      await page.evaluate(() => window.updateCanvasNativeNote('Updated native note'));
      await nextFrame();
      assert.equal(
        await canvas.getByTestId(`schematic-text-${notes[0].id}`).textContent(),
        'Updated native note',
        'Native Source replacements invalidate note presentation.',
      );
      assert.ok((await work()).notes > beforeNoteChange.notes);
      assert.deepEqual((await work()).symbols, beforeNoteChange.symbols);
    }

    await runCanvasAction(page, 'Fit to canvas');
    assert.equal(
      (await objects()).fingerprints,
      0,
      'Property, layer and native-note updates keep the unused overlay idle.',
    );
    assert.equal((await objects()).annotationPresentations, 0);
    await page.evaluate((id) => window.setCanvasSelection([id]), first.id);
    await nextFrame();
    const beforeMove = await page.evaluate(() => structuredClone(window.canvasState.doc));
    const unchangedTransform = await canvas
      .getByTestId(`symbol-hit-${first.ref}`)
      .getAttribute('transform');
    for (const connected of [false, true]) {
      // A toolbar/menu request must not interpret its pointer as drawing input,
      // including when a closed popup uncovers the canvas beneath the pointer.
      await page.mouse.move(10, 10);
      await page.evaluate((connected) => window.requestCanvasMove(connected), connected);
      await page.waitForFunction(
        (mode) =>
          document
            .querySelector('[data-testid="schematic-canvas"]')
            ?.getAttribute('data-move-preview') === mode,
        connected ? 'drag' : 'move',
      );
      assert.equal(
        await canvas.getByTestId(`symbol-hit-${first.ref}`).getAttribute('transform'),
        unchangedTransform,
        `${name}: menu pickup retains the existing pose before drawing input.`,
      );
      await canvas.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.canvasState.doc), beforeMove);
      assert.equal(await page.evaluate(() => window.commitAttempts), 0);
    }
    const pin = canvas.locator(`[data-probe-part="${first.id}"][data-probe-pin="0"]`);
    const fromPin = {
      x: Number(await pin.getAttribute('cx')),
      y: Number(await pin.getAttribute('cy')),
    };
    const pinPaint = () =>
      pin.evaluate((node) => ({
        fill: getComputedStyle(node).fill,
        stroke: getComputedStyle(node).stroke,
        pointerEvents: getComputedStyle(node).pointerEvents,
        excludedFromExport: node.hasAttribute('data-export-exclude'),
      }));
    const originalPinPaint = await pinPaint();
    assert.deepEqual(
      originalPinPaint,
      {
        fill: 'rgba(0, 0, 0, 0)',
        stroke: 'none',
        pointerEvents: 'all',
        excludedFromExport: true,
      },
      'Pin targets remain interactive without drawing terminal rings.',
    );
    await pin.evaluate((node) => {
      window.retainedPinTarget = node;
    });
    const screen = (point) =>
      canvas.evaluate((svg, p) => {
        const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
        return { x: at.x, y: at.y };
      }, point);
    const at = await screen(first);
    await page.mouse.move(at.x, at.y);
    await canvas.focus();
    await page.keyboard.press('m');
    const target = await screen({ x: first.x + 5.08, y: first.y + 2.54 });
    await page.mouse.move(target.x, target.y);
    await nextFrame();
    assert.ok(
      Math.abs(Number(await pin.getAttribute('cx')) - fromPin.x - 5.08) < 1e-9,
      'Move previews translate cached pin hit targets.',
    );
    assert.ok(Math.abs(Number(await pin.getAttribute('cy')) - fromPin.y - 2.54) < 1e-9);
    assert.deepEqual(await pinPaint(), originalPinPaint, 'Moved pin targets stay invisible.');
    assert.equal(
      await pin.evaluate((node) => node === window.retainedPinTarget),
      true,
      'Move previews retain the existing pin hit target.',
    );
    await page.keyboard.press('Escape');
    await nextFrame();
    assert.deepEqual(
      await page.evaluate(() => window.canvasState.doc),
      beforeMove,
      'Cancelling a preview preserves the document.',
    );
    assert.equal(
      Number(await pin.getAttribute('cx')),
      fromPin.x,
      'Cancelled previews restore the original pin geometry.',
    );
    assert.equal(await page.evaluate(() => window.commits), 0);
    assert.deepEqual(await pinPaint(), originalPinPaint);
    assert.equal(await pin.evaluate((node) => node === window.retainedPinTarget), true);

    const startPointerDrag = async () => {
      const box = await canvas.getByTestId(`symbol-hit-${first.ref}`).boundingBox();
      assert.ok(box);
      const distance = await canvas.evaluate((svg) => 5.08 * svg.getScreenCTM().a);
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await nextFrame();
      const beforePointerMove = await objects();
      await page.mouse.move(from.x + distance, from.y);
      await nextFrame();
      assert.equal(
        (await objects()).clientRects - beforePointerMove.clientRects,
        1,
        'One pointer move reads canvas bounds once for readout and the exact drag pose.',
      );
      await page.evaluate(() => (window.expectedPreview = window.canvasLive.drawing));
    };
    const unchangedBeforeRejected = await page.evaluate(() =>
      structuredClone(window.canvasState.doc),
    );
    await page.evaluate(() => (window.rejectCommit = true));
    await startPointerDrag();
    await page.mouse.up();
    await nextFrame();
    assert.equal(
      await page.evaluate(() => window.attemptedPreview === window.expectedPreview),
      true,
    );
    assert.deepEqual(await page.evaluate(() => window.canvasState.doc), unchangedBeforeRejected);
    assert.equal(await page.evaluate(() => window.canvasLive.drag), null);
    assert.equal(await page.evaluate(() => window.commits), 0);
    const attempted = await page.evaluate(() => window.commitAttempts);
    await page.mouse.move(at.x + 10, at.y + 10);
    await nextFrame();
    assert.equal(
      await page.evaluate(() => window.commitAttempts),
      attempted,
      'Rejected release discards its gesture and cannot commit a stale preview on a later move.',
    );

    await page.evaluate(() => (window.rejectCommit = false));
    await startPointerDrag();
    const beforeRelease = await objects();
    await page.evaluate(() => (window.releaseSnapshots = []));
    await page.mouse.up();
    await nextFrame();
    assert.equal(
      await page.evaluate(() => window.attemptedPreview === window.expectedPreview),
      true,
    );
    assert.equal(await page.evaluate(() => window.commits), 1);
    assert.equal(
      (await objects()).canvasCommits - beforeRelease.canvasCommits,
      1,
      'Synchronous document publication and pointer cleanup share one Canvas commit.',
    );
    assert.equal(
      await page.evaluate(() =>
        window.releaseSnapshots.every(({ drawing, doc, drag }) => drag === null && drawing === doc),
      ),
      true,
      'No published document renders with the completed gesture or an earlier preview.',
    );
    assert.deepEqual(
      await page.evaluate(() => window.attemptedPreview.wires.map(({ id }) => id)),
      await page.evaluate(() => window.expectedPreview.wires.map(({ id }) => id)),
      'The commit keeps exactly the generated wire identities displayed in its final pose.',
    );
    await runCanvasAction(page, 'Fit to canvas');
    await nextFrame();
    await page.evaluate(() => window.setCanvasTool('annotate'));
    await nextFrame();
    const annotationTarget = await canvas.getByTestId(`symbol-hit-${first.ref}`).boundingBox();
    assert.ok(annotationTarget, 'Fit keeps the annotation target visible.');
    await page.mouse.move(
      annotationTarget.x + annotationTarget.width / 2,
      annotationTarget.y + annotationTarget.height / 2,
    );
    await nextFrame();
    await canvas.locator('.annotation-hover').waitFor();
    await page.mouse.down({ button: 'middle' });
    await nextFrame();
    const beforeAnnotationPan = await objects();
    await page.mouse.move(
      annotationTarget.x + annotationTarget.width / 2 + 30,
      annotationTarget.y + annotationTarget.height / 2 + 20,
      { steps: 6 },
    );
    await nextFrame();
    assert.equal(
      (await objects()).bboxes,
      beforeAnnotationPan.bboxes,
      'Pure pan reuses annotation world bounds without measuring glyphs again.',
    );
    await page.mouse.up({ button: 'middle' });
    assert.equal(
      await page.evaluate(() => window.commits),
      1,
      'Annotation camera navigation creates no document edit.',
    );
    assert.deepEqual(errors, []);
    const durations = await page.evaluate(() =>
      [...window.canvasPanDurations].sort((a, b) => a - b),
    );
    console.log(
      `${name}: ${doc.parts.length} symbols retain geometry; pan skips electrical snapping, preserves wire/place previews and reuses annotation bounds. Isolated ${renderMode} pan-handler p95=${durations[Math.floor(durations.length * 0.95)].toFixed(2)} ms, max=${durations.at(-1).toFixed(2)} ms (${durations.length} events). Properties, layers, Source and exact preview commits remain current.`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
