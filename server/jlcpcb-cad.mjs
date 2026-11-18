import { createLibraryPart, createProject, quote, validateProject } from './library-format.mjs';
import { createEmptyPCB, createPCBFootprint } from './pcb-layout-format.mjs';

const attributionSource = 'JLCEDA/EasyEDA Official Library';
const homepages = ['https://lceda.cn/', 'https://easyeda.com'];
const mmPerUnit = 0.254;
const decimal = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const decimalField = new RegExp(`^${decimal}$`);
const pinPath = new RegExp(String.raw`^M\s*(${decimal})[ ,]+(${decimal})\s*([hv])\s*(${decimal})$`);
const arcPath = new RegExp(
  String.raw`^M\s*(${decimal})[ ,]+(${decimal})\s*A\s*(${decimal})[ ,]+(${decimal})[ ,]+(${decimal})[ ,]+([01])[ ,]+([01])[ ,]+(${decimal})[ ,]+(${decimal})$`,
);
const pathPoint = String.raw`\s*${decimal}[ ,]+${decimal}\s*`;
const closedPolygonPath = new RegExp(`^M${pathPoint}(?:L${pathPoint}){2,63}Z$`);

function requireCad(condition, message) {
  if (!condition) throw new Error('EasyEDA CAD: ' + message);
}

function text(value, max) {
  requireCad(
    typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value),
    'Invalid text field.',
  );
  return value;
}

function number(value) {
  requireCad(
    (typeof value === 'number' || (typeof value === 'string' && decimalField.test(value))) &&
      Number.isFinite(Number(value)) &&
      Math.abs(Number(value)) <= 100000,
    'Invalid geometry number.',
  );
  return Number(value);
}

function positive(value) {
  const parsed = number(value);
  requireCad(parsed > 0, 'A size must be positive.');
  return parsed;
}

const native = (value) => String(Number(value.toFixed(6)));
const mm = (value) => native(value * mmPerUnit);
const stroke = (width) => ['stroke', ['width', mm(width)], ['type', 'solid']];
const font = (size) => ['font', ['size', native(size), native(size)]];
const effects = (size = 1.27) => ['effects', font(size)];

function readDocument(data, type, uuid) {
  const head = data?.head;
  requireCad(
    typeof uuid === 'string' &&
      /^[a-f0-9]{32}$/.test(uuid) &&
      head?.uuid === uuid &&
      head.docType === type &&
      typeof head.editorVersion === 'string' &&
      /^(?:[56]\.\d+\.\d+|6\.\d+\.\d+\.\d+)$/.test(head.editorVersion) &&
      Array.isArray(data.shape) &&
      data.shape.length <= 2000 &&
      data.shape.every((shape) => typeof shape === 'string' && shape.length <= 128_000),
    'Unsupported library document.',
  );
  const origin = [number(head.x), number(head.y)];
  const notice = text(head.license, 8192);
  requireCad(
    notice.includes(attributionSource) && homepages.every((url) => notice.includes(url)),
    'Missing official library attribution.',
  );
  return { origin, notice, parameters: head.c_para, shapes: data.shape };
}

function localPoint(origin, invertY) {
  return (key, x, y) => [
    key,
    mm(number(x) - origin[0]),
    mm((number(y) - origin[1]) * (invertY ? -1 : 1)),
  ];
}

function points(value) {
  const list = value?.trim().split(/[ ,]+/);
  requireCad(
    list?.length >= 4 && list.length <= 2000 && list.length % 2 === 0,
    'Invalid point list.',
  );
  const result = [];
  for (let index = 0; index < list.length; index += 2)
    result.push([number(list[index]), number(list[index + 1])]);
  return result;
}

function labelSize(value) {
  requireCad(
    typeof value === 'string' && (value === '' || /^\d+(?:\.\d+)?pt$/.test(value)),
    'Unsupported label size.',
  );
  return ((value ? positive(value.slice(0, -2)) : 7) * mmPerUnit * 4) / 3;
}

