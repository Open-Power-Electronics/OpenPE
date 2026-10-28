import { child, children, val, type SExpr } from './sexpr';
import type { Footprint, FootprintModel } from './pcb';

/** Metadata only. Runtime model access resolves a fixed bundled footprint ID. */
export function footprintModels(root: SExpr): FootprintModel[] {
  const models = children(root, 'model');
  if (models.length > 32) throw new Error('A footprint supports at most 32 3D model links.');
  return models.map((node) => {
    const names = node.filter(Array.isArray).map((n) => String(n[0]));
    if (
      new Set(names).size !== names.length ||
      node.slice(2).some((n) => !Array.isArray(n) && n !== 'hide')
    )
      throw new Error('Repeated or unsupported 3D model settings.');
    const path = val(node);
    if (!path || path.length > 4096 || /[\u0000-\u001f]/.test(path))
      throw new Error('Invalid 3D model reference.');
    const vector = (name: string, fallback: number) => {
      const item = child(node, name);
      const xyz = item && child(item, 'xyz');
      if (item && (!xyz || item.length !== 2 || xyz.length !== 4))
        throw new Error(`Unsupported 3D model ${name}.`);
      const values = xyz
        ? [1, 2, 3].map((i) => (val(xyz, i).trim() ? Number(val(xyz, i)) : NaN))
        : [fallback, fallback, fallback];
      if (values.some((n) => !Number.isFinite(n) || Math.abs(n) > 100000))
        throw new Error(`Invalid 3D model ${name}.`);
      if (name === 'scale' && values.some((n) => n <= 0 || n > 1000))
        throw new Error('3D model scales must be positive and at most 1000.');
      return { x: values[0], y: values[1], z: values[2] };
    };
    if (
      node
        .filter(Array.isArray)
        .some((n) => !['offset', 'scale', 'rotate', 'hide', 'opacity'].includes(String(n[0])))
    )
      throw new Error('Unsupported 3D model settings.');
    const opacityNode = child(node, 'opacity');
    const opacity = opacityNode && val(opacityNode).trim() ? Number(val(opacityNode)) : NaN;
    if (
      opacityNode &&
      (opacityNode.length !== 2 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    )
      throw new Error('3D model opacity must be a number from 0 to 1.');
    return {
      path,
      offset: vector('offset', 0),
      scale: vector('scale', 1),
      rotation: vector('rotate', 0),
      ...(opacityNode ? { opacity } : {}),
      ...((child(node, 'hide') && val(child(node, 'hide')) !== 'no') || node.includes('hide')
        ? { hidden: true }
        : {}),
    };
  });
}

/** Missing instance links use official models in the embedded footprint's frame.
 * Boards may reanchor pads without changing the library ID. Only a translation
 * shared by every numbered pad is safe to infer; viewing never edits the board.
 */
export function resolveFootprintModels(footprint: Footprint, official: SExpr): FootprintModel[] {
  if (footprint.models !== undefined) return footprint.models;
  const models = footprintModels(official);
  if (!models.length) return models;
  const groups = (pads: { number: string; x: number; y: number }[]) => {
    const result = new Map<string, { x: number; y: number }[]>();
    for (const pad of pads) {
      if (!pad.number) continue;
      const points = result.get(pad.number) ?? [];
      points.push({ x: pad.x, y: pad.y });
      result.set(pad.number, points);
    }
    for (const points of result.values()) points.sort((a, b) => a.x - b.x || a.y - b.y);
    return result;
  };
  const source = groups(
    children(official, 'pad').map((pad) => ({
      number: val(pad),
      x: Number(val(child(pad, 'at'), 1) || 0),
      y: Number(val(child(pad, 'at'), 2) || 0),
    })),
  );
  const embedded = groups(
    footprint.pads.map((pad) => ({
      ...pad,
      // Native back-side pad geometry is already mirrored; models are not.
      y: footprint.side === 'back' ? -pad.y : pad.y,
    })),
  );
  const fail = (): never => {
    throw new Error(
      'The 3D model cannot be aligned with the embedded pads. Reassign the footprint or specify its model placement in Source.',
    );
  };
  if (!source.size || source.size !== embedded.size) return fail();
  let translation: { x: number; y: number } | undefined;
  for (const [number, points] of source) {
    const matching = embedded.get(number);
    if (!matching || matching.length !== points.length) return fail();
    for (let i = 0; i < points.length; i++) {
      const delta = { x: matching[i].x - points[i].x, y: matching[i].y - points[i].y };
      translation ??= delta;
      if (
        !Number.isFinite(delta.x) ||
        !Number.isFinite(delta.y) ||
        Math.abs(delta.x - translation.x) > 0.00001 ||
        Math.abs(delta.y - translation.y) > 0.00001
      )
        return fail();
    }
  }
  const { x, y } = translation!;
  return models.map((model) => ({
    ...model,
    offset: {
      x: Number((model.offset.x + x).toFixed(6)),
      y: Number((model.offset.y - y).toFixed(6)),
      z: model.offset.z,
    },
  }));
}

/** Model coordinates use upward Y, footprint coordinates use downward Y. */
export function modelPlacement(
  f: { x: number; y: number; rotation: number; side: 'front' | 'back' },
  thickness: number,
) {
  return {
    x: f.x,
    y: -f.y,
    z: f.side === 'front' ? thickness / 2 : -thickness / 2,
    rotation: (f.rotation * Math.PI) / 180,
    flipped: f.side === 'back',
  };
}
