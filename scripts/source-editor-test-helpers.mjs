import { projectFromNativeFiles, projectNativeFiles } from '../server/project-format.mjs';

// Read through the public Copy action: the editor virtualizes long documents,
// so textContent is incomplete. Intercept this one copy without using the OS clipboard.
export async function readSource(page) {
  await page.evaluate(() => {
    window.sourceTestCopy = { original: navigator.clipboard.writeText, text: null };
    navigator.clipboard.writeText = async (text) => {
      window.sourceTestCopy.text = text;
    };
  });
  try {
    await page
      .getByRole('region', { name: 'Project source', exact: true })
      .getByRole('button', { name: 'Copy', exact: true })
      .click();
    return await page.evaluate(() => window.sourceTestCopy.text);
  } finally {
    await page.evaluate(() => {
      navigator.clipboard.writeText = window.sourceTestCopy.original;
      delete window.sourceTestCopy;
    });
  }
}

// Project history lives with drawing tools; Source keeps its own text undo/redo.
export async function projectHistory(page, action) {
  const sourceVisible = await page
    .getByRole('region', { name: 'Project source', exact: true })
    .isVisible();
  if (sourceVisible) await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  if (sourceVisible) await page.getByRole('button', { name: 'Source', exact: true }).click();
}

export async function fillSource(page, text) {
  const editor = page.getByRole('textbox', { name: 'Project file source', exact: true });
  await editor.focus();
  await editor.press('ControlOrMeta+a');
  // Paste is exact replacement. Typing a single opening bracket intentionally
  // wraps a selection through the editor's automatic closing behavior.
  await editor.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}
// Read the real selected native files through Source's public file list and Copy.
// The returned Project is an explicit test-side native parser result, never a
// hidden renderer snapshot or an alternate meaning of readSource.
export async function selectSourceFile(page, name) {
  const navigation = page.getByRole('navigation', { name: 'Project files', exact: true });
  await navigation.waitFor({ state: 'visible' });
  const parts = name.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const path = parts.slice(0, depth).join('/');
    const folders = navigation.locator('button[data-source-folder]');
    const index = await folders.evaluateAll(
      (items, path) => items.findIndex((item) => item.dataset.sourceFolder === path),
      path,
    );
    if (index < 0) throw new Error(`Source folder is missing: ${path}`);
    const folder = folders.nth(index);
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  }
  await navigation.getByRole('button', { name, exact: true }).click();
}

export async function readNativeFiles(page) {
  const navigation = page.getByRole('navigation', { name: 'Project files', exact: true });
  await navigation.waitFor({ state: 'visible' });
  // Collapsed folders retain mounted file rows, so collect the complete native
  // set independently of visibility and expand ancestors only when selecting.
  // Directory observations (including text STEP files) are outside Core/native
  // design. Source marks them private independently of whether they are editable.
  const buttons = navigation.locator('button[data-source-file]:not([data-agent-private])');
  await buttons.first().waitFor({ state: 'attached' });
  const names = await buttons.evaluateAll((items) => items.map((item) => item.dataset.sourceFile));
  if (!names.length) throw new Error('Open Source before reading its native project files.');
  const selected = await navigation
    .locator('[aria-current="page"]')
    .getAttribute('data-source-file');
  const files = [];
  try {
    for (const name of names) {
      await selectSourceFile(page, name);
      const encoding = (
        await page.locator('.source-editor .status-format').textContent()
      )?.includes('ISO-8859-1');
      files.push({
        name,
        source: await readSource(page),
        ...(encoding ? { encoding: 'latin1' } : {}),
      });
    }
  } finally {
    if (selected) await selectSourceFile(page, selected);
  }
  return {
    entry: names.find((name) => /\.kicad_pro$/i.test(name)) ?? names[0],
    files,
  };
}

export async function readNativeProject(page) {
  return projectFromNativeFiles(await readNativeFiles(page));
}

export async function fillNativeFiles(page, bundle) {
  const current = await readNativeFiles(page);
  const names = new Set(current.files.map((file) => file.name));
  if (bundle.files.length !== names.size || bundle.files.some((file) => !names.has(file.name)))
    throw new Error(
      'Source edits existing native files; use project commands to add/remove files.',
    );
  const navigation = page.getByRole('navigation', { name: 'Project files', exact: true });
  const selected = await navigation
    .locator('[aria-current="page"]')
    .getAttribute('data-source-file');
  try {
    for (const file of bundle.files) {
      if (current.files.find((item) => item.name === file.name)?.source === file.source) continue;
      await selectSourceFile(page, file.name);
      await fillSource(page, file.source);
    }
  } finally {
    if (selected) await selectSourceFile(page, selected);
  }
}

export async function fillNativeProject(page, project) {
  const { entry } = await readNativeFiles(page);
  await fillNativeFiles(page, projectNativeFiles(project, entry));
}