function pin(shape, point) {
  const segments = shape.split('^^').map((segment) => segment.split('~'));
  requireCad(segments.length === 7, 'Unsupported pin record.');
  const [[, visibility, type, , x, y, rotation], dot, path, name, label, inversion, clock] =
    segments;
  requireCad(
    visibility === 'show' &&
      inversion[0] === '0' &&
      clock[0] === '0' &&
      ['0', '1'].includes(name[0]) &&
      ['0', '1'].includes(label[0]) &&
      number(dot[0]) === number(x) &&
      number(dot[1]) === number(y),
    'Unsupported hidden, decorated or offset pin.',
  );
  const line = pinPath.exec(path[0]);
  requireCad(
    line && number(line[1]) === number(x) && number(line[2]) === number(y),
    'Unsupported pin path.',
  );
  const delta = number(line[4]);
  const angle = line[3] === 'h' ? (delta > 0 ? 0 : 180) : delta > 0 ? 270 : 90;
  requireCad(
    delta !== 0 && (rotation === '' || (angle + 180) % 360 === number(rotation)),
    'Pin direction and path disagree.',
  );
  const pinTypes = {
    '': 'unspecified',
    0: 'unspecified',
    1: 'input',
    2: 'output',
    3: 'bidirectional',
    4: 'unspecified',
  };
  const pinNumber = text(label[4], 64);
  requireCad(
    Object.hasOwn(pinTypes, type) && pinNumber.trim(),
    'Unsupported pin classification or number.',
  );
  return {
    pinNumber,
    nameVisible: name[0] === '1',
    numberVisible: label[0] === '1',
    node: [
      'pin',
      pinTypes[type],
      'line',
      [...point('at', x, y), String(angle)],
      ['length', mm(Math.abs(delta))],
      ['name', quote(text(name[4], 200) || '~'), effects(labelSize(name[7]))],
      ['number', quote(pinNumber), effects(labelSize(label[7]))],
    ],
  };
}

function symbolStyle(width, style, fill) {
  requireCad(style === '' || style === '0', 'Unsupported symbol stroke style.');
  return [
    stroke(positive(width)),
    ['fill', ['type', fill && fill !== 'none' ? 'background' : 'none']],
  ];
}

function symbolRectangle(fields, point) {
  const [, rawX, rawY, rx, ry, width, height, , strokeWidth, style, fill] = fields;
  const x = number(rawX),
    y = number(rawY),
    w = positive(width),
    h = positive(height);
  const radius = rx ? number(rx) : 0;
  requireCad(
    (ry ? number(ry) : 0) === radius && radius >= 0 && 2 * radius < Math.min(w, h),
    'Unsupported rectangle corners.',
  );
  const appearance = symbolStyle(strokeWidth, style, fill);
  if (radius === 0)
    return [['rectangle', point('start', x, y), point('end', x + w, y + h), ...appearance]];
  requireCad(!fill || fill === 'none', 'Filled rounded rectangles are unsupported.');
  const right = x + w,
    bottom = y + h;
  const diagonal = radius / Math.sqrt(2);
  const line = (a, b) => ['polyline', ['pts', point('xy', ...a), point('xy', ...b)], ...appearance];
  const arc = (a, b, c) => [
    'arc',
    point('start', ...a),
    point('mid', ...b),
    point('end', ...c),
    ...appearance,
  ];
  return [
    line([x + radius, y], [right - radius, y]),
    arc(
      [right - radius, y],
      [right - radius + diagonal, y + radius - diagonal],
      [right, y + radius],
    ),
    line([right, y + radius], [right, bottom - radius]),
    arc(
      [right, bottom - radius],
      [right - radius + diagonal, bottom - radius + diagonal],
      [right - radius, bottom],
    ),
    line([right - radius, bottom], [x + radius, bottom]),
    arc(
      [x + radius, bottom],
      [x + radius - diagonal, bottom - radius + diagonal],
      [x, bottom - radius],
    ),
    line([x, bottom - radius], [x, y + radius]),
    arc([x, y + radius], [x + radius - diagonal, y + radius - diagonal], [x + radius, y]),
  ];
}

