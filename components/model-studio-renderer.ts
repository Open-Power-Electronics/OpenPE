import * as THREE from 'three';
import * as pathTracing from 'three-gpu-pathtracer';
import { PathTracingSceneGenerator } from 'three-gpu-pathtracer';
import { getBVHExtremes, type MeshBVH } from 'three-mesh-bvh';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {
  createModelRenderScene,
  modelRenderFloorFade,
  modelRenderFloorName,
  modelRenderFloorScale,
} from './model-render-scene';
import { createModelRenderEnvironment } from './model-render-environment';
import { createModelRenderDenoiser } from './model-render-denoise';
import { prepareModelShaders } from '@/lib/model-shader-warmup';

export const MODEL_RENDER_SAMPLES = 64;
export const MODEL_RENDER_MAX_DIMENSION = 1920;
export const MODEL_RENDER_COMPILE_TIMEOUT_MS = 120000;
const modelRenderSupersampling = 1.5;
const MODEL_RENDER_FRAME_BUDGET_MS = 8;
const MODEL_RENDER_TILES_PER_FRAME = 3;
const MODEL_RENDER_MAX_TILES_PER_FRAME = 27;
const MODEL_RENDER_FENCE_GRACE_MS = 50;
const modelRenderTextureMaps = [
  'map',
  'metalnessMap',
  'roughnessMap',
  'transmissionMap',
  'emissiveMap',
  'normalMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'alphaMap',
] as const;

/** Compile only map kinds present anywhere in the current generated scene. */
export function modelRenderTextureMask(materials: readonly THREE.Material[]): number {
  let mask = 0;
  for (const material of materials) {
    const surface = material as THREE.MeshPhysicalMaterial;
    for (const [index, map] of modelRenderTextureMaps.entries())
      if (surface[map]?.isTexture) mask |= 1 << index;
  }
  return mask;
}

/** Bound tracing work independently of the full-resolution viewport and PNG canvas. */
export function modelRenderWorkingSize(
  drawing: Readonly<{ x: number; y: number }>,
  css: Readonly<{ x: number; y: number }>,
) {
  if (drawing.x <= 0 || drawing.y <= 0 || css.x <= 0 || css.y <= 0) return { width: 1, height: 1 };
  const scale = Math.min(
    modelRenderSupersampling,
    (modelRenderSupersampling * css.x) / drawing.x,
    (modelRenderSupersampling * css.y) / drawing.y,
    MODEL_RENDER_MAX_DIMENSION / Math.max(drawing.x, drawing.y),
  );
  return {
    width: Math.max(1, Math.floor(drawing.x * scale)),
    height: Math.max(1, Math.floor(drawing.y * scale)),
  };
}

// The owned studio scene has rectangular area lights and an environment. Share
// their visibility/BSDF evaluation so drivers compile one large traversal path.
const modelDirectLightContribution = /* glsl */ `
  vec3 directLightContribution( vec3 worldWo, SurfaceRecord surf, RenderState state, vec3 rayOrigin ) {
    vec3 result = vec3( 0.0 );
    LightRecord lightRec;
    bool hasSample = false;
    if ( lightsDenom != 0.0 && rand( 5 ) < float( lights.count ) / lightsDenom ) {
      lightRec = randomLightSample( lights.tex, iesProfiles, lights.count, rayOrigin, rand3( 6 ) );
      hasSample = true;
    } else if ( envMapInfo.totalSum != 0.0 && environmentIntensity != 0.0 ) {
      vec3 envColor, envDirection;
      lightRec.pdf = sampleEquirectProbability( rand2( 7 ), envColor, envDirection );
      lightRec.direction = invEnvRotation3x3 * envDirection;
      lightRec.emission = environmentIntensity * envColor;
      lightRec.dist = INFINITY;
      hasSample = true;
    }
    if ( hasSample ) {
      bool isSampleBelowSurface = ! surf.volumeParticle && dot( surf.faceNormal, lightRec.direction ) < 0.0;
      if ( isSampleBelowSurface ) lightRec.pdf = 0.0;
      Ray lightRay;
      lightRay.origin = rayOrigin;
      lightRay.direction = lightRec.direction;
      vec3 attenuatedColor;
      if (
        lightRec.pdf > 0.0 &&
        isDirectionValid( lightRec.direction, surf.normal, surf.faceNormal ) &&
        ! attenuateHit( state, lightRay, lightRec.dist, attenuatedColor )
      ) {
        vec3 sampleColor;
        float lightMaterialPdf = bsdfResult( worldWo, lightRec.direction, surf, sampleColor );
        bool isValidSampleColor = all( greaterThanEqual( sampleColor, vec3( 0.0 ) ) );
        if ( lightMaterialPdf > 0.0 && isValidSampleColor ) {
          float lightPdf = lightRec.pdf / lightsDenom;
          float misWeight = misHeuristic( lightPdf, lightMaterialPdf );
          result = attenuatedColor * lightRec.emission * state.throughputColor * sampleColor * misWeight / lightPdf;
        }
      }
    }
    // Retain a single return for the pinned driver's macOS shader workaround.
    return result;
  }

`;
export type ModelStudioRenderOptions = {
  dark: boolean;
  bounds: THREE.Box3;
  moving?: boolean;
  selected?: THREE.Object3D[];
  /** An accumulation-only tick; explicit view updates and captures omit this. */
  continuation?: boolean;
};
export type ModelRenderProgress = { samples: number; complete: boolean };

/** Show early progress, then amortize filtering across four complete samples. */
function modelRenderPresentationSample(samples: number): number {
  const complete = Math.floor(samples);
  return complete < 4 ? complete : Math.floor(complete / 4) * 4;
}

/** Backend seam checks lifecycle without substituting mocked pixels for GPU evidence. */
export type ModelPathTracingBackend = {
  readonly samples: number;
  readonly compiling: boolean;
  setScene(scene: THREE.Scene, camera: THREE.Camera): void;
  updateCamera(camera: THREE.Camera): void;
  resize(width: number, height: number): void;
  reset(): void;
  beginFrame?(): number;
  endFrame?(tiles: number): void;
  finishFrame?(successful?: boolean): void;
  renderSample(): void;
  present(camera: THREE.Camera, selected: THREE.Object3D[]): void;
  dispose(): void;
};
export type ModelStudioRendererDependencies = {
  createScene(content: THREE.Group): ReturnType<typeof createModelRenderScene>;
  createBackend(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    helpers: THREE.Object3D[],
  ): ModelPathTracingBackend;
};

