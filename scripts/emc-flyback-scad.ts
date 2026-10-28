import { validateModelCad } from '../lib/model-cad';

const panels = [
  { key: 'base', name: 'Aluminium base', material: 'aluminium', holes: 4 },
  { key: 'front_wall', name: 'Aluminium front wall', material: 'aluminium', holes: 0 },
  { key: 'back_wall', name: 'Aluminium back wall', material: 'aluminium', holes: 0 },
  { key: 'cover', name: 'Transparent cover', material: 'pmma', holes: 4 },
] as const;

const fail = (message: string): never => {
  throw new Error(`EMC Flyback SCAD: ${message}`);
};

/** Build-only source for the four native enclosure panels; never executes CAD code. */
export function serializeEmcFlybackScad(input: unknown): string {
  const model = validateModelCad(input);
  if (model.objects.length !== panels.length)
    return fail('Expected the four named native enclosure panels.');
  const parts = panels.map((panel) => {
    const matches = model.objects.filter((body) => body.name === panel.name);
    if (matches.length !== 1) return fail(`Expected exactly one ${panel.name} panel.`);
    const body = matches[0];
    if (body.kind !== 'box' || body.profile || body.boolean)
      return fail('Only the current axis-aligned box panels are supported.');
    if (body.edgeTreatment) return fail('Edge treatments cannot be represented by this source.');
    if (Object.values(body.rotation).some((angle) => angle !== 0))
      return fail('Only unrotated native panels are supported.');
    if (body.material !== panel.material || body.holes.length !== panel.holes)
      return fail(`The ${panel.name} material or through-hole pattern is unsupported.`);
    return { panel, body };
  });
  const vector = (value: { x: number; y: number; z: number }) =>
    JSON.stringify([value.x, value.y, value.z]);
  const parameters = parts
    .map(({ panel, body }) =>
      [
        `// ${panel.name}; hole entries are [local X, local Y, diameter] in mm.`,
        `${panel.key}_size = ${vector(body.size)};`,
        `${panel.key}_position = ${vector(body.position)};`,
        `${panel.key}_holes = ${JSON.stringify(body.holes.map((hole) => [hole.x, hole.y, hole.diameterMm]))};`,
        `${panel.key}_opacity = ${JSON.stringify(body.opacity)};`,
      ].join('\n'),
    )
    .join('\n\n');
  const modules = parts
    .map(({ panel }) =>
      [
        `module ${panel.key}_panel() {`,
        `  color(concat(${panel.material}_rgb, [${panel.key}_opacity]))`,
        `    translate(${panel.key}_position)`,
        `      drilled_panel(${panel.key}_size, ${panel.key}_holes);`,
        '}',
      ].join('\n'),
    )
    .join('\n\n');
  return [
    '// OpenPE EMC Flyback enclosure: editable construction source.',
    '// Native source: examples/emc-flyback/emc-flyback.kicad_pro, OPENPE_MODEL_CAD.',
    '// Pinned upstream example: Chengmin Li and AI-PCB-layout contributors, CC BY 4.0.',
    '// https://github.com/ChengminLi/AI-PCB-layout/tree/e1b9a64ac9ac306647fa30094932fb792d17e373/examples/emc-flyback-demo',
    '// Manufacturer STEP models retain their separate source and licence terms.',
    '// Units: millimetres. Native PCB X/Y axes; Z = 0 is the PCB mid-plane.',
    '// Positions are panel centres; hole XY is local and each cut follows local Z.',
    '// Base holes mount the PCB; cover holes are the four cover fasteners.',
    '',
    '$fn = 96;',
    'cut_margin_mm = 0.1;',
    'aluminium_rgb = [0.749, 0.765, 0.776];',
    'pmma_rgb = [0.863, 0.925, 0.937];',
    '',
    parameters,
    '',
    'module drilled_panel(dimensions, hole_pattern) {',
    '  difference() {',
    '    cube(dimensions, center = true);',
    '    for (hole = hole_pattern)',
    '      translate([hole[0], hole[1], 0])',
    '        cylinder(h = dimensions[2] + 2 * cut_margin_mm, d = hole[2], center = true);',
    '  }',
    '}',
    '',
    modules,
    '',
    'module emc_flyback_enclosure() {',
    ...parts.map(({ panel }) => `  ${panel.key}_panel();`),
    '}',
    '',
    'emc_flyback_enclosure();',
    '',
  ].join('\n');
}
