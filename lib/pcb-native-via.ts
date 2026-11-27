import { pcbCopperLayers, type CopperLayer } from './pcb-layer-stack';
import { children, quote, val, type SExpr } from './sexpr';

export type PCBViaSpan = {
  kind: 'blind' | 'buried' | 'micro';
  start: CopperLayer;
  end: CopperLayer;
};
type ViaSides = { front?: boolean; back?: boolean };
export type PCBViaTreatment = {
  capping?: boolean;
  covering?: ViaSides;
  plugging?: ViaSides;
  filling?: boolean;
};
type PCBViaBackdrill = { diameter: number; start: 'F.Cu' | 'B.Cu'; end: CopperLayer };
export type PCBViaBackdrills = { secondary?: PCBViaBackdrill; tertiary?: PCBViaBackdrill };
export type PCBViaPruning = {
  removeUnusedLayers?: boolean;
  keepEndLayers?: boolean;
  startEndOnly?: boolean;
  zoneLayerConnections?: CopperLayer[];
};

const kinds = ['blind', 'buried', 'micro'] as const;
const sides = ['front', 'back'] as const;
const backdrillFields = [
  ['backdrill', 'secondary'],
  ['tertiary_drill', 'tertiary'],
] as const;

export function pcbViaCopperLayers(layers: readonly CopperLayer[], via: { span?: PCBViaSpan }) {
  if (!via.span) return layers;
  return layers.slice(layers.indexOf(via.span.start), layers.indexOf(via.span.end) + 1);
}

export function isPCBViaSpanValid(layers: readonly CopperLayer[], span: PCBViaSpan) {
  const start = layers.indexOf(span.start);
  const end = layers.indexOf(span.end);
  return start >= 0 && end > start && (span.kind !== 'micro' || end === start + 1);
}

export function readPCBViaBackdrills(node: SExpr, fail: (message: string) => never) {
  const result: PCBViaBackdrills = {};
  for (const [native, key] of backdrillFields) {
    const [record, repeated] = children(node, native);
    if (!record) continue;
    const [size, extraSize] = children(record, 'size');
    const [layers, extraLayers] = children(record, 'layers');
    const start = val(layers);
    const end = pcbCopperLayers.find((layer) => layer === val(layers, 2));
    const diameter = Number(val(size));
    if (
      repeated ||
      record.length !== 3 ||
      extraSize ||
      extraLayers ||
      size?.length !== 2 ||
      !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(size[1])) ||
      !(diameter >= 0.000001 && diameter <= 1000) ||
      layers?.length !== 3 ||
      (start !== 'F.Cu' && start !== 'B.Cu') ||
      !end
    )
      return fail('Invalid native via backdrill diameter or layer range.');
    result[key] = { diameter, start, end };
  }
  return result.secondary || result.tertiary ? result : undefined;
}

export function validatePCBViaBackdrills(
  via: { span?: PCBViaSpan; backdrills?: PCBViaBackdrills },
  layers: readonly CopperLayer[],
  fail: (message: string) => never,
) {
  if (!via.backdrills) return;
  const span = pcbViaCopperLayers(layers, via);
  for (const drill of Object.values(via.backdrills))
    if (!span.includes(drill.start) || !span.includes(drill.end))
      fail('Native backdrills require outer entry and a must-cut layer within the via span.');
}

export function writePCBViaBackdrills(backdrills?: PCBViaBackdrills) {
  if (!backdrills) return '';
  return backdrillFields
    .map(([native, key]) => {
      const drill = backdrills[key];
      return drill
        ? ` (${native} (size ${drill.diameter}) (layers ${quote(drill.start)} ${quote(drill.end)}))`
        : '';
    })
    .join('');
}

export function pcbViaOpeningDiameter(via: { drill: number; backdrills?: PCBViaBackdrills }) {
  return Math.max(
    via.drill,
    via.backdrills?.secondary?.diameter ?? 0,
    via.backdrills?.tertiary?.diameter ?? 0,
  );
}

/** A must-cut layer belongs to the machined span. This uses stack order for
 * both entry sides and the larger diameter when two operations overlap. */
export function pcbViaBackdrillDiameterOnLayer(
  via: { backdrills?: PCBViaBackdrills },
  layer: CopperLayer,
): number {
  if (!via.backdrills) return 0;
  const index = pcbCopperLayers.indexOf(layer);
  let diameter = 0;
  for (const drill of Object.values(via.backdrills)) {
    const start = pcbCopperLayers.indexOf(drill.start);
    const end = pcbCopperLayers.indexOf(drill.end);
    if (index >= Math.min(start, end) && index <= Math.max(start, end))
      diameter = Math.max(diameter, drill.diameter);
  }
  return diameter;
}

