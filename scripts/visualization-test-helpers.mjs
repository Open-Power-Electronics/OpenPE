import assert from 'node:assert/strict';

export async function assertEditorViewControls(page, selectedView) {
  const views = page.getByRole('group', { name: 'Editor view', exact: true });
  assert.deepEqual(
    await views
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ['Schematic', 'Layout', 'Model', 'Source'],
  );
  assert.equal(await page.locator('.project-file-tabs').count(), 0);
  assert.equal(await views.locator('[aria-pressed="true"]').count(), 1);
  const close = page
    .locator('.app-header:visible')
    .getByRole('button', { name: 'Close project', exact: true });
  assert.equal(await close.count(), 1);
  const closeGeometry = await close.evaluate((button) => {
    const bounds = button.getBoundingClientRect(),
      row = button.closest('.app-header').getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      width: bounds.width,
      height: bounds.height,
      inset: row.right - bounds.right,
      offset: bounds.y + bounds.height / 2 - row.y - row.height / 2,
      color: style.color,
      icon: button.querySelector('svg')?.classList.contains('lucide-x'),
    };
  });
  assert.deepEqual([closeGeometry.width, closeGeometry.height], [32, 32]);
  const [red, green, blue] = closeGeometry.color.match(/[\d.]+/g).map(Number);
  assert.ok(red > green && red > blue, 'Header project close uses red ink.');
  assert.equal(closeGeometry.icon, true);
  assert.equal(await page.locator('.editor-mode-bar .header-project-close').count(), 0);
  assert.ok(Math.abs(closeGeometry.inset - 12) <= 1 && Math.abs(closeGeometry.offset) <= 1);
  const selected = views.getByRole('button', { name: selectedView, exact: true });
  assert.equal(await selected.getAttribute('aria-pressed'), 'true');
  await page.waitForFunction((name) => {
    const button = document.querySelector('.editor-mode-bar button[aria-pressed="true"]');
    const label = button?.querySelector('.reveal-button-label');
    return (
      button?.getAttribute('aria-label') === name &&
      label &&
      Number(getComputedStyle(label).opacity) >= 0.99 &&
      label.getBoundingClientRect().width >= label.querySelector('span').scrollWidth - 1
    );
  }, selectedView);
  const geometry = await selected.evaluate((button) => {
    const header = button.closest('.editor-mode-bar'),
      editor = button.closest('.editor');
    const bounds = button.getBoundingClientRect(),
      bar = header.getBoundingClientRect(),
      root = editor.getBoundingClientRect();
    const targets = [...header.querySelectorAll('.editor-view-switch button')].map(
      (element) => element.getBoundingClientRect().width,
    );
    const icons = [...header.querySelectorAll('button > svg')].map((element) => {
      const { y, width, height } = element.getBoundingClientRect();
      return { offset: y + height / 2 - bar.y - bar.height / 2, width, height };
    });
    const style = getComputedStyle(button);
    // Sample below the mode row itself, whether the next surface is the
    // schematic-file row or editor content. A child view's stacking context
    // must not paint over the active tab's bottom mask.
    const seamCovered = [0.25, 0.5].every((offset) => {
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bar.bottom + offset);
      return hit === button || button.contains(hit);
    });
    return {
      left: bar.x - root.x,
      top: bar.y - root.y,
      inset: bounds.left - bar.left,
      height: bounds.height,
      headerHeight: bar.height,
      weight: style.fontWeight,
      targets,
      icons,
      seamCovered,
    };
  });
  assert.ok(geometry.left >= 0 && geometry.left <= 1);
  assert.ok(geometry.top >= 0 && geometry.top <= 1);
  assert.ok(geometry.inset >= 8 && geometry.height >= 36 && geometry.headerHeight >= 44);
  assert.ok(Number(geometry.weight) >= 600);
  assert.ok(geometry.targets.every((width) => width >= 44));
  assert.ok(
    geometry.icons.every(
      ({ offset, width, height }) => width === 17 && height === 17 && Math.abs(offset) <= 0.5,
    ),
    `${selectedView}: view and project-action icons are the same size and centered in the mode row.`,
  );
  assert.ok(
    geometry.seamCovered,
    `${selectedView}: the active tab covers the mode-row/content seam.`,
  );
}

export async function assertToolbarSidebarPlacement(toolbar) {
  const editor = toolbar.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " editor ")][1]',
  );
  const actions = editor.locator('.editor-mode-actions');
  const toggle = actions.getByRole('button', { name: 'Toggle right sidebar', exact: true });
  assert.equal(await toggle.count(), 1);
  assert.deepEqual(
    await actions
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ['List', 'Git', 'Toggle right sidebar'],
  );
  const geometry = await actions.evaluate((group) => {
    const row = group.closest('.editor-mode-bar').getBoundingClientRect();
    const buttons = [...group.querySelectorAll('button')].map((button) =>
      button.getBoundingClientRect(),
    );
    return buttons.map((box, index) => ({
      width: box.width,
      height: box.height,
      offset: box.y + box.height / 2 - row.y - row.height / 2,
      gap: index ? box.left - buttons[index - 1].right : 0,
    }));
  });
  assert.ok(
    geometry.every(
      (button) => button.width === 30 && button.height === 30 && Math.abs(button.offset) <= 1,
    ),
  );
  assert.ok(geometry.slice(1).every((button) => Math.abs(button.gap - 4) <= 0.1));
}