/** Submit a bounded tile batch, then yield so input and presentation can run. */
export function advanceModelRenderFrame(
  backend: Pick<
    ModelPathTracingBackend,
    'samples' | 'compiling' | 'renderSample' | 'beginFrame' | 'endFrame'
  >,
  now: () => number = () => performance.now(),
): void {
  const started = now();
  const limit = Math.min(
    MODEL_RENDER_MAX_TILES_PER_FRAME,
    Math.max(0, backend.beginFrame?.() ?? MODEL_RENDER_TILES_PER_FRAME),
  );
  let submitted = 0;
  try {
    for (let tile = 0; tile < limit; tile++) {
      if (backend.samples >= MODEL_RENDER_SAMPLES) return;
      const before = backend.samples;
      // The first call also starts a pending shader compilation. Never spin while
      // compilation or another deferred backend operation makes no progress.
      backend.renderSample();
      if (backend.samples > before) submitted++;
      if (backend.compiling || backend.samples <= before) return;
      if (now() - started >= MODEL_RENDER_FRAME_BUDGET_MS) return;
    }
  } finally {
    backend.endFrame?.(submitted);
  }
}

type FrameBudgetContext = Pick<
  WebGL2RenderingContext,
  'fenceSync' | 'clientWaitSync' | 'deleteSync' | 'flush'
> & {
  readonly SYNC_GPU_COMMANDS_COMPLETE: number;
  readonly ALREADY_SIGNALED: number;
  readonly CONDITION_SATISFIED: number;
  readonly TIMEOUT_EXPIRED: number;
};

/** A single nonblocking fence bounds queued tracing while fast GPUs grow their batch. */
export function createModelRenderFrameBudget(
  gl: FrameBudgetContext,
  now: () => number = () => performance.now(),
) {
  let fence: WebGLSync | null = null;
  let budget = MODEL_RENDER_TILES_PER_FRAME;
  let submitted = 0;
  let queued = 0;
  let issued = 0;
  let stalled = false;
  let supported = true;
  let disposed = false;
  const release = () => {
    if (fence) gl.deleteSync(fence);
    fence = null;
  };
  const reset = () => {
    release();
    budget = MODEL_RENDER_TILES_PER_FRAME;
    submitted = 0;
    queued = 0;
    issued = 0;
    stalled = false;
  };
  return {
    beginFrame() {
      if (disposed) return 0;
      if (!fence) return budget;
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        // A just-submitted fence can be invisible through the browser/GPU IPC
        // boundary for a frame or two. Back off only after sustained pressure.
        if (!stalled && now() - issued >= MODEL_RENDER_FENCE_GRACE_MS) {
          budget = Math.max(1, Math.floor(budget / 2));
          stalled = true;
        }
        return 0;
      }
      release();
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) {
        supported = false;
        budget = MODEL_RENDER_TILES_PER_FRAME;
      } else if (!stalled && now() - issued < MODEL_RENDER_FENCE_GRACE_MS && submitted >= budget) {
        budget = Math.min(MODEL_RENDER_MAX_TILES_PER_FRAME, budget + 3);
      }
      stalled = false;
      return budget;
    },
    endFrame(tiles: number) {
      queued = tiles;
    },
    finishFrame(successful = true) {
      if (!successful) {
        reset();
        return;
      }
      if (disposed || !supported || queued === 0 || fence) return;
      submitted = queued;
      queued = 0;
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (fence) {
        issued = now();
        gl.flush();
      } else {
        supported = false;
        budget = MODEL_RENDER_TILES_PER_FRAME;
      }
    },
    reset,
    dispose() {
      if (disposed) return;
      reset();
      disposed = true;
    },
  };
}

