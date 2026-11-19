import { createLibraryPart, createProject, quote, validateProject } from './library-format.mjs';
import {
  readLibraryFootprint,
  createEmptyPCB,
  insidePolygon,
  pcbPadChamferEndpoints,
  pcbPadCorners,
  pointSegmentDistance,
  segmentDistance,
} from './pcb-layout-format.mjs';

const attributionSource = 'JLCEDA/EasyEDA Official Library';
const homepages = ['https://lceda.cn/', 'https://easyeda.com'];
const mmPerUnit = 0.254;
const cadUuid = /^[a-f0-9]{32}$/;
const decimal = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const decimalField = new RegExp(`^${decimal}$`);
const pinPath = new RegExp(String.raw`^M\s*(${decimal})[ ,]+(${decimal})\s*([hv])\s*(${decimal})$`);
const generatedShapeId = /^S\$\d{1,12}$/;
const arcPath = new RegExp(
  String.raw`^\s*M\s*(${decimal})[ ,]+(${decimal})\s*A\s*(${decimal})[ ,]+(${decimal})[ ,]+(${decimal})[ ,]+([01])[ ,]+([01])[ ,]+(${decimal})[ ,]+(${decimal})\s*$`,
);
const pathToken = new RegExp(`[A-Za-z]|${decimal}|[^\\s,]`, 'g');
const outlineTransform = new RegExp(
  String.raw`^scale\(\s*(${decimal})\s*\)\s*translate\(\s*(${decimal})(?:\s*,\s*|\s+)(${decimal})\s*\)$`,
);
const regionVertexLimit = 512;
const regionWorkLimit = 2_000_000;
const glyphContourLimit = 64;
const glyphVertexLimit = 1536;
const curveToleranceMm = 0.00099;
const graphicLayers = {
  3: 'F.SilkS',
  4: 'B.SilkS',
  5: 'F.Paste',
  6: 'B.Paste',
  7: 'F.Mask',
  8: 'B.Mask',
  10: 'Edge.Cuts',
  13: 'F.Fab',
  14: 'B.Fab',
};
const previewLayers = ['12', '99', '100', '101'];
const symbolStrokeTypes = { '': 'solid', 0: 'solid', 1: 'dash', 2: 'dot' };

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
const stroke = (width, type = 'solid') => ['stroke', ['width', mm(width)], ['type', type]];
const font = (size) => ['font', ['size', native(size), native(size)]];
const effects = (size = 1.27) => ['effects', font(size)];

function hasDocumentIdentity(head, type, uuid) {
  return (
    typeof uuid === 'string' && cadUuid.test(uuid) && head?.uuid === uuid && head.docType === type
  );
}

function readDocument(data, type, uuid, parentNotice) {
  const head = data?.head;
  requireCad(
    hasDocumentIdentity(head, type, uuid) &&
      typeof head.editorVersion === 'string' &&
      /^(?:[56]\.\d+\.\d+|6\.\d+\.\d+\.\d+)$/.test(head.editorVersion) &&
      Array.isArray(data.shape) &&
      data.shape.length <= 2000 &&
      data.shape.every((shape) => typeof shape === 'string' && shape.length <= 128_000),
    'Unsupported library document.',
  );
  const origin = [number(head.x), number(head.y)];
  const notice = text(head.license === undefined ? parentNotice : head.license, 8192);
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
    typeof value === 'string' && (value === '' || /^\d+(?:\.\d+)?(?:pt)?$/.test(value)),
    'Unsupported label size.',
  );
  if (!value) return (7 * mmPerUnit * 4) / 3;
  return value.endsWith('pt')
    ? (positive(value.slice(0, -2)) * mmPerUnit * 4) / 3
    : positive(value) * mmPerUnit;
}

function pin(shape, point) {
  const segments = shape.split('^^').map((segment) => segment.split('~'));
  requireCad(segments.length === 7, 'Unsupported pin record.');
  const [[, visibility, type, , x, y, rotation], dot, path, name, label, inversion, clock] =
    segments;
  requireCad(
    visibility === 'show' &&
      inversion[0] === '0' &&
      ['0', '1'].includes(clock[0]) &&
      ['0', '1'].includes(name[0]) &&
      ['0', '1'].includes(label[0]),
    'Unsupported hidden or decorated pin.',
  );
  const line = pinPath.exec(path[0]);
  requireCad(line, 'Unsupported pin path.');
  const [, rawX, rawY, direction, rawLength] = line;
  const startX = number(rawX);
  const startY = number(rawY);
  const length = number(rawLength);
  const anchorX = number(dot[0]);
  const anchorY = number(dot[1]);
  const horizontal = direction === 'h';
  const endX = startX + (horizontal ? length : 0);
  const endY = startY + (horizontal ? 0 : length);
  const startsAtAnchor = startX === anchorX && startY === anchorY;
  const endsAtAnchor = endX === anchorX && endY === anchorY;
  requireCad(startsAtAnchor || endsAtAnchor, 'Unsupported pin path.');
  const headerX = number(x);
  const headerY = number(y);
  requireCad(
    (headerX === startX && headerY === startY) || (headerX === endX && headerY === endY),
    'The pin position is outside its path endpoints.',
  );
  const delta = startsAtAnchor ? length : -length;
  const angle = horizontal ? (delta > 0 ? 0 : 180) : delta > 0 ? 270 : 90;
  requireCad(
    delta !== 0 && (rotation === '' || (angle + 180) % 360 === number(rotation)),
    'Pin direction and path disagree.',
  );
  const clockPin = clock[0] === '1';
  if (clockPin) {
    const [bodyX, bodyY] = startsAtAnchor ? [endX, endY] : [startX, startY];
    const reach = 3 * Math.sign(delta);
    const marker = horizontal
      ? [
          [bodyX, bodyY + 3],
          [bodyX + reach, bodyY],
          [bodyX, bodyY - 3],
        ]
      : [
          [bodyX + 3, bodyY],
          [bodyX, bodyY + reach],
          [bodyX - 3, bodyY],
        ];
    const contours = svgPathContours(clock[1], true);
    const matches = (points) =>
      points.every(
        ([px, py], i) => Math.hypot(px - contours[0][i][0], py - contours[0][i][1]) <= 1e-6,
      );
    requireCad(
      contours.length === 1 &&
        contours[0].length === 3 &&
        (matches(marker) || matches(marker.toReversed())),
      'Unsupported clock pin marker.',
    );
  }
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
  const pinName = text(name[4], 200) || '~';
  const electricalType = pinTypes[type];
  const nameVisible = name[0] === '1';
  const numberVisible = label[0] === '1';
  const nameSize = labelSize(name[7]);
  const numberSize = labelSize(label[7]);
  return {
    pinNumber,
    pinName,
    electricalType,
    nameVisible,
    numberVisible,
    node(showNames, showNumbers) {
      return [
        'pin',
        electricalType,
        clockPin ? 'clock' : 'line',
        [...point('at', anchorX, anchorY), String(angle)],
        ['length', mm(Math.abs(delta))],
        ['name', quote(pinName), effects(showNames && !nameVisible ? 0 : nameSize)],
        ['number', quote(pinNumber), effects(showNumbers && !numberVisible ? 0 : numberSize)],
      ];
    },
  };
}

