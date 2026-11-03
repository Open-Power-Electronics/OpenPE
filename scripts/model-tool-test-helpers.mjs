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
  const trigger = page.getByRole('combobox', { name: menu, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  // Settle focus scrolling before opening the scroll-dismissed anchored popup.
  await trigger.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await trigger.press('ArrowDown');
  const targetId = await page.getByRole('option', { name: label, exact: true }).getAttribute('id');
  const enabled = await page
    .getByRole('option')
    .evaluateAll((options) =>
      options
        .filter((option) => option.getAttribute('aria-disabled') !== 'true')
        .map((option) => option.id),
    );
  const index = enabled.indexOf(targetId);
  if (index < 0) throw new Error(`The Model tool is unavailable: ${label}`);
  await trigger.press('Home');
  for (let step = 0; step < index; step++) await trigger.press('ArrowDown');
  await trigger.press('Enter');
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