/** Specialize the pinned shader to the optical features owned by the Model scene. */
export function specializeModelRenderShader(source: string): string {
  const omit = (start: string, end: string, replacement = '') => {
    const first = source.indexOf(start),
      last = source.indexOf(end, first + start.length);
    if (
      first < 0 ||
      last < 0 ||
      source.indexOf(start, first + start.length) >= 0 ||
      source.indexOf(end, last + end.length) >= 0
    )
      throw new Error('The pinned path tracing shader does not match its Model specialization.');
    source = source.slice(0, first) + replacement + source.slice(last);
  };
  const replaceBlock = (block: string, replacement = '') => {
    const at = source.indexOf(block);
    if (at < 0 || source.indexOf(block, at + block.length) >= 0)
      throw new Error('The pinned path tracing shader does not match its Model specialization.');
    source = source.slice(0, at) + replacement + source.slice(at + block.length);
  };
  // The pinned texture is width=path depth, height=random domains. Its shader
  // reverses those coordinates, reading outside the texture for domains 11-16
  // with our short paths and freezing those samples across accumulation.
  replaceBlock(
    'ivec2 uv = ivec2( v, sobolBounceIndex );',
    'ivec2 uv = ivec2( sobolBounceIndex, v );',
  );
  const directStart = '\tvec3 directLightContribution(',
    directEnd = '\t#define SKIP_SURFACE 0',
    originalDirect = source.slice(source.indexOf(directStart), source.indexOf(directEnd));
  if (
    originalDirect.match(/\battenuateHit\(/g)?.length !== 2 ||
    originalDirect.match(/\bbsdfResult\(/g)?.length !== 2 ||
    !originalDirect.includes('envPdf /= lightsDenom;') ||
    !originalDirect.includes('float lightPdf = lightRec.pdf / lightsDenom;')
  )
    throw new Error('The pinned path tracing shader does not match its Model specialization.');
  omit(directStart, directEnd, modelDirectLightContribution);
  // All owned studio lights are rectangles. Retain their exact random domain,
  // position, sidedness, distance, emission and area PDF while removing unused
  // punctual/IES/circular dispatch before the driver inlines these functions.
  replaceBlock('\t\tl.type = int( round( s0.a ) );', '\t\tl.type = RECT_AREA_LIGHT_TYPE;');
  replaceBlock(
    '\t\t// spot light fields\n' +
      '\t\tfloat radius;\n\t\tfloat near;\n\t\tfloat decay;\n\t\tfloat distance;\n' +
      '\t\tfloat coneCos;\n\t\tfloat penumbraCos;\n\t\tint iesProfile;\n',
  );
  omit('\t\tif ( l.type == SPOT_LIGHT_TYPE || l.type == POINT_LIGHT_TYPE ) {', '\t\treturn l;');
  omit('\tfloat getSpotAttenuation(', '\tstruct LightRecord {');
  replaceBlock(
    '\t\t\tif(\n' +
      '\t\t\t\t( light.type == RECT_AREA_LIGHT_TYPE && intersectsRectangle( light.position, normal, u, v, rayOrigin, rayDirection, dist ) ) ||\n' +
      '\t\t\t\t( light.type == CIRC_AREA_LIGHT_TYPE && intersectsCircle( light.position, normal, u, v, rayOrigin, rayDirection, dist ) )\n' +
      '\t\t\t) {',
    '\t\t\tif ( intersectsRectangle( light.position, normal, u, v, rayOrigin, rayDirection, dist ) ) {',
  );
  omit('\tLightRecord randomSpotLightSample(', '\tLightRecord randomLightSample(');
  omit(
    '\t\tvec3 randomPos;\n\t\tif( light.type == RECT_AREA_LIGHT_TYPE ) {',
    '\t\tvec3 toLight = randomPos - rayOrigin;',
    '\t\tvec3 randomPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );\n\n',
  );
  omit(
    '\tLightRecord randomLightSample(',
    '#ifndef FOG_CHECK_ITERATIONS',
    '\tLightRecord randomLightSample( sampler2D lights, uint lightCount, vec3 rayOrigin, vec3 ruv ) {\n' +
      '\t\tuint l = uint( ruv.x * float( lightCount ) );\n' +
      '\t\tLight light = readLightInfo( lights, l );\n' +
      '\t\treturn randomAreaLightSample( light, rayOrigin, ruv.yz );\n' +
      '\t}\n\n',
  );
  replaceBlock(
    'randomLightSample( lights.tex, iesProfiles, lights.count, rayOrigin, rand3( 6 ) )',
    'randomLightSample( lights.tex, lights.count, rayOrigin, rand3( 6 ) )',
  );
  replaceBlock('\t\t\t\tuniform sampler2DArray iesProfiles;\n');
  replaceBlock(
    '\t#define CIRC_AREA_LIGHT_TYPE 1\n\t#define SPOT_LIGHT_TYPE 2\n' +
      '\t#define DIR_LIGHT_TYPE 3\n\t#define POINT_LIGHT_TYPE 4\n',
  );
  omit('\tbool intersectsCircle(', '\t\t\t\t// environment\n');
  // Fresh physical surfaces from the scene adapter never carry path-tracer fog,
  // matte, shadow opt-out, or specular maps. Keep authored specular uniforms.
  for (const [original, specialized] of [
    ['m.fogVolume = bool( int( s14.b ) & 4 );', 'm.fogVolume = false;'],
    ['m.matte = bool( s14.r );', 'm.matte = false;'],
    ['m.castShadow = bool( s14.g );', 'm.castShadow = true;'],
    ['m.specularColorMap = int( round( s10.a ) );', 'm.specularColorMap = - 1;'],
    ['m.specularIntensityMap = int( round( s11.g ) );', 'm.specularIntensityMap = - 1;'],
  ] as const)
    replaceBlock(original, specialized);
  omit('\n\t\tif ( material.fogVolume ) {', '\n\t\t// uv coord for textures');
  // Fog is absent from the owned scene. Remove its preprocessor-disabled code
  // before shrinking RenderState, which otherwise copies a complete Material
  // (including all texture transforms) into every visibility/lighting call.
  const fogBlocks = source.match(/#if FEATURE_FOG\b[\s\S]*?#endif/g) ?? [];
  if (
    fogBlocks.length !== 4 ||
    fogBlocks.some((block) => /#(?:if|else|elif)\b/.test(block.slice('#if FEATURE_FOG'.length)))
  )
    throw new Error('The pinned path tracing shader does not match its Model specialization.');
  for (const block of fogBlocks) replaceBlock(block);
  replaceBlock('\t\tMaterial fogMaterial;\n');
  replaceBlock('\t\tresult.fogMaterial.fogVolume = false;\n');
  replaceBlock('\t\tMaterial fogMaterial = state.fogMaterial;\n');
  replaceBlock(
    'Ray ray, Material fogMaterial, inout SurfaceHit surfaceHit',
    'Ray ray, inout SurfaceHit surfaceHit',
  );
  replaceBlock('traceScene( ray, state.fogMaterial, surfaceHit )', 'traceScene( ray, surfaceHit )');
  replaceBlock('traceScene( ray, fogMaterial, surfaceHit )', 'traceScene( ray, surfaceHit )');
  replaceBlock(
    'uniform float backgroundAlpha;',
    `uniform float backgroundAlpha;
      uniform int studioFloorIndex;
      uniform vec3 studioFloorFrame, studioFloorBackground;
      ${modelRenderFloorFade}`,
  );
  replaceBlock(
    'gl_FragColor = vec4( 0, 0, 0, 1 );',
    'gl_FragColor = vec4( 0, 0, 0, 1 );\nfloat floorFade = 0.0;',
  );
  const primaryMaterial =
    '\t\t\t\t\t\tuint materialIndex = uTexelFetch1D( materialIndexAttribute, surfaceHit.faceIndices.x ).r;';
  replaceBlock(
    primaryMaterial,
    `${primaryMaterial}
      if ( state.firstRay && int( materialIndex ) == studioFloorIndex && surfaceHit.side == 1.0 ) {
        vec2 offset = ( ray.origin.xy + ray.direction.xy * surfaceHit.dist - studioFloorFrame.xy )
          * studioFloorFrame.z;
        floorFade = studioFloorFade( offset );
        if ( floorFade >= 1.0 ) break;
      }`,
  );
  replaceBlock(
    'gl_FragColor.a *= opacity;',
    `if ( floorFade > 0.0 )
        gl_FragColor.rgb = mix( gl_FragColor.rgb, studioFloorBackground, floorFade );
      gl_FragColor.a *= opacity;`,
  );
  // The scene adapter constructs fresh physical materials without sheen or
  // iridescence. Remove their expensive spectral/velvet functions and texture
  // reads before driver optimization, retaining GGX, clearcoat and transmission.
  omit('\tfloat velvetD(', '\t// returns the hit distance given the material density');
  omit('\t// sheen\n\tvec3 sheenColor(', '\t// bsdf\n');
  omit('\t\t// sheenColor\n', '\t\t// specular color\n');
  omit('\t\t// sheen\n\t\tfloat sheen;', '\t\t// specular\n');
  replaceBlock(
    '\t\tvec3 iridescenceF = evalIridescence( 1.0, surf.iridescenceIor, dot( wi, wh ), surf.iridescenceThickness, f0Color );\n' +
      '\t\tF = mix( F, iridescenceF,  surf.iridescence );\n',
  );
  replaceBlock(
    '\t\tcolor *= mix( 1.0, sheenAlbedoScaling( wo, wi, surf ), surf.sheen );\n' +
      '\t\tcolor += sheenColor( wo, wi, halfVector, surf ) * surf.sheen;\n',
  );
  const assignments =
    /\n\t\tsurf\.(?:sheen|sheenColor|sheenRoughness|iridescence|iridescenceIor|iridescenceThickness) = [^;\n]*;/g;
  if ([...source.matchAll(assignments)].length !== 6)
    throw new Error('The pinned path tracing shader does not match its Model specialization.');
  source = source.replace(assignments, '');
  // Carry only the packed texture base through surface and shadow traversal.
  // Eagerly returning sixteen mat3 values makes the driver's inlined Material
  // copies expensive to compile. Every sample already guards its map index,
  // so fetch the identical transform there, retaining the original packed ABI.
  const textureMaps = [
    'map',
    'metalnessMap',
    'roughnessMap',
    'transmissionMap',
    'emissiveMap',
    'normalMap',
    'clearcoatMap',
    'clearcoatNormalMap',
    'clearcoatRoughnessMap',
    'sheenColorMap',
    'sheenRoughnessMap',
    'iridescenceMap',
    'iridescenceThicknessMap',
    'specularColorMap',
    'specularIntensityMap',
    'alphaMap',
  ];
  replaceBlock(
    textureMaps.map((map) => `\t\tmat3 ${map}Transform;\n`).join(''),
    '\t\tuint textureTransformIndex;\n',
  );
  replaceBlock(
    '\t\tuint firstTextureTransformIdx = i + 15u;',
    '\t\tm.textureTransformIndex = i + 15u;',
  );
  replaceBlock('\t\t// mat3( 1.0 ) is an identity matrix\n');
  for (const [index, map] of textureMaps.entries()) {
    const offset = index ? ` + ${index * 2}u` : '';
    replaceBlock(
      `\t\tm.${map}Transform = m.${map} == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx${offset} );\n`,
    );
    source = source.replaceAll(
      `material.${map}Transform`,
      `readTextureTransform( materials, material.textureTransformIndex${offset} )`,
    );
  }
  // STEP colours and untextured CAD do not need the general map sampling paths.
  // The scene-wide union is refreshed on every upload; adding a map enables its
  // exact original reader and sampler again before the next image can start.
  for (const [index, map] of modelRenderTextureMaps.entries()) {
    const assignment = source.match(
      new RegExp(`\\t\\tm\\.${map} = int\\( round\\( s\\d+\\.[rgba] \\) \\);`, 'g'),
    );
    if (assignment?.length !== 1)
      throw new Error('The pinned path tracing shader does not match its Model specialization.');
    replaceBlock(
      assignment[0],
      `#if ( MODEL_TEXTURE_MAPS & ${1 << index} ) != 0\n${assignment[0]}\n#else\n\t\tm.${map} = - 1;\n#endif`,
    );
  }
  return source;
}

/** Size the traversal stack from every generated tree, without shortening a tree. */
export function modelRenderBvhStackDepth(bvh: MeshBVH): number {
  let deepest = 0;
  for (const root of getBVHExtremes(bvh)) {
    if (
      !Number.isSafeInteger(root.depth.max) ||
      root.depth.max < 0 ||
      !Number.isSafeInteger(root.primitives.max) ||
      root.primitives.max < 0 ||
      root.primitives.max > 0xffff
    )
      throw new Error('The Model ray-tracing geometry exceeds its GPU traversal bounds.');
    deepest = Math.max(deepest, root.depth.max);
  }
  // Each traversal pops one node then pushes two. A depth-D tree therefore
  // needs D+1 pending entries; keep a spare and a small bucket for shader reuse.
  const entries = Math.ceil((deepest + 2) / 4) * 4;
  if (!Number.isSafeInteger(entries))
    throw new Error('The Model ray-tracing geometry exceeds its GPU traversal bounds.');
  return entries;
}

/** Constructor, scene uploads and GPU samples all restore the shared renderer on failure. */
export function withModelRenderState<T>(renderer: THREE.WebGLRenderer, action: () => T): T {
  const previous = {
    target: renderer.getRenderTarget(),
    cubeFace: renderer.getActiveCubeFace(),
    mipLevel: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    colorSpace: renderer.outputColorSpace,
    autoClear: renderer.autoClear,
    xrEnabled: renderer.xr.enabled,
    shadows: renderer.shadowMap.enabled,
  };
  try {
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = true;
    renderer.xr.enabled = false;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    return action();
  } finally {
    renderer.toneMapping = previous.toneMapping;
    renderer.toneMappingExposure = previous.exposure;
    renderer.outputColorSpace = previous.colorSpace;
    renderer.autoClear = previous.autoClear;
    renderer.xr.enabled = previous.xrEnabled;
    renderer.shadowMap.enabled = previous.shadows;
    renderer.setClearColor(previous.clearColor, previous.clearAlpha);
    renderer.setRenderTarget(previous.target, previous.cubeFace, previous.mipLevel);
    renderer.setViewport(previous.viewport);
    renderer.setScissor(previous.scissor);
    renderer.setScissorTest(previous.scissorTest);
  }
}

function withOutlineState<T>(scene: THREE.Scene, helpers: THREE.Object3D[], action: () => T): T {
  const visibility: [THREE.Object3D, boolean][] = [];
  scene.traverse((object) => visibility.push([object, object.visible]));
  const background = scene.background,
    override = scene.overrideMaterial;
  try {
    for (const helper of helpers) helper.visible = false;
    return action();
  } finally {
    for (const [object, visible] of visibility) object.visible = visible;
    scene.background = background;
    scene.overrideMaterial = override;
  }
}

/** Responsive preview omits optical transmission; the independent path tracer keeps its full material data. */
export function renderModelRasterPreview(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  const transmission = new Map<THREE.MeshPhysicalMaterial, number>();
  scene.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of [object.material].flat())
      if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0)
        transmission.set(material, material.transmission);
  });
  try {
    // Three retains transmission targets by Scene. These short-lived private
    // previews need no optical pass; only converging path-traced frames use it.
    for (const material of transmission.keys()) material.transmission = 0;
    renderer.render(scene, camera);
  } finally {
    for (const [material, value] of transmission) material.transmission = value;
  }
}

