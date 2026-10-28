import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { BoxGeometry } from 'three';
import { tsImport } from 'tsx/esm/api';
import { selectModelView } from './visualization-test-helpers.mjs';

const { emptyCircuit, createPart, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { defaultSchematicLayers } = await tsImport('../lib/schematic-layers.ts', import.meta.url);
const { fieldId } = await tsImport('../lib/schematic-edit.ts', import.meta.url);
const doc = emptyCircuit();
const noteId = uid();
const neutralNoteIds = [uid(), uid()];
doc.parts.push(createPart(doc, 'R', 20.32, 20.32), createPart(doc, 'C', 50.8, 20.32));
doc.parts[0].fields = { Footprint: 'Test:Physical' };
doc.parts[1].fields = { Footprint: '' };
doc.wires = [{ id: 'wire', a: { x: 10, y: 45 }, b: { x: 50, y: 45 } }];
doc.labels = [{ id: 'label', x: 60, y: 20, text: 'OUT', scope: 'global' }];
doc.junctions = [{ id: 'junction', x: 65, y: 45 }];
doc.noConnects = [{ id: 'nc', x: 70, y: 32 }];
doc.original = [
  'kicad_sch',
  [
    'text',
    '"Note"',
    ['at', '60', '55', '0'],
    ['effects', ['font', ['size', '2', '2'], ['color', '160', '70', '30', '0.7']]],
    ['uuid', JSON.stringify(noteId)],
  ],
];
doc.original.push(
  ...neutralNoteIds.map((id, i) => [
    'text',
    JSON.stringify(i ? 'White note' : 'Black note'),
    ['at', String(20 + i * 20), '55', '0'],
    [
      'effects',
      ['font', ['size', '2', '2'], ['color', ...[i * 255, i * 255, i * 255, 1].map(String)]],
    ],
    ['uuid', JSON.stringify(id)],
  ]),
);
const board = createEmptyPCB();
board.graphics = [
  {
    id: 'edge',
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x: 0, y: 0 },
    points: [
      { x: 60, y: 0 },
      { x: 60, y: 35 },
    ],
    end: { x: 0, y: 35 },
  },
];
board.footprints = [15, 45].map((x, i) => ({
  id: uid(),
  libraryId: 'Test:Highlight',
  symbolId: null,
  reference: `U${i + 1}`,
  x,
  y: 17.5,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: `pad-${i}`,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 2, y: 2 },
      netId: null,
    },
  ],
  models: [
    {
      path: 'Fixture.step',
      offset: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  ],
}));
const geometry = new BoxGeometry(8, 6, 3).translate(0, 0, 1.5);
const model = {
  meshes: [
    {
      color: [0.1, 0.35, 0.15],
      attributes: {
        position: { array: Array.from(geometry.attributes.position.array) },
        normal: { array: Array.from(geometry.attributes.normal.array) },
      },
      index: { array: Array.from(geometry.index.array) },
    },
  ],
};
geometry.dispose();

