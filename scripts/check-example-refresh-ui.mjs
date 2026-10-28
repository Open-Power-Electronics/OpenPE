import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import { parseProject, serializeProject, projectNativeFiles } from '../server/project-format.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readOriginalExamples } from './original-example-test-helpers.mjs';
import { readSource, readNativeFiles, fillNativeProject } from './source-editor-test-helpers.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';

// Reproduce stale disk/session examples without opening Electron or user files.
const entry = (await readOriginalExamples())[0];
const { source, filename } = entry;
const stale = parseProject(source);
for (const zone of stale.pcb.zones) delete zone.filledPolygons;
const staleSource = JSON.stringify(JSON.parse(serializeProject(stale)));
const currentNative = projectNativeFiles(parseProject(source), filename);
const staleNative = projectNativeFiles(stale, filename);
const draftNative = structuredClone(staleNative);
draftNative.files.find((file) => file.name === draftNative.entry).source = '{unfinished';
const currentId = '00000000-0000-5000-a000-000000000001';
const oldId = '00000000-0000-4000-8000-000000000002';
const secondId = '00000000-0000-4000-8000-000000000003';
const state = (id, changes = {}) => ({
  id,
  source: staleSource,
  sourceDraft: null,
  dirty: false,
  filename,
  exampleKey: entry.key,
  localExample: true,
  sessions: [{ id: `session-${id}`, messages: [], draft: 'Keep my conversation' }],
  activeSessionId: `session-${id}`,
  ...changes,
});
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import Workspace from './components/DesktopWorkspace';const root=createRoot(document.getElementById('root'));let epoch=0;const render=()=>root.render(<React.StrictMode><Workspace key={epoch}/></React.StrictMode>);window.remountWorkspace=()=>flushSync(()=>{epoch++;render();});render();",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/example-refresh-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  for (const scenario of [
    'clean',
    'duplicate',
    'dirty',
    'source-draft',
    'interrupted',
    'interrupted-failure',
    'failure',
  ]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let recovery = {
      version: 2,
      documents:
        scenario === 'duplicate'
          ? [state(oldId), state(secondId)]
          : [
              state(
                oldId,
                scenario === 'dirty'
                  ? { dirty: true }
                  : scenario === 'source-draft'
                    ? { sourceDraft: JSON.stringify(draftNative) }
                    : {},
              ),
            ],
      activeDocumentId: scenario === 'duplicate' ? secondId : oldId,
      provider: 'codex',
      effort: 'low',
      approvalMode: 'review',
      models: {},
    };
    let recoveryWrites = 0;
    await page.addInitScript(
      ({ source, currentId, key, scenario, filename }) => {
        window.exampleCalls = [];
        window.exampleSaves = [];
        window.liveGrants = [];
        let opening = false;
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
          newFile: async () => {
            const id = crypto.randomUUID();
            window.liveGrants.push(id);
            return id;
          },
          releaseFile: async (id) => {
            window.liveGrants = window.liveGrants.filter((grant) => grant !== id);
          },
          setDirty: async () => {},
          onCloseRequested: () => () => {},
          save: async (options) => {
            if (!window.liveGrants.includes(options.fileId))
              throw new Error('The file grant was released.');
            window.exampleSaves.push(options);
            return {
              name: options.saveAs ? 'personal.kicad_pro' : filename,
              localExample: !options.saveAs,
            };
          },
          openDefaultExample: async (requested) => {
            if (requested !== key) throw new Error('Unexpected example.');
            window.exampleCalls.push(requested);
            if (opening) throw new Error('This example is already opening.');
            opening = true;
            const first = window.exampleCalls.length === 1;
            try {
              if (scenario.startsWith('interrupted') && first)
                await new Promise((resolve) => {
                  window.resumeExampleOpen = resolve;
                });
              if (scenario === 'failure' || (scenario === 'interrupted-failure' && first))
                throw new Error('Fixture example preparation failure.');
              if (!window.liveGrants.includes('example-grant'))
                window.liveGrants.push('example-grant');
              return {
                id: currentId,
                source,
                fileId: 'example-grant',
                filename,
              };
            } finally {
              opening = false;
            }
          },
        };
      },
      { source, currentId, key: entry.key, scenario, filename },
    );
    await page.route('http://localhost/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') {
        if (route.request().method() === 'POST') {
          recoveryWrites++;
          recovery = route.request().postDataJSON();
        }
        return route.fulfill({ json: recovery });
      }
      if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
      if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
      if (url.pathname === '/api/models')
        return route.fulfill({ json: { models: [], defaultModel: '' } });
      if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
        return route.fulfill({
          contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          body: await readFile('public' + url.pathname),
        });
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.goto('http://localhost');
    for (const path of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(path, 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const button = (name) => page.getByRole('button', { name, exact: true });
    const projects = () => page.locator('.project-navigation:visible [data-project-id]');
    if (scenario.startsWith('interrupted')) {
      await page.waitForFunction(() => !!window.resumeExampleOpen);
      await page.evaluate(() => window.remountWorkspace());
      // Keep native I/O pending while replacement effects and mocked HTTP run.
      await page.waitForTimeout(150);
      await page.evaluate(() => window.resumeExampleOpen());
    }
    if (scenario === 'failure') {
      await page
        .getByText(
          'Fixture example preparation failure. The original recovery file was preserved.',
          { exact: true },
        )
        .waitFor();
      assert.equal(await projects().count(), 0);
      assert.equal(
        recoveryWrites,
        0,
        'Failed recovery must not overwrite the original saved draft.',
      );
      assert.deepEqual(await page.evaluate(() => window.liveGrants), []);
      assert.deepEqual(errors, [], scenario);
      await page.close();
      continue;
    }
    await projects().first().waitFor();
    if (scenario.startsWith('interrupted')) {
      assert.equal(await page.evaluate(() => window.exampleCalls.length), 2);
      assert.deepEqual(
        await page.evaluate(() => window.liveGrants),
        ['example-grant'],
        'Cancelled recovery cleanup finishes before replacement recovery receives its grant.',
      );
      assert.equal(await page.getByText(/original recovery file was preserved/).count(), 0);
    }
    await button('Source').click();
    if (scenario === 'clean' || scenario === 'duplicate' || scenario.startsWith('interrupted')) {
      assert.equal(
        await projects().count(),
        1,
        'Clean recovery entries reconnect to the original project.',
      );
      assert.equal(await projects().first().getAttribute('data-project-id'), currentId);
      assert.deepEqual(
        await readNativeFiles(page),
        currentNative,
        'Old recovery cannot hide saved copper polygons.',
      );
      await fileMenuAction(page, 'Save');
      await page.waitForFunction(() => window.exampleSaves.length === 1);
      const edited = parseProject(source);
      edited.schematic.title = 'Saved edited example';
      await fillNativeProject(page, edited);
      await fileMenuAction(page, 'Save');
      await page.waitForFunction(() => window.exampleSaves.length === 2);
      const saves = await page.evaluate(() => window.exampleSaves);
      assert.deepEqual(
        saves.map((save) => save.saveAs),
        [false, false],
      );
      assert.ok(saves.every((save) => save.fileId === 'example-grant'));
      assert.equal(parseProject(saves[1].source).schematic.title, edited.schematic.title);
      assert.ok(
        parseProject(saves[1].source).pcb.zones.some((zone) => zone.filledPolygons?.length),
      );
      await page.waitForFunction(
        () => document.querySelectorAll('.project-navigation .dirty-dot').length === 0,
      );
      await button('Layout').click();
      await page.getByTestId('layout-canvas').waitFor();
      assert.ok(
        await page
          .locator('[data-copper-zone]')
          .evaluateAll(
            (zones) => zones.length > 0 && zones.every((zone) => zone.getAttribute('d').length > 0),
          ),
      );
      await toggleLayoutVisualization(page, 'Visible layers');
      assert.equal(await page.getByRole('slider', { name: 'Copper opacity' }).count(), 0);
      await toggleLayoutVisualization(page, 'Visible layers');
      await button('Home').click();
      await button(`Open ${entry.name} example`).click();
      assert.equal(await projects().count(), 1);
      await fileMenuAction(page, 'Save as');
      await page.waitForFunction(() => window.exampleSaves.length === 3);
      assert.equal(await page.evaluate(() => window.exampleSaves[2].saveAs), true);
    } else {
      assert.equal(await page.evaluate(() => window.exampleCalls.length), 0);
      assert.notEqual(await projects().first().getAttribute('data-project-id'), currentId);
      const retainedSource = await readSource(page);
      if (scenario === 'source-draft') assert.equal(retainedSource, '{unfinished');
      else
        assert.deepEqual(
          await readNativeFiles(page),
          staleNative,
          'Recovered native edits remain intact.',
        );
      await button('Home').click();
      await button(`Open ${entry.name} example`).click();
      assert.equal(
        await projects().count(),
        2,
        'Personal recovered work survives beside the latest example.',
      );
      await button('Source').click();
      assert.deepEqual(await readNativeFiles(page), currentNative);
      await projects().first().click();
      assert.equal(await readSource(page), retainedSource);
    }
    assert.deepEqual(errors, [], scenario);
    await page.close();
  }
  console.log(
    'Latest example recovery: current copper, selection, duplicate removal, interrupted recovery, grant cleanup, failure preservation, direct Save, explicit Save as and unsaved Source preservation passed.',
  );
} finally {
  await browser.close();
}
