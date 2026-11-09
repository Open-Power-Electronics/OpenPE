import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real inspector controls in an isolated browser; no Electron, service or solver.
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const bundle = await build({
  entryPoints: ['scripts/fixtures/properties-ui.jsx'],
  bundle: true,
  write: false,
  outfile: 'test-results/compact-properties.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1510, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addStyleTag({
    content: `body{overflow:auto}nav{display:flex;flex-wrap:wrap;gap:8px;padding:12px}nav button{padding:6px}main{display:flex;gap:20px;padding:12px}.column{width:var(--inspector-width);height:740px;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line)}.column>header{padding:10px 12px;background:var(--panel);font-weight:600}.column>.inspector,.column>.layout-inspector{position:static;width:100%;min-height:0;flex:1;border:0;box-shadow:none;max-height:none;max-width:none}.inspector-body{padding:var(--properties-inset)}.layout-inspector{display:flex;flex-direction:column}`,
  });
  await page.evaluate((project) => {
    window.propertiesProject = project;
  }, source);
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const fields = page.locator('.part-properties .property-fields').first();
  try {
    await fields.waitFor();
  } catch (error) {
    assert.deepEqual(errors, [], 'The inspector fixture mounts without renderer errors.');
    throw error;
  }
  assert.equal(
    await page
      .locator('.part-properties summary')
      .filter({ hasText: /^Fields$/ })
      .count(),
    0,
  );
  await fields.getByRole('button', { name: 'Add field', exact: true }).click();
  const name = fields.getByPlaceholder('Name', { exact: true }).last();
  await name.fill('Retained field');
  await name.press('Tab');
  const fieldValue = fields.getByPlaceholder('Value', { exact: true }).last();
  await fieldValue.fill('draft');
  await page.getByRole('button', { name: 'Toggle model', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle model', exact: true }).click();
  assert.equal(await name.inputValue(), 'Retained field');
  assert.equal(await fieldValue.inputValue(), 'draft');

  const componentX = page.getByLabel('Component X position', { exact: true });
  const savesBeforeGeometry = await page.evaluate(() => window.inspectorSaves);
  await componentX.fill('235.6');
  await componentX.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await componentX.press('Tab');
  assert.equal(
    await page.evaluate(() => window.inspectorSaves),
    savesBeforeGeometry,
    'Geometry edits keep their own commit handling without applying unrelated property drafts.',
  );

  const model = page.getByRole('complementary', { name: 'Solid properties settings', exact: true });
  const placement = model.locator('summary').filter({ hasText: /^Placement$/ });
  assert.equal(await placement.locator('..').getAttribute('open'), null);
  assert.equal(await model.getByRole('button', { name: 'Add hole', exact: true }).count(), 0);
  await placement.click();
  const x = model.getByLabel('Solid X position (mm)', { exact: true });
  await mkdir('test-results/compact-properties', { recursive: true });
  await page.screenshot({ path: 'test-results/compact-properties/light-model-placement.png' });
  const originalX = await x.inputValue();
  await x.fill('12.345');
  await x.press('Escape');
  assert.equal(await x.inputValue(), originalX);
  await x.fill('12.345');
  await x.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.solidApplies), 0);
  await placement.click();
  await page.getByRole('button', { name: 'Toggle model', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle model', exact: true }).click();
  await placement.click();
  assert.equal(await x.inputValue(), '12.35');
  const apply = model.getByRole('button', { name: 'Apply', exact: true });
  assert.equal(await apply.textContent(), '');
  assert.equal(await apply.getAttribute('title'), 'Apply');
  assert.equal(await apply.locator('svg').count(), 1);
  const applyBounds = await apply.boundingBox();
  assert.equal(applyBounds.width, 30);
  assert.equal(applyBounds.height, 30);
  await apply.click();
  assert.equal(await page.evaluate(() => window.solidApplies), 1);
  assert.equal(await page.evaluate(() => window.draft.position.x), 12.345);
  await placement.click();

  await mkdir('test-results/compact-properties', { recursive: true });
  const assertControlBounds = async (context) => {
    const malformedNumbers = await page
      .locator('.quantity-input > input')
      .evaluateAll((inputs) =>
        inputs
          .filter(
            (input) =>
              input.getClientRects().length &&
              input !== document.activeElement &&
              input.value &&
              input.getAttribute('aria-invalid') !== 'true' &&
              !/^-?\d+\.\d{2}$/.test(input.value),
          )
          .map((input) => ({ label: input.getAttribute('aria-label'), value: input.value })),
      );
    assert.deepEqual(
      malformedNumbers,
      [],
      `${context}: inactive engineering quantities show exactly two decimal places.`,
    );
    const clippedNumbers = await page.locator('.quantity-input > input').evaluateAll((inputs) => {
      const canvas = document.createElement('canvas'),
        context = canvas.getContext('2d');
      return inputs
        .filter(
          (input) =>
            input.getClientRects().length && input !== document.activeElement && input.value,
        )
        .flatMap((input) => {
          const style = getComputedStyle(input);
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const required = context.measureText(input.value).width;
          const available =
            input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return required > available + 1
            ? [{ label: input.getAttribute('aria-label'), value: input.value, required, available }]
            : [];
        });
    });
    assert.deepEqual(clippedNumbers, [], `${context}: two-decimal values remain readable.`);
    const nameAlignment = await page.evaluate(() => {
      const name = document.querySelector('[aria-label="Solid name"]');
      const material = document.querySelector('[aria-label="Solid material"]');
      return (
        !name ||
        !material ||
        Math.abs(name.getBoundingClientRect().left - material.getBoundingClientRect().left) < 1
      );
    });
    assert.equal(nameAlignment, true, `${context}: Model name aligns with the other value fields.`);
    const spacing = await page.evaluate(() => {
      const stacks = [
        ...document.querySelectorAll(
          '.inspector-body, .part-properties, .field-properties, .layout-inspector-content, .layout-properties-fields, .model-properties-body',
        ),
      ];
      const modelBody = document.querySelector('[aria-label="Solid dimensions"]')?.parentElement;
      if (modelBody) stacks.push(modelBody);
      return stacks.flatMap((stack) => {
        if (!stack.getClientRects().length) return [];
        const children = [...stack.children].filter(
          (child) =>
            child.getClientRects().length && getComputedStyle(child).position !== 'absolute',
        );
        return children
          .slice(1)
          .map((child, index) => ({
            stack: stack.className,
            child: child.className || child.tagName,
            gap: child.getBoundingClientRect().top - children[index].getBoundingClientRect().bottom,
          }))
          .filter((item) => Math.abs(item.gap - 8) > 1);
      });
    });
    assert.deepEqual(
      spacing,
      [],
      `${context}: property groups use one 8 px gap without stacked margins.`,
    );
    assert.equal(
      await page
        .locator('.layout-inspector summary')
        .filter({ hasText: /^(Drill offset|Fabrication|Pad details)$/ })
        .count(),
      0,
      `${context}: pad-only secondary groups stay out of Properties.`,
    );
    const fieldsBeforeIdentity = await page.locator('.column').evaluateAll((columns) =>
      columns.flatMap((column) => {
        const primary = column.querySelector('.property-primary');
        if (!primary) return [];
        return [...column.querySelectorAll('input, textarea, [role="combobox"]')]
          .filter(
            (control) =>
              control.getClientRects().length &&
              !primary.contains(control) &&
              !control.closest('details') &&
              primary.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_PRECEDING,
          )
          .map((control) => control.getAttribute('aria-label'));
      }),
    );
    assert.deepEqual(
      fieldsBeforeIdentity,
      [],
      `${context}: Reference/Value stay above all other property fields.`,
    );
    const singlesAfterGroups = await page.locator('.column').evaluateAll((columns) =>
      columns.flatMap((column) => {
        const groups = [
          ...column.querySelectorAll(
            '.layout-property-grid, .geometry-fields, [aria-label="Solid dimensions"]',
          ),
        ].filter((group) => group.getClientRects().length && !group.closest('details'));
        const first = groups[0];
        if (!first) return [];
        return [...column.querySelectorAll('input, textarea, [role="combobox"]')]
          .filter(
            (control) =>
              control.getClientRects().length &&
              !control.closest('details') &&
              !groups.some((group) => group.contains(control)) &&
              first.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING,
          )
          .map((control) => control.getAttribute('aria-label'));
      }),
    );
    assert.deepEqual(
      singlesAfterGroups,
      [],
      `${context}: single fields precede multi-column fields in DOM and Tab order.`,
    );
    const geometryGroups = await page.locator('.layout-property-grid').evaluateAll((groups) =>
      groups
        .filter((group) => group.getClientRects().length)
        .map((group) => {
          if (
            [...group.children].some(
              (field) => !field.matches('.layout-field, .layout-property-select'),
            )
          )
            return true;
          const columns = getComputedStyle(group).gridTemplateColumns.split(' ').length;
          const fields = [...group.children].map((field) => field.getBoundingClientRect());
          const tail = fields.at(-1);
          const bounds = group.getBoundingClientRect();
          const completeTail =
            columns !== 2 || fields.length % 2 === 0 || Math.abs(tail.width - bounds.width) < 1;
          const preferred = Number(group.dataset.columns);
          return (
            columns === preferred &&
            completeTail &&
            fields.every(
              (field, index) =>
                index % columns === 0 || Math.abs(field.top - fields[index - 1].top) < 1,
            )
          );
        }),
    );
    assert.ok(geometryGroups.every(Boolean), `${context}: grouped geometry retains compact rows.`);
    const solidDimensions = await page
      .locator('[aria-label="Solid dimensions"] input')
      .evaluateAll((inputs) => {
        if (!inputs.length) return true;
        const columns = getComputedStyle(
          inputs[0].closest('label').parentElement,
        ).gridTemplateColumns.split(' ').length;
        return (
          (inputs.length !== 3 || columns === 3) &&
          inputs.every(
            (input, index) =>
              index % columns === 0 ||
              Math.abs(
                input.getBoundingClientRect().top - inputs[index - 1].getBoundingClientRect().top,
              ) < 1,
          )
        );
      });
    assert.equal(
      solidDimensions,
      true,
      `${context}: solid dimensions use three columns when available.`,
    );
    const transformGroups = await page
      .locator('[aria-label="Solid position"] > div, [aria-label="Solid rotation"] > div')
      .evaluateAll((groups) =>
        groups
          .filter((group) => group.getClientRects().length)
          .every((group) => getComputedStyle(group).gridTemplateColumns.split(' ').length === 3),
      );
    assert.equal(
      transformGroups,
      true,
      `${context}: XYZ position and rotation stay in three columns.`,
    );
    const coordinates = await page
      .locator('.geometry-fields.component-geometry')
      .evaluateAll((groups) =>
        groups.map((group) => {
          const fields = [...group.children].map((field) => field.getBoundingClientRect());
          const columns = getComputedStyle(group).gridTemplateColumns.split(' ').length;
          return (
            fields.length === 3 &&
            columns === 3 &&
            fields.every(
              (field, index) =>
                index % columns === 0 || Math.abs(field.top - fields[index - 1].top) < 1,
            )
          );
        }),
      );
    assert.ok(
      coordinates.every(Boolean),
      `${context}: component X/Y/Rotation retain compact aligned rows.`,
    );
    const units = await page
      .locator('.quantity-input > .select-trigger')
      .evaluateAll((controls) =>
        controls.every(
          (control) =>
            !control.querySelector('svg') &&
            getComputedStyle(control.querySelector('.select-value')).textAlign === 'center',
        ),
      );
    assert.equal(units, true, `${context}: centered units have no chevron.`);
    const clippedUnits = await page
      .locator('.quantity-input > .select-trigger > .select-value')
      .evaluateAll((labels) =>
        labels
          .filter(
            (label) => label.getClientRects().length && label.scrollWidth > label.clientWidth + 1,
          )
          .map((label) => ({
            unit: label.textContent,
            available: label.clientWidth,
            required: label.scrollWidth,
          })),
      );
    assert.deepEqual(clippedUnits, [], `${context}: units remain fully readable.`);
    const misplaced = await page.locator('.column').evaluateAll((columns) =>
      columns.flatMap((column) => {
        const disclosure = column.querySelector('details');
        if (!disclosure) return [];
        return Array.from(column.querySelectorAll('input, textarea, .select-trigger'))
          .filter(
            (control) =>
              control.getClientRects().length &&
              !control.closest('details') &&
              !(control.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING),
          )
          .map((control) => control.getAttribute('aria-label'));
      }),
    );
    assert.deepEqual(misplaced, [], `${context}: ordinary fields precede all disclosures.`);
    const overflows = await page
      .locator('.column input, .column textarea, .column .select-trigger')
      .evaluateAll((controls) =>
        controls
          .filter((control) => {
            if (!control.getClientRects().length) return false;
            const column = control.closest('.column').getBoundingClientRect();
            const rect = control.getBoundingClientRect();
            return rect.left < column.left - 1 || rect.right > column.right + 1;
          })
          .map((control) => control.getAttribute('aria-label')),
      );
    assert.deepEqual(overflows, [], `${context}: controls stay in the dock.`);
    assert.equal(
      await page
        .locator('.layout-inspector .quantity-input > input')
        .evaluateAll((controls) =>
          controls.every((control) => getComputedStyle(control).borderWidth === '0px'),
        ),
      true,
      'Quantity controls have one outer outline.',
    );
  };
  const audit = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [280, 480]) {
      if (width === 480) await page.getByRole('button', { name: 'Resize', exact: true }).click();
      for (const choice of await page.evaluate(() => window.propertiesChoices)) {
        await page.getByRole('button', { name: choice, exact: true }).click();
        const disclosure = page.locator('.layout-inspector summary');
        const summaries = await disclosure.all();
        const tabs = await page.locator('.layout-inspector .property-tabs').getByRole('tab').all();
        for (const tab of tabs) {
          await tab.click();
          await assertControlBounds(
            `${theme} ${width}px ${choice} ${await tab.getAttribute('title')}`,
          );
        }
        if (tabs.length) await tabs[0].click();
        for (const summary of summaries) {
          await summary.click();
          await assertControlBounds(`${theme} ${width}px ${choice} expanded`);
        }
        for (const summary of summaries.reverse()) await summary.click();
        await assertControlBounds(`${theme} ${width}px ${choice}`);
        audit.push({ theme, width, choice, disclosures: summaries.length, tabs: tabs.length });
        await page.locator('.layout-inspector-content').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.mouse.move(1490, 20);
        if (width === 280 || choice === 'footprint')
          await page.screenshot({
            path: `test-results/compact-properties/${theme}-${choice}${width === 480 ? '-wide' : ''}.png`,
          });
      }
      if (width === 480) await page.getByRole('button', { name: 'Resize', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: 'via', exact: true }).click();
  await page
    .locator('.column')
    .nth(1)
    .evaluate((column) => {
      column.style.width = '224px';
    });
  await assertControlBounds('224px via');
  audit.push({ theme: 'dark', width: 224, choice: 'via' });
  const viaFields = await page
    .locator('.layout-inspector .layout-property-grid input')
    .evaluateAll((inputs) =>
      inputs.map((input) => {
        const { left, top, width } = input.getBoundingClientRect();
        return { left, top, width };
      }),
    );
  assert.equal(viaFields.length, 4);
  assert.ok(Math.abs(viaFields[0].top - viaFields[1].top) < 1);
  assert.ok(Math.abs(viaFields[2].top - viaFields[3].top) < 1);
  assert.ok(viaFields[2].top > viaFields[0].top);
  assert.ok(Math.abs(viaFields[0].left - viaFields[2].left) < 1);
  assert.ok(Math.abs(viaFields[1].left - viaFields[3].left) < 1);
  await page.screenshot({ path: 'test-results/compact-properties/dark-via-narrow.png' });
  await page
    .locator('.column')
    .nth(1)
    .evaluate((column) => {
      column.style.width = '';
    });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-step', '4px');
  });
  for (const width of [280, 480]) {
    if (width === 480) await page.getByRole('button', { name: 'Resize', exact: true }).click();
    for (const choice of ['pad', 'footprint', 'dimension', 'cylinder', 'extrusion', 'boolean']) {
      await page.getByRole('button', { name: choice, exact: true }).click();
      if (choice === 'cylinder')
        await model
          .locator('summary')
          .filter({ hasText: /^Placement$/ })
          .click();
      await assertControlBounds(`19px UI ${width}px ${choice}`);
      audit.push({ theme: 'dark', width, choice, interfaceSize: 19 });
      await page.screenshot({
        path: `test-results/compact-properties/large-${choice}-${width}.png`,
      });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/compact-properties/audit.json',
    JSON.stringify({ scenarios: audit }, null, 2) + '\n',
  );
  console.log(
    'PASS: 26 inspector cases in light/dark at 280/480 px, measured 8 px group spacing, 224 px vias, 19 px UI, retained drafts, keyboard/IME and Model Apply.',
  );
} finally {
  await browser.close();
}
