import assert from 'node:assert/strict';

export async function assertEditorViewControls(page, selectedView) {
  const views = page.getByRole('group', { name: 'Editor view', exact: true });
  assert.deepEqual(
    await views
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ['Schematic', 'Layout', 'Model', 'Source', 'Git'],
  );
  assert.equal(await views.locator('[aria-pressed="true"]').count(), 1);
  assert.equal(
    await views
      .getByRole('button', { name: selectedView, exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.waitForFunction((name) => {
    const selected = document.querySelector('.editor-view-switch button[aria-pressed="true"]');
    const label = selected?.querySelector('.reveal-button-label');
    return (
      selected?.getAttribute('aria-label') === name &&
      label &&
      Number(getComputedStyle(label).opacity) >= 0.99 &&
      label.getBoundingClientRect().width > 0 &&
      label.getAnimations().every((animation) => animation.playState !== 'running')
    );
  }, selectedView);
  const geometry = await views.evaluate((element) => {
    const editor = element.closest('.editor');
    const bar = element.closest('.document-bar');
    const files = bar?.querySelector('.project-file-tabs');
    const selected = element.querySelector('[aria-pressed="true"]');
    const tab = selected.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const documentBar = bar?.getBoundingClientRect();
    const fileTabs = files?.getBoundingClientRect();
    const style = getComputedStyle(selected);
    const groupStyle = getComputedStyle(element);
    const file = files?.querySelector('.file-tab.active');
    const fileStyle = file && getComputedStyle(file);
    const newFile = bar?.querySelector('button[aria-label="New file"]');
    const companion = bar?.querySelector('.schematic-open-file') ?? files;
    const addBounds = newFile?.getBoundingClientRect();
    const companionBounds = companion?.getBoundingClientRect();
    const toolbar = editor?.querySelector('.editor-toolbar:not([hidden]), .source-editor-toolbar');
    const editorStyle = getComputedStyle(editor);
    const hostStyle = getComputedStyle(element.parentElement);
    const inactive = element.querySelector('[aria-pressed="false"]');
    const label = selected.querySelector('.reveal-button-label');
    const labelText = label.querySelector('span');
    return {
      inDocumentBar: Boolean(bar && files),
      headerViews: document.querySelectorAll('.app-header .editor-view-switch').length,
      bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom },
      bar: documentBar && {
        x: documentBar.x,
        y: documentBar.y,
        right: documentBar.right,
        bottom: documentBar.bottom,
        height: documentBar.height,
      },
      fileGap: fileTabs && bounds.x - fileTabs.right,
      groupBorder: parseFloat(hostStyle.borderLeftWidth),
      groupInset: parseFloat(hostStyle.paddingLeft),
      tabGap: parseFloat(groupStyle.columnGap),
      label: {
        text: label.textContent.trim(),
        opacity: Number(getComputedStyle(label).opacity),
        width: label.getBoundingClientRect().width,
        contentWidth: labelText.scrollWidth,
        weight: Number(style.fontWeight),
      },
      outerGroup: {
        radius: groupStyle.borderRadius,
        topBorder: groupStyle.borderTopWidth,
        background: groupStyle.backgroundColor,
      },
      tabCorners: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ],
      fileCorners: fileStyle && [
        fileStyle.borderTopLeftRadius,
        fileStyle.borderTopRightRadius,
        fileStyle.borderBottomRightRadius,
        fileStyle.borderBottomLeftRadius,
      ],
      newFile: {
        followsFiles: Boolean(
          newFile &&
          files &&
          files.compareDocumentPosition(newFile) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        beforeViews: Boolean(
          newFile && newFile.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        gap: addBounds && companionBounds && addBounds.left - companionBounds.right,
        bottom: addBounds?.bottom,
      },
      tabColor: style.backgroundColor,
      tabTopBorderColor: style.borderTopColor,
      fileColor: fileStyle?.backgroundColor,
      toolbarColor: toolbar && getComputedStyle(toolbar).backgroundColor,
      tabSeam: documentBar && documentBar.bottom - tab.bottom,
      fileSeam: documentBar && file && documentBar.bottom - file.getBoundingClientRect().bottom,
      inactiveColor: getComputedStyle(inactive).backgroundColor,
      inactiveLabelDisplay: getComputedStyle(inactive.querySelector('.reveal-button-label'))
        .display,
      editorCorners: [
        editorStyle.borderTopLeftRadius,
        editorStyle.borderTopRightRadius,
        editorStyle.borderBottomRightRadius,
        editorStyle.borderBottomLeftRadius,
      ],
      height: tab.height,
      heightLimit: Math.max(
        38,
        parseFloat(style.lineHeight) +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth) +
          1,
      ),
      widths: [...element.querySelectorAll('button')].map(
        (button) => button.getBoundingClientRect().width,
      ),
    };
  });
  assert.equal(geometry.inDocumentBar, true, 'View controls share the file-tab row.');
  assert.equal(geometry.headerViews, 0, 'The app header no longer contains editor view controls.');
  assert.ok(
    geometry.bounds.y >= geometry.bar.y && geometry.bounds.bottom <= geometry.bar.bottom + 1,
  );
  assert.ok(geometry.bounds.x >= geometry.bar.x && geometry.bounds.right <= geometry.bar.right + 1);
  assert.ok(geometry.fileGap >= 8, 'Space separates document tabs from view controls.');
  assert.equal(
    geometry.groupBorder,
    0,
    'View controls use spacing without an extra vertical rule.',
  );
  assert.equal(geometry.groupInset, 12);
  assert.equal(geometry.tabGap, 6, 'Space separates the individual view tabs.');
  assert.equal(geometry.label.text, selectedView);
  assert.equal(geometry.label.opacity, 1, 'The active view label remains visible.');
  assert.ok(
    geometry.label.width > 0 && geometry.label.width >= geometry.label.contentWidth - 1,
    'The active view label finishes expanding without clipping.',
  );
  assert.ok(geometry.label.weight >= 600, 'The active view label has a distinct weight.');
  assert.equal(
    geometry.newFile.followsFiles && geometry.newFile.beforeViews,
    true,
    'New file remains beside the left document tabs, before the right view controls.',
  );
  assert.ok(
    geometry.newFile.gap >= 0 && geometry.newFile.gap <= 12,
    'The plus button immediately follows file tabs or their adjacent Open file control.',
  );
  assert.ok(
    Math.abs(geometry.newFile.bottom - geometry.bounds.bottom) <= 1,
    'New file and the taller tabs share the document-bar baseline.',
  );
  assert.ok(geometry.bar.height >= 44, 'The document bar gives the taller tabs room to grow.');
  assert.equal(
    geometry.outerGroup.radius,
    '0px',
    'View controls are individual tabs, without a capsule.',
  );
  assert.equal(geometry.outerGroup.topBorder, '0px');
  assert.equal(geometry.outerGroup.background, 'rgba(0, 0, 0, 0)');
  assert.equal(
    geometry.tabTopBorderColor,
    'rgba(0, 0, 0, 0)',
    'The active view tab does not draw a horizontal top border.',
  );
  for (const corners of [geometry.tabCorners, geometry.fileCorners]) {
    assert.ok(parseFloat(corners[0]) > 0 && parseFloat(corners[1]) > 0);
    assert.deepEqual(
      corners.slice(2),
      ['0px', '0px'],
      'File and view tabs have square lower corners.',
    );
  }
  assert.equal(
    geometry.tabColor,
    geometry.toolbarColor,
    'The selected view tab shares the surface below.',
  );
  assert.equal(
    geometry.fileColor,
    geometry.toolbarColor,
    'The selected file tab shares the surface below.',
  );
  for (const seam of [geometry.tabSeam, geometry.fileSeam])
    assert.ok(seam >= -1 && seam <= 2, 'Active tabs meet the lower document-bar seam.');
  assert.notEqual(
    geometry.tabColor,
    geometry.inactiveColor,
    'The active view remains distinguishable.',
  );
  assert.equal(geometry.inactiveColor, 'rgba(0, 0, 0, 0)', 'Inactive view tabs stay unfilled.');
  assert.notEqual(geometry.inactiveLabelDisplay, 'none');
  const inactive = views.locator('[aria-pressed="false"]').first();
  const inactiveName = await inactive.getAttribute('aria-label');
  const beforeHover = await inactive.evaluate((button) => button.getBoundingClientRect().width);
  await inactive.hover();
  await page.waitForFunction((name) => {
    const button = [...document.querySelectorAll('.editor-view-switch button')].find(
      (button) => button.getAttribute('aria-label') === name,
    );
    const label = button?.querySelector('.reveal-button-label');
    return (
      label &&
      Number(getComputedStyle(label).opacity) >= 0.99 &&
      label.getBoundingClientRect().width >= label.querySelector('span').scrollWidth - 1 &&
      label.getAnimations().every((animation) => animation.playState !== 'running')
    );
  }, inactiveName);
  assert.ok(
    (await inactive.evaluate((button) => button.getBoundingClientRect().width)) > beforeHover,
    'Hover reveals the inactive view label without clipping.',
  );
  await views.getByRole('button', { name: selectedView, exact: true }).hover();
  await page.waitForFunction((name) => {
    const button = [...document.querySelectorAll('.editor-view-switch button')].find(
      (button) => button.getAttribute('aria-label') === name,
    );
    const label = button?.querySelector('.reveal-button-label');
    return (
      label &&
      Number(getComputedStyle(label).opacity) <= 0.01 &&
      label.getBoundingClientRect().width <= 1 &&
      label.getAnimations().every((animation) => animation.playState !== 'running')
    );
  }, inactiveName);
  const radius = geometry.editorCorners[0];
  assert.deepEqual(
    geometry.editorCorners,
    [radius, radius, radius, radius],
    'The editor retains its rounded outer corners in every view.',
  );
  assert.ok(
    geometry.widths.every((width) => width >= 44),
    'All five view targets stay usable.',
  );
  assert.ok(
    geometry.height >= 36 && geometry.height <= geometry.heightLimit,
    'View tabs use taller targets and grow with the configured typography.',
  );
}

export async function assertToolbarSidebarPlacement(toolbar) {
  const toggle = toolbar.getByRole('button', { name: 'Toggle right sidebar', exact: true });
  assert.equal(
    await toggle.count(),
    1,
    'Each drawing toolbar retains one dock visibility control.',
  );
  const geometry = await toggle.evaluate((element) => {
    const group = element.closest('.editor-view-controls');
    const toolbar = element.closest('.editor-toolbar');
    const previous = toolbar?.querySelector('button[aria-label="Parts list"]');
    const toggle = element.getBoundingClientRect();
    const previousBounds = previous?.getBoundingClientRect();
    const source = toolbar
      ?.closest('.editor')
      ?.querySelector('.editor-view-switch button[aria-label="Git"]')
      ?.getBoundingClientRect();
    const tools = toolbar?.getBoundingClientRect();
    const style = group && getComputedStyle(group);
    const divider = group && getComputedStyle(group, '::before');
    const groupBounds = group?.getBoundingClientRect();
    const dividerHeight = divider && parseFloat(divider.height);
    const dividerShift =
      divider?.transform && divider.transform !== 'none' ? new DOMMatrix(divider.transform).m42 : 0;
    return {
      grouped: Boolean(group),
      outsideDocumentBar: !element.closest('.document-bar'),
      afterParts: Boolean(
        previous && previous.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      gap: previousBounds && toggle.left - previousBounds.right,
      aligned: previousBounds && Math.abs(toggle.top - previousBounds.top),
      viewAligned:
        source && Math.abs(toggle.left + toggle.width / 2 - source.left - source.width / 2),
      bounded:
        tools &&
        toggle.top >= tools.top &&
        toggle.bottom <= tools.bottom + 1 &&
        toggle.right <= tools.right + 1,
      border: style && parseFloat(style.borderLeftWidth),
      padding: style && parseFloat(style.paddingLeft),
      dividerHeight,
      dividerWidth: divider && parseFloat(divider.width),
      dividerCenter:
        divider && groupBounds
          ? Math.abs(
              parseFloat(divider.top) + dividerShift + dividerHeight / 2 - groupBounds.height / 2,
            )
          : null,
    };
  });
  assert.equal(geometry.grouped && geometry.outsideDocumentBar && geometry.afterParts, true);
  assert.equal(geometry.bounded, true, 'Dock visibility stays inside the toolbar.');
  if (geometry.viewAligned !== undefined)
    assert.ok(
      geometry.viewAligned <= 1,
      `The rightmost controls share a center line across rows (${geometry.viewAligned}px offset).`,
    );
  assert.ok(
    geometry.gap >= 8 && geometry.aligned <= 1,
    'Dock visibility follows Parts list on the same row with clearance.',
  );
  assert.ok(
    geometry.border === 0 && geometry.padding === 8,
    'Dock visibility keeps clearance without a full-height border.',
  );
  assert.equal(geometry.dividerHeight, 18, 'Dock visibility uses one compact divider.');
  assert.equal(geometry.dividerWidth, 1);
  assert.ok(geometry.dividerCenter <= 1, 'The compact divider stays vertically centered.');
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
  'Copper preview',
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
