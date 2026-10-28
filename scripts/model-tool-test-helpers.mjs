import { openDisplayDrawer } from './visualization-test-helpers.mjs';

const actionMenus = new Map([
  ...['Chamfer edges', 'Fillet edges', 'Boolean solids'].map((label) => [label, 'Modify solids']),
  ...['Move solid', 'Rotate solid 90°', 'Duplicate solid', 'Delete solid', 'Pan 3D view'].map(
    (label) => [label, 'Edit model'],
  ),
]);

export async function chooseModelTool(page, label) {
  const menu = actionMenus.get(label);
  if (!menu) return page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('combobox', { name: menu, exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

export async function modelToolAvailable(page, label) {
  const menu = actionMenus.get(label);
  if (!menu) return page.getByRole('button', { name: label, exact: true }).isEnabled();
  const trigger = page.getByRole('combobox', { name: menu, exact: true });
  const previousFocus = await page.evaluateHandle(() => document.activeElement);
  try {
    if (await trigger.isDisabled()) return false;
    await trigger.click();
    return (await page.getByRole('option', { name: label, exact: true }).count()) === 1;
  } finally {
    if ((await trigger.getAttribute('aria-expanded')) === 'true')
      await page.keyboard.press('Escape');
    await previousFocus.evaluate((element) => {
      if (element?.isConnected && element instanceof HTMLElement)
        element.focus({ preventScroll: true });
    });
    await previousFocus.dispose();
  }
}

export async function setModelSelectionCategories(page, names) {
  const categories = ['Solids', 'Faces', 'Edges', 'Lines'];
  if (names.some((name) => !categories.includes(name)))
    throw new Error(`Unknown Model selection category: ${names.join(', ')}`);
  await openDisplayDrawer(page, 'Selection');
  const drawer = page.getByRole('group', { name: 'Selection', exact: true });
  for (const category of categories)
    await drawer
      .getByRole('checkbox', { name: category, exact: true })
      .setChecked(names.includes(category));
  await drawer.getByRole('button', { name: 'Selection', exact: true }).focus();
  await page.keyboard.press('Escape');
  await page.locator('.pcb-model-canvas').focus();
}
