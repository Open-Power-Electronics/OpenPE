import * as THREE from 'three';
import { createModelCopperRelief } from './model-copper-relief';

export const modelRenderFloorName = 'OpenPE Render studio floor';
export const modelRenderFloorScale = 200;
export const modelRenderFloorFade = /* glsl */ `
  float studioFloorFade( vec2 offset ) {
    return smoothstep( 1.0, 9.0, dot( offset, offset ) );
  }
`;

type SurfaceRole = 'substrate' | 'copper' | 'mask' | 'silkscreen' | 'component';
type CadMaterial = 'pmma' | 'aluminium' | 'abs' | null;
type SourceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;

const textureKeys = [
  'map',
  'alphaMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'bumpMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'transmissionMap',
  'thicknessMap',
] as const;
const materialKeys = [
  'roughness',
  'metalness',
  'opacity',
  'transparent',
  'alphaTest',
  'side',
  'visible',
  'vertexColors',
  'normalMapType',
  'bumpScale',
  'aoMapIntensity',
  'emissiveIntensity',
  'clearcoat',
  'clearcoatRoughness',
  'ior',
  'transmission',
  'thickness',
  'attenuationDistance',
  'specularIntensity',
  'reflectivity',
  'flatShading',
] as const;

function surfaceRole(object: THREE.Object3D): SurfaceRole {
  if (object.userData.modelSolderMask) return 'mask';
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent)
    if (
      parent.userData.modelBoard &&
      ['substrate', 'copper', 'mask', 'silkscreen'].includes(parent.name)
    )
      return parent.name as SurfaceRole;
  return 'component';
}

function cadMaterial(object: THREE.Object3D): CadMaterial {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
    const material = parent.userData.modelCadMaterial;
    if (material === 'pmma' || material === 'aluminium' || material === 'abs') return material;
  }
  return null;
}

function physicalSurface(object: THREE.Object3D): object is SourceMesh {
  if (!(object instanceof THREE.Mesh)) return false;
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent)
    if (parent.userData.modelMeasurementExcluded || parent.userData.modelSolderMaskBacking)
      return false;
  return true;
}

function materialSignature(material: THREE.Material) {
  const record = material as unknown as Record<string, unknown>;
  return [
    material.uuid,
    material.version,
    ...materialKeys.map((key) => record[key]),
    ...[
      'color',
      'emissive',
      'attenuationColor',
      'specularColor',
      'normalScale',
      'clearcoatNormalScale',
    ].map((key) => {
      const value = record[key];
      return value instanceof THREE.Color || value instanceof THREE.Vector2
        ? value.toArray()
        : null;
    }),
    ...textureKeys.map((key) => {
      const texture = record[key];
      return texture instanceof THREE.Texture
        ? [
            texture.uuid,
            texture.version,
            texture.colorSpace,
            texture.channel,
            texture.wrapS,
            texture.wrapT,
            texture.flipY,
            texture.matrix.toArray(),
            texture.offset.toArray(),
            texture.repeat.toArray(),
            texture.center.toArray(),
            texture.rotation,
          ]
        : null;
    }),
  ];
}

/** Tracer preparation mutates texture transforms; only immutable image bytes are shared. */
function cloneRenderTexture(source: THREE.Texture) {
  // Texture.clone/copy marks its Source dirty. Detach that Source before cloning
  // so even the initial copy cannot advance the native preview's source version.
  const detached = Object.create(source) as THREE.Texture;
  detached.source = new THREE.TextureSource(source.image);
  detached.source.dataReady = source.source.dataReady;
  return detached.clone();
}

