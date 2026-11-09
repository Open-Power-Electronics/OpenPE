import { parseProject, projectNativeFiles } from '../server/project-format.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { readSource } from './source-editor-test-helpers.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const aboutOnly = process.argv.includes('--about-only');
const licensePaths = new Set([
  ...[
    'kicad-libraries',
    'kicad-demos/NOTICE',
    'kicad-demos/LICENSE',
    'reference/NOTICE',
    'emc-flyback/NOTICE',
    'emc-flyback/LICENSE',
    'ti-models',
    'example-models',
    'ngspice',
    'thermal',
    'ai-pcb-layout',
    'occt-import-js',
    'pdf-reader',
    'opencascade',
    'three',
    'three-gpu-pathtracer',
    'glsl-smart-denoise',
    'three-mesh-bvh',
    'xatlas-web',
    'vscode-codicons',
    'kicad-icons',
    'clipper',
    'newstroke',
  ].map((name) => `/licenses/${name}.txt`),
  '/agents/README.txt',
  '/agents/LICENSE-deepseek',
  '/agents/LICENSE-pi',
]);
const licenseRequests = [];
const licenseBodies = new Map();

const manifest = JSON.parse(await readFile('resources/example-catalog/home-manifest.json', 'utf8'));
const catalog = [...manifest.recent, ...manifest.examples];
const exampleSources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
exampleSources['emc-flyback-demo'] = await readFile('lib/emc-flyback-example.json', 'utf8');
assert.equal(manifest.examples.length, 9);
assert.deepEqual(
  manifest.recent.map((entry) => entry.id),
  ['emc-flyback-demo'],
);
assert.equal(manifest.examples[0].id, 'reference-lm2596-to220-5-buck');
assert.ok(manifest.examples.some((entry) => entry.id === 'reference-lm27761-wson8-pump'));

