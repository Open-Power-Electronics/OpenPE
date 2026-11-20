export const maxAnnotations = 4;
export const maxAnnotationElements = 64;
const maxAnnotationImageLength = 1_000_000;
export type AnnotationElement = {
  id: string;
  kind:
    | 'component'
    | 'field'
    | 'wire'
    | 'label'
    | 'junction'
    | 'no-connect'
    | 'text'
    | 'footprint'
    | 'pad'
    | 'track'
    | 'via'
    | 'graphic'
    | 'zone'
    | 'solid';
  label: string;
  properties: Record<string, string>;
};
export type AnnotationImage = { dataUrl: string; width: number; height: number };
export type AnnotationBounds = { x: number; y: number; width: number; height: number };
export type AnnotationMarkup =
  | { kind: 'rectangle'; bounds: AnnotationBounds }
  | { kind: 'freehand'; points: { x: number; y: number }[] };
export type AgentAnnotation = {
  id: string;
  circuitId: string;
  title: string;
  basis: string;
  comment: string;
  elements: AnnotationElement[];
  image: AnnotationImage;
  bounds?: AnnotationBounds;
  markup?: AnnotationMarkup;
  /** PCB snapshots have their own version and board identity, outside project data. */
  target?: 'layout' | 'object';
  version?: 1;
  boardId?: string;
  /** Object overlays belong only to the captured camera and display state. */
  viewBasis?: string;
};
export type LayoutAnnotationContext = {
  version: 1;
  id: string;
  circuitId: string;
  basis: string;
  thickness: number;
  layers: ['F.Cu', 'B.Cu'] | ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  counts: Record<'nets' | 'footprints' | 'pads' | 'tracks' | 'vias' | 'graphics' | 'zones', number>;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid annotation data.');
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unsupported annotation field.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, nonempty = true): value is string {
  return typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim());
}
function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}
export function validateLayoutAnnotationContext(
  value: unknown,
): asserts value is LayoutAnnotationContext | undefined {
  if (value === undefined) return;
  const context = record(value, [
    'version',
    'id',
    'circuitId',
    'basis',
    'thickness',
    'layers',
    'counts',
  ]);
  if (
    context.version !== 1 ||
    !text(context.id, 36) ||
    !uuid.test(context.id) ||
    !text(context.circuitId, 36) ||
    !uuid.test(context.circuitId) ||
    !text(context.basis, 80) ||
    !/^\d+:\d+:\d+$/.test(context.basis) ||
    !coordinate(context.thickness) ||
    context.thickness < 0.0001 ||
    context.thickness > 1000 ||
    !Array.isArray(context.layers) ||
    !['["F.Cu","B.Cu"]', '["F.Cu","In1.Cu","In2.Cu","B.Cu"]'].includes(
      JSON.stringify(context.layers),
    )
  )
    throw new Error('Invalid layout annotation context.');
  // Match the canonical board's bounded collections, including nested footprint data.
  const limits: Record<keyof LayoutAnnotationContext['counts'], number> = {
    nets: 5000,
    footprints: 2000,
    pads: 4_000_000,
    tracks: 10000,
    vias: 10000,
    graphics: 20_010_000,
    zones: 2_001_000,
  };
  const keys = Object.keys(limits) as (keyof typeof limits)[];
  const counts = record(context.counts, keys);
  if (
    keys.some(
      (key) =>
        !Number.isInteger(counts[key]) ||
        Number(counts[key]) < 0 ||
        Number(counts[key]) > limits[key],
    )
  )
    throw new Error('Invalid layout element counts.');
}
function validateAnnotationBounds(value: unknown): asserts value is AnnotationBounds {
  const b = record(value, ['x', 'y', 'width', 'height']);
  if (
    !Object.values(b).every(coordinate) ||
    !coordinate(b.x) ||
    !coordinate(b.y) ||
    !coordinate(b.width) ||
    !coordinate(b.height) ||
    b.width <= 0 ||
    b.height <= 0
  )
    throw new Error('Invalid annotation bounds.');
}
export function validateAnnotationMarkup(value: unknown): asserts value is AnnotationMarkup {
  const m = record(value);
  if (m.kind === 'rectangle') {
    record(m, ['kind', 'bounds']);
    validateAnnotationBounds(m.bounds);
  } else if (m.kind === 'freehand') {
    record(m, ['kind', 'points']);
    if (!Array.isArray(m.points) || m.points.length < 2 || m.points.length > 512)
      throw new Error('Drawing must contain between 2 and 512 points.');
    for (const raw of m.points) {
      const p = record(raw, ['x', 'y']);
      if (!coordinate(p.x) || !coordinate(p.y)) throw new Error('Invalid drawing point.');
    }
  } else throw new Error('Unsupported annotation drawing.');
}
export function validateAnnotationImage(value: unknown): asserts value is AnnotationImage {
  const image = record(value, ['dataUrl', 'width', 'height']);
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    Number(image.width) < 1 ||
    Number(image.height) < 1 ||
    Number(image.width) > 1600 ||
    Number(image.height) > 1200 ||
    !text(image.dataUrl, maxAnnotationImageLength) ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl)
  )
    throw new Error('Annotation screenshots must be bounded PNG images.');
  const base64 = image.dataUrl.slice('data:image/png;base64,'.length);
  if (base64.length % 4) throw new Error('Invalid annotation image encoding.');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (bytes.length < 57 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
    throw new Error('Invalid annotation PNG.');
  let offset = 8,
    data = false,
    end = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (
      offset + length + 12 > bytes.length ||
      !['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'PLTE', 'tRNS', 'sBIT'].includes(
        type,
      )
    )
      throw new Error('Unsupported annotation PNG data.');
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('Invalid PNG header.');
    if (
      type === 'IHDR' &&
      (offset !== 8 ||
        view.getUint32(offset + 8) !== image.width ||
        view.getUint32(offset + 12) !== image.height)
    )
      throw new Error('Invalid PNG dimensions.');
    if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') {
      end = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!data || !end) throw new Error('Incomplete annotation PNG.');
}
export function validateAnnotations(
  value: unknown,
): asserts value is AgentAnnotation[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maxAnnotations)
    throw new Error(`Attach up to ${maxAnnotations} annotations per message.`);
  const ids = new Set<string>();
  for (const raw of value) {
    const a = record(raw, [
      'id',
      'circuitId',
      'title',
      'basis',
      'comment',
      'elements',
      'image',
      'bounds',
      'markup',
      'target',
      'version',
      'boardId',
      'viewBasis',
    ]);
    const layout = a.target === 'layout' || a.target === 'object';
    if (layout) {
      if (a.version !== 1 || !text(a.boardId, 36) || !uuid.test(a.boardId))
        throw new Error('Invalid PCB annotation version or board identity.');
    } else if (a.target !== undefined || a.version !== undefined || a.boardId !== undefined) {
      throw new Error('Unsupported annotation target.');
    }
    if (a.target === 'object') {
      if (!text(a.viewBasis, 80) || !/^\d+:\d+:\d+$/.test(a.viewBasis))
        throw new Error('Invalid object annotation view.');
    } else if (a.viewBasis !== undefined) throw new Error('Unsupported annotation view.');
    if (a.bounds !== undefined) validateAnnotationBounds(a.bounds);
    if (a.markup !== undefined) {
      validateAnnotationMarkup(a.markup);
      if (!a.bounds) throw new Error('A drawing requires annotation bounds.');
    }
    if (
      !text(a.id, 36) ||
      !uuid.test(a.id) ||
      ids.has(a.id) ||
      !text(a.circuitId, 36) ||
      !uuid.test(a.circuitId) ||
      !text(a.title, 4096) ||
      !text(a.basis, 80) ||
      !/^\d+:\d+:\d+$/.test(a.basis) ||
      !text(a.comment, 4096) ||
      !Array.isArray(a.elements) ||
      (!a.elements.length && !a.markup) ||
      a.elements.length > maxAnnotationElements
    )
      throw new Error('Invalid annotation snapshot or comment.');
    ids.add(a.id);
    const elements = new Set<string>();
    for (const rawElement of a.elements) {
      const e = record(rawElement, ['id', 'kind', 'label', 'properties']);
      if (
        !text(e.id, 64) ||
        (!uuid.test(e.id) &&
          (layout || !/^field\/[0-9a-f-]{36}\/(Reference|Value|Sim\.Params)$/i.test(e.id))) ||
        elements.has(e.id) ||
        (!(a.target === 'object' && e.kind === 'solid') &&
          !(
            layout
              ? ['footprint', 'pad', 'track', 'via', 'graphic', 'zone']
              : ['component', 'field', 'wire', 'label', 'junction', 'no-connect', 'text']
          ).includes(String(e.kind))) ||
        !text(e.label, 4096)
      )
        throw new Error('Invalid annotated element.');
      elements.add(e.id);
      const properties = record(e.properties);
      if (
        Object.keys(properties).length > 80 ||
        Object.entries(properties).some(
          ([key, value]) =>
            !text(key, 128) ||
            ['__proto__', 'constructor', 'prototype'].includes(key) ||
            !text(value, 8192, false),
        )
      )
        throw new Error('Invalid annotated element properties.');
    }
    if (JSON.stringify(a.elements).length > 100_000)
      throw new Error('The selected element properties exceed 100 KB. Select fewer elements.');
    validateAnnotationImage(a.image);
  }
}
export function annotationContext(annotations: AgentAnnotation[]) {
  return annotations.map(({ image: _image, ...annotation }, index) => ({
    ...annotation,
    screenshot: index + 1,
  }));
}
