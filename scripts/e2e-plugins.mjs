// Opt-in desktop check. Catalogs and mutations are intercepted; no real plugin is changed.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fillSource, readSource } from './source-editor-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

const profile = path.resolve('test-results', `plugins-${Date.now()}-${process.pid}`);
await mkdir(profile, { recursive: true });
const application = await electron.launch({
  args: ['.'],
  env: { ...process.env, OPENPE_TEST: '1', OPENPE_DATA_DIR: profile, OPENPE_DEV_URL: '' },
});
try {
  const page = await application.firstWindow();
  let installed = true,
    mutations = 0,
    enabled = true;
  const workbench = bundledWorkbenchCatalog();
  await page.route('**/api/workbench-plugins', async (route) => {
    if (route.request().method() === 'POST') {
      const { id, action } = route.request().postDataJSON();
      assert.equal(id, workbench.plugins[0].id);
      workbench.plugins[0].installed = action !== 'uninstall';
      workbench.plugins[0].enabled = action === 'enable' || action === 'install';
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ...workbench, updatedAt: Date.now() } });
  });
  await page.route('**/api/plugins**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      assert.equal(body.id, 'design@fixture');
      mutations++;
      installed = body.action !== 'uninstall';
      if (body.action === 'disable') enabled = false;
      if (body.action === 'enable') enabled = true;
      return route.fulfill({ json: { ok: true } });
    }
    const claude = route.request().url().includes('provider=claude');
    return route.fulfill({
      json: {
        controlsVersion: 1,
        browse: !claude,
        updatedAt: Date.now(),
        actions: claude ? ['install'] : ['install', 'uninstall', 'enable', 'disable'],
        warning: claude ? 'This CLI cannot list plugins. Update it to browse.' : '',
        plugins: claude
          ? []
          : installed
            ? [
                {
                  id: 'design@fixture',
                  scope: 'user',
                  name: 'Design tools',
                  marketplace: 'fixture',
                  description: 'Fixture catalog',
                  installed,
                  origin: 'openpe',
                  enabled,
                  version: '1.0',
                  managed: false,
                  policy: 'AVAILABLE',
                },
              ]
            : [],
      },
    });
  });
  await page.getByRole('region', { name: 'Welcome to OpenPE' }).waitFor();
  await page.getByRole('textbox', { name: 'Describe your circuit' }).fill('Keep this brief');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  const plugins = page.getByRole('region', { name: 'Plugins', exact: true });
  await plugins.getByRole('button', { name: 'View Design tools' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Welcome to OpenPE' }).count(), 0);
  await plugins.getByRole('textbox', { name: 'Search plugins' }).fill('missing');
  assert.equal(await plugins.getByRole('button', { name: 'View Design tools' }).count(), 0);
  await plugins.getByRole('textbox', { name: 'Search plugins' }).fill('');
  await plugins
    .getByRole('region', { name: 'OpenPE plugins', exact: true })
    .getByRole('button', { name: 'View Design tools' })
    .waitFor();
  await plugins.getByRole('button', { name: /^Marketplace / }).click();
  await plugins.getByRole('button', { name: 'View SPICE Simulation' }).waitFor();
  await plugins.getByRole('switch', { name: 'SPICE Simulation enabled' }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="SPICE Simulation enabled"]')
        ?.getAttribute('aria-checked') === 'false',
  );
  await plugins.getByRole('button', { name: /^All plugins / }).click();
  const toggle = plugins.getByRole('switch', { name: 'Design tools enabled' });
  await toggle.click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Design tools enabled"]')
        ?.getAttribute('aria-checked') === 'false',
  );
  assert.equal(mutations, 1);
  assert.equal(await plugins.getByRole('button', { name: 'Plugin settings' }).count(), 0);
  await plugins.getByRole('button', { name: 'View Design tools' }).click();
  await plugins.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Uninstall plugin?' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  assert.equal(mutations, 1);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Uninstall');
  await plugins.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Uninstall plugin?' })
    .getByRole('button', { name: 'Uninstall', exact: true })
    .click();
  await plugins.locator('.plugin-detail').waitFor({ state: 'detached' });
  assert.equal(await plugins.getByRole('button', { name: 'View Design tools' }).count(), 0);
  assert.equal(mutations, 2);
  assert.equal(await plugins.getByRole('combobox', { name: 'Plugin provider' }).count(), 0);
  await page.getByRole('combobox', { name: 'Choose agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude Code', exact: true }).click();
  assert.match(
    await plugins.getByRole('button', { name: 'Refresh plugins' }).getAttribute('aria-description'),
    /Claude Code: This CLI cannot list plugins/,
  );
  await plugins.getByRole('button', { name: 'Return to workspace' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(
    await page.getByRole('textbox', { name: 'Describe your circuit' }).inputValue(),
    'Keep this brief',
  );
  // Opening the manager on Home must not create a document.
  assert.equal(await page.getByTestId('schematic-canvas').count(), 0);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await fillSource(page, '{"pending":');
  const draft = await readSource(page);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await plugins.waitFor();
  await plugins.getByRole('button', { name: 'Return to workspace' }).click();
  assert.equal(await readSource(page), draft);
  console.log('Plugin desktop checks passed.');
} finally {
  // Only this isolated test application is destroyed; unsaved fixture text is intentional.
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  });
  await application.close();
}
