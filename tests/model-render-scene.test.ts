import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PathTracingSceneGenerator } from 'three-gpu-pathtracer';
import { createModelRenderScene } from '../components/model-render-scene';
import { modelMeshGroup } from '../lib/model-mesh';
import {
  createModelBoardDisplayGroups,
  createModelSolderMaskSurface,
  defaultModelBoardDisplay,
} from '../lib/model-board-display';

const bounds = new THREE.Box3(new THREE.Vector3(100, -80, -3), new THREE.Vector3(140, -50, 12));
const assembly = (scene: THREE.Scene) =>
  scene.getObjectByName('OpenPE Render assembly') as THREE.Group;
const copyOf = (scene: THREE.Scene, source: THREE.Object3D) =>
  assembly(scene).children.find(
    (mesh) => mesh.userData.modelRenderSource === source.uuid,
  ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;

test('path-tracing scene owns independent physical geometry/paint and retains world poses, native opacity and maps', () => {
  const source = new THREE.Group();
  source.position.set(101, -60, 3);
  source.rotation.z = 0.3;
  const texture = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
  const geometry = new THREE.BoxGeometry(12, 8, 2);
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x8395b6,
    map: texture,
    opacity: 0.45,
    transparent: true,
    roughness: 0.37,
    metalness: 0.16,
    clearcoat: 0.2,
    normalScale: new THREE.Vector2(0.7, 0.8),
  });
  const first = new THREE.Mesh(geometry, material);
  const second = new THREE.Mesh(geometry, material);
  first.position.set(4, 2, -1);
  second.position.set(8, 3, 2);
  source.add(first, second);
  source.updateWorldMatrix(true, true);
  const positions = Array.from(geometry.getAttribute('position').array);
  texture.matrixAutoUpdate = false;
  texture.matrix.setUvTransform(0.2, 0.3, 1.2, 0.8, 0.4, 0.5, 0.5);
  const textureState = {
    matrix: texture.matrix.toArray(),
    version: texture.version,
    sourceVersion: texture.source.version,
  };
  const render = createModelRenderScene(source);
  assert.equal(render.sync(bounds, false), true);
  const copy = copyOf(render.scene, first);
  const sibling = copyOf(render.scene, second);
  assert.notEqual(copy.geometry, geometry);
  assert.equal(
    copy.geometry,
    sibling.geometry,
    'Shared native geometry has one owned render copy.',
  );
  assert.notEqual(copy.material, material);
  assert.equal(copy.material, sibling.material);
  assert.equal(copy.material.opacity, 0.45);
  assert.equal(copy.material.transparent, true);
  assert.notEqual(copy.material.map, texture);
  assert.notEqual(copy.material.map!.source, texture.source);
  assert.equal(
    copy.material.map!.image,
    texture.image,
    'Immutable image bytes are retained without recolouring.',
  );
  assert.equal(
    copy.material.map,
    sibling.material.map,
    'One source image owns one render texture copy.',
  );
  assert.deepEqual(copy.matrixWorld.toArray(), first.matrixWorld.toArray());
  assert.deepEqual(copy.material.color.toArray(), material.color.toArray());
  assert.equal(copy.material.roughness, material.roughness);
  assert.equal(copy.material.metalness, material.metalness);
  assert.equal(copy.material.clearcoat, material.clearcoat);
  assert.notEqual(copy.material.normalScale, material.normalScale);
  copy.geometry.getAttribute('position').setX(0, 999);
  copy.material.color.set(0x000000);
  copy.material.map!.matrixAutoUpdate = true;
  copy.material.map!.offset.set(0.7, 0.9);
  copy.material.map!.updateMatrix();
  copy.material.map!.needsUpdate = true;
  assert.equal(texture.matrixAutoUpdate, false);
  assert.deepEqual(texture.matrix.toArray(), textureState.matrix);
  assert.equal(texture.version, textureState.version);
  assert.equal(texture.source.version, textureState.sourceVersion);
  assert.deepEqual(Array.from(geometry.getAttribute('position').array), positions);
  assert.equal(material.color.getHex(), 0x8395b6);
  let originalGeometryDisposals = 0,
    originalMaterialDisposals = 0,
    originalTextureDisposals = 0;
  geometry.addEventListener('dispose', () => originalGeometryDisposals++);
  material.addEventListener('dispose', () => originalMaterialDisposals++);
  texture.addEventListener('dispose', () => originalTextureDisposals++);
  render.dispose();
  render.dispose();
  assert.deepEqual(
    [originalGeometryDisposals, originalMaterialDisposals, originalTextureDisposals],
    [0, 0, 0],
  );
  geometry.dispose();
  material.dispose();
  texture.dispose();
});

