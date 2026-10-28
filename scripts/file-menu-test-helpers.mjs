export async function fileMenuAction(page, action) {
  await page.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: action, exact: true }).click();
}
