import { parseProject, projectNativeFiles } from '../server/project-format.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

const { pinPositions } = await tsImport('../lib/circuit.ts', import.meta.url);
const { parseKiCadPCB } = await tsImport('../lib/kicad-pcb.ts', import.meta.url);
const { boardPolygons } = await tsImport('../lib/pcb-polygons.ts', import.meta.url);
const samePoint = (a, b) => Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001;

function assertNativeZoneBoundaries(board, expected, title) {
  const polygons = boardPolygons(board);
  assert.equal(polygons.length, 1, `${title}: native PCB has one board outline.`);
  assert.equal(polygons[0].holes.length, 0, `${title}: native PCB has no board cutouts.`);
  const points = polygons[0].outer;
  const bounds = {
    minX: Math.min(...points.map((point) => point.x)) + 0.5,
    minY: Math.min(...points.map((point) => point.y)) + 0.5,
    maxX: Math.max(...points.map((point) => point.x)) - 0.5,
    maxY: Math.max(...points.map((point) => point.y)) - 0.5,
  };
  assert.deepEqual(
    board.zones.map((zone) => zone.id),
    expected.zones.map((zone) => zone.id),
    `${title}: native Source retains all zone identities and ordering.`,
  );
  const expectedZones = new Map(expected.zones.map((zone) => [zone.id, zone]));
  for (const zone of board.zones) {
    const original = expectedZones.get(zone.id);
    assert.deepEqual(
      {
        layer: zone.layer,
        net: board.nets.find((net) => net.id === zone.netId)?.name ?? null,
        outline: zone.outline,
        holes: zone.holes,
      },
      {
        layer: original.layer,
        net: expected.nets.find((net) => net.id === original.netId)?.name ?? null,
        outline: original.outline,
        holes: original.holes,
      },
      `${title}: native Source zone ${zone.id} matches the curated boundary.`,
    );
    assert.deepEqual(
      zone.filledPolygons,
      original.filledPolygons,
      `${title}: native Source zone ${zone.id} preserves every saved fill point and island.`,
    );
    if (zone.keepout || !board.layers.includes(zone.layer)) continue;
    for (const point of zone.outline)
      assert.ok(
        point.x >= bounds.minX - 0.000001 &&
          point.x <= bounds.maxX + 0.000001 &&
          point.y >= bounds.minY - 0.000001 &&
          point.y <= bounds.maxY + 0.000001,
        `${title}: native Source zone ${zone.id} stays at least 0.5 mm inside the board.`,
      );
  }
}

