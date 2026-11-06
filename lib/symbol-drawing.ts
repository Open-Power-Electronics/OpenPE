import { compileCapabilitySchema } from '../api/capability-schema';
import { type Circuit, type Point, fmt, pinPositions, snap, uid } from './circuit';
import { createLibraryPart, partFields, propertyValue, symbolUnits } from './library';
import { child, children, num, quote, val, type SExpr } from './sexpr';
import { samePoint } from './wiring';
import { documentPinKey, projectNetGroups } from './project-net-groups';

/** Local symbol coordinates use canvas millimetres: +X right, +Y down.
 * Pin rotation follows KiCad: 0 points right and 90 points up. */
export type SymbolDrawingGraphic = (
  | { type: 'rectangle'; start: Point; end: Point }
  | { type: 'circle'; center: Point; radius: number }
  | { type: 'polyline'; points: Point[] }
) & { fill?: 'none' | 'background' | 'outline'; width?: number };
export const symbolPinTypes = [
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'passive',
  'free',
  'unspecified',
  'power_in',
  'power_out',
  'open_collector',
  'open_emitter',
  'no_connect',
] as const;
export const symbolPinShapes = [
  'line',
  'inverted',
  'clock',
  'inverted_clock',
  'input_low',
  'clock_low',
  'output_low',
  'edge_clock_high',
  'non_logic',
] as const;
export type SymbolDrawingPin = Point & {
  number: string;
  name: string;
  rotation: 0 | 90 | 180 | 270;
  length: number;
  type?: (typeof symbolPinTypes)[number];
  shape?: (typeof symbolPinShapes)[number];
  hidden?: boolean;
};
export type SymbolDrawing = { graphics: SymbolDrawingGraphic[]; pins: SymbolDrawingPin[] };
export type SymbolDrawingInput = {
  partId?: string;
  name: string;
  referencePrefix?: string;
  value?: string;
  position?: Point;
  drawing: SymbolDrawing;
};
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const coordinate = { type: 'number', minimum: -100000, maximum: 100000, multipleOf: 0.0001 };
const point = object({ x: coordinate, y: coordinate }, ['x', 'y']);
const style = {
  fill: { enum: ['none', 'background', 'outline'] },
  width: { type: 'number', minimum: 0, maximum: 100, multipleOf: 0.0001 },
};
export const symbolDrawingSchema = object(
  {
    graphics: {
      type: 'array',
      maxItems: 256,
      items: {
        oneOf: [
          object({ type: { const: 'rectangle' }, start: point, end: point, ...style }, [
            'type',
            'start',
            'end',
          ]),
          object(
            {
              type: { const: 'circle' },
              center: point,
              radius: { type: 'number', exclusiveMinimum: 0, maximum: 100000, multipleOf: 0.0001 },
              ...style,
            },
            ['type', 'center', 'radius'],
          ),
          object(
            {
              type: { const: 'polyline' },
              points: { type: 'array', minItems: 2, maxItems: 128, items: point },
              ...style,
            },
            ['type', 'points'],
          ),
        ],
      },
    },
    pins: {
      type: 'array',
      maxItems: 256,
      items: object(
        {
          number: { type: 'string', minLength: 1, maxLength: 64 },
          name: { type: 'string', maxLength: 128 },
          x: coordinate,
          y: coordinate,
          rotation: { enum: [0, 90, 180, 270] },
          length: { type: 'number', minimum: 0, maximum: 100000, multipleOf: 0.0001 },
          type: { enum: [...symbolPinTypes] },
          shape: { enum: [...symbolPinShapes] },
          hidden: { type: 'boolean' },
        },
        ['number', 'name', 'x', 'y', 'rotation', 'length'],
      ),
    },
  },
  ['graphics', 'pins'],
);
const checkDrawing = compileCapabilitySchema(symbolDrawingSchema);
const fail = (message: string): never => {
  throw new Error(message);
};
function validatedDrawing(drawing: SymbolDrawing) {
  const checked = checkDrawing(drawing);
  if (!checked.valid) fail(`Invalid symbol drawing: ${checked.error}`);
  if (!drawing.graphics.length && !drawing.pins.length)
    fail('Draw at least one symbol graphic or pin.');
  const precise = (...values: number[]) => {
    if (values.some((value) => Number(value.toFixed(4)) !== value))
      fail('Symbol drawing geometry requires 0.0001 mm precision.');
  };
  const numbers = new Set<string>();
  for (const pin of drawing.pins) {
    precise(pin.x, pin.y, pin.length);
    if (!pin.number.trim() || /[\x00-\x1f]/.test(pin.number + pin.name))
      fail('Symbol pin names and numbers must be printable text.');
    if (numbers.has(pin.number)) fail('Symbol pin numbers must be unique.');
    numbers.add(pin.number);
  }
  for (const graphic of drawing.graphics) {
    if (graphic.width !== undefined) precise(graphic.width);
    const points =
      graphic.type === 'rectangle'
        ? [graphic.start, graphic.end]
        : graphic.type === 'circle'
          ? [graphic.center]
          : graphic.points;
    for (const point of points) precise(point.x, point.y);
    if (graphic.type === 'circle') precise(graphic.radius);
    if (
      graphic.type === 'rectangle' &&
      (graphic.start.x === graphic.end.x || graphic.start.y === graphic.end.y)
    )
      fail('Symbol rectangles need a nonzero width and height.');
    if (
      graphic.type === 'polyline' &&
      graphic.points.every((p) => p.x === graphic.points[0].x && p.y === graphic.points[0].y)
    )
      fail('Symbol polylines need distinct points.');
  }
  return structuredClone(drawing);
}
function editableLibrary(circuit: Circuit, partId: string) {
  const part = circuit.parts.find((p) => p.id === partId);
  if (!part) return fail('The component no longer exists.');
  const library = circuit.libraries[part.libId];
  if (!library) return fail('The component has no embedded symbol.');
  if (
    symbolUnits(library) !== 1 ||
    (part.unit ?? 1) !== 1 ||
    circuit.parts.some((p) => p.id !== part.id && p.ref === part.ref)
  )
    fail('Drawing supports single-unit symbols only.');
  for (const group of children(library, 'symbol')) {
    const match = val(group).match(/_(\d+)_(\d+)$/);
    if (!match || Number(match[1]) > 1 || Number(match[2]) > 1)
      fail('Drawing does not support alternate symbol bodies.');
    for (const primitive of group.filter(Array.isArray))
      if (!['rectangle', 'circle', 'polyline', 'pin'].includes(String(primitive[0])))
        fail(
          `Drawing cannot edit the symbol primitive ${primitive[0]}. Use Source for this symbol.`,
        );
  }
  return {
    part,
    library,
    primitives: children(library, 'symbol').flatMap((g) => g.filter(Array.isArray)) as SExpr[],
  };
}
const fromNativePoint = (node: SExpr | undefined): Point => ({
  x: num(node),
  y: -num(node, 2) || 0,
});
const nativePoint = (tag: string, p: Point): SExpr => [tag, fmt(p.x), fmt(-p.y)];
function readGraphic(node: SExpr): SymbolDrawingGraphic {
  const style = {
    fill: (val(child(child(node, 'fill') ?? [], 'type')) || 'none') as SymbolDrawingGraphic['fill'],
    width: num(child(child(node, 'stroke') ?? [], 'width')),
  };
  if (node[0] === 'rectangle') {
    if (child(node, 'radius') || child(node, 'corner_radius'))
      fail('Rounded symbol rectangles cannot be edited here.');
    return {
      type: 'rectangle',
      start: fromNativePoint(child(node, 'start')),
      end: fromNativePoint(child(node, 'end')),
      ...style,
    };
  }
  if (node[0] === 'circle')
    return {
      type: 'circle',
      center: fromNativePoint(child(node, 'center')),
      radius: num(child(node, 'radius')),
      ...style,
    };
  return {
    type: 'polyline',
    points: children(child(node, 'pts') ?? [], 'xy').map(fromNativePoint),
    ...style,
  };
}
function readPin(node: SExpr): SymbolDrawingPin {
  return {
    number: val(child(node, 'number')),
    name: val(child(node, 'name')),
    ...fromNativePoint(child(node, 'at')),
    rotation: num(child(node, 'at'), 3) as SymbolDrawingPin['rotation'],
    length: num(child(node, 'length')),
    type: String(node[1]) as SymbolDrawingPin['type'],
    shape: String(node[2]) as SymbolDrawingPin['shape'],
    ...(node.includes('hide') || val(child(node, 'hide')) === 'yes' ? { hidden: true } : {}),
  };
}
export function readSymbolDrawing(
  circuit: Circuit,
  partId: string,
): Omit<SymbolDrawingInput, 'partId'> {
  const { part, library, primitives } = editableLibrary(circuit, partId);
  return {
    name: val(library)
      .split(':')
      .at(-1)!
      .replace(/_[0-9a-f-]{36}$/i, ''),
    referencePrefix: propertyValue(library, 'Reference') || 'U',
    value: part.value,
    position: { x: part.x, y: part.y },
    drawing: validatedDrawing({
      graphics: primitives.filter((p) => p[0] !== 'pin').map(readGraphic),
      pins: primitives.filter((p) => p[0] === 'pin').map(readPin),
    }),
  };
}
function setNode(node: SExpr, tag: string, replacement: SExpr) {
  const previous = child(node, tag);
  if (previous) node[node.indexOf(previous)] = replacement;
  else node.push(replacement);
}
function graphicNode(graphic: SymbolDrawingGraphic, previous?: SExpr): SExpr {
  const node = previous?.[0] === graphic.type ? structuredClone(previous) : [graphic.type];
  if (graphic.type === 'rectangle') {
    setNode(node, 'start', nativePoint('start', graphic.start));
    setNode(node, 'end', nativePoint('end', graphic.end));
  } else if (graphic.type === 'circle') {
    setNode(node, 'center', nativePoint('center', graphic.center));
    setNode(node, 'radius', ['radius', fmt(graphic.radius)]);
  } else setNode(node, 'pts', ['pts', ...graphic.points.map((p) => nativePoint('xy', p))]);
  const stroke = structuredClone(child(node, 'stroke') ?? ['stroke', ['type', 'default']]);
  if (graphic.width !== undefined || !child(node, 'stroke'))
    setNode(stroke, 'width', ['width', fmt(graphic.width ?? 0.254)]);
  setNode(node, 'stroke', stroke);
  const fill = structuredClone(child(node, 'fill') ?? ['fill']);
  if (graphic.fill !== undefined || !child(node, 'fill'))
    setNode(fill, 'type', ['type', graphic.fill ?? 'none']);
  setNode(node, 'fill', fill);
  return node;
}
function pinNode(pin: SymbolDrawingPin, previous?: SExpr): SExpr {
  const node = previous ? structuredClone(previous) : ['pin', 'passive', 'line'];
  node[1] = pin.type ?? 'passive';
  node[2] = pin.shape ?? 'line';
  setNode(node, 'at', [...nativePoint('at', pin), String(pin.rotation)]);
  setNode(node, 'length', ['length', fmt(pin.length)]);
  for (const tag of ['name', 'number'] as const) {
    const text = structuredClone(
      child(node, tag) ?? [tag, '""', ['effects', ['font', ['size', '1.27', '1.27']]]],
    );
    text[1] = quote(pin[tag]);
    setNode(node, tag, text);
  }
  for (let i = node.length - 1; i >= 0; i--)
    if (node[i] === 'hide' || (Array.isArray(node[i]) && node[i][0] === 'hide')) node.splice(i, 1);
  if (pin.hidden) node.push('hide');
  return node;
}
/** Prepare one detached edit; ProjectCore validates and publishes the whole project. */
export function prepareSymbolDrawing(
  circuit: Circuit,
  input: SymbolDrawingInput,
): { circuit: Circuit; partId: string } {
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 80 ||
    /[:\x00-\x1f]/.test(input.name)
  )
    fail('Enter a symbol name of 1–80 printable characters without a colon.');
  if (
    input.referencePrefix !== undefined &&
    !/^#?[A-Za-z][A-Za-z0-9_]{0,15}$/.test(input.referencePrefix)
  )
    fail(
      'The reference prefix must start with a letter or # and contain at most 16 letters, digits or underscores.',
    );
  if (
    input.value !== undefined &&
    (typeof input.value !== 'string' ||
      input.value.length > 4096 ||
      /[\x00-\x1f]/.test(input.value))
  )
    fail('The symbol value must be printable text of at most 4096 characters.');
  const position = input.position ?? { x: 0, y: 0 };
  if (![position.x, position.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 100000))
    fail('Invalid symbol position.');
  const drawing = validatedDrawing(input.drawing);
  const existing = input.partId ? editableLibrary(circuit, input.partId) : undefined;
  // Reading before replacement rejects unsupported geometry instead of silently erasing it.
  const previousDrawing = input.partId ? readSymbolDrawing(circuit, input.partId) : undefined;
  if (
    previousDrawing &&
    previousDrawing.name === input.name.trim() &&
    (input.referencePrefix === undefined ||
      input.referencePrefix === previousDrawing.referencePrefix) &&
    (input.value === undefined || input.value === previousDrawing.value) &&
    (!input.position ||
      (input.position.x === previousDrawing.position!.x &&
        input.position.y === previousDrawing.position!.y)) &&
    JSON.stringify(previousDrawing.drawing) === JSON.stringify(drawing)
  )
    return { circuit, partId: input.partId! };
  if (existing) {
    const fields = partFields(existing.part);
    if (
      ['Sim.Pins', 'Sim.Device', 'Sim.Library'].some((key) => fields[key]?.trim()) &&
      previousDrawing!.drawing.pins.some((p) => !drawing.pins.some((q) => q.number === p.number))
    )
      fail('Retain existing pin numbers while a simulation model is assigned.');
  }
  const partId = existing?.part.id ?? uid();
  let libraryId = `OpenPE:${input.name.trim()}_${partId}`;
  if (circuit.parts.some((p) => p.id !== partId && p.libId === libraryId))
    libraryId = `OpenPE:${input.name.trim()}_${uid()}`;
  const library: SExpr = existing
    ? structuredClone(existing.library)
    : [
        'symbol',
        quote(libraryId),
        ['pin_names', ['offset', '0.508']],
        ['exclude_from_sim', 'yes'],
        ['in_bom', 'yes'],
        ['on_board', 'yes'],
        [
          'property',
          '"Reference"',
          quote(input.referencePrefix ?? 'U'),
          ['at', '0', '5.08', '0'],
          ['effects', ['font', ['size', '1.27', '1.27']]],
        ],
        [
          'property',
          '"Value"',
          quote(input.value ?? input.name.trim()),
          ['at', '0', '-5.08', '0'],
          ['effects', ['font', ['size', '1.27', '1.27']]],
        ],
      ];
  library[1] = quote(libraryId);
  for (const [name, value] of [
    ['Reference', input.referencePrefix],
    ['Value', input.value],
  ] as const) {
    if (value === undefined) continue;
    const field = children(library, 'property').find((p) => val(p) === name);
    if (field) field[2] = quote(value);
  }
  const previousGraphics = existing?.primitives.filter((p) => p[0] !== 'pin') ?? [];
  const previousPins = new Map(
    existing?.primitives.filter((p) => p[0] === 'pin').map((p) => [val(child(p, 'number')), p]),
  );
  const usedGraphics = new Set<number>();
  const retainGraphic = (graphic: SymbolDrawingGraphic, index: number) => {
    const exact = previousGraphics.findIndex(
      (node, i) =>
        !usedGraphics.has(i) && JSON.stringify(readGraphic(node)) === JSON.stringify(graphic),
    );
    const previous =
      exact >= 0
        ? exact
        : !usedGraphics.has(index) && previousGraphics[index]?.[0] === graphic.type
          ? index
          : -1;
    if (previous < 0) return undefined;
    usedGraphics.add(previous);
    return previousGraphics[previous];
  };
  const groups = children(library, 'symbol');
  for (const group of groups) library.splice(library.indexOf(group), 1);
  library.push([
    'symbol',
    quote(`${input.name.trim()}_1_1`),
    ...drawing.graphics.map((g, i) => graphicNode(g, retainGraphic(g, i))),
    ...drawing.pins.map((p) => pinNode(p, previousPins.get(p.number))),
  ]);
  const next: Circuit = {
    ...circuit,
    libraries: { ...circuit.libraries, [libraryId]: library },
    parts: [...circuit.parts],
  };
  if (existing) {
    const part = {
      ...existing.part,
      libId: libraryId,
      ...(input.value === undefined ? {} : { value: input.value }),
    };
    if (input.position && (position.x !== existing.part.x || position.y !== existing.part.y)) {
      part.x = snap(position.x);
      part.y = snap(position.y);
    }
    if (part.raw) {
      part.raw = structuredClone(part.raw);
      setNode(part.raw, 'lib_name', ['lib_name', quote(libraryId)]);
    }
    // Pin edits are explicit geometry edits. Existing wired terminal positions
    // must remain fixed; users can first disconnect or move the component.
    const before = pinPositions(existing.part, existing.library),
      after = pinPositions(part, library);
    const oldPins = existing.primitives.filter((p) => p[0] === 'pin');
    const connectedPins = new Set(
      projectNetGroups(circuit)
        .filter(
          (group) =>
            group.wires.length ||
            group.labels.length ||
            group.junctions.length ||
            group.pins.length > 2,
        )
        .flatMap((group) => group.pins),
    );
    oldPins.forEach((pin, index) => {
      const point = before[index];
      const attached =
        connectedPins.has(documentPinKey(existing.part.id, val(child(pin, 'number')))) ||
        circuit.wires.some((w) => [w.a, w.b].some((p) => samePoint(p, point))) ||
        circuit.labels.some((p) => samePoint(p, point)) ||
        circuit.junctions.some((p) => samePoint(p, point)) ||
        (circuit.noConnects ?? []).some((p) => samePoint(p, point));
      const target = drawing.pins.findIndex((p) => p.number === val(child(pin, 'number')));
      if (attached && (target < 0 || after[target].x !== point.x || after[target].y !== point.y))
        fail('Disconnect wired or marked pins before removing or moving their terminals.');
    });
    next.parts = next.parts.map((p) => (p.id === partId ? part : p));
  } else {
    const part = createLibraryPart(next, library, position.x, position.y);
    part.id = partId;
    next.parts.push(part);
  }
  return { circuit: next, partId };
}