// Isolated renderer only: no desktop, native files, providers or solver are launched.
await mkdir('test-results', { recursive: true });
const bundle = await build({
  stdin: {
    contents: aboutOnly
      ? "import React,{useState} from 'react';import{createRoot}from'react-dom/client';import AboutDialog from './components/AboutDialog';function Fixture(){const[open,setOpen]=useState(false);return <main><button onClick={()=>setOpen(true)}>Open About</button>{open&&<AboutDialog onClose={()=>setOpen(false)}/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);"
      : "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/brand-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  const errors = [];
  let agentRequests = 0,
    footprintRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript((sources) => {
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
      openDefaultExample: async (key) => {
        const source = sources[key.replace(/^example:/, '')];
        if (!source) throw new Error('Unknown Home fixture.');
        return {
          id: JSON.parse(source).project.id,
          source,
          fileId: crypto.randomUUID(),
          filename: 'project.kicad_pro',
        };
      },
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  }, exampleSources);
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/agent-settings') return route.fulfill({json:{followUpMode:'queue'}});
    if (licensePaths.has(url.pathname)) {
      licenseRequests.push(url.pathname);
      const body = await readFile('public' + url.pathname, 'utf8');
      licenseBodies.set(url.pathname, body);
      return route.fulfill({ contentType: 'text/plain', body });
    }
    if (url.pathname === '/api/state' || url.pathname === '/api/appearance')
      return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/libraries/footprints') {
      footprintRequests++;
      return route.fulfill({
        status: 422,
        json: { error: 'Loaded examples must use their embedded footprints.' },
      });
    }
    if (url.pathname === '/api/chat') {
      agentRequests++;
      return route.fulfill({ status: 500, body: 'Unexpected provider request' });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/layout-editor.css', 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  if (aboutOnly) {
    await checkAbout(page, errors);
  } else {
    const home = page.getByRole('region', { name: 'Welcome to OpenPE', exact: true });
    await home
      .getByRole('heading', { name: 'What will you Power next, Engineer?', exact: true })
      .waitFor();
    const recent = home.getByRole('region', { name: 'Recent', exact: true });
    const examples = home.getByRole('region', { name: 'Example', exact: true });
    assert.equal(await recent.locator('.home-example').count(), 1);
    assert.equal(
      await recent.locator('.home-example').getAttribute('aria-label'),
      'Open EMC Flyback example',
    );
    assert.deepEqual(
      await examples.locator('.home-example h3').allTextContents(),
      manifest.examples.map((entry) => entry.title),
    );
    await page.waitForFunction(
      () => document.querySelectorAll('.home-example-preview svg').length === 10,
    );
    assert.equal(await page.getByTestId('schematic-canvas').count(), 0);
    assert.equal(await home.locator('.home-example').count(), 10);
    assert.equal(await home.locator('.home-brand').innerText(), 'OpenPE');
    await page.waitForFunction(() =>
      [...document.images].every((img) => img.complete && img.naturalWidth > 0),
    );
    assert.equal(await home.locator('.home-hero-backdrop').getAttribute('aria-hidden'), 'true');

    // Both OS and explicit reduced motion keep the decorative pulse still.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const animation = () =>
      page.locator('.home-signal-current').evaluate((el) => getComputedStyle(el).animationName);
    assert.equal(await animation(), 'none');
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'full';
    });
    assert.equal(await animation(), 'home-signal-flow');
    await page.evaluate(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    assert.equal(await animation(), 'none');
    await page.screenshot({ path: 'test-results/openpe-home-light.png' });
    console.log('Reference Home light preview check passed.');
    const button = (name) => page.getByRole('button', { name, exact: true });
    async function theme(name) {
      await button('Settings').click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await dialog
        .getByRole('radiogroup', { name: 'Theme', exact: true })
        .getByRole('radio', { name, exact: true })
        .check();
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await theme('Dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: 'test-results/openpe-home-dark.png' });
    if (process.argv.includes('--update-readme-screenshot'))
      await page.screenshot({
        path: 'assets/home.png',
        clip: { x: 0, y: 0, width: 1440, height: 480 },
      });
    console.log('Reference Home dark preview check passed.');

    await page.setViewportSize({ width: 1100, height: 740 });
    await theme('Light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const composer = await home.locator('.home-composer').boundingBox();
    assert.ok(
      composer.x >= 52 && composer.x + composer.width <= 1100 && composer.y + composer.height < 740,
    );
    assert.ok(await home.evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: 'test-results/openpe-home-compact.png' });
    console.log('Reference Home compact preview check passed.');
    // Browser layouts below the desktop minimum keep the cards/composer contained.
    await page.setViewportSize({ width: 760, height: 900 });
    assert.ok(await home.evaluate((el) => el.scrollWidth <= el.clientWidth));
    assert.equal(
      await examples
        .locator('.home-example-list')
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
      2,
    );
    await page.setViewportSize({ width: 1100, height: 740 });
    console.log('Reference Home responsive grid check passed.');

    await button('Settings').click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.waitFor();
    assert.equal(await button('Settings').getAttribute('aria-haspopup'), null);
    assert.equal(await page.getByRole('menu', { name: 'OpenPE menu', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(
      await button('Settings').evaluate((element) => element === document.activeElement),
      true,
    );
    await button('Settings').focus();
    await page.keyboard.press('Enter');
    await settings.waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await settings.waitFor();
    await page.keyboard.press('Escape');
    console.log('Reference Home direct Settings pointer, keyboard and focus checks passed.');

    const brief = 'Create a low-pass filter';
    await home.getByRole('textbox', { name: 'Describe your circuit', exact: true }).fill(brief);
    await button('Start project').click();
    await page.getByTestId('schematic-canvas').waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Message your agent', exact: true }).inputValue(),
      brief,
    );
    assert.equal(
      agentRequests,
      0,
      'Starting from Home must transfer the brief without sending it.',
    );
    console.log('Reference Home brief handoff check passed.');
    const nativeSources = new Map();
    for (const [index, entry] of catalog.entries()) {
      console.log(`Checking ${entry.title} schematic and Layout.`);
      await button('Home').click();
      await home
        .getByRole('button', {
          name: `Open ${entry.title} example`,
          exact: true,
        })
        .click();
      await page.getByTestId('schematic-canvas').waitFor();
      console.log(`${entry.title}: schematic opened.`);
      assert.equal(
        await page.locator('.project-navigation:visible > [data-project-id]').count(),
        index + 2,
      );
      assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
      await button('Source').click();
      const exampleSource = await readSource(page);
      nativeSources.set(entry.id, exampleSource);
      const selectedFile = await page
        .getByRole('region', { name: 'Project source', exact: true })
        .getByRole('navigation', { name: 'Project files', exact: true })
        .locator('[aria-current="page"]')
        .getAttribute('data-source-file');
      const example = parseProject(exampleSources[entry.id]);
      const native = projectNativeFiles(example, 'project.kicad_pro');
      const expectedFile = native.files.find((file) => file.name === selectedFile);
      console.log(`${entry.title}: Source opened.`);
      assert.ok(expectedFile, `${entry.id}: Source selects a native project file.`);
      assert.equal(
        exampleSource,
        expectedFile.source,
        `${entry.id}: opening preserves every selected native source byte.`,
      );
      assert.equal(example.name, entry.title);
      assert.ok(example.schematic.parts.length > 0);
      assert.ok(example.pcb.footprints.length > 0);
      assert.ok(example.pcb.tracks.length > 0);
      await button('Dismiss notification').click();
      await button('Layout').click();
      const layout = page.getByTestId('layout-canvas');
      await layout.waitFor();
      assert.ok((await layout.locator('[data-selection-id]').count()) > 0);
      await page.screenshot({ path: `test-results/openpe-reference-layout-${index + 1}.png` });
      await button('Source').click();
      assert.ok(
        (await readSource(page)) === exampleSource,
        `${entry.id}: viewing Layout preserves the selected native source.`,
      );
      assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
    }
    assert.equal(
      footprintRequests,
      0,
      'Opening and viewing embedded boards never fetches replacement packages.',
    );
    await button('Home').click();
    assert.deepEqual(await recent.locator('.home-example h3').allTextContents(), ['EMC Flyback']);
    const openProjects = await page
      .locator('.project-navigation:visible > [data-project-id]')
      .count();
    await recent.getByRole('button', { name: 'Open EMC Flyback example', exact: true }).click();
    await page.getByRole('region', { name: 'Project source', exact: true }).waitFor();
    assert.equal(await readSource(page), nativeSources.get('emc-flyback-demo'));
    assert.equal(
      await page.locator('.project-navigation:visible > [data-project-id]').count(),
      openProjects,
    );
    assert.deepEqual(errors, []);
    console.log(
      'OpenPE Home: fixed Recent EMC Flyback, original nine Example entries, light/dark/compact layouts, branding, motion, direct Settings, brief handoff and all ten schematic/Layout entries passed.',
    );
  }
} finally {
  await browser.close();
}

async function checkAbout(page, errors) {
  const opener = page.getByRole('button', { name: 'Open About', exact: true });
  const dialog = page.getByRole('dialog', { name: 'About OpenPE', exact: true });
  const summary = dialog.locator('summary').filter({ hasText: 'Third-party licenses' });
  const checkBounds = async () => {
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(Math.abs(box.width - Math.min(560, viewport.width - 48)) <= 1);
    assert.ok(box.x >= 23 && box.y >= 23);
    assert.ok(box.x + box.width <= viewport.width - 23);
    assert.ok(box.y + box.height <= viewport.height - 23);
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await opener.click();
    await dialog.getByRole('heading', { name: 'OpenPE', exact: true }).waitFor();
    await dialog.getByText('Electrical Engineering Studio', { exact: true }).waitFor();
    await waitForAsync(page, () =>
      [...document.querySelectorAll('dialog img')].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).count(), 0);
    assert.equal(await dialog.locator('details[open]').count(), 0);
    assert.equal(licenseRequests.length, 0, 'Collapsed licenses perform no file requests.');
    await checkBounds();
    await dialog.screenshot({ path: `test-results/about-${theme}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
  }
  await opener.click();
  await summary.focus();
  await page.keyboard.press('Enter');
  await dialog.locator('details[data-license]').first().waitFor({ state: 'attached' });
  await waitForAsync(
    page,
    (expectedCount) => {
      const texts = [...document.querySelectorAll('dialog pre')];
      return (
        texts.length === expectedCount &&
        texts.every((text) => text.getAttribute('aria-busy') === 'false')
      );
    },
    licensePaths.size,
  );
  assert.equal(licenseRequests.length, licensePaths.size);
  assert.deepEqual(new Set(licenseRequests), licensePaths);
  const names = await dialog.locator('details[data-license] > summary').allTextContents();
  assert.deepEqual(names.slice(0, 3), [
    'KiCad libraries',
    'KiCad demo notices',
    'KiCad demo license',
  ]);
  assert.deepEqual(names.slice(-3), ['Agent product marks', 'DeepSeek Harness icon', 'Pi icon']);
  for (const entry of await dialog.locator('details[data-license]').all()) {
    const id = await entry.getAttribute('data-license');
    const special = {
      'Agent product marks': '/agents/README.txt',
      'DeepSeek Harness icon': '/agents/LICENSE-deepseek',
      'Pi icon': '/agents/LICENSE-pi',
    };
    const pathname = special[id] ?? `/licenses/${id}.txt`;
    assert.equal(await entry.locator('pre').textContent(), licenseBodies.get(pathname));
  }
  const first = dialog.locator('details[data-license]').first();
  await first.locator('summary').click();
  await first.locator('pre').waitFor({ state: 'visible' });
  await dialog.screenshot({ path: 'test-results/about-licenses.png' });
  await summary.click();
  await summary.click();
  await waitForAsync(page, () => document.querySelector('dialog details')?.open === true);
  assert.equal(
    licenseRequests.length,
    licensePaths.size,
    'Reopening licenses reuses the retained text.',
  );
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-step', '6px');
  });
  await opener.click();
  await checkBounds();
  assert.ok(
    await dialog.evaluate(
      (element) =>
        element.querySelector('.dialog-content').scrollWidth <=
        element.querySelector('.dialog-content').clientWidth + 1,
    ),
  );
  await dialog.screenshot({ path: 'test-results/about-narrow-large-type.png' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(
    'About UI passed: light/dark/narrow large typography, native modal close/focus, lazy stable licenses and exact local notice bytes.',
  );
}