type Disposable = { dispose(): void };
type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
type TextureArray = THREE.Texture & {
  setTextures(
    renderer: THREE.WebGLRenderer,
    textures: THREE.Texture[],
    width?: number,
    height?: number,
  ): void;
};
type TraceMaterial = THREE.ShaderMaterial & {
  setDefine(name: string, value: number): boolean;
  bounces: number;
  transmissiveBounces: number;
  filterGlossyFactor: number;
  bvh: Disposable & { updateFrom(bvh: MeshBVH): void };
  attributesArray: Disposable & { updateFrom(...attributes: Attribute[]): void };
  materialIndexAttribute: Disposable & { updateFrom(attribute: Attribute): void };
  materials: Disposable & {
    updateFrom(materials: THREE.Material[], textures: THREE.Texture[]): void;
  };
  textures: TextureArray;
  iesProfiles: TextureArray;
  lights: { tex: THREE.Texture; updateFrom(lights: THREE.Light[], ies: THREE.Texture[]): void };
  envMapInfo: Disposable;
  stratifiedTexture: THREE.Texture;
  stratifiedOffsetTexture: THREE.Texture;
  backgroundMap: THREE.Texture;
  backgroundAlpha: number;
  backgroundBlur: number;
  backgroundIntensity: number;
  backgroundRotation: THREE.Matrix4;
  environmentIntensity: number;
  environmentRotation: THREE.Matrix4;
};
type TraceRenderer = Disposable & {
  readonly samples: number;
  readonly target: THREE.WebGLRenderTarget;
  readonly isCompiling: boolean;
  alpha: boolean;
  tiles: THREE.Vector2;
  setCamera(camera: THREE.Camera): void;
  setSize(width: number, height: number): void;
  reset(): void;
  update(): void;
  material: TraceMaterial;
  _blendQuad: FullScreenQuad;
  _fsQuad: FullScreenQuad & { _mesh: THREE.Mesh };
  _compileFunction: () => void;
  _compilePromise: Promise<unknown> | null;
};
// The pinned runtime exports the renderer but omits its TypeScript declaration.
const { PathTracingRenderer } = pathTracing as unknown as {
  PathTracingRenderer: new (renderer: THREE.WebGLRenderer) => TraceRenderer;
};
type TraceGenerator = PathTracingSceneGenerator & {
  staticGeometryGenerator: {
    _intermediateGeometry: Map<string, THREE.BufferGeometry>;
    _dummyMesh?: THREE.Mesh;
    setObjects(objects: THREE.Object3D[]): void;
  };
};
type ArrayTarget = Disposable & { fsQuad?: FullScreenQuad };