function symbolGraphics(fields, point) {
  const [type, ...args] = fields;
  switch (type) {
    case 'R':
      return symbolRectangle(fields, point);
    case 'A': {
      const [path, , , width, style, fill] = args;
      requireCad(!fill || fill === 'none', 'Filled symbol arcs are unsupported.');
      const appearance = symbolStyle(width, style, fill);
      const arc = parseArc(path, true);
      if (arc.circular)
        return [
          [
            'arc',
            point('start', ...arc.start),
            point('mid', ...arc.at(0.5)),
            point('end', ...arc.end),
            ...appearance,
          ],
        ];
      // Bound the chord error in schematic millimetres. Pad geometry is independent.
      const tolerance = 0.00099;
      const step = Math.min(Math.PI / 2, 2 * Math.acos(1 - Math.min(1, tolerance / arc.radiusMm)));
      const segments = Math.ceil(Math.abs(arc.sweep) / step);
      requireCad(segments <= 512, 'Elliptical symbol arc exceeds its segment limit.');
      const vertices = [point('xy', ...arc.start)];
      for (let i = 1; i < segments; i++) vertices.push(point('xy', ...arc.at(i / segments)));
      return [['polyline', ['pts', ...vertices, point('xy', ...arc.end)], ...appearance]];
    }
    case 'PG':
    case 'PL':
    case 'L': {
      const isLine = type === 'L';
      const polygon = isLine ? points(args.slice(0, 4).join(' ')) : points(args[0]);
      const [, , width, style, fill] = isLine ? args.slice(3) : args;
      if (type === 'PG') polygon.push(polygon[0]);
      return [
        [
          'polyline',
          ['pts', ...polygon.map(([x, y]) => point('xy', x, y))],
          ...symbolStyle(width, style, fill),
        ],
      ];
    }
    case 'E':
    case 'C': {
      const [x, y, r] = args;
      requireCad(
        type === 'C' || number(r) === number(args[3]),
        'Elliptical symbol circles are unsupported.',
      );
      const [, width, style, fill] = args.slice(type === 'C' ? 3 : 4);
      return [
        [
          'circle',
          point('center', x, y),
          ['radius', mm(positive(r))],
          ...symbolStyle(width, style, fill),
        ],
      ];
    }
    case 'T': {
      const [mark, x, y, rotation, , , size, weight, italic, , usage, content, , anchor] = args;
      requireCad(
        mark === 'L' && usage === 'comment' && ['start', 'middle', 'end'].includes(anchor),
        'Unsupported symbol text.',
      );
      const style = effects(labelSize(size));
      if (weight === 'bold') style[1].push(['bold', 'yes']);
      if (italic === 'italic') style[1].push(['italic', 'yes']);
      if (anchor !== 'middle') style.push(['justify', anchor === 'start' ? 'left' : 'right']);
      return [
        [
          'text',
          quote(text(content, 1000)),
          [...point('at', x, y), native((360 - number(rotation)) % 360)],
          style,
        ],
      ];
    }
    default:
      throw new Error('EasyEDA CAD: Unsupported symbol primitive.');
  }
}

function property(key, value, hidden = false) {
  const style = effects();
  if (hidden) style.push(['hide', 'yes']);
  return ['property', quote(key), quote(value), ['at', '0', '0', '0'], style];
}

