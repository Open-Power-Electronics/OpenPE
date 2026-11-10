import assert from 'node:assert/strict';
import { openSchematicPanel } from './schematic-visualization-test-helpers.mjs';

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
    assert.equal(value, String(Number(Number(value).toFixed(4))));
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

export async function checkPanelResize(page, name, defaultWidth) {
  const open = () =>
    ['List', 'Selection', 'Visible layers'].includes(name)
      ? openSchematicPanel(page, name)
      : page.getByRole('button', { name, exact: true }).click();
  const panelName = name === 'Visible layers' ? 'Visualization' : name;
  if (['Selection', 'Visualization'].includes(panelName)) {
    await open();
    const drawer = page.getByRole('group', { name: panelName, exact: true });
    const disclosure = drawer.getByRole('button', { name: panelName, exact: true });
    const body = drawer.locator('.editor-display-drawer-body');
    const dockBounds = () =>
      drawer.evaluate((element) => {
        const { x, y, width, height } = element
          .closest('.schematic-properties-dock')
          .getBoundingClientRect();
        return { x, y, width, height };
      });
    const initialDock = await dockBounds();
    const assertDock = async () => {
      const current = await dockBounds();
      for (const axis of ['x', 'y', 'width', 'height'])
        assert.ok(
          Math.abs(current[axis] - initialDock[axis]) <= 1,
          'The full sidebar keeps its bounds while a section expands or collapses.',
        );
      assert.equal(
        await drawer.evaluate((element) => {
          const dock = element.closest('.schematic-properties-dock');
          const sections = ['Properties', 'Visualization', 'Selection'].map((label) => {
            const section = dock.querySelector(`.editor-display-drawer[aria-label="${label}"]`);
            return {
              expanded: section.dataset.expanded === 'true',
              bounds: section.getBoundingClientRect(),
              header: section
                .querySelector('.editor-display-drawer-header')
                .getBoundingClientRect(),
              body: section.querySelector('.editor-display-drawer-body').getBoundingClientRect(),
            };
          });
          return (
            sections.every(
              (section, index) =>
                (index === 0 || section.bounds.top >= sections[index - 1].bounds.bottom - 1) &&
                (section.expanded ||
                  (Math.abs(section.bounds.height - section.header.height) <= 1 &&
                    section.body.height === 0)),
            ) &&
            (sections.some((section) => section.expanded) ||
              Math.abs(sections.at(-1).bounds.bottom - dock.getBoundingClientRect().bottom) <= 1)
          );
        }),
        true,
        'Properties, Visualization, Selection retain their order; only the fully collapsed stack sits at the sidebar bottom.',
      );
    };
    const assertHeaderAboveContent = async () => {
      const geometry = await drawer.evaluate((element) => {
        const header = element
          .querySelector('.editor-display-drawer-header')
          .getBoundingClientRect();
        const body = element.querySelector('.editor-display-drawer-body').getBoundingClientRect();
        return { headerBottom: header.bottom, bodyTop: body.top };
      });
      assert.ok(
        geometry.bodyTop >= geometry.headerBottom - 1,
        `${panelName} header precedes its content`,
      );
    };
    await body.waitFor({ state: 'visible' });
    await assertHeaderAboveContent();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(await drawer.locator('.inspector-resize').count(), 0);
    assert.equal(await page.getByRole('dialog', { name: panelName, exact: true }).count(), 0);
    assert.equal(
      await page
        .getByRole('group', { name: 'Analysis and display', exact: true })
        .getByRole('button', { name: panelName, exact: true })
        .count(),
      0,
      `${panelName} is accessed from the sidebar disclosure`,
    );
    assert.equal(
      await drawer.evaluate((element) => !!element.closest('.schematic-properties-dock')),
      true,
      `${panelName} belongs to the retained right sidebar`,
    );
    const checkbox = drawer.getByRole('checkbox').first();
    const checked = await checkbox.isChecked();
    await checkbox.setChecked(!checked);
    await disclosure.click();
    await body.waitFor({ state: 'hidden' });
    await assertDock();
    await disclosure.click();
    await body.waitFor({ state: 'visible' });
    await assertDock();
    await assertHeaderAboveContent();
    assert.equal(await checkbox.isChecked(), !checked, 'Collapsing retains display settings');
    await checkbox.setChecked(checked);
    await page.getByTestId('schematic-canvas').focus();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(
      await drawer.evaluate((element) => element.contains(document.activeElement)),
      false,
      'An expanded drawer permits focus in the editor',
    );
    await checkbox.focus();
    await checkbox.dispatchEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 229,
      isComposing: true,
      bubbles: true,
    });
    assert.equal(
      await disclosure.getAttribute('aria-expanded'),
      'true',
      'IME Escape does not collapse a drawer',
    );
    await checkbox.press('Escape');
    await body.waitFor({ state: 'hidden' });
    await assertDock();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await disclosure.evaluate((element) => element === document.activeElement), true);
    return;
  }
  const panel = page.getByRole('dialog', { name: panelName, exact: true });
  const corner = panel.getByRole('button', {
    name: `Resize ${panelName.toLowerCase()} bottom right`,
    exact: true,
  });
  await open();
  const input = panel.getByRole('textbox').first();
  if (await input.count()) await input.fill('Uncommitted name');
  const initial = await panel.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    Math.abs(initial.width - Math.min(defaultWidth, viewport.width - 48)) < 2,
    `${name} default width`,
  );
  assert.equal(await panel.getAttribute('aria-modal'), 'true');
  assert.equal(
    await panel.evaluate((element) => element.classList.contains('surface-dialog-anchored')),
    false,
  );
  assert.ok(Math.abs(initial.x + initial.width / 2 - viewport.width / 2) < 2);
  const start = await corner.boundingBox();
  assert.equal(await panel.locator('.dialog-resize-edge').count(), 8);
  assert.ok(Math.abs(start.x + start.width - initial.x - initial.width) < 2);
  assert.ok(Math.abs(start.y + start.height - initial.y - initial.height) < 2);
  const x = start.x + start.width / 2,
    y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 48, y + 24, { steps: 6 });
  let changed = await panel.boundingBox();
  assert.ok(changed.width > initial.width + 40, `${name} can be widened`);
  assert.ok(Math.abs(changed.x - initial.x) < 2);
  assert.ok(Math.abs(changed.y - initial.y) < 2);
  if (await input.count()) {
    assert.equal(await input.inputValue(), 'Uncommitted name');
    assert.equal(await input.evaluate((el) => document.activeElement === el), true);
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.ok(await panel.isVisible(), 'Escape cancels resizing without dismissing the panel');
  assert.ok(Math.abs((await panel.boundingBox()).width - initial.width) < 2);
  await corner.press('ArrowRight');
  changed = await panel.boundingBox();
  assert.ok(Math.abs(changed.width - initial.width - 16) < 2);
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await open();
  assert.ok(
    Math.abs((await panel.boundingBox()).width - changed.width) < 2,
    'Size survives reopening',
  );
  await corner.press('Home');
  assert.ok(Math.abs((await panel.boundingBox()).width - initial.width) < 2);
  const reset = await corner.boundingBox();
  await page.mouse.move(reset.x + 9, reset.y + 9);
  await page.mouse.down();
  await page.mouse.move(viewport.width + 600, viewport.height + 600, { steps: 6 });
  await page.mouse.up();
  const oversized = await panel.boundingBox();
  assert.ok(
    oversized.x >= 23 &&
      oversized.y >= 23 &&
      oversized.x + oversized.width <= viewport.width - 23 &&
      oversized.y + oversized.height <= viewport.height - 23,
    'The independent window remains within the viewport margin',
  );
  await corner.dblclick();
  assert.ok(Math.abs((await panel.boundingBox()).width - initial.width) < 2);
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
}
