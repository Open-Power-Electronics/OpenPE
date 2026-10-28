import { setLayoutVisibility, toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { createProject, parseProject, serializeProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);

// Local renderer only: coordinate-based pointer hits, mocked history and no native/provider/service access.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const context=useRef(null);
        window.layoutSelection=()=>context.current?.selection??[];
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="track-selection" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});

function fixture() {
  const board = createEmptyPCB();
  const schematic = emptyCircuit();
  const ids = Object.fromEntries(
    [
      'out',
      'gnd',
      'aux',
      'a',
      'b',
      'c',
      'd',
      'branch',
      'e',
      'f',
      'via',
      'island',
      'islandVia',
      'foreign',
      'otherLayer',
      'auxTrack',
    ].map((name) => [name, uid()]),
  );
  board.nets = [
    { id: ids.out, name: 'OUT' },
    { id: ids.gnd, name: 'GND' },
    { id: ids.aux, name: 'AUX' },
  ];
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.1,
      start: { x: 0, y: 0 },
      points: [
        { x: 70, y: 0 },
        { x: 70, y: 45 },
      ],
      end: { x: 0, y: 45 },
    },
  ];
  board.footprints = [
    { x: 15, layer: 'F.Cu' },
    { x: 48, layer: 'B.Cu' },
  ].map(({ x, layer }, i) => {
    const part = createPart(schematic, 'Port', i * 12.7, 0);
    schematic.parts.push(part);
    return {
      id: uid(),
      symbolId: part.id,
      libraryId: 'Test:TrackAnchor',
      x,
      y: 20,
      rotation: 0,
      side: layer === 'B.Cu' ? 'back' : 'front',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 1, y: 1 },
          netId: ids.out,
          layers: [layer],
        },
      ],
    };
  });
  const track = (name, start, end, layer = 'F.Cu', netId = ids.out) => ({
    id: ids[name],
    start,
    end,
    layer,
    netId,
    width: 0.4,
  });
  board.tracks = [
    track('a', { x: 15, y: 20 }, { x: 20, y: 20 }),
    track('b', { x: 20, y: 20 }, { x: 25, y: 20 }),
    track('c', { x: 25, y: 20 }, { x: 30, y: 20 }),
    track('d', { x: 30, y: 20 }, { x: 35, y: 20 }),
    track('branch', { x: 25, y: 20 }, { x: 25, y: 26 }),
    track('e', { x: 35, y: 20 }, { x: 42, y: 20 }, 'B.Cu'),
    track('f', { x: 42, y: 20 }, { x: 48, y: 20 }, 'B.Cu'),
    track('island', { x: 42, y: 32 }, { x: 48, y: 32 }),
    track('foreign', { x: 20, y: 17 }, { x: 20, y: 23 }, 'F.Cu', ids.gnd),
    track('otherLayer', { x: 22, y: 17 }, { x: 22, y: 23 }, 'B.Cu'),
    track('auxTrack', { x: 35, y: 35 }, { x: 40, y: 35 }, 'F.Cu', ids.aux),
  ];
  board.vias = [
    { id: ids.via, x: 35, y: 20, diameter: 1, drill: 0.4, netId: ids.out },
    { id: ids.islandVia, x: 48, y: 32, diameter: 1, drill: 0.4, netId: ids.out },
  ];
  return { board, schematic, ids };
}

