import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { startServer } from '../server/index.mjs';
import { createProjectThermalStore } from '../server/project-thermal-files.mjs';
import { workspaceFilename } from '../server/workspace-storage.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Explicit offline integration check. First run simulation:check-emc-flyback.
// Only the unrelated Agent/provider discovery responses and the native picker
// boundary are isolated. Thermal detection, compilation, solver execution,
// authenticated HTTP, publication and restoration use production implementations.
const restoreOnly = process.argv.slice(2).includes('--restore');
assert.ok(process.argv.slice(2).every((arg) => arg === '--restore'));
const directory = path.resolve('test-results/emc-flyback-thermal-ui');
const runtime = path.join(directory, 'runtime');
const nativeDirectory = path.join(runtime, 'project');
const dataDir = path.join(runtime, 'service');
const staticDir = path.join(runtime, 'static');
await Promise.all(
  [nativeDirectory, dataDir, staticDir].map((folder) => mkdir(folder, { recursive: true })),
);
const { parseProject, projectNativeFiles } = await tsImport('../lib/project.ts', import.meta.url);
const { buildSpiceDeck, defaultTransient } = await tsImport('../lib/spice.ts', import.meta.url);
const { defaultThermalConfig, deriveThermalSpiceSources, prepareThermalModel } = await tsImport(
  '../lib/thermal.ts',
  import.meta.url,
);
const { thermalSurface, hottestThermalNode, closestThermalNode } = await tsImport(
  '../lib/thermal-view.ts',
  import.meta.url,
);
const { circuitFingerprint } = await tsImport('../lib/circuit.ts', import.meta.url);
const { validateAgentWorkspaceContext } = await tsImport(
  '../context/agent-workspace-context.ts',
  import.meta.url,
);
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const project = parseProject(source);
assert.ok(project.pcb, 'EMC Flyback contains a PCB.');
const electrical = JSON.parse(
  await readFile('test-results/emc-flyback-simulation/result.json', 'utf8'),
);
const deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
const imported = deriveThermalSpiceSources(project.schematic, project.pcb, deck, electrical);
const requestedConfig = { ...defaultThermalConfig(project.pcb), heatSources: imported.heatSources };
const documentId = randomUUID(),
  sessionId = randomUUID(),
  fileId = randomUUID();