function convertSymbol(entry, document, name) {
  const point = localPoint(document.origin, true);
  const prefix = text(document.parameters?.pre, 32).replace(/\?$/, '');
  requireCad(/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix), 'Unsupported reference prefix.');
  const pins = [],
    graphics = [];
  for (const shape of document.shapes) {
    if (shape.startsWith('P~')) pins.push(pin(shape, point));
    else graphics.push(...symbolGraphics(shape.split('~'), point));
  }
  requireCad(
    pins.length > 0 && new Set(pins.map((item) => item.pinNumber)).size === pins.length,
    'Missing or repeated physical pin numbers.',
  );
  requireCad(
    pins.every(
      (item) =>
        item.nameVisible === pins[0].nameVisible && item.numberVisible === pins[0].numberVisible,
    ),
    'Mixed pin-name or pin-number visibility is unsupported.',
  );
  return [
    'symbol',
    quote(entry.id),
    ['pin_names', ...(pins[0].nameVisible ? [['offset', '0.508']] : [['hide', 'yes']])],
    ...(pins[0].numberVisible ? [] : [['pin_numbers', ['hide', 'yes']]]),
    ['in_bom', 'yes'],
    ['on_board', 'yes'],
    ['exclude_from_sim', 'no'],
    property('Reference', prefix),
    property('Value', entry.name),
    property('Footprint', entry.footprint ?? '', true),
    property('Description', entry.description, true),
    property('OpenPE.LibrarySource', [attributionSource, ...homepages].join(' · '), true),
    property('OpenPE.LibraryLicense', document.notice, true),
    ['symbol', quote(name + '_0_1'), ...graphics],
    ['symbol', quote(name + '_1_1'), ...pins.map((item) => item.node)],
  ];
}

function convertPad(fields, point) {
  const [
    ,
    kind,
    x,
    y,
    w,
    h,
    layer,
    net,
    code,
    r,
    ,
    angle,
    ,
    slot,
    holePoints,
    plating,
    ,
    paste,
    mask,
    holeCenter,
  ] = fields;
  const shapes = { RECT: 'rect', ELLIPSE: 'circle', OVAL: 'oval' };
  const through = layer === '11';
  requireCad(
    Object.hasOwn(shapes, kind) &&
      !net &&
      (through || layer === '1') &&
      (!slot || number(slot) === 0) &&
      !holePoints,
    'Unsupported pad shape, layer, net or drill.',
  );
  const shape = shapes[kind];
  requireCad(
    !through || plating === 'Y',
    'Only plated circular through-hole drills are supported.',
  );
  const radius = r ? number(r) : 0;
  requireCad(through ? radius > 0 : radius === 0, 'Pad drill does not match its type.');
  if (through && holeCenter) {
    const center = holeCenter.split(',');
    requireCad(
      center.length === 2 &&
        mm(number(center[0]) - number(x)) === '0' &&
        mm(number(center[1]) - number(y)) === '0',
      'Offset drills are unsupported.',
    );
  }
  const width = positive(w),
    height = positive(h);
  requireCad(shape !== 'circle' || width === height, 'Elliptical copper pads are unsupported.');
  const rotation = number(angle);
  requireCad(rotation >= 0 && rotation <= 360 && rotation % 90 === 0, 'Unsupported pad rotation.');
  return [
    'pad',
    quote(text(code, 64)),
    through ? 'thru_hole' : 'smd',
    shape,
    [...point('at', x, y), native(rotation % 360)],
    ['size', mm(width), mm(height)],
    ...(through ? [['drill', mm(2 * radius)]] : []),
    through
      ? ['layers', quote('*.Cu'), quote('*.Mask')]
      : ['layers', quote('F.Cu'), quote('F.Paste'), quote('F.Mask')],
    ...(paste ? [['solder_paste_margin', mm(number(paste))]] : []),
    ...(mask ? [['solder_mask_margin', mm(number(mask))]] : []),
  ];
}