export function readPCBViaSpan(
  node: SExpr,
  layers: readonly CopperLayer[],
  fail: (message: string) => never,
) {
  const records = children(node, 'layers');
  const [record] = records;
  if (
    records.length !== 1 ||
    record.length !== 3 ||
    record.slice(1).some((layer) => typeof layer !== 'string')
  )
    return fail('Invalid native via layers.');
  const start = layers.find((layer) => layer === val(record));
  const end = layers.find((layer) => layer === val(record, 2));
  const atoms = node.slice(1).filter((entry) => typeof entry === 'string' && entry !== 'locked');
  const kind = kinds.find((option) => option === atoms[0]);
  if (atoms.length > 1 || (atoms.length && !kind))
    return fail('Invalid or unsupported native via type.');
  if (!kind) {
    if (start !== 'F.Cu' || end !== 'B.Cu') fail('Through via requires both outer copper layers.');
    return;
  }
  if (!start || !end || !isPCBViaSpanValid(layers, { kind, start, end }))
    return fail('Invalid native via span for this copper stack.');
  return { kind, start, end };
}

export function readPCBViaFlag(
  node: SExpr,
  key: string,
  fail: (message: string) => never,
  allowBare = false,
) {
  const records = children(node, key);
  const [record] = records;
  if (!record) return;
  if (
    records.length !== 1 ||
    (record.length !== 2 && !(allowBare && record.length === 1)) ||
    (record.length === 2 && record[1] !== 'yes' && record[1] !== 'no')
  )
    return fail(`Invalid native via ${key} setting.`);
  return record.length === 1 || record[1] === 'yes';
}

export function readPCBViaPruning(node: SExpr, fail: (message: string) => never): PCBViaPruning {
  const removeUnusedLayers = readPCBViaFlag(node, 'remove_unused_layers', fail, true);
  const keepEndLayers = readPCBViaFlag(node, 'keep_end_layers', fail, true);
  const startEndOnly = readPCBViaFlag(node, 'start_end_only', fail, true);
  const [record, duplicate] = children(node, 'zone_layer_connections');
  if (duplicate || record?.slice(1).some((entry) => typeof entry !== 'string'))
    return fail('Invalid native via zone layer connections.');
  const zoneLayerConnections = record?.slice(1).map((_, i) => val(record, i + 1) as CopperLayer);
  if (zoneLayerConnections?.some((layer) => !pcbCopperLayers.includes(layer)))
    return fail('Native via zone connections require copper layers.');
  return {
    ...(removeUnusedLayers === undefined ? {} : { removeUnusedLayers }),
    ...(keepEndLayers === undefined ? {} : { keepEndLayers }),
    ...(startEndOnly === undefined ? {} : { startEndOnly }),
    ...(zoneLayerConnections === undefined ? {} : { zoneLayerConnections }),
  };
}

export function writePCBViaPruning(pruning: PCBViaPruning) {
  const fields = [
    ...(pruning.removeUnusedLayers === undefined
      ? []
      : [`(remove_unused_layers ${pruning.removeUnusedLayers ? 'yes' : 'no'})`]),
    ...(pruning.keepEndLayers === undefined
      ? []
      : [`(keep_end_layers ${pruning.keepEndLayers ? 'yes' : 'no'})`]),
    ...(pruning.startEndOnly === undefined
      ? []
      : [`(start_end_only ${pruning.startEndOnly ? 'yes' : 'no'})`]),
    ...(pruning.zoneLayerConnections
      ? [
          `(zone_layer_connections${pruning.zoneLayerConnections.map((layer) => ` ${quote(layer)}`).join('')})`,
        ]
      : []),
  ];
  return fields.length ? ` ${fields.join(' ')}` : '';
}

export function readPCBViaTreatment(node: SExpr, fail: (message: string) => never) {
  const treatment: PCBViaTreatment = {};
  for (const key of ['capping', 'filling'] as const) {
    const value = readPCBViaFlag(node, key, fail);
    if (value !== undefined) treatment[key] = value;
  }
  for (const key of ['covering', 'plugging'] as const) {
    const records = children(node, key);
    const [record] = records;
    if (!record) continue;
    if (records.length !== 1 || record.length < 2 || record.length > 3)
      return fail(`Invalid native via ${key} settings.`);
    const values: ViaSides = {};
    for (const flag of record.slice(1)) {
      if (
        !Array.isArray(flag) ||
        flag.length !== 2 ||
        (flag[0] !== 'front' && flag[0] !== 'back') ||
        (flag[1] !== 'yes' && flag[1] !== 'no') ||
        Object.hasOwn(values, flag[0])
      )
        return fail(`Invalid native via ${key} settings.`);
      values[flag[0]] = flag[1] === 'yes';
    }
    treatment[key] = values;
  }
  return Object.keys(treatment).length ? treatment : undefined;
}

export function pcbViaHasTreatment(treatment?: PCBViaTreatment): boolean {
  return Boolean(
    treatment?.capping ||
    treatment?.filling ||
    sides.some((side) => treatment?.covering?.[side] || treatment?.plugging?.[side]),
  );
}

export function writePCBViaTreatment(treatment: PCBViaTreatment) {
  const flag = (value: boolean) => (value ? 'yes' : 'no');
  return (['capping', 'covering', 'plugging', 'filling'] as const)
    .flatMap((key) => {
      const value = treatment[key];
      if (value === undefined) return [];
      if (typeof value === 'boolean') return [`(${key} ${flag(value)})`];
      const records = sides.flatMap((side) =>
        value[side] === undefined ? [] : [`(${side} ${flag(value[side])})`],
      );
      return [`(${key} ${records.join(' ')})`];
    })
    .join(' ');
}
