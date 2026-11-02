import assert from 'node:assert/strict';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { projectFromNativeFiles } from '../server/project-format.mjs';
import { readNativeFiles } from './source-editor-test-helpers.mjs';
import { selectLayoutLayer } from './visualization-test-helpers.mjs';

const { pinPositions } = await tsImport('../lib/circuit.ts', import.meta.url);
const { padPosition } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { analyzePCBConnectivity } = await tsImport('../lib/pcb-connectivity.ts', import.meta.url);
const { projectNetGroups, documentPhysicalPinKey } = await tsImport(
  '../lib/project-net-groups.ts',
  import.meta.url,
);
const footprintId = 'Resistor_SMD:R_0805_2012Metric';

// All mutations use mounted user controls. Pure adapters only inspect actual
// native Source and map accepted geometry to visible canvas coordinates.
export async function exerciseNewProjectDesign(page, step) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  const read = async (view = 'Schematic') => {
    await button('Source').click();
    const project = projectFromNativeFiles(await readNativeFiles(page));
    await button(view).click();
    return project;
  };
  const clickPoint = async (canvas, point) => {
    const at = await canvas.evaluate((svg, point) => {
      const at = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
    await page.mouse.click(at.x, at.y);
  };
  await button('Schematic').click();
  let project = await read();
  const first = project.schematic.parts[0];
  await button('Add component').click();
  await page.getByLabel('Search components', { exact: true }).fill('Device:R');
  await page
    .locator('.library-results button')
    .filter({ has: page.getByText('R', { exact: true }) })
    .click();
  await button('Place').click();
  const schematic = page.getByTestId('schematic-canvas');
  await clickPoint(schematic, { x: first.x + 25.4, y: first.y });
  await page.keyboard.press('Escape');
  project = await read();
  assert.equal(project.schematic.parts.length, 2);
  const pins = project.schematic.parts.map(
    (part) => pinPositions(part, project.schematic.libraries[part.libId])[0],
  );
  await button('Wire').click();
  for (const point of [
    pins[0],
    { x: pins[0].x, y: pins[0].y - 10.16 },
    { x: pins[1].x, y: pins[1].y - 10.16 },
    pins[1],
  ])
    await clickPoint(schematic, point);
  await schematic.press('Enter');
  await schematic.press('Escape');
  project = await read();
  assert.ok(project.schematic.wires.length >= 3);
  assertSchematicConnection(project);
  const wired = JSON.stringify(project.schematic.wires);
  await button('Undo').click();
  assert.equal((await read()).schematic.wires.length, 0);
  await button('Redo').click();
  assert.equal(JSON.stringify((await read()).schematic.wires), wired);
  step('Connect two real symbol pins with a three-leg wire; undo and redo preserve connectivity');

  for (const ref of ['R1', 'R2']) {
    await page.getByTestId(`part-${ref}`).click();
    await button('Browse footprints').click();
    await page.getByLabel('Search footprints', { exact: true }).fill(footprintId);
    await page
      .locator('.library-results button')
      .filter({ has: page.getByText('R_0805_2012Metric', { exact: true }) })
      .click();
    await button('Assign footprint').click();
    assert.equal(await page.getByLabel('Footprint', { exact: true }).inputValue(), footprintId);
  }
  await button('Layout').click();
  const layout = page.getByTestId('layout-canvas');
  await layout.waitFor();
  await layout.press('Control+Home');
  project = await read('Layout');
  assert.equal(project.pcb.footprints.length, 2);
  for (const [ref, x, rotation] of [
    ['R1', 20, 180],
    ['R2', 40, 0],
  ]) {
    const symbol = project.schematic.parts.find((part) => part.ref === ref);
    const footprint = project.pcb.footprints.find((item) => item.symbolId === symbol.id);
    await layout.locator(`[data-pad-id="${footprint.pads[0].id}"]`).click();
    await button('Footprint properties').click();
    for (const [name, number] of [
      ['X (mm)', x],
      ['Y (mm)', 20],
      ['Rotation (°)', rotation],
    ]) {
      const field = page.getByLabel(name, { exact: true });
      await field.fill(String(number));
      await field.press('Enter');
    }
    await layout.press('Control+Home');
  }
  project = await read('Layout');
  for (const [ref, x, rotation] of [
    ['R1', 20, 180],
    ['R2', 40, 0],
  ]) {
    const footprint = footprintFor(project, ref);
    assert.equal(footprint.x, x);
    assert.equal(footprint.y, 20);
    assert.equal(footprint.rotation, rotation);
  }
  const contacts = ['R1', 'R2'].map((ref) => {
    const footprint = footprintFor(project, ref);
    const pad = footprint.pads.find((pad) => pad.number === '1');
    assert.ok(pad.netId);
    return { pad, point: padPosition(footprint, pad) };
  });
  assert.equal(contacts[0].pad.netId, contacts[1].pad.netId);
  assert.ok(analyzePCBConnectivity(project.pcb).edges.length > 0);
  await button('Route tracks').click();
  await clickPoint(layout, contacts[0].point);
  await clickPoint(layout, contacts[1].point);
  await layout.press('Enter');
  await layout.press('Escape');
  project = await read('Layout');
  assert.ok(project.pcb.tracks.length > 0);
  assert.equal(analyzePCBConnectivity(project.pcb).edges.length, 0);
  const tracks = JSON.stringify(project.pcb.tracks);
  await button('Undo').click();
  assert.equal((await read('Layout')).pcb.tracks.length, 0);
  await button('Redo').click();
  assert.equal(JSON.stringify((await read('Layout')).pcb.tracks), tracks);

  await layout.press('Control+Home');
  // Zoom out around the actual geometry to make room for the complete outline.
  for (let index = 0; index < 3; index++) await button('Zoom out').click();
  await selectLayoutLayer(page, 'Edge.Cuts');
  await button('Draw rectangle').click();
  await clickPoint(layout, { x: 10, y: 10 });
  await clickPoint(layout, { x: 50, y: 35 });
  await layout.press('Escape');
  project = await read('Layout');
  assertBoard(project);
  step(
    'Assign real packages, place and rotate both PCB footprints, route their net and draw a closed board outline',
  );

  const beforeModel = await readNativeFilesInView(page);
  await button('Model').click();
  const model = page.locator('.pcb-model-canvas');
  await model.locator('canvas').waitFor();
  await button('Place box').click();
  const box = page.getByRole('complementary', { name: 'Box settings', exact: true });
  for (const [name, value] of [
    ['Length (mm)', 24],
    ['Width (mm)', 16],
    ['Height (mm)', 8],
  ])
    await box.getByLabel(name, { exact: true }).fill(String(value));
  // Placement itself is a real canvas action; Properties then sets exact poses.
  const bounds = await model.locator('canvas').boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.5);
  const inspector = page.getByRole('complementary', {
    name: 'Solid properties settings',
    exact: true,
  });
  await inspector.waitFor();
  await inspector.getByLabel('Solid name', { exact: true }).fill('Test mounting block');
  for (const [name, value] of [
    ['Length (mm)', 26],
    ['Solid X position (mm)', 30],
    ['Solid Y position (mm)', 25],
    ['Solid Z position (mm)', 10],
    ['Solid Z rotation (degrees)', 30],
    ['Opacity (%)', 85],
  ])
    await inspector.getByLabel(name, { exact: true }).fill(String(value));
  const material = inspector.getByRole('combobox', { name: 'Solid material', exact: true });
  await material.scrollIntoViewIfNeeded();
  await material.focus();
  // Finish the inspector's focus scroll before opening its anchored popup.
  await material.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await material.press('ArrowDown');
  await material.press('End');
  await material.press('Enter');
  assert.equal(await material.innerText(), 'Plastic');
  await inspector.getByRole('button', { name: 'Add hole', exact: true }).click();
  await inspector.getByLabel('Hole 1 diameter (mm)', { exact: true }).fill('4');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  const finished = await read('Model');
  assertModel(finished);
  const finalModel = JSON.stringify(finished.extensions['org.openpe.model-cad']);
  await button('Undo').click();
  const undone = await read('Model');
  assert.notEqual(JSON.stringify(undone.extensions['org.openpe.model-cad']), finalModel);
  await button('Redo').click();
  assert.equal(
    JSON.stringify((await read('Model')).extensions['org.openpe.model-cad']),
    finalModel,
  );
  const afterModel = await readNativeFilesInView(page);
  for (const extension of ['.kicad_sch', '.kicad_pcb'])
    assert.equal(
      afterModel.files.find((file) => file.name.endsWith(extension)).source,
      beforeModel.files.find((file) => file.name.endsWith(extension)).source,
      `Model edits preserve exact ${extension} bytes`,
    );
  step(
    'Create and edit a Model box with a hole, dimensions, position, rotation, material and opacity; undo and redo retain PCB bytes',
  );
  return assertNewProjectDesign(projectFromNativeFiles(afterModel));
}