export async function assertProjectCloseReveal(page, theme) {
  const close = page.locator('.app-header .header-project-close');
  const selectedView = page.locator('.editor-view-switch [aria-pressed="true"]');
  const waitForLabel = (expanded) =>
    page.waitForFunction((expanded) => {
      const label = document.querySelector('.header-project-close .reveal-button-label');
      if (!label) return false;
      const width = label.getBoundingClientRect().width;
      const opacity = Number(getComputedStyle(label).opacity);
      return expanded
        ? opacity >= 0.99 && width >= label.firstElementChild.scrollWidth - 1
        : opacity <= 0.01 && width < 1;
    }, expanded);
  await page.mouse.move(0, 0);
  await selectedView.focus();
  await waitForLabel(false);
  const collapsed = await close.boundingBox();
  assert.equal(collapsed.width, 32);
  assert.equal(await close.getAttribute('title'), null, 'The revealed label replaces the tooltip.');
  await close.hover();
  await waitForLabel(true);
  const expanded = await close.boundingBox();
  assert.ok(expanded.width > collapsed.width + 50);
  assert.ok(Math.abs(expanded.x + expanded.width - collapsed.x - collapsed.width) < 1);
  assert.equal(expanded.height, collapsed.height);
  await page.screenshot({ path: `test-results/project-close-reveal-${theme}.png` });
  await page.mouse.move(0, 0);
  await waitForLabel(false);
  await page.getByRole('combobox', { name: 'File', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await close.evaluate((button) => button === document.activeElement), true);
  await waitForLabel(true);
  await selectedView.focus();
  await waitForLabel(false);
  const motion = await page.evaluate(() => {
    const previous = document.documentElement.getAttribute('data-motion');
    document.documentElement.setAttribute('data-motion', 'reduced');
    return previous;
  });
  try {
    await close.hover();
    await waitForLabel(true);
    assert.equal(
      await close
        .locator('.reveal-button-label')
        .evaluate((label) => getComputedStyle(label).transitionDuration),
      '0s',
    );
  } finally {
    await page.mouse.move(0, 0);
    await page.evaluate((previous) => {
      if (previous === null) document.documentElement.removeAttribute('data-motion');
      else document.documentElement.setAttribute('data-motion', previous);
    }, motion);
  }
  await waitForLabel(false);
}

export async function openDisplayDrawer(page, name) {
  const drawer = page.getByRole('group', { name, exact: true });
  if (!(await drawer.isVisible()))
    await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click();
  const disclosure = drawer.getByRole('button', { name, exact: true });
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
  return drawer.locator('.editor-display-drawer-body');
}

export async function closeDisplayDrawer(page, name) {
  const drawer = page.getByRole('group', { name, exact: true });
  if (!(await drawer.isVisible())) return;
  const disclosure = drawer.getByRole('button', { name, exact: true });
  if ((await disclosure.getAttribute('aria-expanded')) === 'true') await disclosure.click();
}

export async function openVisualization(page) {
  return openDisplayDrawer(page, 'Visualization');
}

export async function selectModelVisualizationTab(page, name) {
  const body = await openVisualization(page);
  await body.getByRole('tab', { name, exact: true }).click();
  return body;
}

export async function closeVisualization(page) {
  await closeDisplayDrawer(page, 'Visualization');
}

const layoutSections = new WeakMap();
const layoutObjectVisibility = new Set([
  'Footprints',
  'Pad numbers',
  'Pad net names',
  'Airwires',
  'Zone outlines',
  'Filled zones',
]);
const layoutAppearance = (page) =>
  page.locator('section.layout-appearance[aria-label="Appearance"]');

async function showLayoutSection(page, section) {
  if (section === 'Selection') {
    await openDisplayDrawer(page, section);
    return;
  }
  await closeDisplayDrawer(page, 'Selection');
  const visualization = await openVisualization(page);
  const tab =
    section === 'Net visibility' ? 'Nets' : section === 'Visible objects' ? 'Objects' : 'Layers';
  await visualization.getByRole('tab', { name: tab, exact: true }).click();
}

export async function toggleLayoutVisualization(page, section) {
  if (layoutSections.get(page) === section) {
    layoutSections.delete(page);
    await closeDisplayDrawer(page, section === 'Selection' ? section : 'Visualization');
    await page.getByTestId('layout-canvas').focus();
    return;
  }
  layoutSections.set(page, section);
  await showLayoutSection(page, section);
}

/** Choose an explicit drawing layer without toggling an already selected row off. */
export async function selectLayoutLayer(page, name) {
  await showLayoutSection(page, 'Visible layers');
  const button = layoutAppearance(page)
    .getByRole('group', { name: 'Visible layers', exact: true })
    .getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.getByTestId('layout-canvas').focus();
}

/** Locate object visibility independently from same-named selection filters. */
export async function setLayoutVisibility(page, name, checked) {
  const section = layoutObjectVisibility.has(name) ? 'Visible objects' : 'Visible layers';
  await showLayoutSection(page, section);
  await layoutAppearance(page)
    .getByRole('group', { name: section, exact: true })
    .getByRole('checkbox', { name, exact: true })
    .setChecked(checked);
  layoutSections.delete(page);
  await page.getByTestId('layout-canvas').focus();
}

export async function readModelVisibility(page, name) {
  const body = await selectModelVisualizationTab(page, 'Display');
  const checked = await body.getByRole('checkbox', { name, exact: true }).isChecked();
  await closeVisualization(page);
  return checked;
}

export async function toggleModelVisibility(page, name) {
  const body = await selectModelVisualizationTab(page, 'Display');
  await body.getByRole('checkbox', { name, exact: true }).click();
  await closeVisualization(page);
}

export async function selectModelView(page, name) {
  const body = await selectModelVisualizationTab(page, 'Views');
  await body.getByRole('button', { name, exact: true }).click();
}
