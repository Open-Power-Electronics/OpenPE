import { parseSExpr, child, children, num, val, quote, writeSExpr, type SExpr } from './sexpr';
import { KICAD_SCHEMATIC_VERSION } from './kicad-version';
import { unitGraphics, symbolUnits, symbolAnnotation, createLibraryPart } from './library';
import officialSymbols from './kicad-starter-symbols.json';
import { schematicTexts, schematicTextBoxes, schematicPolylines } from './schematic-text';
import { schematicImages } from './schematic-image';
import { isOwnedCircuit, isOwnedProjectNode, ownProjectData } from './immutable-project';
export type Point = { x: number; y: number };
export type Kind = 'R' | 'C' | 'L' | 'D' | 'NMOS' | 'GND' | 'Port';
export type Part = Point & {
  id: string;
  libId: string;
  ref: string;
  value: string;
  rotation: number;
  mirror?: 'x' | 'y';
  unit?: number;
  fields?: Record<string, string>;
  excludeFromSimulation?: boolean;
  raw?: SExpr;
};
export type Wire = { id: string; a: Point; b: Point; raw?: SExpr };
export const labelShapes = ['input', 'output', 'bidirectional', 'tri_state', 'passive'] as const;
export type Label = Point & {
  id: string;
  text: string;
  rotation?: number;
  scope?: 'global';
  shape?: (typeof labelShapes)[number];
  raw?: SExpr;
};
export type Circuit = {
  id: string;
  title: string;
  parts: Part[];
  wires: Wire[];
  junctions: (Point & { id: string; raw?: SExpr })[];
  labels: Label[];
  noConnects?: (Point & { id: string; raw?: SExpr })[];
  libraries: Record<string, SExpr>;
  original?: SExpr;
};
export const uid = () => crypto.randomUUID();
export const snap = (v: number) => Number((Math.round(v / 1.27) * 1.27).toFixed(4));
export const fmt = (v: number) => String(Number(v.toFixed(4)));
export function circuitFingerprint(d: Circuit): string {
  const source = serializeCircuit(d);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < source.length; i++) {
    a = Math.imul(a ^ source.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ source.charCodeAt(i);
  }
  return `${source.length}:${a >>> 0}:${b >>> 0}`;
}
// Kind is a bounded Agent vocabulary, not an independently drawn symbol library.
export const catalog: { kind: Kind; libId: string; value: string }[] = [
  { kind: 'R', libId: 'Device:R', value: '10k' },
  { kind: 'C', libId: 'Device:C', value: '10uF' },
  { kind: 'L', libId: 'Device:L', value: '22uH' },
  { kind: 'D', libId: 'Device:D_Schottky', value: 'Schottky' },
  { kind: 'NMOS', libId: 'Transistor_FET:Q_NMOS_GDS', value: 'N-MOSFET' },
  { kind: 'GND', libId: 'power:GND', value: 'GND' },
  { kind: 'Port', libId: 'Connector_Generic:Conn_01x01', value: 'Connector' },
];
// Generated from the pinned upstream release; retain its library license/exception.
export const libraries: Record<string, SExpr> = officialSymbols;
export function createPart(circuit: Circuit, kind: Kind, x: number, y: number): Part {
  const meta = catalog.find((c) => c.kind === kind)!;
  const library = circuit.libraries[meta.libId] || libraries[meta.libId];
  const part = createLibraryPart(circuit, library, x, y);
  circuit.libraries[meta.libId] = structuredClone(library);
  part.value = meta.value;
  return part;
}
export function emptyCircuit(): Circuit {
  return {
    id: uid(),
    title: 'Untitled schematic',
    parts: [],
    wires: [],
    junctions: [],
    labels: [],
    libraries: {},
  };
}
const ownedPartPins = new WeakMap<Part, { library: SExpr; points: readonly Point[] }>();
export function pinPositions(part: Part, library: SExpr): Point[] {
  const owned = isOwnedProjectNode(part) && isOwnedProjectNode(library);
  const cached = owned ? ownedPartPins.get(part) : undefined;
  if (cached && cached.library === library) return cached.points.map((point) => ({ ...point }));
  const a = (-part.rotation * Math.PI) / 180;
  const cosine = Math.cos(a),
    sine = Math.sin(a);
  const points = unitGraphics(library, part.unit || 1)
    .flatMap((s) => children(s, 'pin'))
    .map((p) => {
      const at = child(p, 'at');
      const x = num(at),
        y = -num(at, 2);
      return {
        x: Number((part.x + (part.mirror === 'y' ? -1 : 1) * (x * cosine - y * sine)).toFixed(4)),
        y: Number((part.y + (part.mirror === 'x' ? -1 : 1) * (x * sine + y * cosine)).toFixed(4)),
      };
    });
  if (owned && points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
    // The first result is public too. Keep separate points so caller anchors
    // cannot mutate this exact owned Part/library pair's private derivation.
    ownedPartPins.set(part, { library, points: points.map((point) => ({ ...point })) });
  return points;
}
const ownedCircuitSources = new WeakMap<Circuit, string>();
const ownedCircuitTrees = new WeakMap<Circuit, SExpr>();
const ownedRawObjects = new WeakMap<object, SExpr>();
function rememberMaterializedObject(value: object, node: SExpr): SExpr {
  if (!isOwnedProjectNode(value)) return node;
  const owned = ownProjectData(node);
  ownedRawObjects.set(value, owned);
  return owned;
}
/** Materialize exactly the tree written by serializeCircuit. Owned trees are
 * immutable and shared by validation, private snapshots and native export. */
export function materializedCircuitTree(d: Circuit): SExpr {
  const cached = ownedCircuitTrees.get(d);
  if (cached) return cached;
  let root = serializeCircuitContent(d);
  if (isOwnedCircuit(d)) {
    root = ownProjectData(root);
    ownedCircuitTrees.set(d, root);
  }
  return root;
}
export function serializeCircuit(d: Circuit): string {
  const cached = ownedCircuitSources.get(d);
  if (cached !== undefined) return cached;
  const source = writeSExpr(materializedCircuitTree(d)) + '\n';
  if (isOwnedCircuit(d)) ownedCircuitSources.set(d, source);
  return source;
}
function serializeCircuitContent(d: Circuit): SExpr {
  const root: SExpr = [
    'kicad_sch',
    ['version', '20231120'],
    ['generator', '"openpe"'],
    ['uuid', quote(d.id)],
    ['title_block', ['title', quote(d.title)], ['rev', '"0.1"']],
    ['lib_symbols', ...Object.values(d.libraries)],
  ];
  const pt = (p: Point): SExpr => ['xy', fmt(p.x), fmt(p.y)];
  const replace = (n: SExpr, key: string, value: SExpr) => {
    const i = n.findIndex((x) => Array.isArray(x) && x[0] === key);
    if (i < 0) n.push(value);
    else n[i] = value;
  };
  const applyFields = (s: SExpr, p: Part) => {
    const mirror = child(s, 'mirror');
    if (mirror) s.splice(s.indexOf(mirror), 1);
    if (p.mirror) s.push(['mirror', p.mirror]);
    replace(s, 'unit', ['unit', String(p.unit || 1)]);
    for (const [name, value] of Object.entries(p.fields || {})) {
      const existing = children(s, 'property').find((f) => val(f) === name);
      if (existing) existing[2] = quote(value);
      else
        s.push([
          'property',
          quote(name),
          quote(value),
          ['at', fmt(p.x), fmt(p.y), '0'],
          ['effects', ['font', ['size', '1.27', '1.27']], 'hide'],
        ]);
    }
  };
  for (const w of d.wires) {
    const cached = isOwnedProjectNode(w) ? ownedRawObjects.get(w) : undefined;
    if (cached) {
      root.push(cached);
      continue;
    }
    const n = w.raw
      ? structuredClone(w.raw)
      : (['wire', ['stroke', ['width', '0'], ['type', 'default']], ['uuid', quote(w.id)]] as SExpr);
    replace(n, 'pts', ['pts', pt(w.a), pt(w.b)]);
    root.push(rememberMaterializedObject(w, n));
  }
  for (const j of d.junctions) {
    const cached = isOwnedProjectNode(j) ? ownedRawObjects.get(j) : undefined;
    if (cached) {
      root.push(cached);
      continue;
    }
    const n = j.raw
      ? structuredClone(j.raw)
      : ([
          'junction',
          ['diameter', '0'],
          ['color', '0', '0', '0', '0'],
          ['uuid', quote(j.id)],
        ] as SExpr);
    replace(n, 'at', ['at', fmt(j.x), fmt(j.y)]);
    root.push(rememberMaterializedObject(j, n));
  }
  for (const j of d.noConnects || []) {
    const cached = isOwnedProjectNode(j) ? ownedRawObjects.get(j) : undefined;
    if (cached) {
      root.push(cached);
      continue;
    }
    const n = j.raw ? structuredClone(j.raw) : (['no_connect', ['uuid', quote(j.id)]] as SExpr);
    replace(n, 'at', ['at', fmt(j.x), fmt(j.y)]);
    root.push(rememberMaterializedObject(j, n));
  }
  for (const l of d.labels) {
    const cached = isOwnedProjectNode(l) ? ownedRawObjects.get(l) : undefined;
    if (cached) {
      root.push(cached);
      continue;
    }
    const n = l.raw
      ? structuredClone(l.raw)
      : ([
          'label',
          quote(l.text),
          ['effects', ['font', ['size', '1.27', '1.27']], ['justify', 'left', 'bottom']],
          ['uuid', quote(l.id)],
        ] as SExpr);
    n[1] = quote(l.text);
    n[0] = l.scope === 'global' ? 'global_label' : 'label';
    if (l.scope === 'global') replace(n, 'shape', ['shape', l.shape || 'input']);
    replace(n, 'at', ['at', fmt(l.x), fmt(l.y), String(l.rotation || 0)]);
    root.push(rememberMaterializedObject(l, n));
  }
  for (const p of d.parts) {
    if (p.raw) {
      const cached = isOwnedProjectNode(p) ? ownedRawObjects.get(p) : undefined;
      if (cached) {
        root.push(cached);
        continue;
      }
      const s = structuredClone(p.raw),
        old = child(s, 'at'),
        dx = p.x - num(old),
        dy = p.y - num(old, 2);
      replace(s, 'at', ['at', fmt(p.x), fmt(p.y), String(p.rotation)]);
      replace(s, 'unit', ['unit', String(p.unit || 1)]);
      if (p.excludeFromSimulation !== undefined)
        replace(s, 'exclude_from_sim', [
          'exclude_from_sim',
          p.excludeFromSimulation ? 'yes' : 'no',
        ]);
      for (const f of children(s, 'property')) {
        if (val(f) === 'Reference') f[2] = quote(p.ref);
        if (val(f) === 'Value') f[2] = quote(p.value);
        const at = child(f, 'at');
        if (at) {
          at[1] = fmt(num(at) + dx);
          at[2] = fmt(num(at, 2) + dy);
        }
      }
      const updateRefs = (n: SExpr) => {
        for (const c of n.filter((x): x is SExpr => Array.isArray(x))) {
          if (c[0] === 'reference') c[1] = quote(p.ref);
          else if (c[0] === 'unit') c[1] = String(p.unit || 1);
          else updateRefs(c);
        }
      };
      updateRefs(child(s, 'instances') || []);
      applyFields(s, p);
      root.push(rememberMaterializedObject(p, s));
      continue;
    }
    const hidden = p.ref.startsWith('#');
    const horizontal = p.rotation % 180 === 90;
    const textX = hidden || horizontal ? p.x : p.x + 4;
    const refY = horizontal ? p.y - 8 : p.y - 1.8;
    const valueY = hidden ? p.y + 7 : horizontal ? p.y - 4.5 : p.y + 2;
    const refAt = symbolAnnotation(p, d.libraries[p.libId], 'Reference');
    const valueAt = symbolAnnotation(p, d.libraries[p.libId], 'Value');
    const annotation = (anchor: 'start' | 'middle' | 'end' = 'middle'): SExpr => [
      'effects',
      ['font', ['size', '1.27', '1.27']],
      ...(anchor === 'middle' ? [] : [['justify', anchor === 'start' ? 'left' : 'right'] as SExpr]),
    ];
    const s: SExpr = [
      'symbol',
      ['lib_id', quote(p.libId)],
      ['at', fmt(p.x), fmt(p.y), String(p.rotation)],
      ['unit', String(p.unit || 1)],
      ...(p.excludeFromSimulation === undefined
        ? []
        : [['exclude_from_sim', p.excludeFromSimulation ? 'yes' : 'no'] as SExpr]),
      ['in_bom', hidden ? 'no' : 'yes'],
      ['on_board', 'yes'],
      ['dnp', 'no'],
      ['uuid', quote(p.id)],
      [
        'property',
        '"Reference"',
        quote(p.ref),
        ['at', fmt(refAt?.x ?? textX), fmt(refAt?.y ?? refY), '0'],
        hidden
          ? ['effects', ['font', ['size', '1.27', '1.27']], 'hide']
          : annotation(refAt?.anchor),
      ],
      [
        'property',
        '"Value"',
        quote(p.value),
        ['at', fmt(valueAt?.x ?? textX), fmt(valueAt?.y ?? valueY), '0'],
        annotation(valueAt?.anchor),
      ],
    ];
    s.push([
      'instances',
      [
        'project',
        quote(d.title.replace(/[^\p{L}\p{N}_-]/gu, '_')),
        ['path', quote('/' + d.id), ['reference', quote(p.ref)], ['unit', String(p.unit || 1)]],
      ],
    ]);
    applyFields(s, p);
    root.push(s);
  }
  root.push(['sheet_instances', ['path', '"/"', ['page', '"1"']]]);
  if (d.original) {
    const retained = d.original.filter(
      (x) =>
        !Array.isArray(x) ||
        ![
          'paper',
          'lib_symbols',
          'wire',
          'junction',
          'label',
          'global_label',
          'no_connect',
          'symbol',
        ].includes(String(x[0])),
    ) as SExpr;
    // Filter replaced records before detaching metadata. Copying the original
    // embedded libraries and every old symbol only to discard them dominates
    // otherwise small component edits in large imported schematics.
    const rebuilt = isOwnedCircuit(d)
      ? (retained.map((node) =>
          Array.isArray(node) && node[0] === 'title_block' ? structuredClone(node) : node,
        ) as SExpr)
      : structuredClone(retained);
    const title = child(rebuilt, 'title_block');
    if (title) replace(title, 'title', ['title', quote(d.title)]);
    rebuilt.push(
      ...root.filter(
        (x): x is SExpr =>
          Array.isArray(x) &&
          [
            'lib_symbols',
            'wire',
            'junction',
            'label',
            'global_label',
            'no_connect',
            'symbol',
          ].includes(String(x[0])),
      ),
    );
    return rebuilt;
  }
  return root;
}
export function parseCircuit(source: string): Circuit {
  return parseCircuitTree(parseSExpr(source));
}
const supportedOwnedLibraries = new WeakSet<SExpr>();
/** Apply the same supported-subset guard to an already materialized tree. */
export function parseCircuitTree(root: SExpr): Circuit {
  if (root[0] !== 'kicad_sch') throw new Error('Choose a KiCad 6 or newer .kicad_sch file.');
  const version = num(child(root, 'version'));
  if (!Number.isInteger(version) || version < 20200100 || version > Number(KICAD_SCHEMATIC_VERSION))
    throw new Error(
      'Unsupported schematic version. OpenPE supports the single-sheet subset through KiCad 10. The original file was not modified.',
    );
  const allowed = [
    'version',
    'generator',
    'generator_version',
    'uuid',
    'paper',
    'title_block',
    'lib_symbols',
    'wire',
    'junction',
    'label',
    'global_label',
    'no_connect',
    'symbol',
    'sheet_instances',
    'embedded_fonts',
    'text',
    'text_box',
    'image',
    'polyline',
    'rectangle',
  ];
  const unsupported = root
    .filter(Array.isArray)
    .map((x) => String(x[0]))
    .filter((k) => !allowed.includes(k));
  if (unsupported.length)
    throw new Error(
      `Unsupported KiCad objects: ${[...new Set(unsupported)].join(', ')}. The original file was not modified.`,
    );
  const d = emptyCircuit();
  // Native printing metadata has no meaning on OpenPE's infinite canvas.
  // Accept KiCad documents without carrying their paper size into project state.
  d.original = root.filter((node) => !Array.isArray(node) || node[0] !== 'paper');
  schematicTexts(root);
  schematicTextBoxes(root);
  schematicImages(root);
  schematicPolylines(root);
  d.id = val(child(root, 'uuid')) || uid();
  d.title = val(child(child(root, 'title_block') || [], 'title')) || 'Imported schematic';
  d.libraries = {};
  for (const lib of children(child(root, 'lib_symbols') || [], 'symbol')) {
    if (supportedOwnedLibraries.has(lib)) {
      d.libraries[val(lib)] = lib;
      continue;
    }
    if (child(lib, 'extends'))
      throw new Error(
        'Inherited symbols are not supported. Save a self-contained schematic in KiCad first.',
      );
    for (const unit of children(lib, 'symbol')) {
      const match = val(unit).match(/_(\d+)_(\d+)$/);
      if (match && (Number(match[1]) > 100 || Number(match[2]) > 2))
        throw new Error('Unsupported symbol unit or body style.');
      for (const pin of children(unit, 'pin'))
        if (
          ![
            'line',
            'inverted',
            'clock',
            'inverted_clock',
            'input_low',
            'clock_low',
            'output_low',
            'edge_clock_high',
            'non_logic',
          ].includes(String(pin[2]))
        )
          throw new Error('Unsupported pin shape.');
    }
    for (const u of children(lib, 'symbol'))
      for (const g of u.filter(Array.isArray))
        if (!['polyline', 'rectangle', 'circle', 'arc', 'pin', 'text'].includes(String(g[0])))
          throw new Error(`Unsupported symbol primitive: ${g[0]}.`);
        else if (g[0] === 'rectangle' && (child(g, 'radius') || child(g, 'corner_radius')))
          throw new Error(
            'Rounded symbol rectangles are not supported yet. Simplify the symbol in KiCad first.',
          );
    d.libraries[val(lib)] = lib;
    if (isOwnedProjectNode(lib)) supportedOwnedLibraries.add(lib);
  }
  for (const s of children(root, 'symbol')) {
    if (
      (child(s, 'mirror') && !['x', 'y'].includes(val(child(s, 'mirror')))) ||
      num(child(s, 'body_style')) > 1
    )
      throw new Error(
        'Unsupported mirror axis or alternate-body symbol. The original file was not modified.',
      );
    // Locally customized KiCad symbols use lib_name for the embedded definition,
    // while lib_id retains the original catalog link. Never merge distinct aliases.
    const libId = val(child(s, 'lib_name') ?? child(s, 'lib_id'));
    if (!Object.hasOwn(d.libraries, libId)) throw new Error(`Missing embedded symbol: ${libId}`);
    const instancePaths = children(child(s, 'instances') || [], 'project')
      .flatMap((project) => children(project, 'path'))
      .filter((instance) => val(instance) === '/' + d.id);
    const instance = instancePaths[0];
    if (
      instancePaths.some(
        (entry) =>
          val(child(entry, 'reference')) !== val(child(instance, 'reference')) ||
          val(child(entry, 'unit')) !== val(child(instance, 'unit')),
      )
    )
      throw new Error(
        'Conflicting symbol instances for this schematic. Resolve them in KiCad before importing.',
      );
    const unit = num(child(instance || [], 'unit') ?? child(s, 'unit')) || 1;
    if (unit > symbolUnits(d.libraries[libId]))
      throw new Error('Symbol unit is missing from its library.');
    const at = child(s, 'at');
    for (const f of children(s, 'property')) {
      const position = child(f, 'at');
      if (
        position &&
        (![1, 2, 3].every((i) => Number.isFinite(Number(position[i]))) ||
          Math.abs(num(position)) > 100000 ||
          Math.abs(num(position, 2)) > 100000)
      )
        throw new Error('Symbol field coordinates are invalid.');
    }
    const prop = (name: string) =>
      val(
        children(s, 'property').find((p) => val(p) === name),
        2,
      );
    d.parts.push({
      id: val(child(s, 'uuid')) || uid(),
      libId,
      ref: instance ? val(child(instance, 'reference')) : prop('Reference'),
      value: prop('Value'),
      x: num(at),
      y: num(at, 2),
      rotation: num(at, 3),
      ...(child(s, 'mirror') ? { mirror: val(child(s, 'mirror')) as 'x' | 'y' } : {}),
      unit,
      raw: s,
    });
  }
  for (const w of children(root, 'wire')) {
    const p = children(child(w, 'pts') || [], 'xy');
    if (p.length !== 2) throw new Error('Multi-segment wire objects are not supported.');
    d.wires.push({
      id: val(child(w, 'uuid')) || uid(),
      a: { x: num(p[0]), y: num(p[0], 2) },
      b: { x: num(p[1]), y: num(p[1], 2) },
      raw: w,
    });
  }
  for (const j of children(root, 'junction'))
    d.junctions.push({
      id: val(child(j, 'uuid')) || uid(),
      x: num(child(j, 'at')),
      y: num(child(j, 'at'), 2),
      raw: j,
    });
  for (const n of children(root, 'no_connect')) {
    (d.noConnects ||= []).push({
      id: val(child(n, 'uuid')) || uid(),
      x: num(child(n, 'at')),
      y: num(child(n, 'at'), 2),
      raw: n,
    });
  }
  for (const l of [...children(root, 'label'), ...children(root, 'global_label')]) {
    if (
      l[0] === 'global_label' &&
      !labelShapes.includes(val(child(l, 'shape')) as (typeof labelShapes)[number])
    )
      throw new Error('Unsupported global label shape.');
    d.labels.push({
      id: val(child(l, 'uuid')) || uid(),
      text: val(l),
      x: num(child(l, 'at')),
      y: num(child(l, 'at'), 2),
      rotation: num(child(l, 'at'), 3),
      ...(l[0] === 'global_label'
        ? {
            scope: 'global' as const,
            shape: val(child(l, 'shape')) as (typeof labelShapes)[number],
          }
        : {}),
      raw: l,
    });
  }
  for (const p of [
    ...d.parts,
    ...d.junctions,
    ...d.labels,
    ...(d.noConnects || []),
    ...d.wires.flatMap((w) => [w.a, w.b]),
  ])
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
      throw new Error('The schematic contains invalid coordinates.');
  if (d.parts.length > 2000 || d.wires.length > 10000)
    throw new Error('This schematic exceeds the preview size limit.');
  return d;
}