const native = projectNativeFiles(project, 'emc-flyback.kicad_pro');
const nativeFile = path.join(nativeDirectory, native.entry);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nativeHashes = {};
for (const file of native.files) {
  const destination = path.resolve(nativeDirectory, file.name);
  const relative = path.relative(nativeDirectory, destination);
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Native integration files stay within the isolated project.',
  );
  const bytes = Buffer.from(file.source, file.encoding ?? 'utf8');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  nativeHashes[file.name] = hash(bytes);
}
await writeFile(
  path.join(dataDir, workspaceFilename),
  JSON.stringify({
    version: 2,
    documents: [
      {
        id: documentId,
        source,
        sourceDraft: null,
        dirty: false,
        filename: native.entry,
        sessions: [{ id: sessionId, messages: [], draft: '' }],
        activeSessionId: sessionId,
      },
    ],
    activeDocumentId: documentId,
    provider: 'codex',
    effort: 'low',
    approvalMode: 'review',
    models: {},
  }),
);
await writeFile(
  path.join(staticDir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>OpenPE EMC thermal integration check</title></head><body><div id="root"></div></body></html>',
);
const thermalStore = createProjectThermalStore(() => nativeFile);
const server = await startServer({
  dataDir,
  staticDir,
  thermalResultFiles: {
    forProject: (id) => (id === fileId ? thermalStore : null),
  },
});
const started = Date.now();
let browser, page;
const errors = [],
  thermalRequests = [],
  nativeExports = [],
  screenshots = [];
const report = {
  startedAt: new Date(started).toISOString(),
  restoreOnly,
  project: {
    id: project.id,
    name: project.name,
    boardId: project.pcb.id,
    sourceSha256: hash(source),
    nativeHashes,
  },
  electricalInput: {
    file: 'test-results/emc-flyback-simulation/result.json',
    sha256: hash(JSON.stringify(electrical)),
    origin:
      'Fresh real ngspice result; exact deriveThermalSpiceSources losses supplied as Manual thermal inputs. The UI normalizes numeric drafts to six significant figures before Run. No SPICE provenance is fabricated.',
    window: imported.window,
    losses: imported.losses,
    assumptions: imported.assumptions,
  },
  isolation: {
    nativeBoundary:
      'A test-only opaque UUID resolves solely to runtime/project/emc-flyback.kicad_pro; native image picker writes only the dedicated test PNG.',
    service:
      'Production authenticated startServer; real workspace/plugin state, thermal detector/compiler/Gmsh/Elmer runner and native thermal result store.',
    mockedRoutes: ['/api/agents', '/api/models', '/api/plugins'],
    note: 'Unrelated Agent/provider discovery only. No thermal endpoint, field, solver response or saved thermal result is mocked. The user desktop instance is not accessed.',
  },
};
async function snapshotBaseline() {
  return page.evaluate(async () => ({
    source: await window.thermalWorkbenchHost().query('project.source'),
    history: await window.thermalWorkbenchHost().query('history.get'),
    dirty: (await window.thermalWorkbenchHost().query('workbench.state')).ui.dirty,
  }));
}
async function screenshot(name) {
  const file = path.join(directory, name);
  await page.screenshot({ path: file });
  screenshots.push(file);
}
function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function edgeDistance(point, ring) {
  let distance = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return distance;
}
try {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import Workspace from './components/DesktopWorkspace';window.thermalWorkbenchHost=()=>window.__thermalHosts?.findLast(host=>host.catalog().some(entry=>entry.id==='workbench.state'));createRoot(document.getElementById('root')).render(<Workspace/>);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    outfile: path.join(directory, 'workbench.js'),
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'isolated-capability-observer',
        setup(builder) {
          builder.onLoad({ filter: /[\\/]api[\\/]capabilities\.ts$/ }, async ({ path: file }) => ({
            loader: 'ts',
            contents:
              (await readFile(file, 'utf8')).replace(
                'export function createCapabilityHost(',
                'function originalCreateCapabilityHost(',
              ) +
              '\nexport function createCapabilityHost(options){const host=originalCreateCapabilityHost(options);(window.__thermalHosts??=[]).push(host);return host;}',
          }));
        },
      },
    ],
  });
  browser = await chromium.launch({
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  page.setDefaultTimeout(45000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/thermal/'))
      thermalRequests.push({
        path: url.pathname,
        method: request.method(),
        atMs: Date.now() - started,
        ...(url.pathname === '/api/thermal/run'
          ? { config: request.postDataJSON().config, fileId: request.postDataJSON().fileId }
          : {}),
      });
  });
  await page.exposeFunction('writeThermalTestExport', async (image) => {
    assert.match(image.dataUrl, /^data:image\/png;base64,/);
    const file = path.join(directory, 'emc-flyback-temperature.png');
    const bytes = Buffer.from(image.dataUrl.split(',')[1], 'base64');
    await writeFile(file, bytes);
    nativeExports.push({ file, name: image.name, bytes: bytes.length, sha256: hash(bytes) });
    return { name: path.basename(file) };
  });
  await page.addInitScript(
    ({ base, token, fileId }) => {
      window.openpe = {
        titleBarOverlay: false,
        writeWorkspaceRecovery: async (content) => {
          await fetch('http://localhost/api/state', {
            method: content === null ? 'DELETE' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: content ?? undefined,
          });
        },
        connection: async () => ({ base, token }),
        newFile: async () => fileId,
        releaseFile: async () => {},
        setDirty: async () => {},
        onCloseRequested: () => () => {},
        exportImage: (image) => window.writeThermalTestExport(image),
      };
    },
    { base: server.base, token: server.token, fileId },
  );
  await page.route(`${server.base}/api/agents`, (route) => route.fulfill({ json: [] }));
  await page.route(`${server.base}/api/models**`, (route) =>
    route.fulfill({ json: { models: [], defaultModel: '' } }),
  );
  await page.route(`${server.base}/api/plugins`, (route) =>
    route.fulfill({
      json: {
        controlsVersion: 1,
        plugins: [],
        actions: [],
        browse: true,
        warning: '',
        updatedAt: Date.now(),
      },
    }),
  );
  for (const folder of ['brand', 'agents', 'cursors'])
    await page.route(`${server.base}/${folder}/**`, async (route) => {
      const file = path.basename(new URL(route.request().url()).pathname);
      await route.fulfill({
        contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile(path.join('public', folder, file)),
      });
    });
  await page.goto(server.base);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  await page.getByTestId('schematic-canvas').waitFor();
  const baseline = await snapshotBaseline();
  report.baseline = {
    sourceSha256: hash(JSON.stringify(baseline.source)),
    history: baseline.history,
    dirty: baseline.dirty,
  };
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('button', { name: 'Layout Thermal', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Layout Thermal', exact: true });
  await panel.waitFor();
  const detected = await waitForAsync(page, async () => {
    const status = await window.thermalWorkbenchHost().query('thermal.status');
    if (status.status === 'unavailable' || status.error)
      throw new Error(status.error || status.solver?.error || 'Thermal solver unavailable.');
    return status.solver?.available ? status.solver : null;
  });
  report.detectedSolver = detected;
  console.log(`Actual Thermal UI: Gmsh ${detected.gmsh}; Elmer ${detected.elmer}.`);
  const layout = page.getByTestId('layout-canvas');
  const field = layout.locator('[data-thermal-field]');
  const raster = field.locator('[data-thermal-raster]');
  const legend = page.getByRole('region', { name: 'Layout board temperature', exact: true });
  const runs = () => thermalRequests.filter((request) => request.path === '/api/thermal/run');
  if (restoreOnly) {
    await field.waitFor({ timeout: 120000 });
    assert.equal(
      runs().length,
      0,
      '--restore displays the saved matching native result without solving.',
    );
  } else {
    await page.evaluate(
      (config) =>
        window.thermalWorkbenchHost().execute('thermal.configure', { config }, { actor: 'human' }),
      requestedConfig,
    );
    await screenshot('emc-flyback-thermal-settings.png');
    const solveStarted = Date.now();
    console.log(
      `Actual Thermal UI: starting real ${requestedConfig.meshSizeMm} mm EMC Flyback solve with ${imported.losses.length} dissipative paths.`,
    );
    await panel.getByRole('button', { name: 'Run', exact: true }).click();
    await waitForAsync(
      page,
      async () => {
        const status = await window.thermalWorkbenchHost().query('thermal.status');
        if (status.status === 'failed' || status.error)
          throw new Error(status.error || 'Actual thermal solve failed.');
        return status.status === 'completed' && status.result;
      },
      null,
      { timeout: 900000, polling: 1000 },
    );
    report.solveElapsedMs = Date.now() - solveStarted;
    assert.equal(
      runs().length,
      1,
      'The real Run button starts exactly one production thermal run.',
    );
  }
  await field.waitFor();
  await legend.waitFor();
  const saved = await thermalStore.read(new AbortController().signal);
  assert.ok(saved, 'The real solver artifacts are published beside the isolated native project.');
  const { result, model, solver } = saved;
  const prepared = prepareThermalModel(project.pcb, model.config);
  assert.equal(JSON.stringify(model), JSON.stringify(prepared));
  assert.equal(model.config.meshSizeMm, 2);
  assert.equal(
    model.config.spiceSource,
    undefined,
    'Manual derived watts do not claim a verified native SPICE import.',
  );
  for (const heat of imported.heatSources) {
    const applied = model.config.heatSources.find(
      (item) => item.footprintId === heat.footprintId,
    )?.powerW;
    assert.ok(
      Math.abs(applied - heat.powerW) <= Math.max(1e-12, Math.abs(heat.powerW) * 5e-6),
      'UI decimal normalization retains the measured loss.',
    );
  }
  assert.ok(result.statistics.maxC > model.config.ambientC);
  assert.ok(result.statistics.energyImbalanceRelative < 0.005);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result));
  await writeFile(
    path.join(directory, 'config.json'),
    JSON.stringify(model.config, null, 2) + '\n',
  );
  report.solver = solver;
  report.statistics = result.statistics;
  report.config = model.config;
  report.basis = result.basis;
  report.assumptions = result.assumptions;
  report.diagnostics = result.diagnostics;
  report.resultSha256 = hash(JSON.stringify(result));
  assert.equal(
    await panel.locator('.simulation-error').count(),
    0,
    'Successful solver diagnostics are details, not visible error messages.',
  );
  const completedStatus = panel.getByRole('status');
  for (const diagnostic of result.diagnostics) {
    assert.ok((await completedStatus.getAttribute('aria-description')).includes(diagnostic));
    assert.ok((await completedStatus.getAttribute('aria-description')).includes(diagnostic));
  }
  console.log(
    `Actual Thermal UI completed: ${result.statistics.nodeCount} nodes, ${result.statistics.minC.toFixed(2)}–${result.statistics.maxC.toFixed(2)} °C.`,
  );

  const front = thermalSurface(result, 'front'),
    back = thermalSurface(result, 'back');
  report.surfaces = {
    front: {
      z: front.z,
      nodes: front.indices.length,
      triangles: front.triangles.length,
      hottest: hottestThermalNode(result, 'front'),
    },
    back: {
      z: back.z,
      nodes: back.indices.length,
      triangles: back.triangles.length,
      hottest: hottestThermalNode(result, 'back'),
    },
  };
  const bounds = front.indices.reduce(
    (box, node) => {
      const point = result.points[node];
      return {
        minX: Math.min(box.minX, point.x),
        minY: Math.min(box.minY, point.y),
        maxX: Math.max(box.maxX, point.x),
        maxY: Math.max(box.maxY, point.y),
      };
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const expectedBox = [
    bounds.minX,
    bounds.minY,
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
  ];
  assert.deepEqual(
    await raster.evaluate((image) =>
      ['x', 'y', 'width', 'height'].map((name) => Number(image.getAttribute(name))),
    ),
    expectedBox,
    'The temperature map uses the exact real solved PCB coordinates.',
  );
  assert.equal(await field.getAttribute('data-thermal-surface'), 'front');
  assert.equal(
    Number(await layout.locator('[data-thermal-hottest]').getAttribute('data-thermal-hottest')),
    report.surfaces.front.hottest.node,
  );
  const viewWithField = await layout.getAttribute('viewBox');
  const frontPaint = await raster.getAttribute('href');
  assert.match(frontPaint, /^data:image\/png;base64,/);
  for (const value of [result.statistics.minC, result.statistics.maxC])
    assert.ok((await legend.innerText()).includes(value.toFixed(2)));

  // Sample rendered pixel centres against independently tested native board
  // polygons, away from boundaries. This includes mechanical and drill voids.
  const imageSize = await raster.evaluate(async (element) => {
    const image = new Image();
    image.src = element.getAttribute('href');
    await image.decode();
    return { width: image.width, height: image.height };
  });
  const samples = [];
  const rings = model.board.flatMap((polygon) => [polygon.outer, ...polygon.holes]);
  const spanX = bounds.maxX - bounds.minX,
    spanY = bounds.maxY - bounds.minY;
  const margin = Math.hypot(spanX / imageSize.width, spanY / imageSize.height) * 2;
  for (let row = 0; row < imageSize.height; row += 7)
    for (let column = 0; column < imageSize.width; column += 7) {
      const point = {
        x: bounds.minX + ((column + 0.5) * spanX) / imageSize.width,
        y: bounds.minY + ((row + 0.5) * spanY) / imageSize.height,
      };
      if (Math.min(...rings.map((ring) => edgeDistance(point, ring))) < margin) continue;
      const inside = model.board.some(
        (polygon) =>
          insideRing(point, polygon.outer) &&
          !polygon.holes.some((ring) => insideRing(point, ring)),
      );
      samples.push({ column, row, inside });
    }
  const pixels = await raster.evaluate(async (element, samples) => {
    const image = new Image();
    image.src = element.getAttribute('href');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    return samples.map(({ column, row }) => [
      ...pixels.slice((row * image.width + column) * 4, (row * image.width + column) * 4 + 4),
    ]);
  }, samples);
  let materialSamples = 0,
    voidSamples = 0;
  for (const [index, sample] of samples.entries()) {
    assert.equal(
      pixels[index][3],
      sample.inside ? 255 : 0,
      `Real temperature raster at pixel ${sample.column},${sample.row} agrees with board/void geometry.`,
    );
    sample.inside ? materialSamples++ : voidSamples++;
  }
  assert.ok(materialSamples > 100 && voidSamples > 0, 'The real board and its voids are sampled.');
  report.render = {
    bounds,
    imageSize,
    materialSamples,
    voidSamples,
    frontPaintSha256: hash(frontPaint),
    camera: viewWithField,
  };
  await screenshot('emc-flyback-layout-thermal-front.png');

  const surface = page.getByRole('combobox', { name: 'Thermal surface', exact: true });
  await surface.press('ArrowDown');
  await surface.press('End');
  await surface.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-thermal-field]')?.getAttribute('data-thermal-surface') ===
      'back',
  );
  assert.notEqual(
    await raster.getAttribute('href'),
    frontPaint,
    'Back surface displays its own real solver field.',
  );
  assert.equal(
    Number(await layout.locator('[data-thermal-hottest]').getAttribute('data-thermal-hottest')),
    report.surfaces.back.hottest.node,
  );
  assert.equal(
    await layout.getAttribute('viewBox'),
    viewWithField,
    'Surface switching retains the Layout camera.',
  );
  await screenshot('emc-flyback-layout-thermal-back.png');
  await surface.press('ArrowDown');
  await surface.press('Home');
  await surface.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-thermal-field]')?.getAttribute('data-thermal-surface') ===
      'front',
  );

  const probeButton = page.getByRole('button', { name: 'Probe Layout temperature', exact: true });
  await probeButton.click();
  const largestTriangle = front.triangles.reduce(
    (best, triangle) => {
      const [a, b, c] = triangle.map((node) => result.points[node]);
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      return area > best.area ? { triangle, area } : best;
    },
    { triangle: null, area: 0 },
  ).triangle;
  const target = largestTriangle
    .map((node) => result.points[node])
    .reduce((point, node) => ({ x: point.x + node.x / 3, y: point.y + node.y / 3 }), {
      x: 0,
      y: 0,
    });
  const screen = await layout.evaluate((svg, point) => {
    svg.addEventListener(
      'pointerup',
      (event) => {
        const local = svg.createSVGPoint();
        local.x = event.clientX;
        local.y = event.clientY;
        const actual = local.matrixTransform(svg.getScreenCTM().inverse());
        window.__actualThermalClick = { x: actual.x, y: actual.y };
      },
      { once: true },
    );
    const local = svg.createSVGPoint();
    local.x = point.x;
    local.y = point.y;
    const screen = local.matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, target);
  await page.mouse.click(screen.x, screen.y);
  await waitForAsync(
    page,
    async () => (await window.thermalWorkbenchHost().query('thermal.status')).probe,
  );
  const actualClick = await page.evaluate(() => window.__actualThermalClick);
  const expectedProbe = closestThermalNode(result, actualClick, 'front');
  const probed = await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'));
  assert.deepEqual(
    probed.probe,
    expectedProbe,
    'The actual Layout pointer reports the closest exact saved solver node and temperature.',
  );
  assert.equal(
    await layout.locator('[data-thermal-probe]').getAttribute('data-thermal-probe'),
    String(expectedProbe.node),
  );
  assert.ok((await legend.innerText()).includes(expectedProbe.temperatureC.toFixed(2)));
  assert.equal(
    await layout.getAttribute('viewBox'),
    viewWithField,
    'Probing retains the Layout camera.',
  );
  report.probe = {
    requested: target,
    actualClick,
    actual: probed.probe,
    verifiedAgainstSavedResult: true,
  };
  await screenshot('emc-flyback-layout-thermal-probe.png');
  const frontHotspot = report.surfaces.front.hottest;
  const highNode = front.indices.findLast((node) => node >= 150000);
  assert.ok(
    highNode !== undefined,
    'The actual EMC field exercises nodes above the former observation bound.',
  );
  const highProbe = { ...result.points[highNode], node: highNode };
  for (const [label, expected] of [
    ['surfaceHotspot', frontHotspot],
    ['largeIndex', highProbe],
  ]) {
    await page.evaluate(
      (point) =>
        window.thermalWorkbenchHost().execute('thermal.probe', { point }, { actor: 'human' }),
      { x: expected.x, y: expected.y, z: expected.z },
    );
    const state = await page.evaluate(() => window.thermalWorkbenchHost().query('workbench.state'));
    assert.deepEqual(
      state.thermal.probe,
      expected,
      `${label} reports exact real solver coordinates and temperature.`,
    );
    validateAgentWorkspaceContext(
      state,
      project.schematic.id,
      circuitFingerprint(project.schematic),
    );
    report.probe[label] = { ...expected, validatedFullWorkspaceContext: true };
  }
  await screenshot('emc-flyback-layout-thermal-large-node.png');
  assert.equal(
    await page.getByRole('button', { name: 'Export temperature map', exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.thermalWorkbenchHost().execute('thermal.exportImage'));
  await waitForAsync(page, () => !!document.querySelector('[data-thermal-probe]'));
  const exportDeadline = Date.now() + 45000;
  while (!nativeExports.length && Date.now() < exportDeadline) await page.waitForTimeout(100);
  assert.equal(
    nativeExports.length,
    1,
    'The real PNG exporter reaches the isolated native image boundary.',
  );
  report.exports = nativeExports;

  const visibility = page.getByRole('button', { name: 'Show temperature in Layout', exact: true });
  await visibility.click();
  await field.waitFor({ state: 'detached' });
  assert.equal(await layout.getAttribute('viewBox'), viewWithField);
  await visibility.click();
  await field.waitFor();
  assert.equal(await layout.getAttribute('viewBox'), viewWithField);
  const canvasBox = await layout.boundingBox();
  await layout.hover({ position: { x: canvasBox.width * 0.75, y: canvasBox.height * 0.75 } });
  await page.mouse.wheel(0, -140);
  await page.waitForFunction(
    (before) =>
      document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !== before,
    viewWithField,
  );
  const navigatedView = await layout.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.getByTestId('schematic-canvas').waitFor();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await field.waitFor();
  assert.equal(
    await layout.getAttribute('viewBox'),
    navigatedView,
    'Editor visits retain thermal result and camera.',
  );
  assert.equal(
    runs().length,
    restoreOnly ? 0 : 1,
    'Presentation changes do not start another solve.',
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);
  const layoutBox = await layout.boundingBox(),
    panelBox = await panel.boundingBox();
  assert.ok(layoutBox.width > 250 && panelBox.width >= 250);
  assert.ok(
    layoutBox.x + layoutBox.width <= panelBox.x + 1,
    'The dock remains beside the board at a compact desktop size.',
  );
  report.render.compact = { viewport: { width: 1280, height: 800 }, layoutBox, panelBox };
  await screenshot('emc-flyback-layout-thermal-compact.png');
  await runCanvasAction(page, 'Fit board to canvas');
  const fitted = await raster.boundingBox();
  assert.ok(
    fitted.x >= layoutBox.x - 1 &&
      fitted.y >= layoutBox.y - 1 &&
      fitted.x + fitted.width <= layoutBox.x + layoutBox.width + 1 &&
      fitted.y + fitted.height <= layoutBox.y + layoutBox.height + 1,
    'Fit retains the complete real temperature field within the compact Layout viewport.',
  );
  await screenshot('emc-flyback-layout-thermal-compact-fit.png');

  const after = await snapshotBaseline();
  assert.deepEqual(
    after,
    baseline,
    'Thermal configuration, actual solving, inspection, export and camera changes preserve native source, design, dirty state and undo history.',
  );
  for (const [file, expectedHash] of Object.entries(nativeHashes))
    assert.equal(
      hash(await readFile(path.join(nativeDirectory, file))),
      expectedHash,
      'Native design files remain byte-identical.',
    );
  // A second real HTTP lookup verifies native-store restoration without solving.
  const response = await fetch(`${server.base}/api/thermal/result`, {
    method: 'POST',
    headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, fileId, config: model.config }),
  });
  assert.equal(response.status, 200);
  const restored = await response.json();
  assert.deepEqual(restored.result, result);
  assert.deepEqual(restored.config, model.config);
  report.restoration = {
    authenticatedHttp: true,
    sameResult: true,
    sameConfig: true,
    noAdditionalSolve: true,
  };
  report.unchanged = { source: true, design: true, dirty: true, history: true, nativeBytes: true };
  assert.deepEqual(errors, [], 'The real EMC Layout presentation emits no browser runtime error.');
  report.passed = true;
  console.log(`Actual Thermal UI passed. Screenshots and report: ${directory}`);
} catch (error) {
  report.passed = false;
  report.failure = { message: error.message, stack: error.stack };
  if (page) {
    await screenshot('emc-flyback-thermal-failure.png').catch(() => {});
    report.failure.visibleText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
  }
  throw error;
} finally {
  report.elapsedMs = Date.now() - started;
  report.thermalRequests = thermalRequests;
  report.browserErrors = errors;
  report.screenshots = screenshots;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (!restoreOnly)
    await writeFile(
      path.join(directory, 'run-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  await browser?.close();
  server.close();
}
