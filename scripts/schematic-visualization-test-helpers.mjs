import { openDisplayDrawer } from './visualization-test-helpers.mjs';

export async function openSchematicPanel(page, name) {
  if (!['List', 'Selection', 'Visualization'].includes(name))
    throw new Error(`Unsupported schematic visualization panel: ${name}`);
  const list = page.getByRole('dialog', { name: 'List', exact: true });
  if (await list.isVisible()) {
    if (name === 'List') return list;
    await list.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  if (name !== 'List') return openDisplayDrawer(page, name);
  await page.getByRole('button', { name, exact: true }).click();
  await list.waitFor();
  return list;
}