const filledSymbol = (fill) => Boolean(fill && fill.toLowerCase() !== 'none');

function symbolStyle(width, style, fill, color) {
  requireCad(Object.hasOwn(symbolStrokeTypes, style), 'Unsupported symbol stroke style.');
  const fillType = !filledSymbol(fill)
    ? 'none'
    : fill.toLowerCase() === color?.toLowerCase()
      ? 'outline'
      : 'background';
  return [stroke(positive(width), symbolStrokeTypes[style]), ['fill', ['type', fillType]]];
}

function symbolRectangle(fields, point, spend) {
  const [, rawX, rawY, rx, ry, width, height, color, strokeWidth, style, fill] = fields;
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
  const right = x + w,
    bottom = y + h;
  if (filledSymbol(fill)) {
    const segments = curveSegments(Math.PI / 2, radius * mmPerUnit);
    const vertexCount = 4 * (segments + 1) + 1;
    requireCad(vertexCount <= regionVertexLimit, 'Rounded rectangle exceeds the vertex limit.');
    spend(vertexCount ** 2);
    const corners = [
      [right - radius, y + radius],
      [right - radius, bottom - radius],
      [x + radius, bottom - radius],
      [x + radius, y + radius],
    ];
    const vertices = corners.flatMap(([cx, cy], corner) =>
      Array.from({ length: segments + 1 }, (_, i) => {
        const angle = (corner - 1 + i / segments) * (Math.PI / 2);
        return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
      }),
    );
    const { nodes } = regionPolygon(vertices, point);
    return [
      ['polyline', ['pts', ...nodes, nodes[0]], ...symbolStyle(strokeWidth, style, fill, color)],
    ];
  }
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

function symbolPath([path, color, width, style, fill], point, spend) {
  const contours = svgPathContours(path, true).filter((contour) => contour.length > 1);
  const vertexCount = contours.reduce((count, contour) => count + contour.length, 0);
  requireCad(vertexCount > 1 && vertexCount <= regionVertexLimit, 'Invalid symbol path size.');
  if (filledSymbol(fill)) {
    requireCad(
      contours.length === 1 && contours[0][0].join() === contours[0].at(-1).join(),
      'Filled symbol paths require one closed contour.',
    );
    spend(vertexCount ** 2);
    regionPolygon(contours[0], point);
  }
  return contours.map((contour) => [
    'polyline',
    ['pts', ...contour.map(([x, y]) => point('xy', x, y))],
    ...symbolStyle(width, style, fill, color),
  ]);
}

function curveSegments(sweep, radiusMm) {
  // Leave room for native coordinate rounding within the 1 µm chord error.
  const step = Math.min(Math.PI / 2, 2 * Math.acos(1 - Math.min(1, curveToleranceMm / radiusMm)));
  return Math.ceil(Math.abs(sweep) / step);
}

function symbolCurvePoints({ start, end, at, sweep, radiusMm }) {
  const segments = curveSegments(sweep, radiusMm);
  requireCad(segments <= 512, 'Elliptical symbol graphics exceed the segment limit.');
  const vertices = [start];
  for (let i = 1; i < segments; i++) vertices.push(at(i / segments));
  return [...vertices, end];
}

function symbolGraphics(fields, point, spend) {
  const [type, ...args] = fields;
  switch (type) {
    case 'R':
      return symbolRectangle(fields, point, spend);
    case 'PT':
      return symbolPath(args, point, spend);
    case 'A': {
      const [path, , color, width, style, fill] = args;
      const appearance = symbolStyle(width, style, fill, color);
      const arc = parseArc(path, true);
      if (!arc) return [];
      if (filledSymbol(fill)) {
        const gap = Math.hypot(arc.start[0] - arc.end[0], arc.start[1] - arc.end[1]) * mmPerUnit;
        requireCad(
          Math.abs(arc.sweep) > Math.PI && gap <= curveToleranceMm,
          'Filled symbol arcs must have a negligible closing chord.',
        );
        const vertices = symbolCurvePoints(arc);
        spend(vertices.length ** 2);
        const { nodes } = regionPolygon(vertices, point);
        return [['polyline', ['pts', ...nodes, nodes[0]], ...appearance]];
      }
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
      const points = symbolCurvePoints(arc).map(([x, y]) => point('xy', x, y));
      return [['polyline', ['pts', ...points], ...appearance]];
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
      const rx = positive(r);
      const ry = type === 'E' ? positive(args[3]) : rx;
      const [, width, style, fill] = args.slice(type === 'C' ? 3 : 4);
      const appearance = symbolStyle(width, style, fill);
      if (rx !== ry) {
        const cx = number(x);
        const cy = number(y);
        const start = [cx + rx, cy];
        const sweep = 2 * Math.PI;
        const ellipse = {
          start,
          end: start,
          sweep,
          radiusMm: Math.max(rx, ry) * mmPerUnit,
          at: (fraction) => [
            cx + rx * Math.cos(fraction * sweep),
            cy + ry * Math.sin(fraction * sweep),
          ],
        };
        const points = symbolCurvePoints(ellipse).map(([x, y]) => point('xy', x, y));
        return [['polyline', ['pts', ...points], ...appearance]];
      }
      return [['circle', point('center', x, y), ['radius', mm(rx)], ...appearance]];
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

function readSymbolUnits(value, document, name) {
  const { subparts } = value;
  if (subparts === undefined || (Array.isArray(subparts) && subparts.length === 0))
    return [document];
  const linkedPackage = value.dataStr.head.puuid;
  const componentName = text(document.parameters?.name, 300);
  requireCad(
    Array.isArray(subparts) &&
      subparts.length <= 32 &&
      componentName.trim() &&
      typeof linkedPackage === 'string' &&
      cadUuid.test(linkedPackage),
    'Unsupported multi-unit symbol container.',
  );
  const units = Array(subparts.length);
  const ids = new Set();
  for (const unit of subparts) {
    const child = readDocument(unit?.dataStr, '6', unit?.uuid, document.notice);
    const reference = child.parameters?.pre;
    const match =
      typeof reference === 'string' && /^([A-Za-z][A-Za-z0-9_]*\??)\.([1-9]\d?)$/.exec(reference);
    const index = Number(match?.[2]) - 1;
    requireCad(
      match?.[1] === document.parameters.pre &&
        index < units.length &&
        !units[index] &&
        !ids.has(unit.uuid) &&
        unit.dataStr.head.puuid === linkedPackage &&
        child.parameters.Supplier === 'LCSC' &&
        child.parameters['Supplier Part'] === name &&
        child.parameters.name === componentName &&
        child.notice === document.notice,
      'Symbol subpart identity or unit number does not match.',
    );
    ids.add(unit.uuid);
    units[index] = child;
  }
  return units;
}

function convertSymbol(entry, document, unitDocuments, name) {
  const prefix = text(document.parameters?.pre, 32).replace(/\?$/, '');
  requireCad(/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix), 'Unsupported reference prefix.');
  const overview = unitDocuments[0] !== document ? document.shapes : [];
  requireCad(
    unitDocuments.reduce((count, unit) => count + unit.shapes.length, overview.length) <= 2000,
    'The symbol has too many primitives.',
  );
  let graphicCount = 0;
  let regionWork = 0;
  const spend = (work) => {
    regionWork += work;
    requireCad(regionWork <= regionWorkLimit, 'Symbol paths exceed the geometry work limit.');
  };
  const units = unitDocuments.map(({ origin, shapes }) => {
    const point = localPoint(origin, true);
    const pins = [],
      graphics = [];
    for (const shape of shapes) {
      if (shape.startsWith('P~')) pins.push(pin(shape, point));
      else {
        const converted = symbolGraphics(shape.split('~'), point, spend);
        graphicCount += converted.length;
        requireCad(graphicCount <= 2000, 'The symbol has too many graphics.');
        graphics.push(...converted);
      }
    }
    requireCad(pins.length > 0, 'Missing physical pins.');
    return { graphics, pins };
  });
  const pins = units.flatMap((unit) => unit.pins);
  const physicalPins = new Map();
  for (const { pinNumber, pinName, electricalType } of pins) {
    const previous = physicalPins.get(pinNumber);
    requireCad(
      !previous || (previous.pinName === pinName && previous.electricalType === electricalType),
      'Repeated physical pin numbers have conflicting names or electrical types.',
    );
    physicalPins.set(pinNumber, { pinName, electricalType });
  }
  if (overview.length) {
    const point = localPoint(document.origin, true);
    const overviewPins = overview.filter((shape) => shape.startsWith('P~'));
    requireCad(
      overviewPins.length > 0 &&
        overviewPins.every((shape) => physicalPins.has(pin(shape, point).pinNumber)),
      'The parent symbol drawing has pins missing from its subparts.',
    );
  }
  const showNames = pins.some((item) => item.nameVisible);
  const showNumbers = pins.some((item) => item.numberVisible);
  const nativeUnits = units.map(({ graphics, pins }, index) => [
    'symbol',
    quote(name + '_' + (index + 1) + '_1'),
    ...(units.length > 1 ? graphics : []),
    ...pins.map((item) => item.node(showNames, showNumbers)),
  ]);
  return [
    'symbol',
    quote(entry.id),
    ['pin_names', ...(showNames ? [['offset', '0.508']] : [['hide', 'yes']])],
    ...(showNumbers ? [] : [['pin_numbers', ['hide', 'yes']]]),
    ['in_bom', 'yes'],
    ['on_board', 'yes'],
    ['exclude_from_sim', 'no'],
    property('Reference', prefix),
    property('Value', entry.name),
    property('Footprint', entry.footprint ?? '', true),
    property('Description', entry.description, true),
    property('OpenPE.LibrarySource', [attributionSource, ...homepages].join(' · '), true),
    property('OpenPE.LibraryLicense', document.notice, true),
    ...(units.length === 1 ? [['symbol', quote(name + '_0_1'), ...units[0].graphics]] : []),
    ...nativeUnits,
  ];
}

function inversePadRotation(x, y, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians),
    sin = Math.sin(radians);
  return [x * cos - y * sin, x * sin + y * cos];
}

function rectangularPad(outline, width, height) {
  const tolerance = 0.000001;
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
  if (outline.length < 4 || outline.length > 8) return;
  const size = { x: Number(mm(width)), y: Number(mm(height)) };
  const halfWidth = size.x / 2,
    halfHeight = size.y / 2;
  const vertex = (c) => ({ x: c.x * halfWidth, y: c.y * halfHeight });
  const corners = pcbPadCorners.filter((c) => !outline.some((p) => near(p, vertex(c))));
  let ratio = 0;
  if (corners.length) {
    const offCorner = outline.find((p) => !pcbPadCorners.some((c) => near(p, vertex(c))));
    if (!offCorner) return;
    const dx = halfWidth - Math.abs(offCorner.x),
      dy = halfHeight - Math.abs(offCorner.y);
    const cut = Math.abs(dx) <= tolerance ? dy : dx;
    const shorter = Math.min(size.x, size.y);
    if (!(cut > tolerance && cut <= shorter / 2 + tolerance)) return;
    ratio = Number(Math.min(0.5, cut / shorter).toFixed(12));
  }
  const expected = pcbPadCorners.flatMap((c) =>
    corners.includes(c)
      ? pcbPadChamferEndpoints(c, size, ratio * Math.min(size.x, size.y))
      : [vertex(c)],
  );
  const ring = expected.filter(
    (p, i) => !near(p, expected[(i + expected.length - 1) % expected.length]),
  );
  if (outline.length !== ring.length) return;
  const start = outline.findIndex((p) => near(p, ring[0]));
  if (
    start === -1 ||
    ![1, -1].some((direction) =>
      ring.every((p, i) =>
        near(p, outline[(start + direction * i + outline.length) % outline.length]),
      ),
    )
  )
    return;
  return corners.length
    ? [
        ['roundrect_rratio', '0'],
        ['chamfer_ratio', String(ratio)],
        ['chamfer', ...corners.map((corner) => corner.name)],
      ]
    : [];
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
    outline,
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
  const shapes = { RECT: 'rect', ELLIPSE: 'circle', OVAL: 'oval', POLYGON: 'rect' };
  const through = layer === '11';
  const surface = { 1: 'F', 2: 'B' }[layer];
  requireCad(
    Object.hasOwn(shapes, kind) && !net && (through || surface),
    'Unsupported pad shape, layer or net.',
  );
  requireCad(!through || plating === 'Y' || plating === 'N', 'Unsupported through-hole plating.');
  const radius = r ? number(r) : 0;
  requireCad(through ? radius > 0 : radius === 0, 'Pad drill does not match its type.');
  const padX = number(x),
    padY = number(y);
  const width = positive(w),
    height = positive(h);
  const rotation = number(angle);
  requireCad(rotation >= 0 && rotation <= 360, 'Unsupported pad rotation.');
  const nativeRotation = native(rotation % 360);
  let shape = shapes[kind];
  let padSize = ['size', mm(width), mm(height)];
  let geometry = [];
  if (kind === 'POLYGON') {
    const contour = points(outline);
    if (contour.length > 2 && contour[0].every((n, i) => n === contour.at(-1)[i])) contour.pop();
    const local = contour.map(([px, py]) => {
      const [u, v] = inversePadRotation(px - padX, py - padY, Number(nativeRotation));
      return { x: u * mmPerUnit, y: v * mmPerUnit };
    });
    const corners = rectangularPad(local, width, height);
    if (corners) {
      if (corners.length) shape = 'roundrect';
      geometry = corners;
    } else {
      shape = 'custom';
      // KiCad requires an anchor. The shared reader verifies this anchor adds no copper.
      padSize = ['size', '0.0001', '0.0001'];
      geometry = [
        ['options', ['clearance', 'outline'], ['anchor', 'rect']],
        [
          'primitives',
          [
            'gr_poly',
            ['pts', ...local.map((p) => ['xy', native(p.x), native(p.y)])],
            ['width', '0'],
            ['fill', 'yes'],
          ],
        ],
      ];
    }
  }
  const length = slot ? number(slot) : 0;
  requireCad(
    length >= 0 && (length ? through && length > 2 * radius && !!holePoints : !holePoints),
    'A slot needs a through-hole pad, a length greater than the tool diameter and a centreline.',
  );
  let center = [padX, padY];
  if (through && holeCenter) {
    const fields = holeCenter.split(',').map((value) => value.trim());
    requireCad(fields.length === 2, 'Invalid drill centre.');
    center = fields.map(number);
  }
  const diameter = mm(2 * radius);
  const drill = ['drill', diameter];
  if (length) {
    const ends = points(holePoints);
    requireCad(ends.length === 2, 'A slot needs exactly two tool centreline endpoints.');
    const [[ax, ay], [bx, by]] = ends;
    const [dx, dy] = inversePadRotation(bx - ax, by - ay, Number(nativeRotation));
    const midpoint = [(ax + bx) / 2, (ay + by) / 2];
    // EasyEDA's redundant centre can drift slightly from the explicit tool path.
    const endpointTolerance = 0.001 / mmPerUnit;
    const midpointTolerance = 0.002 / mmPerUnit;
    requireCad(
      Math.abs(Math.hypot(dx, dy) - (length - 2 * radius)) <= endpointTolerance &&
        (!holeCenter ||
          Math.hypot(center[0] - midpoint[0], center[1] - midpoint[1]) <= midpointTolerance),
      'Slot length, centre and endpoints disagree.',
    );
    const horizontal = Math.abs(dx) > Math.abs(dy);
    requireCad(
      Math.abs(horizontal ? dy : dx) <= endpointTolerance &&
        Math.abs(horizontal ? dx : dy) > endpointTolerance &&
        mm(length) !== diameter,
      'The slot must follow one of the pad axes.',
    );
    center = midpoint;
    drill.splice(1, 1, 'oval', ...(horizontal ? [mm(length), diameter] : [diameter, mm(length)]));
  }
  const offset = inversePadRotation(padX - center[0], padY - center[1], Number(nativeRotation)).map(
    mm,
  );
  const shifted = offset.some((coordinate) => coordinate !== '0');
  if (shifted) drill.push(['offset', ...offset]);
  if (through && plating === 'N') {
    requireCad(
      (length
        ? shape === 'oval'
        : !shifted && shape === 'circle' && width === height && mm(width) === diameter) &&
        (!paste || number(paste) === 0),
      'Unsupported non-plated pad.',
    );
  }
  requireCad(shape !== 'circle' || width === height, 'Elliptical copper pads are unsupported.');
  return [
    'pad',
    quote(text(code, 64)),
    through ? (plating === 'Y' ? 'thru_hole' : 'np_thru_hole') : 'smd',
    shape,
    [...point('at', ...center), nativeRotation],
    padSize,
    ...geometry,
    ...(through ? [drill] : []),
    through
      ? plating === 'Y'
        ? ['layers', quote('*.Cu'), quote('*.Mask')]
        : ['layers', quote('*.Mask')]
      : ['layers', quote(surface + '.Cu'), quote(surface + '.Paste'), quote(surface + '.Mask')],
    ...(paste && !(through && plating === 'N') ? [['solder_paste_margin', mm(number(paste))]] : []),
    ...(mask ? [['solder_mask_margin', mm(number(mask))]] : []),
  ];
}

function roundHole(point, x, y, radius, mask) {
  const diameter = mm(2 * positive(radius));
  return [
    'pad',
    quote(''),
    'np_thru_hole',
    'circle',
    point('at', x, y),
    ['size', diameter, diameter],
    ['drill', diameter],
    ['layers', quote('*.Mask')],
    ...(mask ? [['solder_mask_margin', mm(number(mask))]] : []),
  ];
}

function parseArc(path, allowEllipse = false) {
  const match = arcPath.exec(path);
  requireCad(match, 'Unsupported SVG arc path.');
  const [, sx, sy, rx, ry, rotation, large, sweepFlag, ex, ey] = match;
  const xRadius = positive(rx),
    yRadius = positive(ry);
  requireCad(
    xRadius === yRadius || (allowEllipse && number(rotation) % 180 === 0),
    'Unsupported elliptical arc.',
  );
  const start = [number(sx), number(sy)];
  const end = [number(ex), number(ey)];
  if (start[0] === end[0] && start[1] === end[1]) return;
  return arcBetween(start, end, xRadius, yRadius, 0, large, sweepFlag);
}

function arcBetween(start, end, xRadius, yRadius, rotation, large, sweepFlag) {
  const yRatio = yRadius / xRadius;
  const tilt = ((rotation % 360) * Math.PI) / 180;
  const cos = Math.cos(tilt),
    sin = Math.sin(tilt);
  const dxWorld = (start[0] - end[0]) / 2;
  const dyWorld = (start[1] - end[1]) / 2;
  const dx = dxWorld * cos + dyWorld * sin;
  const dy = (-dxWorld * sin + dyWorld * cos) / yRatio;
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
    circular: xRadius === yRadius,
    radiusMm: radius * Math.max(1, yRatio) * mmPerUnit,
    sweep,
    at(fraction) {
      const theta = angle + fraction * sweep;
      const x = cx + radius * Math.cos(theta);
      const y = (cy + radius * Math.sin(theta)) * yRatio;
      return [start[0] + x * cos - y * sin, start[1] + x * sin + y * cos];
    },
  };
}

function appendBezier(vertices, controls, depth = 0) {
  const start = controls[0],
    end = controls.at(-1);
  const asPoint = ([x, y]) => ({ x, y });
  const toleranceSquared = (curveToleranceMm / mmPerUnit) ** 2;
  if (
    controls
      .slice(1, -1)
      .every(
        (control) =>
          pointSegmentDistance(asPoint(control), asPoint(start), asPoint(end)) <= toleranceSquared,
      )
  ) {
    requireCad(vertices.length < regionVertexLimit, 'Filled region has too many vertices.');
    vertices.push(end);
    return;
  }
  requireCad(depth < 16, 'Filled region exceeds its curve limit.');
  const left = [start],
    right = [end];
  let row = controls;
  while (row.length > 1) {
    row = row.slice(1).map(([x, y], i) => [(x + row[i][0]) / 2, (y + row[i][1]) / 2]);
    left.push(row[0]);
    right.push(row.at(-1));
  }
  appendBezier(vertices, left, depth + 1);
  appendBezier(vertices, right.reverse(), depth + 1);
}

function svgPathContours(path, traceClosure = false, contourLimit = 32) {
  requireCad(typeof path === 'string' && path.length <= 128_000, 'Invalid SVG path.');
  const tokens = path.match(pathToken) ?? [];
  requireCad(
    /^[Mm]$/.test(tokens[0]) && tokens.length <= regionVertexLimit * 8,
    'Invalid SVG path start or size.',
  );
  let cursor = 0,
    command = '',
    previous = [0, 0],
    vertices = [],
    curve;
  const contours = [];
  const finish = () => {
    requireCad(
      vertices.length > 0 && contours.length < contourLimit,
      'Invalid SVG path contour count.',
    );
    contours.push(vertices);
    vertices = [];
  };
  const read = () => number(tokens[cursor++]);
  while (cursor < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[cursor])) command = tokens[cursor++];
    const kind = command.toUpperCase();
    const relative = command !== kind;
    const [x, y] = previous;
    const nextX = () => read() + (relative ? x : 0);
    const nextY = () => read() + (relative ? y : 0);
    const previousCurve = curve;
    curve = undefined;
    if (kind === 'M') {
      if (vertices.length) finish();
      previous = [nextX(), nextY()];
      vertices.push(previous);
      command = relative ? 'l' : 'L';
      continue;
    }
    requireCad(
      vertices.length > 0 && ['L', 'H', 'V', 'A', 'C', 'S', 'Q', 'T', 'Z'].includes(kind),
      'Unsupported SVG path command.',
    );
    if (kind === 'Z') {
      if (traceClosure && previous.join() !== vertices[0].join()) vertices.push(vertices[0]);
      previous = vertices[0];
      finish();
      command = '';
      continue;
    }
    if (['Q', 'T', 'C', 'S'].includes(kind)) {
      const cubic = kind === 'C' || kind === 'S';
      const smooth = kind === 'S' || kind === 'T';
      const reflected =
        previousCurve?.cubic === cubic
          ? [2 * x - previousCurve.control[0], 2 * y - previousCurve.control[1]]
          : previous;
      const controls = [previous, smooth ? reflected : [nextX(), nextY()]];
      if (cubic) controls.push([nextX(), nextY()]);
      curve = { cubic, control: controls.at(-1) };
      previous = [nextX(), nextY()];
      controls.push(previous);
      appendBezier(vertices, controls);
      continue;
    }
    if (kind === 'A') {
      const rx = Math.abs(read()),
        ry = Math.abs(read()),
        tilt = read();
      const large = tokens[cursor++],
        sweep = tokens[cursor++];
      requireCad(
        ['0', '1'].includes(large) && ['0', '1'].includes(sweep),
        'Invalid region arc flags.',
      );
      const end = [nextX(), nextY()];
      if (x === end[0] && y === end[1]) continue;
      if (rx === 0 || ry === 0) {
        previous = end;
        vertices.push(end);
        requireCad(vertices.length <= regionVertexLimit, 'Filled region has too many vertices.');
        continue;
      }
      const arc = arcBetween(previous, end, rx, ry, tilt, large, sweep);
      const segments = curveSegments(arc.sweep, arc.radiusMm);
      requireCad(
        vertices.length + segments <= regionVertexLimit,
        'Filled region has too many vertices.',
      );
      for (let i = 1; i < segments; i++) vertices.push(arc.at(i / segments));
      previous = end;
    } else {
      previous = [kind === 'V' ? x : nextX(), kind === 'H' ? y : nextY()];
    }
    vertices.push(previous);
    requireCad(vertices.length <= regionVertexLimit, 'Filled region has too many vertices.');
  }
  if (vertices.length) finish();
  return contours;
}

