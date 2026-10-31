export async function fileMenuAction(page, action) {
  await page.getByRole('combobox', { name: 'File', exact: true }).click();
  for (const name of Array.isArray(action) ? action : [action])
    await page.getByRole('option', { name, exact: true }).click();
}
