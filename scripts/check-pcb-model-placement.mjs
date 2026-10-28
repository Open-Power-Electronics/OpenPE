import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

// Real bundled STEP models in an isolated renderer: no Electron, user data,
// provider, downloads or project writes. Exercise the runtime tessellator too.
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { parseSExpr } = await tsImport('../lib/sexpr.ts', import.meta.url);
const { flipPCBFootprint, padPosition } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const project = parseProject(
  await readFile('tests/fixtures/reference/lm2735-msop8-sepic.json', 'utf8'),
);
const models = new Map(),
  details = new Map();
for (const f of project.pcb.footprints) {
  if (details.has(f.libraryId)) continue;
  const [library, name] = f.libraryId.split(':');
  details.set(f.libraryId, {
    footprint: parseSExpr(
      await readFile(
        `resources/kicad/10.0.0/footprints/${library}.pretty/${name}.kicad_mod`,
        'utf8',
      ),
    ),
  });
  const bytes = await readFile(
    'examples/lm2735-msop8-sepic/' + f.models[0].path.replace('${KIPRJMOD}/', ''),
  );
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../server/step-worker.mjs', import.meta.url), {
      workerData: bytes,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('STEP conversion timed out.'));
    }, 45000);
    worker.once('message', (result) => {
      clearTimeout(timer);
      void worker.terminate();
      result.error ? reject(new Error(result.error)) : resolve(result);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
  });
  models.set(f.libraryId, result);
}
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
      import Preview from './components/PCBModelPreview';
      const root=createRoot(document.getElementById('root'));
      const schematic=${JSON.stringify(project.schematic)};
      window.preview=(board,key)=>{window.board=board;root.render(<Preview key={key} board={board} schematic={schematic}/>)};`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  plugins: [
    {
      name: 'inspect-rendered-scene',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const render = 'renderer?.render(scene, camera);';
          assert.ok(source.includes(render));
          return {
            contents: source.replace(render, `window.scene = scene; ${render}`),
            loader: 'tsx',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
  ],
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1124, height: 1077 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({ json: details.get(url.searchParams.get('id')) });
    if (url.pathname === '/api/library-model')
      return route.fulfill({ json: models.get(url.searchParams.get('id')) });
    return route.fulfill({
      contentType: 'text/html',
      body: '<div id="root" style="height:100vh"></div>',
    });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  let explicitImage;
  for (const scenario of ['explicit', 'fallback', 'back']) {
    const board = structuredClone(project.pcb);
    if (scenario !== 'explicit') board.footprints.forEach((f) => delete f.models);
    if (scenario === 'back') board.footprints = board.footprints.map(flipPCBFootprint);
    await page.evaluate(({ board, scenario }) => window.preview(board, scenario), {
      board,
      scenario,
    });
    await page.waitForFunction(
      () =>
        document.querySelector('.pcb-model-canvas canvas') &&
        !document.querySelector('.pcb-model-status') &&
        !document.querySelector('.pcb-model-notices'),
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    assert.deepEqual(
      await page.evaluate(() => window.board),
      board,
      'Viewing models preserves board data.',
    );
    const leads = await page.evaluate(() => {
      const componentGroup = window.scene.children[0].children.find((group) =>
        group.children.some((child) => child.userData.estimated),
      );
      const placed = componentGroup.children.filter((child) => !child.userData.estimated);
      window.scene.updateMatrixWorld(true);
      return window.board.footprints.flatMap((footprint, index) => {
        if (!footprint.libraryId.startsWith('Connector_')) return [];
        const model = placed[index];
        const vertices = [];
        model.traverse((mesh) => {
          if (!mesh.isMesh) return;
          const positions = mesh.geometry.attributes.position;
          let bottom = Infinity;
          for (let i = 0; i < positions.count; i++) bottom = Math.min(bottom, positions.getZ(i));
          for (let i = 0; i < positions.count; i++) {
            if (positions.getZ(i) > bottom + 0.15) continue;
            const v = mesh.position.clone().fromBufferAttribute(positions, i);
            const pin = footprint.libraryId.startsWith('Connector_JST:')
              ? v.x < 1
                ? '1'
                : '2'
              : v.y > -1
                ? '1'
                : '2';
            v.applyMatrix4(mesh.matrixWorld);
            vertices.push({ pin, x: v.x, y: -v.y });
          }
        });
        return ['1', '2'].map((pin) => {
          const points = vertices.filter((v) => v.pin === pin);
          return {
            id: footprint.id,
            pin,
            x: (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2,
            y: (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2,
          };
        });
      });
    });
    assert.equal(leads.length, 6);
    for (const lead of leads) {
      const footprint = board.footprints.find((f) => f.id === lead.id);
      const target = padPosition(
        footprint,
        footprint.pads.find((p) => p.number === lead.pin),
      );
      assert.ok(
        Math.hypot(lead.x - target.x, lead.y - target.y) < 0.05,
        `${scenario}: ${footprint.libraryId} pin ${lead.pin} must enter its hole.`,
      );
    }
    const screenshot = await page.locator('.pcb-model-canvas').screenshot({
      path: `test-results/pcb-model-placement-${scenario}.png`,
    });
    if (scenario === 'explicit') explicitImage = screenshot;
    if (scenario === 'fallback')
      assert.deepEqual(
        screenshot,
        explicitImage,
        'Verified fallback placement renders identically to the source model assignments.',
      );
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real JST/header STEP leads align with all six holes on front/back; fallback matches source placement and preserves board data.',
  );
} finally {
  await browser.close();
}
