import { runCanvasAction, openCanvasContextMenu } from './canvas-context-menu-test-helpers.mjs';
import {
  parseProject,
  serializeProject,
  schematicDocumentItems,
} from '../server/project-format.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { tsImport } from 'tsx/esm/api';
const { defaultAppearance } = await tsImport('../lib/appearance.ts', import.meta.url);
const { switchingStageSource } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
import {
  readNativeProject,
  fillNativeProject,
  projectHistory,
} from './source-editor-test-helpers.mjs';
import { openSchematicPanel } from './schematic-visualization-test-helpers.mjs';
import { closeDisplayDrawer } from './visualization-test-helpers.mjs';
import { checkInspectorResize, checkFieldProperties } from './schematic-panel-test-helpers.mjs';
import { watchCanvasResizeFrames } from './check-canvas-resize.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = process.cwd();
const section = process.argv.find((arg) => arg.startsWith('--section='))?.split('=')[1] ?? 'all';
assert.ok(
  ['all', 'appearance', 'home', 'editor'].includes(section),
  'Choose all, appearance, home or editor.',
);
const homeManifest = JSON.parse(
  await readFile(path.join(root, 'resources/example-catalog/home-manifest.json'), 'utf8'),
);
const homeCatalog = [...homeManifest.recent, ...homeManifest.examples];
const firstExampleButton = `Open ${homeManifest.examples[0].title} example`;
const projectButtonSelector = '.project-navigation:not([hidden] *) .project-folder > button';
const activeProjectButton = projectButtonSelector + '[aria-current="page"]';
const projectDirtyDot = projectButtonSelector + ' .dirty-dot';
const profile = path.join(root, 'test-results', `profile-${Date.now()}-${process.pid}`);
const nativeFixtures = `${profile}-native-fixtures`;
// Assertions use the internal model adapter only after reading every native file
// through Source's public file list and Copy action. Source itself stays native.
const readSnapshotFromNative = async (page) => serializeProject(await readNativeProject(page));
const fillSnapshotAsNative = async (page, source) => fillNativeProject(page, parseProject(source));
async function chooseSelect(page, trigger, value) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await trigger.press('ArrowDown');
  const target = page.getByRole('option', { name: value, exact: true });
  const index = Number((await target.getAttribute('id')).split('-').at(-1));
  assert.ok(Number.isInteger(index) && index >= 0);
  await trigger.press('Home');
  for (let i = 0; i < index; i++) await trigger.press('ArrowDown');
  await trigger.press('Enter');
}
await mkdir('test-results', { recursive: true });
await Promise.all(
  ['rejected', 'imported', 'rectifier', 'saved', 'closing'].map((name) =>
    mkdir(path.join(nativeFixtures, name), { recursive: true }),
  ),
);
const application = await electron.launch({
  ...(process.env.OPENPE_EXECUTABLE
    ? { executablePath: process.env.OPENPE_EXECUTABLE, args: [] }
    : { args: ['.'] }),
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DATA_DIR: profile,
    OPENPE_DEV_URL: '',
  },
});
// Native capture supports a hidden packaged window without waiting on Chromium's
// screenshot animation-frame barrier after modal focus changes.
async function capture(file) {
  const bounded = async (work) => {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native test capture timed out.')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  await bounded(
    application.evaluate(async ({ BrowserWindow }) => {
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  const png = await bounded(
    application.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      if (image.isEmpty()) throw new Error('The desktop capture is empty.');
      return image.toPNG().toString('base64');
    }),
  );
  await writeFile(file, Buffer.from(png, 'base64'));
}
async function closeCurrentProject(page) {
  const count = await page.locator(projectButtonSelector).count();
  const unsaved = await page
    .locator(activeProjectButton)
    .getAttribute('aria-label')
    .then((label) => /Unsaved changes/.test(label ?? ''));
  await fileMenuAction(page, 'Close project');
  const dialog = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  if (unsaved) await dialog.getByRole('button', { name: "Don't save", exact: true }).click();
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelectorAll(selector).length === expected,
    { selector: projectButtonSelector, expected: count - 1 },
  );
}
async function keepCurrentProject(page) {
  const id = await page
    .locator(activeProjectButton)
    .evaluate((button) => button.closest('[data-project-id]').dataset.projectId);
  const buttons = page.locator(projectButtonSelector);
  while ((await buttons.count()) > 1) {
    const index = await buttons.evaluateAll(
      (buttons, id) =>
        buttons.findIndex((button) => button.closest('[data-project-id]').dataset.projectId !== id),
      id,
    );
    if (index < 0) throw new Error('Expected a distinct fixture project.');
    await buttons.nth(index).click();
    await closeCurrentProject(page);
  }
  assert.equal(
    await page
      .locator(activeProjectButton)
      .evaluate((button) => button.closest('[data-project-id]').dataset.projectId),
    id,
  );
}
async function checkHome(page) {
  let homeChatRequests = 0;
  await page.exposeFunction('recordUnexpectedHomeChat', () => {
    homeChatRequests += 1;
  });
  await page.evaluate(() => sessionStorage.setItem('guardHomeChatRequests', '1'));
  const home = page.getByRole('region', { name: 'Welcome to OpenPE', exact: true });
  const canvas = page.getByTestId('schematic-canvas');
  const state = () =>
    page.evaluate(async () => {
      const c = await window.openpe.connection();
      return (
        await fetch(c.base + '/api/state', {
          headers: { 'X-OpenPE-Token': c.token },
          cache: 'no-store',
        })
      ).json();
    });
  const source = async () => {
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const text = await readSnapshotFromNative(page);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    return text;
  };
  await home.waitFor();
  assert.equal(await canvas.count(), 0);
  // Idle Home must not fabricate an active document or write a recovery file.
  await page.waitForFunction(
    (count) => document.querySelectorAll('.home-example-preview svg').length === count,
    homeCatalog.length,
  );
  await capture('test-results/home.png');
  await page.setViewportSize({ width: 1120, height: 760 });
  await capture('test-results/home-compact.png');
  assert.ok(await page.locator('.home-surface').evaluate((el) => el.scrollWidth <= el.clientWidth));
  assert.equal(await state(), null);
  await page.reload();
  await home.waitFor();
  await page.setViewportSize({ width: 1480, height: 920 });
  await page.keyboard.press('a');
  await page.keyboard.press('w');
  assert.equal(await page.getByRole('dialog').count(), 0);
  // Keyboard file opening works on Home; cancel and parse failures stay there.
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.keyboard.press('Control+o');
  assert.equal(await home.isVisible(), true);
  const rejectedPath = path.join(nativeFixtures, 'rejected', 'rejected.kicad_sch');
  await writeFile(rejectedPath, 'not a KiCad schematic');
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, rejectedPath);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.locator('.toast').waitFor();
  assert.equal(await home.isVisible(), true);
  assert.equal(await state(), null);
  assert.equal(await readFile(rejectedPath, 'utf8'), 'not a KiCad schematic');
  // A failed recovery must remain untouched instead of being replaced by an example.
  const brokenRecovery = '{invalid JSON';
  const recoveryFile = path.join(profile, 'openpe-workspace-v2.json');
  await writeFile(recoveryFile, brokenRecovery);
  await page.reload();
  await page
    .getByRole('alert')
    .filter({ hasText: 'original recovery file was preserved' })
    .waitFor();
  await capture('test-results/home-recovery-error.png');
  assert.equal(await readFile(recoveryFile, 'utf8'), brokenRecovery);
  await unlink(recoveryFile);
  await page.reload();
  await home.waitFor();
  // Starting blank is explicit; Home/resume preserves the document and unsent chat.
  const agentPicker = page.getByRole('combobox', { name: 'Choose agent', exact: true });
  await page
    .getByLabel('Describe your circuit', { exact: true })
    .fill('Keep this brief while changing agents');
  await agentPicker.click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Claude Code', { exact: true }) })
    .click();
  assert.equal(
    await page.getByLabel('Describe your circuit', { exact: true }).inputValue(),
    'Keep this brief while changing agents',
  );
  assert.equal(
    await page.getByLabel('Describe your circuit', { exact: true }).getAttribute('placeholder'),
    'Work with Claude Code',
  );
  await page.getByLabel('Describe your circuit', { exact: true }).fill('');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await canvas.waitFor();
  assert.match(await agentPicker.getAttribute('aria-description'), /Claude Code/);
  await agentPicker.click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Codex', { exact: true }) })
    .click();
  assert.equal(await page.locator('[data-testid^="part-"]').count(), 0);
  const blankSource = await source();
  await page.getByLabel('Message your agent', { exact: true }).fill('Keep this unsent draft');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await home.waitFor();
  assert.equal(await page.locator(projectDirtyDot).count(), 0);
  assert.doesNotMatch(
    await page.locator(projectButtonSelector).getAttribute('aria-label'),
    /Unsaved changes/,
  );
  await page.locator(projectButtonSelector).click();
  assert.equal(await source(), blankSource);
  assert.equal(
    await page.getByLabel('Message your agent', { exact: true }).inputValue(),
    'Keep this unsent draft',
  );
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  // Promote the initial Recent card into real history before opening other files.
  for (const { title } of homeManifest.recent) {
    await page.getByRole('button', { name: `Open ${title} example`, exact: true }).click();
    await canvas.waitFor();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
  }
  await page.getByRole('button', { name: firstExampleButton, exact: true }).click();
  await canvas.waitFor();
  assert.equal(
    await page.locator('.file-tab .dirty-dot').count(),
    0,
    'Opening an example is not an edit.',
  );
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator(projectButtonSelector).count(), homeManifest.recent.length + 2);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  // The brief is handed to the real Chat composer without inventing a response.
  const brief = 'Design a 48 V to 12 V converter.\nCompare switching topologies.';
  await page.getByLabel('Describe your circuit', { exact: true }).fill(brief);
  const chooseHome = async (name, value) => {
    await home.getByRole('combobox', { name, exact: true }).click();
    await page
      .getByRole('option')
      .filter({ has: page.getByText(value, { exact: true }) })
      .click();
  };
  await chooseHome('Choose model', 'GPT-6 Astra');
  await chooseHome('Reasoning effort', 'Medium');
  await chooseHome('Agent permissions', 'Auto-approve');
  const homeModelLabel = await home
    .getByRole('combobox', { name: 'Choose model', exact: true })
    .innerText();
  await page.getByRole('button', { name: 'Start project', exact: true }).click();
  await canvas.waitFor();
  assert.equal(await page.getByLabel('Message your agent', { exact: true }).inputValue(), brief);
  assert.equal(await page.locator('.message').count(), 0);
  assert.equal(
    await page.getByRole('combobox', { name: 'Choose model', exact: true }).innerText(),
    homeModelLabel,
  );
  assert.match(
    await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).innerText(),
    /Medium/,
  );
  assert.match(
    await page
      .getByRole('combobox', { name: 'Agent permissions', exact: true })
      .getAttribute('aria-description'),
    /Auto/,
  );
  await chooseEffort(page, 'Low');
  await page.getByRole('combobox', { name: 'Agent permissions', exact: true }).click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Review changes', { exact: true }) })
    .click();
  assert.equal(await page.locator('[data-testid^="part-"]').count(), 0);
  // Real native open is usable from Home. Work from a copy to protect the example file.
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const importedPath = path.join(nativeFixtures, 'imported', 'home-import.kicad_sch');
  const exampleSource = switchingStageSource();
  await writeFile(importedPath, exampleSource);
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, importedPath);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await canvas.waitFor();
  await page.getByTestId('part-C2').waitFor();
  assert.equal(await page.getByLabel('Message your agent', { exact: true }).inputValue(), '');
  const importedSource = await source();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: firstExampleButton, exact: true }).click();
  await canvas.waitFor();
  const firstExample = await source();
  assert.notEqual(firstExample, importedSource, 'An example creates its own UUIDs.');
  // Save as prompts for a separate destination, never overwriting an imported file.
  await application.evaluate(({ dialog }) => {
    globalThis.__homeSaveDialogCalls = 0;
    dialog.showSaveDialog = async () => {
      globalThis.__homeSaveDialogCalls++;
      return { canceled: true };
    };
  });
  await fileMenuAction(page, 'Save as');
  assert.equal(await application.evaluate(() => globalThis.__homeSaveDialogCalls), 1);
  assert.equal(await readFile(importedPath, 'utf8'), exampleSource);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: firstExampleButton, exact: true }).click();
  await canvas.waitFor();
  assert.equal(await source(), firstExample, 'Reopening keeps the existing example document.');
  for (const { id, file, title } of homeCatalog) {
    const name = homeManifest.recent.some((entry) => entry.id === id)
      ? `Open ${file}`
      : `Open ${title} example`;
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await canvas.waitFor();
    const first = JSON.parse(await source());
    assert.equal(first.nativeFiles.entry, `${file}.kicad_pro`);
    await runCanvasAction(page, 'Fit to canvas');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[data-testid="schematic-canvas"]');
      if (!canvas) return false;
      const bounds = canvas.getBoundingClientRect();
      return [...canvas.querySelectorAll('text')].every((text) => {
        const box = text.getBoundingClientRect();
        return (
          box.left >= bounds.left &&
          box.right <= bounds.right &&
          box.top >= bounds.top &&
          box.bottom <= bounds.bottom
        );
      });
    });
    assert.ok(parseProject(JSON.stringify(first)).pcb.footprints.length > 0);
    assert.ok(parseProject(JSON.stringify(first)).pcb.tracks.length > 0);
    assert.ok(first.schematic.components.length > 0, `${id} retains its native components.`);
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await page.getByTestId('layout-canvas').waitFor();
    assert.deepEqual(
      JSON.parse(await source()),
      first,
      'Layout viewing preserves the complete example.',
    );
    const before = await application.evaluate(() => globalThis.__homeSaveDialogCalls);
    await fileMenuAction(page, 'Save as');
    assert.equal(await application.evaluate(() => globalThis.__homeSaveDialogCalls), before + 1);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await canvas.waitFor();
    assert.deepEqual(
      JSON.parse(await source()),
      first,
      'Reopening retains project and PCB identities.',
    );
    assert.equal(await readFile(importedPath, 'utf8'), exampleSource);
    await closeCurrentProject(page);
    console.log(
      `PASS: native Home example ${title}, schematic/Layout preservation and reopen identity.`,
    );
  }
  // Keep the original tight-body pointer regression independent of Home's catalog.
  if (!(await home.isVisible()))
    await page.getByRole('button', { name: 'Home', exact: true }).click();
  const rectifierPath = path.join(nativeFixtures, 'rectifier', 'rectifier.kicad_sch');
  await writeFile(
    rectifierPath,
    await readFile(path.join(root, 'tests/fixtures/kicad/kicad-rectifier.kicad_sch'), 'utf8'),
  );
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, rectifierPath);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await canvas.waitFor();
  {
    const first = JSON.parse(await source());
    await runCanvasAction(page, 'Fit to canvas');
    const clickBody = async (ref, modifiers = false) => {
      const p = first.schematic.components.find((p) => p.reference === ref);
      const at = await canvas.evaluate((svg, p) => {
        const point = new DOMPoint(p.position.x, p.position.y).matrixTransform(svg.getScreenCTM());
        return { x: point.x, y: point.y };
      }, p);
      if (modifiers) await page.keyboard.down('Shift');
      await page.mouse.click(at.x, at.y);
      if (modifiers) await page.keyboard.up('Shift');
      assert.match(await page.getByTestId(`part-${ref}`).getAttribute('class'), /is-selected/);
    };
    // A real pointer click on D1 must not hit C1's transparent target.
    for (const zoom of [false, true]) {
      if (zoom) await runCanvasAction(page, 'Zoom in');
      await clickBody('D1');
      assert.doesNotMatch(await page.getByTestId('part-C1').getAttribute('class'), /is-selected/);
      assert.equal(
        await page.getByLabel('Component reference', { exact: true }).inputValue(),
        'D1',
      );
      await clickBody('C1', true);
      assert.match(await page.getByTestId('part-D1').getAttribute('class'), /is-selected/);
      await canvas.focus();
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(
      JSON.parse(await source()),
      first,
      'Body selection changes neither project data nor history.',
    );
  }
  await closeCurrentProject(page);
  console.log(
    'PASS: document-free Home, shared composer preference/draft handoff, recovery preservation, native opening, non-destructive project creation and all ten Home schematic/Layout projects.',
  );
  assert.equal(homeChatRequests, 0, 'Home actions transfer drafts without sending Agent requests.');
  // Later canvas tests use the switching-stage test circuit as a fixture.
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, importedPath);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByTestId('part-C2').waitFor();
  await keepCurrentProject(page);
  await page.evaluate(() => sessionStorage.removeItem('guardHomeChatRequests'));
}
async function checkAppearance(page) {
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  const brief = page.getByRole('textbox', { name: 'Describe your circuit', exact: true });
  const composerStyle = () =>
    page.locator('.home-composer').evaluate((el) => {
      const style = getComputedStyle(el);
      return { shadow: style.boxShadow, border: style.borderColor };
    });
  const unfocusedStyle = await composerStyle();
  await brief.focus();
  assert.equal(await brief.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
  assert.equal(await brief.evaluate((el) => getComputedStyle(el).boxShadow), 'none');
  assert.deepEqual(await composerStyle(), unfocusedStyle, 'Focus adds no border or halo.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const choose = async (label, value) => {
    if (label === 'Motion' || label === 'Source indentation') {
      if (!(await dialog.locator('.appearance-advanced').evaluate((el) => el.open)))
        await dialog.getByText('Advanced', { exact: true }).click();
    }
    if (label === 'Theme' || label === 'Motion') {
      await dialog
        .getByRole('radiogroup', { name: label, exact: true })
        .getByRole('radio', { name: value, exact: true })
        .check();
      return;
    }
    await chooseSelect(page, dialog.getByRole('combobox', { name: label, exact: true }), value);
  };
  await choose('Theme', 'Dark');
  const themeModes = dialog.getByRole('radiogroup', { name: 'Theme', exact: true });
  await themeModes.getByRole('radio', { name: 'Dark', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(
    await themeModes.getByRole('radio', { name: 'Light', exact: true }).isChecked(),
    true,
  );
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await themeModes.getByRole('radio', { name: 'Dark', exact: true }).isChecked(),
    true,
  );
  for (const [label, value] of [
    ['Colored blocks', 'rainbow'],
    ['Colored lines', 'guides'],
  ]) {
    await choose('Source indentation', label);
    await page.waitForFunction(
      (style) => document.documentElement.dataset.sourceWhitespace === style,
      value,
    );
  }
  await page.setViewportSize({ width: 1100, height: 740 });
  for (const [label, value, pixels] of [
    ['Small · 13 px', 'small', 13],
    ['Compact · 14 px', 'compact', 14],
    ['Standard · 15 px', 'standard', 15],
    ['Large · 17 px', 'large', 17],
    ['Extra large · 19 px', 'extra-large', 19],
  ]) {
    await choose('Text size', label);
    await page.waitForFunction((size) => document.documentElement.dataset.textSize === size, value);
    assert.equal(
      await page.locator('body').evaluate((el) => getComputedStyle(el).fontSize),
      `${pixels}px`,
    );
    assert.ok(
      await dialog.evaluate((el) => {
        const footer = el.querySelector('.dialog-footer').getBoundingClientRect();
        const rows = [...el.querySelectorAll('.appearance-row')];
        return (
          footer.bottom <= innerHeight &&
          el.scrollWidth <= el.clientWidth &&
          rows.every((row) => row.scrollWidth <= row.clientWidth)
        );
      }),
      `Settings fits at ${pixels} px in a compact window.`,
    );
  }
  await choose('Text size', 'Large · 17 px');
  await choose('Motion', 'On');
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.documentElement.dataset.textSize === 'large',
  );
  assert.equal(await page.locator('body').evaluate((el) => getComputedStyle(el).fontSize), '17px');
  await page.setViewportSize({ width: 1100, height: 740 });
  assert.ok(
    await dialog.evaluate((el) => {
      const footer = el.querySelector('.dialog-footer').getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && footer.bottom <= innerHeight;
    }),
  );
  await dialog.getByRole('combobox', { name: 'Text size', exact: true }).press('ArrowDown');
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true, 'Menu Escape keeps Settings open.');
  await waitForAsync(page, async () => {
    const c = await window.openpe.connection();
    const value = await (
      await fetch(c.base + '/api/appearance', {
        headers: { 'X-OpenPE-Token': c.token },
        cache: 'no-store',
      })
    ).json();
    return (
      value.theme === 'dark' &&
      value.textSize === 'large' &&
      value.motion === 'reduced' &&
      value.sourceWhitespace === 'guides'
    );
  });
  await page.reload();
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.documentElement.dataset.motion === 'reduced' &&
      document.documentElement.dataset.sourceWhitespace === 'guides',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await choose('Theme', 'System');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await choose('Theme', 'Light');
  await choose('Text size', 'Standard · 15 px');
  await choose('Motion', 'System');
  await choose('Source indentation', 'Colored blocks');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await waitForAsync(page, async () => {
    const c = await window.openpe.connection();
    const value = await (
      await fetch(c.base + '/api/appearance', {
        headers: { 'X-OpenPE-Token': c.token },
        cache: 'no-store',
      })
    ).json();
    return value.theme === 'light' && value.textSize === 'standard' && value.motion === 'system';
  });
  await page.setViewportSize({ width: 1480, height: 920 });
  console.log(
    'PASS: appearance persistence, system theme, compact settings and nested menu focus.',
  );
}
async function checkAdvancedAppearance(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const choose = async (name, label) => {
    await chooseSelect(page, dialog.getByRole('combobox', { name, exact: true }), label);
  };
  const fill = async (name, value) => {
    const input = dialog.getByRole('textbox', { name, exact: true });
    await input.fill(value);
    await input.press('Enter');
  };
  const css = (property) =>
    page
      .locator('html')
      .evaluate((el, key) => getComputedStyle(el).getPropertyValue(key).trim(), property);
  await choose('Theme preset', 'Graphite');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--surface') === '#f4f6fa',
  );
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Background"]').value === '#f4f6fa',
  );
  await fill('Background', '#f2f4f8');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--surface') === '#f2f4f8',
  );
  await fill('Foreground', '#253044');
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Foreground picker"]').value === '#253044',
  );
  await fill('Accent color', '#3766aa');
  assert.equal(await css('--surface'), '#f2f4f8');
  await fill('Background', '#nope');
  assert.equal(
    await dialog
      .getByRole('textbox', { name: 'Background', exact: true })
      .getAttribute('aria-invalid'),
    'true',
  );
  assert.equal(await css('--surface'), '#f2f4f8');
  await dialog.getByRole('textbox', { name: 'Background', exact: true }).press('Escape');
  await choose('Interface font', 'Technical · Bahnschrift');
  await dialog.getByText('Advanced', { exact: true }).click();
  for (const [name, value] of [
    ['Interface text size', '18'],
    ['Content text size', '24'],
    ['Code text size', '16'],
  ]) {
    const input = dialog.getByRole('spinbutton', { name, exact: true });
    await input.fill(value);
    await input.press('Enter');
  }
  await choose('Content font', 'Serif · Georgia');
  await choose('Code font', 'Consolas');
  await choose('Code font style', 'Italic');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--code-style') === 'italic',
  );
  assert.equal(
    await page.locator('.home-composer textarea').evaluate((el) => getComputedStyle(el).fontSize),
    '24px',
  );
  assert.match(await css('--content-font'), /Georgia/);
  assert.match(await css('--code-font'), /Consolas/);
  assert.equal(await css('--code-style'), 'italic');
  await dialog
    .getByRole('switch', { name: 'Separate light and dark settings', exact: true })
    .click();
  await choose('Editing mode', 'Light');
  await choose('Theme preset', 'Paper');
  await choose('Editing mode', 'Dark');
  await choose('Theme preset', 'Graphite');
  await dialog
    .getByRole('radiogroup', { name: 'Theme', exact: true })
    .getByRole('radio', { name: 'Dark', exact: true })
    .check();
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--surface') === '#191c21',
  );
  assert.equal(await css('--surface'), '#191c21');
  await dialog
    .getByRole('radiogroup', { name: 'Theme', exact: true })
    .getByRole('radio', { name: 'Light', exact: true })
    .check();
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--surface') === '#faf7ef',
  );
  assert.equal(await css('--surface'), '#faf7ef');
  await dialog
    .getByRole('switch', { name: 'Separate light and dark settings', exact: true })
    .click();
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--surface') === '#f2f4f8',
  );
  assert.equal(await css('--surface'), '#f2f4f8');
  for (const name of ['Translucent sidebar', 'Smart punctuation', 'Full-width content'])
    await dialog.getByRole('switch', { name, exact: true }).click();
  const contrast = dialog.getByRole('slider', { name: 'Contrast', exact: true });
  await contrast.focus();
  await contrast.press('End');
  assert.equal(await contrast.inputValue(), '100');
  await dialog
    .getByRole('radiogroup', { name: 'Motion', exact: true })
    .getByRole('radio', { name: 'Off', exact: true })
    .check();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.notEqual(
    await page.locator('.home-signal-current').evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await dialog
    .getByRole('radiogroup', { name: 'Motion', exact: true })
    .getByRole('radio', { name: 'On', exact: true })
    .check();
  assert.equal(
    await page.locator('.home-signal-current').evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const draft = page.getByLabel('Describe your circuit', { exact: true });
  await draft.fill('Wait');
  await draft.pressSequentially('...');
  assert.equal(await draft.inputValue(), 'Wait…');
  assert.equal(
    await page.locator('.home-content').evaluate((el) => getComputedStyle(el).maxWidth),
    'none',
  );
  assert.match(
    await page.locator('.home-sidebar').evaluate((el) => getComputedStyle(el).backdropFilter),
    /blur/,
  );
  await waitForAsync(page, async () => {
    const c = await window.openpe.connection();
    const a = await (
      await fetch(c.base + '/api/appearance', {
        headers: { 'X-OpenPE-Token': c.token },
        cache: 'no-store',
      })
    ).json();
    return a.contentSize === 24 && a.fullWidth && a.smartPunctuation && a.contrast === 100;
  });
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.fullWidth === 'true');
  assert.equal(await css('--content-size'), '24px');
  assert.equal(await css('--surface'), '#f2f4f8');
  // Restore the isolated fixture's preferences for subsequent checks.
  await page.evaluate(async (appearance) => {
    const c = await window.openpe.connection();
    const response = await fetch(c.base + '/api/appearance', {
      method: 'POST',
      headers: { 'X-OpenPE-Token': c.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(appearance),
    });
    if (!response.ok) throw new Error('Could not restore fixture appearance.');
  }, defaultAppearance);
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.smartPunctuation === 'false');
  console.log(
    'PASS: custom colors/fonts, independent modes, motion override, smart typing, translucent/full-width layouts and persistence.',
  );
}
async function checkGrid(page) {
  const canvas = page.getByTestId('schematic-canvas');
  const density = page.getByRole('combobox', { name: 'Grid density', exact: true });
  const dirtyBefore = await page.locator(projectDirtyDot).count();
  assert.equal(await density.getAttribute('aria-description'), '2 mm');
  for (const spacing of [0.5, 1, 2, 5, 10]) {
    await density.click();
    await page.getByRole('option', { name: `${spacing} mm`, exact: true }).click();
    assert.equal(await canvas.locator('pattern').getAttribute('width'), String(spacing));
    assert.equal(await canvas.locator('pattern').getAttribute('x'), String(-spacing / 2));
  }
  await density.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await density.getAttribute('aria-description'), 'Off');
  await density.click();
  await page.getByRole('option', { name: '10 mm', exact: true }).click();
  assert.equal(await density.getAttribute('aria-description'), '10 mm');
  await density.click();
  await page.getByRole('option', { name: '2 mm', exact: true }).click();
  assert.equal(await page.locator(projectDirtyDot).count(), dirtyBefore);
  assert.equal(await page.getByRole('button', { name: 'Show grid', exact: true }).count(), 0);
  const box = await canvas.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const samples = [];
  for (const enabled of [true, false, true]) {
    await density.click();
    await page.getByRole('option', { name: enabled ? '2 mm' : 'Off', exact: true }).click();
    const file = `test-results/grid-${samples.length}.png`;
    await capture(file);
    const metadata = await sharp(file).metadata();
    const sx = metadata.width / viewport.width;
    const sy = metadata.height / viewport.height;
    const { data } = await sharp(file)
      .extract({
        left: Math.round((box.x + 20) * sx),
        top: Math.round((box.y + 20) * sy),
        width: Math.round(180 * sx),
        height: Math.round(100 * sy),
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    samples.push(data);
  }
  const [first, off, restored] = samples;
  for (let i = 0; i < off.length; i += 3)
    assert.ok(off[i] === off[0] && off[i + 1] === off[1] && off[i + 2] === off[2]);
  for (const enabled of [first, restored]) {
    let contrastingDots = 0;
    for (let i = 0; i < off.length; i += 3) if (off[i] - enabled[i] >= 3) contrastingDots++;
    assert.ok(contrastingDots > 50, 'Enabled grid has visibly contrasting dots');
  }
  assert.equal(await page.locator(projectDirtyDot).count(), dirtyBefore);
  console.log('PASS: grid follows its density control without changing project data.');
}
async function chooseEffort(page, label) {
  await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText(label, { exact: true }) })
    .click();
}
async function checkComposerLayout(page) {
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  const agent = page.getByRole('combobox', { name: 'Choose agent', exact: true });
  const model = page.getByRole('combobox', { name: 'Choose model', exact: true });
  const textSize = async (label) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await chooseSelect(
      page,
      settings.getByRole('combobox', { name: 'Text size', exact: true }),
      label,
    );
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
  };
  await model.click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('GPT-6 Astra', { exact: true }) })
    .click();
  for (const size of [
    { width: 1480, height: 920, font: 'Standard · 15 px' },
    { width: 1120, height: 760, font: 'Standard · 15 px' },
    { width: 1100, height: 740, font: 'Standard · 15 px' },
    { width: 1100, height: 740, font: 'Small · 13 px' },
    { width: 1100, height: 740, font: 'Extra large · 19 px' },
  ]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await textSize(size.font);
    await chooseEffort(page, 'Medium');
    const layout = await page.locator('.composer').evaluate((el) => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const composer = el.getBoundingClientRect();
      const text = box('.composer textarea');
      const model = box('[aria-label="Choose model"]');
      const effort = box('[aria-label="Reasoning effort"]');
      const send = box('.send-button');
      const permission = box('.approval-control');
      const agent = box('.rail-agent');
      const settings = box('.nav-rail [aria-label="Settings"]');
      return {
        fits: el.scrollWidth <= el.clientWidth && composer.bottom <= innerHeight,
        settingsBelowText: model.top >= text.bottom && effort.top >= text.bottom,
        order: model.right <= effort.left && effort.right <= send.left,
        aligned: Math.abs((effort.top + effort.bottom - send.top - send.bottom) / 2) < 2,
        permissionInsideComposer:
          permission.top >= text.bottom &&
          permission.left >= composer.left &&
          permission.right <= model.left,
        agentAboveSettings: agent.bottom <= settings.top && agent.right <= composer.left,
      };
    });
    assert.ok(
      Object.values(layout).every(Boolean),
      `Composer fits ${size.width} × ${size.height}, ${size.font}: ${JSON.stringify(layout)}`,
    );
    await effort.click();
    const menu = await page.getByRole('listbox').boundingBox();
    const trigger = await effort.boundingBox();
    assert.ok(menu.y >= 0 && menu.x >= 0 && menu.x + menu.width <= size.width);
    assert.ok(
      menu.y + menu.height <= trigger.y,
      'The bottom composer menu opens above its trigger.',
    );
    assert.ok(trigger.y - menu.y - menu.height <= 8, 'The menu stays anchored to the trigger.');
    await page.keyboard.press('Escape');
    assert.equal(await effort.evaluate((el) => el === document.activeElement), true);
    await page
      .getByLabel('Message your agent', { exact: true })
      .fill('Unsent composer layout check');
    await agent.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByLabel('Message your agent', { exact: true }).inputValue(),
      'Unsent composer layout check',
    );
    await page.getByLabel('Message your agent', { exact: true }).fill('');
    await page.locator('.chat-header').click({ position: { x: 1, y: 1 } });
    await capture(
      `test-results/composer-${size.width}-${size.font.split(' ')[0].toLowerCase()}.png`,
    );
  }
  await textSize('Standard · 15 px');
  await page.getByLabel('Message your agent', { exact: true }).fill('');
  await model.click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('GPT-6 Astra', { exact: true }) })
    .click();
  await chooseEffort(page, 'Low');
  await page.setViewportSize({ width: 1480, height: 920 });
  console.log(
    'PASS: composer geometry at three desktop sizes and extreme font sizes, anchored upward effort menu, focus restoration and unsent draft preservation.',
  );
}
async function checkModelSelection(page) {
  const agent = page.getByRole('combobox', { name: 'Choose agent', exact: true });
  const model = page.getByRole('combobox', { name: 'Choose model', exact: true });
  const choose = async (trigger, label) => {
    await trigger.click();
    await page
      .getByRole('option')
      .filter({ has: page.getByText(label, { exact: true }) })
      .click();
  };
  await choose(model, 'GPT-6 Astra');
  await choose(agent, 'Claude Code');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Choose model"]')?.textContent === 'Choose model',
  );
  await choose(model, 'Sonnet');
  await page.locator('.chat-header').click({ position: { x: 1, y: 1 } });
  await capture('test-results/composer-claude.png');
  await choose(agent, 'Codex');
  assert.match(
    await model.innerText(),
    /GPT-6 Astra|gpt-6-astra/,
    'Each agent retains its own model.',
  );
  await page.setViewportSize({ width: 1100, height: 740 });
  assert.equal(
    await page.locator('.composer').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await page
    .getByLabel('Message your agent', { exact: true })
    .fill('Preserve draft while selecting a model');
  await model.click();
  await page.keyboard.press('Escape');
  assert.match(await model.innerText(), /GPT-6 Astra|gpt-6-astra/);
  assert.equal(
    await page.getByLabel('Message your agent', { exact: true }).inputValue(),
    'Preserve draft while selecting a model',
  );
  await choose(model, 'GPT-6 Astra');
  await waitForAsync(
    page,
    async () => {
      const c = await window.openpe.connection();
      const state = await (
        await fetch(c.base + '/api/state', {
          headers: { 'X-OpenPE-Token': c.token },
          cache: 'no-store',
        })
      ).json();
      return (
        state.provider === 'codex' &&
        state.models?.codex === 'gpt-6-astra' &&
        state.models?.claude === 'sonnet'
      );
    },
    undefined,
    { polling: 100 },
  );
  await page.reload();
  await page.waitForFunction(() => {
    const trigger = document.querySelector('.workspace:not([hidden]) [aria-label="Choose model"]');
    return (
      trigger?.getAttribute('aria-description')?.includes('gpt-6-astra') ||
      trigger?.textContent?.includes('GPT-6 Astra')
    );
  });
  await choose(agent, 'Claude Code');
  await page.waitForFunction(() =>
    /sonnet/i.test(
      document.querySelector('.workspace:not([hidden]) [aria-label="Choose model"]')?.textContent ??
        '',
    ),
  );
  await choose(agent, 'Codex');
  await page.setViewportSize({ width: 1480, height: 920 });
  console.log(
    'PASS: model selection, compact layout, menu dismissal, per-agent preferences and recovery.',
  );
}
async function checkDialogs(page) {
  await page.getByTestId('part-C2').click();
  const inspector = page.getByRole('complementary', { name: 'Object properties' });
  const dialog = page.getByRole('dialog');
  const addComponent = page.getByRole('button', { name: 'Add component', exact: true });
  const checkFit = async () => {
    const fits = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const footer = el.querySelector('.dialog-footer')?.getBoundingClientRect() ?? r;
      return (
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        r.left >= 0 &&
        r.right <= innerWidth &&
        footer.bottom <= r.bottom &&
        el.scrollWidth <= el.clientWidth
      );
    });
    assert.equal(fits, true, 'Dialog and actions fit the viewport.');
  };
  await addComponent.click();
  const search = page.getByLabel('Search components', { exact: true });
  await search.fill('no matching symbol');
  await page.getByText('No matching symbols.', { exact: true }).waitFor();
  await page.keyboard.press('Shift+Tab');
  assert.equal(
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  // Native modal inertness must block focus on the background trigger.
  await page
    .locator('.workspace:not([hidden]) button[aria-label="Add component"]')
    .evaluate((button) => button.focus());
  assert.equal(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
    true,
    'The modal keeps focus when a background control attempts to take it.',
  );
  await page.keyboard.press('Tab');
  await search.fill('');
  await capture('test-results/dialog-components.png');
  await search.focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await inspector.isVisible(), true, 'Modal Escape preserves selection.');
  assert.equal(
    await addComponent.evaluate((el) => el === document.activeElement),
    true,
    'Focus returns to the trigger.',
  );
  // All modal bodies scroll independently; their actions stay reachable at the minimum size.
  await page.setViewportSize({ width: 1100, height: 740 });
  for (const [button, name] of [
    ['Add component', 'components'],
    ['Settings', 'connections'],
  ]) {
    const fromHome = name === 'connections';
    if (fromHome) await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: button, exact: true }).click();
    await dialog.waitFor();
    await checkFit();
    await page.keyboard.press('Control+s');
    await page.keyboard.press('Control+o');
    assert.equal(await dialog.count(), 1, 'Global file shortcuts are blocked by dialogs.');
    await capture(`test-results/dialog-${name}-compact.png`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    if (fromHome) await page.locator(projectButtonSelector).click();
  }
  await capture('test-results/dialog-properties-compact.png');
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  const agent = page.getByRole('combobox', { name: 'Choose agent', exact: true });
  await agent.click();
  await capture('test-results/menu-agent.png');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  assert.ok(
    (await agent.getAttribute('aria-description')).includes('Codex'),
    'Escape cancels a highlighted choice.',
  );
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  await effort.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal((await effort.innerText()).trim(), 'High');
  await effort.click();
  await capture('test-results/menu-effort.png');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal((await effort.innerText()).trim(), 'Low');
  await agent.click();
  await page
    .getByRole('complementary', { name: 'Object properties', exact: true })
    .locator('.inspector-body')
    .click({ position: { x: 8, y: 8 } });
  assert.equal(await page.getByRole('listbox').count(), 0, 'Outside click dismisses the menu.');
  // Cancelling a save must leave this project open.
  await page.getByTestId('part-C2').click();
  const editedValue = page.getByLabel('Component value', { exact: true });
  const originalValue = await editedValue.inputValue();
  await editedValue.fill('150uF');
  await editedValue.press('Enter');
  await page.locator(projectDirtyDot).waitFor();
  await fileMenuAction(page, 'Close project');
  await page.getByRole('dialog', { name: 'Save changes?', exact: true }).waitFor();
  await capture('test-results/dialog-replace-compact.png');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Save cancelled' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByTestId('part-C2').count(), 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByTestId('part-C2').click();
  assert.equal(
    await editedValue.inputValue(),
    originalValue,
    'The close-review fixture edit is fully undoable.',
  );
  await page.getByTestId('schematic-canvas').press('Escape');
  await page.setViewportSize({ width: 1480, height: 920 });
  console.log(
    'PASS: modal focus containment/restoration, Escape in inputs, protected background shortcuts, compact layouts, menu keyboard/cancel/outside selection and cancelled save preserves the project.',
  );
}
async function checkSchematicPanels(page) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Source').click();
  const original = await readSnapshotFromNative(page);
  await button('Schematic').click();
  await openSchematicPanel(page, 'List');
  const list = page.getByRole('dialog', { name: 'List', exact: true });
  assert.equal(
    await page.getByTestId('schematic-canvas').count(),
    1,
    'Parts panel keeps the canvas mounted.',
  );
  await list
    .getByRole('button', { name: /^Locate / })
    .first()
    .click();
  await list.waitFor({ state: 'hidden' });
  await page.getByTestId('schematic-canvas').press('e');
  const properties = page.getByRole('complementary', { name: 'Object properties', exact: true });
  await properties.waitFor();
  const bounds = await properties.boundingBox();
  const dockBounds = await page.getByTestId('schematic-properties-panel').boundingBox();
  const canvasBounds = await page.getByTestId('schematic-canvas').boundingBox();
  assert.ok(
    dockBounds.x >= canvasBounds.x + canvasBounds.width - 1 &&
      dockBounds.width >= 280 &&
      dockBounds.width <= 480,
    'Properties dock sits beside the schematic drawing.',
  );
  assert.ok(bounds.x >= dockBounds.x && bounds.x + bounds.width <= dockBounds.x + dockBounds.width);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await properties
    .getByRole('textbox', { name: 'Component value', exact: true })
    .fill('Cancelled edit');
  await properties.getByRole('textbox', { name: 'Component value', exact: true }).press('Escape');
  assert.equal(
    (await properties
      .getByRole('textbox', { name: 'Component value', exact: true })
      .inputValue()) !== 'Cancelled edit',
    true,
  );
  await openSchematicPanel(page, 'List');
  assert.equal(await properties.isVisible(), false, 'List dismisses object properties.');
  await page.keyboard.press('Escape');
  assert.equal(await properties.isVisible(), false, 'Dismissed properties stay closed.');
  await page.getByTestId('schematic-canvas').press('e');
  await properties.waitFor();
  assert.equal(
    await properties
      .getByLabel('Component reference', { exact: true })
      .evaluate((input) => input === document.activeElement),
    true,
  );
  const visualization = await openSchematicPanel(page, 'Visualization');
  await visualization.getByRole('checkbox', { name: 'References', exact: true }).waitFor();
  assert.equal(await properties.isVisible(), true, 'Visualization shares the right dock.');
  await page
    .getByRole('group', { name: 'Visualization', exact: true })
    .getByRole('button', { name: 'Visualization', exact: true })
    .click();
  await button('Source').click();
  assert.equal(
    await readSnapshotFromNative(page),
    original,
    'Opening panels, locating parts and cancelling properties preserve the project.',
  );
  await button('Schematic').click();
}
async function checkSimulationProperties(page) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Source').click();
  const original = await readSnapshotFromNative(page);
  const part = JSON.parse(original).schematic.components.find((p) => p.reference === 'C1');
  assert.ok(part, 'The switching-stage fixture includes capacitor C1.');
  await button('Schematic').click();
  await openSchematicPanel(page, 'List');
  await button('Edit ' + part.reference).click();
  const properties = page.getByRole('complementary', { name: 'Object properties', exact: true });
  const simulation = properties.getByRole('tab', { name: 'SPICE', exact: true });
  const model = properties.getByRole('combobox', { name: 'Simulation model', exact: true });
  const initialVoltage = properties.getByLabel('Initial voltage (V)', { exact: true });
  assert.equal(await initialVoltage.isVisible(), false);
  await simulation.press('Enter');
  await model.waitFor();
  assert.equal(await properties.getByLabel('Sim.Name', { exact: true }).count(), 0);
  await initialVoltage.fill('1.2');
  await initialVoltage.press('Enter');
  await properties.getByRole('tab', { name: 'General', exact: true }).click();
  assert.equal(await initialVoltage.isVisible(), false);
  await button('Source').click();
  const changed = JSON.parse(await readSnapshotFromNative(page));
  assert.equal(
    changed.schematic.components.find((p) => p.id === part.id).simulation.initialVoltage,
    '1.2',
  );
  await button('Schematic').click();
  await button('Undo').click();
  await button('Source').click();
  assert.equal(
    await readSnapshotFromNative(page),
    original,
    'The SPICE parameter is one undoable edit and tab switches add no history.',
  );
  await button('Schematic').click();
}
async function checkPartsListEditing(page) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Source').click();
  const before = await readSnapshotFromNative(page);
  const project = JSON.parse(before);
  const part =
    project.schematic.components.find((p) => p.reference === 'R1') ||
    project.schematic.components.find((p) => !p.reference.startsWith('#'));
  const another = project.schematic.components.find(
    (p) => p.id !== part.id && !p.reference.startsWith('#'),
  );
  const editedRef = part.reference.replace(/\d+$/, '') + '901';
  const footprint = 'TestLibrary:' + 'LongFootprintName'.repeat(12);
  await button('Schematic').click();
  if (another) {
    await openSchematicPanel(page, 'List');
    await button('Locate ' + another.reference).click();
  }
  await openSchematicPanel(page, 'List');
  await button('Edit ' + part.reference).click();
  let properties = page.getByRole('complementary', { name: 'Object properties', exact: true });
  await properties
    .getByRole('textbox', { name: 'Footprint', exact: true })
    .fill('Cancelled footprint');
  await properties.getByRole('textbox', { name: 'Footprint', exact: true }).press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'List', exact: true }).count(), 0);
  await openSchematicPanel(page, 'List');
  await button('Edit ' + part.reference).click();
  properties = page.getByRole('complementary', { name: 'Object properties', exact: true });
  assert.notEqual(
    await properties.getByRole('textbox', { name: 'Footprint', exact: true }).inputValue(),
    'Cancelled footprint',
  );
  await properties
    .getByRole('textbox', { name: 'Component reference', exact: true })
    .fill(editedRef);
  await properties
    .getByRole('textbox', { name: 'Component reference', exact: true })
    .press('Enter');
  await properties.getByRole('textbox', { name: 'Component value', exact: true }).fill('2.2k');
  await properties.getByRole('textbox', { name: 'Component value', exact: true }).press('Enter');
  await properties.getByRole('textbox', { name: 'Footprint', exact: true }).fill(footprint);
  await properties.getByRole('textbox', { name: 'Footprint', exact: true }).press('Enter');
  const fieldLayout = await properties
    .locator('.property-resource-field')
    .filter({ has: page.getByRole('button', { name: 'Browse footprints', exact: true }) })
    .evaluate((row) => {
      const [name, value, action] = [...row.children].map((child) => child.getBoundingClientRect());
      return {
        aligned: Math.abs(name.y - value.y) < 2 && Math.abs(value.y - action.y) < 2,
        columns:
          name.right <= value.left &&
          action.left > value.left &&
          Math.abs(value.right - action.right) < 2,
        fits: row.scrollWidth <= row.clientWidth,
      };
    });
  assert.deepEqual(fieldLayout, { aligned: true, columns: true, fits: true });
  await checkInspectorResize(page, properties);
  assert.equal(await properties.getByLabel('Component X position', { exact: true }).count(), 1);
  assert.equal(await properties.getByLabel('Component rotation', { exact: true }).count(), 1);
  assert.equal(await properties.getByRole('button', { name: /^(Apply|Cancel)$/ }).count(), 0);
  assert.equal(await properties.isVisible(), true);
  await openSchematicPanel(page, 'List');
  assert.ok((await button('Edit ' + editedRef).innerText()).includes(footprint));
  const list = page.getByRole('dialog', { name: 'List', exact: true });
  const content = list.locator('.dialog-content');
  assert.equal(
    await content.evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
    'Long fields do not cause horizontal scrolling.',
  );
  const listBounds = await list.boundingBox();
  const locateBounds = await button('Locate ' + editedRef).boundingBox();
  assert.ok(
    locateBounds.x >= listBounds.x &&
      locateBounds.x + locateBounds.width <= listBounds.x + listBounds.width,
  );
  const footprintCell = button('Edit ' + editedRef).locator('.parts-panel-footprint');
  assert.equal(await footprintCell.getAttribute('aria-description'), footprint);
  assert.equal(
    await footprintCell.evaluate((el) => el.scrollWidth > el.clientWidth),
    true,
    'Long footprint names are truncated inside their column.',
  );
  assert.equal(
    await list
      .getByRole('textbox', { name: 'Search parts', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  await button('Source').click();
  const changed = JSON.parse(await readSnapshotFromNative(page));
  const updated = changed.schematic.components.find((p) => p.id === part.id);
  assert.equal(updated.reference, editedRef);
  assert.equal(updated.value, '2.2k');
  assert.equal(updated.fields.Footprint, footprint);
  if (another)
    assert.deepEqual(
      changed.schematic.components.find((p) => p.id === another.id),
      another,
    );
  assert.deepEqual(changed.pcb, project.pcb);
  assert.deepEqual(changed.extensions, project.extensions);
  await button('Schematic').click();
  for (let i = 0; i < 3; i++) await button('Undo').click();
  await button('Source').click();
  assert.equal(
    await readSnapshotFromNative(page),
    before,
    'Each committed property edit is independently undoable.',
  );
  await button('Schematic').click();
  const layers = await openSchematicPanel(page, 'Visualization');
  await layers.getByRole('checkbox', { name: 'References', exact: true }).uncheck();
  await closeDisplayDrawer(page, 'Visualization');
  await openSchematicPanel(page, 'List');
  await button('Edit ' + part.reference).click();
  assert.equal(
    await properties.getByLabel('Component reference', { exact: true }).inputValue(),
    part.reference,
  );
  assert.equal(await page.getByTestId('part-' + part.reference).count(), 1);
  assert.equal(await page.getByTestId('annotation-ref-' + part.reference).count(), 0);
  await openSchematicPanel(page, 'Visualization');
  await layers.getByRole('checkbox', { name: 'References', exact: true }).check();
  await closeDisplayDrawer(page, 'Visualization');
}
async function checkSchematicLayers(page) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Source').click();
  const original = await readSnapshotFromNative(page);
  await button('Schematic').click();
  const ref = page.getByTestId('annotation-ref-C1');
  const value = page.getByTestId('annotation-value-C1');
  assert.notEqual(
    await ref.evaluate((el) => getComputedStyle(el).fill),
    await value.evaluate((el) => getComputedStyle(el).fill),
  );
  const dirty = await page.locator('.file-tab .dirty-dot').count();
  const layers = await openSchematicPanel(page, 'Visualization');
  for (const name of ['References', 'Values'])
    await layers.getByRole('checkbox', { name, exact: true }).uncheck();
  await closeDisplayDrawer(page, 'Visualization');
  assert.equal(await ref.count(), 0);
  assert.equal(await value.isVisible(), false);
  assert.equal(await page.getByTestId('part-C1').count(), 1);
  assert.equal(await page.locator('.file-tab .dirty-dot').count(), dirty);
  await button('Source').click();
  assert.equal(await readSnapshotFromNative(page), original);
  await button('Schematic').click();
  await openSchematicPanel(page, 'Visualization');
  for (const name of ['References', 'Values'])
    await layers.getByRole('checkbox', { name, exact: true }).check();
  await closeDisplayDrawer(page, 'Visualization');
  await ref.waitFor();
  const bounds = await ref.boundingBox();
  await ref.click();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2 + 20, {
    steps: 4,
  });
  await page.getByTestId('field-owner-guide').waitFor();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.getByTestId('field-owner-guide').count(), 0);
  await button('Source').click();
  assert.equal(
    await readSnapshotFromNative(page),
    original,
    'Cancelled field drag and view toggles preserve project data.',
  );
  await button('Schematic').click();
}