async function readNativeFilesInView(page) {
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  return readNativeFiles(page);
}

function footprintFor(project, ref) {
  const symbol = project.schematic.parts.find((part) => part.ref === ref);
  assert.ok(symbol);
  const footprint = project.pcb.footprints.find((item) => item.symbolId === symbol.id);
  assert.ok(footprint);
  return footprint;
}

function assertSchematicConnection(project) {
  const keys = ['R1', 'R2'].map((ref) => documentPhysicalPinKey(ref, '1'));
  const joined = projectNetGroups(project.schematic).find((group) =>
    keys.every((key) => group.pins.includes(key)),
  );
  assert.ok(joined, 'R1.1 and R2.1 share a geometry-derived net');
  assert.ok(joined.wires.length >= 3);
}

function assertBoard(project) {
  assert.equal(project.pcb.footprints.length, 2);
  for (const [ref, x, rotation] of [
    ['R1', 20, 180],
    ['R2', 40, 0],
  ]) {
    const footprint = footprintFor(project, ref);
    assert.equal(footprint.libraryId, footprintId);
    assert.equal(footprint.x, x);
    assert.equal(footprint.y, 20);
    assert.equal(footprint.rotation, rotation);
    assert.equal(footprint.pads.length, 2);
  }
  const net = footprintFor(project, 'R1').pads.find((pad) => pad.number === '1').netId;
  assert.equal(net, footprintFor(project, 'R2').pads.find((pad) => pad.number === '1').netId);
  assert.ok(project.pcb.tracks.length > 0);
  assert.ok(
    project.pcb.tracks.every(
      (track) => track.netId === net && track.layer === 'F.Cu' && track.width > 0,
    ),
  );
  assert.equal(analyzePCBConnectivity(project.pcb).edges.length, 0);
  const outline = project.pcb.graphics.filter((graphic) => graphic.layer === 'Edge.Cuts');
  assert.equal(outline.length, 1);
  assert.equal(outline[0].kind, 'polygon');
  assert.equal(outline[0].points.length, 2);
}

