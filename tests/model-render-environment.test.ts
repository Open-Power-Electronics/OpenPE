import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import * as pathTracing from 'three-gpu-pathtracer';
import { createModelRenderEnvironment } from '../components/model-render-environment';
import { createModelRenderScene } from '../components/model-render-scene';

type VendorEnvironment = {
  map: THREE.DataTexture;
  marginalWeights: THREE.DataTexture;
  conditionalWeights: THREE.DataTexture;
  totalSum: number;
  updateFrom(source: THREE.DataTexture): void;
  dispose(): void;
};
const { PhysicalPathTracingMaterial } = pathTracing as unknown as {
  PhysicalPathTracingMaterial: new () => THREE.ShaderMaterial;
};
function texture(width: number, height: number, data: number[] | Float32Array) {
  const source = new THREE.DataTexture(
    Float32Array.from(data),
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.colorSpace = THREE.LinearSRGBColorSpace;
  source.wrapS = THREE.RepeatWrapping;
  source.wrapT = THREE.ClampToEdgeWrapping;
  source.minFilter = source.magFilter = THREE.LinearFilter;
  source.needsUpdate = true;
  return source;
}
function state(source: THREE.DataTexture) {
  assert.ok(source.image.data);
  return {
    data: Array.from(source.image.data),
    image: source.image,
    source: source.source,
    sourceVersion: source.source.version,
    version: source.version,
    matrix: source.matrix.toArray(),
    flipY: source.flipY,
    type: source.type,
    colorSpace: source.colorSpace,
  };
}

test('owned studio environment matches the pinned half-float map and inverse CDF without changing its source', () => {
  const generated = createModelRenderScene(new THREE.Group());
  const fixtures = [
    texture(3, 2, [0, 0, 0, 1, 0.1, 0.3, 0.8, 1, 9, 4, 2, 1, 1, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 1]),
    texture(2, 3, new Array(24).fill(0)),
    texture(2, 2, [65504, 0.00001, 0, 1, 0, 200, 0, 1, 0.001, 0, 60000, 0.5, 0, 0, 0, 1]),
    generated.scene.environment as THREE.DataTexture,
  ];
  for (const source of fixtures) {
    const before = state(source);
    const owned = createModelRenderEnvironment(source);
    assert.deepEqual(state(source), before);
    const vendorSource = texture(
      source.image.width,
      source.image.height,
      source.image.data as Float32Array,
    );
    const vendorMaterial = new PhysicalPathTracingMaterial();
    const vendor = vendorMaterial.uniforms.envMapInfo.value as VendorEnvironment;
    // Only this comparison calls the old API; the production adapter uses modern DataTexture sources.
    vendor.updateFrom(vendorSource);
    for (const key of ['map', 'marginalWeights', 'conditionalWeights'] as const) {
      const actual = owned[key],
        expected = vendor[key];
      assert.equal(actual.image.width, expected.image.width);
      assert.equal(actual.image.height, expected.image.height);
      assert.deepEqual(
        actual.image.data,
        expected.image.data,
        `${key} bytes match the pinned renderer.`,
      );
      assert.equal(actual.type, expected.type);
      assert.equal(actual.format, expected.format);
      assert.equal(actual.minFilter, expected.minFilter);
      assert.equal(actual.magFilter, expected.magFilter);
      assert.equal(actual.wrapS, expected.wrapS);
      assert.equal(actual.wrapT, expected.wrapT);
      assert.equal(actual.flipY, false);
      assert.equal(actual.source instanceof THREE.TextureSource, true);
      assert.notEqual(actual.source, source.source);
      assert.notEqual(actual.image.data, source.image.data);
    }
    assert.equal(owned.map.mapping, vendor.map.mapping);
    assert.equal(owned.map.colorSpace, vendor.map.colorSpace);
    assert.equal(owned.totalSum, vendor.totalSum);
    assert.deepEqual(state(source), before, 'Vendor comparison uses a separate input texture.');
    let sourceDisposals = 0;
    source.addEventListener('dispose', () => sourceDisposals++);
    const disposed = [0, 0, 0];
    [owned.map, owned.marginalWeights, owned.conditionalWeights].forEach((entry, index) =>
      entry.addEventListener('dispose', () => disposed[index]++),
    );
    owned.dispose();
    owned.dispose();
    assert.deepEqual(disposed, [1, 1, 1]);
    assert.equal(sourceDisposals, 0);
    vendor.dispose();
    vendorMaterial.dispose();
    vendorSource.dispose();
    if (source !== generated.scene.environment) source.dispose();
  }
  generated.dispose();
});

test('environment copies have independent pixels and texture state', () => {
  const source = texture(2, 1, [0.2, 0.3, 0.4, 1, 1, 0, 0, 1]);
  const before = state(source);
  const first = createModelRenderEnvironment(source);
  const second = createModelRenderEnvironment(source);
  (first.map.image.data as Uint16Array)[0] = 0;
  (first.conditionalWeights.image.data as Uint16Array)[0] = 0;
  first.map.offset.x = 0.8;
  first.map.needsUpdate = true;
  assert.ok(first.map.image.data && second.map.image.data);
  assert.ok(first.conditionalWeights.image.data && second.conditionalWeights.image.data);
  assert.notEqual(first.map.image.data[0], second.map.image.data[0]);
  assert.notEqual(first.conditionalWeights.image.data[0], second.conditionalWeights.image.data[0]);
  assert.deepEqual(state(source), before);
  assert.equal(second.map.offset.x, 0);
  first.dispose();
  second.dispose();
  source.dispose();
});

test('unsupported or unbounded environment inputs fail before changing source data', () => {
  const cases: ((source: THREE.DataTexture) => void)[] = [
    (source) => (source.type = THREE.HalfFloatType),
    (source) => (source.format = THREE.RedFormat),
    (source) => (source.colorSpace = THREE.SRGBColorSpace),
    (source) => (source.mapping = THREE.UVMapping),
    (source) => (source.flipY = true),
    (source) => (source.image.width = 513),
    (source) => (source.image.height = 257),
    (source) => (source.image.width = 0),
    (source) => (source.image.width = 1.5),
    (source) => (source.image.data = new Uint8Array(4)),
    (source) => (source.image.data = new Float32Array(3)),
    (source) => ((source.image.data as Float32Array)[0] = NaN),
    (source) => ((source.image.data as Float32Array)[1] = Infinity),
    (source) => ((source.image.data as Float32Array)[2] = -0.1),
    (source) => ((source.image.data as Float32Array)[0] = 65505),
    (source) => ((source.image.data as Float32Array)[3] = 1.01),
  ];
  for (const change of cases) {
    const source = texture(1, 1, [0.2, 0.3, 0.4, 1]);
    change(source);
    const before = state(source);
    assert.throws(() => createModelRenderEnvironment(source), /Model environment/);
    assert.deepEqual(state(source), before);
    source.dispose();
  }
});
