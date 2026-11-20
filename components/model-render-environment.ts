import * as THREE from 'three';

type ModelRenderEnvironment = {
  map: THREE.DataTexture;
  marginalWeights: THREE.DataTexture;
  conditionalWeights: THREE.DataTexture;
  totalSum: number;
  dispose(): void;
};

/** Prepare only the owned procedural studio map, without modifying its texture source. */
export function createModelRenderEnvironment(source: THREE.DataTexture): ModelRenderEnvironment {
  const { width, height, data } = source.image;
  if (
    !source.isDataTexture ||
    source.type !== THREE.FloatType ||
    source.format !== THREE.RGBAFormat ||
    source.colorSpace !== THREE.LinearSRGBColorSpace ||
    source.mapping !== THREE.EquirectangularReflectionMapping ||
    source.flipY ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 256 ||
    !(data instanceof Float32Array) ||
    data.length !== width * height * 4
  )
    throw new Error('The Model environment must be a bounded linear RGBA float studio texture.');

  const pixels = new Uint16Array(data.length);
  for (let index = 0; index < data.length; index++) {
    const value = data[index];
    if (!Number.isFinite(value) || value < 0 || value > (index % 4 === 3 ? 1 : 65504))
      throw new Error('The Model environment contains unsupported radiance or opacity.');
    pixels[index] = THREE.DataUtils.toHalfFloat(value);
  }

  // Match the pinned renderer's half-precision map and Float32 CDF rounding.
  const conditional = new Float32Array(width * height);
  const marginal = new Float32Array(height);
  let totalSum = 0,
    marginalSum = 0;
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const weight =
        0.2126 * THREE.DataUtils.fromHalfFloat(pixels[4 * index]) +
        0.7152 * THREE.DataUtils.fromHalfFloat(pixels[4 * index + 1]) +
        0.0722 * THREE.DataUtils.fromHalfFloat(pixels[4 * index + 2]);
      rowSum += weight;
      totalSum += weight;
      conditional[index] = rowSum;
    }
    if (rowSum !== 0) for (let x = 0; x < width; x++) conditional[y * width + x] /= rowSum;
    marginalSum += rowSum;
    marginal[y] = marginalSum;
  }
  if (marginalSum !== 0) for (let y = 0; y < height; y++) marginal[y] /= marginalSum;

  // Inverse-CDF targets increase monotonically, so each row needs one linear walk.
  const marginalPixels = new Uint16Array(height);
  let row = 0;
  for (let index = 0; index < height; index++) {
    const target = (index + 1) / height;
    while (row < height - 1 && marginal[row] < target) row++;
    marginalPixels[index] = THREE.DataUtils.toHalfFloat((row + 0.5) / height);
  }
  const conditionalPixels = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    let column = 0;
    for (let x = 0; x < width; x++) {
      const target = (x + 1) / width;
      while (column < width - 1 && conditional[y * width + column] < target) column++;
      conditionalPixels[y * width + x] = THREE.DataUtils.toHalfFloat((column + 0.5) / width);
    }
  }

  const weights = (values: Uint16Array, columns: number, rows: number) => {
    const texture = new THREE.DataTexture(
      values,
      columns,
      rows,
      THREE.RedFormat,
      THREE.HalfFloatType,
    );
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  };
  const map = new THREE.DataTexture(
    pixels,
    width,
    height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
    source.mapping,
    THREE.RepeatWrapping,
    THREE.ClampToEdgeWrapping,
    source.magFilter,
    source.minFilter,
    source.anisotropy,
    source.colorSpace,
  );
  map.name = source.name;
  map.needsUpdate = true;
  const marginalWeights = weights(marginalPixels, height, 1);
  const conditionalWeights = weights(conditionalPixels, width, height);
  let disposed = false;
  return {
    map,
    marginalWeights,
    conditionalWeights,
    totalSum,
    dispose() {
      if (disposed) return;
      disposed = true;
      map.dispose();
      marginalWeights.dispose();
      conditionalWeights.dispose();
    },
  };
}