function captureArrayTargets<T>(
  renderer: THREE.WebGLRenderer,
  textures: ReadonlySet<THREE.Texture>,
  owners: Map<THREE.Texture, ArrayTarget>,
  action: () => T,
): T {
  const setTarget = renderer.setRenderTarget;
  // r186 replaces WebGLArrayRenderTarget.texture without assigning its owner.
  // The upload exposes that owner here; texture.dispose cannot release its framebuffer.
  renderer.setRenderTarget = (...args: Parameters<THREE.WebGLRenderer['setRenderTarget']>) => {
    const [target] = args;
    if (target) {
      const attached = Array.isArray(target.texture) ? target.texture : [target.texture];
      for (const texture of attached) if (textures.has(texture)) owners.set(texture, target);
    }
    return setTarget.apply(renderer, args);
  };
  try {
    return action();
  } finally {
    renderer.setRenderTarget = setTarget;
  }
}

/** The pinned low-level renderer leaves uniform allocations and baked geometry to its owner. */
function disposePinnedPathTracer(
  tracer: TraceRenderer,
  generator: TraceGenerator,
  arrayOwners: Map<THREE.Texture, ArrayTarget>,
) {
  const released = new Set<Disposable>();
  const release = (value: Disposable | null | undefined) => {
    if (!value || released.has(value)) return;
    released.add(value);
    value.dispose();
  };
  {
    const material = tracer.material;
    for (const key of [
      'bvh',
      'attributesArray',
      'materialIndexAttribute',
      'materials',
      'envMapInfo',
      'stratifiedTexture',
      'stratifiedOffsetTexture',
    ] as const)
      release(material[key]);
    release(material.lights.tex);
    for (const texture of [material.textures, material.iesProfiles]) {
      const target = arrayOwners.get(texture) ?? (texture.renderTarget as ArrayTarget | null);
      if (target) {
        release(target.fsQuad?.material);
        release(target);
      } else release(texture);
    }
    release(tracer._blendQuad.material);
    release(material);
  }
  tracer.dispose();
  release(generator.geometry);
  const geometries = generator.staticGeometryGenerator;
  for (const geometry of geometries._intermediateGeometry.values()) release(geometry);
  geometries._intermediateGeometry.clear();
  if (geometries._dummyMesh) {
    release(geometries._dummyMesh.geometry);
    for (const material of [geometries._dummyMesh.material].flat()) release(material);
  }
  geometries.setObjects([]);
  arrayOwners.clear();
}

