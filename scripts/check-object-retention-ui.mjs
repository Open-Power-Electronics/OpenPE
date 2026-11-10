import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import {
  openDisplayDrawer,
  closeDisplayDrawer,
  assertEditorViewControls,
  assertToolbarSidebarPlacement,
  assertProjectCloseReveal,
} from './visualization-test-helpers.mjs';
import {
  readSource,
  readNativeProject,
  readNativeFiles,
  fillNativeProject,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';

// Full workspace, isolated browser, in-memory service/native bridge. No Electron,
// user profiles, downloads, providers or project writes.
const { createProject, serializeProject, projectNativeFiles, projectFromNativeFiles } =
  await tsImport('../lib/project.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { defaultAppearance } = await tsImport('../lib/appearance.ts', import.meta.url);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const projects = ['First board', 'Second board'].map((name, index) => {
  const project = createProject();
  project.name = name;
  project.pcb = createEmptyPCB();
  const corners = [
    [0, 0],
    [30, 0],
    [30, 20],
    [0, 20],
  ];
  project.pcb.graphics = corners.map(([x, y], i) => ({
    id: crypto.randomUUID(),
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x, y },
    end: { x: corners[(i + 1) % 4][0], y: corners[(i + 1) % 4][1] },
  }));
  project.pcb.footprints = ['Part', 'Other'].map((part, i) => ({
    id: crypto.randomUUID(),
    symbolId: null,
    libraryId: `Fixture:${part}`,
    reference: `J${i + 1}`,
    value: part,
    x: 10 + i * 10,
    y: 10,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: crypto.randomUUID(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        size: { x: 1, y: 1 },
        shape: 'rect',
        type: 'smd',
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
  const native = projectFromNativeFiles(projectNativeFiles(project, `board-${index}.kicad_pro`));
  native.name = name;
  return native;
});
const ids = projects.map(() => crypto.randomUUID());
const focusedLayoutComplete = Symbol('focused-layout-complete');
let recovery = {
  ...defaultAgentPreferences,
  version: 2,
  documents: projects.map((project, i) => ({
    id: ids[i],
    source: serializeProject(project),
    sourceDraft: null,
    dirty: false,
    filename: `board-${i}.kicad_pro`,
    sessions: [{ id: `session-${i}`, messages: [], draft: '' }],
    activeSessionId: `session-${i}`,
  })),
  activeDocumentId: ids[0],
};
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {EditorView} from '@codemirror/view';
      import {undoDepth, redoDepth} from '@codemirror/commands';
      import Workspace from './components/DesktopWorkspace';
      window.inspectSource = () => {
        const view = EditorView.findFromDOM(document.querySelector('.source-editor-code .cm-editor'));
        return {text:view.state.doc.toString(), selection:view.state.selection.toJSON(),
          undo:undoDepth(view.state), redo:redoDepth(view.state)};
      };
      createRoot(document.getElementById('root')).render(<Workspace/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/object-retention-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-object-lifecycle',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: file }) => {
          const contents = await readFile(file, 'utf8');
          assert.ok(
            contents.includes('renderer.dispose();'),
            'Observe the live renderer disposal path.',
          );
          assert.ok(
            contents.includes('          updateScale.current();'),
            'Observe the current Model render callback.',
          );
          return {
            contents: contents
              .replace(
                'host.current.appendChild(renderer.domElement);',
                'window.created++; host.current.appendChild(renderer.domElement);',
              )
              .replace(
                '          updateScale.current();',
                `
              const span = (depth) => {
                const center = orbit.target.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), depth);
                const above = center.clone().add(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion));
                return above.project(camera).y - center.project(camera).y;
              };
              window.cameras[board.id] = {position:camera.position.toArray(), target:orbit.target.toArray(),
                up:camera.up.toArray(), zoom:camera.zoom, type:camera.type, span:span(0), depths:[span(-5), span(5)]};
              window.scenes[board.id] = scene;
          updateScale.current();`,
              )
              .replace('renderer.dispose();', 'window.disposed++; renderer.dispose();'),
            loader: 'tsx',
            resolveDir: path.dirname(file),
          };
        });
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(15000);
  const errors = [],
    requests = { models: 0, details: 0 };
  let rejectNextModel = false;
  let releaseFirstModel, firstModelStarted;
  const firstModelGate = new Promise((resolve) => {
    releaseFirstModel = resolve;
  });
  const firstRequest = new Promise((resolve) => {
    firstModelStarted = resolve;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.created = 0;
    window.disposed = 0;
    window.cameras = {};
    window.scenes = {};
    window.openpe = {
      titleBarOverlay: false,
      projectDirectory: async () => ({ entries: [], truncated: false }),
      listExamples: async () => ({ entries: [], warnings: [] }),
      listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
      onRecentChanged: () => () => {},
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: defaultAppearance });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/libraries/footprints') {
      requests.details++;
      return route.fulfill({
        json: {
          footprint: ['footprint', '"Part"', ['model', '"Fixture.step"']],
          models: [{ path: 'Fixture.step' }],
        },
      });
    }
    if (url.pathname === '/api/library-model') {
      requests.models++;
      if (requests.models === 1) {
        firstModelStarted();
        await firstModelGate;
      }
      if (rejectNextModel) {
        rejectNextModel = false;
        return route.fulfill({ status: 422, json: { error: 'Fixture model unavailable. Retry.' } });
      }
      return route.fulfill({
        json: {
          meshes: [
            {
              attributes: { position: { array: [0, 0, 0, 2, 0, 0, 0, 2, 2] } },
              index: { array: [0, 1, 2] },
            },
          ],
        },
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const checkbox = (name) => page.getByRole('checkbox', { name, exact: true });
  const partsList = page.getByRole('dialog', { name: 'List', exact: true });
  const selectionFilters = page
    .getByRole('group', { name: 'Selection', exact: true })
    .locator('.editor-display-drawer-body');
  const visualization = page
    .getByRole('group', { name: 'Visualization', exact: true })
    .locator('.editor-display-drawer-body');
  const openSelectionFilters = async () => {
    await openDisplayDrawer(page, 'Selection');
    await selectionFilters.waitFor();
    assert.equal(
      await page.getByRole('dialog', { name: 'Selection', exact: true }).count(),
      0,
      'Selection remains in the retained sidebar.',
    );
  };
  const closeSelectionFilters = async () => {
    await selectionFilters.getByRole('checkbox').first().focus();
    await page.keyboard.press('Escape');
    await selectionFilters.waitFor({ state: 'hidden' });
    assert.equal(
      await button('Selection').evaluate((element) => element === document.activeElement),
      true,
      'Escape restores focus to the Selection trigger.',
    );
  };
  const openVisualization = async (tab) => {
    await openDisplayDrawer(page, 'Visualization');
    await visualization.waitFor();
    if (tab) await visualization.getByRole('tab', { name: tab, exact: true }).click();
    assert.equal(
      await page.getByRole('dialog', { name: 'Visualization', exact: true }).count(),
      0,
      'Visualization remains in the retained display drawer.',
    );
  };
  const closeVisualization = async () => {
    await visualization
      .locator('[role="tab"][aria-selected="true"], input[type="checkbox"]')
      .first()
      .focus();
    await page.keyboard.press('Escape');
    await visualization.waitFor({ state: 'hidden' });
    assert.equal(
      await button('Visualization').evaluate((element) => element === document.activeElement),
      true,
      'Escape restores focus to the Visualization trigger.',
    );
  };
  const inspectSource = () => page.evaluate(() => window.inspectSource());
  const assertToolbarOrder = async (mode) => {
    const toolbar = page.locator('.editor-mode-actions:visible');
    assert.equal(await toolbar.count(), 1, `${mode} has one visible document-action toolbar.`);
    const labels = await toolbar
      .locator('button:visible')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
    const expected = mode === 'Source' ? ['List', 'Git'] : ['List', 'Git', 'Toggle right sidebar'];
    assert.deepEqual(
      labels,
      expected,
      `${mode} keeps List and Git before the rightmost dock visibility control.`,
    );
    const rules = page.getByRole('button', { name: 'Rule', exact: true });
    assert.equal(
      await page.getByRole('button', { name: 'Rule', exact: true }).count(),
      1,
      `${mode} has one shared footer rule-count trigger.`,
    );
    assert.equal(await toolbar.getByRole('button', { name: 'Rule', exact: true }).count(), 0);
    assert.equal(await rules.evaluate((element) => !!element.closest('.status-bar')), true);
    assert.equal(await rules.locator('[data-rule-errors], [data-rule-warnings]').count(), 2);
    assert.equal(await rules.getAttribute('aria-haspopup'), 'dialog');
    for (const name of ['Rule', 'Electrical rules (ERC)', 'Design rules (DRC)'])
      assert.equal(
        await page
          .locator('.editor-toolbar:visible')
          .locator(`button[aria-label="${name}"]`)
          .count(),
        0,
        `${mode} has no separate drawing-toolbar rule control.`,
      );
    if (mode === 'Source') assert.equal(labels.includes('Toggle right sidebar'), false);
    else
      await assertToolbarSidebarPlacement(
        page.locator('.editor-drawing-region:visible .editor-toolbar'),
      );
    assert.equal(labels.filter((label) => label === 'List').length, 1);
    assert.equal(labels.filter((label) => label === 'Selection').length, 0);
    assert.equal(labels.filter((label) => label === 'Visualization').length, 0);
    for (const name of ['Selection', 'Visualization']) {
      if (mode === 'Source') {
        assert.equal(await button(name).count(), 0, `Source has no ${name} disclosure.`);
      } else {
        assert.equal(
          await button(name).evaluate((element) => !!element.closest('.editor-display-drawers')),
          true,
          `${mode} keeps ${name} in the bottom display drawers.`,
        );
      }
    }
  };
  const selectProject = (i) =>
    page.locator(`.project-navigation [data-project-id="${ids[i]}"] button:visible`).click();
  const ready = () =>
    page.waitForFunction(() => {
      const preview = document.querySelector('.pcb-model-preview');
      return (
        preview && !preview.querySelector('.pcb-model-status') && preview.querySelector('canvas')
      );
    });
  const camera = () => page.evaluate((id) => window.cameras[id], projects[0].pcb.id);
  const samePose = (actual, expected) => {
    for (const key of ['position', 'target', 'up'])
      actual[key].forEach((value, i) =>
        assert.ok(
          Math.abs(value - expected[key][i]) < 1e-8,
          `Retained camera ${key}[${i}] delta ${value - expected[key][i]}: ${JSON.stringify({ actual, expected })}`,
        ),
      );
  };
  const sameCamera = (actual, expected) => {
    samePose(actual, expected);
    assert.equal(actual.type, expected.type);
    assert.ok(
      Math.abs(actual.zoom - expected.zoom) < 1e-8,
      `Retained camera zoom delta ${actual.zoom - expected.zoom}: ${JSON.stringify({ actual, expected })}`,
    );
    assert.ok(
      Math.abs(actual.span - expected.span) < 1e-8,
      `Retained camera span delta ${actual.span - expected.span}: ${JSON.stringify({ actual, expected })}`,
    );
  };
  const visibilityStyle = (drawer) =>
    drawer
      .locator('.editor-visibility-row')
      .first()
      .evaluate((row) => {
        const style = getComputedStyle(row);
        const swatch = row.querySelector('.editor-visibility-swatch').getBoundingClientRect();
        const eye = row.querySelector('.editor-visibility-toggle').getBoundingClientRect();
        return {
          font: [style.fontFamily, style.fontSize, style.lineHeight],
          row: [style.minHeight, style.borderRadius],
          swatch: [swatch.width, swatch.height],
          eye: [eye.width, eye.height],
        };
      });
  const filterStyle = () =>
    selectionFilters.locator('.editor-filter-grid').evaluate((grid) => {
      const style = getComputedStyle(grid);
      const label = grid.querySelector('label');
      const rowStyle = getComputedStyle(label);
      const inputStyle = getComputedStyle(label.querySelector('input'));
      return {
        columns: style.gridTemplateColumns.split(' ').length,
        grid: [style.columnGap, style.padding, style.fontSize],
        row: [rowStyle.minHeight, rowStyle.gap, rowStyle.lineHeight],
        checkbox: [inputStyle.width, inputStyle.height, inputStyle.margin],
      };
    });
  await page.getByTestId('schematic-canvas').waitFor();
  const assertGridPopup = async (grid) => {
    const spacing = await grid.getAttribute('aria-description');
    assert.match(spacing, /^(?:Off|\d+(?:\.\d+)? mm)$/);
    assert.equal((await grid.textContent()).trim(), spacing);
    assert.equal(await grid.locator('svg.lucide-grid3x3').count(), 1);
    await grid.press('Enter');
    const list = page.getByRole('listbox', { name: 'Grid density', exact: true });
    await list.waitFor();
    assert.equal(
      await list.getByRole('option', { name: spacing, exact: true }).getAttribute('aria-selected'),
      'true',
    );
    const region = grid.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " editor-drawing-region ")][1]',
    );
    const [menu, footer, drawing] = await Promise.all([
      list.boundingBox(),
      grid.locator('xpath=ancestor::footer').boundingBox(),
      region.boundingBox(),
    ]);
    assert.ok(menu.x >= drawing.x && menu.x + menu.width <= drawing.x + drawing.width);
    assert.ok(menu.y >= drawing.y);
    assert.ok(Math.abs(footer.y - menu.y - menu.height - 8) <= 1);
    assert.ok(menu.width >= 88 && menu.width < 104, 'Grid uses a compact option menu.');
    assert.ok(Math.abs(footer.x + footer.width - menu.x - menu.width - 8) <= 1);
    const rule = page.getByRole('dialog', { name: 'Rule', exact: true });
    if (await rule.isVisible()) {
      const left = await rule.boundingBox();
      assert.ok(
        Math.abs(left.x - footer.x - (footer.x + footer.width - menu.x - menu.width)) <= 1,
        JSON.stringify({ left, menu, footer }),
      );
      assert.ok(Math.abs(left.y + left.height - menu.y - menu.height) <= 1);
    }
    await grid.press('Escape');
    await list.waitFor({ state: 'detached' });
    assert.equal(await grid.evaluate((element) => document.activeElement === element), true);
  };
  if (process.argv.includes('--grid-popup')) {
    const grid = page.getByRole('combobox', { name: 'Grid density', exact: true });
    const rule = page.getByRole('dialog', { name: 'Rule', exact: true });
    const assertStatusItems = async () => {
      await waitForAsync(page, () => {
        const footer = [...document.querySelectorAll('.status-bar')].find(
          (element) => element.getClientRects().length && element.querySelector('.grid-density'),
        );
        if (!footer) return false;
        const trigger = footer.querySelector('.grid-density .select-trigger');
        const counts = footer.querySelector('.rule-status');
        const coordinate = footer.querySelector('.status-center .status-coordinate');
        const gridStyle = getComputedStyle(trigger);
        const countStyle = getComputedStyle(counts);
        const coordinateStyle = coordinate && getComputedStyle(coordinate);
        return (
          gridStyle.backgroundColor !== getComputedStyle(footer).backgroundColor &&
          countStyle.backgroundColor === gridStyle.backgroundColor &&
          countStyle.borderRadius === gridStyle.borderRadius &&
          countStyle.minHeight === gridStyle.minHeight &&
          (!coordinateStyle ||
            (coordinateStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
              coordinateStyle.borderTopWidth === '0px'))
        );
      });
      const counts = button('Rule');
      const [left, right] = await Promise.all([counts.boundingBox(), grid.boundingBox()]);
      assert.ok(Math.abs(left.y + left.height / 2 - right.y - right.height / 2) <= 1);
    };
    releaseFirstModel();
    for (const view of ['Schematic', 'Layout', 'Model']) {
      await button(view).click();
      if (view === 'Model') await ready();
      await assertStatusItems();
      await button('Rule').click();
      await rule.waitFor();
      await assertGridPopup(grid);
      await button('Close Rule').click();
      if (view !== 'Model') {
        const coordinate = page.locator('.status-bar:visible .status-center .status-coordinate');
        assert.equal(
          await coordinate.evaluate((element) => {
            const coordinateStyle = getComputedStyle(element);
            const footerStyle = getComputedStyle(element.closest('footer'));
            const first = element.firstElementChild.getBoundingClientRect();
            const second = element
              .querySelector('.status-coordinate-next-axis')
              .getBoundingClientRect();
            return (
              coordinateStyle.fontFamily === footerStyle.fontFamily &&
              coordinateStyle.fontSize === footerStyle.fontSize &&
              coordinateStyle.fontWeight === '500' &&
              coordinateStyle.fontVariantNumeric === 'tabular-nums' &&
              second.left - first.right >= 8
            );
          }),
          true,
        );
      }
    }
    await button('Schematic').click();
    await page.setViewportSize({ width: 1120, height: 740 });
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      document.activeElement?.blur();
      document.documentElement.dataset.theme = 'dark';
    });
    await assertStatusItems();
    await assertGridPopup(grid);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: shared footer styling and compact Grid popup placement in Schematic, Layout and Model.',
    );
    throw focusedLayoutComplete;
  }
  const statusRowOnly = process.argv.includes('--status-row');
  if (statusRowOnly || process.argv.includes('--status-layout')) {
    await button('Source').click();
    const originalNative = await readNativeFiles(page);
    await button('Schematic').click();
    const assertStatusRuleControls = async (view) => {
      const rules = page.getByRole('button', { name: 'Rule', exact: true });
      const grid = page.getByRole('combobox', { name: 'Grid density', exact: true });
      const [ruleBox, gridBox] = await Promise.all([rules.boundingBox(), grid.boundingBox()]);
      assert.ok(
        Math.abs(ruleBox.height - gridBox.height) < 1,
        `${view} Rule counts and Grid share control height.`,
      );
      assert.equal(
        await page.getByRole('combobox', { name: 'Editor mode', exact: true }).count(),
        0,
      );
      assert.equal(await rules.locator('[data-rule-errors], [data-rule-warnings]').count(), 2);
      assert.equal(await rules.getAttribute('aria-haspopup'), 'dialog');
      if (view !== 'Model') {
        const coordinate = page.locator('.status-bar:visible .status-center .status-coordinate');
        await coordinate.waitFor();
        const footer = coordinate.locator('xpath=ancestor::footer');
        const [readout, bounds] = await Promise.all([
          coordinate.boundingBox(),
          footer.boundingBox(),
        ]);
        assert.ok(
          Math.abs(readout.x + readout.width / 2 - bounds.x - bounds.width / 2) <= 3,
          `${view} live coordinates are centered on the drawing footer.`,
        );
        const drawing = page.getByTestId(
          view === 'Schematic' ? 'schematic-canvas' : 'layout-canvas',
        );
        await drawing.hover({ position: { x: 40, y: 40 } });
        const before = await coordinate.textContent();
        await drawing.hover({ position: { x: 90, y: 80 } });
        await page.waitForFunction(
          (before) =>
            document.querySelector('.status-center .status-coordinate')?.textContent !== before,
          before,
        );
        assert.match(await coordinate.textContent(), /X .+ Y .+ mm/);
        await rules.locator('[data-rule-errors]:not([data-rule-errors="unknown"])').waitFor();
        await page.screenshot({
          path: `test-results/status-coordinates-${view.toLowerCase()}.png`,
          animations: 'disabled',
        });
        const originalViewport = page.viewportSize();
        await page.setViewportSize({ width: 1120, height: originalViewport.height });
        const [compact, compactFooter, compactRule, compactGrid] = await Promise.all([
          coordinate.boundingBox(),
          footer.boundingBox(),
          rules.boundingBox(),
          grid.boundingBox(),
        ]);
        assert.ok(compactFooter.width <= 480, `${view} exercises a narrow drawing footer.`);
        for (const control of [compactRule, compactGrid]) {
          assert.ok(
            Math.abs(compact.y + compact.height / 2 - control.y - control.height / 2) <= 1,
            `${view} coordinates and footer controls stay on one row.`,
          );
        }
        assert.ok(
          compact.x >= compactRule.x + compactRule.width &&
            compact.x + compact.width <= compactGrid.x,
          `${view} coordinates fit between the footer controls.`,
        );
        const [textWidth, visibleWidth] = await coordinate.evaluate((element) => [
          element.scrollWidth,
          element.clientWidth,
        ]);
        assert.ok(
          textWidth <= visibleWidth + 1,
          `${view} coordinates fit in the compact footer (${textWidth} px of ${visibleWidth} px).`,
        );
        assert.ok(
          Math.abs(compactGrid.x + compactGrid.width - compactFooter.x - compactFooter.width + 4) <=
            1,
          `${view} Grid stays at the right edge of the single row.`,
        );
        if (view === 'Layout') {
          await footer.evaluate((element) => (element.style.inlineSize = '160px'));
          await grid.focus();
          assert.equal(
            await grid.evaluate((control) => {
              const footer = control.closest('footer');
              const bounds = footer.getBoundingClientRect();
              const grid = control.getBoundingClientRect();
              return (
                footer.scrollLeft > 0 &&
                grid.left >= bounds.left &&
                grid.right <= bounds.left + footer.clientWidth
              );
            }),
            true,
            'Grid remains reachable by keyboard at the minimum drawing width.',
          );
          await footer.evaluate((element) => element.style.removeProperty('inline-size'));
        }
        await page.setViewportSize(originalViewport);
      }
      assert.equal((await grid.textContent()).trim(), await grid.getAttribute('aria-description'));
      assert.equal(await grid.locator('svg.lucide-grid3x3').count(), 1);
      for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
        await rules.dispatchEvent('keydown', { key: 'Enter', ...event });
        assert.equal(await rules.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.getByRole('dialog', { name: 'Rule', exact: true }).count(), 0);
      }
      await button('Annotation mode').click();
      assert.equal(await button('Annotation mode').getAttribute('aria-pressed'), 'true');
      await button('Interaction mode').focus();
      await page.keyboard.press('Enter');
      assert.equal(await button('Interaction mode').getAttribute('aria-pressed'), 'true');
    };
    const assertSidebarDragResize = async (view) => {
      const sidebar = page.locator('.editor-sidebar-sections:visible');
      const handle = sidebar.locator('..').locator(':scope > .inspector-resize-gutter:visible');
      const original = await sidebar.boundingBox();
      const hit = await handle.boundingBox();
      assert.equal(hit.width, 12, `${view} exposes the full gap as its resize target.`);
      assert.ok(Math.abs(hit.height - original.height) <= 1);
      const grip = await handle.evaluate((element) => {
        const style = getComputedStyle(element, '::after');
        return { opacity: Number(style.opacity), width: style.width, height: style.height };
      });
      assert.ok(grip.opacity > 0 && grip.opacity < 0.5);
      assert.deepEqual([grip.width, grip.height], ['2px', '32px']);
      for (const fraction of [0.15, 0.5, 0.85]) {
        const edge = await handle.boundingBox();
        const start = { x: edge.x + edge.width / 2, y: edge.y + edge.height * fraction };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x - 48, start.y, { steps: 6 });
        assert.ok(
          Math.abs((await sidebar.boundingBox()).width - original.width - 48) <= 1,
          `${view} resizes from the full-height left edge.`,
        );
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.ok(
          Math.abs((await sidebar.boundingBox()).width - original.width) <= 1,
          `${view} Escape restores the width before dragging.`,
        );
      }
      await handle.focus();
      for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
        await handle.dispatchEvent('keydown', { key: 'ArrowLeft', ...event });
        assert.equal(
          (await sidebar.boundingBox()).width,
          original.width,
          `${view} IME navigation leaves the sidebar width unchanged.`,
        );
      }
      const edge = await handle.boundingBox();
      const start = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 64, start.y, { steps: 6 });
      await page.mouse.up();
      const resized = (await sidebar.boundingBox()).width;
      assert.ok(Math.abs(resized - original.width - 64) <= 1);
      await button('Toggle right sidebar').click();
      await button('Toggle right sidebar').click();
      assert.equal(
        (await sidebar.boundingBox()).width,
        resized,
        `${view} keeps its dragged width while hidden.`,
      );
      await handle.dblclick();
      assert.equal(
        (await sidebar.boundingBox()).width,
        original.width,
        `${view} double-click resets the sidebar width.`,
      );
    };
    const assertDrawingRegions = async (view) => {
      await assertEditorViewControls(page, view);
      const region = page.locator('.editor-drawing-region:visible');
      assert.equal(await region.locator('.zoom-controls').count(), 0);
      const dock = page.locator('.editor-sidebar-sections:visible');
      const geometry = await region.evaluate((element) => {
        const bounds = element.getBoundingClientRect(),
          status = element.querySelector('.status-bar').getBoundingClientRect(),
          grid = element.querySelector('.grid-density').getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          bottom: bounds.bottom,
          statusRight: status.right,
          gridRight: grid.right,
        };
      });
      const sidebar = await dock.boundingBox();
      assert.ok(Math.abs(sidebar.x - geometry.right - 12) <= 1);
      assert.ok(Math.abs(sidebar.y + sidebar.height - geometry.bottom) <= 1);
      assert.ok(geometry.gridRight <= geometry.statusRight && geometry.statusRight < sidebar.x);
      await assertToolbarSidebarPlacement(region.locator('.editor-toolbar'));
      const rule = region.getByRole('button', { name: 'Rule', exact: true });
      assert.equal(await rule.count(), 1);
      assert.equal(await rule.evaluate((element) => !!element.closest('.status-bar')), true);
      assert.equal(await region.locator('.editor-tool-group-end').count(), 0);
      for (const name of ['Electrical rules (ERC)', 'Design rules (DRC)'])
        assert.equal(await region.locator(`button[aria-label="${name}"]`).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'List', exact: true }).count(), 1);
      await page.screenshot({
        path: 'test-results/editor-regions-' + view.toLowerCase() + '.png',
        animations: 'disabled',
      });
    };
    for (const view of ['Schematic', 'Layout']) {
      await button(view).click();
      await page.getByTestId(view === 'Layout' ? 'layout-canvas' : 'schematic-canvas').waitFor();
      if (!statusRowOnly) await assertDrawingRegions(view);
      await assertStatusRuleControls(view);
      if (statusRowOnly) continue;
      await assertSidebarDragResize(view);
      {
        const canvasId = view === 'Layout' ? 'layout-canvas' : 'schematic-canvas';
        const canvas = page.getByTestId(canvasId);
        await button('Source').click();
        const native = await readNativeFiles(page);
        await button(view).click();
        const width = () =>
          canvas.evaluate((svg) => {
            const matrix = svg.getScreenCTM();
            return svg.closest('.canvas-wrap').clientWidth / Math.hypot(matrix.a, matrix.b);
          });
        await runCanvasAction(page, view === 'Layout' ? 'Fit board to canvas' : 'Fit to canvas');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const fittedWidth = await width();
        const before = await width();
        await runCanvasAction(page, 'Zoom in');
        await waitForAsync(
          page,
          ([id, value]) => {
            const svg = document.querySelector(`[data-testid="${id}"]`);
            const matrix = svg.getScreenCTM();
            return svg.closest('.canvas-wrap').clientWidth / Math.hypot(matrix.a, matrix.b) < value;
          },
          [canvasId, before],
        );
        await canvas.hover();
        const zoomed = await width();
        await page.mouse.wheel(0, 100);
        await page.waitForFunction(
          ([id, value]) => {
            const svg = document.querySelector(`[data-testid="${id}"]`);
            const matrix = svg.getScreenCTM();
            return svg.closest('.canvas-wrap').clientWidth / Math.hypot(matrix.a, matrix.b) > value;
          },
          [canvasId, zoomed],
        );
        await canvas.focus();
        await canvas.press('Space');
        await page.waitForFunction(
          ([id, value]) => {
            const svg = document.querySelector(`[data-testid="${id}"]`);
            const matrix = svg.getScreenCTM();
            const current =
              svg.closest('.canvas-wrap').clientWidth / Math.hypot(matrix.a, matrix.b);
            return Math.abs(current - value) < value * 1e-6;
          },
          [canvasId, fittedWidth],
        );
        await button('Source').click();
        assert.deepEqual(
          await readNativeFiles(page),
          native,
          'Camera navigation leaves native design unchanged.',
        );
        await button(view).click();
      }
      await button('Toggle right sidebar').click();
      assert.equal(await page.locator('.editor-sidebar-sections:visible').count(), 0);
      await assertToolbarSidebarPlacement(
        page.locator('.editor-drawing-region:visible .editor-toolbar'),
      );
      await button('Toggle right sidebar').click();
      await assertDrawingRegions(view);
    }
    if (statusRowOnly) {
      assert.deepEqual(errors, []);
      console.log('PASS: Schematic and Layout keep Rule, coordinates and Grid on one narrow row.');
      throw focusedLayoutComplete;
    }
    await button('Model').click();
    await firstRequest;
    const loadingFooter = page.locator('footer[aria-label="Editor status"]:visible');
    const loadingStatus = loadingFooter.locator('.status-center .pcb-model-status');
    await loadingStatus.waitFor();
    assert.match(await loadingStatus.textContent(), /Loading components · \d+\/\d+.*J1/);
    assert.equal(
      await page.locator('.pcb-object-stage .pcb-model-status').count(),
      0,
      'Editable Model loading has no canvas-top status.',
    );
    const loadingGeometry = await loadingStatus.evaluate((element) => {
      const text = element.getBoundingClientRect();
      const footer = element.closest('footer').getBoundingClientRect();
      const center = element.closest('.status-center');
      const rule = element.closest('footer').querySelector('.rule-status').getBoundingClientRect();
      const grid = element.closest('footer').querySelector('.grid-density').getBoundingClientRect();
      return {
        within: text.left >= rule.right && text.right <= grid.left,
        centeredHorizontally: Math.abs(text.x + text.width / 2 - footer.x - footer.width / 2) <= 3,
        centeredVertically: Math.abs(text.y + text.height / 2 - footer.y - footer.height / 2) <= 1,
        alignment: getComputedStyle(center).textAlign,
        position: getComputedStyle(element).position,
      };
    });
    assert.deepEqual(loadingGeometry, {
      within: true,
      centeredHorizontally: true,
      centeredVertically: true,
      alignment: 'center',
      position: 'static',
    });
    await page.screenshot({
      path: 'test-results/model-status-loading-footer.png',
      animations: 'disabled',
    });
    releaseFirstModel();
    await ready();
    const dismiss = button('Dismiss notification');
    if (await dismiss.isVisible()) await dismiss.click();
    const footer = page.locator('footer[aria-label="Editor status"]:visible');
    const dock = page.getByRole('complementary', { name: 'Model sidebar', exact: true });
    const canvas = page.locator('.pcb-model-canvas:visible');
    const grid = page.getByRole('combobox', { name: 'Grid density', exact: true });
    assert.equal(
      await grid.getAttribute('aria-description'),
      '5 mm',
      'Model starts with the default 5 mm grid.',
    );
    const assertStatusLayout = async () => {
      const [status, properties, drawing] = await Promise.all([
        footer.boundingBox(),
        dock.boundingBox(),
        canvas.boundingBox(),
      ]);
      assert.equal(await page.locator('.status-bar:visible').count(), 1);
      assert.ok(Math.abs(status.x - drawing.x) <= 1);
      assert.ok(
        Math.abs(status.x + status.width - drawing.x - drawing.width) <= 1,
        'Status spans only the drawing region, leaving the inspector independent.',
      );
      assert.ok(Math.abs(status.y - drawing.y - drawing.height) <= 1);
      assert.ok(
        Math.abs(properties.x - drawing.x - drawing.width - 14) <= 1,
        'Two bordered regions retain a 12 px gap.',
      );
      assert.ok(
        Math.abs(properties.y + properties.height - status.y - status.height - 1) <= 1,
        'Properties extends to the drawing region bottom, beside its status row.',
      );
      const control = await grid.boundingBox();
      assert.equal(await page.locator('.pcb-model-preview .zoom-controls').count(), 0);
      assert.ok(
        Math.abs(control.x + control.width - status.x - status.width + 4) <= 1,
        'Grid remains at the right edge of the drawing footer.',
      );
    };
    await footer.waitFor();
    await assertDrawingRegions('Model');
    await assertStatusRuleControls('Model');
    await assertSidebarDragResize('Model');
    await assertStatusLayout();
    const beforeFitRender = Number(await canvas.getAttribute('data-render-count'));
    await runCanvasAction(page, 'Fit 3D board');
    await waitForAsync(
      page,
      (before) => Number(document.querySelector('.pcb-model-canvas')?.dataset.renderCount) > before,
      beforeFitRender,
    );
    const fittedCamera = await camera();
    await runCanvasAction(page, 'Zoom in');
    await waitForAsync(page, ([id, span]) => window.cameras[id].span > span, [
      projects[0].pcb.id,
      fittedCamera.span,
    ]);
    const zoomedCamera = await camera();
    await canvas.hover();
    await page.mouse.wheel(0, 100);
    await waitForAsync(page, ([id, span]) => window.cameras[id].span < span, [
      projects[0].pcb.id,
      zoomedCamera.span,
    ]);
    await canvas.focus();
    await canvas.press('Space');
    await waitForAsync(page, ([id, span]) => Math.abs(window.cameras[id].span - span) < 1e-8, [
      projects[0].pcb.id,
      fittedCamera.span,
    ]);
    sameCamera(await camera(), fittedCamera);
    const before = await camera();
    const resize = button('Resize model properties width');
    await resize.press('ArrowLeft');
    await assertStatusLayout();
    await resize.press('Home');
    await button('Toggle right sidebar').click();
    await dock.waitFor({ state: 'hidden' });
    assert.ok(
      Math.abs((await footer.boundingBox()).width - (await canvas.boundingBox()).width) <= 1,
    );
    await button('Toggle right sidebar').click();
    await assertStatusLayout();
    sameCamera(await camera(), before);
    await grid.focus();
    for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
      await grid.dispatchEvent('keydown', { key: 'Enter', ...event });
      assert.equal(
        await grid.getAttribute('aria-expanded'),
        'false',
        'IME Enter cannot open Grid.',
      );
    }
    await grid.press('Enter');
    await page.getByRole('listbox', { name: 'Grid density', exact: true }).waitFor();
    await grid.press('Escape');
    assert.equal(await grid.evaluate((node) => node === document.activeElement), true);
    const numberStyle = (element) => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.fontFamily, style.fontWeight, style.fontStyle];
    };
    const modelNumberStyle = await page.locator('.model-scale-value:visible').evaluate(numberStyle);
    await button('Layout').click();
    await page.getByTestId('layout-canvas').waitFor();
    assert.deepEqual(
      await page.getByLabel('Layout scale', { exact: true }).evaluate(numberStyle),
      modelNumberStyle,
      'Model and Layout scale numbers share typography.',
    );
    await button('Schematic').click();
    await page.getByTestId('schematic-canvas').waitFor();
    await button('Model').click();
    await ready();
    await assertStatusLayout();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      );
      await page.screenshot({
        path: `test-results/model-status-layout-${theme}.png`,
        animations: 'disabled',
      });
      await assertProjectCloseReveal(page, theme);
    }
    await page.setViewportSize({ width: 1120, height: 740 });
    await assertStatusLayout();
    await page.screenshot({
      path: 'test-results/model-status-layout-compact.png',
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1000, height: 740 });
    for (let step = 0; step < 16; step++) await resize.press('ArrowLeft');
    await assertStatusLayout();
    await page.screenshot({
      path: 'test-results/model-status-layout-narrow.png',
      animations: 'disabled',
    });
    assert.deepEqual(errors, []);
    await button('Source').click();
    assert.deepEqual(
      await readNativeFiles(page),
      originalNative,
      'Status mode selection and Grid presentation preserve all native files.',
    );
    console.log(
      'PASS: Model drawing-only footer beside independent Properties, control insets, Grid/IME/focus, resize, hidden sidebar and retained view switching.',
    );
    throw focusedLayoutComplete;
  }
  await openVisualization();
  const schematicVisibilityStyle = await visibilityStyle(visualization);
  await closeVisualization();
  await openSelectionFilters();
  const schematicFilterStyle = await filterStyle();
  await closeSelectionFilters();
  const sidebarWidth = (selector) =>
    page.locator(selector).evaluate((element) => element.getBoundingClientRect().width);
  const schematicDefaultWidth = await sidebarWidth('.schematic-properties-dock:visible');
  assert.ok(
    Math.abs(schematicDefaultWidth - 280) <= 1,
    'Schematic starts with the shared 280 px sidebar width.',
  );
  assert.deepEqual(requests, { models: 0, details: 0 }, 'Model remains lazy on startup.');
  await button('Model').click();
  await firstRequest;
  const modelDefaultWidth = await sidebarWidth('.model-properties-dock:visible');
  await page.evaluate(() => {
    window.loadingCanvas = document.querySelector('.pcb-model-canvas canvas');
  });
  await button('Layout').click();
  await page.getByTestId('layout-canvas').waitFor();
  const layoutDefaultWidth = await sidebarWidth('.layout-sidebar:visible');
  for (const [mode, width] of [
    ['Model', modelDefaultWidth],
    ['Layout', layoutDefaultWidth],
  ])
    assert.ok(
      Math.abs(width - schematicDefaultWidth) <= 1,
      `${mode} starts with the same default sidebar width as Schematic.`,
    );
  releaseFirstModel();
  await page.waitForTimeout(200);
  assert.deepEqual(
    requests,
    { models: 1, details: 1 },
    'Hidden Model finishes in-flight work and pauses further requests.',
  );
  await button('Model').click();
  await ready();
  assert.ok(
    await page.evaluate(
      () => window.loadingCanvas === document.querySelector('.pcb-model-canvas canvas'),
    ),
    'Switching during loading retains the canvas and in-flight conversion.',
  );
  assert.deepEqual(requests, { models: 2, details: 2 });
  assert.equal(await page.locator('.pcb-model-issues').count(), 0);
  await page.evaluate(() => {
    window.originalCanvas = document.querySelector('.pcb-model-canvas canvas');
    window.originalScene = Object.values(window.scenes)[0];
  });
  const projection = button('Orthographic projection');
  const waitProjection = (type) =>
    page.waitForFunction(
      ([id, type]) => window.cameras[id]?.type === type,
      [projects[0].pcb.id, type],
    );
  await openVisualization();
  assert.deepEqual(await visualization.getByRole('tab').allTextContents(), [
    'Views',
    'Display',
    'Explosion',
  ]);
  const beforeTabCamera = await camera();
  const viewsTab = visualization.getByRole('tab', { name: 'Views', exact: true });
  const displayTab = visualization.getByRole('tab', { name: 'Display', exact: true });
  const explodedTab = visualization.getByRole('tab', { name: 'Explosion', exact: true });
  assert.equal(await viewsTab.getAttribute('aria-selected'), 'true');
  assert.equal(await projection.isVisible(), true, 'Views contains the projection control.');
  assert.equal(await projection.getAttribute('aria-label'), 'Orthographic projection');
  assert.equal(await projection.getAttribute('title'), null);
  assert.equal(
    (await projection.textContent()).trim(),
    'Orthographic projection',
    'Projection retains its visible label.',
  );
  assert.equal(await projection.locator('svg').count(), 1);
  const presetViews = [
    ['Top view', [0, 0, 1]],
    ['Bottom view', [0, 0, -1]],
    ['Front view', [0, -1, 0]],
    ['Back view', [0, 1, 0]],
    ['Left view', [-1, 0, 0]],
    ['Right view', [1, 0, 0]],
    ['Isometric view', [1, -1, 1]],
  ];
  assert.deepEqual(
    await visualization.locator('.model-view-controls > button').allTextContents(),
    presetViews.map(([label]) => label),
    'Views exposes the six faces and an isometric preset with visible labels.',
  );
  const projectionBounds = await projection.boundingBox();
  const viewBounds = await Promise.all(presetViews.map(([label]) => button(label).boundingBox()));
  assert.ok(projectionBounds && viewBounds.every(Boolean));
  for (let index = 0; index < 6; index += 2) {
    const [left, right] = viewBounds.slice(index, index + 2);
    assert.ok(
      Math.abs(left.y - right.y) <= 1 &&
        right.x >= left.x + left.width &&
        Math.abs(left.width - right.width) <= 1,
      'Opposite faces share an equally sized two-column row.',
    );
    if (index > 0) assert.ok(left.y >= viewBounds[index - 2].y + viewBounds[index - 2].height);
  }
  const isometricBounds = viewBounds.at(-1);
  assert.ok(
    isometricBounds.y >= viewBounds[4].y + viewBounds[4].height &&
      projectionBounds.y >= isometricBounds.y + isometricBounds.height &&
      Math.abs(isometricBounds.x - viewBounds[0].x) <= 1 &&
      Math.abs(isometricBounds.x - projectionBounds.x) <= 1 &&
      Math.abs(isometricBounds.width - projectionBounds.width) <= 1,
    'Isometric spans the last row above the full-width projection control.',
  );
  const columns = await Promise.all(
    [projection, ...['Top view', 'Front view', 'Left view', 'Isometric view'].map(button)].map(
      async (control) => ({
        icon: await control.locator('svg').boundingBox(),
        label: await control.locator('span').boundingBox(),
      }),
    ),
  );
  assert.ok(columns.every(({ icon, label }) => icon && label));
  assert.ok(
    columns.every(
      ({ icon, label }) =>
        Math.abs(icon.x - columns[0].icon.x) <= 1 && Math.abs(label.x - columns[0].label.x) <= 1,
    ),
    'First-column views and projection align their icons and visible labels.',
  );
  const viewsHeight = await visualization.evaluate((element) => {
    const body = element;
    const tabs = element.querySelector('.model-visualization-tabs');
    const controls = element.querySelector('.model-view-controls');
    const projection = element.querySelector('.model-projection-controls');
    const outerHeight = (target) => {
      const style = getComputedStyle(target);
      return (
        target.getBoundingClientRect().height +
        parseFloat(style.marginTop) +
        parseFloat(style.marginBottom)
      );
    };
    return {
      actual: body.getBoundingClientRect().height,
      content: outerHeight(tabs) + outerHeight(controls) + outerHeight(projection),
      bottom: body.getBoundingClientRect().bottom,
      lastControlBottom: projection.getBoundingClientRect().bottom,
    };
  });
  assert.ok(
    viewsHeight.actual <= viewsHeight.content + 2 &&
      viewsHeight.lastControlBottom <= viewsHeight.bottom + 1,
    'Model Visualization fits its view controls without stretching into unused sidebar space.',
  );
  await mkdir('test-results', { recursive: true });
  await visualization.screenshot({ path: 'test-results/model-views-projection.png' });
  for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
    await viewsTab.dispatchEvent('keydown', { key: 'ArrowRight', ...event });
    assert.equal(await viewsTab.getAttribute('aria-selected'), 'true');
  }
  await viewsTab.press('ArrowRight');
  assert.equal(await displayTab.getAttribute('aria-selected'), 'true');
  assert.equal(await projection.count(), 0, 'Only the active visualization panel is exposed.');
  assert.equal(await button('Top view').count(), 0);
  assert.equal(await checkbox('Show components').isVisible(), true);
  await displayTab.press('Home');
  assert.equal(await viewsTab.getAttribute('aria-selected'), 'true');
  await viewsTab.press('ArrowLeft');
  assert.equal(await explodedTab.getAttribute('aria-selected'), 'true');
  await explodedTab.press('ArrowRight');
  assert.equal(await viewsTab.getAttribute('aria-selected'), 'true');
  await viewsTab.press('End');
  assert.equal(await explodedTab.getAttribute('aria-selected'), 'true');
  await explodedTab.press('ArrowLeft');
  assert.equal(await displayTab.getAttribute('aria-selected'), 'true');
  await closeVisualization();
  await openVisualization();
  assert.equal(
    await visualization
      .getByRole('tab', { name: 'Display', exact: true })
      .getAttribute('aria-selected'),
    'true',
    'Reopening retains the chosen visualization tab.',
  );
  sameCamera(await camera(), beforeTabCamera);
  assert.deepEqual(
    await visibilityStyle(visualization),
    schematicVisibilityStyle,
    'Model uses the same visibility typography, row corners, swatches and eye targets as Schematic.',
  );
  await openVisualization('Views');
  assert.equal(await projection.getAttribute('aria-pressed'), 'true');
  await closeVisualization();
  const initialCamera = await camera();
  assert.equal(initialCamera.type, 'OrthographicCamera');
  assert.ok(Math.abs(initialCamera.depths[0] - initialCamera.depths[1]) < 1e-8);
  await runCanvasAction(page, 'Zoom in');
  await page.waitForFunction(
    ([id, span]) => window.cameras[id].span > span,
    [projects[0].pcb.id, initialCamera.span],
  );
  const orthographicZoomed = await camera();
  assert.equal(await page.locator('.pcb-model-preview .zoom-controls').count(), 0);
  await page.screenshot({ path: 'test-results/model-orthographic.png' });
  await openVisualization('Views');
  await projection.click();
  await waitProjection('PerspectiveCamera');
  const perspective = await camera();
  samePose(perspective, orthographicZoomed);
  assert.ok(
    Math.abs(perspective.span - orthographicZoomed.span) < 1e-8,
    'Projection keeps target scale.',
  );
  assert.ok(
    perspective.depths[0] > perspective.depths[1],
    'Perspective gives nearer geometry a larger scale.',
  );
  assert.equal(await projection.getAttribute('aria-pressed'), 'false');
  await closeVisualization();
  assert.equal(await page.locator('.pcb-model-preview .zoom-controls').count(), 0);
  await page.screenshot({ path: 'test-results/model-perspective.png' });
  await openVisualization('Views');
  await projection.click();
  await waitProjection('OrthographicCamera');
  sameCamera(await camera(), orthographicZoomed);
  await projection.focus();
  await page.keyboard.press('Space');
  await waitProjection('PerspectiveCamera');
  await closeVisualization();
  const beforeZoom = await camera();
  await runCanvasAction(page, 'Zoom in');
  await page.waitForFunction(
    ([id, span]) => window.cameras[id].span > span,
    [projects[0].pcb.id, beforeZoom.span],
  );
  assert.ok(Math.abs((await camera()).span / beforeZoom.span - 1.2) < 1e-8);
  await runCanvasAction(page, 'Zoom out');
  await page.waitForFunction(
    ([id, span]) => Math.abs(window.cameras[id].span - span) < 1e-8,
    [projects[0].pcb.id, beforeZoom.span],
  );
  await page.locator('.pcb-model-canvas').hover();
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(
    ([id, span]) => window.cameras[id].span > span,
    [projects[0].pcb.id, beforeZoom.span],
  );
  await runCanvasAction(page, 'Actual size (100%)');
  await page.waitForFunction(
    ([id, height]) => Math.abs((window.cameras[id].span * height) / 2 - 96 / 25.4) < 1e-8,
    [
      projects[0].pcb.id,
      await page.locator('.pcb-model-canvas').evaluate((node) => node.clientHeight),
    ],
  );
  const beforeTop = await camera();
  await openVisualization('Views');
  const orbitCanvas = page.locator('.pcb-model-canvas canvas');
  const orbitBounds = await orbitCanvas.boundingBox();
  const orbitStart = {
    x: orbitBounds.x + orbitBounds.width * 0.4,
    y: orbitBounds.y + orbitBounds.height * 0.45,
  };
  await page.mouse.move(orbitStart.x, orbitStart.y);
  await page.mouse.down();
  await page.mouse.move(orbitStart.x + 40, orbitStart.y + 24, { steps: 4 });
  await page.mouse.up();
  await waitForAsync(
    page,
    async ({ id, position }) => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return (
        Math.hypot(...window.cameras[id].position.map((value, axis) => value - position[axis])) >
        0.001
      );
    },
    { id: projects[0].pcb.id, position: beforeTop.position },
  );
  const presetRequests = { ...requests };
  const waitPreset = (type, direction) =>
    waitForAsync(
      page,
      async ({ id, type, direction }) => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const current = window.cameras[id];
        if (current?.type !== type) return false;
        const offset = current.position.map((value, axis) => value - current.target[axis]);
        const distance = Math.hypot(...offset);
        const length = Math.hypot(...direction);
        return offset.every(
          (value, axis) => Math.abs(value / distance - direction[axis] / length) < 1e-5,
        );
      },
      { id: projects[0].pcb.id, type, direction },
    );
  const viewPixels = [];
  const captureViewPixels = async (stage, label) => {
    const path = `test-results/model-view-${stage}-${label.toLowerCase().replaceAll(' ', '-')}.png`;
    const bounds = await orbitCanvas.boundingBox();
    // Sample the rendered scene without the recovery toast.
    const clip = {
      x: bounds.x + bounds.width * 0.1,
      y: bounds.y + bounds.height * 0.1,
      width: bounds.width * 0.8,
      height: bounds.height * 0.7,
    };
    const image = await page.screenshot({ path, clip });
    const sample = {
      stage,
      label,
      path,
      clip,
      bytes: image.length,
      hash: createHash('sha256').update(image).digest('hex'),
      frame: await orbitCanvas.evaluate((canvas) =>
        Number(canvas.parentElement.dataset.renderCount),
      ),
    };
    viewPixels.push(sample);
    await writeFile('test-results/model-view-pixels.json', JSON.stringify(viewPixels, null, 2));
    return sample;
  };
  const assertDifferentViewPixels = (samples, stage) => {
    assert.equal(samples.length, 3);
    assert.equal(
      new Set(samples.map((sample) => sample.hash)).size,
      3,
      `${stage}: Top, Front and Isometric produce different rendered WebGL canvas pixels.`,
    );
  };
  for (const type of ['PerspectiveCamera', 'OrthographicCamera']) {
    if ((await camera()).type !== type) {
      await projection.click();
      await waitProjection(type);
    }
    const baseline = await camera();
    const distance = Math.hypot(
      ...baseline.position.map((value, axis) => value - baseline.target[axis]),
    );
    const pixelSamples = [];
    for (const [label, direction] of presetViews) {
      const frame = await orbitCanvas.evaluate((canvas) =>
        Number(canvas.parentElement.dataset.renderCount),
      );
      await button(label).click();
      await waitPreset(type, direction);
      await waitForAsync(
        page,
        async (previous) => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          return Number(document.querySelector('.pcb-model-canvas').dataset.renderCount) > previous;
        },
        frame,
      );
      const current = await camera();
      assert.equal(await visualization.isVisible(), true, `${label} keeps Visualization expanded.`);
      assert.equal(await button('Visualization').getAttribute('aria-expanded'), 'true');
      assert.equal(await visualization.locator('.model-view-controls > button:visible').count(), 7);
      assert.equal(current.type, type, `${label} retains its projection.`);
      assert.ok(Math.abs(current.zoom - baseline.zoom) < 1e-8, `${label} retains zoom.`);
      assert.ok(
        Math.abs(current.span - baseline.span) < 1e-8,
        `${label} retains target-plane scale.`,
      );
      for (let axis = 0; axis < 3; axis++)
        assert.ok(
          Math.abs(current.target[axis] - baseline.target[axis]) < 1e-8,
          `${label} retains its orbit target.`,
        );
      assert.ok(
        Math.abs(
          Math.hypot(...current.position.map((value, axis) => value - current.target[axis])) -
            distance,
        ) < 1e-8,
        `${label} retains the camera distance.`,
      );
      assert.deepEqual(
        current.up,
        label === 'Top view' || label === 'Bottom view' ? [0, 1, 0] : [0, 0, 1],
      );
      if (['Top view', 'Front view', 'Isometric view'].includes(label))
        pixelSamples.push(await captureViewPixels(type, label));
    }
    assertDifferentViewPixels(pixelSamples, type);
  }
  await projection.click();
  await waitProjection('PerspectiveCamera');
  await button('Top view').click();
  await waitPreset('PerspectiveCamera', [0, 0, 1]);
  assert.deepEqual(
    requests,
    presetRequests,
    'View presets reuse all loaded models and footprint details.',
  );
  assert.ok(
    Math.abs((await camera()).span - beforeTop.span) < 1e-8,
    'Top view keeps perspective zoom.',
  );
  assert.equal(
    await page.evaluate(() => window.created),
    1,
    'Projection toggles retain the renderer.',
  );
  assert.ok(await page.evaluate(() => window.originalScene === Object.values(window.scenes)[0]));
  assert.deepEqual(
    requests,
    { models: 2, details: 2 },
    'Projection changes make no model requests.',
  );
  const beforeFilterCamera = await camera();
  await openSelectionFilters();
  assert.deepEqual(
    await filterStyle(),
    schematicFilterStyle,
    'Model uses the shared compact two-column Selection grid and leading checkboxes.',
  );
  const allModelItems = selectionFilters.getByRole('checkbox', { name: 'All items', exact: true });
  const modelCategories = ['Solids', 'Faces', 'Edges', 'Lines'];
  assert.equal(await allModelItems.isChecked(), true);
  await allModelItems.uncheck();
  for (const name of modelCategories) assert.equal(await checkbox(name).isChecked(), false);
  assert.equal(await allModelItems.evaluate((input) => input.indeterminate), false);
  assert.equal(
    await page.locator('.pcb-model-canvas').getAttribute('data-models-visible'),
    'true',
    'All items changes eligibility without hiding displayed components.',
  );
  await checkbox('Solids').check();
  assert.equal(await allModelItems.isChecked(), false);
  assert.equal(await allModelItems.evaluate((input) => input.indeterminate), true);
  assert.equal(await checkbox('Faces').isChecked(), false);
  await allModelItems.check();
  for (const name of modelCategories) assert.equal(await checkbox(name).isChecked(), true);
  assert.equal(await allModelItems.evaluate((input) => input.indeterminate), false);
  assert.equal(await checkbox('Solids').isChecked(), true);
  await checkbox('Solids').uncheck();
  assert.equal(await allModelItems.evaluate((input) => input.indeterminate), true);
  await closeSelectionFilters();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.modelsSelectable === 'false',
  );
  sameCamera(await camera(), beforeFilterCamera);
  assert.equal(
    await page.locator('.pcb-model-canvas').getAttribute('data-models-visible'),
    'true',
    'Disabling Model selection retains displayed component models.',
  );
  assert.equal(await page.evaluate(() => window.created), 1);
  assert.ok(await page.evaluate(() => window.originalScene === Object.values(window.scenes)[0]));
  assert.deepEqual(requests, { models: 2, details: 2 });
  await openVisualization('Display');
  await checkbox('Show components').click();
  await checkbox('Show silkscreen').click();
  assert.equal(await visualization.isVisible(), true, 'Visibility toggles retain their drawer.');
  await closeVisualization();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.modelsVisible === 'false',
  );
  const savedCamera = await camera();
  const warmRequests = { ...requests };
  await button('Layout').click();
  await page.getByTestId('layout-canvas').waitFor();
  const paused = await page.locator('.pcb-model-canvas').getAttribute('data-render-count');
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator('.pcb-model-canvas').getAttribute('data-render-count'),
    paused,
    'Hidden Model stops rendering.',
  );
  await button('Model').click();
  await ready();
  assert.ok(
    await page.evaluate(
      () => window.originalCanvas === document.querySelector('.pcb-model-canvas canvas'),
    ),
    'Layout round trip retains the WebGL canvas.',
  );
  assert.equal(await page.evaluate(() => window.created), 1);
  sameCamera(await camera(), savedCamera);
  assert.deepEqual(requests, warmRequests, 'Layout round trip makes no model/detail requests.');
  await openSelectionFilters();
  assert.equal(
    await checkbox('Solids').isChecked(),
    false,
    'The current project retains Model selection filters across view switches.',
  );
  await closeSelectionFilters();
  await openVisualization();
  assert.equal(
    await visualization
      .getByRole('tab', { name: 'Display', exact: true })
      .getAttribute('aria-selected'),
    'true',
    'View switches retain the Model visualization tab.',
  );
  assert.equal(await checkbox('Show components').isChecked(), false);
  assert.equal(await checkbox('Show silkscreen').isChecked(), false);
  await openVisualization('Views');
  assert.equal(await projection.getAttribute('aria-pressed'), 'false');
  await closeVisualization();
  await button('Source').click();
  await selectSourceFile(page, 'board-0.kicad_pcb');
  const originalNativeSource = await readSource(page);
  assert.match(originalNativeSource, /^\(kicad_pcb\b/);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  const sourcePanel = page.getByRole('region', { name: 'Project source', exact: true });
  await sourcePanel.locator('.cm-editor').evaluate((element) => {
    window.retainedSourceEditor = element;
  });
  const assertSourceWithoutDrawers = async () => {
    for (const name of ['Visualization', 'Selection']) {
      assert.equal(await sourcePanel.getByRole('button', { name, exact: true }).count(), 0);
      assert.equal(await sourcePanel.getByRole('group', { name, exact: true }).count(), 0);
    }
    assert.equal(await sourcePanel.locator('.editor-display-drawers').count(), 0);
    assert.equal(
      await sourcePanel
        .locator('.cm-editor')
        .evaluate((element) => element === window.retainedSourceEditor),
      true,
      'Source retains the same editor across view switches without display drawers.',
    );
  };

  // Every mode keeps List/Git windows; drawing modes keep display drawers.
  // Exercise their bounds at both sizes and surface themes.
  const screenshotSidebar = async (mode, width, theme) => {
    const dock = page.locator(
      {
        Schematic: '.schematic-properties-dock:visible',
        Layout: '.layout-sidebar:visible',
        Model: '.model-properties-dock:visible',
      }[mode],
    );
    const disclosures = ['Properties', 'Visualization', 'Selection'].map((name) =>
      dock.getByRole('button', { name, exact: true }),
    );
    const expanded = await Promise.all(
      disclosures.map(async (control) => (await control.getAttribute('aria-expanded')) === 'true'),
    );
    for (let index = 0; index < disclosures.length; index++)
      if (!expanded[index]) await disclosures[index].click();
    await dock.screenshot({
      path: `test-results/sidebar-${mode.toLowerCase()}-${width}-${theme}.png`,
    });
    for (let index = 0; index < disclosures.length; index++)
      if (!expanded[index]) await disclosures[index].click();
  };
  for (const viewport of [
    { width: 1120, height: 760 },
    { width: 1480, height: 920 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const mode of ['Schematic', 'Layout', 'Model', 'Source']) {
        await button(mode).click();
        if (mode === 'Model') await ready();
        if (mode === 'Source')
          await page.getByRole('textbox', { name: 'Project file source', exact: true }).waitFor();
        await assertEditorViewControls(page, mode);
        await assertToolbarOrder(mode);
        await button('List').click();
        await partsList.waitFor();
        const listBounds = await partsList.boundingBox();
        assert.ok(listBounds.x >= 24 && listBounds.y >= 24);
        assert.ok(Math.abs(listBounds.x + listBounds.width / 2 - viewport.width / 2) < 2);
        assert.ok(listBounds.x + listBounds.width <= viewport.width);
        assert.ok(listBounds.y + listBounds.height <= viewport.height);
        await partsList.getByText('No components', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await partsList.waitFor({ state: 'hidden' });
        assert.equal(
          await button('List').evaluate((element) => element === document.activeElement),
          true,
          `${mode} restores focus to the List trigger.`,
        );
        if (mode === 'Layout') {
          const sidebar = page.getByRole('complementary', { name: 'Layout sidebar', exact: true });
          await openSelectionFilters();
          const filters = sidebar.getByRole('group', { name: 'Selection', exact: true });
          assert.equal(
            await filters.evaluate((element) => !!element.closest('.layout-sidebar')),
            true,
            'Layout filters remain in their dock.',
          );
          assert.deepEqual(
            await filters
              .getByRole('checkbox')
              .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
            [
              'All items',
              'Locked items',
              'Footprints',
              'Text',
              'Tracks',
              'Vias',
              'Pads',
              'Graphics',
              'Zones',
              'Rule areas',
              'Dimensions',
              'Points',
            ],
            'Layout retains its selection categories in row-major order.',
          );
          assert.equal(
            await filters.getByRole('checkbox', { name: 'Other items', exact: true }).count(),
            0,
          );
          assert.equal(
            await filters.getByRole('checkbox', { name: 'Points', exact: true }).isDisabled(),
            true,
          );
          await page.screenshot({
            path: `test-results/selection-filters-layout-${viewport.width}-${theme}.png`,
          });
          await closeDisplayDrawer(page, 'Selection');
          await openVisualization();
          assert.equal(
            await visualization.evaluate((element) => !!element.closest('.layout-sidebar')),
            true,
            'Layout appearance remains in its dock.',
          );
          assert.deepEqual(await sidebar.getByRole('tab').allTextContents(), [
            'Layers',
            'Objects',
            'Nets',
          ]);
          const [bounds, drawing] = await Promise.all([
            sidebar.boundingBox(),
            page.getByTestId('layout-canvas').boundingBox(),
          ]);
          assert.ok(
            bounds.x >= drawing.x + drawing.width - 1 && bounds.x + bounds.width <= viewport.width,
          );
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
          await sidebar.getByRole('tab', { name: 'Objects', exact: true }).click();
          const colors = await sidebar
            .locator('.layout-layer-swatch')
            .first()
            .evaluate((swatch) => {
              const board = document.querySelector('.layout-editor');
              const token = getComputedStyle(board).getPropertyValue('--pcb-silk-front').trim();
              const expected = document.createElement('span');
              expected.style.backgroundColor = token;
              document.body.append(expected);
              const expectedColor = getComputedStyle(expected).backgroundColor;
              expected.remove();
              return { actual: getComputedStyle(swatch).backgroundColor, expected: expectedColor };
            });
          assert.notEqual(colors.actual, 'rgba(0, 0, 0, 0)');
          assert.equal(
            colors.actual,
            colors.expected,
            'Docked appearance swatches match the board palette.',
          );
          await page.screenshot({
            path: `test-results/visualization-layout-${viewport.width}-${theme}.png`,
          });
          await screenshotSidebar(mode, viewport.width, theme);
          await page.getByTestId('layout-canvas').focus();
          continue;
        }
        if (mode === 'Source') {
          await assertSourceWithoutDrawers();
          await page.screenshot({
            path: `test-results/source-editor-${viewport.width}-${theme}.png`,
          });
          continue;
        } else {
          assert.equal(await button('Selection').isEnabled(), true);
          await openSelectionFilters();
          const filterTriggerBounds = await button('Selection').boundingBox();
          const filterBounds = await selectionFilters.boundingBox();
          assert.ok(
            filterBounds.x >= 0 &&
              filterBounds.y >= 0 &&
              filterBounds.y >= filterTriggerBounds.y + filterTriggerBounds.height - 1,
            'Selection keeps its disclosure above its content.',
          );
          assert.ok(filterBounds.x + filterBounds.width <= viewport.width);
          assert.ok(filterBounds.y + filterBounds.height <= viewport.height);
          assert.ok(filterBounds.width >= 224, `${mode} retains readable filter rows.`);
          assert.deepEqual(
            await selectionFilters
              .getByRole('checkbox')
              .evaluateAll((inputs) =>
                inputs.map(
                  (input) =>
                    input.getAttribute('aria-label') || input.closest('label').textContent.trim(),
                ),
              ),
            {
              Schematic: ['All', 'Symbols', 'Wires', 'Labels', 'Text', 'No-connects'],
              Model: ['All items', 'Solids', 'Faces', 'Edges', 'Lines'],
            }[mode],
            `${mode} exposes only its own selectable object categories.`,
          );
          await page.screenshot({
            path: `test-results/selection-filters-${mode.toLowerCase()}-${viewport.width}-${theme}.png`,
          });
          await closeSelectionFilters();
          await openSelectionFilters();
          await closeDisplayDrawer(page, 'Selection');
          await selectionFilters.waitFor({ state: 'hidden' });
        }
        await openVisualization(mode === 'Model' ? 'Display' : undefined);
        const bounds = await visualization.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0);
        assert.ok(bounds.x + bounds.width <= viewport.width);
        assert.ok(bounds.y + bounds.height <= viewport.height);
        assert.ok(bounds.width >= 224, `${mode} retains readable display rows.`);
        assert.deepEqual(
          await visualization.getByRole('tab').allTextContents(),
          {
            Schematic: [],
            Model: ['Views', 'Display'],
          }[mode],
          `${mode} exposes its visualization tabs in the drawer.`,
        );
        const rows = await visualization.locator('.editor-visibility-row').evaluateAll((elements) =>
          elements.map((element) => {
            const row = element.getBoundingClientRect();
            const checkbox = element
              .querySelector('input[type="checkbox"]')
              ?.getBoundingClientRect();
            return {
              height: row.height,
              checkboxRight: checkbox ? row.right - checkbox.right : null,
            };
          }),
        );
        assert.ok(rows.length > 0);
        for (const row of rows) {
          assert.ok(row.height >= 30, `${mode} retains a 30 px display row target.`);
          if (row.checkboxRight !== null)
            assert.ok(
              row.checkboxRight >= 0 && row.checkboxRight <= 10,
              `${mode} aligns each display checkbox at its row's right edge.`,
            );
        }
        await page.screenshot({
          path: `test-results/visualization-${mode.toLowerCase()}-${viewport.width}-${theme}.png`,
        });
        await screenshotSidebar(mode, viewport.width, theme);
        await closeVisualization();
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  assert.equal(await readSource(page), originalNativeSource);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);

  // Source retains its editor, default presentation, draft, selection and local
  // undo/redo history without reserving room for drawing controls.
  const sourceEditor = page.getByRole('textbox', { name: 'Project file source', exact: true });
  await sourceEditor.focus();
  await sourceEditor.press('ControlOrMeta+End');
  await page.keyboard.insertText(' ');
  await sourceEditor.press('ControlOrMeta+Home');
  await sourceEditor.press('ArrowRight');
  const pendingSource = await inspectSource();
  assert.equal(pendingSource.text, originalNativeSource + ' ');
  assert.equal(pendingSource.undo, 1);
  assert.equal(await button('Apply').isEnabled(), true);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  await assertSourceWithoutDrawers();
  assert.deepEqual(await inspectSource(), pendingSource);
  assert.equal(await sourcePanel.locator('.cm-lineNumbers').count(), 1);
  assert.ok((await sourcePanel.locator('.cm-highlightSpace').count()) > 0);
  assert.equal(await sourcePanel.locator('.cm-lineWrapping').count(), 0);
  assert.equal(await button('Apply').isEnabled(), true);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  await sourceEditor.focus();
  await sourceEditor.press('ControlOrMeta+z');
  assert.equal((await inspectSource()).text, originalNativeSource);
  await sourceEditor.press('ControlOrMeta+Shift+z');
  assert.equal((await inspectSource()).text, pendingSource.text);
  await sourceEditor.press('ControlOrMeta+z');
  assert.equal(await button('Apply').isEnabled(), false);
  await page.locator('.project-navigation .dirty-dot').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);

  // Opening List shares Source's existing validated-transaction boundary.
  // An invalid draft remains editable in Source instead of opening the list.
  await sourceEditor.press('ControlOrMeta+End');
  await page.keyboard.insertText(' invalid');
  const invalidSource = await inspectSource();
  await button('List').click();
  await page.locator('.source-editor-error').waitFor();
  assert.equal(await sourceEditor.isVisible(), true);
  assert.equal(await partsList.count(), 0);
  assert.equal((await inspectSource()).text, invalidSource.text);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  await assertSourceWithoutDrawers();
  assert.deepEqual(await inspectSource(), invalidSource);
  await sourceEditor.focus();
  await sourceEditor.press('ControlOrMeta+z');
  assert.equal((await inspectSource()).text, originalNativeSource);
  assert.equal(await button('Apply').isEnabled(), false);
  await page.locator('.project-navigation .dirty-dot').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await button('Model').click();
  await ready();
  await openVisualization('Views');
  assert.equal(await projection.getAttribute('aria-pressed'), 'false');
  await closeVisualization();
  await selectProject(1);
  await button('Model').click();
  await ready();
  await openVisualization('Views');
  assert.equal(
    await projection.getAttribute('aria-pressed'),
    'true',
    'Each project starts with its own projection.',
  );
  await closeVisualization();
  assert.deepEqual(requests, warmRequests, 'A second board reuses the shared CPU model cache.');
  await selectProject(0);
  await ready();
  assert.ok(
    await page.evaluate(
      () => window.originalCanvas === document.querySelector('.pcb-model-canvas canvas'),
    ),
    'Project switching retains the original canvas.',
  );
  sameCamera(await camera(), savedCamera);
  await openVisualization('Views');
  assert.equal(await projection.getAttribute('aria-pressed'), 'false');
  const resumedPixels = [];
  for (const [label, direction] of presetViews.filter(([label]) =>
    ['Top view', 'Front view', 'Isometric view'].includes(label),
  )) {
    await button(label).click();
    await waitPreset('PerspectiveCamera', direction);
    assert.equal(await visualization.isVisible(), true);
    resumedPixels.push(await captureViewPixels('resumed-project', label));
  }
  assertDifferentViewPixels(resumedPixels, 'Retained project after Model and project switching');
  await button('Top view').click();
  await waitPreset('PerspectiveCamera', [0, 0, 1]);
  const idleTop = await captureViewPixels('idle-before-repeat', 'Top view');
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await button('Top view').click();
  await waitPreset('PerspectiveCamera', [0, 0, 1]);
  await waitForAsync(
    page,
    async (previous) => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return Number(document.querySelector('.pcb-model-canvas').dataset.renderCount) > previous;
    },
    idleTop.frame,
  );
  const repeatedTop = await captureViewPixels('idle-after-repeat', 'Top view');
  assert.equal(
    repeatedTop.hash,
    idleTop.hash,
    'Selecting the already-current idle view retains the complete rendered picture.',
  );
  sameCamera(await camera(), savedCamera);
  await closeVisualization();
  await button('Home').click();
  await selectProject(0);
  await ready();
  assert.equal(await page.evaluate(() => window.created), 2);
  assert.deepEqual(requests, warmRequests);

  // Hidden edits are coalesced, then placed from cached meshes on return.
  await button('Source').click();
  const changed = await readNativeProject(page);
  changed.pcb.footprints[0].x += 3;
  await fillNativeProject(page, changed);
  await button('Apply').click();
  changed.pcb.footprints[0].x += 2;
  await fillNativeProject(page, changed);
  await button('Apply').click();
  assert.equal(
    await page.evaluate(() => window.created),
    2,
    'Hidden board edits defer rebuilding.',
  );
  await button('Model').click();
  await ready();
  assert.equal(await page.evaluate(() => window.created), 3);
  assert.deepEqual(
    requests,
    warmRequests,
    'Board edits reuse completed meshes and footprint metadata.',
  );
  sameCamera(await camera(), savedCamera);
  const placed = await page.evaluate(
    (id) =>
      window.scenes[id].children[0].children
        .flatMap((group) => group.children)
        .filter((object) => object.type === 'Group')
        .map((object) => object.position.x),
    projects[0].pcb.id,
  );
  assert.ok(placed.includes(15), 'Model uses the latest board placement.');
  await page.keyboard.press('ControlOrMeta+z');
  await ready();
  assert.deepEqual(requests, warmRequests, 'Undo reuses models too.');

  // A later board edit retries failed requests while reusing successful models.
  await button('Source').click();
  const failing = await readNativeProject(page);
  failing.pcb.footprints[0].libraryId = 'Fixture:Retry';
  rejectNextModel = true;
  await fillNativeProject(page, failing);
  await button('Apply').click();
  await button('Model').click();
  await ready();
  await button('Rule').click();
  await page.getByRole('tab', { name: 'Model', exact: true }).click();
  await page.getByText('J1: Fixture model unavailable. Retry.', { exact: true }).waitFor();
  await button('Close dialog').click();
  const failedRequests = requests.models;
  await button('Source').click();
  failing.pcb.footprints[0].x += 1;
  await fillNativeProject(page, failing);
  await button('Apply').click();
  await button('Model').click();
  await ready();
  assert.equal(requests.models, failedRequests + 1);
  assert.equal(await page.locator('.pcb-model-issues').count(), 0);

  // Closing a clean project releases its retained renderer.
  await selectProject(1);
  const disposed = await page.evaluate(() => window.disposed);
  await page
    .locator(`.project-navigation [data-project-id="${ids[1]}"]`)
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close project', exact: true }).click();
  await page.waitForFunction((before) => window.disposed > before, disposed);
  assert.deepEqual(errors, []);
  console.log(
    'Selection and Visualization: four-mode List/Git toolbar order, retained drawing-mode display drawers, current-mode filter categories, window/drawer bounds at 1120/1480 px in light/dark themes, Escape/focus restoration, Source without display drawers and retained editor/text/selection/undo/dirty invariants passed. Model: orthographic/perspective projection, preserved camera/scale, context-menu/wheel zoom without floating controls, retained scenes/camera/display/selection filters, paused hidden rendering, project/Home/Layout/Source round trips, shared model cache, deferred edits, undo, retry and renderer disposal passed.',
  );
} catch (cause) {
  if (cause !== focusedLayoutComplete) {
    if (process.argv.includes('--status-layout')) {
      const failedPage = browser.contexts()[0]?.pages()[0];
      await mkdir('test-results', { recursive: true });
      await failedPage?.screenshot({ path: 'test-results/model-status-layout-failure.png' });
      console.error((await failedPage?.locator('body').innerText())?.slice(-3000));
    }
    throw cause;
  }
} finally {
  await browser.close();
}