/** Keep each tracer mesh on one material; its scene merger discards source groups. */
function renderGeometry(source: THREE.BufferGeometry, materialIndex: number | null) {
  const total = source.index?.count ?? source.getAttribute('position').count;
  const start = Math.max(0, source.drawRange.start);
  const end = Math.min(total, start + source.drawRange.count);
  if (materialIndex === null && start === 0 && end === total) return source.clone();
  const groups =
    materialIndex === null
      ? [{ start, count: end - start }]
      : source.groups.filter((group) => (group.materialIndex ?? 0) === materialIndex);
  const vertices: number[] = [];
  const indices: number[] = [];
  const byVertex = new Map<number, number>();
  for (const group of groups) {
    const first = Math.max(start, group.start);
    const last = Math.min(end, group.start + group.count);
    // Match drawElements: only complete triangles in the accepted draw range draw.
    for (let offset = first; offset + 2 < last; offset += 3)
      for (let corner = 0; corner < 3; corner++) {
        const vertex = source.index?.getX(offset + corner) ?? offset + corner;
        let index = byVertex.get(vertex);
        if (index === undefined) {
          index = vertices.length;
          vertices.push(vertex);
          byVertex.set(vertex, index);
        }
        indices.push(index);
      }
  }
  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.name = source.name;
  geometry.setIndex(indices);
  for (const [name, attribute] of Object.entries(source.attributes)) {
    // Copy raw components to retain normalized integer colours and interleaved UVs.
    const array = attribute.array.slice(0, vertices.length * attribute.itemSize);
    const interleaved = attribute instanceof THREE.InterleavedBufferAttribute;
    const stride = interleaved ? attribute.data.stride : attribute.itemSize;
    const offset = interleaved ? attribute.offset : 0;
    for (let index = 0; index < vertices.length; index++)
      for (let component = 0; component < attribute.itemSize; component++)
        array[index * attribute.itemSize + component] =
          attribute.array[vertices[index] * stride + offset + component];
    const copy =
      attribute instanceof THREE.Float16BufferAttribute
        ? new THREE.Float16BufferAttribute(array, attribute.itemSize, attribute.normalized)
        : new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized);
    copy.name = attribute.name;
    if (attribute instanceof THREE.BufferAttribute) {
      copy.setUsage(attribute.usage);
      copy.gpuType = attribute.gpuType;
    }
    geometry.setAttribute(name, copy);
  }
  return geometry;
}

/** All physical paint and texture state belong to this render scene. */
function renderMaterial(
  source: THREE.Material,
  role: SurfaceRole,
  copyTexture: (texture: THREE.Texture) => THREE.Texture,
  cad: CadMaterial,
): THREE.MeshPhysicalMaterial {
  if (!(source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial))
    throw new Error(`Render does not support the ${source.type} surface material.`);
  const standard = source instanceof THREE.MeshStandardMaterial ? source : null;
  const physical = source instanceof THREE.MeshPhysicalMaterial ? source : null;
  const parameters: THREE.MeshPhysicalMaterialParameters = {
    color: source.color,
    map: source.map,
    alphaMap: source.alphaMap,
    opacity: source.opacity,
    transparent: source.transparent,
    alphaTest: source.alphaTest,
    side: source.side,
    vertexColors: source.vertexColors,
    flatShading: standard?.flatShading ?? false,
    roughness: standard?.roughness ?? 0.58,
    metalness: standard?.metalness ?? 0,
    emissive: standard?.emissive,
    emissiveIntensity: standard?.emissiveIntensity,
    emissiveMap: standard?.emissiveMap,
    normalMap: standard?.normalMap,
    normalMapType: standard?.normalMapType,
    normalScale: standard?.normalScale.clone(),
    roughnessMap: standard?.roughnessMap,
    metalnessMap: standard?.metalnessMap,
    aoMap: source.aoMap,
    aoMapIntensity: source.aoMapIntensity,
    bumpMap: standard?.bumpMap,
    bumpScale: standard?.bumpScale,
    clearcoat: physical?.clearcoat ?? 0,
    clearcoatRoughness: physical?.clearcoatRoughness ?? 0,
    clearcoatMap: physical?.clearcoatMap,
    clearcoatRoughnessMap: physical?.clearcoatRoughnessMap,
    clearcoatNormalMap: physical?.clearcoatNormalMap,
    clearcoatNormalScale: physical?.clearcoatNormalScale.clone(),
    transmission: physical?.transmission ?? 0,
    transmissionMap: physical?.transmissionMap,
    thickness: physical?.thickness ?? 0,
    thicknessMap: physical?.thicknessMap,
    ior: physical?.ior ?? 1.5,
    attenuationColor: physical?.attenuationColor,
    attenuationDistance: physical?.attenuationDistance,
    specularColor: physical?.specularColor,
    specularIntensity: physical?.specularIntensity,
  };
  const material = new THREE.MeshPhysicalMaterial(
    Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined)),
  );
  for (const key of textureKeys) {
    const texture = material[key];
    if (texture) material[key] = copyTexture(texture);
  }
  material.name = `OpenPE Render ${role}`;
  material.visible = source.visible;
  if (role === 'substrate') {
    material.roughness = 0.78;
    material.metalness = 0;
  } else if (role === 'copper') {
    material.roughness = 0.22;
    material.metalness = 0.95;
    // Zone alpha belongs to engineering display, not the physical metal finish.
    material.opacity = 1;
    material.transparent = false;
  } else if (role === 'mask') {
    // Replace the lighting-free multiply overlay with a thin pigmented dielectric.
    // Partial transmission shows coated surface copper; opaque FR4 still blocks
    // internal/bottom layers. Native apertures expose the original bare metal.
    material.color.multiplyScalar(0.48);
    material.opacity = 1;
    material.transparent = false;
    material.roughness = 0.3;
    material.metalness = 0;
    material.transmission = 0.26;
    material.ior = 1.55;
    material.thickness = 0;
    material.attenuationDistance = Infinity;
    material.clearcoat = 0.8;
    material.clearcoatRoughness = 0.2;
  } else if (role === 'silkscreen') {
    material.roughness = 0.62;
    material.metalness = 0;
    // Alpha-tested native text remains an aperture, not a translucent rectangle.
    if (material.map || material.alphaMap) material.alphaTest = Math.max(source.alphaTest, 0.02);
  } else if (cad === 'pmma') {
    // Only the explicit accepted CAD material identifies acrylic. Generic STEP
    // transparency remains authored alpha, without inferring an optical medium.
    material.transmission = 0.92;
    material.ior = 1.49;
  }
  return material;
}