function footprintPath(path) {
  requireCad(typeof path === 'string' && path.length <= 128_000, 'Invalid footprint path.');
  return /^\s*[Mm]/.test(path) ? svgPathContours(path) : [points(path)];
}

function regionPolygon(vertices, point) {
  requireCad(vertices.length <= regionVertexLimit, 'Filled region has too many vertices.');
  const nodes = vertices.map(([x, y]) => point('xy', x, y));
  if (nodes.length > 1 && nodes[0].join() === nodes.at(-1).join()) nodes.pop();
  requireCad(
    nodes.length >= 3 && new Set(nodes.map((node) => node.join())).size === nodes.length,
    'Filled region needs at least three distinct vertices.',
  );
  const ring = nodes.map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
  const origin = ring[0];
  const area = ring.reduce((sum, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return sum + (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }, 0);
  requireCad(Math.abs(area) > 1e-12, 'Filled region must enclose an area.');
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      requireCad(
        segmentDistance(ring[i], ring[i + 1], ring[j], ring[(j + 1) % ring.length]) > 1e-18,
        'Filled region edges must not cross or touch.',
      );
    }
  }
  return { nodes, ring };
}

function regionPolygons(contours, point, layer, spend, width = 0) {
  const vertices = contours.reduce((count, contour) => count + contour.length, 0);
  requireCad(vertices <= regionVertexLimit, 'Filled region has too many vertices.');
  spend(vertices ** 2);
  const polygons = contours.map((contour) => regionPolygon(contour, point));
  for (let i = 0; i < polygons.length; i++) {
    const a = polygons[i].ring;
    for (let j = i + 1; j < polygons.length; j++) {
      const b = polygons[j].ring;
      requireCad(
        !insidePolygon(a[0], { outer: b, holes: [] }) &&
          !insidePolygon(b[0], { outer: a, holes: [] }),
        'Nested filled contours are unsupported.',
      );
      for (let k = 0; k < a.length; k++) {
        for (let l = 0; l < b.length; l++) {
          requireCad(
            segmentDistance(a[k], a[(k + 1) % a.length], b[l], b[(l + 1) % b.length]) > 1e-18,
            'Filled contours must not cross or touch.',
          );
        }
      }
    }
  }
  return polygons.map(({ nodes }) => [
    'fp_poly',
    ['pts', ...nodes],
    stroke(width),
    ['fill', layer === 'Edge.Cuts' ? 'none' : 'yes'],
    ['layer', quote(layer)],
  ]);
}