async function checkAnnotationSelection(page) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  const source = async () => {
    await button('Source').click();
    const text = await readSnapshotFromNative(page);
    await button('Schematic').click();
    return text;
  };
  const before = await source();
  await page.getByTestId('annotation-ref-C1').click();
  assert.equal(await page.getByLabel('Reference text', { exact: true }).inputValue(), 'C1');
  await checkFieldProperties(page, page.getByRole('complementary', { name: 'Object properties' }));
  await capture('test-results/selection-component.png');
  await page.getByTestId('schematic-canvas').press('Escape');
  const value = page.getByTestId('annotation-value-C1');
  const bounds = await value.boundingBox();
  // The far end of a long value lies outside the former symbol-sized hit rectangle.
  await page.mouse.click(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2);
  assert.equal(await page.getByLabel('Value text', { exact: true }).count(), 1);
  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + bounds.height / 2 + 18);
  await page.mouse.up();
  const afterTextMove = await source();
  const oldProject = JSON.parse(before),
    newProject = JSON.parse(afterTextMove);
  assert.notEqual(afterTextMove, before, 'Dragging an annotation moves that field.');
  assert.deepEqual(
    schematicDocumentItems(newProject.schematic, 'wires'),
    schematicDocumentItems(oldProject.schematic, 'wires'),
  );
  assert.deepEqual(
    newProject.schematic.components.map(({ fieldLayout, ...p }) => p),
    oldProject.schematic.components.map(({ fieldLayout, ...p }) => p),
    'Text movement leaves all component coordinates and parameters unchanged.',
  );
  await button('Undo').click();
  assert.equal(await source(), before, 'Text move is one undoable edit.');
  await button('Redo').click();
  assert.equal(await source(), afterTextMove, 'Text position survives redo.');
  await button('Undo').click();
  // A cancelled text gesture must never enter history.
  const cancelBounds = await value.boundingBox();
  await page.mouse.move(
    cancelBounds.x + cancelBounds.width / 2,
    cancelBounds.y + cancelBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(cancelBounds.x + 30, cancelBounds.y + 20);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await source(), before);
  const canvas = page.getByTestId('schematic-canvas');
  const panBefore = await canvas.getAttribute('viewBox');
  const ref = await page.getByTestId('annotation-ref-C1').boundingBox();
  await page.mouse.move(ref.x + ref.width / 2, ref.y + ref.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(ref.x + ref.width / 2 + 30, ref.y + ref.height / 2 + 15);
  await page.mouse.up({ button: 'right' });
  assert.notEqual(await canvas.getAttribute('viewBox'), panBefore);
  assert.equal(await source(), before, 'Panning over annotations does not edit the document.');
  await runCanvasAction(page, 'Fit to canvas');
  await page.getByTestId('label-SW').locator('text').click();
  assert.equal(await page.getByLabel('Net name', { exact: true }).inputValue(), 'SW');
  await capture('test-results/selection-net-label.png');
  await page.getByLabel('Net name', { exact: true }).fill('SW_TEST');
  await page.getByTestId('schematic-canvas').press('Escape');
  assert.ok((await source()).includes('SW_TEST'));
  await button('Undo').click();
  assert.equal(
    await source(),
    before,
    'A net-label edit is undoable without changing other objects.',
  );
  console.log(
    'PASS: reference/value/net selection, long-text hit area, annotation pan and edit/undo integrity.',
  );
}

