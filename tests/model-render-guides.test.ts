import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createModelRenderGuides } from '../components/model-render-guides';

function fixture() {
  const previousTarget = new THREE.WebGLRenderTarget(3, 5);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#385574');
  scene.environment = new THREE.Texture();
  scene.overrideMaterial = new THREE.MeshBasicMaterial();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.z = 30;
  let fail = false;
  let inspect = (_scene: THREE.Scene) => {};
  const state = {
    capabilities: { logarithmicDepthBuffer: false, reversedDepthBuffer: false },
    target: previousTarget as THREE.WebGLRenderTarget | null,
    viewport: new THREE.Vector4(2, 3, 5, 7),
    scissor: new THREE.Vector4(1, 2, 3, 4),
    scissorTest: true,
    clearColor: new THREE.Color('#123456'),
    clearAlpha: 0.3,
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: true,
    toneMapping: THREE.AgXToneMapping,
    shadowMap: { enabled: true },
    xr: { enabled: true },
    renders: 0,
    getRenderTarget() {
      return this.target;
    },
    getActiveCubeFace() {
      return 0;
    },
    getActiveMipmapLevel() {
      return 0;
    },
    getViewport(value: THREE.Vector4) {
      return value.copy(this.viewport);
    },
    getScissor(value: THREE.Vector4) {
      return value.copy(this.scissor);
    },
    getScissorTest() {
      return this.scissorTest;
    },
    getClearColor(value: THREE.Color) {
      return value.copy(this.clearColor);
    },
    getClearAlpha() {
      return this.clearAlpha;
    },
    setRenderTarget(value: THREE.WebGLRenderTarget | null) {
      this.target = value;
    },
    setViewport(x: number | THREE.Vector4, y?: number, width?: number, height?: number) {
      if (x instanceof THREE.Vector4) this.viewport.copy(x);
      else this.viewport.set(x, y!, width!, height!);
    },
    setScissor(value: THREE.Vector4) {
      this.scissor.copy(value);
    },
    setScissorTest(value: boolean) {
      this.scissorTest = value;
    },
    setClearColor(value: THREE.ColorRepresentation, alpha: number) {
      this.clearColor.set(value);
      this.clearAlpha = alpha;
    },
    render(current: THREE.Scene) {
      this.renders++;
      assert.equal(current, scene);
      assert.equal(current.background, null);
      assert.equal(
        current.environment,
        null,
        'Guide preparation cannot trigger an environment bake.',
      );
      assert.equal(current.overrideMaterial, null);
      assert.equal(this.clearAlpha, 1);
      assert.equal(this.clearColor.getHex(), 0);
      assert.equal(this.target!.textures.length, 2, 'One draw writes both independent guides.');
      assert.equal(this.target!.textures[0].type, THREE.FloatType);
      inspect(current);
      if (fail) throw new Error('Guide draw failed.');
    },
  };
  const renderer = state as unknown as THREE.WebGLRenderer;
  const guides = createModelRenderGuides(renderer);
  const snapshot = () => ({
    target: state.target,
    viewport: state.viewport.toArray(),
    scissor: state.scissor.toArray(),
    scissorTest: state.scissorTest,
    clearColor: state.clearColor.toArray(),
    clearAlpha: state.clearAlpha,
    autoClear: state.autoClear,
    autoClearColor: state.autoClearColor,
    autoClearDepth: state.autoClearDepth,
    autoClearStencil: state.autoClearStencil,
    toneMapping: state.toneMapping,
    shadows: state.shadowMap.enabled,
    xr: state.xr.enabled,
    background: scene.background,
    environment: scene.environment,
    override: scene.overrideMaterial,
  });
  return {
    scene,
    camera,
    renderer,
    state,
    guides,
    previousTarget,
    snapshot,
    inspect(value: typeof inspect) {
      inspect = value;
    },
    fail(value: boolean) {
      fail = value;
    },
  };
}

