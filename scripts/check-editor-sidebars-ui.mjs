import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { parseProject, serializeProject } from '../server/project-format.mjs';
import { readNativeFiles, readNativeProject } from './source-editor-test-helpers.mjs';
import {
  assertEditorViewControls,
  assertToolbarSidebarPlacement,
} from './visualization-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const { flipPCBFootprint } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { partFields } = await tsImport('../lib/library.ts', import.meta.url);

// Isolated workspace: real editor gestures and native Source, mocked local services.
// No Electron, user files, provider calls or solver processes.
const fixture = parseProject(await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8'));
for (const footprint of fixture.pcb.footprints) {
  const part = fixture.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
for (const net of fixture.pcb.nets) {
  if (net.name === '/IN' || net.name === '/OUT') net.name = net.name.slice(1);
}
const resistorPart = fixture.schematic.parts.find((part) => part.ref === 'R1');
fixture.pcb.footprints = fixture.pcb.footprints.map((footprint) =>
  footprint.symbolId === resistorPart.id
    ? { ...flipPCBFootprint(footprint), rotation: 90 }
    : footprint,
);
fixture.pcb.zones[0].filledPolygons = [
  {
    points: [
      { x: 12, y: 12 },
      { x: 16, y: 12 },
      { x: 16, y: 16 },
      { x: 12, y: 16 },
    ],
  },
];
const footprintDetail = (name, count) => ({
  id: `Fixture:${name}`,
  name,
  library: 'Fixture',
  description: 'Isolated footprint assignment fixture',
  keywords: 'replacement',
  footprint: [
    'footprint',
    JSON.stringify(name),
    ['layer', '"F.Cu"'],
    ...Array.from({ length: count }, (_, index) => [
      'pad',
      JSON.stringify(String(index + 1)),
      'smd',
      'rect',
      ['at', String((index - 0.5) * 7.62), '0'],
      ['size', '2.2', '1.8'],
      ['layers', '"F.Cu"', '"F.Paste"', '"F.Mask"'],
    ]),
  ],
  pads: Array.from({ length: count }, (_, index) => String(index + 1)),
  models: [],
});
const replacementPackage = footprintDetail('Replacement_2Pad', 2);
const unsupportedPackage = footprintDetail('Replacement_3Pad', 3);
const footprintPackages = [replacementPackage, unsupportedPackage];
const source = serializeProject(fixture);
const plugins = bundledWorkbenchCatalog();
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'sidebars.kicad_pro',
      sessions: [{ id: 'sidebars-session', messages: [], draft: '' }],
      activeSessionId: 'sidebars-session',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react';import {createRoot} from 'react-dom/client';import Workspace from './components/DesktopWorkspace';createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/editor-sidebars/bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
await mkdir('test-results/editor-sidebars', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: true,
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
      historyList: async () => ({ version: '', commits: [], more: false, needsSave: true }),
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/workbench-plugins') return route.fulfill({ json: plugins });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/libraries/footprints') {
      const id = url.searchParams.get('id');
      if (id) {
        const detail = footprintPackages.find((entry) => entry.id === id);
        assert.ok(detail, `Only known fixture footprints can be requested: ${id}`);
        return route.fulfill({ json: detail });
      }
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const entries = footprintPackages
        .filter((entry) => entry.id.toLowerCase().includes(query))
        .map(({ footprint, pads, models, ...entry }) => entry);
      return route.fulfill({ json: { entries, libraries: ['Fixture'], total: entries.length } });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div>',
    });
  });
  const mount = async () => {
    await page.goto('http://localhost');
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
      await page.addStyleTag({ content: output.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
    });
  };
  await mount();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const clean = async () =>
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  const screenshotEditorCorner = async (canvas, theme) => {
    const clip = await canvas.evaluate((element) => {
      const editor = element.closest('.editor').getBoundingClientRect();
      const toolbar = element.closest('.layout-editor').querySelector('.layout-toolbar');
      const right = Math.min(window.innerWidth, editor.right);
      const x = Math.max(0, Math.floor(right - Math.min(520, editor.width)));
      const y = Math.max(0, Math.floor(editor.top));
      const bottom = Math.min(window.innerHeight, toolbar.getBoundingClientRect().bottom);
      return { x, y, width: Math.ceil(right) - x, height: Math.ceil(bottom) - y };
    });
    await page.screenshot({ path: `test-results/editor-corner-${theme}.png`, clip });
  };
  const drawerGeometry = (sidebar) =>
    sidebar.evaluate((dock) => {
      const bounds = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        sidebar: bounds(dock),
        sections: ['Properties', 'Visualization', 'Selection'].map((label) => {
          const section = dock.querySelector(`.editor-display-drawer[aria-label="${label}"]`);
          const body = section.querySelector('.editor-display-drawer-body');
          const filterGrid = section.querySelector('.editor-filter-grid');
          const bodyStyle = getComputedStyle(body);
          return {
            label,
            expanded: section.dataset.expanded === 'true',
            section: bounds(section),
            header: bounds(section.querySelector('.editor-display-drawer-header')),
            body: bounds(body),
            filterContentHeight: filterGrid
              ? bounds(filterGrid).height +
                parseFloat(bodyStyle.paddingTop) +
                parseFloat(bodyStyle.paddingBottom)
              : null,
          };
        }),
      };
    });
  const assertDrawerPlacement = (geometry) => {
    const expanded = geometry.sections.filter((section) => section.expanded);
    const collapsed = geometry.sections.filter((section) => !section.expanded);
    for (const section of expanded) {
      assert.ok(section.body.height > 24, `${section.label} retains its expanded scrolling body.`);
      assert.ok(
        section.body.y >= section.header.y + section.header.height - 1,
        `${section.label} keeps its disclosure above its body.`,
      );
      if (section.label === 'Selection')
        assert.ok(
          section.section.height <= section.header.height + section.filterContentHeight + 2,
          'Expanded Selection fits its checkbox rows without blank space, including when it is the only open section.',
        );
    }
    for (let index = 1; index < geometry.sections.length; index++)
      assert.ok(
        geometry.sections[index].header.y >=
          geometry.sections[index - 1].section.y + geometry.sections[index - 1].section.height - 1,
        'Properties, Visualization, Selection keep their order in every expanded or collapsed state.',
      );
    for (const section of collapsed) {
      assert.ok(
        Math.abs(section.section.height - section.header.height) <= 1,
        `${section.label} reserves only its header when collapsed.`,
      );
      assert.equal(section.body.height, 0, `${section.label} hides its retained body.`);
    }
    if (!geometry.sections.find((section) => section.label === 'Properties').expanded) {
      const last = geometry.sections.at(-1);
      assert.ok(
        Math.abs(
          last.section.y + last.section.height - geometry.sidebar.y - geometry.sidebar.height,
        ) <= 1,
        'The section stack stays at the sidebar bottom whenever Properties is collapsed.',
      );
    }
  };
  const assertSharedDockHeaders = async (sidebar) => {
    const dockSurface = await sidebar.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const dockContentLeft = await sidebar.evaluate(
      (element) =>
        element.getBoundingClientRect().left +
        parseFloat(getComputedStyle(element).borderLeftWidth),
    );
    const headers = await sidebar
      .locator('.editor-display-drawer > .editor-dock-header:visible')
      .evaluateAll(
        (elements, contentLeft) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            const title = element.querySelector(
              ':scope > .editor-display-disclosure > span, :scope > span, :scope > strong, :scope > h2',
            );
            const titleStyle = getComputedStyle(title);
            const icon = element.querySelector('.editor-display-disclosure > svg');
            return {
              label: title.textContent.trim(),
              height: element.getBoundingClientRect().height,
              columns: [
                icon.getBoundingClientRect().left - contentLeft,
                title.getBoundingClientRect().left - contentLeft,
              ],
              paint: [
                style.backgroundColor,
                style.borderTopWidth,
                style.borderTopStyle,
                style.borderTopColor,
                style.borderBottomWidth,
                style.borderBottomStyle,
                style.borderBottomColor,
              ],
              typography: [
                titleStyle.fontFamily,
                titleStyle.fontSize,
                titleStyle.fontWeight,
                titleStyle.lineHeight,
                titleStyle.color,
              ],
            };
          }),
        dockContentLeft,
      );
    assert.equal(
      headers.length,
      3,
      'Properties and both display drawers use the shared dock header.',
    );
    assert.ok(headers.some(({ label }) => label === 'Properties'));
    assert.ok(headers.some(({ label }) => label === 'Visualization'));
    assert.ok(headers.some(({ label }) => label === 'Selection'));
    for (const header of headers) {
      assert.notEqual(
        header.paint[0],
        dockSurface,
        `${header.label} has a distinct header surface above its content.`,
      );
      assert.equal(header.paint[1], '1px', `${header.label} has a visible top separator.`);
      assert.equal(header.paint[2], 'solid');
      assert.equal(header.paint[4], '1px', `${header.label} has a visible bottom separator.`);
      assert.equal(header.paint[5], 'solid');
      assert.ok(
        Math.abs(header.height - headers[0].height) <= 1,
        `${header.label} shares the dock header height.`,
      );
      assert.deepEqual(header.paint, headers[0].paint, `${header.label} shares dock header paint.`);
      assert.deepEqual(
        header.typography,
        headers[0].typography,
        `${header.label} shares dock title typography.`,
      );
      assert.ok(
        Math.abs(header.columns[0] - 12) <= 1 && Math.abs(header.columns[1] - 34) <= 1,
        `${header.label} shares the 12 px icon and 34 px text columns.`,
      );
    }
  };
  const checkDrawerSharing = async (sidebar, canvas, expectDefaults = false) => {
    await page.mouse.move(0, 0);
    await assertSharedDockHeaders(sidebar);
    const names = ['Properties', 'Visualization', 'Selection'];
    const disclosures = names.map((name) => sidebar.getByRole('button', { name, exact: true }));
    const originallyExpanded = await Promise.all(
      disclosures.map(
        async (disclosure) => (await disclosure.getAttribute('aria-expanded')) === 'true',
      ),
    );
    for (let index = 0; index < disclosures.length; index++) {
      if (expectDefaults)
        assert.equal(originallyExpanded[index], true, `${names[index]} defaults open.`);
      if (!originallyExpanded[index]) await disclosures[index].click();
    }
    const expanded = await drawerGeometry(sidebar);
    assertDrawerPlacement(expanded);
    await canvas.focus();
    // Visit every combination with one disclosure change at a time. In
    // particular, Selection alone must stay below both collapsed headers.
    for (const mask of [7, 6, 4, 5, 1, 0, 2, 3, 7]) {
      for (let index = 0; index < disclosures.length; index++) {
        const expected = Boolean(mask & (1 << index));
        if (((await disclosures[index].getAttribute('aria-expanded')) === 'true') !== expected)
          await disclosures[index].click();
      }
      const current = await drawerGeometry(sidebar);
      assertDrawerPlacement(current);
      assert.deepEqual(
        current.sections.map((section) => section.expanded),
        disclosures.map((_, index) => Boolean(mask & (1 << index))),
        'Each disclosure changes expansion without changing section order.',
      );
      for (const axis of ['x', 'y', 'width', 'height'])
        assert.ok(
          Math.abs(current.sidebar[axis] - expanded.sidebar[axis]) <= 1,
          `Changing section expansion retains the full sidebar ${axis}.`,
        );
    }
    for (let index = 0; index < disclosures.length; index++)
      if (!originallyExpanded[index]) await disclosures[index].click();
  };
  const displayContentStyle = async (sidebar) => {
    const content = await sidebar.evaluate((dock) => {
      const box = (element) => {
        const { left, right, top, width, height } = element.getBoundingClientRect();
        return { left, right, top, width, height };
      };
      const style = (element, properties) => {
        const computed = getComputedStyle(element);
        return Object.fromEntries(properties.map((property) => [property, computed[property]]));
      };
      const visualization = dock.querySelector('.editor-visualization-drawer');
      const row = visualization.querySelector('.editor-visibility-row');
      const name = row.querySelector('.editor-visibility-name');
      const swatch = row.querySelector('.editor-visibility-swatch');
      const toggle = row.querySelector('.editor-visibility-toggle');
      const checkbox = toggle.querySelector('input[type="checkbox"]');
      const dockContentLeft =
        dock.getBoundingClientRect().left + parseFloat(getComputedStyle(dock).borderLeftWidth);
      const visibleLabel = name.querySelector(':scope > span:last-child');
      const list = visualization.querySelector(
        '.schematic-visibility-list, .layout-appearance-content',
      );
      const grid = dock.querySelector('.editor-filters-drawer .editor-filter-grid');
      const gridRows = Array.from(grid.querySelectorAll(':scope > label'));
      const firstFilter = gridRows[0];
      const firstCheckbox = firstFilter.querySelector('input');
      return {
        visibility: {
          row: box(row),
          toggle: box(toggle),
          checkbox: box(checkbox),
          leadingColumns: [
            box(swatch).left - dockContentLeft,
            box(visibleLabel).left - dockContentLeft,
          ],
          eyeCount: toggle.querySelectorAll('svg').length,
          typography: style(name, ['fontFamily', 'fontSize', 'lineHeight', 'color']),
          rowStyle: style(row, ['minHeight', 'borderRadius']),
          nameStyle: style(name, [
            'gap',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
          ]),
          swatch: {
            width: box(swatch).width,
            height: box(swatch).height,
            ...style(swatch, ['borderTopWidth', 'borderTopStyle', 'borderRadius']),
          },
          insets: style(list, ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']),
        },
        filter: {
          schematic: dock.classList.contains('schematic-properties-dock'),
          columns: getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat),
          gridStyle: style(grid, [
            'columnGap',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
            'fontSize',
          ]),
          rowStyle: style(firstFilter, ['gap', 'minHeight', 'lineHeight', 'fontSize']),
          checkboxStyle: style(firstCheckbox, [
            'width',
            'height',
            'marginTop',
            'marginRight',
            'marginBottom',
            'marginLeft',
          ]),
          leadingColumns: [
            box(firstCheckbox).left - dockContentLeft,
            box(firstFilter.querySelector('span')).left - dockContentLeft,
          ],
          rows: gridRows.map((label) => {
            const text = label.querySelector('span');
            const range = document.createRange();
            range.selectNodeContents(text);
            return {
              row: box(label),
              checkbox: box(label.querySelector('input')),
              text: box(text),
              lines: range.getClientRects().length,
              overflow: text.scrollWidth > text.clientWidth + 1,
            };
          }),
        },
      };
    });
    const { visibility, filter } = content;
    assert.ok(visibility.row.height >= 30, 'Layer visibility retains a 30 px row target.');
    assert.equal(visibility.toggle.width, 30);
    assert.equal(visibility.toggle.height, 30);
    assert.equal(visibility.eyeCount, 1, 'Each layer has one eye visibility indicator.');
    assert.ok(
      Math.abs(visibility.row.right - visibility.toggle.right) <= 1 &&
        Math.abs(visibility.checkbox.width - visibility.toggle.width) <= 1 &&
        Math.abs(visibility.checkbox.height - visibility.toggle.height) <= 1,
      'The right-aligned eye has a native checkbox covering its complete target.',
    );
    assert.equal(visibility.swatch.width, 14);
    assert.equal(visibility.swatch.height, 14);
    for (const [name, columns] of [
      ['Visibility', visibility.leadingColumns],
      ['Selection', filter.leadingColumns],
    ])
      assert.ok(
        Math.abs(columns[0] - 12) <= 1 && Math.abs(columns[1] - 34) <= 1,
        `${name} aligns its 14 px icon or checkbox with the shared text column.`,
      );
    assert.equal(filter.checkboxStyle.width, '14px');
    assert.equal(filter.checkboxStyle.height, '14px');
    assert.equal(filter.columns.length, 2, 'Selection categories use two columns.');
    assert.ok(Math.abs(filter.columns[0] - filter.columns[1]) <= 1);
    assert.ok(
      Math.abs(filter.rows[0].row.top - filter.rows[1].row.top) <= 1 &&
        filter.rows[1].row.left > filter.rows[0].row.left,
      'Selection categories flow across each row before continuing below.',
    );
    for (const { row, checkbox, text, lines, overflow } of filter.rows) {
      assert.ok(row.height >= 30, 'Selection rows retain the shared 30 px minimum height.');
      assert.ok(checkbox.right <= text.left, 'Each filter checkbox precedes its label.');
      if (filter.schematic) {
        assert.equal(lines, 1, 'Every compact Schematic Selection label occupies one line.');
        assert.equal(overflow, false, 'Compact Schematic Selection labels remain fully readable.');
        assert.ok(text.right <= row.right + 1, 'Schematic Selection text stays within its column.');
      }
    }
    return {
      visibility: Object.fromEntries(
        ['typography', 'rowStyle', 'nameStyle', 'swatch', 'insets'].map((key) => [
          key,
          visibility[key],
        ]),
      ),
      filter: Object.fromEntries(
        ['gridStyle', 'rowStyle', 'checkboxStyle'].map((key) => [key, filter[key]]),
      ),
    };
  };
  const schematic = page.getByTestId('schematic-canvas');
  await schematic.waitFor();
  const assertWindowActions = async (toolbar, plugin, rule) => {
    const group = toolbar.locator('.editor-tool-group-end');
    const pluginGroup = toolbar.getByRole('group', { name: 'Plugins', exact: true });
    const pluginButton = pluginGroup.getByRole('button', { name: plugin, exact: true });
    await pluginButton.waitFor();
    assert.deepEqual(
      await group
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
      [rule, 'Parts list', 'Version history', 'Toggle right sidebar'],
    );
    assert.equal(await group.getByRole('button', { name: plugin, exact: true }).count(), 0);
    assert.equal(await group.locator('.editor-tool-divider').count(), 0);
    assert.deepEqual(
      await group.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderLeftWidth, style.paddingLeft];
      }),
      ['0px', '0px'],
      'The right-aligned actions have no leading separator or separator padding.',
    );
    const placement = await pluginGroup.evaluate((element) => {
      const actions = element.parentElement.querySelector('.editor-tool-group-end');
      const pluginBounds = element.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        leftGroup:
          element.classList.contains('editor-plugin-actions') &&
          !element.classList.contains('editor-tool-group-end'),
        followsEditing:
          element.previousElementSibling?.getAttribute('aria-label') === 'Edit and history',
        precedesWindows: Boolean(
          element.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        leftOfWindows: pluginBounds.right <= actionBounds.left,
        separator: parseFloat(style.borderLeftWidth),
        inset: parseFloat(style.paddingLeft),
      };
    });
    assert.equal(
      placement.leftGroup &&
        placement.followsEditing &&
        placement.precedesWindows &&
        placement.leftOfWindows,
      true,
      'Plugin actions follow editing tools on the left, separate from window actions.',
    );
    assert.ok(
      placement.separator > 0 && placement.inset >= 8,
      'The left plugin group retains a quiet separator and clearance.',
    );
    assert.equal(
      await page.locator('.status-bar').getByRole('button', { name: rule, exact: true }).count(),
      0,
    );
  };
  await assertWindowActions(
    page.getByRole('group', { name: 'Schematic tools', exact: true }),
    'SPICE Simulation',
    'Electrical rules (ERC)',
  );
  await assertEditorViewControls(page, 'Schematic');
  const rightToggle = button('Toggle right sidebar');
  assert.equal(await rightToggle.isEnabled(), true);
  assert.equal(await rightToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await page
      .locator('.desktop-titlebar')
      .getByRole('button', { name: 'Toggle right sidebar', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await rightToggle.evaluate(
      (element) =>
        element.classList.contains('editor-sidebar-toggle') &&
        !!element.closest('.editor-toolbar .editor-view-controls') &&
        !element.closest('.schematic-properties-dock, .layout-sidebar, .model-properties-dock'),
    ),
    true,
    'The persistent right toggle belongs to the separated toolbar view-control group.',
  );
  const assertSidebarTogglePlacement = async (toolbar) => {
    await assertToolbarSidebarPlacement(toolbar);
  };
  await assertSidebarTogglePlacement(
    page.getByRole('group', { name: 'Schematic tools', exact: true }),
  );
  await button('Source').click();
  await assertEditorViewControls(page, 'Source');
  assert.equal(await rightToggle.count(), 0, 'Source has no right dock to toggle.');
  assert.equal(
    await page
      .locator('.source-editor-actions')
      .getByRole('button', { name: 'Visualization', exact: true })
      .count(),
    0,
  );
  const sourceEditor = page.getByRole('region', { name: 'Project source', exact: true });
  for (const name of ['Visualization', 'Selection']) {
    assert.equal(await sourceEditor.getByRole('group', { name, exact: true }).count(), 0);
    assert.equal(await sourceEditor.getByRole('button', { name, exact: true }).count(), 0);
  }
  assert.equal(await sourceEditor.locator('.editor-display-drawers').count(), 0);
  const [codeBounds, statusBounds] = await Promise.all([
    sourceEditor.locator('.source-editor-code').boundingBox(),
    sourceEditor.locator('.status-bar').boundingBox(),
  ]);
  assert.ok(
    Math.abs(codeBounds.y + codeBounds.height - statusBounds.y) <= 1,
    'Source code fills the available height through to its status bar.',
  );
  const original = await readNativeFiles(page);
  await button('Schematic').click();
  const schematicSidebar = page.getByTestId('schematic-properties-panel');
  await schematicSidebar
    .getByText('Select a component to view its properties.', { exact: true })
    .waitFor();
  const emptyPropertiesStyle = (placeholder) =>
    placeholder.evaluate((element) => {
      const style = getComputedStyle(element);
      const icon = element.querySelector('svg').getBoundingClientRect();
      return {
        style: Object.fromEntries(
          ['display', 'flexDirection', 'alignItems', 'gap', 'padding', 'fontSize', 'color'].map(
            (property) => [property, style[property]],
          ),
        ),
        icon: [icon.width, icon.height],
      };
    });
  const schematicEmptyPropertiesStyle = await emptyPropertiesStyle(
    schematicSidebar.locator('.properties-empty-state:visible'),
  );
  for (const name of ['Selection', 'Visualization']) {
    assert.equal(
      await page.locator('.schematic-toolbar').getByRole('button', { name, exact: true }).count(),
      0,
    );
  }
  await checkDrawerSharing(schematicSidebar, schematic, true);
  const schematicDisplayStyle = await displayContentStyle(schematicSidebar);
  await schematicSidebar
    .getByRole('button', { name: 'Resize properties width', exact: true })
    .press('Home');
  assert.ok(
    Math.abs((await schematicSidebar.boundingBox()).width - 300) <= 1,
    'Compact Schematic Selection is checked at the default sidebar width.',
  );
  const schematicFontStep = await page.evaluate(() => {
    const previous = document.documentElement.style.getPropertyValue('--font-step');
    document.documentElement.style.setProperty('--font-step', '4px');
    return previous;
  });
  try {
    await displayContentStyle(schematicSidebar);
  } finally {
    await page.evaluate((previous) => {
      if (previous) document.documentElement.style.setProperty('--font-step', previous);
      else document.documentElement.style.removeProperty('--font-step');
    }, schematicFontStep);
  }
  const schematicVisualization = schematicSidebar.getByRole('group', {
    name: 'Visualization',
    exact: true,
  });
  const references = schematicVisualization.getByRole('checkbox', {
    name: 'References',
    exact: true,
  });
  await schematicVisualization.getByText('References', { exact: true }).click();
  assert.equal(await references.isChecked(), false);
  assert.equal(
    await references.locator('..').getAttribute('aria-description'),
    'Show References',
    'The eye action reports the current visibility state.',
  );
  await references.focus();
  await references.press('Space');
  assert.equal(
    await references.isChecked(),
    true,
    'Eye visibility controls retain keyboard toggling.',
  );
  const schematicFilters = schematicSidebar.getByRole('group', { name: 'Selection', exact: true });
  assert.equal(
    await schematicFilters.getByRole('combobox', { name: 'Left button drag', exact: true }).count(),
    0,
    'Schematic Selection contains only object-category checkboxes.',
  );
  assert.equal(await schematicFilters.getByText('Left button drag', { exact: true }).count(), 0);
  assert.deepEqual(
    await schematicFilters
      .getByRole('checkbox')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
    ['All', 'Symbols', 'Wires', 'Labels', 'Text', 'No-connects'],
    'The compact Selection retains only Schematic categories and their original order.',
  );
  await schematicFilters.getByText('Symbols', { exact: true }).click({ button: 'right' });
  assert.equal(
    await schematicFilters
      .getByRole('checkbox', { name: 'All', exact: true })
      .evaluate((input) => input.indeterminate),
    true,
  );
  assert.deepEqual(
    await schematicFilters
      .getByRole('checkbox')
      .evaluateAll((inputs) => inputs.map((input) => input.checked)),
    [false, true, false, false, false, false],
    'Right-clicking a compact filter still isolates that Schematic category.',
  );
  await schematicFilters.getByRole('checkbox', { name: 'All', exact: true }).check();
  await page.getByTestId('part-R1').click();
  const properties = page.getByRole('complementary', { name: 'Object properties', exact: true });
  await properties.getByRole('textbox', { name: 'Component value', exact: true }).waitFor();
  const assertDocked = async (canvas, sidebar) => {
    const [drawing, panel] = await Promise.all([canvas.boundingBox(), sidebar.boundingBox()]);
    assert.ok(
      drawing.width >= 159,
      'At least 160 px of drawing area remains within pixel tolerance.',
    );
    assert.ok(panel.width >= 224, 'Sidebar controls retain readable width.');
    assert.ok(
      panel.x >= drawing.x + drawing.width - 1,
      'The sidebar does not overlay the drawing.',
    );
    assert.ok(
      panel.y + panel.height <= page.viewportSize().height + 1,
      'The sidebar stays inside the viewport.',
    );
    assert.equal(
      await sidebar.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
    );
  };
  await assertDocked(schematic, schematicSidebar);
  const initialWidth = (await schematicSidebar.boundingBox()).width;
  const resize = schematicSidebar.getByRole('button', {
    name: 'Resize properties width',
    exact: true,
  });
  await resize.press('ArrowLeft');
  assert.ok(Math.abs((await schematicSidebar.boundingBox()).width - initialWidth - 16) < 2);
  await resize.press('Home');
  await rightToggle.focus();
  await rightToggle.press('Enter');
  await schematicSidebar.waitFor({ state: 'hidden' });
  assert.equal(
    await rightToggle.evaluate((element) => element.classList.contains('editor-sidebar-toggle')),
    true,
  );
  assert.equal(
    await rightToggle.evaluate((element) => element === document.activeElement),
    true,
    'Keyboard focus stays on the persistent toolbar toggle.',
  );
  await rightToggle.press('Enter');
  await properties.getByRole('textbox', { name: 'Component value', exact: true }).waitFor();
  await assertDocked(schematic, schematicSidebar);
  await page.getByTestId('part-R1').click();
  await clean();
  const value = properties.getByRole('textbox', { name: 'Component value', exact: true });
  const savedValue = await value.inputValue();
  await value.fill('');
  const propertiesDisclosure = schematicSidebar.getByRole('button', {
    name: 'Properties',
    exact: true,
  });
  await propertiesDisclosure.click();
  assertDrawerPlacement(await drawerGeometry(schematicSidebar));
  await propertiesDisclosure.click();
  assert.equal(
    await value.inputValue(),
    '',
    'Collapsing Properties retains its invalid local draft.',
  );
  const drawingWidth = (await schematic.boundingBox()).width;
  await rightToggle.click();
  assert.equal(await schematicSidebar.isVisible(), false);
  assert.equal(await rightToggle.getAttribute('aria-pressed'), 'false');
  assert.ok(
    (await schematic.boundingBox()).width > drawingWidth + 200,
    'Hiding the dock returns its width to the drawing.',
  );
  await clean();
  await rightToggle.click();
  await value.waitFor();
  assert.equal(await value.inputValue(), '', 'Hiding the dock retains an invalid property draft.');
  await value.press('Escape');
  assert.equal(await value.inputValue(), savedValue);
  await clean();
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    original,
    'Toggling a draft never edits native files.',
  );
  await button('Schematic').click();
  await value.fill('2.2k');
  await value.press('Enter');
  await button('Source').click();
  assert.equal(
    (await readNativeProject(page)).schematic.parts.find((part) => part.ref === 'R1').value,
    '2.2k',
  );
  await button('Schematic').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    original,
    'Property editing is one undoable native design transaction.',
  );
  await button('Schematic').click();
  await clean();
  await page.getByTestId('part-R1').click();
  await properties.getByRole('textbox', { name: 'Component value', exact: true }).waitFor();
  if (await button('Dismiss notification').isVisible())
    await button('Dismiss notification').click();
  const numericInputStyle = (input) =>
    input.evaluate((element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(
        [
          'fontFamily',
          'fontSize',
          'paddingTop',
          'paddingRight',
          'paddingBottom',
          'paddingLeft',
          'backgroundColor',
          'color',
          'borderTopWidth',
          'borderTopColor',
          'borderRadius',
          'minHeight',
        ].map((property) => [property, style[property]]),
      );
    });
  const schematicNumericStyle = await numericInputStyle(
    properties.getByRole('spinbutton', { name: 'Component X position', exact: true }),
  );
  const componentPropertiesStyle = (panel) =>
    panel.evaluate((element) => {
      const styles = (target, properties) => {
        const style = getComputedStyle(target);
        return Object.fromEntries(properties.map((property) => [property, style[property]]));
      };
      const identity = element.querySelector('.inspector-symbol');
      const body = identity.closest('.inspector-body, .layout-inspector-content');
      const thumbnail = identity.querySelector('.component-preview').getBoundingClientRect();
      const field = element
        .querySelector('input[aria-label="Footprint"]')
        .closest('.property-field');
      const columns = getComputedStyle(field).gridTemplateColumns.split(' ').map(parseFloat);
      return {
        identity: styles(identity, ['display', 'gap', 'padding']),
        identityOffset: identity.getBoundingClientRect().top - body.getBoundingClientRect().top,
        thumbnail: [thumbnail.width, thumbnail.height],
        reference: styles(identity.querySelector('strong'), [
          'fontFamily',
          'fontSize',
          'fontWeight',
        ]),
        library: styles(identity.querySelector('span'), ['fontSize', 'color']),
        field: styles(field, ['gap', 'alignItems']),
        fieldAction: columns.at(-1),
        valueRatio: Math.round((columns[1] / columns[0]) * 100),
        footprint: styles(field.querySelector('.property-field-value'), [
          'fontFamily',
          'fontSize',
          'padding',
          'borderRadius',
          'backgroundColor',
        ]),
        deleteAction: styles(identity.querySelector('.property-delete-action'), [
          'width',
          'height',
          'color',
        ]),
      };
    });
  const schematicComponentPropertiesStyle = await componentPropertiesStyle(properties);
  const objectDelete = properties.getByRole('button', { name: 'Delete object', exact: true });
  assert.equal(await properties.locator('.inspector-footer').count(), 0);
  assert.equal(
    await objectDelete.evaluate((element) => {
      const action = element.getBoundingClientRect(),
        identity = element.closest('.inspector-symbol').getBoundingClientRect();
      return (
        action.top >= identity.top &&
        action.bottom <= identity.bottom &&
        action.right <= identity.right &&
        action.left > identity.left + identity.width / 2
      );
    }),
    true,
    'Delete is at the upper right of the component identity, outside the drawer title.',
  );
  const inputValue = properties.getByRole('textbox', { name: 'Component value', exact: true });
  const valueBeforeIME = await inputValue.inputValue();
  await inputValue.focus();
  await inputValue.dispatchEvent('compositionstart');
  await objectDelete.click();
  assert.equal(
    await inputValue.inputValue(),
    valueBeforeIME,
    'Deletion cannot interrupt input composition.',
  );
  await inputValue.dispatchEvent('compositionend');
  const blockedIME = await objectDelete.evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(blockedIME, true);

  const assertEqualColumns = async (group, count, name) => {
    const fields = await group.evaluate((element) =>
      Array.from(element.children).map((field) => {
        const { x, y, width } = field.getBoundingClientRect();
        return { x, y, width };
      }),
    );
    assert.equal(fields.length, count, `${name} contains the expected grouped fields.`);
    for (let index = 1; index < fields.length; index++) {
      assert.ok(Math.abs(fields[index].y - fields[0].y) <= 1, `${name} shares one row.`);
      assert.ok(
        Math.abs(fields[index].width - fields[0].width) <= 1,
        `${name} uses equal-width columns.`,
      );
      assert.ok(fields[index].x > fields[index - 1].x, `${name} preserves field order.`);
    }
  };
  await assertEqualColumns(properties.locator('.property-primary'), 2, 'Schematic identity');
  await assertEqualColumns(properties.locator('.component-geometry'), 3, 'Schematic geometry');
  await page.screenshot({ path: 'test-results/editor-sidebar-schematic.png' });

  await button('Layout').click();
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await assertWindowActions(page.locator('.layout-toolbar'), 'Thermal FEM', 'Design rules (DRC)');
  const sidebar = page.getByRole('complementary', { name: 'Layout sidebar', exact: true });
  await sidebar.waitFor();
  await checkDrawerSharing(sidebar, canvas, true);
  assert.deepEqual(
    await emptyPropertiesStyle(sidebar.locator('.properties-empty-state:visible')),
    schematicEmptyPropertiesStyle,
    'Empty Layout Properties shares Schematic icon, spacing and text treatment.',
  );
  assert.deepEqual(
    await displayContentStyle(sidebar),
    schematicDisplayStyle,
    'Schematic Visualization and Selection share Layout row typography, controls, spacing and insets.',
  );
  const layoutResize = sidebar.getByRole('button', {
    name: 'Resize layout sidebar width',
    exact: true,
  });
  const layoutScale = await canvas.evaluate((svg) => {
    const matrix = svg.getScreenCTM();
    return [Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)];
  });
  const expectLayoutWidth = async (width) => {
    await waitForAsync(
      page,
      async ({ width, scale }) => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const panel = document.querySelector('[aria-label="Layout sidebar"]');
        const svg = document.querySelector('[data-testid="layout-canvas"]');
        if (!panel || !svg) return false;
        const matrix = svg.getScreenCTM();
        return (
          Math.abs(panel.getBoundingClientRect().width - width) < 2 &&
          Math.abs(Math.hypot(matrix.a, matrix.b) - scale[0]) < 0.001 &&
          Math.abs(Math.hypot(matrix.c, matrix.d) - scale[1]) < 0.001
        );
      },
      { width, scale: layoutScale },
    );
  };
  const dragLayoutWidth = async (distance) => {
    const handle = await layoutResize.boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + Math.min(80, handle.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - distance, y, { steps: 6 });
  };
  await expectLayoutWidth(300);
  await layoutResize.press('ArrowLeft');
  await expectLayoutWidth(316);
  await layoutResize.press('ArrowRight');
  await expectLayoutWidth(300);
  await dragLayoutWidth(48);
  await page.mouse.up();
  await expectLayoutWidth(348);
  await rightToggle.click();
  await sidebar.waitFor({ state: 'hidden' });
  await rightToggle.click();
  await sidebar.waitFor();
  await expectLayoutWidth(348);
  await button('Schematic').click();
  await button('Layout').click();
  await expectLayoutWidth(348);
  await dragLayoutWidth(40);
  await expectLayoutWidth(388);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectLayoutWidth(348);
  assert.equal(await sidebar.isVisible(), true, 'Escape cancels resizing without hiding the dock.');
  const combinedWidth = (await canvas.boundingBox()).width + (await sidebar.boundingBox()).width;
  await dragLayoutWidth(650);
  await page.mouse.up();
  await expectLayoutWidth(Math.min(480, combinedWidth - 160));
  await assertDocked(canvas, sidebar);
  for (let index = 0; index < 20; index++) await layoutResize.press('ArrowRight');
  await expectLayoutWidth(224);
  await layoutResize.dblclick();
  await expectLayoutWidth(300);
  await layoutResize.press('ArrowLeft');
  await layoutResize.press('Home');
  await expectLayoutWidth(300);
  await clean();
  const resistorFootprint = fixture.pcb.footprints.find(
    (footprint) =>
      fixture.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref === 'R1',
  );
  assert.ok(resistorFootprint, 'The fixture has the matching Schematic/Layout component.');
  const footprintPoint = await canvas.evaluate((svg, footprint) => {
    const point = new DOMPoint(footprint.x, footprint.y).matrixTransform(svg.getScreenCTM());
    return { x: point.x, y: point.y };
  }, resistorFootprint);
  await page.mouse.dblclick(footprintPoint.x, footprintPoint.y);
  const layoutProperties = sidebar.getByRole('complementary', {
    name: 'Layout properties',
    exact: true,
  });
  const layoutX = layoutProperties.getByRole('spinbutton', { name: 'X (mm)', exact: true });
  await layoutX.waitFor();
  assert.deepEqual(
    await numericInputStyle(layoutX),
    schematicNumericStyle,
    'Layout geometry controls share Schematic typography, insets, surfaces and sizing.',
  );
  await assertEqualColumns(
    layoutProperties.locator('.part-properties .property-primary'),
    2,
    'Layout identity',
  );
  assert.deepEqual(
    await componentPropertiesStyle(layoutProperties),
    schematicComponentPropertiesStyle,
    'Linked Layout Properties shares Schematic identity, Footprint field and component delete action.',
  );
  await layoutProperties
    .getByRole('textbox', { name: 'Component reference', exact: true })
    .waitFor();
  await layoutProperties.getByRole('textbox', { name: 'Component value', exact: true }).waitFor();
  assert.equal(await layoutProperties.locator('.property-simulation').count(), 0);
  assert.equal(
    await layoutProperties.getByRole('switch', { name: /^Include .*in SPICE simulation$/ }).count(),
    0,
    'SPICE participation belongs only to Schematic plugin controls.',
  );
  assert.equal(
    await layoutProperties
      .getByRole('button', { name: 'Browse footprints', exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(
    await layoutProperties.getByRole('button', { name: 'Delete object', exact: true }).count(),
    1,
  );
  assert.equal(
    await layoutProperties.getByRole('heading', { name: 'Footprint', exact: true }).count(),
    0,
  );
  assert.equal(await layoutProperties.getByText('Library', { exact: true }).count(), 0);
  await assertEqualColumns(
    layoutProperties.locator('.layout-property-grid[data-columns="3"]'),
    3,
    'Layout geometry',
  );
  assert.equal(
    await layoutX.evaluate((input) => {
      const field = input.closest('label');
      const label = field.querySelector(':scope > span').getBoundingClientRect();
      const control = input.getBoundingClientRect();
      return control.top >= label.bottom + 3 && Math.abs(control.left - label.left) <= 1;
    }),
    true,
    'Layout geometry places each label above its full-column control, like Schematic.',
  );
  for (const name of ['Visualization', 'Selection'])
    await sidebar.getByRole('button', { name, exact: true }).click();
  await page.screenshot({ path: 'test-results/editor-sidebar-layout-footprint.png' });
  for (const name of ['Visualization', 'Selection'])
    await sidebar.getByRole('button', { name, exact: true }).click();
  await button('Source').click();
  const assignmentBaseline = await readNativeFiles(page);
  const beforeAssignment = await readNativeProject(page);
  const originalPackage = beforeAssignment.pcb.footprints.find(
    (footprint) => footprint.id === resistorFootprint.id,
  );
  await button('Layout').click();
  const layoutValue = layoutProperties.getByRole('textbox', {
    name: 'Component value',
    exact: true,
  });
  await layoutValue.focus();
  await layoutValue.dispatchEvent('compositionstart');
  await layoutValue.fill('4.7k');
  await layoutX.focus();
  await clean();
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    assignmentBaseline,
    'Blurring the shared Layout form during IME composition cannot commit a partial value.',
  );
  await button('Layout').click();
  await layoutValue.dispatchEvent('compositionend');
  await layoutValue.focus();
  await layoutValue.press('Escape');
  assert.equal(await layoutValue.inputValue(), resistorPart.value);
  const browseFootprints = layoutProperties.getByRole('button', {
    name: 'Browse footprints',
    exact: true,
  });
  const footprintDialog = page.getByRole('dialog', { name: 'Footprints', exact: true });
  await browseFootprints.click();
  await footprintDialog.waitFor();
  await footprintDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    assignmentBaseline,
    'Cancelling the Layout chooser retains every native file.',
  );
  await button('Layout').click();
  const choosePackage = async (detail) => {
    await browseFootprints.click();
    await footprintDialog
      .getByRole('textbox', { name: 'Search footprints', exact: true })
      .fill(detail.name);
    await footprintDialog
      .locator(`.library-results button[aria-description="${detail.id}"]`)
      .click();
    await footprintDialog.getByRole('button', { name: 'Assign footprint', exact: true }).click();
    await footprintDialog.waitFor({ state: 'hidden' });
  };
  await choosePackage(replacementPackage);
  const footprintField = layoutProperties.getByRole('textbox', { name: 'Footprint', exact: true });
  assert.equal(await footprintField.inputValue(), replacementPackage.id);
  await button('Source').click();
  const replacedProject = await readNativeProject(page);
  const replacedPackage = replacedProject.pcb.footprints.find(
    (footprint) => footprint.id === originalPackage.id,
  );
  assert.equal(
    partFields(replacedProject.schematic.parts.find((part) => part.ref === 'R1')).Footprint,
    replacementPackage.id,
  );
  assert.equal(replacedPackage.libraryId, replacementPackage.id);
  for (const key of ['id', 'symbolId', 'x', 'y', 'rotation', 'side'])
    assert.deepEqual(
      replacedPackage[key],
      originalPackage[key],
      `Replacing a package retains its ${key}.`,
    );
  const padAssociations = (footprint) =>
    footprint.pads.map(({ number, id, netId }) => ({ number, id, netId }));
  assert.deepEqual(
    padAssociations(replacedPackage),
    padAssociations(originalPackage),
    'Replacement retains matching pad identities and schematic nets.',
  );
  assert.notDeepEqual(
    replacedPackage.pads.map((pad) => [pad.type, pad.x, pad.y, pad.size]),
    originalPackage.pads.map((pad) => [pad.type, pad.x, pad.y, pad.size]),
    'Replacement installs the chosen package geometry.',
  );
  assert.deepEqual(
    replacedProject.pcb.tracks,
    beforeAssignment.pcb.tracks,
    'Package replacement retains routed copper.',
  );
  assert.deepEqual(replacedProject.pcb.vias, beforeAssignment.pcb.vias);
  assert.ok(
    originalPackage.side === 'back' && originalPackage.rotation === 90,
    'The replacement fixture exercises retained side and rotation.',
  );
  assert.ok(beforeAssignment.pcb.zones.some((zone) => zone.filledPolygons?.length));
  assert.ok(
    replacedProject.pcb.zones.every((zone) => !zone.filledPolygons?.length),
    'Package replacement invalidates saved fills.',
  );
  await button('Layout').click();
  await button('Undo').click();
  assert.equal(
    await button('Undo').isEnabled(),
    false,
    'Package assignment is exactly one project edit.',
  );
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    assignmentBaseline,
    'One undo restores the complete original native file set.',
  );
  await button('Layout').click();
  await choosePackage(unsupportedPackage);
  await layoutProperties.locator('.part-properties [role="alert"]').waitFor();
  assert.equal(
    await footprintField.inputValue(),
    originalPackage.libraryId,
    'Rejected chooser packages retain the current Footprint field.',
  );
  await footprintField.focus();
  await footprintField.press('Tab');
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    assignmentBaseline,
    'Rejected packages remain native-clean after the Footprint field blurs.',
  );
  await button('Layout').click();
  await clean();
  assert.equal(await button('Undo').isEnabled(), false);
  if (await button('Dismiss notification').isVisible())
    await button('Dismiss notification').click();
  await assertEditorViewControls(page, 'Layout');
  await assertDocked(canvas, sidebar);
  await assertSidebarTogglePlacement(page.locator('.layout-toolbar'));
  assert.equal(await rightToggle.count(), 1);
  assert.equal(
    await sidebar.locator('.layout-appearance-header').count(),
    0,
    'Layout omits a separate Appearance heading row.',
  );
  const toggleBounds = await rightToggle.boundingBox();
  for (const name of ['Properties', 'Visualization', 'Selection']) {
    const disclosure = sidebar.getByRole('button', { name, exact: true });
    if ((await disclosure.getAttribute('aria-expanded')) === 'true') await disclosure.click();
  }
  const collapsedDrawerGeometry = await drawerGeometry(sidebar);
  assertDrawerPlacement(collapsedDrawerGeometry);
  await page.screenshot({ path: 'test-results/editor-sidebar-layout-collapsed.png' });
  const collapsedToggleBounds = await rightToggle.boundingBox();
  assert.equal(
    collapsedToggleBounds.y,
    toggleBounds.y,
    'Collapsing all three sections cannot move the toolbar toggle.',
  );
  for (const name of ['Properties', 'Visualization', 'Selection'])
    await sidebar.getByRole('button', { name, exact: true }).click();
  const filters = sidebar.getByRole('group', { name: 'Selection', exact: true });
  const categories = [
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
  ];
  assert.deepEqual(
    await filters
      .getByRole('checkbox')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
    categories,
    'Selection categories follow the Layout row-major matrix.',
  );
  const category = (name) => filters.getByRole('checkbox', { name, exact: true });
  const master = category('All items');
  assert.equal(await master.isChecked(), true);
  assert.equal(await master.evaluate((input) => input.indeterminate), false);
  for (const name of categories.filter(
    (name) => !['All items', 'Locked items', 'Points'].includes(name),
  ))
    assert.equal(await category(name).isChecked(), true, `${name} is eligible by default.`);
  assert.equal(await category('Locked items').isChecked(), false);
  assert.equal(await category('Other items').count(), 0);
  assert.equal(
    await category('Points').isDisabled(),
    true,
    'Points remains visibly unavailable without an independent object type.',
  );
  assert.equal(await category('Points').isChecked(), false);
  await category('Locked items').uncheck();
  await master.check();
  assert.equal(await master.evaluate((input) => input.indeterminate), false);
  for (const name of categories.filter(
    (name) => !['All items', 'Locked items', 'Points'].includes(name),
  ))
    assert.equal(await category(name).isChecked(), true);
  assert.equal(
    await category('Locked items').isChecked(),
    false,
    'The master does not change the independent lock gate.',
  );
  await master.uncheck();
  for (const name of categories.filter(
    (name) => !['All items', 'Locked items', 'Points'].includes(name),
  ))
    assert.equal(await category(name).isChecked(), false);
  await master.check();
  await category('Locked items').check();
  await category('Pads').uncheck();
  assert.equal(await master.evaluate((input) => input.indeterminate), true);
  const tab = (name) => sidebar.getByRole('tab', { name, exact: true });
  await tab('Layers').click();
  await tab('Layers').press('ArrowRight');
  assert.equal(await tab('Objects').getAttribute('aria-selected'), 'true');
  await tab('Objects').press('End');
  assert.equal(await tab('Nets').getAttribute('aria-selected'), 'true');
  await tab('Nets').press('Home');
  assert.equal(await tab('Layers').getAttribute('aria-selected'), 'true');
  await sidebar.getByRole('checkbox', { name: 'B.Cu', exact: true }).uncheck();
  assert.equal(await canvas.locator('[data-pcb-layer="B.Cu"]').count(), 0);
  await sidebar.getByRole('button', { name: 'B.Cu', exact: true }).click();
  assert.equal(
    await sidebar.getByRole('button', { name: 'B.Cu', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await tab('Objects').click();
  await sidebar.getByRole('checkbox', { name: 'Pad numbers', exact: true }).uncheck();
  await tab('Nets').click();
  await sidebar.getByRole('checkbox', { name: 'Show airwires for OUT', exact: true }).uncheck();
  await sidebar.getByRole('button', { name: 'Highlight OUT', exact: true }).click();
  assert.ok(
    (await canvas.locator('[data-net-id][opacity="0.2"]').count()) > 0,
    'Net highlighting reaches the actual drawing.',
  );
  await sidebar.getByRole('button', { name: 'Clear net highlight', exact: true }).click();
  await category('Tracks').uncheck();
  await rightToggle.click();
  assert.equal(await sidebar.isVisible(), false);
  await button('Schematic').click();
  assert.equal(
    await schematicSidebar.isVisible(),
    false,
    'The right-sidebar visibility preference follows editor view changes.',
  );
  assert.equal(await rightToggle.getAttribute('aria-pressed'), 'false');
  await rightToggle.click();
  await schematicSidebar.waitFor();
  await button('Layout').click();
  assert.equal(await tab('Nets').getAttribute('aria-selected'), 'true');
  assert.equal(
    await sidebar.getByRole('checkbox', { name: 'Show airwires for OUT', exact: true }).isChecked(),
    false,
  );
  assert.equal(await category('Tracks').isChecked(), false);
  await rightToggle.click();
  assert.equal(await sidebar.isVisible(), false);
  await rightToggle.click();
  await sidebar.waitFor();
  const filterDisclosure = filters.getByRole('button', { name: 'Selection', exact: true });
  await filterDisclosure.click();
  assert.equal(await filterDisclosure.getAttribute('aria-expanded'), 'false');
  await filterDisclosure.click();
  assert.equal(await rightToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await category('Tracks').isChecked(),
    false,
    'Explicitly reopening filters retains their previous values.',
  );
  assert.equal(await tab('Nets').getAttribute('aria-selected'), 'true');
  await tab('Objects').click();
  assert.equal(
    await sidebar.getByRole('checkbox', { name: 'Pad numbers', exact: true }).isChecked(),
    false,
  );
  await tab('Layers').click();
  assert.equal(
    await sidebar.getByRole('button', { name: 'B.Cu', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  const frontLayer = sidebar.getByRole('checkbox', { name: 'F.Cu', exact: true });
  const backLayer = sidebar.getByRole('checkbox', { name: 'B.Cu', exact: true });
  await frontLayer.uncheck();
  await backLayer.check();
  assert.equal(
    await sidebar.getByRole('checkbox', { name: 'F.Cu', exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await sidebar.getByRole('checkbox', { name: 'B.Cu', exact: true }).isChecked(),
    true,
  );
  await frontLayer.check();
  await backLayer.uncheck();
  assert.equal(
    await sidebar.getByRole('checkbox', { name: 'F.Cu', exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await sidebar.getByRole('checkbox', { name: 'B.Cu', exact: true }).isChecked(),
    false,
  );
  await backLayer.check();
  await button('Fit board to canvas').click();
  await canvas.press('ControlOrMeta+Home');
  await clean();
  await page.screenshot({ path: 'test-results/editor-sidebar-layout.png' });
  await screenshotEditorCorner(canvas, 'light');
  for (const viewport of [
    { width: 900, height: 650 },
    { width: 1120, height: 760 },
  ]) {
    await page.setViewportSize(viewport);
    // The shell preserves conversation/editor minimums; its existing caption
    // action makes the full drawing area available in a compact desktop window.
    if (viewport.width === 900) await button('Toggle sidebar').click();
    await assertDocked(canvas, sidebar);
    await canvas.dblclick({ position: { x: 10, y: 10 } });
    const boardProperties = sidebar.getByRole('complementary', {
      name: 'Layout properties',
      exact: true,
    });
    await boardProperties.locator('.properties-empty-state:visible').waitFor();
    assert.equal(
      await boardProperties.getByLabel('Board thickness (mm)', { exact: true }).count(),
      0,
    );
    await checkDrawerSharing(sidebar, canvas);
    await category('Points').scrollIntoViewIfNeeded();
    const [pointBounds, sidebarBounds] = await Promise.all([
      category('Points').boundingBox(),
      sidebar.boundingBox(),
    ]);
    assert.ok(
      pointBounds.y >= sidebarBounds.y &&
        pointBounds.y + pointBounds.height <= sidebarBounds.y + sidebarBounds.height,
      `The final filter remains reachable with board Properties open. ${JSON.stringify({
        viewport,
        pointBounds,
        sidebarBounds,
        drawers: await drawerGeometry(sidebar),
      })}`,
    );
    await rightToggle.click();
    await sidebar.waitFor({ state: 'hidden' });
    await rightToggle.click();
    await boardProperties.locator('.properties-empty-state:visible').waitFor();
    assert.equal(
      await boardProperties.getByLabel('Board thickness (mm)', { exact: true }).count(),
      0,
    );
    await tab('Layers').scrollIntoViewIfNeeded();
    if (viewport.width === 900) await button('Toggle sidebar').click();
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--font-step', '4px'));
  await checkDrawerSharing(sidebar, canvas);
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    original,
    'Layer, object, net and filter controls never edit native design data.',
  );
  await clean();
  await button('Layout').click();
  await button('Settings').click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await button('Done').click();
  if (await button('Dismiss notification').isVisible())
    await button('Dismiss notification').click();
  await page.screenshot({ path: 'test-results/editor-sidebar-layout-dark.png' });
  await screenshotEditorCorner(canvas, 'dark');
  await button('Home').click();
  assert.equal(await rightToggle.count(), 0, 'Home has no right dock to toggle.');
  await page.getByRole('group', { name: 'Open projects', exact: true }).getByRole('button').click();
  await sidebar.waitFor();
  assert.equal(await rightToggle.isEnabled(), true);
  assert.equal(await rightToggle.getAttribute('aria-pressed'), 'true');
  // Exercise the actual dense example in the same isolated, mocked renderer.
  await page.goto('about:blank');
  const emc = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  state = {
    ...state,
    documents: [
      {
        ...state.documents[0],
        source: serializeProject(emc),
        sourceDraft: null,
        dirty: false,
        filename: 'emc-flyback.kicad_pro',
        activeSchematicId: emc.schematic.id,
        closedSchematicIds: [],
      },
    ],
  };
  await mount();
  await schematic.waitFor();
  await button('Source').click();
  const emcOriginal = await readNativeFiles(page);
  await button('Layout').click();
  await tab('Nets').click();
  const search = sidebar.getByRole('textbox', { name: 'Search nets', exact: true });
  const clearSearch = sidebar.getByRole('button', { name: 'Clear net search', exact: true });
  const clearHighlight = sidebar.getByRole('button', { name: 'Clear net highlight', exact: true });
  const netList = sidebar.locator('.layout-appearance-content');
  assert.equal(await sidebar.locator('.layout-net-row').count(), emc.pcb.nets.length);
  assert.equal(
    await sidebar.getByRole('alert').count(),
    0,
    'The pinned EMC board has a complete bounded airwire preview.',
  );
  await sidebar.getByRole('button', { name: 'Highlight CLAMP', exact: true }).click();
  await netList.evaluate((element) => (element.scrollTop = element.scrollHeight));
  const [searchBounds, listBounds] = await Promise.all([
    search.boundingBox(),
    netList.boundingBox(),
  ]);
  assert.ok(
    searchBounds.y >= listBounds.y - 1 &&
      searchBounds.y + searchBounds.height <= listBounds.y + listBounds.height,
    'Dense EMC net scrolling keeps search and clear actions visible.',
  );
  assert.equal(await clearHighlight.isEnabled(), true);
  await clearHighlight.click();
  assert.equal(
    await search.evaluate((element) => element === document.activeElement),
    false,
    'Pointer clearing does not move focus into search.',
  );
  await search.fill('clamp');
  assert.equal(await sidebar.locator('.layout-net-row').count(), 1);
  const clearBounds = await clearSearch.boundingBox();
  assert.ok(
    clearBounds.width >= 30 && clearBounds.height >= 30,
    'Clear search retains a 30 px target.',
  );
  await sidebar.getByRole('button', { name: 'Highlight CLAMP', exact: true }).click();
  await clearHighlight.focus();
  await clearHighlight.press('Enter');
  assert.equal(await search.evaluate((element) => element === document.activeElement), true);
  assert.equal(await clearHighlight.count(), 0);
  await clearSearch.focus();
  await clearSearch.press('Enter');
  assert.equal(await search.inputValue(), '');
  assert.equal(await search.evaluate((element) => element === document.activeElement), true);
  assert.equal(await sidebar.locator('.layout-net-row').count(), emc.pcb.nets.length);
  await search.fill('CLAMP');
  await sidebar.getByRole('button', { name: 'Highlight CLAMP', exact: true }).click();
  await rightToggle.click();
  await rightToggle.click();
  assert.equal(await search.inputValue(), 'CLAMP');
  assert.equal(
    await sidebar
      .getByRole('button', { name: 'Highlight CLAMP', exact: true })
      .getAttribute('aria-pressed'),
    'true',
    'Hiding the dock retains the dense-board search and highlights.',
  );
  await page.screenshot({ path: 'test-results/editor-sidebar-emc-nets.png' });
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    emcOriginal,
    'EMC net inspection retains native files.',
  );
  await clean();
  assert.deepEqual(
    await page
      .locator('[title], svg title, [role="tooltip"], .project-name-reveal')
      .evaluateAll((items) =>
        items
          .filter((element) => {
            if (element.matches('svg title, [role="tooltip"], .project-name-reveal')) return true;
            if (element.matches('.cm-foldGutter [aria-label], .cm-foldPlaceholder')) return false;
            const text = (element.innerText ?? element.textContent ?? '').trim();
            const iconControl =
              element.closest('button, [role="button"], [role="combobox"], label') ||
              element.matches('[role="img"][aria-label], [role="status"][aria-label]');
            return !iconControl || text.length > 0;
          })
          .map((element) => ({
            tag: element.tagName,
            label: element.getAttribute('aria-label'),
            title: element.getAttribute('title'),
            text: element.textContent?.slice(0, 120),
          })),
      ),
    [],
    'Hover hints explain icon controls without duplicating visible text or graphic metadata.',
  );
  for (const name of ['Copy', 'Apply'])
    assert.equal(await button(name).getAttribute('title'), name, `${name} retains its icon hint.`);
  assert.deepEqual(
    await page
      .locator('[title]')
      .evaluateAll((items) =>
        items
          .map((element) => element.getAttribute('title'))
          .filter((hint) => /[:：·|—–×\r\n]/u.test(hint)),
      ),
    [],
    'Icon hints use plain names without separator punctuation or extra lines.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Editor sidebars passed: distinct shared dock headers, fixed Properties/Visualization/Selection order in all expansion states, shared display-content styles, eye visibility controls, compact two-column filters, fully collapsed bottom stack, persistent toolbar toggle, retained drafts/settings, dock bounds, component edit/undo, dense EMC net controls and native cleanliness.',
  );
} finally {
  await browser.close();
}