test('STEP face colours and subsequent scalar paint survive the actual tracer material-index merge', () => {
  const source = modelMeshGroup([
    {
      color: [0.45, 0.45, 0.45],
      attributes: {
        position: { array: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, -2, 0, 0] },
      },
      index: { array: [0, 1, 2, 0, 2, 3, 0, 3, 4] },
      brep_faces: [
        { first: 0, last: 0, color: [1, 0, 0] },
        { first: 1, last: 1, color: [0, 1, 0] },
        { first: 2, last: 2, color: [0, 0, 1] },
      ],
    },
  ]);
  const native = source.children[0] as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial[]
  >;
  const sibling = new THREE.Mesh(
    native.geometry,
    native.material.map((material) => material.clone()),
  );
  sibling.position.x = 10;
  const tail = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([20, 0, 0, 22, 0, 0, 20, 2, 0], 3),
    ),
    new THREE.MeshStandardMaterial({ color: 0xffaa00 }),
  );
  tail.geometry.computeVertexNormals();
  source.add(sibling, tail);
  const nativeState = () => ({
    indices: Array.from(native.geometry.index!.array),
    positions: Array.from(native.geometry.getAttribute('position').array),
    groups: native.geometry.groups.map((group) => ({ ...group })),
    colours: native.material.map((material) => material.color.toArray()),
  });
  const before = nativeState();
  const render = createModelRenderScene(source);
  render.sync(bounds, false);
  const copies = assembly(render.scene).children as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshPhysicalMaterial
  >[];
  assert.equal(
    copies.length,
    7,
    'Only the three used coloured face materials are traced per instance.',
  );
  for (const copy of copies) assert.equal(Array.isArray(copy.material), false);
  const nativeCopies = copies.filter((copy) => copy.userData.modelRenderSource === native.uuid);
  const siblingCopies = copies.filter((copy) => copy.userData.modelRenderSource === sibling.uuid);
  assert.deepEqual(
    nativeCopies.map((copy) => copy.material.color.toArray()),
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  );
  for (let index = 0; index < nativeCopies.length; index++)
    assert.equal(nativeCopies[index].geometry, siblingCopies[index].geometry);
  // Make the scalar surface follow every multi-material STEP surface in the
  // generator's UUID sort, exposing the library's flattened-material offset bug.
  copies.forEach((copy, index) => (copy.uuid = `render-${index.toString().padStart(3, '0')}`));
  const generator = new PathTracingSceneGenerator(assembly(render.scene));
  generator.generateBVH = false;
  const traced = generator.generate();
  const positions = traced.geometry.getAttribute('position');
  const materialIndices = traced.geometry.getAttribute('materialIndex');
  const pointKey = (points: number[][]) =>
    points
      .map((point) => point.join(','))
      .sort()
      .join(';');
  const expected = new Map<string, number[]>();
  for (const mesh of [native, sibling])
    for (const group of mesh.geometry.groups) {
      const points: number[][] = [];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = mesh.geometry.index!.getX(group.start + corner);
        points.push(
          new THREE.Vector3()
            .fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex)
            .applyMatrix4(mesh.matrixWorld)
            .toArray(),
        );
      }
      expected.set(pointKey(points), mesh.material[group.materialIndex!].color.toArray());
    }
  expected.set(
    pointKey([
      [20, 0, 0],
      [22, 0, 0],
      [20, 2, 0],
    ]),
    tail.material.color.toArray(),
  );
  assert.equal(traced.geometry.index!.count / 3, expected.size);
  for (let offset = 0; offset < traced.geometry.index!.count; offset += 3) {
    const vertices = [0, 1, 2].map((corner) => traced.geometry.index!.getX(offset + corner));
    const materialIndex = materialIndices.getX(vertices[0]);
    assert.ok(vertices.every((vertex) => materialIndices.getX(vertex) === materialIndex));
    const points = vertices.map((vertex) =>
      new THREE.Vector3().fromBufferAttribute(positions, vertex).toArray(),
    );
    const material = traced.materials[materialIndex] as THREE.MeshPhysicalMaterial;
    assert.deepEqual(material.color.toArray(), expected.get(pointKey(points)));
  }
  assert.deepEqual(
    nativeState(),
    before,
    'Tracing never rewrites native indices, groups or colours.',
  );
  traced.geometry.dispose();
  render.dispose();
  native.geometry.dispose();
  tail.geometry.dispose();
  for (const material of [...native.material, ...sibling.material, tail.material])
    material.dispose();
});