async function checkSelectionEdits(page) {
  const canvas = page.getByTestId('schematic-canvas');
  const button = (name) => page.getByRole('button', { name, exact: true });
  const source = async () => {
    await button('Source').click();
    const value = await readSnapshotFromNative(page);
    await button('Schematic').click();
    return value;
  };
  const before = await source(),
    original = JSON.parse(before);
  await canvas.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  const duplicated = JSON.parse(await source());
  assert.equal(duplicated.schematic.components.length, original.schematic.components.length * 2);
  assert.equal(
    schematicDocumentItems(duplicated.schematic, 'wires').length,
    schematicDocumentItems(original.schematic, 'wires').length * 2,
  );
  assert.equal(
    new Set(duplicated.schematic.components.map((p) => p.id)).size,
    duplicated.schematic.components.length,
  );
  await button('Undo').click();
  assert.equal(await source(), before);
  for (const action of ['Rotate', 'Mirror horizontally', 'Mirror vertically']) {
    await canvas.focus();
    await page.keyboard.press('Control+a');
    await page.getByRole('combobox', { name: 'Edit schematic', exact: true }).click();
    await page.getByRole('option', { name: action, exact: true }).click();
    assert.notEqual(await source(), before);
    await button('Undo').click();
    assert.equal(await source(), before);
  }
  await canvas.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  assert.equal(
    JSON.parse(await source()).schematic.components.length,
    original.schematic.components.length * 2,
  );
  await button('Undo').click();
  assert.equal(await source(), before);
  await page.getByRole('combobox', { name: 'Place electrical marker', exact: true }).click();
  await page.getByRole('option', { name: 'Global label', exact: true }).click();
  const bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + 30, bounds.y + 30);
  const marked = JSON.parse(await source());
  assert.equal(
    schematicDocumentItems(marked.schematic, 'labels').filter((l) => l.scope === 'global').length,
    schematicDocumentItems(original.schematic, 'labels').filter((l) => l.scope === 'global')
      .length + 1,
  );
  await button('Undo').click();
  assert.equal(await source(), before);
  await canvas.focus();
  await page.keyboard.press('Escape');
  console.log(
    'PASS: multi-object copy, duplicate, rotation, mirrors, global labels and undo integrity.',
  );
}