test('surface guides preserve paint, apertures and mapped normals without taking source ownership', () => {
  const f = fixture();
  const map = new THREE.Texture();
  const alphaMap = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const material = new THREE.MeshPhysicalMaterial({
    color: '#885522',
    map,
    alphaMap,
    normalMap,
    alphaTest: 0.12,
    opacity: 0.7,
    transparent: true,
    transmission: 0.26,
    normalScale: new THREE.Vector2(0.4, 0.8),
    side: THREE.DoubleSide,
    vertexColors: true,
    flatShading: true,
  });
  const hidden = new THREE.MeshBasicMaterial();
  hidden.visible = false;
  const original = [material, hidden];
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, original);
  const invisible = new THREE.Mesh(geometry, material);
  invisible.visible = false;
  f.scene.add(mesh, invisible);
  let derived: THREE.MeshStandardMaterial | undefined;
  let sourceDisposals = 0;
  for (const resource of [material, hidden, geometry, map, alphaMap, normalMap])
    resource.addEventListener('dispose', () => sourceDisposals++);
  const before = f.snapshot();
  f.inspect(() => {
    assert.notEqual(mesh.material, original);
    const [guide, hiddenGuide] = mesh.material;
    derived = guide as THREE.MeshStandardMaterial;
    assert.notEqual(guide, material);
    assert.equal(hiddenGuide.visible, false);
    assert.equal(invisible.material, material, 'Hidden geometry keeps its exact material.');
    assert.equal(mesh.geometry, geometry);
    assert.equal(derived.map, map);
    assert.equal(derived.alphaMap, alphaMap);
    assert.equal(derived.normalMap, normalMap);
    assert.equal(derived.alphaTest, 0.12);
    assert.equal(derived.opacity, 0.7);
    assert.equal(derived.side, THREE.DoubleSide);
    assert.equal(derived.vertexColors, true);
    assert.equal(derived.flatShading, true);
    assert.equal(derived.depthWrite, true, 'A translucent surface is an optical first-hit guide.');
    assert.equal(derived.transparent, false);
    assert.notEqual(derived.normalScale, material.normalScale);
    assert.deepEqual(derived.normalScale.toArray(), [0.4, 0.8]);
    assert.deepEqual(derived.color.toArray(), material.color.toArray());
    const shader = { uniforms: {}, fragmentShader: '', vertexShader: '' } as Parameters<
      THREE.Material['onBeforeCompile']
    >[0];
    derived.onBeforeCompile(shader, f.renderer);
    assert.equal(shader.uniforms.openpeGuideTransmission.value, 0.26);
    assert.match(shader.fragmentShader, /#include <alphatest_fragment>/);
    assert.match(shader.fragmentShader, /#include <normal_fragment_maps>/);
    assert.match(shader.fragmentShader, /gl_FragCoord\.z/);
  });
  const textures = f.guides.render(f.scene, f.camera, 80, 60);
  assert.notEqual(textures.normalDepth, textures.albedo);
  assert.equal(mesh.material, original);
  assert.deepEqual(f.snapshot(), before);
  let derivedDisposals = 0;
  derived!.addEventListener('dispose', () => derivedDisposals++);
  f.guides.dispose();
  f.guides.dispose();
  assert.equal(derivedDisposals, 1);
  assert.equal(sourceDisposals, 0, 'Disposal releases guides, never source geometry or images.');
  f.previousTarget.dispose();
});

test('guide pixels are cached while camera changes retain materials and changed paint replaces them', () => {
  const f = fixture();
  const source = new THREE.MeshStandardMaterial({ color: '#ff0000' });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), source);
  f.scene.add(mesh);
  const materials: THREE.Material[] = [];
  let released = 0;
  f.inspect(() => {
    materials.push(mesh.material);
    if (materials.length === 1) mesh.material.addEventListener('dispose', () => released++);
  });
  const first = f.guides.render(f.scene, f.camera, 80, 60);
  assert.equal(f.guides.render(f.scene, f.camera, 80, 60), first);
  assert.equal(f.state.renders, 1);
  f.camera.position.x++;
  f.guides.render(f.scene, f.camera, 80, 60);
  assert.equal(materials[1], materials[0], 'Camera changes do not compile a new material.');
  source.color.set('#0000ff');
  f.guides.invalidate();
  f.guides.render(f.scene, f.camera, 80, 60);
  assert.notEqual(materials[2], materials[1]);
  assert.equal(released, 1);
  assert.deepEqual(
    (materials[2] as THREE.MeshStandardMaterial).color.toArray(),
    source.color.toArray(),
  );
  f.guides.render(f.scene, f.camera, 40, 30);
  assert.equal(materials[3], materials[2], 'Resize retains the same paint program.');
  f.guides.dispose();
  f.previousTarget.dispose();
});

test('failed guide draws restore source and renderer state and remain retryable', () => {
  const f = fixture();
  const source = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), source);
  f.scene.add(mesh);
  const before = f.snapshot();
  f.fail(true);
  assert.throws(() => f.guides.render(f.scene, f.camera, 40, 30), /Guide draw failed/);
  assert.equal(mesh.material, source);
  assert.deepEqual(f.snapshot(), before);
  f.fail(false);
  f.guides.render(f.scene, f.camera, 40, 30);
  assert.equal(f.state.renders, 2, 'A failed frame cannot populate the guide cache.');
  assert.deepEqual(f.snapshot(), before);
  f.guides.dispose();
  assert.throws(() => f.guides.render(f.scene, f.camera, 40, 30), /disposed/);
  f.previousTarget.dispose();
});

test('unsupported materials and sizes reject without leaving partially swapped scene materials', () => {
  const f = fixture();
  const first = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
  const second = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial());
  const original = first.material;
  f.scene.add(first, second);
  const before = f.snapshot();
  assert.throws(() => f.guides.render(f.scene, f.camera, 40, 30), /do not support ShaderMaterial/);
  assert.equal(first.material, original);
  assert.deepEqual(f.snapshot(), before);
  for (const width of [0, -1, 1.5, 1921, Infinity, NaN])
    assert.throws(() => f.guides.render(f.scene, f.camera, width, 30), /dimensions/);
  assert.equal(f.state.renders, 0);
  f.guides.dispose();
  f.previousTarget.dispose();
});
