import { openDisplayDrawer } from './visualization-test-helpers.mjs';

export async function openSchematicPanel(page, name) {
  if (!['List', 'Selection', 'Visible layers'].includes(name))
    throw new Error(`Unsupported schematic visualization panel: ${name}`);
  for (const previous of ['List']) {
    const dialog = page.getByRole('dialog', { name: previous, exact: true });
    if (await dialog.isVisible()) {
      if (previous === name) return dialog;
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    }
  }
  if (name !== 'List')
    return openDisplayDrawer(page, name === 'Visible layers' ? 'Visualization' : name);
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.waitFor();
  return dialog;
}