function footprintModel(attrs, origin) {
  const { uuid, c_origin: center, c_rotation: rotation, z, transform } = attrs;
  if (typeof uuid !== 'string' || !/^[a-f0-9]{32}$/.test(uuid)) return;
  const coords = typeof center === 'string' ? center.split(',').map((v) => v.trim()) : [];
  const angles = typeof rotation === 'string' ? rotation.split(',').map((v) => v.trim()) : [];
  if (coords.length !== 2 || angles.length !== 3) return;
  try {
    // Uniform scale and translation position the SVG outline. The linked STEP uses its own pose.
    if (transform !== undefined) {
      const fields = typeof transform === 'string' && outlineTransform.exec(transform);
      if (!fields) return;
      const [scale] = fields.slice(1).map(number);
      if (scale <= 0) return;
    }
    const [x, y] = coords.map(number);
    const [rx, ry, rz] = angles.map(number);
    const height = number(z);
    // Native STEP offsets follow KiCad's EasyEDA Standard library frame.
    return {
      path: `JLCPCB:${uuid}.step`,
      offset: ['offset', ['xyz', mm(origin[0] - x), mm(origin[1] - y), mm(height)]],
      rotate: ['rotate', ['xyz', native(-rx % 360), native(-ry % 360), native(-rz % 360)]],
    };
  } catch {
    // An unsupported model pose does not invalidate verified 2D manufacturing geometry.
  }
}