test('material partitions retain selected triangles, interleaved UVs, normalized vertex colours and image colour space', () => {
  const geometry = new THREE.BufferGeometry();
  const interleaved = new THREE.InterleavedBuffer(
    new Float32Array([
      0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 2, 2, 0, 1, 1, 0, 2, 0, 0, 1, -2, 2, 0, -1, 1, -2, 0, 0, -1, 0,
    ]),
    5,
  );
  geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
  geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleaved, 2, 3));
  const colours = new THREE.Uint8BufferAttribute(
    [255, 255, 255, 128, 64, 32, 64, 128, 255, 255, 32, 128, 32, 255, 64, 64, 32, 255],
    3,
    true,
  );
  geometry.setAttribute('color', colours);
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
  geometry.computeVertexNormals();
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(6, 3, 1);
  geometry.addGroup(3, 3, 0);
  geometry.setDrawRange(3, 6);
  const texture = new THREE.DataTexture(new Uint8Array([255, 64, 32, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.offset.set(0.25, 0.5);
  const paints = [
    new THREE.MeshStandardMaterial({ color: 0xff0000, vertexColors: true, map: texture }),
    new THREE.MeshStandardMaterial({ color: 0x0000ff, vertexColors: true }),
    new THREE.MeshStandardMaterial({ color: 0x808080 }),
  ];
  const source = new THREE.Group();
  source.add(new THREE.Mesh(geometry, paints));
  const before = {
    data: [...interleaved.array],
    indices: [...geometry.index!.array],
    groups: geometry.groups.map((group) => ({ ...group })),
    sourceVersion: texture.source.version,
  };
  const render = createModelRenderScene(source);
  render.sync(bounds, false);
  const copies = assembly(render.scene).children as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshPhysicalMaterial
  >[];
  assert.equal(copies.length, 2, 'Unused paint and ungrouped triangles never enter tracing.');
  for (const [index, vertices] of [
    [0, [0, 2, 3]],
    [1, [0, 3, 4]],
  ] as const) {
    const copy = copies[index];
    assert.equal(copy.geometry.getAttribute('position').count, 3);
    assert.deepEqual([...copy.geometry.index!.array], [0, 1, 2]);
    assert.equal(copy.material.vertexColors, true);
    assert.equal(copy.geometry.getAttribute('color').normalized, true);
    assert.ok(copy.geometry.getAttribute('color').array instanceof Uint8Array);
    for (let vertex = 0; vertex < vertices.length; vertex++) {
      assert.deepEqual(
        new THREE.Vector3()
          .fromBufferAttribute(copy.geometry.getAttribute('position'), vertex)
          .toArray(),
        new THREE.Vector3()
          .fromBufferAttribute(geometry.getAttribute('position'), vertices[vertex])
          .toArray(),
      );
      const copiedUV = copy.geometry.getAttribute('uv');
      const sourceUV = geometry.getAttribute('uv');
      assert.deepEqual(
        [copiedUV.getX(vertex), copiedUV.getY(vertex)],
        [sourceUV.getX(vertices[vertex]), sourceUV.getY(vertices[vertex])],
      );
      assert.deepEqual(
        [...copy.geometry.getAttribute('color').array.slice(vertex * 3, vertex * 3 + 3)],
        [...colours.array.slice(vertices[vertex] * 3, vertices[vertex] * 3 + 3)],
      );
    }
  }
  assert.notEqual(copies[0].material.map, texture);
  assert.equal(copies[0].material.map!.colorSpace, THREE.SRGBColorSpace);
  assert.equal(copies[0].material.map!.image, texture.image);
  assert.deepEqual(copies[0].material.map!.offset.toArray(), [0.25, 0.5]);
  assert.deepEqual([...interleaved.array], before.data);
  assert.deepEqual([...geometry.index!.array], before.indices);
  assert.deepEqual(geometry.groups, before.groups);
  assert.deepEqual(geometry.drawRange, { start: 3, count: 6 });
  assert.equal(texture.source.version, before.sourceVersion);
  render.dispose();
  geometry.dispose();
  texture.dispose();
  for (const paint of paints) paint.dispose();
});

test('visible physical surfaces alone enter tracing, with lacquer, copper and alpha-tested silkscreen roles', () => {
  const source = new THREE.Group();
  const groups = createModelBoardDisplayGroups(source, defaultModelBoardDisplay());
  const geometry = new THREE.PlaneGeometry(2, 2);
  const paint = new THREE.MeshStandardMaterial({ color: 0xb6ad7b });
  const substrate = new THREE.Mesh(geometry, paint);
  const fillPaint = new THREE.MeshStandardMaterial({
    color: 0xc3a15f,
    opacity: 0.8,
    transparent: true,
    depthWrite: false,
  });
  const copper = new THREE.Mesh(geometry, fillPaint);
  const mask = createModelSolderMaskSurface(geometry);
  mask.children[0].visible = true;
  const texture = new THREE.DataTexture(new Uint8Array([242, 242, 240, 0]), 1, 1);
  const silk = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  groups.substrate.add(substrate);
  groups.copper.add(copper);
  groups.mask.add(mask);
  groups.silkscreen.add(silk);
  const hidden = new THREE.Group();
  hidden.visible = false;
  const hiddenMesh = new THREE.Mesh(geometry, paint);
  hidden.add(hiddenMesh);
  source.add(hidden);
  const preview = new THREE.Group();
  preview.userData.modelMeasurementExcluded = true;
  const previewMesh = new THREE.Mesh(geometry, paint);
  preview.add(previewMesh);
  source.add(preview);
  source.add(new THREE.Line(geometry, new THREE.LineBasicMaterial()));
  const render = createModelRenderScene(source);
  render.sync(bounds, false);
  assert.equal(assembly(render.scene).children.length, 4);
  assert.equal(copyOf(render.scene, hiddenMesh), undefined);
  assert.equal(copyOf(render.scene, previewMesh), undefined);
  assert.equal(
    copyOf(render.scene, mask.children[0]),
    undefined,
    'Viewport-only exploded backing is not double-counted.',
  );
  assert.equal(copyOf(render.scene, substrate).material.roughness, 0.78);
  assert.equal(copyOf(render.scene, copper).material.metalness, 0.95);
  assert.equal(copyOf(render.scene, copper).material.opacity, 1);
  assert.equal(copyOf(render.scene, copper).material.transparent, false);
  assert.equal(
    fillPaint.opacity,
    0.8,
    'Engineering fill alpha remains outside the physical finish.',
  );
  assert.equal(fillPaint.transparent, true);
  const lacquer = copyOf(render.scene, mask).material;
  assert.equal(lacquer.opacity, 1);
  assert.equal(lacquer.transparent, false);
  assert.equal(lacquer.clearcoat, 0.8);
  assert.equal(lacquer.transmission, 0.26);
  assert.equal(lacquer.ior, 1.55);
  assert.equal(lacquer.thickness, 0);
  assert.equal(lacquer.attenuationDistance, Infinity);
  assert.equal(
    (mask.material as THREE.Material).opacity,
    0.9,
    'Native multiply tint stays unchanged.',
  );
  const ink = copyOf(render.scene, silk).material;
  assert.notEqual(ink.map, texture);
  assert.equal(ink.map!.image, texture.image);
  assert.equal(ink.alphaTest, 0.02);
  render.dispose();
  geometry.dispose();
  paint.dispose();
  fillPaint.dispose();
  texture.dispose();
  (silk.material as THREE.Material).dispose();
  (mask.material as THREE.Material).dispose();
  ((mask.children[0] as THREE.Mesh).material as THREE.Material).dispose();
  ((source.children.at(-1) as THREE.Line).material as THREE.Material).dispose();
});

test('thin lacquer retains coated copper, actual pad apertures and opaque FR4 without changing native mask paint', () => {
  const source = new THREE.Group();
  const groups = createModelBoardDisplayGroups(source, defaultModelBoardDisplay());
  const rectangle = (x: number, y: number) =>
    new THREE.Shape()
      .moveTo(-x / 2, -y / 2)
      .lineTo(x / 2, -y / 2)
      .lineTo(x / 2, y / 2)
      .lineTo(-x / 2, y / 2)
      .closePath();
  const substrate = new THREE.Mesh(
    new THREE.BoxGeometry(12, 10, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xb6ad7b }),
  );
  groups.substrate.add(substrate);
  const copperPaint = new THREE.MeshStandardMaterial({ color: 0xc3a15f, side: THREE.DoubleSide });
  const track = new THREE.Mesh(new THREE.ShapeGeometry(rectangle(10, 0.6)), copperPaint);
  const pour = new THREE.Mesh(new THREE.ShapeGeometry(rectangle(11, 9)), copperPaint);
  const pad = new THREE.Mesh(new THREE.ShapeGeometry(rectangle(2, 2)), copperPaint);
  track.position.z = pad.position.z = 0.815;
  pour.position.z = 0.81;
  groups.copper.add(track, pour, pad);
  const coatingShape = rectangle(12, 10);
  coatingShape.holes.push(
    new THREE.Path()
      .moveTo(-1.2, -1.2)
      .lineTo(-1.2, 1.2)
      .lineTo(1.2, 1.2)
      .lineTo(1.2, -1.2)
      .closePath(),
  );
  const mask = createModelSolderMaskSurface(new THREE.ShapeGeometry(coatingShape));
  mask.position.z = 0.82;
  groups.mask.add(mask);
  const originalMaskVertices = Array.from(mask.geometry.getAttribute('position').array);
  const render = createModelRenderScene(source);
  render.sync(
    new THREE.Box3(new THREE.Vector3(-6, -5, -0.8), new THREE.Vector3(6, 5, 0.82)),
    false,
  );
  for (const original of [track, pour, pad]) {
    const copy = copyOf(render.scene, original);
    assert.ok(copy, 'Every original physical copper category remains in the render.');
    assert.equal(copy.material.opacity, 1);
    assert.equal(copy.material.transmission, 0);
  }
  const coating = copyOf(render.scene, mask);
  assert.ok(coating.material.transmission > 0 && coating.material.transmission < 1);
  assert.equal(copyOf(render.scene, substrate).material.transmission, 0);
  assert.equal(copyOf(render.scene, substrate).material.opacity, 1);
  const topAperture = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
  const topCoated = new THREE.Raycaster(new THREE.Vector3(4, 0, 10), new THREE.Vector3(0, 0, -1));
  const underside = new THREE.Raycaster(new THREE.Vector3(4, 0, -10), new THREE.Vector3(0, 0, 1));
  const copies = assembly(render.scene).children;
  assert.notEqual(
    topAperture.intersectObjects(copies, true)[0].object,
    coating,
    'The pad aperture exposes actual copper geometry.',
  );
  assert.equal(
    topCoated.intersectObjects(copies, true)[0].object,
    coating,
    'Surface copper is covered by the thin lacquer.',
  );
  assert.equal(
    underside.intersectObjects(copies, true)[0].object,
    copyOf(render.scene, substrate),
    'Opaque FR4 blocks through-board viewing.',
  );
  assert.deepEqual(Array.from(mask.geometry.getAttribute('position').array), originalMaskVertices);
  const nativeMask = mask.material as THREE.MeshBasicMaterial;
  assert.equal(nativeMask.opacity, 0.9);
  assert.equal(nativeMask.blending, THREE.MultiplyBlending);
  assert.equal('transmission' in nativeMask, false);
  render.dispose();
  substrate.geometry.dispose();
  substrate.material.dispose();
  track.geometry.dispose();
  pour.geometry.dispose();
  pad.geometry.dispose();
  copperPaint.dispose();
  mask.geometry.dispose();
  nativeMask.dispose();
  ((mask.children[0] as THREE.Mesh).material as THREE.Material).dispose();
});

