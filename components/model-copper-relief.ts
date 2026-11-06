import * as THREE from 'three';

type SurfaceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;

/** Display shading only: neither a native copper thickness nor a measured stackup. */
export const MODEL_COPPER_RELIEF_MICROMETERS = 35;
export const MODEL_COPPER_RELIEF_MAX_SIZE = 1024;
const maxTriangles = 250_000;
const maxScanlines = 1_000_000;
const maxRasterPixels = 96_000_000;

function eligibleCopper(mask: SurfaceMesh, copper: SurfaceMesh) {
  const maskLayer = mask.userData.modelExplosionLayer;
  const copperLayer = copper.userData.modelExplosionLayer;
  if (maskLayer !== 'F.Mask' && maskLayer !== 'B.Mask') return false;
  return copperLayer === (maskLayer === 'F.Mask' ? 'F.Cu' : 'B.Cu');
}

/** Match native ShapeGeometry UVs (local XY), also allowing the aligned unit-UV fixtures. */
function maskFrame(mask: SurfaceMesh) {
  const positions = mask.geometry.getAttribute('position');
  const uv = mask.geometry.getAttribute('uv');
  if (!positions?.count || !uv || uv.count !== positions.count) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  let uMinX = 0,
    uMaxX = 0,
    vMinY = 0,
    vMaxY = 0;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index),
      y = positions.getY(index);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) {
      minX = x;
      uMinX = uv.getX(index);
    }
    if (x > maxX) {
      maxX = x;
      uMaxX = uv.getX(index);
    }
    if (y < minY) {
      minY = y;
      vMinY = uv.getY(index);
    }
    if (y > maxY) {
      maxY = y;
      vMaxY = uv.getY(index);
    }
  }
  const width = maxX - minX,
    height = maxY - minY;
  const uRange = uMaxX - uMinX,
    vRange = vMaxY - vMinY;
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height) || !uRange || !vRange)
    return null;
  for (let index = 0; index < positions.count; index++)
    if (
      Math.abs((positions.getX(index) - minX) / width - (uv.getX(index) - uMinX) / uRange) > 1e-5 ||
      Math.abs((positions.getY(index) - minY) / height - (uv.getY(index) - vMinY) / vRange) > 1e-5
    )
      return null;
  return { minX, minY, width, height, uMinX, vMinY, uRange, vRange };
}

/**
 * Derive a bounded normal map from the union of visible, same-side native copper
 * triangles. Vertex positions, mask apertures, native UVs and source images are untouched.
 * Unsupported UV layouts or excessive raster work omit relief, retaining physical tracing.
 */