// Isolated fixtures, real SVG/WebGL pixels and pointer events; no Electron or user files.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import Canvas from './components/Canvas';import PCBModelPreview from './components/PCBModelPreview';
    import {captureSchematicPNG} from './lib/drawing-export';
    function Test(){const [mode,setMode]=useState('schematic');const [selection,setSelection]=useState([]);
      const [annotations,setAnnotations]=useState([]);const [tool,setTool]=useState('select');
      window.showMode=setMode;window.setSchematicSelection=setSelection;window.inspectSchematic=()=>({selection,doc:window.fixture.doc});
      window.captureSchematic=()=>captureSchematicPNG(document.querySelector('[data-testid="schematic-canvas"]'));
      return mode==='schematic'?<Canvas doc={window.fixture.doc} selection={selection} onSelection={setSelection}
        onSelect={id=>setSelection(id?[id]:[])} tool={tool} setTool={setTool} kind="R"
        initialViewport={{view:{x:0,y:0,width:90},ratio:2/3,canvasWidth:1080,zoomBaseWidth:1080}}
        layers={window.fixture.layers} grid={false} gridSpacing={1.27} fitKey={0} onPosition={()=>{}}
        onCommit={()=>{window.commits++;return true}} annotations={annotations} annotationSessionId="highlight"
        onAnnotationsChange={setAnnotations}/>
        :<PCBModelPreview board={window.fixture.board} schematic={window.fixture.doc} annotationProps={{
          sessionId:'model-highlight',annotations,onChange:setAnnotations}}/>;}
    createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/editor-highlight/bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'inspect-retained-model',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: file }) => ({
          contents: (await readFile(file, 'utf8')).replace(
            'redraw.current = render;',
            `redraw.current = render; window.inspectModel=()=>({scene,components,camera,orbit,renderer,selection:selectionRef.current});`,
          ),
          loader: 'tsx',
          resolveDir: path.dirname(file),
        }));
      },
    },
  ],
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
await mkdir('test-results/editor-highlight', { recursive: true });
const pixels = async (dataUrl) =>
  sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
    .raw()
    .toBuffer();
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 720 },
      colorScheme: theme,
    });
    const errors = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    await page.route('http://localhost/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/libraries/footprints')
        return route.fulfill({
          json: { footprint: ['footprint', '"Highlight"', ['model', '"Fixture.step"']] },
        });
      if (url.pathname === '/api/library-model') return route.fulfill({ json: model });
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.goto('http://localhost');
    await page.evaluate(
      (fixture) => {
        window.fixture = fixture;
        window.commits = 0;
        document.documentElement.dataset.theme = fixture.theme;
        window.openpe = {
          connection: async () => ({ base: 'http://localhost', token: 'test' }),
          exportImage: async (image) => {
            window.exportedImage = image;
            return { name: 'highlight.png' };
          },
        };
      },
      { doc, board, layers: defaultSchematicLayers, theme },
    );
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({ content: 'html,body,#root{height:100%;margin:0}' });
    for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
      await page.addStyleTag({ content: output.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
    });
    const canvas = page.getByTestId('schematic-canvas');
    await canvas.waitFor();
    await page.waitForFunction(
      (theme) => document.querySelector('.canvas-wrap')?.dataset.schematicTheme === theme,
      theme,
    );
    const capture = async () =>
      pixels((await page.evaluate(() => window.captureSchematic())).dataUrl);
    const originalExport = await capture();
    const pixel = async (x, y) => {
      const point = await canvas.evaluate(
        (svg, p) => {
          const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
          return { x: q.x, y: q.y };
        },
        { x, y },
      );
      const { data, info } = await sharp(await page.screenshot())
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (Math.round(point.y) * info.width + Math.round(point.x)) * info.channels;
      return [...data.subarray(at, at + 3)];
    };
    const baseWire = await pixel(30, 45),
      outsideWire = await pixel(30, 45.4);
    const originalTargets = await canvas.locator('[data-selection-id]').count();
    await canvas.screenshot({ path: `test-results/editor-highlight/${theme}-schematic-base.png` });
    await page.evaluate(
      (ids) => window.setSchematicSelection(ids),
      [
        doc.parts[0].id,
        doc.parts[1].id,
        'wire',
        'label',
        'junction',
        'nc',
        noteId,
        ...neutralNoteIds,
      ],
    );
    const selectedWire = await pixel(30, 45);
    assert.notDeepEqual(selectedWire, baseWire);
    assert.ok(
      Math.max(...baseWire.map((value, i) => Math.abs(selectedWire[i] - value))) >= 60,
      'Selected wire colour must differ clearly, beyond a small brightness change.',
    );
    assert.ok(theme === 'dark' ? selectedWire[1] > baseWire[1] : selectedWire[1] < baseWire[1]);
    assert.deepEqual(await pixel(30, 45.4), outsideWire, 'Selection adds no wider halo.');
    assert.equal(
      await canvas.locator('[data-selection-id]').count(),
      originalTargets,
      'Paint copies introduce no selection targets.',
    );
    assert.equal(
      await canvas
        .locator('[data-selection-only] *')
        .evaluateAll((nodes) =>
          nodes.some((node) => getComputedStyle(node).pointerEvents !== 'none'),
        ),
      false,
      'Selected paint cannot intercept pointer targets, including glyphs with hit-testing classes.',
    );
    assert.equal(await canvas.locator('filter').count(), 0, 'The old blue contour is absent.');
    const contrast = await canvas.evaluate((svg) => {
      const sample = document.createElement('canvas').getContext('2d');
      const rgb = (color) => {
        sample.clearRect(0, 0, 1, 1);
        sample.fillStyle = color;
        sample.fillRect(0, 0, 1, 1);
        return [...sample.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      return [
        ...svg.querySelectorAll('[data-symbol-role="physical"], [data-testid="no-connect-nc"]'),
      ]
        .filter((node) => !node.closest('[data-selection-only]'))
        .map((node) => {
          const wrapper = node.closest('[style*="--selection-source-wire"]');
          const selected = wrapper.querySelector('[data-selection-only]');
          const original = rgb(getComputedStyle(node).stroke);
          const painted = rgb(
            getComputedStyle(
              selected.querySelector('[data-symbol-role]') || selected.firstElementChild,
            ).stroke,
          );
          if (Math.max(...original) - Math.min(...original) >= 24)
            throw new Error('Physical symbols and markers must use neutral base paint.');
          if (!(painted[2] > painted[0] && painted[2] > painted[1]))
            throw new Error('Neutral symbols and markers must use blue selected paint.');
          return Math.max(...original.map((value, i) => Math.abs(value - painted[i])));
        });
    });
    assert.ok(
      contrast.length >= 1 && contrast.every((difference) => difference >= 100),
      'Neutral symbols use a distinct selection colour on both canvas themes.',
    );
    for (const id of neutralNoteIds) {
      const paints = await canvas.locator(`[data-selection-id="${id}"]`).evaluate((text) => {
        const overlay = text.parentElement.querySelector('[data-selection-only] text');
        return {
          original: getComputedStyle(text).fill,
          selected: getComputedStyle(overlay).fill,
          opacity: getComputedStyle(text).fillOpacity,
          selectedOpacity: getComputedStyle(overlay).fillOpacity,
        };
      });
      assert.notEqual(
        paints.selected,
        paints.original,
        'Native black/white notes remain distinguishable when selected.',
      );
      assert.equal(paints.selectedOpacity, paints.opacity);
    }
    for (const selector of [
      '[data-symbol-role="physical"]',
      '[data-symbol-role="virtual"]',
      '.schematic-ref',
      '.schematic-value',
      '.global-net-label',
    ]) {
      const paint = await canvas.locator(selector).evaluateAll((nodes) =>
        nodes.map((node) => ({
          selected: !!node.closest('[data-selection-only]'),
          color: getComputedStyle(node).color,
          fill: getComputedStyle(node).fill,
        })),
      );
      const original = paint.find((node) => !node.selected),
        selected = paint.find((node) => node.selected);
      assert.ok(original && selected, `${selector} retains base and selected paint.`);
      assert.notDeepEqual([selected.color, selected.fill], [original.color, original.fill]);
    }
    assert.deepEqual(
      await capture(),
      originalExport,
      'Schematic export uses unselected semantic colours.',
    );
    await canvas.screenshot({ path: `test-results/editor-highlight/${theme}-schematic.png` });
    await page.evaluate(
      (id) => window.setSchematicSelection([id]),
      fieldId(doc.parts[0].id, 'Value'),
    );
    assert.equal(
      await canvas.locator('[data-selection-only]').count(),
      1,
      'A selected field highlights only itself.',
    );
    assert.equal(await page.evaluate(() => window.commits), 0);
    assert.deepEqual((await page.evaluate(() => window.inspectSchematic())).doc, doc);
    console.log(`Editor highlights: ${theme} Schematic pixels, fields and clean PNG passed.`);

    await page.evaluate(() => window.showMode('model'));
    await page.getByRole('region', { name: '3D board preview' }).waitFor();
    await page.waitForFunction(
      () => window.inspectModel && !document.querySelector('.pcb-model-status'),
    );
    const button = (name) => page.getByRole('button', { name, exact: true });
    await selectModelView(page, 'Top view');
    await page.waitForFunction(() => {
      const { camera, orbit } = window.inspectModel();
      return (
        Math.abs(camera.position.x - orbit.target.x) < 0.01 &&
        Math.abs(camera.position.y - orbit.target.y) < 0.01
      );
    });
    await page.evaluate(() => {
      const { components, renderer, camera, orbit } = window.inspectModel();
      window.originalModel = {
        canvas: renderer.domElement,
        camera: camera.position.toArray(),
        target: orbit.target.toArray(),
        materials: components.children
          .filter((o) => o.visible)
          .map((o) => o.children[0]?.children[0]?.material),
      };
    });
    const bodyPoint = async (index) =>
      page.evaluate((index) => {
        const { components, camera, renderer } = window.inspectModel();
        const object = components.children.find(
          (o) => o.visible && o.userData.footprintId === window.fixture.board.footprints[index].id,
        );
        const p = object.position.clone();
        p.z += 2;
        p.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return {
          x: rect.left + ((p.x + 1) * rect.width) / 2,
          y: rect.top + ((1 - p.y) * rect.height) / 2,
        };
      }, index);
    const modelCanvas = page.locator('.pcb-model-canvas canvas');
    const before = await modelCanvas.screenshot();
    await button('Export image').click();
    const baseModelExport = await page.evaluate(() => window.exportedImage.dataUrl);
    const meshColors = () =>
      page.evaluate(() => {
        const { components } = window.inspectModel();
        return components.children
          .filter((o) => o.visible)
          .map((o) => {
            const mesh = o.children[0].children[0];
            return { id: o.userData.footprintId, color: mesh.material[0].color.toArray() };
          });
      });
    const baseColors = await meshColors();
    const first = await bodyPoint(0);
    await page.mouse.click(first.x, first.y);
    await page
      .waitForFunction(
        () => {
          const { components } = window.inspectModel();
          const mesh = components.children.find(
            (o) => o.visible && o.userData.footprintId === window.fixture.board.footprints[0].id,
          ).children[0].children[0];
          return mesh.material !== window.originalModel.materials[0];
        },
        undefined,
        { timeout: 5000 },
      )
      .catch(async (error) => {
        console.error(await page.evaluate(() => window.inspectModel().selection));
        throw error;
      });
    assert.ok(
      !before.equals(await modelCanvas.screenshot()),
      'The actual WebGL image highlights the selected model.',
    );
    const selectedColors = await meshColors();
    assert.notDeepEqual(selectedColors[0], baseColors[0]);
    assert.deepEqual(
      selectedColors[1],
      baseColors[1],
      'Another instance of the same STEP template stays unchanged.',
    );
    assert.ok(
      theme === 'dark'
        ? selectedColors[0].color[1] > baseColors[0].color[1]
        : selectedColors[0].color[1] < baseColors[0].color[1],
    );
    await button('Export image').click();
    assert.deepEqual(
      await pixels(await page.evaluate(() => window.exportedImage.dataUrl)),
      await pixels(baseModelExport),
    );
    assert.deepEqual(
      await meshColors(),
      selectedColors,
      'Export restores the live selected materials.',
    );
    console.log(
      `Editor highlights: ${theme} Model selection, material isolation and clean PNG passed.`,
    );
    await modelCanvas.screenshot({ path: `test-results/editor-highlight/${theme}-model.png` });
    await button('Annotation mode').click();
    await page
      .getByLabel('3D annotation canvas', { exact: true })
      .locator(`[data-selection-id="${board.footprints[0].id}"]`)
      .waitFor();
    const annotationPoint = await bodyPoint(0);
    await page.mouse.click(annotationPoint.x, annotationPoint.y);
    await page
      .getByRole('textbox', { name: 'Annotation comment', exact: true })
      .waitFor({ timeout: 5000 })
      .catch(async (error) => {
        console.error(await page.locator('.annotation-error').allTextContents());
        console.error(
          await page.evaluate(() => ({
            selection: window.inspectModel().selection,
            count: document.querySelectorAll('.pcb-object-annotations [data-selection-id]').length,
          })),
        );
        throw error;
      });
    assert.notDeepEqual(
      (await meshColors())[0],
      baseColors[0],
      `Annotation selection uses the same model material highlight: ${JSON.stringify(await page.evaluate(() => window.inspectModel().selection))}`,
    );
    await page
      .getByRole('textbox', { name: 'Annotation comment', exact: true })
      .fill('Check this package.');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await button('Interaction mode').click();
    await page.locator('.pcb-model-canvas').press('Escape');
    assert.deepEqual(await meshColors(), baseColors);
    assert.equal(
      await page.evaluate(
        () => window.originalModel.canvas === window.inspectModel().renderer.domElement,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      `Editor highlights: ${theme} semantic paint, material isolation, annotation selection and clean PNG exports.`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
