import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { readNativeFiles, readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

const { createProject } = await tsImport('../lib/project.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { parseKiCadPCB } = await tsImport('../lib/kicad-pcb.ts', import.meta.url);
const { serializePCB } = await tsImport('../lib/pcb.ts', import.meta.url);
const project = createProject();
project.name = 'Layout properties';
let board = (project.pcb = createEmptyPCB());
const ids = Object.fromEntries(
  ['net', 'footprint', 'smd', 'through', 'hole', 'via', 'track', 'line', 'text', 'rule'].map(
    (name) => [name, uid()],
  ),
);
board.nets = [{ id: ids.net, name: 'GND' }];
board.footprints = [
  {
    id: ids.footprint,
    symbolId: null,
    libraryId: 'Fixture:PadTypes',
    reference: 'J1',
    x: 20,
    y: 15,
    rotation: 0,
    side: 'front',
    graphics: [
      {
        id: uid(),
        start: { x: -3, y: -3 },
        end: { x: 19, y: -3 },
        width: 0.12,
        layer: 'F.SilkS',
      },
    ],
    pads: [
      {
        id: ids.smd,
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 3, y: 2 },
        solderMaskMargin: 0.05,
        netId: ids.net,
      },
      {
        id: ids.through,
        number: '2',
        x: 8,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        shape: 'circle',
        size: { x: 4, y: 4 },
        drill: 2,
        netId: ids.net,
      },
      {
        id: ids.hole,
        number: '',
        x: 16,
        y: 0,
        rotation: 0,
        type: 'np_thru_hole',
        shape: 'circle',
        size: { x: 3, y: 3 },
        drill: 3,
        netId: null,
      },
    ],
  },
];
board.vias = [{ id: ids.via, x: 35, y: 28, diameter: 1.2, drill: 0.6, netId: ids.net }];
board.tracks = [
  {
    id: ids.track,
    start: { x: 10, y: 30 },
    end: { x: 25, y: 30 },
    width: 0.4,
    layer: 'F.Cu',
    netId: ids.net,
  },
];
board.graphics = [
  {
    id: uid(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    start: { x: 0, y: 0 },
    points: [
      { x: 70, y: 0 },
      { x: 70, y: 50 },
    ],
    end: { x: 0, y: 50 },
    width: 0.1,
  },
  {
    id: ids.line,
    start: { x: 10, y: 40 },
    end: { x: 20, y: 40 },
    width: 0.2,
    layer: 'F.SilkS',
  },
  {
    id: ids.text,
    kind: 'text',
    start: { x: 35, y: 40 },
    end: { x: 35, y: 40 },
    width: 0.15,
    layer: 'F.SilkS',
    text: {
      value: 'TEST',
      rotation: 0,
      size: { x: 2, y: 2 },
      thickness: 0.15,
    },
  },
];
board.zones = [
  {
    id: ids.rule,
    netId: null,
    layer: 'F.Cu',
    outline: [
      { x: 45, y: 20 },
      { x: 55, y: 20 },
      { x: 55, y: 30 },
      { x: 45, y: 30 },
    ],
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    keepout: { tracks: false, vias: true, pads: true, copperpour: true, footprints: false },
  },
];
// Normalize the fixture through the supported native format before exercising
// edits so native net identities, captions and layer declarations are exact.
board = project.pcb = parseKiCadPCB(
  serializePCB(board, project.schematic),
  project.schematic,
  'layout-properties',
).board;
ids.net = board.nets[0].id;

// Real retained editors and ProjectCore with fixture-only host callbacks. No
// Electron, services, providers, native pickers or writes to user files.
const bundle = await build({
  stdin: {
    contents: `import React,{useEffect,useState,useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';
import LayoutEditor from './components/LayoutEditor';import SourceEditor from './components/SourceEditor';import{ProjectCore}from'./core/project-core';import{captureLayoutPNG}from'./lib/drawing-export';
function Fixture(){const[core]=useState(()=>new ProjectCore(window.fixture));
const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot,core.getSnapshot);
const[sourceView,setSourceView]=useState(false),[selectedFile,setSelectedFile]=useState('');
const files=core.getNativeFiles().files,selected=files.find(f=>f.name===selectedFile)||files[0];
useEffect(()=>{const save=event=>{if(!event.defaultPrevented&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();window.saves++;window.savedPCBSource=core.getNativeFiles().files.find(file=>file.name.endsWith('.kicad_pcb')).source}};window.addEventListener('keydown',save);return()=>window.removeEventListener('keydown',save)},[core]);
window.readLayoutState=()=>({board:core.getSnapshot().project.pcb,revision:core.getSnapshot().revision,commits:window.commits,error:window.commitError,saves:window.saves,savedPCBSource:window.savedPCBSource});
window.lockLayoutObjects=targets=>core.execute('layout.lock',{boardId:core.getSnapshot().project.pcb.id,targets,locked:true});
window.layoutImage=()=>captureLayoutPNG(document.querySelector('[data-testid="layout-canvas"]'),{minX:0,minY:0,maxX:70,maxY:50});
return <><nav className="fixture-navigation"><button onClick={()=>setSourceView(false)}>Layout</button><button onClick={()=>setSourceView(true)}>Source</button></nav>
<div className="fixture-editor" hidden={sourceView}><LayoutEditor board={snapshot.project.pcb} schematic={snapshot.project.schematic} active={!sourceView} visible={!sourceView}
onCommit={next=>{if(window.rejectCommit)return false;try{if(core.replaceBoard(next))window.commits++;window.commitError='';return true}catch(e){window.commitError=e.message;return false}}}
undoAction={<button aria-label="Undo" disabled={!snapshot.canUndo} onClick={()=>core.undo()}>Undo</button>}
annotations={[]} annotationSessionId="properties" onAnnotationsChange={()=>{}}/></div>
<div className="fixture-editor" hidden={!sourceView}><SourceEditor value={selected.source} pending={false} error="" active={sourceView} visible={sourceView}
files={files} activeFile={selected.name} onSelectFile={setSelectedFile} onChange={value=>core.updateNativeSource(selected.name,value)} onApply={()=>core.applySource()} onCopy={()=>navigator.clipboard.writeText(selected.source)}/></div></>}
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
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
const pattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
let matched = 0;

async function run(name, check) {
  if (pattern && !pattern.test(name)) return;
  matched++;
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route('http://localhost/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
    );
    await page.goto('http://localhost');
    await page.evaluate((fixture) => {
      window.fixture = fixture;
      window.commits = 0;
      window.commitError = '';
      window.saves = 0;
      window.savedPCBSource = '';
      window.rejectCommit = false;
    }, project);
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({
      content:
        'html,body,#root{height:100%;margin:0}.fixture-navigation{height:32px;display:flex;gap:8px}.fixture-editor{height:calc(100% - 32px)}.fixture-editor[hidden]{display:none}.layout-editor,.source-editor{height:100%}',
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    const panel = page.locator('.layout-inspector');
    try {
      await canvas.waitFor();
    } catch (error) {
      assert.deepEqual(errors, [], 'The real editor mounts without renderer errors.');
      throw error;
    }
    await runCanvasAction(page, 'Fit board to canvas');
    const filterDisclosure = page.getByRole('button', { name: 'Selection', exact: true });
    if ((await filterDisclosure.getAttribute('aria-expanded')) !== 'true')
      await filterDisclosure.click();
    await page.getByRole('checkbox', { name: 'Pads', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Footprints', exact: true }).uncheck();
    await filterDisclosure.click();
    const frames = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    const state = () => page.evaluate(() => window.readLayoutState());
    const assertPropertiesFormatting = async () => {
      const formatting = await panel.evaluate((element) => {
        const fontSize = (token) => {
          const probe = document.createElement('span');
          probe.style.cssText = `position:fixed;visibility:hidden;font-size:var(${token})`;
          element.append(probe);
          const size = parseFloat(getComputedStyle(probe).fontSize);
          probe.remove();
          return size;
        };
        const bounds = (target) => {
          const { top, bottom, left, width } = target.getBoundingClientRect();
          return { top, bottom, left, width };
        };
        return {
          labelFontSize: fontSize('--font-small'),
          controlFontSize: fontSize('--font-control'),
          radius: getComputedStyle(element).getPropertyValue('--radius').trim(),
          fields: Array.from(element.querySelectorAll('.layout-field, .layout-property-select'))
            .filter((field) => field.getClientRects().length)
            .map((field) => {
              const control = field.querySelector('input, textarea, [role="combobox"]');
              const style = getComputedStyle(control);
              const surface = field.querySelector('.quantity-input') ?? control;
              const surfaceStyle = getComputedStyle(surface);
              return {
                name: control.getAttribute('aria-label'),
                label: bounds(field.querySelector(':scope > span')),
                field: bounds(field),
                control: bounds(surface),
                labelFontSize: parseFloat(
                  getComputedStyle(field.querySelector(':scope > span')).fontSize,
                ),
                controlFontSize: parseFloat(style.fontSize),
                compactQuantity: control.matches(
                  ':is(.geometry-fields.component-geometry, .layout-property-grid[data-columns="3"]) .quantity-input > input',
                ),
                radius: surfaceStyle.borderRadius,
                minHeight: parseFloat(surfaceStyle.minHeight),
              };
            }),
          grids: Array.from(element.querySelectorAll('.layout-property-grid'))
            .filter((grid) => grid.getClientRects().length)
            .map((grid) => ({
              columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
              fields: Array.from(grid.children)
                .filter((field) => getComputedStyle(field).gridColumnEnd !== '-1')
                .map(bounds),
            })),
        };
      });
      for (const field of formatting.fields) {
        const stacked = field.control.top >= field.label.bottom + 3;
        assert.ok(
          stacked
            ? Math.abs(field.control.left - field.label.left) <= 1 &&
                Math.abs(field.control.width - field.field.width) <= 1
            : field.control.left >= field.label.left + field.label.width + 3 &&
                Math.abs(
                  field.control.top + field.control.bottom - field.label.top - field.label.bottom,
                ) <= 2,
          'Properties keeps controls aligned beside labels with the compact label gap.',
        );
        assert.equal(
          field.labelFontSize,
          formatting.labelFontSize,
          `${field.name}: Properties labels use the small UI text size.`,
        );
        assert.equal(
          field.controlFontSize,
          field.compactQuantity ? formatting.labelFontSize : formatting.controlFontSize,
          `${field.name}: compact three-column quantities use small text; other values use control text.`,
        );
        assert.equal(field.radius, formatting.radius, 'Properties uses the shared control radius.');
        assert.ok(field.minHeight >= 30, 'Properties retains the standard minimum control height.');
      }
      for (const grid of formatting.grids) {
        assert.ok([1, 2, 3].includes(grid.columns), 'Geometry columns adapt to the dock width.');
        for (let index = 1; index < grid.fields.length; index++) {
          assert.ok(
            Math.abs(grid.fields[index].width - grid.fields[0].width) <= 1,
            'Grouped geometry fields retain equal-width columns.',
          );
          if (index % grid.columns)
            assert.ok(
              Math.abs(grid.fields[index].top - grid.fields[index - 1].top) <= 1,
              'Related geometry fields stay on the same row.',
            );
        }
      }
    };
    const click = async (x, y) => {
      const p = await canvas.evaluate(
        (svg, p) => {
          const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
          return { x: at.x, y: at.y };
        },
        { x, y },
      );
      await page.mouse.click(p.x, p.y);
      await frames();
      await panel.waitFor({ state: 'visible' });
      await assertPropertiesFormatting();
    };
    const number = async (label, value) => {
      const input = panel.getByRole('spinbutton', { name: label, exact: true });
      await input.fill(String(value));
      await input.press('Enter');
      await frames();
      return input;
    };
    const choose = async (label, option) => {
      await panel.getByRole('combobox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
      await frames();
    };
    const native = async () => {
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      const navigation = page.getByRole('navigation', { name: 'Project files', exact: true });
      const names = await navigation
        .locator('[data-source-file]')
        .evaluateAll((elements) => elements.map((element) => element.dataset.sourceFile));
      const name = names.find((name) => name.endsWith('.kicad_pcb'));
      assert.ok(name, 'The editable native PCB is present in Source.');
      await selectSourceFile(page, name);
      const source = await readSource(page);
      assert.ok(source.startsWith('(kicad_pcb'), 'Copy reads native board text.');
      const result = parseKiCadPCB(source, project.schematic, 'layout-properties').board;
      await page.getByRole('button', { name: 'Layout', exact: true }).click();
      await frames();
      return result;
    };
    const undo = async () => {
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await frames();
    };
    const pad = (pcb, id = ids.smd) => pcb.footprints[0].pads.find((pad) => pad.id === id);
    await check({ page, canvas, panel, click, number, choose, state, native, undo, frames, pad });
    assert.deepEqual(errors, [], 'No renderer errors.');
    assert.equal((await state()).error, '', 'All accepted property transactions pass Core.');
    console.log(`Layout properties: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'locked footprint can be picked again after enabling Locked items',
    async ({ page, canvas, panel, click, state, frames }) => {
      const initialDisclosure = page.getByRole('button', { name: 'Selection', exact: true });
      await initialDisclosure.click();
      await page.getByRole('checkbox', { name: 'Footprints', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Pads', exact: true }).uncheck();
      await initialDisclosure.click();
      await click(20, 15);
      await panel.getByRole('checkbox', { name: 'Locked', exact: true }).check();
      const before = await state();
      await click(60, 45);
      await click(20, 15);
      assert.equal(
        await canvas
          .locator(`[data-selection-id="${ids.footprint}"] [data-selection-only]`)
          .count(),
        0,
        'Locked objects remain excluded until locked picking is enabled.',
      );
      const disclosure = page.getByRole('button', { name: 'Selection', exact: true });
      await disclosure.click();
      await page.getByRole('checkbox', { name: 'Footprints', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Pads', exact: true }).uncheck();
      await page.getByRole('checkbox', { name: 'Locked items', exact: true }).check();
      await disclosure.click();
      await click(60, 45);
      await click(20, 15);
      await frames();
      assert.equal(
        await panel.getByRole('checkbox', { name: 'Locked', exact: true }).isChecked(),
        true,
      );
      assert.equal((await state()).revision, before.revision);
      assert.equal(
        await panel.getByRole('spinbutton', { name: 'X (mm)', exact: true }).isDisabled(),
        true,
      );
      await panel.getByRole('checkbox', { name: 'Locked', exact: true }).uncheck();
      assert.equal((await state()).board.footprints[0].locked, undefined);
    },
  );
  await run(
    'locked object colours preserve native layer paint and image exports',
    async ({ page, canvas, state, frames }) => {
      const before = await page.evaluate(() => window.layoutImage());
      await page.evaluate(
        (ids) =>
          window.lockLayoutObjects([
            { kind: 'footprint', id: ids.footprint },
            { kind: 'track', id: ids.track },
            { kind: 'via', id: ids.via },
            { kind: 'graphic', id: ids.line },
            { kind: 'graphic', id: ids.text },
            { kind: 'zone', id: ids.rule },
          ]),
        ids,
      );
      await frames();
      for (const id of [ids.footprint, ids.track, ids.via, ids.line, ids.text, ids.rule]) {
        const paints = canvas.locator(`[data-selection-id="${id}"] [data-layout-locked-paint]`);
        assert.ok(await paints.count(), `Locked ${id} has colour paint.`);
        assert.equal(await paints.first().getAttribute('data-export-exclude'), 'true');
      }
      const light = await canvas
        .locator(`[data-selection-id="${ids.track}"] [data-layout-locked-paint] line`)
        .evaluate((node) => getComputedStyle(node).stroke);
      await canvas.evaluate((svg) =>
        svg.closest('.layout-editor').setAttribute('data-pcb-theme', 'dark'),
      );
      const dark = await canvas
        .locator(`[data-selection-id="${ids.track}"] [data-layout-locked-paint] line`)
        .evaluate((node) => getComputedStyle(node).stroke);
      assert.notEqual(light, dark, 'Locked paint adapts to board brightness.');
      await canvas.evaluate((svg) =>
        svg.closest('.layout-editor').setAttribute('data-pcb-theme', 'light'),
      );
      assert.deepEqual(
        await page.evaluate(() => window.layoutImage()),
        before,
        'Lock paint never changes exported pixels.',
      );
      assert.equal((await state()).revision, 1, 'Only the lock transaction changes the project.');
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/layout-locked-colours.png' });
    },
  );
  await run(
    'locked component keeps Properties and a visible screen-size lock marker',
    async ({ page, canvas, panel, click, state, frames }) => {
      await click(20, 15);
      await panel.getByRole('button', { name: 'Footprint properties', exact: true }).click();
      const before = await state();
      const lock = panel.getByRole('checkbox', { name: 'Locked', exact: true });
      await lock.check();
      await frames();
      assert.equal(await lock.isChecked(), true);
      const marker = page.locator(`[data-layout-lock="${ids.footprint}"]`);
      await marker.waitFor();
      assert.equal(await marker.getAttribute('aria-label'), 'J1 locked');
      const markerSize = await marker.locator(':scope > rect').boundingBox();
      assert.ok(Math.abs(markerSize.width - 16) < 0.1);
      const beforeView = await canvas.getAttribute('viewBox');
      await canvas.hover({ position: { x: 12, y: 12 } });
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(
        (before) =>
          document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !==
          before,
        beforeView,
      );
      await frames();
      const zoomed = await marker.locator(':scope > rect').boundingBox();
      assert.ok(
        Math.abs(zoomed.width - 16) < 0.1,
        `The zoomed marker stays 16 px wide (${zoomed.width}).`,
      );
      await lock.uncheck();
      await frames();
      assert.equal(await marker.count(), 0);
      assert.equal((await state()).revision, before.revision + 2);
    },
  );

  await run(
    'unlinked footprint identity shares Schematic spacing without native edits',
    async ({ page, panel, click, state, frames }) => {
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      const nativeBefore = await readNativeFiles(page);
      await page.getByRole('button', { name: 'Layout', exact: true }).click();
      const before = await state();
      await click(20, 15);
      await panel.getByRole('button', { name: 'Footprint properties', exact: true }).click();
      await frames();
      const identity = panel.locator('.inspector-symbol');
      await identity.waitFor();
      const disclosure = page.getByRole('button', { name: 'Properties', exact: true });
      await disclosure.click();
      await identity.waitFor({ state: 'hidden' });
      await disclosure.click();
      await identity.waitFor();
      await frames();
      assert.ok(
        await identity
          .locator('.component-preview svg')
          .evaluate((svg) => svg.viewBox.baseVal.width >= 20),
        'Revealing Properties fits the complete footprint thumbnail.',
      );
      assert.equal(await identity.locator('strong').innerText(), board.footprints[0].libraryId);
      assert.match(await panel.innerText(), /Fixture:PadTypes/);
      assert.equal(await panel.getByRole('heading', { name: 'Footprint', exact: true }).count(), 0);
      const preview = identity.getByRole('img', { name: 'Footprint preview', exact: true });
      assert.equal(await preview.getAttribute('class'), 'footprint-identity-preview');
      assert.equal(await preview.locator('g[data-preview-pad]').count(), 3);
      assert.equal(
        await preview.locator(':scope > g > path').count(),
        1,
        'The identity renders native footprint artwork as well as its pads.',
      );
      const layout = await identity.evaluate((element) => {
        const style = getComputedStyle(element);
        const thumbnail = element.querySelector('.component-preview');
        const svg = thumbnail.querySelector('svg');
        return {
          gap: style.gap,
          top: style.paddingTop,
          bottom: style.paddingBottom,
          offset:
            element.getBoundingClientRect().top -
            element.closest('.layout-inspector-content').getBoundingClientRect().top,
          thumbnail: [
            thumbnail.getBoundingClientRect().width,
            thumbnail.getBoundingClientRect().height,
          ],
          preview: [svg.getBoundingClientRect().width, svg.getBoundingClientRect().height],
          referenceWeight: getComputedStyle(element.querySelector('strong')).fontWeight,
        };
      });
      assert.deepEqual(
        layout,
        {
          gap: '8px',
          top: '0px',
          bottom: '0px',
          offset: 8,
          thumbnail: [32, 32],
          preview: [26, 26],
          referenceWeight: '600',
        },
        'Unlinked footprints use the shared identity strip, thumbnail and top inset.',
      );
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/layout-properties-unlinked-identity.png' });
      const after = await state();
      assert.equal(after.revision, before.revision);
      assert.equal(after.commits, before.commits);
      assert.equal(
        await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(),
        false,
      );
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      assert.deepEqual(
        await readNativeFiles(page),
        nativeBefore,
        'Inspecting an unlinked footprint retains every native byte.',
      );
    },
  );
  await run(
    'pad geometry, classification, validation and native undo',
    async ({ page, panel, click, number, choose, state, native, undo, pad }) => {
      await click(20, 15);
      assert.match(await panel.innerText(), /Surface-mount pad/);
      assert.equal(
        await panel
          .locator('summary')
          .filter({ hasText: /^(Drill offset|Fabrication|Pad details)$/ })
          .count(),
        0,
      );
      assert.equal(
        await panel.getByRole('combobox', { name: 'Pad net', exact: true }).count(),
        0,
        'Pad electrical associations remain schematic-owned.',
      );
      const before = await state();
      const invalid = await number('Pad width (mm)', 0);
      assert.equal(await invalid.getAttribute('aria-invalid'), 'true');
      assert.equal((await state()).revision, before.revision);
      await invalid.press('Escape');
      await number('Pad width (mm)', 4);
      assert.equal((await state()).revision, before.revision + 1);
      assert.equal(pad(await native()).size.x, 4);
      assert.equal(
        pad(await native()).solderMaskMargin,
        pad(before.board).solderMaskMargin,
        'Hidden fabrication data survives ordinary geometry edits.',
      );
      await undo();
      assert.deepEqual((await state()).board, before.board);
      await number('Pad X (mm)', 1.5);
      assert.equal(pad(await native()).x, 1.5);
      await choose('Pad shape', 'Oval');
      const changed = await native();
      assert.equal(pad(changed).shape, 'oval');
      assert.equal(pad(changed).id, ids.smd);
      assert.equal(pad(changed).netId, ids.net);
      assert.deepEqual(changed.tracks, board.tracks);
      assert.deepEqual(changed.vias, board.vias);
      assert.equal(changed.footprints[0].id, ids.footprint);
      await mkdir('test-results/layout-properties', { recursive: true });
      await panel.locator('.layout-inspector-content').evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: 'test-results/layout-properties/compact.png' });
      const overflow = await panel.evaluate((element) => ({
        panel: element.scrollWidth > element.clientWidth + 1,
        body:
          element.querySelector('.layout-inspector-content').scrollWidth >
          element.querySelector('.layout-inspector-content').clientWidth + 1,
      }));
      assert.deepEqual(
        overflow,
        { panel: false, body: false },
        'Compact Properties has no horizontal overflow.',
      );
    },
  );

  await run(
    'plated pads, mechanical holes and vias remain separate',
    async ({ panel, click, number, native, state, pad }) => {
      await click(28, 15);
      assert.match(await panel.innerText(), /Plated through-hole pad/);
      await number('Pad drill (mm)', 1.5);
      assert.equal(pad(await native(), ids.through).drill, 1.5);
      await click(36, 15);
      assert.match(await panel.innerText(), /Non-plated hole/);
      await click(35, 28);
      await panel.getByRole('heading', { name: 'Via', exact: true }).waitFor();
      const previous = (await state()).board;
      await number('Diameter (mm)', 1.8);
      const changed = await native();
      assert.equal(changed.vias[0].id, ids.via);
      assert.equal(changed.vias[0].diameter, 1.8);
      assert.deepEqual(changed.footprints, previous.footprints);
    },
  );

  await run(
    'track endpoints and lock guards share Core transactions',
    async ({ page, panel, click, number, native, undo, state }) => {
      await click(18, 30);
      assert.deepEqual(
        await panel.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.title)),
        ['General'],
      );
      const general = panel.getByRole('tabpanel', { name: 'General', exact: true });
      const startX = general.getByRole('spinbutton', { name: 'Start X (mm)', exact: true });
      assert.equal(await startX.isVisible(), true);
      const before = (await state()).board;
      await number('Start X (mm)', 11.5);
      const changed = await native();
      assert.equal(changed.tracks[0].start.x, 11.5);
      assert.equal(changed.tracks[0].id, ids.track);
      assert.equal(changed.tracks[0].netId, ids.net);
      await undo();
      assert.deepEqual((await state()).board, before);
      const selection = page.getByRole('button', { name: 'Selection', exact: true });
      await selection.click();
      await page.getByRole('checkbox', { name: 'Locked items', exact: true }).check();
      await selection.click();
      await panel.getByRole('checkbox', { name: 'Locked', exact: true }).check();
      assert.equal(await startX.isDisabled(), true);
      assert.equal(
        await panel.getByRole('spinbutton', { name: 'Width (mm)', exact: true }).isDisabled(),
        true,
      );
      assert.equal((await native()).tracks[0].locked, true);
    },
  );

  await run(
    'graphic width and text edits serialize actual native artwork',
    async ({ panel, click, number, native, choose }) => {
      await click(15, 40);
      await number('Line width (mm)', 0.35);
      assert.equal(
        (await native()).graphics.find((graphic) => graphic.id === ids.line).width,
        0.35,
      );
      await click(35, 40);
      const content = panel.getByRole('textbox', { name: 'Text content', exact: true });
      await content.fill('OUTPUT');
      await content.press('ControlOrMeta+Enter');
      await number('Text rotation (°)', 45);
      const text = (await native()).graphics.find((graphic) => graphic.id === ids.text);
      assert.equal(text.text.value, 'OUTPUT');
      assert.equal(text.text.rotation, 45);
      assert.equal(text.layer, 'F.SilkS');
    },
  );

  await run(
    'rule areas expose actual keepout settings',
    async ({ panel, click, native, undo, state }) => {
      await click(50, 20);
      const before = (await state()).board;
      await panel.getByRole('checkbox', { name: 'Keep out tracks', exact: true }).check();
      const rule = (await native()).zones.find((zone) => zone.id === ids.rule);
      assert.equal(rule.keepout.tracks, true);
      assert.equal(rule.keepout.vias, true);
      assert.equal(rule.keepout.footprints, false);
      await undo();
      assert.deepEqual((await state()).board, before);
    },
  );
  await run(
    'Save commits current fields once and IME or invalid drafts block Save',
    async ({ page, panel, click, state, frames, pad }) => {
      await click(20, 15);
      const width = panel.getByRole('spinbutton', { name: 'Pad width (mm)', exact: true });
      const before = await state();
      await width.fill('4');
      await width.press('ControlOrMeta+s');
      await frames();
      let current = await state();
      assert.equal(current.revision, before.revision + 1);
      assert.equal(current.commits, before.commits + 1, 'Save commits the focused draft once.');
      assert.equal(current.saves, 1);
      assert.equal(
        pad(parseKiCadPCB(current.savedPCBSource, project.schematic, 'layout-properties').board)
          .size.x,
        4,
        'The window Save handler observes the new native PCB bytes synchronously.',
      );
      const accepted = current;
      await width.fill('0');
      await width.press('ControlOrMeta+s');
      await frames();
      assert.equal((await state()).revision, accepted.revision);
      assert.equal((await state()).saves, 1);
      assert.equal(await width.inputValue(), '0');
      assert.equal(await width.getAttribute('aria-invalid'), 'true');
      await width.press('Escape');
      await page.evaluate(() => {
        window.rejectCommit = true;
      });
      await width.fill('5');
      await width.press('ControlOrMeta+s');
      await frames();
      assert.equal((await state()).revision, accepted.revision);
      assert.equal((await state()).saves, 1, 'Rejected host edits cannot reach Save.');
      assert.equal(await width.inputValue(), '5');
      assert.equal(await width.getAttribute('aria-invalid'), 'true');
      await page.evaluate(() => {
        window.rejectCommit = false;
      });
      await width.press('Escape');

      const composingSave = async (input) => {
        await input.evaluate((element) =>
          element.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 's',
              code: 'KeyS',
              ctrlKey: true,
              keyCode: 229,
              isComposing: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await frames();
        assert.equal((await state()).revision, accepted.revision);
        assert.equal((await state()).saves, 1, 'Code 229 cannot commit or save a field.');
        await input.dispatchEvent('compositionstart');
        await input.press('ControlOrMeta+s');
        await frames();
        assert.equal((await state()).revision, accepted.revision);
        assert.equal((await state()).saves, 1, 'Active composition blocks a plain Save chord.');
        await input.dispatchEvent('compositionend');
        await input.press('Escape');
      };
      await width.fill('5');
      await composingSave(width);

      await click(35, 40);
      const content = panel.getByRole('textbox', { name: 'Text content', exact: true });
      await content.fill('UNCOMMITTED');
      await composingSave(content);
      assert.equal(await content.inputValue(), 'TEST');
      await content.fill('SAVED TEXT');
      await content.press('ControlOrMeta+s');
      await frames();
      current = await state();
      assert.equal(current.revision, accepted.revision + 1);
      assert.equal(current.saves, 2);
      const nativeText = parseKiCadPCB(
        current.savedPCBSource,
        project.schematic,
        'layout-properties',
      ).board.graphics.find((graphic) => graphic.id === ids.text);
      assert.equal(
        nativeText.text.value,
        'SAVED TEXT',
        'Save observes a committed multiline text draft.',
      );
    },
  );
  assert.ok(matched, 'At least one Layout Properties case matched.');
} finally {
  await browser.close();
}
