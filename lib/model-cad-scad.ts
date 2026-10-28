import {
  modelCadMaterialColors,
  modelCadShape,
  validateModelCad,
  type ModelCadShape,
  type ModelCadVector,
} from './model-cad';

const fail = (message: string): never => {
  throw new Error(`OpenSCAD export: ${message}`);
};

const number = (value: number) => String(value);
const list = (values: readonly number[]) => `[${values.map(number).join(', ')}]`;
const indent = (lines: readonly string[]) => lines.map((line) => '  ' + line);
const nest = (statement: string, body: readonly string[]) => [statement, ...indent(body)];

function posed(position: ModelCadVector, rotation: ModelCadVector, body: string[]) {
  // Intrinsic XYZ (Rx * Ry * Rz): the innermost local Z rotation applies first.
  for (const [axis, angle] of [
    [2, rotation.z],
    [1, rotation.y],
    [0, rotation.x],
  ] as const)
    if (angle !== 0)
      body = nest(`rotate(${list([0, 1, 2].map((index) => (index === axis ? angle : 0)))})`, body);
  return position.x !== 0 || position.y !== 0 || position.z !== 0
    ? nest(`translate(${list([position.x, position.y, position.z])})`, body)
    : body;
}

function drilled(shape: ModelCadShape): boolean {
  return (
    shape.holes.length > 0 ||
    !!shape.boolean?.operands.some((operand) => drilled(operand.shape))
  );
}

function solid(shape: ModelCadShape, name: string): string[] {
  if (shape.edgeTreatment)
    return fail(`${name} has chamfered or filleted edges, which OpenSCAD cannot represent.`);
  const { size } = shape;
  let body: string[];
  if (shape.kind === 'box') body = [`cube(${list([size.x, size.y, size.z])}, center = true);`];
  else if (shape.kind === 'cylinder')
    body = [`cylinder(h = ${number(size.z)}, d = ${number(size.x)}, center = true);`];
  else if (shape.kind === 'extrusion') {
    const profile = shape.profile!;
    body = nest(`linear_extrude(height = ${number(size.z)}, center = true)`, [
      profile.kind === 'rectangle'
        ? `square(${list([size.x, size.y])}, center = true);`
        : profile.kind === 'circle'
          ? `circle(d = ${number(size.x)});`
          : `polygon([${profile.points.map((point) => list([point.x, point.y])).join(', ')}]);`,
    ]);
  } else {
    const { operation, operands } = shape.boolean!;
    body = [
      `${operation}() {`,
      ...operands.flatMap((operand) =>
        indent(posed(operand.position, operand.rotation, solid(operand.shape, name))),
      ),
      '}',
    ];
  }
  if (shape.holes.length)
    body = nest(
      `through_holes(${number(size.z)}, [${shape.holes
        .map((hole) => list([hole.x, hole.y, hole.diameterMm]))
        .join(', ')}])`,
      body,
    );
  return body;
}

/** OpenSCAD text for accepted Model CAD solids. OpenPE never reads or executes SCAD. */
export function exportModelCadScad(input: unknown): string {
  const model = validateModelCad(input);
  if (!model.objects.length) return fail('Create a CAD solid before exporting OpenSCAD.');
  const shapes = model.objects.map((object) => modelCadShape(object));
  const bodies = model.objects.flatMap((object, index) => {
    const color = [16, 8, 0].map((shift) =>
      Number((((modelCadMaterialColors[object.material] >> shift) & 0xff) / 255).toFixed(3)),
    );
    return [
      `// ${object.name}`,
      ...nest(
        `color(${list([...color, object.opacity])})`,
        posed(object.position, object.rotation, solid(shapes[index], object.name)),
      ),
      '',
    ];
  });
  return [
    '// OpenPE Model CAD exported for OpenSCAD.',
    '// OpenPE does not read this file; edit the model in OpenPE and export again.',
    '// Units: millimetres. Native PCB X/Y axes; Z = 0 is the PCB mid-plane.',
    '// OpenSCAD facets circular geometry with $fn.',
    '',
    '$fn = 96;',
    '',
    ...(shapes.some(drilled)
      ? [
          '// Cuts [x, y, diameter] holes along local Z through a centred child of this depth.',
          'module through_holes(depth, holes) {',
          '  difference() {',
          '    children();',
          '    for (hole = holes)',
          '      translate([hole[0], hole[1], 0])',
          '        cylinder(h = depth + 0.02, d = hole[2], center = true);',
          '  }',
          '}',
          '',
        ]
      : []),
    ...bodies,
  ].join('\n');
}
