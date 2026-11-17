/** Use the actual visible drawing surface; right clicks leave native data untouched. */
export async function openCanvasContextMenu(page) {
  const canvas = page
    .locator(
      '[data-testid="schematic-canvas"]:visible, [data-testid="layout-canvas"]:visible, .pcb-model-canvas:visible',
    )
    .last();
  await canvas.click({ button: 'right', position: { x: 12, y: 12 } });
  const menu = page.getByRole('menu', { name: 'Canvas actions', exact: true });
  await menu.waitFor();
  return menu;
}

export async function exportCanvasImage(page) {
  await runCanvasAction(page, 'Export image');
}

export async function runCanvasAction(page, name) {
  const menu = await openCanvasContextMenu(page);
  await menu.getByRole('menuitem', { name, exact: true }).click();
}
