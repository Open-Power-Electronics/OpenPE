import { modelReferenceKey, resolveExampleModelRelative } from '../server/library-format.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nativeProject from '../electron/native-project.cjs';
import { createLibraryService } from '../server/libraries.mjs';

const manifest = JSON.parse(
  await readFile('resources/example-catalog/footprints/manifest.json', 'utf8'),
);
const emcManifest = JSON.parse(
  await readFile('resources/example-catalog/emc-flyback-assets.json', 'utf8'),
);
// Real service and bounded STEP workers. No desktop, provider or downloads.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Example 3D models must load offline.');
};
const service = createLibraryService({ dataDir: '.openpe/reference-model-check' });
const results = new Map();
const details = new Map(),
  renderedModels = new Map();
const key = modelReferenceKey;
try {
  for (const entry of manifest.footprints) {
    const detail = await service.request({ action: 'detail', kind: 'footprints', id: entry.id });
    assert.equal(detail.error, undefined);
    details.set(entry.id, detail);
    const models = detail.models;
    for (const relative of entry.models) {
      const index = models.findIndex((model) => key(model.path) === key(relative));
      assert.ok(index >= 0, `${entry.id}: missing linked model ${relative}`);
      const result = await service.model(entry.id, index);
      assert.ok(result.meshes.length, `${entry.id}: empty model`);
      for (const mesh of result.meshes) {
        assert.ok(mesh.index.array.length > 0);
        assert.ok(mesh.attributes.position.array.every(Number.isFinite));
      }
      results.set(relative, result);
      renderedModels.set(`${entry.id}:${index}`, result);
      console.log(`${entry.id}: ${result.meshes.length} real STEP meshes, offline`);
    }
  }
  assert.equal(results.size, 46);
  console.log('Reference: 46/46 models available and tessellated offline.');
  const emcResults = new Map();
  for (const entry of emcManifest.footprints) {
    const detail = await service.request({ action: 'detail', kind: 'footprints', id: entry.id });
    details.set(entry.id, detail);
    for (const model of entry.models) {
      const relative = resolveExampleModelRelative(Object.keys(emcManifest.models), model.path);
      const index = detail.models.findIndex((candidate) => key(candidate.path) === key(relative));
      assert.ok(index >= 0, `${entry.id}: missing linked model ${relative}`);
      const requestKey = `${entry.id}:${index}`;
      assert.ok(!emcManifest.models[relative].missing, `${relative}: model bytes must be pinned`);
      const result = emcResults.get(relative) ?? (await service.model(entry.id, index));
      assert.ok(result.meshes.length, `${entry.id}: empty model`);
      for (const mesh of result.meshes) {
        assert.ok(mesh.index.array.length > 0);
        assert.ok(mesh.attributes.position.array.every(Number.isFinite));
      }
      emcResults.set(relative, result);
      renderedModels.set(requestKey, result);
      console.log(`${entry.id}: ${result.meshes.length} real STEP meshes, offline`);
    }
  }
  assert.equal(emcResults.size, 31);
  console.log('EMC Flyback: 31/31 models available and tessellated offline.');
  if (process.argv.includes('--render')) {
    const { build } = await import('esbuild');
    const { chromium } = await import('playwright');
    const { mkdir } = await import('node:fs/promises');
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import Preview from './components/PCBModelPreview';
                import {modelCadFromProject} from './lib/model-cad';
        const root=createRoot(document.getElementById('root'));
        window.preview=(project,key)=>{window.project=project;root.render(<Preview key={key} board={project.pcb} schematic={project.schematic} modelCad={modelCadFromProject(project)}/>)};`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: 'test-results/reference-object/models.js',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'inspect-loaded-models',
          setup(plugin) {
            plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async (args) => {
              const source = await readFile(args.path, 'utf8');
              const marker = 'const scene = new THREE.Scene();';
              assert.equal(source.split(marker).length, 2);
              return {
                contents: source.replace(marker, `${marker} window.modelScene=scene;`),
                loader: 'tsx',
                resolveDir: path.dirname(args.path),
              };
            });
          },
        },
      ],
    });
    // Restore Node fetch before launching Playwright. Browser traffic is fully mocked.
    globalThis.fetch = originalFetch;
    const browser = await chromium.launch({
      headless: true,
      channel:
        process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
      });
      await page.route('http://localhost/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/libraries/footprints')
          return route.fulfill({ json: details.get(url.searchParams.get('id')) });
        if (url.pathname === '/api/library-model') {
          const requestKey = `${url.searchParams.get('id')}:${url.searchParams.get('index')}`;
          assert.ok(renderedModels.has(requestKey), `Unexpected model request: ${requestKey}`);
          return route.fulfill({
            json: renderedModels.get(requestKey),
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: '<div id="root" style="height:100vh"></div>',
        });
      });
      await page.goto('http://localhost');
      for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
        await page.addStyleTag({ content: await readFile(file, 'utf8') });
      for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
        await page.addStyleTag({ content: file.text });
      await page.addScriptTag({
        content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
      });
      const { projectFromNativeFiles, serializeProject } =
        await import('../server/project-format.mjs');
      const projects = JSON.parse(
        await readFile('resources/example-catalog/home-manifest.json', 'utf8'),
      );
      const catalog = [...projects.recent, ...projects.examples];
      assert.equal(catalog.length, 10);
      assert.equal(new Set(catalog.map((entry) => entry.id)).size, 10);
      await mkdir('test-results/reference-object', { recursive: true });
      for (const entry of catalog) {
        const project = projectFromNativeFiles(
          await nativeProject.readNativeProject(
            path.resolve('examples', entry.file, `${entry.file}.kicad_pro`),
          ),
        );
        const source = serializeProject(project);
        const expectedNotices = [],
          expectedInstances = [];
        for (const footprint of project.pcb.footprints) {
          const detail = details.get(footprint.libraryId);
          assert.ok(detail, `${footprint.libraryId}: missing checked footprint detail`);
          const assigned = footprint.models ?? detail.models;
          const name = footprint.reference || footprint.libraryId;
          if (!assigned.length) expectedNotices.push(`${name}: no 3D model is assigned.`);
          for (const model of assigned) {
            if (model.hidden) continue;
            const index = detail.models.findIndex(
              (candidate) => key(candidate.path) === key(model.path),
            );
            const requestKey = `${footprint.libraryId}:${index}`;
            assert.ok(index >= 0, `${name}: missing model link`);
            assert.ok(renderedModels.has(requestKey), `${name}: missing converted model`);
            expectedInstances.push(footprint.id);
          }
        }
        if (entry.id === 'emc-flyback-demo') {
          assert.equal(expectedInstances.length, 83);
          assert.equal(expectedNotices.length, 5);
        } else assert.deepEqual(expectedNotices, []);
        await page.evaluate(({ project, key }) => window.preview(project, key), {
          project,
          key: entry.id,
        });
        await page.waitForFunction(
          () =>
            document.querySelector('.pcb-model-canvas canvas') &&
            !document.querySelector('.pcb-model-status'),
          undefined,
          { timeout: 30000 },
        );
        assert.deepEqual(
          (await page.locator('.pcb-model-notices li').allTextContents()).sort(),
          expectedNotices.sort(),
          `${entry.title}: only known model omissions may remain.`,
        );
        const loaded = await page.evaluate(() => {
          const instances = [];
          window.modelScene.traverse((object) => {
            if (object.isGroup && object.userData.footprintId)
              instances.push(object.userData.footprintId);
          });
          return instances.sort();
        });
        assert.deepEqual(
          loaded,
          expectedInstances.sort(),
          `${entry.title}: every available assigned model reaches the scene.`,
        );
        assert.equal(
          serializeProject(await page.evaluate(() => window.project)),
          source,
          'Model preserves design bytes.',
        );
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `test-results/reference-object/${entry.id}.png` });
        console.log(
          `${entry.title}: ${loaded.length} real model instances, ${expectedNotices.length} known model notices.`,
        );
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  service.close();
  globalThis.fetch = originalFetch;
}
