import assert from 'node:assert/strict';

export async function checkComponentDeletePlacement(inspector) {
  const action = inspector.getByRole('button', { name: 'Delete object', exact: true });
  assert.equal(await inspector.locator('.inspector-footer').count(), 0);
  assert.equal(
    await action.evaluate((button) => {
      const row = button.closest('.property-tabs-row');
      const bounds = button.getBoundingClientRect();
      const strip = row?.getBoundingClientRect();
      const dock = button.closest('.inspector').getBoundingClientRect();
      const tabList = row?.querySelector('[role="tablist"]');
      const fields = row?.nextElementSibling?.getBoundingClientRect();
      return (
        !!strip &&
        !!fields &&
        strip.right <= dock.right &&
        Math.abs(strip.right - bounds.right) < 1 &&
        Math.abs((strip.top + strip.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 1 &&
        fields.top >= strip.bottom &&
        (!tabList ||
          (!tabList.contains(button) && tabList.getBoundingClientRect().right <= bounds.left))
      );
    }),
    true,
    'Component deletion sits to the right of the tabs and above the fields.',
  );
}

// Shared Schematic panel and Properties checks for desktop and isolated Workbench tests.
export async function checkInspectorResize(page, inspector) {
  assert.equal(
    await inspector.evaluate((element) => !!element.closest('.schematic-properties-dock')),
    true,
    'Schematic Properties uses the docked inspector.',
  );
  const dock = inspector.locator('xpath=ancestor::*[@data-testid="schematic-properties-panel"]');
  const handle = dock
    .locator('..')
    .getByRole('button', { name: 'Resize properties width', exact: true });
  const initial = await dock.boundingBox();
  const input = inspector.getByLabel('Component value', { exact: true });
  await input.focus();
  const value = await input.inputValue();
  const start = await handle.boundingBox();
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 64, y, { steps: 5 });
  const expanded = await dock.boundingBox();
  assert.ok(expanded.width > initial.width, 'Dragging left expands the docked inspector.');
  assert.ok(Math.abs(expanded.x + expanded.width - initial.x - initial.width) < 2);
  assert.equal(expanded.y, initial.y);
  assert.equal(expanded.height, initial.height);
  assert.equal(await input.inputValue(), value);
  assert.equal(await input.evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.ok(Math.abs((await dock.boundingBox()).width - initial.width) < 2);

  await handle.press('ArrowLeft');
  assert.ok(Math.abs((await dock.boundingBox()).width - initial.width - 16) < 2);
  await handle.press('Home');
  assert.ok(Math.abs((await dock.boundingBox()).width - initial.width) < 2);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 1000, y, { steps: 5 });
  await page.mouse.up();
  assert.equal(
    await dock.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const row = element.parentElement.getBoundingClientRect();
      return panel.left - row.left >= 159 && panel.right <= row.right + 1;
    }),
    true,
    'The expanded dock leaves room for the drawing.',
  );
  await handle.press('Home');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 1000, y, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs((await dock.boundingBox()).width - 280) < 1);
  await checkComponentDeletePlacement(inspector);
  await handle.dblclick();
  assert.ok(Math.abs((await dock.boundingBox()).width - initial.width) < 2);
}

export async function checkFieldProperties(page, inspector) {
  const x = inspector.getByLabel('Text X position', { exact: true });
  const y = inspector.getByLabel('Text Y position', { exact: true });
  await x.waitFor();
  assert.equal(await inspector.getByLabel('Component X position', { exact: true }).count(), 0);
  assert.equal(await inspector.getByLabel('Component rotation', { exact: true }).count(), 0);
  assert.equal(
    await inspector.getByRole('button', { name: 'Delete object', exact: true }).count(),
    0,
  );
  const original = await x.inputValue();
  for (const input of [x, y]) {
    const value = await input.inputValue();
    assert.match(value, /^-?\d+\.\d{2}$/);
    await input.focus();
    await input.press('Tab');
  }
  const xb = await x.boundingBox(),
    yb = await y.boundingBox();
  assert.ok(
    Math.abs(xb.y - yb.y) < 2 && xb.x + xb.width <= yb.x,
    'Text coordinates share one row.',
  );
  await x.fill('100001');
  await x.press('Enter');
  await inspector
    .getByRole('alert')
    .filter({ hasText: 'Position must be between -100000 and 100000 mm.' })
    .waitFor();
  assert.equal(Number(await x.inputValue()), 100001, 'Invalid drafts retain their numeric value.');
  await x.press('Escape');
  assert.equal(await x.inputValue(), original);
  assert.equal(await inspector.getByRole('alert').count(), 0);
}
