import * as THREE from 'three';

const MAX_GUIDE_DIMENSION = 1920;

const fragmentShader = /* glsl */ `
  uniform vec3 diffuse;
  uniform float opacity;
  uniform float openpeGuideTransmission;
  varying vec3 vViewPosition;
  layout(location = 1) out highp vec4 openpeGuideAlbedo;

  #include <common>
  #include <color_pars_fragment>
  #include <uv_pars_fragment>
  #include <map_pars_fragment>
  #include <alphamap_pars_fragment>
  #include <alphatest_pars_fragment>
  #include <normal_pars_fragment>
  #include <bumpmap_pars_fragment>
  #include <normalmap_pars_fragment>
  #include <clipping_planes_pars_fragment>

  void main() {
    vec4 diffuseColor = vec4( diffuse, opacity );
    #include <clipping_planes_fragment>
    #include <map_fragment>
    #include <color_fragment>
    #include <alphamap_fragment>
    #include <alphatest_fragment>
    if ( diffuseColor.a <= 0.0 ) discard;
    #include <normal_fragment_begin>
    #include <normal_fragment_maps>

    gl_FragColor = vec4( normalize( normal ), gl_FragCoord.z );
    openpeGuideAlbedo = vec4(
      diffuseColor.rgb,
      max( openpeGuideTransmission, 1.0 - clamp( diffuseColor.a, 0.0, 1.0 ) )
    );
  }
`;

type SourceMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
type GuideEntry = { material: THREE.MeshStandardMaterial; signature: unknown[] };

function sourceSignature(source: SourceMaterial): unknown[] {
  const standard = source instanceof THREE.MeshStandardMaterial ? source : null;
  return [
    source.version,
    ...source.color.toArray(),
    source.map,
    source.alphaMap,
    source.alphaTest,
    source.opacity,
    source.transparent,
    source.visible,
    source.side,
    source.vertexColors,
    standard?.flatShading,
    standard?.normalMap,
    standard?.normalMapType,
    standard?.normalScale.x,
    standard?.normalScale.y,
    standard?.bumpMap,
    standard?.bumpScale,
    source instanceof THREE.MeshPhysicalMaterial ? source.transmission : 0,
  ];
}

function createGuideMaterial(source: SourceMaterial): THREE.MeshStandardMaterial {
  const standard = source instanceof THREE.MeshStandardMaterial ? source : null;
  const material = new THREE.MeshStandardMaterial({
    color: source.color,
    map: source.map,
    alphaMap: source.alphaMap,
    alphaTest: source.alphaTest,
    opacity: source.opacity,
    side: source.side,
    vertexColors: source.vertexColors,
    flatShading: standard?.flatShading ?? false,
    normalMap: standard?.normalMap ?? null,
    normalMapType: standard?.normalMapType ?? THREE.TangentSpaceNormalMap,
    normalScale: standard?.normalScale ?? new THREE.Vector2(1, 1),
    bumpMap: standard?.bumpMap ?? null,
    bumpScale: standard?.bumpScale ?? 1,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
  });
  material.name = 'OpenPE Render surface guide';
  material.visible = source.visible;
  const transmission =
    source instanceof THREE.MeshPhysicalMaterial
      ? THREE.MathUtils.clamp(source.transmission, 0, 1)
      : 0;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.openpeGuideTransmission = { value: transmission };
    shader.fragmentShader = fragmentShader;
  };
  material.customProgramCacheKey = () => 'openpe-model-render-guide';
  return material;
}