test('unchanged render inputs retain clones; pose, material, texture and visibility changes invalidate once', () => {
  const source = new THREE.Group();
  const texture = new THREE.Texture();
  const paint = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), paint);
  source.add(mesh);
  const render = createModelRenderScene(source);
  assert.equal(render.sync(bounds, false), true);
  const original = copyOf(render.scene, mesh);
  assert.equal(render.sync(bounds.clone(), false), false);
  assert.equal(copyOf(render.scene, mesh), original);
  let disposed = 0;
  original.geometry.addEventListener('dispose', () => disposed++);
  mesh.position.x = 4;
  assert.equal(render.sync(bounds, false), true);
  assert.equal(disposed, 1);
  assert.equal(render.sync(bounds, false), false);
  paint.roughness = 0.2;
  assert.equal(render.sync(bounds, false), true);
  texture.offset.x = 0.3;
  assert.equal(render.sync(bounds, false), true);
  mesh.visible = false;
  assert.equal(render.sync(bounds, false), true);
  assert.equal(assembly(render.scene).children.length, 0);
  mesh.visible = true;
  assert.equal(render.sync(bounds, false), true);
  assert.equal(render.sync(bounds, false), false);
  render.dispose();
  mesh.geometry.dispose();
  paint.dispose();
  texture.dispose();
});