async function checkCanvasNavigation(page) {
  const canvas = page.getByTestId('schematic-canvas');
  const view = () =>
    canvas.evaluate((el) => {
      const { x, y, width, height } = el.viewBox.baseVal;
      return { x, y, width, height };
    });
  const textGeometry = () =>
    canvas.evaluate((svg) => {
      const inverse = svg.getCTM().inverse();
      const boxes = [...svg.querySelectorAll('text')]
        .filter((text) => getComputedStyle(text).display !== 'none')
        .map((text) => {
          const box = text.getBBox();
          const matrix = inverse.multiply(text.getCTM());
          const points = [box.x, box.x + box.width].flatMap((x) =>
            [box.y, box.y + box.height].map((y) => new DOMPoint(x, y).matrixTransform(matrix)),
          );
          return {
            text: text.textContent,
            local: { x: box.x, y: box.y, width: box.width, height: box.height },
            minX: Math.min(...points.map((point) => point.x)),
            maxX: Math.max(...points.map((point) => point.x)),
            minY: Math.min(...points.map((point) => point.y)),
            maxY: Math.max(...points.map((point) => point.y)),
          };
        });
      return Object.fromEntries(
        ['minX', 'maxX', 'minY', 'maxY'].map((key) => [
          key,
          boxes.reduce((best, box) =>
            (key.startsWith('min') ? box[key] < best[key] : box[key] > best[key]) ? box : best,
          ),
        ]),
      );
    });
  let fittedGeometry;
  const renderedFit = () =>
    canvas.evaluate((svg) => {
      const inverse = svg.getCTM().inverse();
      const points = [...svg.querySelectorAll('[data-selection-id]')]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .flatMap((element) => {
          const box = element.getBBox();
          const matrix = inverse.multiply(element.getCTM());
          return [box.x, box.x + box.width].flatMap((x) =>
            [box.y, box.y + box.height].map((y) => new DOMPoint(x, y).matrixTransform(matrix)),
          );
        });
      const { x, y, width, height } = svg.viewBox.baseVal;
      return {
        view: { x, y, width, height },
        left: Math.min(...points.map((point) => point.x)) - x,
        right: x + width - Math.max(...points.map((point) => point.x)),
        top: Math.min(...points.map((point) => point.y)) - y,
        bottom: y + height - Math.max(...points.map((point) => point.y)),
      };
    });
  const expectFittedView = async (expected, message = 'Space restores a padded, centered fit') => {
    // Chromium changes SVG glyph metrics slightly with scale. Verify the visible
    // drawing and asymmetric fit gutters instead of equating two old viewBoxes.
    const deadline = Date.now() + 5000;
    let metrics;
    while (Date.now() < deadline) {
      metrics = await renderedFit();
      const { left, right, top, bottom } = metrics;
      if (
        left >= 16.5 &&
        right >= 23.5 &&
        top >= 21.5 &&
        bottom >= 23.5 &&
        Math.abs(right - left - 7) < 0.5 &&
        Math.abs(bottom - top - 2) < 0.5 &&
        Math.min(left + right - 41, top + bottom - 46) < 0.5
      )
        return;
      await page.waitForTimeout(50);
    }
    assert.fail(
      JSON.stringify(
        {
          message,
          expected,
          metrics,
          fittedGeometry,
          textGeometry: await textGeometry(),
          bounds: await canvas.boundingBox(),
        },
        null,
        2,
      ),
    );
  };
  const fittedView = async () => {
    await page.evaluate(() => document.fonts.ready);
    const before = await textGeometry();
    await canvas.press('Space');
    // Canvas schedules a fit after its 60 ms layout delay; observe the resulting viewport.
    await page.waitForTimeout(100);
    fittedGeometry = { before, after: await textGeometry() };
    return view();
  };
  const source = async () => {
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const text = await readSnapshotFromNative(page);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    return text;
  };
  const original = await source();
  await page.getByTestId('part-C2').click();
  assert.equal(await page.getByLabel('Component reference', { exact: true }).inputValue(), 'C2');
  let centered = await fittedView();
  let bounds = await canvas.boundingBox();
  let blank = { x: bounds.x + 20, y: bounds.y + bounds.height * 0.7 };
  const startPan = async (point) => {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: 'right' });
  };
  const panFrom = async (point) => {
    const gestureBounds = await canvas.boundingBox();
    const before = await view();
    await startPan(point);
    await page.mouse.move(point.x + 32, point.y + 18, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    await page.waitForFunction(
      ({ x, y }) => {
        const svg = document.querySelector('[data-testid="schematic-canvas"]');
        const current = svg?.viewBox.baseVal;
        return current && Math.abs(current.x - x) < 0.01 && Math.abs(current.y - y) < 0.01;
      },
      {
        x: before.x - (32 * before.width) / gestureBounds.width,
        y: before.y - (18 * before.width) / gestureBounds.width,
      },
      { timeout: 5000 },
    );
    const after = await view();
    assert.equal(after.width, before.width, 'Panning preserves zoom');
    assert.equal(await canvas.evaluate((el) => el === document.activeElement), true);
  };
  // Right-drag must bubble through symbol, wire and label hit targets without editing them.
  for (const target of [
    page.getByTestId('part-C2'),
    canvas.locator('line[stroke="transparent"]').first(),
    canvas.locator('.net-label').first(),
  ]) {
    const b = await target.boundingBox();
    await panFrom({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    assert.equal(await page.getByLabel('Component reference', { exact: true }).inputValue(), 'C2');
    await page.keyboard.press('Space');
    await expectFittedView(centered, 'Space restores the fitted view');
  }
  console.log('PASS: right-drag over objects and Space recenter.');
  await panFrom(blank);
  const panned = await view();
  const value = page.getByLabel('Component value', { exact: true });
  const oldValue = await value.inputValue();
  await value.press('End');
  await value.press('Space');
  assert.equal(await value.inputValue(), oldValue + ' ');
  assert.deepEqual(await view(), panned, 'Property typing does not recenter');
  await value.fill(oldValue);
  const chat = page.getByLabel('Message your agent', { exact: true });
  await chat.fill('A');
  await chat.press('Space');
  assert.equal(await chat.inputValue(), 'A ');
  assert.deepEqual(await view(), panned, 'Chat typing does not recenter');
  await chat.fill('');
  await canvas.press('Escape');
  await openCanvasContextMenu(page);
  await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.ok((await view()).width < panned.width, 'Space still activates focused buttons');
  await canvas.focus();
  await page.keyboard.press('Space');
  await expectFittedView(centered);
  await page.getByTestId('part-C2').click();
  await panFrom(blank);
  const beforeDialog = await view();
  await page.keyboard.press('a');
  await page.getByRole('dialog').waitFor();
  const componentSearch = page.getByLabel('Search components', { exact: true });
  assert.equal(await componentSearch.inputValue(), '', 'Opening shortcut never enters the search.');
  await canvas.focus();
  assert.equal(await canvas.evaluate((el) => el === document.activeElement), false);
  await page.keyboard.press('Space');
  assert.deepEqual(await view(), beforeDialog, 'Open dialogs block canvas shortcuts');
  await componentSearch.fill('');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await canvas.focus();
  await page.keyboard.press('Space');
  await expectFittedView(centered);
  console.log('PASS: keyboard focus guards.');
  await page.mouse.click(blank.x, blank.y);
  assert.equal(await page.locator('.inspector').count(), 0, 'Left-click on paper clears selection');
  centered = await fittedView();
  bounds = await canvas.boundingBox();
  blank = { x: bounds.x + 20, y: bounds.y + bounds.height * 0.7 };
  for (const tool of ['Wire', 'Net label']) {
    if (tool === 'Net label') {
      await page.getByRole('combobox', { name: 'Place electrical marker', exact: true }).click();
      await page.getByRole('option', { name: 'Net label', exact: true }).click();
    } else await page.getByRole('button', { name: tool, exact: true }).click();
    if (tool === 'Wire') await page.mouse.click(blank.x, blank.y);
    await panFrom(blank);
    assert.equal(
      await page.locator(`.canvas-wrap.tool-${tool === 'Wire' ? 'wire' : 'label'}`).count(),
      1,
    );
    await page.keyboard.press('Space');
    await expectFittedView(centered);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Add component', exact: true }).click();
  await page.getByLabel('Search components', { exact: true }).fill('Device:R');
  await page
    .locator('.library-results button')
    .filter({ has: page.getByText('R', { exact: true }) })
    .click();
  await page.getByRole('button', { name: 'Place', exact: true }).click();
  await panFrom(blank);
  assert.equal(await page.locator('.canvas-wrap.tool-place').count(), 1);
  await page.keyboard.press('Escape');
  console.log('PASS: panning during wire, label and component placement.');
  // Capture keeps the drag alive outside the canvas and releases it cleanly.
  await startPan(blank);
  await page.mouse.move(bounds.x - 25, blank.y + 20, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  const released = await view();
  await page.mouse.move(blank.x, blank.y);
  assert.deepEqual(await view(), released);
  await startPan(blank);
  await page.mouse.move(blank.x + 20, blank.y + 10);
  await page.keyboard.press('Escape');
  const cancelled = await view();
  await page.mouse.move(blank.x + 40, blank.y + 20);
  await page.mouse.up({ button: 'right' });
  assert.deepEqual(await view(), cancelled, 'Escape cancels a pan');
  assert.equal(await page.locator('.canvas-wrap.is-panning').count(), 0);
  assert.equal(await source(), original, 'Navigation preserves the complete KiCad document');
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), false);
  console.log('PASS: gesture cancellation and unchanged KiCad document / undo history.');
}
try {
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  console.log(`Desktop section: ${section}; isolated profile: ${profile}`);
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (request) => {
    if (request.isNavigationRequest())
      console.error('Desktop navigation failed:', request.url(), request.failure()?.errorText);
  });
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const target = new URL(String(url));
      if (
        target.pathname === '/api/chat' &&
        sessionStorage.getItem('guardHomeChatRequests') === '1'
      ) {
        await window.recordUnexpectedHomeChat();
        return Response.json({ error: 'Unexpected Agent request from Home' }, { status: 500 });
      }
      if (target.pathname === '/api/agents')
        return Response.json([
          { id: 'codex', available: true, supportsEffort: true },
          { id: 'claude', available: true, supportsEffort: true },
        ]);
      if (target.pathname === '/api/models')
        return Response.json({
          defaultModel: target.searchParams.get('provider') === 'codex' ? 'gpt-6-astra' : null,
          models:
            target.searchParams.get('provider') === 'codex'
              ? [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'] }]
              : [
                  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
                  { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'max'] },
                ],
        });
      return original(url, options);
    };
  });
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Reasoning effort"]')?.textContent.trim() === 'Medium',
  );
  await page.setViewportSize({ width: 1480, height: 920 });
  await (async () => {
    if (section === 'all' || section === 'appearance') {
      await checkAppearance(page);
      await checkAdvancedAppearance(page);
      if (section === 'appearance') return;
    }
    if (section === 'all' || section === 'home') {
      await checkHome(page);
      if (section === 'home') return;
    } else {
      // Same clean native switching-stage document that checkHome leaves active.
      await page.getByRole('button', { name: 'New project', exact: true }).click();
      await page.getByRole('button', { name: 'New project', exact: true }).click();
      const fixture = path.join(nativeFixtures, 'imported', 'home-import.kicad_sch');
      await writeFile(fixture, switchingStageSource());
      await application.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        return true;
      }, fixture);
      await page.getByRole('button', { name: 'Open project', exact: true }).click();
      await page.getByTestId('part-C2').waitFor();
      await keepCurrentProject(page);
    }
    await checkGrid(page);
    await checkComposerLayout(page);
    await checkModelSelection(page);
    await checkDialogs(page);
    await page.getByTestId('schematic-canvas').waitFor();
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getTitle(),
      ),
      'OpenPE · Electrical Engineering Studio',
    );
    if (process.platform === 'win32') {
      const chrome = await page.evaluate(() => {
        const title = document.querySelector('.desktop-titlebar').getBoundingClientRect();
        const label = document.querySelector('.desktop-titlebar-content').getBoundingClientRect();
        const workspace = document.querySelector('.app-shell').getBoundingClientRect();
        const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
        return {
          visible: navigator.windowControlsOverlay.visible,
          titleBottom: title.bottom,
          titleHeight: title.height,
          labelRight: label.right,
          controlsStart: area.x + area.width,
          workspaceTop: workspace.top,
          workspaceBottom: workspace.bottom,
          viewportHeight: innerHeight,
        };
      });
      assert.equal(chrome.visible, true, 'Native window controls stay available.');
      assert.equal(chrome.titleHeight, 30);
      assert.ok(
        chrome.labelRight <= chrome.controlsStart + 1,
        'Title keeps clear of native controls.',
      );
      assert.equal(
        chrome.workspaceTop,
        chrome.titleBottom,
        'Workspace sits below the draggable title.',
      );
      assert.ok(
        chrome.workspaceBottom <= chrome.viewportHeight + 1,
        'Status bar stays inside the window.',
      );
      const caption = page.locator('.desktop-titlebar');
      const menu = (label) => caption.getByRole('combobox', { name: label, exact: true });
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      const beforeNavigation = await readSnapshotFromNative(page);
      await page.getByRole('button', { name: 'Schematic', exact: true }).click();
      await menu('View').click();
      await page.getByRole('option', { name: 'Home', exact: true }).click();
      await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
      await caption.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByTestId('schematic-canvas').waitFor({ state: 'visible' });
      await caption.getByRole('button', { name: 'Forward', exact: true }).click();
      await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
      assert.equal(
        await caption.getByRole('button', { name: 'Toggle sidebar', exact: true }).count(),
        0,
      );
      assert.equal(await page.locator('.home-sidebar').isVisible(), true);
      await caption.getByRole('button', { name: 'Back', exact: true }).click();
      const conversation = page.locator('.chat-panel:not([hidden])');
      const separator = page.getByRole('separator', { name: 'Resize conversation and schematic' });
      const toggle = conversation.getByRole('button', { name: 'Toggle sidebar', exact: true });
      const draft = await conversation.locator('textarea').inputValue();
      await conversation
        .locator('textarea')
        .fill('Keep this draft while the conversation is collapsed.');
      const dockWidth = (await page.locator('.nav-rail').boundingBox()).width;
      await toggle.click();
      const restore = page
        .locator('.nav-rail')
        .getByRole('button', { name: 'Toggle sidebar', exact: true });
      assert.equal(await restore.getAttribute('aria-pressed'), 'false');
      assert.equal(await conversation.isVisible(), false);
      assert.equal(await separator.isVisible(), false);
      assert.ok(Math.abs((await page.locator('.nav-rail').boundingBox()).width - dockWidth) < 1);
      await restore.click();
      assert.equal(await conversation.isVisible(), true);
      assert.equal(await separator.isVisible(), true);
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      assert.ok(Math.abs((await page.locator('.nav-rail').boundingBox()).width - dockWidth) < 1);
      assert.equal(
        await conversation.locator('textarea').inputValue(),
        'Keep this draft while the conversation is collapsed.',
      );
      await conversation.locator('textarea').fill(draft);
      await menu('Help').click();
      await page.getByRole('option', { name: 'About OpenPE', exact: true }).click();
      await page.getByRole('dialog', { name: 'About OpenPE', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await menu('Help').evaluate((el) => el === document.activeElement), true);
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      assert.equal(
        await readSnapshotFromNative(page),
        beforeNavigation,
        'Caption navigation and sidebar toggling preserve the project.',
      );
      await page.getByRole('button', { name: 'Schematic', exact: true }).click();
      assert.equal(
        await caption
          .locator('.caption-drag-space')
          .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
        'drag',
      );
      assert.equal(
        await menu('File').evaluate((el) =>
          getComputedStyle(el).getPropertyValue('-webkit-app-region'),
        ),
        'no-drag',
      );
      console.log('PASS: native window controls, caption safe area and full-height workspace.');
    }
    await capture('test-results/initial.png');
    await checkCanvasNavigation(page);
    await checkSchematicPanels(page);
    await checkSimulationProperties(page);
    await checkPartsListEditing(page);
    await checkSchematicLayers(page);
    await checkAnnotationSelection(page);
    await checkSelectionEdits(page);
    await page.getByTestId('part-C2').click();
    await page.getByLabel('Component value', { exact: true }).fill('220uF');
    await page.getByLabel('Component value', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.ok((await readSnapshotFromNative(page)).includes('220uF'));
    await projectHistory(page, 'Undo');
    assert.ok(!(await readSnapshotFromNative(page)).includes('220uF'));
    await projectHistory(page, 'Redo');
    assert.ok((await readSnapshotFromNative(page)).includes('220uF'));
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await page.getByRole('button', { name: 'Add component', exact: true }).click();
    await page.getByLabel('Search components', { exact: true }).fill('Device:R');
    await page
      .locator('.library-results button')
      .filter({ has: page.getByText('R', { exact: true }) })
      .click();
    await page.getByRole('button', { name: 'Place', exact: true }).click();
    const bounds = await page.getByTestId('schematic-canvas').boundingBox();
    await page.mouse.click(bounds.x + bounds.width * 0.42, bounds.y + bounds.height * 0.78);
    await page.getByTestId('part-R2').waitFor();
    await page.keyboard.press('r');
    const rotation = page.getByLabel('Component rotation', { exact: true });
    const xPosition = page.getByLabel('Component X position', { exact: true });
    const yPosition = page.getByLabel('Component Y position', { exact: true });
    assert.equal(await rotation.inputValue(), '90.00');
    const originalX = await xPosition.inputValue();
    const originalY = await yPosition.inputValue();
    await xPosition.fill('101');
    await xPosition.press('Enter');
    assert.equal(await xPosition.inputValue(), '101.60');
    await yPosition.fill('-25.4');
    await yPosition.press('Tab');
    assert.equal(
      await page
        .getByRole('combobox', { name: 'Component Y position unit', exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press('Tab');
    assert.equal(await yPosition.inputValue(), '-25.40');
    await rotation.fill('45');
    await rotation.press('Enter');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const geometrySource = JSON.parse(await readSnapshotFromNative(page));
    const geometryPart = geometrySource.schematic.components.find((p) => p.reference === 'R2');
    assert.equal(geometryPart.position.x, 101.6);
    assert.equal(geometryPart.position.y, -25.4);
    assert.equal(geometryPart.rotation, 45);
    await projectHistory(page, 'Undo');
    assert.equal(
      JSON.parse(await readSnapshotFromNative(page)).schematic.components.find(
        (p) => p.id === geometryPart.id,
      ).rotation,
      90,
    );
    await projectHistory(page, 'Redo');
    assert.equal(
      JSON.parse(await readSnapshotFromNative(page)).schematic.components.find(
        (p) => p.id === geometryPart.id,
      ).rotation,
      45,
    );
    // Restore the part into view with three undoable edits, then test rejected drafts.
    for (let i = 0; i < 3; i++) await projectHistory(page, 'Undo');
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await page.getByTestId('part-R2').click();
    assert.equal(await xPosition.inputValue(), originalX);
    assert.equal(await yPosition.inputValue(), originalY);
    for (const invalid of ['', '361']) {
      await rotation.fill(invalid);
      await rotation.press('Enter');
      const draft = await rotation.inputValue();
      assert.equal(draft ? Number(draft) : draft, invalid ? Number(invalid) : invalid);
      assert.equal(await rotation.getAttribute('aria-invalid'), 'true');
      await rotation.press('Escape');
      assert.equal(await rotation.inputValue(), '90.00');
      assert.equal(await rotation.getAttribute('aria-invalid'), null);
    }
    await xPosition.fill('100001');
    await xPosition.press('Enter');
    assert.equal(Number(await xPosition.inputValue()), 100001);
    assert.equal(await xPosition.getAttribute('aria-invalid'), 'true');
    await xPosition.fill('50.8');
    await xPosition.press('Escape');
    assert.equal(await xPosition.inputValue(), originalX);
    assert.equal(await xPosition.getAttribute('aria-invalid'), null);
    await capture('test-results/geometry-properties.png');
    console.log(
      'PASS: numeric position/rotation, snapping, source persistence, undo/redo and invalid drafts.',
    );
    const placed = await page.getByTestId('part-R2').boundingBox();
    await page.mouse.move(placed.x + placed.width / 2, placed.y + placed.height / 2);
    await page.mouse.down();
    await page.mouse.move(placed.x + placed.width / 2 + 25, placed.y + placed.height / 2 + 15, {
      steps: 5,
    });
    await page.mouse.up();
    await page.getByRole('button', { name: /Delete object/ }).click();
    assert.equal(await page.getByTestId('part-R2').count(), 0);
    await page.getByRole('button', { name: 'Wire', exact: true }).click();
    await page.mouse.click(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.8);
    await page.mouse.click(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.85);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await projectHistory(page, 'Undo');
    // Test the actual native-dialog IPC and filesystem write with deterministic picker responses.
    const destination = path.join(nativeFixtures, 'saved', 'saved.kicad_pro');
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await fileMenuAction(page, 'Save as');
    await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
    assert.ok(
      (await readFile(destination.replace(/\.kicad_pro$/, '.kicad_sch'), 'utf8')).includes('220uF'),
    );
    const openProjectCount = await page.locator(projectButtonSelector).count();
    const savedProjectId = await page
      .locator(activeProjectButton)
      .evaluate((button) => button.closest('[data-project-id]').dataset.projectId);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const savedNative = await readSnapshotFromNative(page);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, destination);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    assert.equal(await page.locator(projectButtonSelector).count(), openProjectCount);
    assert.equal(
      await page
        .locator(activeProjectButton)
        .evaluate((button) => button.closest('[data-project-id]').dataset.projectId),
      savedProjectId,
    );
    assert.equal(await page.getByTestId('part-C2').count(), 1);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(
      await readSnapshotFromNative(page),
      savedNative,
      'Opening a live destination selects its existing project without changing native content.',
    );
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByText('Codex CLI', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(
      await page.getByRole('dialog').getByText('Codex CLI', { exact: true }).isVisible(),
      true,
    );
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.locator(projectDirtyDot).count(), 0);
    await page.locator(projectButtonSelector).click();
    if (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count())
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await capture('test-results/desktop.png');
    // A gated ReadableStream proves partial text is visible BEFORE completion.
    // Real child-process and HTTP/SSE transport are covered in tests/chat.test.ts.
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.__chatFixture = {};
      window.fetch = async (url, options) => {
        if (!String(url).endsWith('/api/chat')) return original(url, options);
        window.__chatFixture.request = JSON.parse(options.body);
        const body = new ReadableStream({
          start(controller) {
            window.__chatFixture.push = (event) =>
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            window.__chatFixture.close = () => controller.close();
            options.signal.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      };
    });
    const push = (e) => page.evaluate((event) => window.__chatFixture.push(event), e);
    const finishStream = () => page.evaluate(() => window.__chatFixture.close());
    assert.equal(
      (await page.getByLabel('Reasoning effort', { exact: true }).innerText()).trim(),
      'Low',
    );
    await page.getByLabel('Message your agent', { exact: true }).fill('Test the proposal flow');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__chatFixture.request.effort), 'low');
    assert.equal(await page.evaluate(() => window.__chatFixture.request.model), 'gpt-6-astra');
    await push({ type: 'status', stage: 'waiting', text: 'Waiting for the model…' });
    await page.getByRole('status').filter({ hasText: 'Waiting for the model' }).waitFor();
    const liveTiming = '.agent-process[data-running] .message-timing';
    const elapsedLabel = /^(?:<1s|\d+s|\d+m(?: \d+s)?)$/;
    const initialElapsed = await page.locator(liveTiming).innerText();
    await page.waitForFunction(
      ({ selector, initial }) => {
        const timing = document.querySelector(selector);
        return timing && timing.textContent !== initial;
      },
      { selector: liveTiming, initial: initialElapsed },
    );
    assert.equal(await page.locator('.agent-process:not([data-running]) .message-timing').count(), 0);
    await push({
      type: 'timing',
      timings: { resolvedMs: 80, spawnedMs: 100, readyMs: 250, submittedMs: 250, firstTextMs: 650 },
    });
    await push({ type: 'text-delta', delta: 'Test ' });
    const answerSelector = '.message.assistant .agent-answer-part';
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.trim() === 'Test',
      answerSelector,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Stop generation', exact: true }).count(),
      1,
    );
    assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Choose model', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Choose agent', { exact: true }).isDisabled(), true);
    await push({
      type: 'text-delta',
      delta: 'proposal.\n```openpe\n[{"type":"setValue","ref":"C2",',
    });
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.trim() === 'Test proposal.',
      answerSelector,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Apply to schematic', exact: true }).count(),
      0,
    );
    await page.getByTestId('part-C2').click();
    await capture('test-results/chat-streaming.png');
    await push({ type: 'text-delta', delta: '"value":"330uF"}]\n```' });
    await push({ type: 'timing', timings: { completedMs: 1200 } });
    await push({ type: 'done', outcome: 'completed' });
    await finishStream();
    await page.getByRole('button', { name: 'Apply to schematic', exact: true }).click();
    assert.equal(await page.locator(answerSelector).innerText(), 'Test proposal.');
    assert.equal(await page.locator('.chat-progress').count(), 0);
    const completedTiming = await page.locator('.message-timing').innerText();
    assert.match(completedTiming, elapsedLabel);
    await capture('test-results/chat-complete.png');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.ok((await readSnapshotFromNative(page)).includes('330uF'));
    await projectHistory(page, 'Undo');
    assert.ok(!(await readSnapshotFromNative(page)).includes('330uF'));
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await chooseEffort(page, 'High');
    await page.getByLabel('Message your agent', { exact: true }).fill('Cancel a partial proposal');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__chatFixture.request.effort), 'high');
    await push({ type: 'text-delta', delta: 'Keep partial text.\n```openpe\n[' });
    await page
      .locator('.message.assistant')
      .last()
      .getByText('Keep partial text.', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
    await page.getByText('Generation stopped.', { exact: true }).waitFor();
    assert.equal(await page.locator('.message-timing').first().innerText(), completedTiming);
    assert.match(
      await page.locator('.message.assistant').last().locator('.message-timing').innerText(),
      elapsedLabel,
    );
    assert.equal(
      await page
        .locator('.message.assistant')
        .last()
        .getByRole('button', { name: 'Apply to schematic', exact: true })
        .count(),
      0,
    );
    await page
      .getByLabel('Message your agent', { exact: true })
      .fill('Disconnect during streaming');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await push({ type: 'text-delta', delta: 'Preserved partial' });
    await finishStream();
    await page
      .getByText('Connection closed before the response completed. Partial text was kept.', {
        exact: true,
      })
      .waitFor();
    assert.ok(
      (await page.locator('.message.assistant').last().innerText()).includes('Preserved partial'),
    );
    const persistenceDeadline = Date.now() + 10000;
    for (;;) {
      const persisted = await page.evaluate(async () => {
        const c = await window.openpe.connection();
        return (
          await fetch(c.base + '/api/state', {
            headers: { 'X-OpenPE-Token': c.token },
            cache: 'no-store',
          })
        ).json();
      });
      const persistedDocument = persisted?.documents?.find(
        (item) => item.id === persisted.activeDocumentId,
      );
      if (
        persistedDocument?.sessions
          ?.find((session) => session.id === persistedDocument.activeSessionId)
          ?.messages.at(-1)
          ?.errorText?.includes('Connection closed')
      ) {
        assert.equal(persisted.effort, 'high');
        const responses = persistedDocument.sessions
          .find((session) => session.id === persistedDocument.activeSessionId)
          .messages.filter((message) => message.role === 'assistant');
        assert.equal(responses.length, 3);
        assert.ok(responses.every((message) => Number.isFinite(message.timings?.clientTotalMs)));
        assert.equal(responses[0].timings.firstTextMs, 650, 'Diagnostic timings remain stored.');
        break;
      }
      assert.ok(Date.now() < persistenceDeadline, 'Completed response timings are persisted.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const savedTimingLabels = await page.locator('.message-timing').allTextContents();
    await page.reload();
    await page.getByTestId('schematic-canvas').waitFor();
    assert.deepEqual(await page.locator('.message-timing').allTextContents(), savedTimingLabels);
    assert.equal(await page.locator('.chat-progress').count(), 0);
    assert.equal(
      (await page.getByLabel('Reasoning effort', { exact: true }).innerText()).trim(),
      'High',
    );
    await chooseEffort(page, 'Low');
    await page.setViewportSize({ width: 1120, height: 760 });
    await capture('test-results/desktop-compact.png');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const beforeConversation = await readSnapshotFromNative(page);
    await page
      .locator('.project-navigation > span')
      .first()
      .locator('.project-folder > button')
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New session', exact: true }).click();
    assert.equal(await page.locator('.chat-panel:not([hidden]) .message').count(), 0);
    assert.equal(await readSnapshotFromNative(page), beforeConversation);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await closeCurrentProject(page);
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByTestId('part-C2').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const closeProjectSource = JSON.parse(await readSnapshotFromNative(page));
    closeProjectSource.schematic.name = 'Edited before quit';
    await fillSnapshotAsNative(page, JSON.stringify(closeProjectSource, null, 2));
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.evaluate(() => window.openpe.resolveClose(true));
    assert.equal(application.windows().length, 1, 'Unsolicited close approval is ignored.');
    const requestClose = () =>
      application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await requestClose();
    await page.getByRole('dialog', { name: 'Save changes?', exact: true }).waitFor();
    await capture('test-results/dialog-close.png');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    // Cancelling app.quit also keeps the local service alive.
    await application.evaluate(({ app }) => app.quit());
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(
      await page.evaluate(async () => {
        const c = await window.openpe.connection();
        return (
          await fetch(c.base + '/api/state', {
            headers: { 'X-OpenPE-Token': c.token },
            cache: 'no-store',
          })
        ).status;
      }),
      200,
    );
    await requestClose();
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Save cancelled' }).waitFor();
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => {
        throw new Error('Test save failure');
      };
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Test save failure' }).waitFor();
    assert.equal(application.windows().length, 1, 'Failed save never closes the project.');
    assert.deepEqual(errors, []);
    const closeFile = path.join(nativeFixtures, 'closing', 'save-before-close.kicad_pro');
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, closeFile);
    const closed = application.waitForEvent('close');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await closed;
    assert.equal(typeof JSON.parse(await readFile(closeFile, 'utf8')), 'object');
    assert.ok(
      (await readFile(closeFile.replace(/\.kicad_pro$/, '.kicad_sch'), 'utf8')).includes(
        'Edited before quit',
      ),
    );
    console.log(
      'PASS: clear-chat cancellation/confirmation preserves the circuit; close IPC ignores unsolicited approval, supports cancellation, keeps the service alive after cancelled quit, and closes only after successful save.',
    );
    console.log(
      'PASS: canvas navigation/editing, native save/open, incremental text before completion, timing, partial proposal isolation, apply/undo, cancellation, interrupted stream preservation, Medium default and saved effort; screenshots and zero page errors.',
    );
  })();
} catch (error) {
  console.error('Desktop check profile:', profile);
  console.error(
    'Desktop check window:',
    await application
      .firstWindow()
      .then(async (page) => ({
        url: page.url(),
        text: (await page.locator('body').innerText()).slice(0, 600),
      }))
      .catch(() => 'unavailable'),
  );
  await capture(path.join(profile, 'failure.png')).catch(() => {});
  await capture('test-results/desktop-failure.png').catch(() => {});
  throw error;
} finally {
  // Destroy only this isolated test instance; never bypass the product close guard.
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
    })
    .catch(() => {});
  await application.close();
}