function parseArc(path, allowEllipse = false) {
  const match = arcPath.exec(path);
  requireCad(match, 'Unsupported SVG arc path.');
  const [, sx, sy, rx, ry, rotation, large, sweepFlag, ex, ey] = match;
  const xRadius = positive(rx);
  const yRatio = positive(ry) / xRadius;
  const circular = yRatio === 1;
  requireCad(
    circular || (allowEllipse && number(rotation) % 180 === 0),
    'Unsupported elliptical arc.',
  );
  const start = [number(sx), number(sy)];
  const end = [number(ex), number(ey)];
  const dx = (start[0] - end[0]) / 2,
    dy = (start[1] - end[1]) / (2 * yRatio);
  const halfChord = Math.hypot(dx, dy);
  requireCad(Number.isFinite(halfChord) && halfChord > 0, 'Degenerate arc.');
  // Work in circle coordinates relative to the first endpoint. SVG scales
  // undersized radii proportionally so both endpoints stay on the arc.
  const radius = Math.max(xRadius, halfChord);
  const centerOffset =
    ((large === sweepFlag ? -1 : 1) * Math.sqrt(Math.max(0, radius ** 2 - halfChord ** 2))) /
    halfChord;
  const cx = -dx + dy * centerOffset;
  const cy = -dy - dx * centerOffset;
  const angle = Math.atan2(-cy, -cx);
  const smallAngle = Math.asin(halfChord / radius);
  const sweep = (sweepFlag === '1' ? 2 : -2) * (large === '1' ? Math.PI - smallAngle : smallAngle);
  return {
    start,
    end,
    circular,
    radiusMm: radius * Math.max(1, yRatio) * mmPerUnit,
    sweep,
    at(fraction) {
      const theta = angle + fraction * sweep;
      return [
        start[0] + cx + radius * Math.cos(theta),
        start[1] + (cy + radius * Math.sin(theta)) * yRatio,
      ];
    },
  };
}

function pasteRegion(path, point) {
  requireCad(closedPolygonPath.test(path), 'Unsupported front paste region path.');
  const vertices = points(path.replace(/[MLZ]/g, ' ').trim());
  requireCad(
    new Set(vertices.map((vertex) => vertex.join(','))).size === vertices.length,
    'Front paste region vertices must be distinct.',
  );
  const [originX, originY] = vertices[0];
  const area = vertices.reduce((sum, [x, y], i) => {
    const [nextX, nextY] = vertices[(i + 1) % vertices.length];
    return sum + (x - originX) * (nextY - originY) - (y - originY) * (nextX - originX);
  }, 0);
  // All vertices must be on the interior side of each edge in source order.
  requireCad(
    area !== 0 &&
      vertices.every(([x, y], i) => {
        const [nextX, nextY] = vertices[(i + 1) % vertices.length];
        return vertices.every(
          ([px, py]) => Math.sign(area) * ((nextX - x) * (py - y) - (nextY - y) * (px - x)) >= 0,
        );
      }),
    'Only convex front paste regions are supported.',
  );
  return [
    'fp_poly',
    ['pts', ...vertices.map(([x, y]) => point('xy', x, y))],
    stroke(0),
    ['fill', 'yes'],
    ['layer', quote('F.Paste')],
  ];
}

function footprintModel(shape, origin) {
  let model;
  try {
    model = JSON.parse(shape.slice('SVGNODE~'.length));
  } catch {}
  requireCad(
    model?.layerid === '19' && model.attrs?.c_etype === 'outline3D',
    'Unsupported embedded footprint object.',
  );
  const { uuid, c_origin: center, c_rotation: rotation, z, transform } = model.attrs;
  if (
    typeof uuid === 'string' &&
    /^[a-f0-9]{32}$/.test(uuid) &&
    center === origin.join(',') &&
    rotation === '0,0,0' &&
    (z === '0' || z === 0) &&
    transform === 'scale(1) translate(0, 0)'
  ) {
    return { path: `JLCPCB:${uuid}.step` };
  }
}