/** Read-only first-surface guides over the already-private physical scene. */
export function createModelRenderGuides(renderer: THREE.WebGLRenderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    count: 2,
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.textures[1].type = THREE.HalfFloatType;
  target.textures[0].name = 'OpenPE Render normal and depth guide';
  target.textures[1].name = 'OpenPE Render albedo and optical guide';
  const result = { normalDepth: target.textures[0], albedo: target.textures[1] };
  const materials = new Map<SourceMaterial, GuideEntry>();
  let retainedScene: THREE.Scene | undefined;
  let retainedCamera = '';
  let dirty = true;
  let disposed = false;
  const releaseMaterials = () => {
    for (const entry of materials.values()) entry.material.dispose();
    materials.clear();
  };
  return {
    invalidate() {
      dirty = true;
    },
    render(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
      if (disposed) throw new Error('The Model render guides have been disposed.');
      if (
        ![width, height].every(
          (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_GUIDE_DIMENSION,
        )
      )
        throw new Error('Model render guides require dimensions between 1 and 1,920 pixels.');
      if (renderer.capabilities.logarithmicDepthBuffer || renderer.capabilities.reversedDepthBuffer)
        throw new Error('Model render guides require ordinary camera depth.');
      camera.updateMatrixWorld();
      const cameraBasis = JSON.stringify([
        ...camera.matrixWorld.elements,
        ...camera.projectionMatrix.elements,
      ]);
      if (
        !dirty &&
        scene === retainedScene &&
        cameraBasis === retainedCamera &&
        target.width === width &&
        target.height === height
      )
        return result;
      dirty = true;
      if (scene !== retainedScene) releaseMaterials();
      const replacements: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
      const live = new Set<SourceMaterial>();
      const guideFor = (source: THREE.Material) => {
        if (!(
          source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial
        ))
          throw new Error(`Model render guides do not support ${source.type}.`);
        live.add(source);
        const signature = sourceSignature(source);
        let entry = materials.get(source);
        if (!entry || entry.signature.some((value, index) => value !== signature[index])) {
          entry?.material.dispose();
          entry = { material: createGuideMaterial(source), signature };
          materials.set(source, entry);
        }
        return entry.material;
      };
      const previous = {
        target: renderer.getRenderTarget(),
        cubeFace: renderer.getActiveCubeFace(),
        mipLevel: renderer.getActiveMipmapLevel(),
        viewport: renderer.getViewport(new THREE.Vector4()),
        scissor: renderer.getScissor(new THREE.Vector4()),
        scissorTest: renderer.getScissorTest(),
        clearColor: renderer.getClearColor(new THREE.Color()),
        clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear,
        autoClearColor: renderer.autoClearColor,
        autoClearDepth: renderer.autoClearDepth,
        autoClearStencil: renderer.autoClearStencil,
        toneMapping: renderer.toneMapping,
        shadows: renderer.shadowMap.enabled,
        xr: renderer.xr.enabled,
        background: scene.background,
        environment: scene.environment,
        overrideMaterial: scene.overrideMaterial,
      };
      try {
        scene.traverseVisible((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const original = object.material;
          const replacement = Array.isArray(original) ? original.map(guideFor) : guideFor(original);
          replacements.push([object, original]);
          object.material = replacement;
        });
        for (const [source, entry] of materials) {
          if (live.has(source)) continue;
          entry.material.dispose();
          materials.delete(source);
        }
        scene.background = null;
        scene.environment = null;
        scene.overrideMaterial = null;
        renderer.autoClear = true;
        renderer.autoClearColor = true;
        renderer.autoClearDepth = true;
        renderer.autoClearStencil = false;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.shadowMap.enabled = false;
        renderer.xr.enabled = false;
        target.setSize(width, height);
        renderer.setRenderTarget(target);
        renderer.setScissorTest(false);
        // Zero normal with depth one identifies uncovered/background pixels.
        renderer.setClearColor(0x000000, 1);
        renderer.render(scene, camera);
        retainedScene = scene;
        retainedCamera = cameraBasis;
        dirty = false;
        return result;
      } finally {
        for (const [mesh, material] of replacements) mesh.material = material;
        scene.background = previous.background;
        scene.environment = previous.environment;
        scene.overrideMaterial = previous.overrideMaterial;
        renderer.autoClear = previous.autoClear;
        renderer.autoClearColor = previous.autoClearColor;
        renderer.autoClearDepth = previous.autoClearDepth;
        renderer.autoClearStencil = previous.autoClearStencil;
        renderer.toneMapping = previous.toneMapping;
        renderer.shadowMap.enabled = previous.shadows;
        renderer.xr.enabled = previous.xr;
        renderer.setClearColor(previous.clearColor, previous.clearAlpha);
        renderer.setRenderTarget(previous.target, previous.cubeFace, previous.mipLevel);
        renderer.setViewport(previous.viewport);
        renderer.setScissor(previous.scissor);
        renderer.setScissorTest(previous.scissorTest);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseMaterials();
      target.dispose();
    },
  };
}