export function createModelCopperRelief(mask: SurfaceMesh, copperSurfaces: readonly SurfaceMesh[]) {
  const frame = maskFrame(mask);
  if (!frame || !copperSurfaces.length) return null;
  const longest = Math.max(frame.width, frame.height);
  const resolution = Math.min(MODEL_COPPER_RELIEF_MAX_SIZE, Math.max(128, Math.ceil(longest * 24)));
  const width = Math.max(8, Math.round((resolution * frame.width) / longest));
  const height = Math.max(8, Math.round((resolution * frame.height) / longest));
  const coverage = new Uint8Array(width * height);
  const inverse = mask.matrixWorld.clone().invert();
  const matrix = new THREE.Matrix4();
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let triangles = 0,
    scanlines = 0,
    rasterPixels = 0,
    covered = false;
  for (const copper of copperSurfaces) {
    let visible = true;
    for (let ancestor: THREE.Object3D | null = copper; ancestor; ancestor = ancestor.parent)
      if (!ancestor.visible || ancestor.userData.modelMeasurementExcluded) visible = false;
    if (!visible) continue;
    if (!eligibleCopper(mask, copper)) continue;
    matrix.multiplyMatrices(inverse, copper.matrixWorld);
    const position = copper.geometry.getAttribute('position');
    if (!position) continue;
    const index = copper.geometry.getIndex();
    const count = index ? index.count : position.count;
    const first = Math.max(0, copper.geometry.drawRange.start);
    const end = Math.min(count, first + copper.geometry.drawRange.count);
    if (triangles + Math.floor((end - first) / 3) > maxTriangles) return null;
    for (let start = first; start + 2 < end; start += 3) {
      if (++triangles > maxTriangles) return null;
      vertices.forEach((point, offset) => {
        point
          .fromBufferAttribute(position, index ? index.getX(start + offset) : start + offset)
          .applyMatrix4(matrix);
        point.x = ((point.x - frame.minX) * width) / frame.width;
        point.y = ((point.y - frame.minY) * height) / frame.height;
      });
      if (!vertices.every((point) => Number.isFinite(point.x + point.y))) return null;
      if (
        Math.abs(
          (vertices[1].x - vertices[0].x) * (vertices[2].y - vertices[0].y) -
            (vertices[2].x - vertices[0].x) * (vertices[1].y - vertices[0].y),
        ) <= 1e-10
      )
        continue;
      const fromY = Math.max(0, Math.ceil(Math.min(...vertices.map((point) => point.y)) - 0.5));
      const toY = Math.min(
        height - 1,
        Math.floor(Math.max(...vertices.map((point) => point.y)) - 0.5),
      );
      for (let row = fromY; row <= toY; row++) {
        if (++scanlines > maxScanlines) return null;
        const sampleY = row + 0.5;
        let min = Infinity,
          max = -Infinity;
        for (let edge = 0; edge < 3; edge++) {
          const a = vertices[edge],
            b = vertices[(edge + 1) % 3];
          if ((a.y <= sampleY && b.y > sampleY) || (b.y <= sampleY && a.y > sampleY)) {
            const crossing = a.x + ((sampleY - a.y) * (b.x - a.x)) / (b.y - a.y);
            min = Math.min(min, crossing);
            max = Math.max(max, crossing);
          }
        }
        const fromX = Math.max(0, Math.ceil(min - 0.5));
        const toX = Math.min(width - 1, Math.floor(max - 0.5));
        if (fromX > toX) continue;
        rasterPixels += toX - fromX + 1;
        if (rasterPixels > maxRasterPixels) return null;
        coverage.fill(1, row * width + fromX, row * width + toX + 1);
        covered = true;
      }
    }
  }
  if (!covered) return null;
  // A small separable 1:2:1 filter softens foil shoulders without moving their centres.
  const horizontal = new Float32Array(coverage.length);
  const smoothed = new Float32Array(coverage.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const row = y * width;
      horizontal[row + x] =
        (coverage[row + Math.max(0, x - 1)] +
          2 * coverage[row + x] +
          coverage[row + Math.min(width - 1, x + 1)]) /
        4;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      smoothed[y * width + x] =
        (horizontal[Math.max(0, y - 1) * width + x] +
          2 * horizontal[y * width + x] +
          horizontal[Math.min(height - 1, y + 1) * width + x]) /
        4;
  const data = new Uint8Array(width * height * 4);
  const relief = MODEL_COPPER_RELIEF_MICROMETERS / 1000;
  const normal = new THREE.Vector3();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx =
        ((smoothed[y * width + Math.min(width - 1, x + 1)] -
          smoothed[y * width + Math.max(0, x - 1)]) *
          relief *
          width) /
        (2 * frame.width);
      const dy =
        ((smoothed[Math.min(height - 1, y + 1) * width + x] -
          smoothed[Math.max(0, y - 1) * width + x]) *
          relief *
          height) /
        (2 * frame.height);
      normal.set(-dx, -dy, 1).normalize();
      const offset = (y * width + x) * 4;
      data[offset] = Math.round((normal.x * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = 'OpenPE display copper relief';
  texture.userData.modelCopperReliefMicrometers = MODEL_COPPER_RELIEF_MICROMETERS;
  texture.offset.set(-frame.uMinX / frame.uRange, -frame.vMinY / frame.vRange);
  texture.repeat.set(1 / frame.uRange, 1 / frame.vRange);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.updateMatrix();
  texture.needsUpdate = true;
  return texture;
}