function footprintGraphics(fields, point) {
  const [shape, first, second, third, fourth, fifth] = fields;
  const layerId = { TRACK: second, ARC: second, CIRCLE: fifth, RECT: fifth, SOLIDREGION: first }[
    shape
  ];
  requireCad(layerId, 'Unsupported footprint primitive.');
  // EasyEDA document and 3D preview layers have no manufacturing geometry.
  if (['12', '99', '100', '101'].includes(layerId)) {
    requireCad(
      shape !== 'SOLIDREGION' || (!second && ['solid', 'cutout'].includes(fourth)),
      'Unsupported preview region.',
    );
    return [];
  }
  if (shape === 'SOLIDREGION' && layerId === '5') {
    requireCad(!second && fourth === 'solid', 'Unsupported front paste region.');
    return [pasteRegion(third, point)];
  }
  const layer = { 3: 'F.SilkS', 4: 'B.SilkS', 13: 'F.Fab', 14: 'B.Fab' }[layerId];
  requireCad(layer, 'Unsupported footprint layer (including standalone copper or mask graphics).');
  const layerNode = ['layer', quote(layer)];
  switch (shape) {
    case 'TRACK': {
      requireCad(!third, 'Footprint graphics cannot have electrical nets.');
      const path = points(fourth);
      return path
        .slice(1)
        .map(([x, y], index) => [
          'fp_line',
          point('start', ...path[index]),
          point('end', x, y),
          stroke(positive(first)),
          layerNode,
        ]);
    }
    case 'ARC': {
      requireCad(!third, 'Footprint graphics cannot have electrical nets.');
      const { start, end, at } = parseArc(fourth);
      return [
        [
          'fp_arc',
          point('start', ...start),
          point('mid', ...at(0.5)),
          point('end', ...end),
          stroke(positive(first)),
          layerNode,
        ],
      ];
    }
    case 'CIRCLE':
      return [
        [
          'fp_circle',
          point('center', first, second),
          point('end', number(first) + positive(third), second),
          stroke(positive(fourth)),
          ['fill', 'none'],
          layerNode,
        ],
      ];
    default:
      throw new Error('EasyEDA CAD: Unsupported footprint graphic.');
  }
}

function convertFootprint(entry, document, name) {
  const point = localPoint(document.origin, false);
  const pads = [],
    graphics = [],
    modelRecords = [];
  for (const shape of document.shapes) {
    if (shape.startsWith('SVGNODE~')) {
      modelRecords.push(footprintModel(shape, document.origin));
      continue;
    }
    const fields = shape.split('~');
    if (fields[0] === 'PAD') pads.push(convertPad(fields, point));
    else graphics.push(...footprintGraphics(fields, point));
  }
  requireCad(pads.length > 0, 'The linked footprint has no supported pads.');
  const model = modelRecords.length === 1 ? modelRecords[0] : undefined;
  return {
    ...entry,
    footprint: [
      'footprint',
      quote(name),
      ['version', '20260206'],
      ['generator', 'openpe'],
      ['layer', quote('F.Cu')],
      ['descr', quote([attributionSource, ...homepages, document.notice].join(' · '))],
      ...pads,
      ...graphics,
      ...(model ? [['model', quote(model.path)]] : []),
    ],
    pads: [...new Set(pads.map((pad) => JSON.parse(pad[1])))],
    models: model ? [model] : [],
    attribution: { source: attributionSource, homepages, notice: document.notice },
  };
}

export function convertJlcpcbComponent(entry, value) {
  const name = entry.id.slice('JLCPCB:'.length);
  const document = readDocument(value.dataStr, '2', value.uuid);
  const linked = value.packageDetail;
  const component = linked ? { ...entry, footprint: entry.id } : entry;
  const symbol = convertSymbol(component, document, name);
  const project = createProject();
  project.schematic.libraries = { [entry.id]: symbol };
  const part = createLibraryPart(project.schematic, symbol, 0, 0);
  project.schematic.parts = [part];
  validateProject(project);
  const symbols = {
    ...component,
    symbol,
    units: 1,
    attribution: { source: attributionSource, homepages, notice: document.notice },
  };
  if (!linked) return { symbols };
  try {
    requireCad(
      linked.uuid === value.dataStr.head.puuid && linked.docType === 4,
      'Linked footprint identity or type does not match.',
    );
    const footprint = convertFootprint(
      component,
      readDocument(linked.dataStr, '4', linked.uuid),
      name,
    );
    project.pcb = createEmptyPCB();
    project.pcb.footprints = [
      createPCBFootprint(footprint, project.schematic, part.id, { x: 0, y: 0 }),
    ];
    validateProject(project);
    return { symbols, footprints: footprint };
  } catch (error) {
    symbols.warning =
      'Footprint unavailable: ' +
      String(error.message)
        .replace(/[\u0000-\u001f]/g, ' ')
        .slice(0, 300);
    return { symbols };
  }
}