function svgFootprintPath(node, layer, point, spend) {
  const attrs = node?.attrs;
  requireCad(
    node?.nodeType === 1 &&
      node.nodeName === 'path' &&
      !node.childNodes?.length &&
      attrs &&
      typeof attrs.d === 'string' &&
      !['transform', 'style', 'class', 'mask', 'clip-path', 'opacity', 'fill-opacity'].some(
        (key) => attrs[key] !== undefined,
      ) &&
      (attrs.fill === undefined || /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(attrs.fill)) &&
      (attrs.stroke === undefined || attrs.stroke === 'none'),
    'Unsupported embedded footprint path.',
  );
  if (previewLayers.includes(layer)) return [];
  requireCad(
    layer !== '10' && Object.hasOwn(graphicLayers, layer),
    'Unsupported embedded footprint layer.',
  );
  return regionPolygons(footprintPath(attrs.d), point, graphicLayers[layer], spend);
}

function labelStrokes(fields, point, layer) {
  const [, kind, , , width, , , , net, , , path, visibility] = fields;
  requireCad(kind === 'L' && !net, 'Unsupported footprint text.');
  if (visibility === 'none') return [];
  requireCad(/^\s*[Mm]/.test(path), 'Footprint text requires a stored glyph path.');
  const contours = svgPathContours(path, true, glyphContourLimit);
  requireCad(
    contours.reduce((count, contour) => count + contour.length, 0) <= glyphVertexLimit,
    'Footprint text has too many glyph points.',
  );
  const pen = stroke(positive(width)),
    layerNode = ['layer', quote(layer)];
  const lines = contours.flatMap((contour) =>
    contour
      .slice(1)
      .map((end, index) => [
        'fp_line',
        point('start', ...contour[index]),
        point('end', ...end),
        pen,
        layerNode,
      ]),
  );
  requireCad(lines.length > 0, 'Footprint text requires visible glyph strokes.');
  return lines;
}