function createPathTracingBackend(
  renderer: THREE.WebGLRenderer,
  originalScene: THREE.Scene,
  helpers: THREE.Object3D[],
): ModelPathTracingBackend {
  const context = renderer.getContext();
  if (!('fenceSync' in context)) throw new Error('Model Render requires WebGL2.');
  const tracer = new PathTracingRenderer(renderer);
  const generator = new PathTracingSceneGenerator() as TraceGenerator;
  const material = tracer.material;
  material.bounces = 3;
  material.transmissiveBounces = 3;
  material.filterGlossyFactor = 0.5;
  tracer.tiles.set(3, 3);
  const backgroundPixels = new Float32Array(4);
  const background = new THREE.DataTexture(
    backgroundPixels,
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  material.backgroundMap = background;
  material.backgroundAlpha = 1;
  const studioFloorIndex = (material.uniforms.studioFloorIndex = { value: -1 });
  const studioFloorFrame = (material.uniforms.studioFloorFrame = { value: new THREE.Vector3() });
  const studioFloorBackground = (material.uniforms.studioFloorBackground = {
    value: new THREE.Color(),
  });
  let environmentSource: THREE.DataTexture | undefined;
  const denoiser = createModelRenderDenoiser(renderer);
  let renderScene: THREE.Scene;
  const image = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const resolved = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const drawingSize = new THREE.Vector2();
  const resolveMaterial = new THREE.ShaderMaterial({
    name: 'OpenPE Render subpixel resolve',
    uniforms: {
      source: { value: image.texture },
      sourceSize: { value: new THREE.Vector2() },
      footprint: { value: new THREE.Vector2() },
    },
    depthWrite: false,
    depthTest: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D source;
      uniform vec2 sourceSize, footprint;

      void main() {
        vec2 start = ( gl_FragCoord.xy - 0.5 ) * footprint;
        vec2 end = start + footprint;
        vec2 first = floor( start );
        vec4 sum = vec4( 0.0 );
        // A 1.5× footprint can overlap at most three source cells per axis.
        for ( int y = 0; y < 3; y++ ) {
          for ( int x = 0; x < 3; x++ ) {
            vec2 cell = first + vec2( float( x ), float( y ) );
            vec2 overlap = max( vec2( 0.0 ), min( end, cell + 1.0 ) - max( start, cell ) );
            sum += texture2D( source, ( cell + 0.5 ) / sourceSize ) * overlap.x * overlap.y;
          }
        }
        gl_FragColor = sum / ( footprint.x * footprint.y );
      }
    `,
  });
  const resolveQuad = new FullScreenQuad(resolveMaterial);
  const copyMaterial = new THREE.MeshBasicMaterial({
    map: image.texture,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NoBlending,
  });
  const copyQuad = new FullScreenQuad(copyMaterial);
  let disposed = false;
  let denoisedSample = -1;
  let resolvedCurrent = false;
  const controller = new AbortController();
  const frameBudget = createModelRenderFrameBudget(context);
  const primary = tracer;
  const arrayOwners = new Map<THREE.Texture, ArrayTarget>();
  const arrayTextures = new Set([material.textures, material.iesProfiles]);
  const events = material as unknown as THREE.EventDispatcher<{ recompilation: object }>;
  let compileRequested = true;
  let compileError: unknown;
  let compiling: Promise<void> | null = null;
  const requestCompile = () => {
    compileRequested = true;
  };
  // The pinned listener compiles once for every intermediate define. Finalize all
  // scene/camera/features first, then compile one program against its real target.
  events.removeEventListener('recompilation', primary._compileFunction);
  events.addEventListener('recompilation', requestCompile);
  const compileCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const startCompile = () => {
    compileRequested = false;
    const pending = prepareModelShaders({
      signal: controller.signal,
      timeoutMs: MODEL_RENDER_COMPILE_TIMEOUT_MS,
      dispose: () => material.dispose(),
      compile: () =>
        withModelRenderState(renderer, () => {
          renderer.setRenderTarget(tracer.target);
          renderer.toneMapping = THREE.NoToneMapping;
          return renderer.compileAsync(primary._fsQuad._mesh, compileCamera).then(() => {
            if (disposed) return;
            const properties = renderer.properties.get(material) as {
              currentProgram?: { program?: WebGLProgram };
            };
            const program = properties.currentProgram?.program;
            const gl = renderer.getContext();
            if (!program || !gl.getProgramParameter(program, gl.LINK_STATUS))
              throw new Error(
                `Path tracing shader compilation failed${program ? `: ${gl.getProgramInfoLog(program)?.slice(0, 240) ?? ''}` : '.'}`,
              );
          });
        }),
    }).then(
      () => {
        if (compiling === pending) compiling = null;
        if (primary._compilePromise === pending) primary._compilePromise = null;
      },
      (error: unknown) => {
        if (!disposed) compileError = error;
        if (compiling === pending) compiling = null;
        if (primary._compilePromise === pending) primary._compilePromise = null;
      },
    );
    compiling = pending;
    primary._compilePromise = pending;
  };
  let outlineState:
    | {
        composer: EffectComposer;
        texture: TexturePass;
        outline: OutlinePass;
        output: OutputPass;
        cameraType: string;
      }
    | undefined;
  const releaseOutline = () => {
    if (!outlineState) return;
    outlineState.texture.dispose();
    outlineState.outline.dispose();
    outlineState.output.dispose();
    outlineState.composer.dispose();
    outlineState = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    frameBudget.dispose();
    events.removeEventListener('recompilation', requestCompile);
    releaseOutline();
    denoiser.dispose();
    image.dispose();
    resolved.dispose();
    resolveMaterial.dispose();
    resolveQuad.dispose();
    copyMaterial.dispose();
    copyQuad.dispose();
    background.dispose();
    disposePinnedPathTracer(tracer, generator, arrayOwners);
  };
  try {
    tracer.alpha = !renderer.extensions.get('EXT_float_blend');
    material.fragmentShader = specializeModelRenderShader(material.fragmentShader);
    // Short fixed surface paths do not need randomized roulette termination.
    // Keep multiple-importance sampling for low-noise direct light and reflections.
    material.setDefine('FEATURE_RUSSIAN_ROULETTE', 0);
    material.needsUpdate = true;
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    get samples() {
      return tracer.samples;
    },
    get compiling() {
      return !!compiling || compileRequested;
    },
    beginFrame() {
      if (renderer.getContext().isContextLost()) {
        frameBudget.reset();
        throw new Error('The WebGL context was lost while preparing or rendering the image.');
      }
      return frameBudget.beginFrame();
    },
    endFrame: frameBudget.endFrame,
    finishFrame: frameBudget.finishFrame,
    setScene(scene, camera) {
      renderScene = scene;
      denoiser.invalidate();
      frameBudget.reset();
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      // Release baked geometry before the pinned generator drops obsolete mesh references.
      for (const geometry of generator.staticGeometryGenerator._intermediateGeometry.values())
        geometry.dispose();
      generator.staticGeometryGenerator._intermediateGeometry.clear();
      if (
        !(scene.environment instanceof THREE.DataTexture) ||
        !(scene.background instanceof THREE.Color)
      )
        throw new Error(
          'The Model studio requires its generated environment and solid background.',
        );
      generator.setObjects(scene);
      const results = generator.generate();
      const floor = scene.children.find((object) => object.name === modelRenderFloorName);
      if (!(floor instanceof THREE.Mesh) || Array.isArray(floor.material))
        throw new Error('The Model studio requires its matte floor.');
      studioFloorIndex.value = results.materials.indexOf(floor.material);
      studioFloorFrame.value.set(
        floor.position.x,
        floor.position.y,
        modelRenderFloorScale / floor.scale.x,
      );
      studioFloorBackground.value.copy(scene.background).multiplyScalar(scene.backgroundIntensity);
      if (results.bvhChanged) {
        material.bvh.updateFrom(results.bvh);
        material.attributesArray.updateFrom(
          results.geometry.getAttribute('normal'),
          results.geometry.getAttribute('tangent'),
          results.geometry.getAttribute('uv'),
          results.geometry.getAttribute('color'),
        );
      }
      if (results.needsMaterialIndexUpdate)
        material.materialIndexAttribute.updateFrom(results.geometry.getAttribute('materialIndex'));
      const bySource = new Map<string, THREE.Texture>();
      for (const texture of results.textures) {
        const key = `${texture.source.uuid}:${texture.colorSpace}`;
        if (!bySource.has(key)) bySource.set(key, texture);
      }
      const textures = [...bySource.values()].sort((a, b) => b.uuid.localeCompare(a.uuid));
      const lights = results.lights.sort((a, b) => b.uuid.localeCompare(a.uuid));
      if (lights.some((light) => !(light instanceof THREE.RectAreaLight)))
        throw new Error('The Model studio supports rectangular area lights only.');
      captureArrayTargets(renderer, arrayTextures, arrayOwners, () => {
        material.textures.setTextures(renderer, textures, 1024, 1024);
        material.iesProfiles.setTextures(renderer, []);
      });
      material.materials.updateFrom(results.materials, textures);
      material.setDefine('MODEL_TEXTURE_MAPS', modelRenderTextureMask(results.materials));
      material.lights.updateFrom(lights, []);
      if (environmentSource !== scene.environment) {
        const environment = createModelRenderEnvironment(scene.environment);
        material.envMapInfo.dispose();
        material.envMapInfo = environment;
        environmentSource = scene.environment;
      }
      backgroundPixels.set([...scene.background.toArray(), 1]);
      background.needsUpdate = true;
      material.backgroundBlur = scene.backgroundBlurriness;
      material.backgroundIntensity = scene.backgroundIntensity;
      material.backgroundRotation.makeRotationFromEuler(scene.backgroundRotation).invert();
      material.environmentIntensity = scene.environmentIntensity;
      material.environmentRotation.makeRotationFromEuler(scene.environmentRotation).invert();
      tracer.setCamera(camera);
      material.setDefine('BVH_STACK_DEPTH', modelRenderBvhStackDepth(results.bvh));
      tracer.reset();
      denoisedSample = -1;
    },
    updateCamera(camera) {
      denoiser.invalidate();
      frameBudget.reset();
      tracer.setCamera(camera);
      tracer.reset();
      denoisedSample = -1;
    },
    resize(width, height) {
      denoiser.invalidate();
      frameBudget.reset();
      tracer.setSize(width, height);
      tracer.reset();
      denoisedSample = -1;
    },
    reset() {
      denoiser.invalidate();
      frameBudget.reset();
      tracer.reset();
      denoisedSample = -1;
    },
    renderSample() {
      if (compileError) throw compileError;
      if (renderer.getContext().isContextLost())
        throw new Error('The WebGL context was lost while preparing or rendering the image.');
      (material.onBeforeRender as unknown as () => void).call(material);
      if (compiling) return;
      if (compileRequested) {
        startCompile();
        return;
      }
      tracer.update();
    },
    present(camera, selected) {
      const { width, height } = tracer.target;
      const completed = modelRenderPresentationSample(tracer.samples);
      if (denoisedSample !== completed || image.width !== width || image.height !== height) {
        resolvedCurrent = false;
        image.setSize(width, height);
        denoiser.render(tracer.target.texture, image, renderScene, camera, tracer.samples);
        denoisedSample = completed;
      }
      renderer.getDrawingBufferSize(drawingSize);
      const outputWidth = Math.max(1, Math.min(width, drawingSize.x));
      const outputHeight = Math.max(1, Math.min(height, drawingSize.y));
      const downsample = width !== outputWidth || height !== outputHeight;
      if (downsample) {
        if (!resolvedCurrent || resolved.width !== outputWidth || resolved.height !== outputHeight) {
          resolvedCurrent = false;
          resolved.setSize(outputWidth, outputHeight);
          resolveMaterial.uniforms.sourceSize.value.set(width, height);
          resolveMaterial.uniforms.footprint.value.set(width / outputWidth, height / outputHeight);
          renderer.setRenderTarget(resolved);
          resolveQuad.render(renderer);
          resolvedCurrent = true;
        }
      }
      const display = downsample ? resolved : image;
      renderer.setRenderTarget(null);
      if (!selected.length) {
        copyMaterial.map = display.texture;
        copyQuad.render(renderer);
        return;
      }
      if (outlineState?.cameraType !== camera.type) releaseOutline();
      if (!outlineState) {
        const composer = new EffectComposer(
          renderer,
          new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
        );
        composer.setPixelRatio(1);
        const texture = new TexturePass(display.texture);
        const outline = new OutlinePass(new THREE.Vector2(1, 1), originalScene, camera);
        outline.visibleEdgeColor.set('#528bff');
        outline.hiddenEdgeColor.set(0x000000);
        outline.edgeStrength = 3;
        const output = new OutputPass();
        composer.addPass(texture);
        composer.addPass(outline);
        composer.addPass(output);
        outlineState = { composer, texture, outline, output, cameraType: camera.type };
      }
      const state = outlineState;
      state.texture.map = display.texture;
      state.composer.setSize(display.width, display.height);
      state.outline.renderCamera = camera;
      state.outline.selectedObjects = selected;
      withOutlineState(originalScene, helpers, () => state.composer.render());
    },
    dispose,
  };
}

const defaults: ModelStudioRendererDependencies = {
  createScene: createModelRenderScene,
  createBackend: createPathTracingBackend,
};
function cameraBasis(camera: THREE.Camera) {
  return JSON.stringify(
    [
      camera.type,
      ...camera.position.toArray(),
      ...camera.quaternion.toArray(),
      ...camera.scale.toArray(),
      ...camera.projectionMatrix.elements,
      ...(camera.parent ? camera.parent.matrixWorld.elements : []),
    ].map((value) => (typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value)),
  );
}
function copyRenderCamera(camera: THREE.Camera, existing: THREE.Camera | undefined) {
  const copy = existing?.type === camera.type ? existing.copy(camera, false) : camera.clone();
  if (camera.parent) {
    copy.matrix.compose(camera.position, camera.quaternion, camera.scale);
    copy.matrix.premultiply(camera.parent.matrixWorld);
    copy.matrix.decompose(copy.position, copy.quaternion, copy.scale);
  }
  copy.updateMatrixWorld(true);
  return copy;
}

/** True progressive WebGL2 path tracing over a private physical scene, outside design ownership. */
export function createModelStudioRenderer(
  renderer: THREE.WebGLRenderer,
  originalScene: THREE.Scene,
  content: THREE.Group,
  helpers: THREE.Object3D[],
  dependencies: ModelStudioRendererDependencies = defaults,
) {
  // Three owns these immutable LUTs. Its module survives a Model hot update;
  // a module-local flag would allocate new textures on every refresh.
  const lightUniforms = THREE.UniformsLib as unknown as Record<string, unknown>;
  if (
    !['LTC_FLOAT_1', 'LTC_FLOAT_2', 'LTC_HALF_1', 'LTC_HALF_2'].every(
      (key) => lightUniforms[key] instanceof THREE.DataTexture,
    )
  ) {
    RectAreaLightUniformsLib.init();
  }
  const physical = dependencies.createScene(content);
  let backend: ModelPathTracingBackend | undefined, camera: THREE.Camera | undefined;
  let retainedCameraBasis = '',
    retainedSceneBasis = '';
  let presentedSamples = -1;
  let presentedSelection: THREE.Object3D[] = [];
  const drawing = new THREE.Vector2();
  const css = new THREE.Vector2();
  const presentedDrawingSize = new THREE.Vector2();
  let needsSync = true,
    needsSceneUpload = true,
    moved = false,
    disposed = false,
    width = 0,
    height = 0;
  return {
    get samples() {
      return backend?.samples ?? 0;
    },
    invalidate() {
      if (!disposed) needsSync = true;
    },
    render(sourceCamera: THREE.Camera, options: ModelStudioRenderOptions): ModelRenderProgress {
      if (disposed) throw new Error('The path tracer has been disposed.');
      return withModelRenderState(renderer, () => {
        const sceneBasis = JSON.stringify([
          options.dark,
          ...options.bounds.min.toArray(),
          ...options.bounds.max.toArray(),
        ]);
        if (needsSync || retainedSceneBasis !== sceneBasis) {
          if (physical.sync(options.bounds, options.dark)) needsSceneUpload = true;
          retainedSceneBasis = sceneBasis;
          needsSync = false;
        }
        const nextCameraBasis = cameraBasis(sourceCamera),
          changedCamera = nextCameraBasis !== retainedCameraBasis;
        if (changedCamera || !camera) {
          camera = copyRenderCamera(sourceCamera, camera);
          retainedCameraBasis = nextCameraBasis;
        }
        if (options.moving) {
          // The retained tracer cannot sample during motion. Clear its three
          // accumulation targets once, then only redraw the responsive preview.
          if (!moved) backend?.reset();
          moved = true;
          presentedSamples = -1;
          renderModelRasterPreview(renderer, physical.scene, camera!);
          return { samples: 0, complete: false };
        }
        backend ??= dependencies.createBackend(renderer, originalScene, helpers);
        if (needsSceneUpload) {
          backend.setScene(physical.scene, camera!);
          presentedSamples = -1;
          needsSceneUpload = false;
          moved = false;
        } else if (changedCamera || moved) {
          backend.updateCamera(camera!);
          presentedSamples = -1;
          moved = false;
        }
        renderer.getDrawingBufferSize(drawing);
        renderer.getSize(css);
        const { width: nextWidth, height: nextHeight } = modelRenderWorkingSize(drawing, css);
        if (nextWidth !== width || nextHeight !== height) {
          backend.resize(nextWidth, nextHeight);
          presentedSamples = -1;
          width = nextWidth;
          height = nextHeight;
        }
        let successfulFrame = false;
        try {
          advanceModelRenderFrame(backend);
          const completed = modelRenderPresentationSample(backend.samples);
          const selected = options.selected ?? [];
          if (
            !options.continuation ||
            completed !== presentedSamples ||
            !drawing.equals(presentedDrawingSize) ||
            selected.length !== presentedSelection.length ||
            selected.some((object, index) => object !== presentedSelection[index])
          ) {
            if (backend.samples >= 1) backend.present(camera!, selected);
            else renderModelRasterPreview(renderer, physical.scene, camera!);
            presentedSamples = completed;
            presentedDrawingSize.copy(drawing);
            presentedSelection = [...selected];
          }
          successfulFrame = true;
        } finally {
          if (!successfulFrame) presentedSamples = -1;
          // Fence after denoising, outlines and copy: the next batch must not
          // queue behind unfinished presentation of the previous image.
          backend.finishFrame?.(successfulFrame);
        }
        return {
          samples: backend.samples,
          complete: backend.samples >= MODEL_RENDER_SAMPLES && !backend.compiling,
        };
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        backend?.dispose();
      } finally {
        physical.dispose();
      }
    },
  };
}
