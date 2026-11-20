import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
const trackId = 'e5b79686-7bce-4eeb-bc33-cc09e12ffe67';
const otherId = '7536b140-2f7b-4625-9db7-77e8da3a4803';
const pickup = { x: 87, y: 114.24975 };
const target = { x: 86, y: pickup.y };
const originalWidth = project.pcb.tracks.find((track) => track.id === trackId).width;
const mode = process.env.OPENPE_TEST_REACT_MODE ?? 'development';

// Real EMC, LayoutEditor, Select and ProjectCore. The host only supplies project
// lifecycle/sidebar state; no service, native dialog or user-file writes occur.
const bundle = await build({
  stdin: {
    contents: `import React,{StrictMode,useState,useRef,useMemo,useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
      import LayoutEditor from './components/LayoutEditor';import{ProjectCore}from'./core/project-core';import{isOwnedPCB}from'./lib/immutable-project';import{pcbFillRuleContext}from'./lib/pcb-clearance-sources';
      function Fixture(){
        const[core]=useState(()=>new ProjectCore(window.fixture));
        const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot,core.getSnapshot);
        const nativeFiles=snapshot.project.nativeFiles;
        const fillRules=useMemo(()=>pcbFillRuleContext({nativeFiles}),[nativeFiles]);
        const[active,setActive]=useState(true),[visible,setVisible]=useState(true),[sidebar,setSidebar]=useState(true);
        const context=useRef(null);window.layoutContext=()=>context.current;
        window.setLayoutHost=patch=>flushSync(()=>{if('active'in patch)setActive(patch.active);if('visible'in patch)setVisible(patch.visible);if('sidebar'in patch)setSidebar(patch.sidebar)});
        window.readLayoutState=()=>{const s=core.getSnapshot();return{board:s.project.pcb,source:s.source,revision:s.revision,canUndo:s.canUndo,pending:s.sourceDraft!==null,commits:window.commits,attempts:window.commitAttempts,error:window.commitError,exactAdoption:window.exactAdoption}};
        window.stageSource=()=>{const file=core.getNativeFiles().files.find(file=>file.name.endsWith('.kicad_pcb'));core.updateNativeSource(file.name,file.source+'\\n')};
        window.clearSource=()=>core.discardSource();
        window.changeTrackWidth=(id,width)=>{const pcb=core.getSnapshot().project.pcb;core.replaceBoard({...pcb,tracks:pcb.tracks.map(track=>track.id===id?{...track,width}:track)})};
        return <LayoutEditor board={snapshot.project.pcb} schematic={snapshot.project.schematic} fillRules={fillRules}
          active={active} visible={visible} sidebarVisible={sidebar} onToggleSidebar={()=>setSidebar(value=>!value)} onShowSidebar={()=>setSidebar(true)}
          agentContextRef={context} draftStatus={snapshot.sourceDraft!==null?'Pending Source edits':''}
          onCommit={next=>{window.commitAttempts++;try{const changed=core.replaceBoard(next);window.exactAdoption=isOwnedPCB(next)&&core.getSnapshot().project.pcb===next;if(changed)window.commits++;window.commitError='';return true}catch(error){window.commitError=error.message;return false}}}
          undoAction={<button aria-label="Undo" disabled={!snapshot.canUndo} onClick={()=>core.undo()}>Undo</button>}
          annotations={[]} annotationSessionId="properties-retention" onAnnotationsChange={()=>{}}/>;
      }
      createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  plugins: [
    {
      name: 'count-retained-properties-and-unrelated-presentation',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]pcbPresentationAnalysis\.ts$/ }, async ({ path: file }) => {
          let contents = await readFile(file, 'utf8');
          for (const name of ['connectivity', 'copper']) {
            const marker = `const result = calculations.${name}(board);`;
            assert.ok(contents.includes(marker), `Find uncached ${name} calculation.`);
            contents = contents.replace(
              marker,
              `window.layoutWork.${name}Computations++;` + marker,
            );
          }
          return { contents, loader: 'ts', resolveDir: path.dirname(file) };
        });
        plugin.onLoad(
          { filter: /[\\/](LayoutEditor|LayoutAppearancePanel)\.tsx$/ },
          async ({ path: file }) => {
            let contents = await readFile(file, 'utf8');
            if (path.basename(file) === 'LayoutEditor.tsx') {
              const properties = 'return children();';
              assert.ok(contents.includes(properties), 'Find actual retained Properties render.');
              contents = contents.replace(
                properties,
                'window.layoutWork.properties++;' + properties,
              );
              const airwires = 'const airwireDrawing = useMemo(() => {';
              assert.ok(contents.includes(airwires), 'Find actual airwire drawing factory.');
              contents = contents.replace(airwires, airwires + '\nwindow.layoutWork.airwires++;');
            } else {
              const body = 'const body = useMemo(\n    () => (';
              assert.ok(contents.includes(body), 'Find actual Appearance body factory.');
              contents = contents.replace(body, body + '\nwindow.layoutWork.appearanceBodies++,');
            }
            return { contents, loader: 'tsx', resolveDir: path.dirname(file) };
          },
        );
      },
    },
  ],
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const geometry = (tracks) =>
  tracks
    .map(({ id, start, end, width }) => ({ id, start, end, width }))
    .sort((a, b) => a.id.localeCompare(b.id));
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
const pattern = process.argv[2] ? new RegExp(process.argv[2]) : null;

async function run(name, check) {
  if (pattern && !pattern.test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route('http://localhost/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
    );
    await page.goto('http://localhost');
    await page.evaluate((project) => {
      window.fixture = project;
      window.commits = 0;
      window.commitAttempts = 0;
      window.commitError = '';
      window.layoutWork = {
        properties: 0,
        airwires: 0,
        appearanceBodies: 0,
        connectivityComputations: 0,
        copperComputations: 0,
      };
    }, project);
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor();
    await canvas.focus();
    await canvas.press('PageDown');
    const settle = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    const point = async (at, click = false) => {
      const screen = await canvas.evaluate((svg, at) => {
        const p = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM());
        return { x: p.x, y: p.y };
      }, at);
      await page.mouse.move(screen.x, screen.y);
      if (click) await page.mouse.click(screen.x, screen.y);
      await settle();
    };
    const state = () => page.evaluate(() => window.readLayoutState());
    const counts = () => page.evaluate(() => ({ ...window.layoutWork }));
    const host = async (patch) => {
      await page.evaluate((patch) => window.setLayoutHost(patch), patch);
      await settle();
    };
    const panel = page.locator('.layout-inspector');
    const width = panel.locator('input[aria-label="Width (mm)"]');
    const net = panel.locator('[role="combobox"][aria-label="Track net"]');
    const marker = canvas.locator('[data-track-drag-preview]');
    const select = async (at = pickup, id = trackId) => {
      await point(at, true);
      await width.waitFor({ state: 'visible' });
      assert.deepEqual((await page.evaluate(() => window.layoutContext())).selection, [
        { kind: 'track', id },
      ]);
    };
    const remember = () =>
      page.evaluate(() => {
        window.savedWidth = document.querySelector(
          '.layout-inspector input[aria-label="Width (mm)"]',
        );
        window.savedNet = document.querySelector('.layout-inspector [aria-label="Track net"]');
      });
    const retained = () =>
      page.evaluate(
        () =>
          window.savedWidth ===
            document.querySelector('.layout-inspector input[aria-label="Width (mm)"]') &&
          window.savedNet === document.querySelector('.layout-inspector [aria-label="Track net"]'),
      );
    const preview = async () =>
      geometry(
        await canvas.evaluate((svg) =>
          [...svg.querySelectorAll('[data-selection-id][data-net-id]')].flatMap((group) => {
            const line = [...group.querySelectorAll('line')].at(-1);
            return line
              ? [
                  {
                    id: group.getAttribute('data-selection-id'),
                    start: { x: +line.getAttribute('x1'), y: +line.getAttribute('y1') },
                    end: { x: +line.getAttribute('x2'), y: +line.getAttribute('y2') },
                    width: +line.getAttribute('stroke-width'),
                  },
                ]
              : [];
          }),
        ),
      );
    await check({
      page,
      canvas,
      panel,
      width,
      net,
      marker,
      select,
      point,
      state,
      counts,
      host,
      settle,
      remember,
      retained,
      preview,
    });
    assert.deepEqual(errors, [], 'No renderer errors.');
    console.log(`Layout Properties retention (${mode}): ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'same track controls survive exact connected-drag commit and whole-project undo',
    async ({
      page,
      canvas,
      panel,
      width,
      net,
      marker,
      select,
      point,
      state,
      counts,
      remember,
      retained,
      preview,
    }) => {
      await select();
      await remember();
      const baseline = await state();
      const before = await counts();
      await canvas.focus();
      await canvas.press('d');
      await marker.waitFor({ state: 'attached' });
      assert.equal(await panel.getAttribute('hidden'), '');
      assert.equal(await panel.getAttribute('inert'), '');
      assert.equal(await width.isDisabled(), true);
      assert.equal(await net.isDisabled(), true);
      assert.equal(
        await retained(),
        true,
        'Pickup deactivates the existing controls without remounting.',
      );
      const hidden = await counts();
      await point({ x: 86.5, y: pickup.y });
      await point(target);
      assert.equal(
        (await counts()).properties,
        hidden.properties,
        'Hidden previews do not construct inspector JSX.',
      );
      assert.equal((await state()).revision, baseline.revision);
      const displayed = await preview();
      const previewWork = await counts();
      const airwireMarkup = await canvas
        .locator('[data-airwire]')
        .evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
      assert.ok(airwireMarkup.length, 'The EMC fixture exercises visible airwire presentation.');
      await canvas.press('Enter');
      await width.waitFor({ state: 'visible' });
      const changed = await state();
      assert.equal(changed.commits, 1);
      assert.equal(changed.exactAdoption, true, 'Core adopts the exact immutable displayed board.');
      assert.equal(
        (await counts()).connectivityComputations,
        previewWork.connectivityComputations,
        'A successful exact preview is not re-analyzed after Core adoption, including StrictMode.',
      );
      assert.deepEqual(
        geometry(changed.board.tracks),
        displayed,
        'Core accepts the exact displayed UUIDs and geometry.',
      );
      assert.equal(
        await retained(),
        true,
        'Same-subject placement retains the real input and Select controls.',
      );
      assert.equal(await width.inputValue(), String(originalWidth));
      assert.equal(await width.isEnabled(), true);
      assert.equal(await panel.getAttribute('inert'), null);
      assert.deepEqual(
        await canvas
          .locator('[data-airwire]')
          .evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
        airwireMarkup,
        'The committed preview has exactly the same airwire geometry and paint.',
      );
      assert.equal(
        (await counts()).airwires,
        previewWork.airwires,
        'An unchanged preview-to-Core airwire presentation retains its drawing JSX.',
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal(await retained(), true, 'Whole-project Undo retains same-subject controls.');
      const undone = await state();
      assert.deepEqual(undone.board, baseline.board);
      assert.equal(undone.source, baseline.source);
      assert.equal(undone.canUndo, false);
      const after = await counts();
      assert.equal(
        after.appearanceBodies,
        before.appearanceBodies,
        'D/preview/commit/Undo retain unchanged Appearance control JSX.',
      );
    },
  );

  await run(
    'sidebar and project lifecycle preserve disabled drafts while actual inspector hides reset them',
    async ({
      page,
      canvas,
      panel,
      width,
      net,
      select,
      host,
      state,
      settle,
      remember,
      retained,
    }) => {
      await select();
      await remember();
      const baseline = await state();
      await width.fill('0.6');
      await host({ sidebar: false });
      assert.equal(await panel.isVisible(), false);
      assert.equal(
        await width.inputValue(),
        '0.6',
        'Sidebar hiding preserves its uncommitted valid draft.',
      );
      await width.dispatchEvent('keydown', { key: 'Enter', bubbles: true });
      await width.dispatchEvent('blur');
      assert.equal(
        (await state()).revision,
        baseline.revision,
        'Hidden synthetic input events cannot commit.',
      );
      await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click();
      assert.equal(await width.isVisible(), true);
      assert.equal(await retained(), true);
      assert.equal(await width.inputValue(), '0.6');
      await width.press('Escape');
      await width.fill('0');
      await width.press('Enter');
      assert.equal(await width.getAttribute('aria-invalid'), 'true');
      await host({ sidebar: false });
      assert.equal(await width.inputValue(), '0');
      assert.equal(
        await width.getAttribute('aria-invalid'),
        'true',
        'Sidebar hiding preserves invalid state as well as its draft.',
      );
      await host({ sidebar: true });
      assert.equal(await width.inputValue(), '0');
      assert.equal(await width.getAttribute('aria-invalid'), 'true');
      await width.press('Escape');
      await net.click();
      assert.equal(await page.getByRole('listbox', { name: 'Track net', exact: true }).count(), 1);
      await host({ sidebar: false });
      assert.equal(
        await page.getByRole('listbox', { name: 'Track net', exact: true }).count(),
        0,
        'A portal is removed in the hide commit.',
      );
      await net.dispatchEvent('keydown', { key: 'ArrowDown', bubbles: true });
      assert.equal(await page.getByRole('listbox', { name: 'Track net', exact: true }).count(), 0);
      await host({ sidebar: true });
      assert.equal(await net.getAttribute('aria-expanded'), 'false');
      await width.fill('0');
      await width.press('Enter');
      await net.click();
      await host({ active: false });
      assert.equal(await panel.getAttribute('inert'), '');
      assert.equal(await page.getByRole('listbox', { name: 'Track net', exact: true }).count(), 0);
      await canvas.dispatchEvent('keydown', { key: 'd', bubbles: true });
      assert.equal(
        await canvas.locator('[data-track-drag-preview]').count(),
        0,
        'Inactive projects ignore edit shortcuts.',
      );
      await host({ active: true });
      assert.equal(await retained(), true);
      assert.equal(await width.inputValue(), '0');
      assert.equal(
        await width.getAttribute('aria-invalid'),
        'true',
        'Project deactivation preserves its local draft.',
      );
      await host({ visible: false });
      assert.equal(await width.getAttribute('aria-invalid'), 'true');
      await host({ visible: true });
      assert.equal(await width.inputValue(), '0');
      await width.press('Escape');
      for (const draft of ['0.6', '0']) {
        await width.fill(draft);
        if (draft === '0') await width.press('Enter');
        // Invoke the real canvas handler without a preceding field blur, as an
        // external origin-bound editor command can hide the inspector directly.
        await canvas.dispatchEvent('keydown', { key: 'd', bubbles: true });
        assert.equal(await panel.isVisible(), false);
        assert.equal(
          await width.inputValue(),
          String(originalWidth),
          'D pickup resets a formerly unmounted inspector draft.',
        );
        assert.equal(await width.getAttribute('aria-invalid'), null);
        await canvas.press('Escape');
        await select();
      }
      assert.equal((await state()).revision, baseline.revision);
      // Hidden render-prop retention must reveal the latest document and actions.
      await host({ sidebar: false });
      await page.evaluate((id) => window.changeTrackWidth(id, 0.55), trackId);
      await settle();
      await host({ sidebar: true });
      assert.equal(await retained(), true);
      assert.equal(await width.inputValue(), '0.55');
      await width.fill('0.65');
      await width.press('Enter');
      assert.equal(
        (await state()).board.tracks.find((track) => track.id === trackId).width,
        0.65,
        'Revealed fields use the current document callback.',
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal((await state()).source, baseline.source);
      await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click();
      assert.equal(await panel.isVisible(), false);
      await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click();
      assert.equal(
        await panel.isVisible(),
        true,
        'Sidebar controls preserve hide/reopen semantics.',
      );
      assert.equal(await retained(), true);
    },
  );

  await run(
    'changing a track subject resets local field state and binds the new stable ID',
    async ({ page, width, select, state, remember, retained }) => {
      await select();
      await remember();
      const baseline = await state();
      await width.fill('0');
      await width.press('Enter');
      const other = project.pcb.tracks.find((track) => track.id === otherId);
      await select(
        { x: (other.start.x + other.end.x) / 2, y: (other.start.y + other.end.y) / 2 },
        otherId,
      );
      assert.equal(
        await retained(),
        false,
        'A different stable subject gets independent local form state.',
      );
      assert.equal(await width.inputValue(), String(other.width));
      assert.equal(await width.getAttribute('aria-invalid'), null);
      await width.fill('0.45');
      await width.press('Enter');
      const changed = await state();
      assert.equal(changed.board.tracks.find((track) => track.id === otherId).width, 0.45);
      assert.equal(
        changed.board.tracks.find((track) => track.id === trackId).width,
        originalWidth,
        'A new subject never edits the previously retained part.',
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal((await state()).source, baseline.source);
    },
  );

  await run(
    'Source rejection retains an exact retry while cancel and origin placement stay clean',
    async ({
      page,
      canvas,
      panel,
      width,
      marker,
      select,
      point,
      state,
      remember,
      retained,
      preview,
      settle,
    }) => {
      await select();
      await remember();
      const baseline = await state();
      await canvas.focus();
      await canvas.press('d');
      await point(target);
      const displayed = await preview();
      await page.evaluate(() => window.stageSource());
      await settle();
      await canvas.press('Enter');
      const rejected = await state();
      assert.equal(rejected.pending, true);
      assert.equal(rejected.commits, 0);
      assert.match(rejected.error, /Source/i);
      assert.deepEqual(rejected.board, baseline.board);
      assert.equal(await marker.count(), 1);
      assert.equal(await panel.isVisible(), false);
      assert.equal(await retained(), true);
      assert.deepEqual(
        await preview(),
        displayed,
        'Source rejection restores the exact explicit draft.',
      );
      await page.evaluate(() => window.clearSource());
      await settle();
      await canvas.press('Enter');
      assert.equal(await marker.count(), 0);
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      assert.equal(await retained(), true);
      assert.equal(await width.isVisible(), true);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      const restored = await state();
      assert.equal(restored.source, baseline.source);
      await point(pickup);
      await canvas.focus();
      await canvas.press('d');
      await point(target);
      await canvas.press('Escape');
      assert.equal(await marker.count(), 0);
      assert.equal((await state()).revision, restored.revision, 'Escape creates no transaction.');
      await point(pickup);
      await canvas.press('d');
      await canvas.press('Enter');
      assert.equal(await marker.count(), 0);
      assert.equal(
        (await state()).revision,
        restored.revision,
        'Placing the unchanged pickup is a no-op.',
      );
      assert.equal((await state()).source, baseline.source);
      assert.equal(await retained(), true);
    },
  );
} finally {
  await browser.close();
}