function footprintGraphics(fields, point, spend) {
  const [shape, first, second, third, fourth, fifth] = fields;
  const layerId = {
    TRACK: second,
    ARC: second,
    CIRCLE: fifth,
    RECT: fifth,
    SOLIDREGION: first,
    TEXT: fields[7],
  }[shape];
  requireCad(layerId, 'Unsupported footprint primitive.');
  // EasyEDA document and 3D preview layers have no manufacturing geometry.
  if (previewLayers.includes(layerId)) {
    const documentIdentifier =
      layerId === '12' && fourth === 'solid' && generatedShapeId.test(second);
    requireCad(
      shape !== 'SOLIDREGION' ||
        documentIdentifier ||
        (!second && ['solid', 'cutout'].includes(fourth)),
      'Unsupported preview region.',
    );
    return [];
  }
  const cutout = shape === 'SOLIDREGION' && layerId === '11' && fourth === 'npth';
  requireCad(
    cutout || Object.hasOwn(graphicLayers, layerId),
    'Unsupported footprint layer (including standalone copper graphics).',
  );
  const layer = cutout ? 'Edge.Cuts' : graphicLayers[layerId];
  const aperture = ['5', '6', '7', '8'].includes(layerId);
  const edge = layer === 'Edge.Cuts';
  if (shape === 'SOLIDREGION') {
    requireCad(
      !second &&
        (cutout || (!edge && fourth === 'solid')) &&
        (!fields[6] || fields[6] === '0') &&
        !fields[7] &&
        !fields[8],
      'Unsupported filled region.',
    );
    return regionPolygons(footprintPath(third), point, layer, spend, cutout ? 0.1 / mmPerUnit : 0);
  }
  if (shape === 'RECT') {
    const [, , , , , , , , width, fill, transform, net, kind] = fields;
    requireCad(!transform && !net && !kind, 'Unsupported footprint rectangle.');
    const x = number(first),
      y = number(second);
    const right = x + positive(third),
      bottom = y + positive(fourth);
    const strokeWidth = width ? number(width) : 0;
    requireCad(strokeWidth >= 0, 'A stroke cannot be negative.');
    if (fill !== 'none') {
      requireCad(
        !edge && (!aperture || strokeWidth === 0),
        'Unsupported filled footprint rectangle.',
      );
      return regionPolygons(
        [
          [
            [x, y],
            [right, y],
            [right, bottom],
            [x, bottom],
          ],
        ],
        point,
        layer,
        spend,
        strokeWidth,
      );
    }
    requireCad(!aperture && strokeWidth > 0, 'Unsupported outline rectangle.');
    return [
      [
        'fp_rect',
        point('start', x, y),
        point('end', right, bottom),
        stroke(strokeWidth),
        ['layer', quote(layer)],
      ],
    ];
  }
  requireCad(!aperture, 'Paste and mask graphics require a filled region.');
  requireCad(!edge || shape !== 'TEXT', 'Board edges cannot contain text.');
  const layerNode = ['layer', quote(layer)];
  const silkscreenIdentifier = ['3', '4'].includes(layerId) && generatedShapeId.test(third);
  switch (shape) {
    case 'TEXT':
      return labelStrokes(fields, point, layer);
    case 'TRACK': {
      requireCad(!third || silkscreenIdentifier, 'Footprint graphics cannot have electrical nets.');
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
      requireCad(!third || silkscreenIdentifier, 'Footprint graphics cannot have electrical nets.');
      const arc = parseArc(fourth);
      requireCad(arc, 'Degenerate arc.');
      const { start, end, at } = arc;
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
  let regionWork = 0;
  const spend = (work) => {
    regionWork += work;
    requireCad(
      regionWork <= regionWorkLimit,
      'Footprint filled regions exceed the geometry work limit.',
    );
  };
  for (const shape of document.shapes) {
    if (shape.startsWith('SVGNODE~')) {
      const node = JSON.parse(shape.slice('SVGNODE~'.length));
      const layer = String(node?.layerid);
      if (layer === '19' && node.attrs?.c_etype === 'outline3D')
        modelRecords.push(footprintModel(node.attrs, document.origin));
      else graphics.push(...svgFootprintPath(node, layer, point, spend));
    } else {
      const fields = shape.split('~');
      if (fields[0] === 'PAD') pads.push(convertPad(fields, point));
      else if (fields[0] === 'HOLE') pads.push(roundHole(point, fields[1], fields[2], fields[3]));
      else graphics.push(...footprintGraphics(fields, point, spend));
    }
    requireCad(graphics.length <= 2000, 'The linked footprint has too many graphics.');
  }
  const models = modelRecords.length <= 32 ? modelRecords.filter(Boolean) : [];
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
      ...models.map(({ path, offset, rotate }) => ['model', quote(path), offset, rotate]),
    ],
    pads: [...new Set(pads.map((pad) => JSON.parse(pad[1])).filter(Boolean))],
    models,
    attribution: { source: attributionSource, homepages, notice: document.notice },
  };
}