// One recovered source project per page: no Electron, user data, library or provider requests.
const manifest = JSON.parse(await readFile('resources/example-catalog/manifest.json', 'utf8'));
const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
assert.equal(manifest.examples.length, 9);
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'openpe-example-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  let recovery,
    footprintRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: false,
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
    if (url.pathname === '/api/state')
      return route.fulfill({ json: route.request().method() === 'GET' ? recovery : null });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/libraries/footprints') {
      footprintRequests++;
      return route.fulfill({
        status: 422,
        json: { error: 'Source boards retain embedded packages.' },
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const assertNoNativeDirty = async (title) =>
    assert.equal(
      await page.locator('.dirty-dot').count(),
      0,
      `${title}: viewing Source and Layout leaves native files and the project clean.`,
    );
  for (const [index, entry] of manifest.examples.entries()) {
    const source = sources[entry.id],
      project = JSON.parse(source),
      id = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    recovery = {
      version: 2,
      documents: [
        {
          id,
          source,
          sourceDraft: null,
          dirty: false,
          filename: 'project.kicad_pro',
          exampleKey: `example:${entry.id}`,
          localExample: true,
          sessions: [{ id: sessionId, messages: [], draft: '' }],
          activeSessionId: sessionId,
        },
      ],
      activeDocumentId: id,
      provider: 'codex',
      effort: 'low',
      approvalMode: 'review',
      models: {},
    };
    await page.goto('http://localhost');
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
      await page.addStyleTag({ content: output.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
    });
    await page.getByTestId('schematic-canvas').waitFor();
    const bench = project.extensions['org.openpe.reference-example'].simulation.testbench;
    const refs = [bench.source, ...bench.loads];
    const benchParts = project.schematic.components.filter((part) => refs.includes(part.reference));
    assert.equal(benchParts.length, refs.length);
    const parsed = parseProject(source);
    const circuit = parsed.schematic;
    const benchAssemblies = refs.map((ref) => {
      const part = circuit.parts.find((part) => part.ref === ref);
      assert.ok(part, `${entry.title}: ${ref} is present.`);
      const pins = pinPositions(part, circuit.libraries[part.libId]);
      assert.equal(pins.length, 2, `${entry.title}: ${ref} has two testbench terminals.`);
      const ids = [part.id];
      for (const [index, pin] of pins.entries()) {
        const leads = circuit.wires.filter(
          (wire) => samePoint(wire.a, pin) || samePoint(wire.b, pin),
        );
        assert.equal(leads.length, 1, `${entry.title}: ${ref} terminal ${index + 1} has one lead.`);
        const lead = leads[0];
        const endpoint = samePoint(lead.a, pin) ? lead.b : lead.a;
        assert.ok(!samePoint(endpoint, pin), `${entry.title}: ${ref} has a visible lead.`);
        ids.push(lead.id);
        if (index === 0) {
          const labels = circuit.labels.filter((label) => samePoint(label, endpoint));
          assert.equal(labels.length, 1, `${entry.title}: ${ref} rail label terminates its lead.`);
          ids.push(labels[0].id);
        } else {
          const grounds = circuit.parts.filter(
            (candidate) =>
              candidate.libId === 'power:GND' &&
              pinPositions(candidate, circuit.libraries[candidate.libId]).some((point) =>
                samePoint(point, endpoint),
              ),
          );
          assert.equal(grounds.length, 1, `${entry.title}: ${ref} ground terminates its lead.`);
          ids.push(grounds[0].id);
        }
      }
      return { ref, ids };
    });
    const benchIds = new Set(benchAssemblies.flatMap((assembly) => assembly.ids));
    assert.equal(
      benchIds.size,
      benchAssemblies.reduce((count, assembly) => count + assembly.ids.length, 0),
      `${entry.title}: each testbench assembly owns separate symbols, leads and labels.`,
    );
    const connectorIds = circuit.parts
      .filter((part) => /^J\d+$/.test(part.ref) && /^Connector(?:_|:)/.test(part.libId))
      .map((part) => part.id);
    const mainIds = [
      ...circuit.parts,
      ...circuit.wires,
      ...circuit.junctions,
      ...circuit.labels,
      ...(project.schematic.texts || []),
    ]
      .filter((item) => !benchIds.has(item.id))
      .map((item) => item.id);
    for (const part of benchParts) {
      assert.equal((part.fields?.Footprint || '').trim(), '');
      assert.equal(
        await page
          .getByTestId(`part-${part.reference}`)
          .locator('[data-symbol-role="virtual"]')
          .count(),
        1,
      );
    }
    const geometry = await page.getByTestId('schematic-canvas').evaluate(
      (canvas, { benchAssemblies, connectorIds, mainIds }) => {
        const rectangles = (ids) =>
          [...canvas.querySelectorAll('[data-selection-id]')]
            .filter((element) => ids.has(element.dataset.selectionId))
            .map((element) => {
              const bounds = element.getBoundingClientRect();
              return {
                id: element.dataset.selectionId,
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
                width: bounds.width,
                height: bounds.height,
              };
            })
            .filter((rect) => rect.width || rect.height);
        const benchBounds = benchAssemblies.map((assembly) => {
          const bounds = rectangles(new Set(assembly.ids));
          return {
            ref: assembly.ref,
            items: bounds,
            left: Math.min(...bounds.map((b) => b.left)),
            top: Math.min(...bounds.map((b) => b.top)),
            right: Math.max(...bounds.map((b) => b.right)),
            bottom: Math.max(...bounds.map((b) => b.bottom)),
          };
        });
        return {
          connectorRight: Math.max(...rectangles(new Set(connectorIds)).map((b) => b.right)),
          mainBounds: rectangles(new Set(mainIds)).map((b) => ({
            id: b.id,
            left: b.left,
            top: b.top,
            right: b.right,
            bottom: b.bottom,
          })),
          benchBounds,
        };
      },
      { benchAssemblies, connectorIds, mainIds },
    );
    await page.screenshot({ path: `test-results/openpe-reference-schematic-${index + 1}.png` });
    assert.ok(Number.isFinite(geometry.connectorRight), 'Connector geometry is rendered.');
    for (const bounds of geometry.benchBounds) {
      assert.ok(
        [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite),
        `${entry.title}: ${bounds.ref} assembly is rendered.`,
      );
      assert.ok(
        bounds.left > geometry.connectorRight + 4,
        `${entry.title}: source and loads sit to the right of the connectors.`,
      );
      // The complete assembly rectangle includes empty space below long source
      // parameters. Check its individual visible items against original artwork.
      for (const item of bounds.items)
        for (const main of geometry.mainBounds)
          assert.ok(
            item.right < main.left ||
              item.left > main.right ||
              item.bottom < main.top ||
              item.top > main.bottom,
            `${entry.title}: ${bounds.ref} item ${item.id} does not overlap original artwork ${main.id}: ${JSON.stringify({ assembly: item, original: main })}.`,
          );
    }
    for (let i = 1; i < geometry.benchBounds.length; i++)
      assert.ok(
        geometry.benchBounds[i - 1].right < geometry.benchBounds[i].left,
        `${entry.title}: source and load assemblies do not overlap.`,
      );
    await button('Source').click();
    const native = projectNativeFiles(parsed, 'project.kicad_pro');
    const schematicSource = native.files.find((file) => file.name.endsWith('.kicad_sch'));
    assert.ok(schematicSource, `${entry.title}: native schematic source is present.`);
    await selectSourceFile(page, schematicSource.name);
    assert.ok(
      (await readSource(page)) === schematicSource.source,
      `${entry.title}: opening preserves native schematic bytes.`,
    );
    await assertNoNativeDirty(entry.title);
    await button('Dismiss notification').click();
    await button('Layout').click();
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor();
    assert.ok(
      (await canvas.locator('[data-selection-id]').count()) >= parsed.pcb.footprints.length,
    );
    for (const zone of parsed.pcb.zones.filter((z) => z.filledPolygons?.length))
      assert.ok(
        (await canvas.locator(`[data-copper-zone="${zone.id}"]`).getAttribute('d'))?.length > 0,
        `${entry.title}: saved native copper is rendered.`,
      );
    await assertNoNativeDirty(entry.title);
    await page.screenshot({ path: `test-results/openpe-reference-layout-${index + 1}.png` });
    await button('Source').click();
    const boardSource = native.files.find((file) => file.name.endsWith('.kicad_pcb'));
    assert.ok(boardSource, `${entry.title}: native board source is present.`);
    await selectSourceFile(page, boardSource.name);
    const actualBoardSource = await readSource(page);
    assert.equal(
      actualBoardSource,
      boardSource.source,
      `${entry.title}: viewing Layout preserves native board bytes.`,
    );
    const nativeBoard = parseKiCadPCB(actualBoardSource, circuit, entry.id).board;
    assertNativeZoneBoundaries(nativeBoard, parsed.pcb, entry.title);
    await assertNoNativeDirty(entry.title);
    await selectSourceFile(page, schematicSource.name);
    assert.ok(
      (await readSource(page)) === schematicSource.source,
      `${entry.title}: viewing Layout preserves native schematic bytes.`,
    );
    await assertNoNativeDirty(entry.title);
    console.log(
      `${entry.title}: schematic, native Source and Layout preserve inset boundaries and saved copper.`,
    );
  }
  assert.equal(footprintRequests, 0, 'Loaded source boards never fetch replacement packages.');
  assert.deepEqual(errors, []);
  console.log(
    'Reference: all nine complete projects render without mutations or footprint requests.',
  );
} finally {
  await browser.close();
}