function framing(bounds: THREE.Box3) {
  const valid =
    !bounds.isEmpty() && [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite);
  const center = valid ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const size = valid ? bounds.getSize(new THREE.Vector3()) : new THREE.Vector3(50, 0, 0);
  return {
    center,
    span: Math.max(0.1, Math.hypot(size.x, size.y, size.z)),
    minZ: valid ? bounds.min.z : 0,
  };
}

/** Floating-point generated softboxes provide actual broad metal reflections without downloads. */
function studioEnvironment() {
  const width = 512,
    height = 256;
  const pixels = new Float32Array(width * height * 4);
  const panels = [
    {
      direction: new THREE.Vector3(0.65, -0.85, 1.4).normalize(),
      width: 0.44,
      height: 0.3,
      radiance: [1.8, 1.72, 1.6],
    },
    {
      direction: new THREE.Vector3(-1, -0.1, 0.75).normalize(),
      width: 0.32,
      height: 0.5,
      radiance: [0.32, 0.4, 0.52],
    },
    {
      direction: new THREE.Vector3(0.25, 1, 0.9).normalize(),
      width: 0.22,
      height: 0.52,
      radiance: [1.1, 1.25, 1.5],
    },
  ].map((panel) => ({
    ...panel,
    right: new THREE.Vector3()
      .crossVectors(panel.direction, new THREE.Vector3(0, 0, 1))
      .normalize(),
    up: new THREE.Vector3(),
  }));
  for (const panel of panels) panel.up.crossVectors(panel.right, panel.direction).normalize();
  const direction = new THREE.Vector3();
  for (let y = 0; y < height; y++) {
    const phi = (1 - (y + 0.5) / height) * Math.PI;
    for (let x = 0; x < width; x++) {
      const theta = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      direction.set(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
      const base = 0.035 + 0.055 * Math.max(0, direction.z);
      const color = [base * 0.95, base, base * 1.05];
      for (const panel of panels) {
        const forward = direction.dot(panel.direction);
        if (forward <= 0) continue;
        const horizontal = Math.abs(direction.dot(panel.right) / forward) / panel.width;
        const vertical = Math.abs(direction.dot(panel.up) / forward) / panel.height;
        const edge = Math.max(horizontal, vertical);
        const strength = 1 - THREE.MathUtils.smoothstep(edge, 0.85, 1.08);
        for (let channel = 0; channel < 3; channel++)
          color[channel] += panel.radiance[channel] * strength;
      }
      const offset = (y * width + x) * 4;
      pixels.set([...color, 1], offset);
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.name = 'OpenPE generated studio softboxes';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A disposable physical scene, entirely independent of native geometry and editor paint. */
export function createModelRenderScene(content: THREE.Group) {
  const scene = new THREE.Scene();
  const assembly = new THREE.Group();
  assembly.name = 'OpenPE Render assembly';
  const environment = studioEnvironment();
  scene.environment = environment;
  scene.environmentIntensity = 1;
  const floorMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xc9ced3,
    roughness: 0.62,
    metalness: 0,
    side: THREE.FrontSide,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMaterial);
  floor.name = modelRenderFloorName;
  const floorBackground = { value: new THREE.Color() };
  floorMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.studioFloorBackground = floorBackground;
    shader.vertexShader = 'varying vec2 studioFloorUV;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       studioFloorUV = uv;
       // The editing camera clips tightly around the assembly. Keep only the
       // private floor at the far plane once it extends beyond that range.
       gl_Position.z = min( gl_Position.z, gl_Position.w );`,
    );
    shader.fragmentShader = `
      uniform vec3 studioFloorBackground;
      varying vec2 studioFloorUV;
      ${modelRenderFloorFade}
    ` + shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      `gl_FragColor.rgb = mix( gl_FragColor.rgb, studioFloorBackground,
         studioFloorFade( ( studioFloorUV - 0.5 ) * ${modelRenderFloorScale}.0 ) );
       #include <colorspace_fragment>`,
    );
  };
  floor.userData.modelMeasurementExcluded = true;
  floor.raycast = () => {};
  const lights = [
    new THREE.RectAreaLight(0xfff4e7, 8, 1, 1),
    new THREE.RectAreaLight(0xdce9ff, 2.2, 1, 1),
    new THREE.RectAreaLight(0xe6efff, 5.5, 1, 1),
  ];
  for (const light of lights) light.up.set(0, 0, 1);
  scene.add(assembly, floor, ...lights);
  let signature = '';
  let disposed = false;
  let geometries: THREE.BufferGeometry[] = [];
  let materials: THREE.Material[] = [];
  let textures: THREE.Texture[] = [];
  const releaseAssembly = () => {
    assembly.clear();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    geometries = [];
    materials = [];
    textures = [];
  };
  return {
    scene,
    sync(bounds: THREE.Box3, dark: boolean) {
      if (disposed) throw new Error('The render scene has been disposed.');
      content.updateWorldMatrix(true, true);
      const sources: SourceMesh[] = [];
      content.traverseVisible((object) => {
        if (physicalSurface(object)) sources.push(object);
      });
      const nextSignature = JSON.stringify([
        dark,
        bounds.min.toArray(),
        bounds.max.toArray(),
        sources.map((mesh) => [
          mesh.uuid,
          mesh.geometry.uuid,
          surfaceRole(mesh),
          cadMaterial(mesh),
          mesh.matrixWorld.toArray(),
          Object.entries(mesh.geometry.attributes).map(([key, attribute]) => [
            key,
            attribute.count,
            attribute instanceof THREE.InterleavedBufferAttribute
              ? attribute.data.version
              : attribute.version,
          ]),
          mesh.geometry.index?.version,
          mesh.geometry.drawRange,
          mesh.geometry.groups.map((group) => [group.start, group.count, group.materialIndex]),
          (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(materialSignature),
        ]),
      ]);
      if (signature === nextSignature) return false;
      // Prepare everything first. A failed conversion preserves the last accepted render scene.
      const nextAssembly = new THREE.Group();
      const nextGeometries = new Map<string, THREE.BufferGeometry>();
      const nextMaterials = new Map<string, THREE.MeshPhysicalMaterial>();
      const nextTextures = new Map<THREE.Texture, THREE.Texture>();
      const reliefTextures: THREE.Texture[] = [];
      const copperSurfaces = sources.filter((source) => surfaceRole(source) === 'copper');
      const copyTexture = (source: THREE.Texture) => {
        let texture = nextTextures.get(source);
        if (!texture) {
          texture = cloneRenderTexture(source);
          nextTextures.set(source, texture);
        }
        return texture;
      };
      try {
        for (const source of sources) {
          const role = surfaceRole(source);
          const cad = cadMaterial(source);
          const paint = (original: THREE.Material) => {
            const key = `${original.uuid}:${role}:${cad}${role === 'mask' ? `:${source.uuid}` : ''}`;
            let material = nextMaterials.get(key);
            if (!material) {
              material = renderMaterial(original, role, copyTexture, cad);
              if (role === 'mask' && !material.normalMap) {
                const relief = createModelCopperRelief(source, copperSurfaces);
                if (relief) {
                  material.normalMap = relief;
                  material.clearcoatNormalMap = relief;
                  reliefTextures.push(relief);
                }
              }
              nextMaterials.set(key, material);
            }
            return material;
          };
          const slots = Array.isArray(source.material)
            ? [...new Set(source.geometry.groups.map((group) => group.materialIndex ?? 0))]
            : [null];
          for (const slot of slots) {
            const original = Array.isArray(source.material)
              ? source.material[slot!]
              : source.material;
            if (!original?.visible) continue;
            const key = `${source.geometry.uuid}:${slot ?? 'all'}`;
            let geometry = nextGeometries.get(key);
            if (!geometry) {
              const prepared = renderGeometry(source.geometry, slot);
              if (!prepared) continue;
              geometry = prepared;
              nextGeometries.set(key, geometry);
            }
            const mesh = new THREE.Mesh(geometry, paint(original));
            mesh.name = source.name;
            mesh.userData.modelRenderSource = source.uuid;
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(source.matrixWorld);
            nextAssembly.add(mesh);
          }
        }
      } catch (error) {
        for (const geometry of nextGeometries.values()) geometry.dispose();
        for (const material of nextMaterials.values()) material.dispose();
        for (const texture of nextTextures.values()) texture.dispose();
        for (const texture of reliefTextures) texture.dispose();
        throw error;
      }
      releaseAssembly();
      if (nextAssembly.children.length) assembly.add(...nextAssembly.children);
      geometries = [...nextGeometries.values()];
      materials = [...nextMaterials.values()];
      textures = [...nextTextures.values(), ...reliefTextures];
      const { center, span, minZ } = framing(bounds);
      floor.position.set(center.x, center.y, minZ - Math.max(0.01, span * 0.001));
      floor.scale.set(span * modelRenderFloorScale, span * modelRenderFloorScale, 1);
      floorMaterial.color.setHex(dark ? 0x3b4149 : 0xc9ced3);
      scene.background = new THREE.Color(dark ? 0x242931 : 0xd8dde2);
      floorBackground.value.copy(scene.background);
      const positions = [
        [0.65, -0.85, 1.4],
        [-1.15, -0.15, 0.8],
        [0.3, 1.15, 0.95],
      ];
      const sizes = [
        [1.45, 1.1],
        [1.2, 1.5],
        [0.65, 1.3],
      ];
      lights.forEach((light, index) => {
        light.position
          .copy(center)
          .add(new THREE.Vector3().fromArray(positions[index]).multiplyScalar(span));
        light.width = sizes[index][0] * span;
        light.height = sizes[index][1] * span;
        light.lookAt(center);
      });
      scene.updateMatrixWorld(true);
      signature = nextSignature;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseAssembly();
      floor.geometry.dispose();
      floorMaterial.dispose();
      environment.dispose();
      scene.clear();
      scene.environment = null;
    },
  };
}