export function convertJlcpcbComponent(entry, value) {
  const name = entry.id.slice('JLCPCB:'.length);
  const head = value.dataStr?.head;
  requireCad(
    typeof value.uuid === 'string' &&
      cadUuid.test(value.uuid) &&
      hasDocumentIdentity(head, '2', head?.uuid) &&
      head.c_para?.Supplier === 'LCSC' &&
      head.c_para['Supplier Part'] === name,
    'Unsupported library document.',
  );
  const linked = value.packageDetail;
  const component = linked ? { ...entry, footprint: entry.id } : entry;
  const converted = {};
  const diagnostic = (error) =>
    String(error.message)
      .replace(/[\u0000-\u001f]/g, ' ')
      .slice(0, 300);
  if (linked) {
    try {
      requireCad(
        linked.uuid === head.puuid && linked.docType === 4,
        'Linked footprint identity or type does not match.',
      );
      const footprint = convertFootprint(
        entry,
        readDocument(linked.dataStr, '4', linked.uuid),
        name,
      );
      const project = createProject();
      project.pcb = createEmptyPCB();
      project.pcb.footprints = [
        {
          id: crypto.randomUUID(),
          libraryId: entry.id,
          symbolId: null,
          reference: 'U1',
          value: name,
          side: 'front',
          x: 0,
          y: 0,
          rotation: 0,
          ...readLibraryFootprint(footprint),
        },
      ];
      validateProject(project);
      converted.footprints = footprint;
    } catch (error) {
      converted.footprintError = 'Footprint unavailable: ' + diagnostic(error);
    }
  }
  try {
    const document = readDocument(value.dataStr, '2', head.uuid);
    const units = readSymbolUnits(value, document, name);
    const symbol = convertSymbol(component, document, units, name);
    const project = createProject();
    project.schematic.libraries = { [entry.id]: symbol };
    for (let i = 0; i < units.length; i++) {
      project.schematic.parts.push(
        createLibraryPart(project.schematic, symbol, i * 30.48, 0, i + 1),
      );
    }
    validateProject(project);
    converted.symbols = {
      ...component,
      symbol,
      units: units.length,
      attribution: { source: attributionSource, homepages, notice: document.notice },
      ...(converted.footprintError
        ? { warning: converted.footprintError, footprintPreview: 'unavailable' }
        : converted.footprints
          ? { footprintPreview: converted.footprints.models.length ? '2d-and-3d' : '2d' }
          : { footprintPreview: 'unavailable' }),
    };
  } catch (error) {
    converted.symbolError = 'Symbol unavailable: ' + diagnostic(error);
  }
  return converted;
}