function assertModel(project) {
  const model = project.extensions['org.openpe.model-cad'];
  assert.equal(model.objects.length, 1);
  const body = model.objects[0];
  assert.equal(body.name, 'Test mounting block');
  assert.equal(body.kind, 'box');
  assert.deepEqual(body.size, { x: 26, y: 16, z: 8 });
  assert.deepEqual(body.position, { x: 30, y: 25, z: 10 });
  assert.deepEqual(body.rotation, { x: 0, y: 0, z: 30 });
  assert.equal(body.material, 'plastic');
  assert.equal(body.opacity, 0.85);
  assert.equal(body.holes.length, 1);
  assert.equal(body.holes[0].diameterMm, 4);
}

export function assertNewProjectDesign(project) {
  assertSchematicConnection(project);
  assertBoard(project);
  assertModel(project);
  return {
    components: project.schematic.parts.length,
    wires: project.schematic.wires.length,
    footprints: project.pcb.footprints.length,
    tracks: project.pcb.tracks.length,
    outlineEdges: project.pcb.graphics.filter((item) => item.layer === 'Edge.Cuts').length,
    unresolvedAirwires: analyzePCBConnectivity(project.pcb).edges.length,
    model: project.extensions['org.openpe.model-cad'],
  };
}

export async function captureReopenedDesign(page, dir, expected) {
  const actual = await readNativeFilesInView(page);
  assert.deepEqual(actual, expected);
  const summary = assertNewProjectDesign(projectFromNativeFiles(actual));
  for (const [view, filename, selector] of [
    ['Schematic', 'reopened-schematic.png', '[data-testid="schematic-canvas"]'],
    ['Layout', 'reopened-layout.png', '[data-testid="layout-canvas"]'],
    ['Model', 'reopened-model.png', '.pcb-model-canvas canvas'],
  ]) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.locator(selector).waitFor();
    if (view === 'Model') {
      await page
        .locator('.pcb-model-status')
        .filter({ hasText: /Loading/ })
        .waitFor({
          state: 'hidden',
          timeout: 60_000,
        });
      assert.equal(await page.locator('.pcb-model-status[role="alert"]').count(), 0);
      assert.deepEqual(await page.locator('.pcb-model-notices li').allTextContents(), []);
    }
    await page.locator(selector).press(view === 'Model' ? 'Space' : 'Control+Home');
    await page.screenshot({ path: path.join(dir, filename) });
  }
  assert.deepEqual(
    await readNativeFilesInView(page),
    expected,
    'Reopened Schematic, Layout and Model presentation preserves every saved native byte',
  );
  return summary;
}