const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
let matchedCases = 0;
async function run(name, check) {
  if (casePattern && !casePattern.test(name)) return;
  matchedCases++;
  const input = fixture();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((value) => {
    window.fixture = value;
    window.lastBoard = value.board;
    window.commits = 0;
  }, input);
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await canvas.focus();
  const button = (label) => page.getByRole('button', { name: label, exact: true });
  const point = async (p, click = false, modifiers = []) => {
    const at = await canvas.evaluate((svg, position) => {
      const screen = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
    await page.mouse.move(at.x, at.y);
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    if (click) await page.mouse.click(at.x, at.y);
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  };
  const state = () => page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const clean = async () => assert.deepEqual(await state(), { board: input.board, commits: 0 });
  const selected = () =>
    page.evaluate(() =>
      window
        .layoutSelection()
        .map(({ id }) => id)
        .sort(),
    );
  const expectSelected = async (names) =>
    assert.deepEqual(await selected(), names.map((key) => input.ids[key]).sort());
  const opacity = (name) =>
    canvas.locator(`[data-selection-id="${input.ids[name]}"][data-net-id]`).getAttribute('opacity');
  const allConnected = ['a', 'b', 'c', 'd', 'branch', 'e', 'f', 'via'];
  try {
    await check({
      ...input,
      page,
      canvas,
      button,
      point,
      state,
      clean,
      selected,
      expectSelected,
      opacity,
      allConnected,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout track selection: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  for (const key of ['Enter', 'Space']) {
    await run(
      'panel keyboard continuity: ' +
        key +
        ' clears net highlights and returns to the retained search',
      async ({ page, point, button, opacity, expectSelected, clean }) => {
        await point({ x: 22.5, y: 20 }, true);
        await toggleLayoutVisualization(page, 'Net visibility');
        await button('Highlight OUT').click();
        const search = page.getByLabel('Search nets', { exact: true });
        await search.fill('GN');
        await button('Clear net highlight').focus();
        await page.keyboard.press(key);
        assert.equal(await button('Clear net highlight').count(), 0);
        assert.equal(await search.evaluate((input) => document.activeElement === input), true);
        assert.equal(await search.inputValue(), 'GN');
        assert.equal(await button('Highlight GND').count(), 1);
        assert.equal(await button('Highlight OUT').count(), 0);
        assert.equal(await opacity('a'), '1');
        assert.equal(await opacity('foreign'), '1');
        await expectSelected(['b']);
        await clean();
      },
    );
  }

  for (const activation of ['pointer', 'unfocused click']) {
    await run(
      'panel keyboard continuity: ' + activation + ' clear does not take search focus',
      async ({ page, canvas, button, opacity, clean }) => {
        await toggleLayoutVisualization(page, 'Net visibility');
        await button('Highlight OUT').click();
        const search = page.getByLabel('Search nets', { exact: true });
        await search.fill('GN');
        await canvas.focus();
        if (activation === 'pointer') await button('Clear net highlight').click();
        else await button('Clear net highlight').evaluate((control) => control.click());
        assert.equal(await button('Clear net highlight').count(), 0);
        assert.equal(await search.evaluate((input) => document.activeElement === input), false);
        if (activation === 'unfocused click')
          assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
        assert.equal(await search.inputValue(), 'GN');
        assert.equal(await opacity('foreign'), '1');
        await clean();
      },
    );
  }

  await run(
    'first U selects a pad-to-branch chain and second U selects only physically connected copper',
    async ({ canvas, point, clean, expectSelected, allConnected }) => {
      await point({ x: 22.5, y: 20 }, true);
      await canvas.press('u');
      await expectSelected(['a', 'b']);
      await canvas.press('u');
      await expectSelected(allConnected);
      await canvas.press('u');
      await expectSelected(allConnected);
      await clean();
    },
  );

  await run(
    'hover U selects the chain bounded by a branch and through via',
    async ({ canvas, point, clean, expectSelected }) => {
      await point({ x: 27.5, y: 20 });
      await canvas.press('u');
      await expectSelected(['c', 'd']);
      await clean();
    },
  );

  await run(
    'Escape followed by manual reselection starts expansion from the chain stage again',
    async ({ canvas, point, expectSelected, allConnected, clean }) => {
      await point({ x: 22.5, y: 20 }, true);
      await canvas.press('u');
      await expectSelected(['a', 'b']);
      await canvas.press('Escape');
      await expectSelected([]);
      await point({ x: 17.5, y: 20 }, true);
      await point({ x: 22.5, y: 20 }, true, ['Shift']);
      await expectSelected(['a', 'b']);
      await canvas.press('u');
      await expectSelected(['a', 'b']);
      await canvas.press('u');
      await expectSelected(allConnected);
      await clean();
    },
  );

  await run(
    'menu expansion uses the same stages and returns keyboard focus to the canvas',
    async ({ page, canvas, point, clean, expectSelected, allConnected }) => {
      await point({ x: 22.5, y: 20 }, true);
      await page.getByRole('combobox', { name: 'Edit layout', exact: true }).click();
      const action = page.getByRole('option', { name: 'Expand track selection', exact: true });
      assert.equal(await action.innerText(), 'Expand track selection');
      await action.click();
      await expectSelected(['a', 'b']);
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      await page.keyboard.press('u');
      await expectSelected(allConnected);
      await clean();
    },
  );

  await run(
    'Delete of the expanded network commits once and Undo restores every original object',
    async ({
      board,
      schematic,
      ids,
      canvas,
      button,
      point,
      state,
      expectSelected,
      allConnected,
    }) => {
      await point({ x: 22.5, y: 20 }, true);
      await canvas.press('u');
      await canvas.press('u');
      await expectSelected(allConnected);
      await canvas.press('Delete');
      const result = await state();
      assert.equal(result.commits, 1);
      const removed = new Set(allConnected.map((name) => ids[name]));
      assert.deepEqual(
        result.board.tracks,
        board.tracks.filter((track) => !removed.has(track.id)),
      );
      assert.deepEqual(
        result.board.vias,
        board.vias.filter((via) => !removed.has(via.id)),
      );
      assert.deepEqual(result.board.footprints, board.footprints);
      assert.deepEqual(result.board.graphics, board.graphics);
      assert.deepEqual(result.board.nets, board.nets);
      const project = createProject(schematic);
      project.pcb = result.board;
      assert.deepEqual(parseProject(serializeProject(project)).pcb, result.board);
      await button('Undo').click();
      assert.deepEqual((await state()).board, board);
    },
  );

  await run(
    'hidden back-layer tracks remain excluded from full connected selection',
    async ({ page, canvas, button, point, clean, expectSelected }) => {
      await setLayoutVisibility(page, 'B.Cu', false);
      await point({ x: 22.5, y: 20 }, true);
      await canvas.press('u');
      await canvas.press('u');
      await expectSelected(['a', 'b', 'c', 'd', 'branch', 'via']);
      await clean();
    },
  );

  await run(
    'disabled via selection stays excluded during expansion',
    async ({ page, canvas, button, point, expectSelected, clean }) => {
      await toggleLayoutVisualization(page, 'Selection');
      await page.getByRole('checkbox', { name: 'Vias', exact: true }).uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await point({ x: 22.5, y: 20 }, true);
      await canvas.press('u');
      await canvas.press('u');
      await expectSelected(['a', 'b', 'c', 'd', 'branch']);
      await clean();
    },
  );

  await run(
    'disabled tracks cannot be added while expansion starts from a visible via',
    async ({ ids, page, canvas, button, point, selected, clean }) => {
      await toggleLayoutVisualization(page, 'Selection');
      await page.getByRole('checkbox', { name: 'Tracks', exact: true }).uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await point({ x: 35, y: 20 });
      await canvas.press('u');
      await canvas.press('u');
      assert.deepEqual(await selected(), [ids.via]);
      await clean();
    },
  );

  await run(
    'backtick highlights hovered copper across disconnected same-net islands and tilde clears it',
    async ({ canvas, point, opacity, clean }) => {
      await point({ x: 27.5, y: 20 });
      await canvas.press('`');
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('island'), '1');
      assert.equal(await opacity('foreign'), '0.2');
      assert.equal(await opacity('auxTrack'), '0.2');
      await canvas.press('~');
      assert.equal(await opacity('foreign'), '1');
      assert.equal(await opacity('auxTrack'), '1');
      await clean();
    },
  );

  await run(
    'selected copper takes priority over the hovered net and Escape clears highlight',
    async ({ canvas, point, opacity, clean }) => {
      await point({ x: 22.5, y: 20 }, true);
      await point({ x: 20, y: 18 });
      await canvas.press('`');
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '0.2');
      await canvas.press('Escape');
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '1');
      assert.equal(await opacity('auxTrack'), '1');
      await clean();
    },
  );

  await run(
    'backtick on empty space clears an earlier hover highlight',
    async ({ canvas, point, opacity, clean }) => {
      await point({ x: 27.5, y: 20 });
      await canvas.press('`');
      assert.equal(await opacity('foreign'), '0.2');
      await point({ x: 55, y: 28 });
      await canvas.press('`');
      assert.equal(await opacity('foreign'), '1');
      assert.equal(await opacity('auxTrack'), '1');
      await clean();
    },
  );

  await run(
    'multiple selected copper nets remain highlighted together',
    async ({ canvas, point, opacity, clean }) => {
      await point({ x: 22.5, y: 20 }, true);
      await point({ x: 20, y: 18 }, true, ['Shift']);
      await canvas.press('`');
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '1');
      assert.equal(await opacity('auxTrack'), '0.2');
      await canvas.press('~');
      assert.equal(await opacity('auxTrack'), '1');
      await clean();
    },
  );

  await run(
    'pad hover provides its schematic net for temporary highlighting',
    async ({ canvas, point, opacity, clean }) => {
      await point({ x: 15, y: 20 });
      await canvas.press('`');
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '0.2');
      await canvas.press('~');
      await clean();
    },
  );

  await run(
    'an inspected pad provides the highlight net before unrelated hovered copper',
    async ({ page, canvas, button, point, opacity, clean }) => {
      await toggleLayoutVisualization(page, 'Selection');
      await page.getByRole('checkbox', { name: 'Pads', exact: true }).check();
      await toggleLayoutVisualization(page, 'Selection');
      await point({ x: 15, y: 20 }, true);
      assert.equal(
        await page.getByRole('menu', { name: 'Choose layout object', exact: true }).count(),
        0,
        'Enabled pad inspection resolves directly from the pad geometry.',
      );
      assert.equal(
        await page
          .getByRole('complementary', { name: 'Layout properties' })
          .locator('header strong')
          .innerText(),
        'Pad 1',
      );
      await point({ x: 20, y: 18 });
      await canvas.press('`');
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '0.2');
      await canvas.press('Escape');
      assert.equal(await opacity('foreign'), '1');
      await clean();
    },
  );

  await run(
    'net panel buttons toggle individual highlights and clear all without writes',
    async ({ page, button, opacity, clean }) => {
      await toggleLayoutVisualization(page, 'Net visibility');
      await button('Highlight OUT').click();
      await button('Highlight GND').click();
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '1');
      assert.equal(await opacity('auxTrack'), '0.2');
      await button('Highlight OUT').click();
      assert.equal(await opacity('a'), '0.2');
      assert.equal(await opacity('foreign'), '1');
      await button('Clear net highlight').click();
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('auxTrack'), '1');
      await clean();
    },
  );

  await run(
    'Properties text entry suppresses expansion and net highlight shortcuts',
    async ({ page, canvas, point, opacity, expectSelected, clean }) => {
      await point({ x: 22.5, y: 20 }, true);
      const width = page.getByRole('spinbutton', { name: 'Width (mm)', exact: true });
      await width.fill('2');
      await point({ x: 20, y: 18 });
      for (const key of ['u', '`', '~']) await page.keyboard.press(key);
      await expectSelected(['b']);
      assert.equal(await opacity('a'), '1');
      assert.equal(await opacity('foreign'), '1');
      assert.equal(await opacity('auxTrack'), '1');
      await page.keyboard.press('Escape');
      assert.equal(await width.inputValue(), '0.4');
      await clean();
    },
  );
  assert.ok(
    matchedCases > 0,
    `No Layout track-selection cases matched ${JSON.stringify(process.argv[2] ?? '')}.`,
  );
} finally {
  await browser.close();
}
