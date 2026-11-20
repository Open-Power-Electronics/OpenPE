// Isolated renderer menu: no Electron, projects on disk or provider calls.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import Navigation from './components/ProjectNavigation';
      const projects=[{id:'a',title:'Project A',unsaved:false,sessions:[
        {id:'session-a',title:'Existing conversation',pinned:true},
        {id:'session-a-latest',title:'Latest conversation'},
        {id:'session-a-archived',title:'Archived conversation',archived:true}]},
        {id:'b',title:'Project B',unsaved:false,sessions:[{id:'session-b',title:'Other project conversation'}]},
        {id:'empty',title:'Empty navigation',unsaved:false}];
      window.menuEvents=[];
      createRoot(document.getElementById('root')).render(<nav className="nav-rail">
        <Navigation projects={projects} activeId="a" activeSessionId="session-a"
          onSelect={(id,sessionId)=>window.menuEvents.push({kind:'select',id,sessionId})}
          onNewSession={id=>window.menuEvents.push({kind:'session',id})}
          onAction={(id,action)=>window.menuEvents.push({kind:'file',id,action})}
          onSelectSession={()=>{}} onSessionAction={()=>{}}/>
      </nav>);`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 520 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const first = page.locator('[data-project-id="a"] .project-folder button');
  const second = page.locator('[data-project-id="b"] .project-folder button');
  const menu = page.getByRole('menu', { name: 'Project file actions', exact: true });
  const rings = await page.locator('.project-session').count();
  await first.click();
  await first.click();
  await second.click();
  await first.focus();
  await first.press('Enter');
  await first.press('Space');
  const beforeComposition = await page.evaluate(() => window.menuEvents.length);
  await first.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(await page.evaluate(() => window.menuEvents.length), beforeComposition);
  await page.locator('[data-project-id="empty"] .project-folder button').click();
  assert.deepEqual(await page.evaluate(() => window.menuEvents), [
    { kind: 'select', id: 'a', sessionId: 'session-a-latest' },
    { kind: 'select', id: 'a', sessionId: 'session-a-latest' },
    { kind: 'select', id: 'b', sessionId: 'session-b' },
    { kind: 'select', id: 'a', sessionId: 'session-a-latest' },
    { kind: 'select', id: 'a', sessionId: 'session-a-latest' },
    { kind: 'select', id: 'empty', sessionId: undefined },
  ]);
  assert.equal(await page.locator('.project-session').count(), rings);
  await page.evaluate(() => {
    window.menuEvents = [];
  });
  await first.click({ button: 'right' });
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [
    'Pin',
    'New session',
    'Rename',
    'Save',
    'Save as',
    'Show in File Explorer',
    'Close project',
    'Restore Archived conversation',
  ]);
  await menu.getByRole('menuitem', { name: 'New session', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.menuEvents), [{ kind: 'session', id: 'a' }]);
  await second.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'New session', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.menuEvents), [
    { kind: 'session', id: 'a' },
    { kind: 'session', id: 'b' },
  ]);
  await first.focus();
  await first.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  const newSession = menu.getByRole('menuitem', { name: 'New session', exact: true });
  assert.equal(await newSession.evaluate((element) => element === document.activeElement), true);
  const compositionPrevented = await newSession.evaluate(
    (element) =>
      !element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
  );
  assert.equal(compositionPrevented, true);
  assert.equal(await page.evaluate(() => window.menuEvents.length), 2);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.menuEvents.length), 3);
  await first.press('Shift+F10');
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
  assert.equal(await first.evaluate((element) => element === document.activeElement), true);
  await page.locator('[data-session-id="session-a"]').click({ button: 'right' });
  assert.equal(
    await page
      .getByRole('menu', { name: 'Conversation actions' })
      .getByRole('menuitem', { name: 'New session', exact: true })
      .count(),
    0,
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 360, height: 400 });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await second.dispatchEvent('contextmenu', { clientX: 350, clientY: 390 });
  await menu.waitFor();
  const bounds = await menu.boundingBox();
  const labelsFit = await menu
    .locator('.select-option > span')
    .evaluateAll((labels) =>
      labels.every(
        (label) =>
          label.scrollWidth <= label.clientWidth + 1 &&
          label.scrollHeight <= label.clientHeight + 1,
      ),
    );
  assert.equal(labelsFit, true, 'Project menu labels remain complete in a narrow window.');
  assert.ok(
    bounds &&
      bounds.x >= 8 &&
      bounds.y >= 8 &&
      bounds.x + bounds.width <= 352 &&
      bounds.y + bounds.height <= 392,
  );
  await mkdir('test-results/project-session-menu', { recursive: true });
  await page.screenshot({ path: 'test-results/project-session-menu/light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/project-session-menu/dark.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Project folders select the latest unarchived session without creating one; New session stays explicit, with keyboard/IME, focus and narrow-layout coverage.',
  );
} finally {
  await browser.close();
}