test('explicit CAD PMMA receives an optical render material while generic alpha remains authored transparency', () => {
  const source = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 8, 1);
  const paint = new THREE.MeshStandardMaterial({
    color: 0xa5bdcc,
    roughness: 0.16,
    opacity: 0.45,
    transparent: true,
  });
  const acrylic = new THREE.Group();
  acrylic.userData.modelCadMaterial = 'pmma';
  const pmma = new THREE.Mesh(geometry, paint);
  acrylic.add(pmma);
  const generic = new THREE.Mesh(geometry, paint);
  source.add(acrylic, generic);
  const render = createModelRenderScene(source);
  render.sync(bounds, false);
  const optical = copyOf(render.scene, pmma).material;
  const alpha = copyOf(render.scene, generic).material;
  assert.equal(optical.transmission, 0.92);
  assert.equal(optical.ior, 1.49);
  assert.equal(optical.opacity, 0.45);
  assert.equal(optical.roughness, 0.16);
  assert.equal(alpha.transmission, 0);
  assert.equal(alpha.opacity, 0.45);
  assert.notEqual(optical, alpha, 'Different explicit CAD materials cannot share converted paint.');
  assert.equal(paint.opacity, 0.45);
  assert.equal('transmission' in paint, false);
  acrylic.userData.modelCadMaterial = 'abs';
  assert.equal(render.sync(bounds, false), true);
  assert.equal(copyOf(render.scene, pmma).material.transmission, 0);
  render.dispose();
  geometry.dispose();
  paint.dispose();
});

