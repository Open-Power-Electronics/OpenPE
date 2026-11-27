import { readKiCadEmbeddedPng } from './kicad-embedded-png';
import { child, children, val, type SExpr } from './sexpr';
import { isOwnedProjectNode } from './immutable-project-ownership.mjs';

type SchematicImage = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
  href: string;
};
const cachedImages = new WeakMap<SExpr, SchematicImage>();
const invalidImage = (): never => {
  throw new Error(
    'Unsupported schematic image. Use bounded embedded PNG artwork. The original file was not modified.',
  );
};

function readImage(node: SExpr): SchematicImage {
  const cached = cachedImages.get(node);
  if (cached) return cached;
  const scale = child(node, 'scale');
  const uuid = child(node, 'uuid');
  if (node.length !== (scale ? 5 : 4) || uuid?.length !== 2) return invalidImage();
  const id = val(uuid);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return invalidImage();
  const image = { id, ...readKiCadEmbeddedPng(node, invalidImage) };
  if (isOwnedProjectNode(node)) cachedImages.set(node, Object.freeze(image));
  return image;
}

export function schematicImages(original?: SExpr) {
  const records = children(original ?? [], 'image');
  if (records.length > 16) return invalidImage();
  const images = records.map(readImage);
  if (images.reduce((pixels, image) => pixels + image.pixels, 0) > 16_000_000)
    return invalidImage();
  return images;
}

export const schematicImageCorners = (original?: SExpr) =>
  schematicImages(original).flatMap(({ x, y, width, height }) => [
    { x, y },
    { x: x + width, y: y + height },
  ]);
