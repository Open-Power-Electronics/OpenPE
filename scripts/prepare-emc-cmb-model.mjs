import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build-only adapter for the exact manufacturer library model. The upstream
// shape records, colours and topology remain byte-for-byte unchanged. Only the
// top assembly placement and the derivative's identifying description change.
export const emcCmbSource = {
  commit: 'df5afb528e92371b558431a7dd41d654e09330ca',
  path: '3dmodels/Inductor_THT_Wurth.3dshapes/L_Wurth_WE-CMB-S.step',
  sha256: 'ac1239404086261a577773f66d1ae66f05a3c5497ebf23ba3765c1bc8e043a6b',
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9);

export function prepareEmcCmbModel(bytes) {
  assert.equal(digest(bytes), emcCmbSource.sha256, 'Unexpected manufacturer CMB model bytes.');
  const source = bytes.toString('latin1');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const point = (id) => {
    const match = source.match(
      new RegExp(`#${id}=CARTESIAN_POINT\\('(?:[^']|'')*',\\(([^)]+)\\)\\);`),
    );
    assert.ok(match, `Missing fixed manufacturer point #${id}.`);
    return match[1].split(',').map(Number);
  };
  const terminalIds = [19240, 19243, 19246, 19249];
  const terminals = terminalIds.map(point);
  const expectedPins = [
    [-3.85, -2.5],
    [3.85, -2.5],
    [-3.85, 2.5],
    [3.85, 2.5],
  ];
  terminals.forEach((terminal, index) => {
    near(terminal[0], expectedPins[index][0]);
    near(terminal[1], expectedPins[index][1]);
    near(terminal[2], -4.5511844391847);
  });
  // The vendor's root assembly is rotated/translated in XY. Its local shape
  // already has the centered 7.7 x 5 mm terminal rectangle expected by EMC's
  // retained model offset (3.85, 2.5, 0). Keep the original Z elevation so the
  // case floor stays at z=0 and lead tips stay at z=-3 mm.
  const elevation = point(42445)[2];
  near(elevation, 1.55118443918445);
  const replaceOnce = (text, before, after) => {
    assert.equal(text.split(before).length, 2, 'Manufacturer assembly placement differs.');
    return text.replace(before, after);
  };
  let output = replaceOnce(
    source,
    "/* description */ ('Unknown'),",
    "/* description */ ('Modified by OpenPE: rigid assembly alignment for EMC Flyback; original model by Wurth Elektronik eiSos GmbH & Co. KG'),",
  );
  output = replaceOnce(
    output,
    "/* name */ 'L_Wurth_WE-CMB-S',",
    "/* name */ 'WE-CMB_744822222_OpenPE_aligned',",
  );
  output = replaceOnce(
    output,
    "#21=ITEM_DEFINED_TRANSFORMATION(' ',' ',#15239,#16490);",
    "#21=ITEM_DEFINED_TRANSFORMATION(' ',' ',#15239,#42476);",
  );
  output = replaceOnce(
    output,
    "#15238=SHAPE_REPRESENTATION('L_Wurth_WE-CMB-S',(#15239,#16490),#42447);",
    "#15238=SHAPE_REPRESENTATION('L_Wurth_WE-CMB-S',(#15239,#42476),#42447);",
  );
  for (let id = 42473; id <= 42476; id++)
    assert.ok(!source.includes(`#${id}=`), 'Manufacturer STEP identifiers collide.');
  const placement = [
    `#42473=CARTESIAN_POINT('OpenPE aligned assembly origin',(0.,0.,${elevation}));`,
    "#42474=DIRECTION('',(0.,0.,1.));",
    "#42475=DIRECTION('',(1.,0.,0.));",
    "#42476=AXIS2_PLACEMENT_3D('OpenPE rigid assembly alignment',#42473,#42474,#42475);",
  ].join(newline);
  output = replaceOnce(
    output,
    `${newline}ENDSEC;${newline}END-ISO-10303-21;`,
    `${newline}${placement}${newline}ENDSEC;${newline}END-ISO-10303-21;`,
  );
  // Each pre-existing STEP entity survives exactly; only the two assembly
  // relationship records named above may differ. This guards shape and colour
  // preservation independently from tessellation bounds.
  const entities = (text) =>
    new Map([...text.matchAll(/#(\d+)=[\s\S]*?;/g)].map((match) => [Number(match[1]), match[0]]));
  const beforeEntities = entities(source),
    afterEntities = entities(output);
  for (const [id, entity] of beforeEntities)
    if (id !== 21 && id !== 15238) assert.equal(afterEntities.get(id), entity);
  assert.equal(afterEntities.size, beforeEntities.size + 4);
  return Buffer.from(output, 'latin1');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length || path.resolve(input) === path.resolve(output))
    throw new Error(
      'Usage: node scripts/prepare-emc-cmb-model.mjs <manufacturer.step> <aligned.step>',
    );
  const result = prepareEmcCmbModel(await readFile(input));
  await writeFile(output, result, { flag: 'wx' });
  console.log(JSON.stringify({ file: output, bytes: result.length, sha256: digest(result) }));
}
