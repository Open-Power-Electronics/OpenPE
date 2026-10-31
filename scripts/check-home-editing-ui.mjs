import { modelReferenceKey } from '../server/library-format.mjs';
import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { prepareExampleFootprints } from '../server/example-footprints.mjs';
import { prepareProjectModelFiles } from '../server/project-model-files.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';
import { readNativeFiles } from './source-editor-test-helpers.mjs';

// Actual current Home projects in DesktopWorkspace, Core and native Source.
// The native picker only grants fresh test destinations. Save, pinned asset
// preparation and fresh reopening use the real host ports; no Electron, user
// destination, provider, solver, downloaded asset or mocked Save is involved.
const home = JSON.parse(await readFile('resources/example-catalog/home-manifest.json', 'utf8'));
const entries = home.examples;
assert.equal(
  entries.length,
  9,
  'This matrix covers precisely the current nine Home Boost projects.',
);
assert.equal(new Set(entries.map((entry) => entry.id)).size, 9);
assert.ok(entries.every((entry) => entry.id.startsWith('reference-')));
assert.ok(entries.some((entry) => entry.id === 'reference-lm27761-wson8-pump'));
const footprintManifest = JSON.parse(
  await readFile('resources/example-catalog/footprints/manifest.json', 'utf8'),
);
const footprintPackages = new Map(footprintManifest.footprints.map((entry) => [entry.id, entry]));
const { parseProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { defaultAgentPreferences, restoreWorkspace } = await tsImport(
  '../lib/workspace-state.ts',
  import.meta.url,
);
const { projectNativeFiles, projectFromNativeFiles } = await tsImport(
  '../lib/kicad-project.ts',
  import.meta.url,
);
const { displayPartValue } = await tsImport('../lib/library.ts', import.meta.url);
const { parseSExpr, child, children, val } = await tsImport('../lib/sexpr.ts', import.meta.url);
const { participatesInSimulation } = await tsImport(
  '../lib/simulation-participation.ts',
  import.meta.url,
);
const require = createRequire(import.meta.url);
const { createNativeSave } = require('../electron/native-save.cjs');
const { FileGrants } = require('../electron/file-grants.cjs');
const { createProjectDirectoryReader } = require('../electron/project-directory.cjs');
const { readNativeProject: readNativeProjectFile } = require('../electron/native-project.cjs');
const sources = Object.fromEntries(
  await Promise.all(
    entries.map(async (entry) => [
      entry.id,
      serializeProject(
        projectFromNativeFiles(
          await readNativeProjectFile(
            path.resolve('examples', entry.file, `${entry.file}.kicad_pro`),
          ),
        ),
      ),
    ]),
  ),
);
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react';import{createRoot}from'react-dom/client';import Workspace from './components/DesktopWorkspace';createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/home-editing/bundle',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
await mkdir('test-results/home-editing', { recursive: true });
const byName = (bundle) => ({
  ...bundle,
  files: [...bundle.files].sort((a, b) => a.name.localeCompare(b.name)),
});
const nativeText = (name, bytes) => ({
  name,
  source: bytes.toString(isUtf8(bytes) ? 'utf8' : 'latin1'),
  ...(!isUtf8(bytes) ? { encoding: 'latin1' } : {}),
});
async function preparedNativeAssets(project) {
  const files = [];
  const pinnedText = async (name, sourceFile, sha256) => {
    const bytes = await readFile(sourceFile);
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, name);
    files.push(nativeText(name, bytes));
  };
  for (const model of project.simulationModels ?? [])
    await pinnedText(
      model.file,
      path.resolve(
        'resources/example-catalog/simulation/models',
        `${model.id}-${model.sha256}.lib`,
      ),
      model.sha256,
    );
  // Match the host's bounded, assigned example packages, retaining their order.
  // STEP assets and notices are not editable native text files.
  const used = [
    ...new Set(
      (project.pcb?.footprints ?? [])
        .filter((footprint) =>
          footprint.models?.some((model) =>
            footprintPackages
              .get(footprint.libraryId)
              ?.models.some(
                (relative) => modelReferenceKey(model.path) === modelReferenceKey(relative),
              ),
          ),
        )
        .map((footprint) => footprint.libraryId),
    ),
  ].map((id) => footprintPackages.get(id));
  for (const entry of used.filter(
    (entry) =>
      entry.file &&
      !project.nativeFiles?.files.some((file) =>
        file.name.endsWith('/' + path.basename(entry.file)),
      ),
  ))
    await pinnedText(
      'footprints/' + entry.file,
      path.resolve('resources/example-catalog/footprints', entry.file),
      entry.sha256,
    );
  const libraries = [
    ...new Set(used.filter((entry) => entry.file).map((entry) => entry.id.split(':')[0])),
  ];
  if (
    libraries.length &&
    !project.nativeFiles?.files.some((file) => file.name === 'fp-lib-table')
  ) {
    const table =
      '(fp_lib_table\n  (version 7)\n' +
      libraries
        .map(
          (library) =>
            `  (lib (name ${JSON.stringify(library)})(type "KiCad")(uri "\${KIPRJMOD}/footprints/${library}.pretty")(options "")(descr "Reference source package"))\n`,
        )
        .join('') +
      ')\n';
    files.push(nativeText('fp-lib-table', Buffer.from(table)));
  }
  return files;
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Home editing must use pinned offline resources.');
};
let browser;
let completed = 0;
try {
  browser = await chromium.launch({
    headless: true,
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  });
  for (const entry of entries) {
    assert.equal(
      typeof sources[entry.id],
      'string',
      `${entry.title}: the actual Home source exists.`,
    );
    assert.match(entry.file, /^[a-z0-9-]+$/);
    const fileGrants = new FileGrants();
    const directoryReader = createProjectDirectoryReader(fileGrants);
    const nativeDirectory = await mkdtemp(path.resolve('test-results/home-editing/native-'));
    const nativeFile = path.join(nativeDirectory, entry.file + '.kicad_pro');
    // This fixed manifest path is a read-only source of pinned model bytes. It
    // is never granted as the renderer's destination or passed to the picker.
    const modelSource = path.resolve('examples', entry.file, entry.file + '.kicad_pro');
    let saves = 0;
    const nativeSave = createNativeSave({
      parseProject,
      projectNativeFiles,
      fileGrants,
      dataDir: nativeDirectory,
      atomicWrite,
      showSaveDialog: async () => ({ canceled: false, filePath: nativeFile }),
      prepareProjectFiles: async (project, destination, sourceFile) => {
        await prepareExampleFootprints(project, destination);
        await prepareProjectModelFiles(
          project,
          destination,
          sourceFile ?? modelSource,
          async () => {
            throw new Error('A missing pinned Home model cannot be downloaded by this test.');
          },
          new AbortController().signal,
        );
      },
    });
    const documentId = crypto.randomUUID();
    let recovery = restoreWorkspace({
      ...defaultAgentPreferences,
      version: 2,
      documents: [
        {
          id: documentId,
          source: sources[entry.id],
          sourceDraft: null,
          dirty: false,
          filename: entry.file + '.kicad_pro',
          exampleKey: null,
          localExample: false,
          sessions: [{ id: 'home-editing', messages: [], draft: '' }],
          activeSessionId: 'home-editing',
        },
      ],
      activeDocumentId: documentId,
    });
    let ignoreRecoveryWrites = false;
    const page = await browser.newPage({ viewport: { width: 1520, height: 980 } });
    page.setDefaultTimeout(25000);
    const errors = [];
    const unexpectedRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.exposeFunction('homeEditingNewFile', () => fileGrants.create());
      await page.exposeFunction('homeEditingReleaseFile', (id) => fileGrants.release(id));
      await page.exposeFunction('homeEditingDirectory', (id) => directoryReader.list(id));
      await page.exposeFunction('homeEditingFilePreview', (id, entryId) =>
        directoryReader.read(id, entryId),
      );
      await page.exposeFunction('homeEditingAcceptOpen', () => fileGrants.create(nativeFile));
      await page.exposeFunction('homeEditingOpen', async () => ({
        source: serializeProject(projectFromNativeFiles(await readNativeProjectFile(nativeFile))),
        name: path.basename(nativeFile),
        native: true,
      }));
      await page.exposeFunction('homeEditingSave', async (options) => {
        const result = await nativeSave(options);
        saves++;
        return result;
      });
      await page.addInitScript(() => {
        window.homeEditingSaveCount = 0;
        window.homeEditingDirtyWrites = [];
        window.openpe = {
          titleBarOverlay: true,
          writeWorkspaceRecovery: async (content) => {
            await fetch('http://localhost/api/state', {
              method: content === null ? 'DELETE' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: content ?? undefined,
            });
          },
          connection: async () => ({ base: 'http://localhost', token: 'home-editing' }),
          newFile: () => window.homeEditingNewFile(),
          releaseFile: (id) => window.homeEditingReleaseFile(id),
          projectDirectory: (id) => window.homeEditingDirectory(id),
          projectFilePreview: ({ fileId, id }) => window.homeEditingFilePreview(fileId, id),
          open: () => window.homeEditingOpen(),
          acceptOpen: () => window.homeEditingAcceptOpen(),
          save: async (options) => {
            const result = await window.homeEditingSave(options);
            window.homeEditingSaveCount++;
            return result;
          },
          setDirty: async (value) => window.homeEditingDirtyWrites.push(Boolean(value)),
          onCloseRequested: () => () => {},
        };
      });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://localhost') {
          unexpectedRequests.push(url.href);
          return route.abort();
        }
        if (url.pathname === '/api/state') {
          if (route.request().method() === 'POST' && !ignoreRecoveryWrites)
            recovery = route.request().postDataJSON();
          return route.fulfill({ json: recovery });
        }
        if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
        if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
        if (url.pathname === '/api/models')
          return route.fulfill({ json: { models: [], defaultModel: '' } });
        if (url.pathname === '/api/workbench-plugins')
          return route.fulfill({ json: bundledWorkbenchCatalog() });
        if (url.pathname === '/api/simulation/status')
          return route.fulfill({ json: { available: false } });
        if (url.pathname === '/api/simulation/result')
          return route.fulfill({ json: { result: null } });
        if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
          return route.fulfill({
            contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
            body: await readFile('public' + url.pathname),
          });
        if (url.pathname.startsWith('/api/')) {
          unexpectedRequests.push(url.pathname);
          return route.fulfill({
            status: 422,
            json: { error: 'Unexpected Home editing service request.' },
          });
        }
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      });
      const mount = async () => {
        await page.goto('http://localhost');
        for (const content of styles) await page.addStyleTag({ content });
        for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
          await page.addStyleTag({ content: output.text });
        await page.addScriptTag({
          content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
        });
      };
      const button = (name) => page.getByRole('button', { name, exact: true });
      const schematic = page.getByTestId('schematic-canvas');
      const layout = page.getByTestId('layout-canvas');
      const native = async () => {
        await button('Source').click();
        return readNativeFiles(page);
      };
      const clean = async () => {
        assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
        assert.equal(await page.evaluate(() => window.homeEditingDirtyWrites.at(-1)), false);
      };
      const editValue = async (reference, value) => {
        await button('Schematic').click();
        await button('Parts list').click();
        const panel = page.getByRole('dialog', { name: 'Parts list', exact: true });
        await panel.getByRole('textbox', { name: 'Search parts', exact: true }).fill(reference);
        await panel.getByRole('button', { name: 'Edit ' + reference, exact: true }).click();
        const field = page
          .getByRole('complementary', { name: 'Object properties', exact: true })
          .getByRole('textbox', { name: 'Component value', exact: true });
        await field.fill(value);
        await field.press('Enter');
        await page.waitForFunction(() => document.querySelector('.project-navigation .dirty-dot'));
      };
      await mount();
      await schematic.waitFor();
      await page.waitForFunction(() => window.homeEditingDirtyWrites.length > 0);
      const original = await native();
      const baseline = projectFromNativeFiles(original);
      const part = baseline.schematic.parts.find(
        (part) =>
          /^R\d/.test(part.ref) &&
          baseline.pcb.footprints.some((footprint) => footprint.symbolId === part.id),
      );
      assert.ok(part, `${entry.title}: a real resistor has a linked PCB footprint.`);
      const footprint = baseline.pcb.footprints.find((footprint) => footprint.symbolId === part.id);
      const nextValue = displayPartValue(part) === '22k' ? '33k' : '22k';
      await clean();

      await editValue(part.ref, nextValue);
      const changedValueFiles = await native();
      const changedValue = projectFromNativeFiles(changedValueFiles);
      assert.equal(changedValue.schematic.id, baseline.schematic.id);
      assert.equal(
        displayPartValue(changedValue.schematic.parts.find((item) => item.id === part.id)),
        nextValue,
      );
      const changedBoard = parseSExpr(
        changedValueFiles.files.find((file) => file.name.endsWith('.kicad_pcb')).source,
      );
      const nativeFootprint = children(changedBoard, 'footprint').find(
        (node) => val(child(node, 'uuid')) === footprint.id,
      );
      assert.ok(nativeFootprint, 'Value editing retains the native footprint UUID.');
      assert.equal(
        val(
          children(nativeFootprint, 'property').find((node) => val(node) === 'Value'),
          2,
        ),
        nextValue,
        'The native PCB caption follows the edited Value without renaming copper nets.',
      );
      assert.deepEqual(changedValue.pcb.tracks, baseline.pcb.tracks);
      assert.deepEqual(changedValue.pcb.vias, baseline.pcb.vias);
      assert.deepEqual(changedValue.pcb.zones, baseline.pcb.zones);
      await button('Layout').click();
      await layout.waitFor({ state: 'visible' });
      assert.equal(await button('Undo').isEnabled(), true);
      await button('Undo').click();
      assert.equal(
        await button('Undo').isDisabled(),
        true,
        'One Undo restores the complete Value edit.',
      );
      assert.deepEqual(
        await native(),
        original,
        `${entry.title}: SCH undo restores every native byte.`,
      );
      await clean();

      await button('Layout').click();
      await layout.waitFor({ state: 'visible' });
      const referenceLayer =
        footprint.graphics.find((graphic) => graphic.text?.property === 'Reference')?.layer ??
        (footprint.side === 'front' ? 'F.SilkS' : 'B.SilkS');
      await layout
        .locator(`[data-footprint-captions="${footprint.id}"]`)
        .locator(`text[data-pcb-layer="${referenceLayer}"]`)
        .getByText(part.ref, { exact: true })
        .hover();
      await layout.focus();
      await page.keyboard.press('e');
      const inspector = page.getByRole('complementary', { name: 'Layout properties', exact: true });
      await inspector.waitFor({ state: 'visible' });
      assert.equal(
        await inspector
          .getByRole('textbox', { name: 'Component reference', exact: true })
          .inputValue(),
        part.ref,
      );
      const x = inspector.getByRole('spinbutton', { name: 'X (mm)', exact: true });
      assert.equal(Number(await x.inputValue()), footprint.x);
      const targetX = Math.floor(footprint.x) + 2;
      await x.fill(String(targetX));
      await x.press('Enter');
      assert.equal(Number(await x.inputValue()), targetX);
      const movedFiles = await native();
      const moved = projectFromNativeFiles(movedFiles);
      const placed = moved.pcb.footprints.find((item) => item.id === footprint.id);
      assert.equal(placed.x, targetX);
      assert.equal(placed.y, footprint.y);
      assert.equal(placed.rotation, footprint.rotation);
      assert.equal(placed.side, footprint.side);
      assert.deepEqual(moved.pcb.tracks, baseline.pcb.tracks);
      assert.deepEqual(moved.pcb.vias, baseline.pcb.vias);
      assert.deepEqual(moved.pcb.nets, baseline.pcb.nets);
      assert.deepEqual(
        movedFiles.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
        original.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
        'Footprint pose editing retains the exact schematic and project files.',
      );
      await button('Schematic').click();
      await button('Undo').click();
      assert.equal(
        await button('Undo').isDisabled(),
        true,
        'One cross-view Undo restores the footprint edit.',
      );
      assert.deepEqual(
        await native(),
        original,
        `${entry.title}: Layout undo restores every native byte.`,
      );
      await clean();

      await editValue(part.ref, nextValue);
      const saveNative = async (count) => {
        const beforeSave = await native();
        await button('Schematic').click();
        await schematic.focus();
        await page.keyboard.press('ControlOrMeta+s');
        await page.waitForFunction((count) => window.homeEditingSaveCount === count, count);
        await page.waitForFunction(() => !document.querySelector('.project-navigation .dirty-dot'));
        assert.equal(saves, count, 'Each public Save reaches the real native writer once.');
        const saved = await native();
        assert.deepEqual(
          byName(saved),
          byName(beforeSave),
          'Saving retains the displayed native files exactly.',
        );
        const disk = await readNativeProjectFile(nativeFile);
        const expectedDisk = new Map(saved.files.map((file) => [file.name, file]));
        for (const file of await preparedNativeAssets(parseProject(sources[entry.id]))) {
          if (expectedDisk.has(file.name)) assert.deepEqual(expectedDisk.get(file.name), file);
          else expectedDisk.set(file.name, file);
        }
        for (const file of disk.files) {
          const expected = expectedDisk.get(file.name);
          if (!expected || file.source === expected.source) continue;
          let offset = 0;
          while (offset < file.source.length && file.source[offset] === expected.source[offset])
            offset++;
          console.log('Native Save mismatch', {
            project: entry.title,
            file: file.name,
            offset,
            disk: file.source.slice(Math.max(0, offset - 60), offset + 180),
            source: expected.source.slice(Math.max(0, offset - 60), offset + 180),
          });
        }
        assert.deepEqual(
          byName(disk),
          byName({ entry: saved.entry, files: [...expectedDisk.values()] }),
          'Disk retains Source bytes and only the declared, verified supporting assets.',
        );
        await clean();
        return disk;
      };
      let disk = await saveNative(1);
      if (entry.id === 'reference-lm2596-to220-5-buck') {
        for (const [index, included] of [false, true].entries()) {
          await button('Schematic').click();
          await button('SPICE Simulation').click();
          const toggle = page.getByRole('switch', {
            name: 'Include ' + part.ref + ' in SPICE simulation',
            exact: true,
          });
          assert.equal(await toggle.getAttribute('aria-checked'), String(!included));
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-checked'), String(included));
          const changed = projectFromNativeFiles(await native());
          assert.equal(
            participatesInSimulation(changed.schematic.parts.find((item) => item.id === part.id)),
            included,
          );
          assert.deepEqual(changed.pcb.nets, baseline.pcb.nets);
          disk = await saveNative(index + 2);
        }
        console.log(
          'LM2596 Buck: excluding and restoring simulation participation retain exact Source/disk bytes.',
        );
      }

      ignoreRecoveryWrites = true;
      recovery = null;
      // Main-frame replacement revokes old opaque grants; reopening obtains a
      // fresh grant for the files written above, with recovery disconnected.
      fileGrants.clear();
      await mount();
      await button('Open project').click();
      await schematic.waitFor({ state: 'visible' });
      const reopenedFiles = await native();
      assert.deepEqual(
        byName(reopenedFiles),
        byName(disk),
        'Fresh Open reads the exact saved disk files.',
      );
      const reopened = projectFromNativeFiles(reopenedFiles);
      assert.equal(
        displayPartValue(reopened.schematic.parts.find((item) => item.id === part.id)),
        nextValue,
      );
      if (entry.id === 'reference-lm2596-to220-5-buck')
        assert.equal(
          participatesInSimulation(reopened.schematic.parts.find((item) => item.id === part.id)),
          true,
        );
      await clean();
      assert.deepEqual(
        unexpectedRequests,
        [],
        `${entry.title}: no missing resources or network requests.`,
      );
      assert.deepEqual(errors, [], `${entry.title}: no renderer errors.`);
      completed++;
      console.log(
        `${entry.title}: SCH Value and Layout footprint edits, cross-view Undo, exact native Save and fresh disk Open passed.`,
      );
    } catch (error) {
      console.error({
        project: entry.title,
        errors,
        unexpectedRequests,
        visibleText: (await page.locator('body').innerText()).slice(0, 4000),
      });
      throw error;
    } finally {
      await page.close();
      fileGrants.clear();
    }
  }
  assert.equal(completed, 9);
  console.log(
    JSON.stringify({
      workflow: 'Current Home Boost editing',
      projects: completed,
      ids: entries.map((entry) => entry.id),
      nativeSave: 'real writer',
      reopen: 'fresh workspace without recovery',
    }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