test('generated HDR softboxes, area lights and matte floor scale without changing source bounds or receiving picks', () => {
  const source = new THREE.Group();
  const render = createModelRenderScene(source);
  const originalBounds = bounds.clone();
  render.sync(bounds, false);
  const floor = render.scene.getObjectByName('OpenPE Render studio floor') as THREE.Mesh;
  const lights = render.scene.children.filter(
    (object) => object instanceof THREE.RectAreaLight,
  ) as THREE.RectAreaLight[];
  assert.equal(lights.length, 3);
  assert.ok(
    lights[0].intensity > lights[1].intensity * 3,
    'The key/fill ratio preserves dimensional contrast.',
  );
  assert.ok(floor.position.z < bounds.min.z);
  assert.equal((floor.material as THREE.Material).side, THREE.FrontSide);
  assert.deepEqual(
    new THREE.Raycaster(
      new THREE.Vector3(120, -60, 100),
      new THREE.Vector3(0, 0, -1),
    ).intersectObject(floor),
    [],
  );
  const environment = render.scene.environment as THREE.DataTexture;
  assert.equal(environment.mapping, THREE.EquirectangularReflectionMapping);
  const values = environment.image.data as Float32Array;
  assert.ok(values.every(Number.isFinite));
  const radiance = Array.from(values).filter((_, index) => index % 4 !== 3);
  assert.ok(Math.max(...radiance.slice(0, 10000)) >= 0, 'Generated values remain finite.');
  assert.ok(
    radiance.some((value) => value > 1),
    'Softboxes retain HDR specular highlights.',
  );
  assert.ok(radiance.some((value) => value < 0.05));
  const initialWidth = lights[0].width;
  const larger = new THREE.Box3(new THREE.Vector3(-50, -40, -25), new THREE.Vector3(150, 110, 50));
  assert.equal(render.sync(larger, true), true);
  assert.ok(lights[0].width > initialWidth * 3);
  assert.ok(floor.position.z < -25);
  assert.deepEqual(bounds, originalBounds);
  let environmentDisposals = 0,
    floorDisposals = 0;
  environment.addEventListener('dispose', () => environmentDisposals++);
  floor.geometry.addEventListener('dispose', () => floorDisposals++);
  render.dispose();
  render.dispose();
  assert.equal(environmentDisposals, 1);
  assert.equal(floorDisposals, 1);
});

test('failed surface conversion leaves the accepted render scene intact and remains retryable', () => {
  const source = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.add(mesh);
  const render = createModelRenderScene(source);
  render.sync(bounds, false);
  const accepted = copyOf(render.scene, mesh);
  const unsupported = new THREE.Mesh(mesh.geometry, new THREE.ShaderMaterial());
  source.add(unsupported);
  assert.throws(() => render.sync(bounds, false), /does not support/);
  assert.equal(copyOf(render.scene, mesh), accepted);
  unsupported.removeFromParent();
  assert.equal(render.sync(bounds, false), false, 'The previous accepted signature remains valid.');
  mesh.position.y = 2;
  assert.equal(render.sync(bounds, false), true);
  render.dispose();
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  unsupported.material.dispose();
});
