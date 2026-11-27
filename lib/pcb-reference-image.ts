import { isOwnedProjectNode } from './immutable-project-ownership.mjs';
import { readKiCadEmbeddedPng } from './kicad-embedded-png';
import { pcbBoardLayers, type BoardLayer } from './pcb-layer-stack';
import { child, val, type SExpr } from './sexpr';

type PCBReferenceImage = ReturnType<typeof readKiCadEmbeddedPng> & {
  id: string;
  layer: BoardLayer;
};

const cachedImages = new WeakMap<SExpr, PCBReferenceImage>();
const fields = new Set(['at', 'layer', 'scale', 'locked', 'uuid', 'data']);
const invalidImage = (): never => {
  throw new Error('KiCad PCB: Unsupported reference image. Use bounded embedded PNG artwork.');
};

function readReferenceImage(node: SExpr): PCBReferenceImage {
  const cached = cachedImages.get(node);
  if (cached) return cached;
  const seen = new Set<string>();
  if (node[0] !== 'image') return invalidImage();
  for (const field of node.slice(1)) {
    if (
      !Array.isArray(field) ||
      typeof field[0] !== 'string' ||
      !fields.has(field[0]) ||
      seen.has(field[0])
    )
      return invalidImage();
    seen.add(field[0]);
  }
  const uuid = child(node, 'uuid');
  const nativeLayer = child(node, 'layer');
  const locked = child(node, 'locked');
  const id = val(uuid);
  const layer = pcbBoardLayers.find((value) => value === val(nativeLayer));
  if (
    uuid?.length !== 2 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    nativeLayer?.length !== 2 ||
    !layer ||
    (locked && (locked.length !== 2 || !['yes', 'no'].includes(val(locked))))
  )
    return invalidImage();
  const image = { id, layer, ...readKiCadEmbeddedPng(node, invalidImage) };
  if (isOwnedProjectNode(node)) cachedImages.set(node, Object.freeze(image));
  return image;
}

export function pcbReferenceImages(records?: readonly SExpr[]): PCBReferenceImage[] {
  if (!records?.length) return [];
  if (records.length > 16) return invalidImage();
  const images = records.map(readReferenceImage);
  if (images.reduce((pixels, image) => pixels + image.pixels, 0) > 16_000_000)
    return invalidImage();
  return images;
}
