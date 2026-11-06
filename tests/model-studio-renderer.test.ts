import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import * as pathTracing from 'three-gpu-pathtracer';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { getBVHExtremes, MeshBVH } from 'three-mesh-bvh';
import {
  advanceModelRenderFrame,
  createModelStudioRenderer,
  createModelRenderFrameBudget,
  MODEL_RENDER_MAX_DIMENSION,
  MODEL_RENDER_SAMPLES,
  modelRenderBvhStackDepth,
  renderModelRasterPreview,
  specializeModelRenderShader,
  type ModelPathTracingBackend,
  type ModelStudioRendererDependencies,
} from '../components/model-studio-renderer';

test('existing Three area-light textures survive a new Model implementation instance', () => {
  RectAreaLightUniformsLib.init();
  const uniforms = THREE.UniformsLib as unknown as Record<string, THREE.DataTexture>;
  const keys = ['LTC_FLOAT_1', 'LTC_FLOAT_2', 'LTC_HALF_1', 'LTC_HALF_2'];
  const before = keys.map((key) => uniforms[key]);
  const f = fixture();
  for (let index = 0; index < keys.length; index++)
    assert.equal(
      uniforms[keys[index]],
      before[index],
      'Reuse the library-owned texture after refresh.',
    );
  f.studio.dispose();
  f.target.dispose();
});

function frameBudgetFixture() {
  let status = 2;
  let failFence = false;
  let elapsed = 0;
  const created: WebGLSync[] = [],
    deleted: WebGLSync[] = [];
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    ALREADY_SIGNALED: 2,
    CONDITION_SATISFIED: 3,
    TIMEOUT_EXPIRED: 4,
    flushes: 0,
    polls: 0,
    fenceSync(condition: number, flags: number) {
      assert.equal(condition, 1);
      assert.equal(flags, 0);
      if (failFence) return null;
      const fence = { id: created.length } as unknown as WebGLSync;
      created.push(fence);
      return fence;
    },
    clientWaitSync(_fence: WebGLSync, flags: number, timeout: number) {
      assert.equal(flags, 0);
      assert.equal(timeout, 0, 'GPU backpressure never blocks the UI thread.');
      this.polls++;
      return status;
    },
    deleteSync(fence: WebGLSync) {
      assert.equal(deleted.includes(fence), false, 'Every owned sync is released once.');
      deleted.push(fence);
    },
    flush() {
      this.flushes++;
    },
  };
  return {
    budget: createModelRenderFrameBudget(gl, () => elapsed),
    gl,
    created,
    deleted,
    setStatus(value: number) {
      status = value;
    },
    setTime(value: number) {
      elapsed = value;
    },
    failFence() {
      failFence = true;
    },
  };
}

test('GPU-completed batches grow conservatively and fence only after presentation', () => {
  const f = frameBudgetFixture();
  for (let frame = 0; frame < 32; frame++) {
    const tiles = f.budget.beginFrame();
    assert.equal(tiles, Math.min(27, 3 + frame * 3));
    f.budget.endFrame(tiles);
    assert.equal(
      f.created.length,
      frame,
      'Trace submission alone must not fence before presentation.',
    );
    f.budget.finishFrame();
    assert.equal(f.created.length - f.deleted.length, 1, 'Only one GPU batch remains in flight.');
  }
  f.budget.dispose();
  f.budget.dispose();
  assert.equal(f.created.length, f.deleted.length);
  assert.equal(f.gl.flushes, f.created.length);
  assert.equal(f.budget.beginFrame(), 0);
});

test('brief fence visibility delays retain growth instead of starving tile submission', () => {
  const f = frameBudgetFixture();
  f.budget.endFrame(f.budget.beginFrame());
  f.budget.finishFrame();
  f.setStatus(f.gl.TIMEOUT_EXPIRED);
  for (const time of [16, 32]) {
    f.setTime(time);
    assert.equal(f.budget.beginFrame(), 0);
    f.budget.endFrame(0);
    f.budget.finishFrame();
    assert.equal(f.created.length, 1, 'Visibility delays cannot stack tracing batches.');
  }
  f.setTime(33);
  f.setStatus(f.gl.CONDITION_SATISFIED);
  assert.equal(f.budget.beginFrame(), 6, 'A completed batch inside the grace period can grow.');
  f.budget.dispose();
});

test('sustained GPU backpressure reduces the budget once after its grace period', () => {
  const f = frameBudgetFixture();
  f.budget.endFrame(f.budget.beginFrame());
  f.budget.finishFrame();
  f.setStatus(f.gl.TIMEOUT_EXPIRED);
  for (let frame = 0; frame < 3; frame++) {
    f.setTime(50 + frame * 20);
    assert.equal(f.budget.beginFrame(), 0);
    f.budget.endFrame(0);
    f.budget.finishFrame();
    assert.equal(f.created.length, 1, 'Waiting frames cannot replace or stack GPU fences.');
  }
  f.setStatus(f.gl.CONDITION_SATISFIED);
  assert.equal(f.budget.beginFrame(), 1, 'Slow GPUs can reduce work to one tile.');
  f.budget.endFrame(1);
  f.budget.finishFrame();
  assert.equal(f.budget.beginFrame(), 4, 'A recovered full batch grows by three tiles.');
  f.budget.endFrame(4);
  f.budget.finishFrame();
  f.budget.reset();
  assert.equal(f.created.length, f.deleted.length);
  assert.equal(f.budget.beginFrame(), 3, 'A new image starts with a conservative budget.');
  f.budget.endFrame(3);
  f.budget.finishFrame();
  f.budget.finishFrame(false);
  assert.equal(f.created.length, f.deleted.length, 'A failed frame releases pending syncs.');
  assert.equal(f.budget.beginFrame(), 3);
  f.budget.dispose();
});

test('missing or failed GPU fences retain conservative bounded submission', () => {
  for (const failedWait of [false, true]) {
    const f = frameBudgetFixture();
    if (!failedWait) f.failFence();
    f.budget.endFrame(f.budget.beginFrame());
    f.budget.finishFrame();
    if (failedWait) f.setStatus(0);
    assert.equal(f.budget.beginFrame(), 3);
    f.budget.endFrame(3);
    f.budget.finishFrame();
    assert.equal(f.budget.beginFrame(), 3);
    f.budget.dispose();
    assert.equal(f.created.length, f.deleted.length);
  }
});

// The pinned package exports this runtime constructor but omits it from its declarations.
const { PhysicalPathTracingMaterial } = pathTracing as unknown as {
  PhysicalPathTracingMaterial: new () => THREE.ShaderMaterial;
};

test('pinned Model shader omits unused spectral and velvet optics while retaining physical PCB shading', () => {
  const material = new PhysicalPathTracingMaterial();
  const source = material.fragmentShader;
  const shader = specializeModelRenderShader(source);
  assert.ok(shader.length < source.length);
  for (const unused of ['evalIridescence(', 'evalSensitivity(', 'velvetD(', 'sheenAlbedoScaling('])
    assert.equal(shader.includes(unused), false, `${unused} must not reach the driver compiler.`);
  assert.doesNotMatch(shader, /surf\.(?:sheen|iridescence)/);
  for (const retained of [
    'ggxDistribution(',
    'transmissionDirection(',
    'clearcoatDirection(',
    'directLightContribution(',
    'material.normalMapTransform',
    'material.clearcoatNormalMapTransform',
    'vec4 albedo = vec4( material.color, material.opacity );',
    'mix( f0 * surf.specularColor * surf.specularIntensity, surf.color, surf.metalness )',
  ])
    assert.ok(shader.includes(retained), `${retained} must retain its original physical behavior.`);
  assert.equal(material.defines.FEATURE_MIS, 1);
  assert.equal(material.fragmentShader, source, 'Specialization does not mutate another shader.');
  assert.throws(() => specializeModelRenderShader(shader), /pinned path tracing shader/);
  assert.throws(
    () => specializeModelRenderShader(source.replace('vec3 iridescenceF =', 'vec3 changed =')),
    /pinned path tracing shader/,
    'An incompatible pinned shader fails explicitly before compilation.',
  );
  material.dispose();
});

test('owned surface invariants specialize unused branches while preserving authored specular uniforms', () => {
  const material = new PhysicalPathTracingMaterial();
  const shader = specializeModelRenderShader(material.fragmentShader);
  for (const retained of [
    'm.fogVolume = false;',
    'm.matte = false;',
    'm.castShadow = true;',
    'm.specularColorMap = - 1;',
    'm.specularIntensityMap = - 1;',
    'm.specularColor = s10.rgb;',
    'm.specularIntensity = s11.r;',
    'surf.specularColor = specularColor;',
    'surf.specularIntensity = specularIntensity;',
  ])
    assert.ok(shader.includes(retained), `Owned surface specialization retains ${retained}`);
  assert.equal(shader.includes('SurfaceRecord fogSurface;'), false);
  assert.doesNotMatch(shader, /\bfogMaterial\b|#if FEATURE_FOG\b/);
  assert.equal(shader.match(/traceScene\( ray, surfaceHit \)/g)?.length, 2);
  assert.ok(shader.includes('Ray ray, inout SurfaceHit surfaceHit'));
  assert.ok(shader.includes('Material material = readMaterialInfo( materials, materialIndex );'));
  material.dispose();
});

test('stratified shader coordinates stay in the actual short-path texture and change across samples', () => {
  const material = new PhysicalPathTracingMaterial();
  const shader = specializeModelRenderShader(material.fragmentShader);
  assert.ok(shader.includes('ivec2 uv = ivec2( sobolBounceIndex, v );'));
  assert.equal(shader.includes('ivec2 uv = ivec2( v, sobolBounceIndex );'), false);
  const texture = material.uniforms.stratifiedTexture.value as THREE.DataTexture & {
    stableNoise: boolean;
    init(count: number, depth: number): void;
    reset(): void;
    next(): void;
  };
  texture.stableNoise = true;
  texture.init(20, 3 + 3 + 5);
  texture.reset();
  const { width, height } = texture.image;
  assert.equal(width, 11);
  assert.equal(height, 20);
  const dimensions: { offset: number; values: Set<number> }[] = [];
  // Main-path and shadow/transmission traversal together reach bounce index 7;
  // the pinned BSDF uses random domains through 16 (including every optical lobe).
  for (let domain = 0; domain <= 16; domain++)
    for (let bounce = 0; bounce <= 7; bounce++) {
      assert.ok(bounce < width && domain < height);
      dimensions.push({ offset: 4 * (domain * width + bounce), values: new Set() });
    }
  for (let sample = 0; sample < 64; sample++) {
    texture.next();
    const data = texture.image.data as Float32Array;
    for (const dimension of dimensions) {
      const value = data[dimension.offset];
      assert.ok(Number.isFinite(value) && value >= 0 && value < 1);
      dimension.values.add(value);
    }
  }
  for (const dimension of dimensions)
    assert.ok(
      dimension.values.size >= 48,
      'Every active random domain varies during accumulation.',
    );
  texture.dispose();
  material.dispose();
});

test('area and environment light sampling share one visibility and MIS evaluation path', () => {
  const material = new PhysicalPathTracingMaterial();
  const extract = (shader: string) =>
    shader.slice(
      shader.indexOf('vec3 directLightContribution('),
      shader.indexOf('#define SKIP_SURFACE 0'),
    );
  const original = extract(material.fragmentShader);
  const specialized = extract(specializeModelRenderShader(material.fragmentShader));
  for (const expensive of [/\battenuateHit\(/g, /\bbsdfResult\(/g]) {
    assert.equal(original.match(expensive)?.length, 2);
    assert.equal(specialized.match(expensive)?.length, 1);
  }
  for (const retained of [
    'rand( 5 ) < float( lights.count ) / lightsDenom',
    'randomLightSample( lights.tex, lights.count, rayOrigin, rand3( 6 ) )',
    'sampleEquirectProbability( rand2( 7 ), envColor, envDirection )',
    'lightRec.direction = invEnvRotation3x3 * envDirection;',
    'lightRec.emission = environmentIntensity * envColor;',
    'lightRec.dist = INFINITY;',
    'float lightPdf = lightRec.pdf / lightsDenom;',
    'misHeuristic( lightPdf, lightMaterialPdf )',
    'isDirectionValid( lightRec.direction, surf.normal, surf.faceNormal )',
    'dot( surf.faceNormal, lightRec.direction ) < 0.0',
    'result = attenuatedColor * lightRec.emission * state.throughputColor * sampleColor * misWeight / lightPdf;',
  ])
    assert.ok(specialized.includes(retained), `Shared lighting retains ${retained}`);
  assert.equal(
    specialized.match(/^\s*return\b/gm)?.length,
    1,
    'The driver workaround keeps one return.',
  );
  assert.throws(
    () =>
      specializeModelRenderShader(
        material.fragmentShader.replace('envPdf /= lightsDenom;', 'envPdf = 0.0;'),
      ),
    /pinned path tracing shader/,
    'Changed source PDF semantics cannot be silently specialized.',
  );
  material.dispose();
});

test('rectangular studio specialization preserves its sampling and intersection equations', () => {
  const material = new PhysicalPathTracingMaterial();
  const original = material.fragmentShader;
  const specialized = specializeModelRenderShader(original);
  for (const unused of [
    'getSpotAttenuation(',
    'getDistanceAttenuation(',
    'getPhotometricAttenuation(',
    'randomSpotLightSample(',
    'intersectsCircle(',
    'iesProfiles',
    'CIRC_AREA_LIGHT_TYPE',
    'SPOT_LIGHT_TYPE',
    'DIR_LIGHT_TYPE',
    'POINT_LIGHT_TYPE',
  ])
    assert.equal(specialized.includes(unused), false, `${unused} is outside the owned light set.`);
  const area = (shader: string) =>
    shader.slice(
      shader.indexOf('LightRecord randomAreaLightSample('),
      shader.indexOf('LightRecord randomLightSample('),
    );
  const expression = (shader: string, assignment: string) => {
    const start = shader.indexOf(assignment);
    assert.ok(start >= 0, `${assignment} exists in the pinned light shader.`);
    return shader.slice(start + assignment.length, shader.indexOf(';', start)).trim();
  };
  for (const assignment of [
    'randomPos =',
    'toLight =',
    'lightDistSq =',
    'dist =',
    'direction =',
    'lightNormal =',
    'lightRec.emission =',
    'lightRec.pdf =',
  ])
    assert.equal(expression(area(specialized), assignment), expression(area(original), assignment));
  for (const retained of [
    'uint l = uint( ruv.x * float( lightCount ) );',
    'return randomAreaLightSample( light, rayOrigin, ruv.yz );',
    'dot( normal, rayDirection ) > 0.0',
    'intersectsRectangle( light.position, normal, u, v, rayOrigin, rayDirection, dist )',
    'lightRec.pdf = ( dist * dist ) / ( light.area * cosTheta );',
    'l.position = s0.rgb;',
    'l.color = s1.rgb;',
    'l.intensity = s1.a;',
    'l.u = s2.rgb;',
    'l.v = s3.rgb;',
    'l.area = s3.a;',
  ])
    assert.ok(specialized.includes(retained), `Rectangle specialization retains ${retained}`);
  assert.throws(
    () =>
      specializeModelRenderShader(
        original.replace('l.type = int( round( s0.a ) );', 'l.type = 99;'),
      ),
    /pinned path tracing shader/,
  );
  material.dispose();
});

test('GPU traversal stack covers the actual pending nodes of every generated BVH tree', () => {
  const geometry = new THREE.BoxGeometry(8, 4, 2, 16, 8, 4);
  const bvh = new MeshBVH(geometry, { maxLeafSize: 1, indirect: false });
  const originalIndex = geometry.index!.array.slice();
  const depth = modelRenderBvhStackDepth(bvh);
  const roots = getBVHExtremes(bvh);
  assert.ok(roots.length > 1, 'Grouped geometry exercises every GPU tree, not only the first.');
  assert.ok(depth < 60, 'An ordinary scene avoids the default oversized shader array.');
  for (let root = 0; root < roots.length; root++) {
    type Node = { children: Node[] };
    const ancestry: Node[] = [];
    let first: Node | undefined;
    bvh.traverse((level, leaf) => {
      const node: Node = { children: [] };
      if (level) ancestry[level - 1].children.push(node);
      else first = node;
      ancestry[level] = node;
      if (leaf) assert.equal(node.children.length, 0);
    }, root);
    for (const reverse of [false, true]) {
      const pending = [first!];
      while (pending.length) {
        assert.ok(pending.length < depth, 'All deferred siblings fit with a spare entry.');
        const node = pending.pop()!;
        pending.push(...(reverse ? [...node.children].reverse() : node.children));
      }
    }
  }
  assert.deepEqual(
    geometry.index!.array,
    originalIndex,
    'Stack inspection cannot rewrite geometry.',
  );
  geometry.dispose();
});

test('GPU traversal bounds reject invalid depth or unrepresentable leaf data', () => {
  for (const [depth, count] of [
    [-1, 1],
    [NaN, 1],
    [0, 0x10000],
  ]) {
    const invalid = {
      _roots: [{}],
      traverse(
        callback: (
          depth: number,
          leaf: boolean,
          bounds: number[],
          offset: number,
          count: number,
        ) => void,
      ) {
        callback(depth, true, [0, 0, 0, 1, 1, 1], 0, count);
      },
    } as unknown as MeshBVH;
    assert.throws(() => modelRenderBvhStackDepth(invalid), /GPU traversal bounds/);
  }
});

function fixture() {
  const target = new THREE.WebGLRenderTarget(5, 7);
  const state = {
    toneMapping: THREE.NoToneMapping as THREE.ToneMapping,
    toneMappingExposure: 0.7,
    outputColorSpace: THREE.LinearSRGBColorSpace,
    autoClear: true,
    shadowMap: { enabled: true },
    xr: { enabled: true },
    clearColor: new THREE.Color('#123456'),
    clearAlpha: 0.3,
    target: target as THREE.WebGLRenderTarget | null,
    viewport: new THREE.Vector4(2, 3, 5, 7),
    scissor: new THREE.Vector4(1, 2, 3, 4),
    scissorTest: true,
    drawing: new THREE.Vector2(800, 600),
    css: new THREE.Vector2(800, 600),
    previews: [] as THREE.Scene[],
    getClearColor(value: THREE.Color) {
      return value.copy(this.clearColor);
    },
    getClearAlpha() {
      return this.clearAlpha;
    },
    setClearColor(color: THREE.Color, alpha = 1) {
      this.clearColor.copy(color);
      this.clearAlpha = alpha;
    },
    getRenderTarget() {
      return this.target;
    },
    getActiveCubeFace() {
      return 2;
    },
    getActiveMipmapLevel() {
      return 3;
    },
    setRenderTarget(value: THREE.WebGLRenderTarget | null) {
      this.target = value;
    },
    getViewport(value: THREE.Vector4) {
      return value.copy(this.viewport);
    },
    setViewport(value: THREE.Vector4) {
      this.viewport.copy(value);
    },
    getScissor(value: THREE.Vector4) {
      return value.copy(this.scissor);
    },
    setScissor(value: THREE.Vector4) {
      this.scissor.copy(value);
    },
    getScissorTest() {
      return this.scissorTest;
    },
    setScissorTest(value: boolean) {
      this.scissorTest = value;
    },
    getDrawingBufferSize(value: THREE.Vector2) {
      return value.copy(this.drawing);
    },
    getSize(value: THREE.Vector2) {
      return value.copy(this.css);
    },
    render(scene: THREE.Scene) {
      this.previews.push(scene);
    },
  };
  const original = new THREE.Scene(),
    content = new THREE.Group(),
    physical = new THREE.Scene();
  original.add(content);
  let changed = true,
    compiling = false,
    samples = 0;
  const calls = {
    scenes: 0,
    cameras: [] as THREE.Camera[],
    updates: 0,
    sizes: [] as number[][],
    resets: 0,
    samples: 0,
    presents: 0,
    disposed: 0,
    sceneDisposed: 0,
    sync: 0,
  };
  const backend: ModelPathTracingBackend = {
    get samples() {
      return samples;
    },
    get compiling() {
      return compiling;
    },
    setScene(scene, camera) {
      assert.equal(scene, physical);
      calls.scenes++;
      calls.cameras.push(camera);
      samples = 0;
    },
    updateCamera(camera) {
      calls.updates++;
      calls.cameras.push(camera);
      samples = 0;
    },
    resize(width, height) {
      calls.sizes.push([width, height]);
      samples = 0;
    },
    reset() {
      calls.resets++;
      samples = 0;
    },
    renderSample() {
      calls.samples++;
      if (!compiling) samples += 0.25;
    },
    present() {
      calls.presents++;
    },
    dispose() {
      calls.disposed++;
    },
  };
  const dependencies: ModelStudioRendererDependencies = {
    createScene(source) {
      assert.equal(source, content);
      return {
        scene: physical,
        sync() {
          calls.sync++;
          const result = changed;
          changed = false;
          return result;
        },
        dispose() {
          calls.sceneDisposed++;
        },
      };
    },
    createBackend() {
      return backend;
    },
  };
  const studio = createModelStudioRenderer(
    state as unknown as THREE.WebGLRenderer,
    original,
    content,
    [],
    dependencies,
  );
  const camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 1000);
  camera.position.set(50, -60, 70);
  camera.lookAt(0, 0, 0);
  const options = {
    dark: false,
    bounds: new THREE.Box3(new THREE.Vector3(-20, -20, -3), new THREE.Vector3(20, 20, 15)),
  };
  return {
    studio,
    state,
    target,
    original,
    physical,
    calls,
    backend,
    dependencies,
    camera,
    options,
    setChanged() {
      changed = true;
    },
    setCompiling(value: boolean) {
      compiling = value;
    },
  };
}

test('render frame advances multiple cheap tiles but bounds queued GPU work', () => {
  let samples = 0,
    calls = 0;
  const backend = {
    get samples() {
      return samples;
    },
    compiling: false,
    renderSample() {
      calls++;
      samples += 1 / 9;
    },
  };
  advanceModelRenderFrame(backend, () => 0);
  assert.equal(calls, 3, 'Cheap tile submission must still yield before a full nine-tile sample.');
  assert.equal(samples, 1 / 3);
});

test('adaptive frame budgets accelerate tracing without changing its exact convergence work', () => {
  let tiles = 0,
    frames = 0;
  const batches: number[] = [];
  const backend = {
    get samples() {
      return tiles / 9;
    },
    compiling: false,
    beginFrame() {
      return 27;
    },
    endFrame(submitted: number) {
      batches.push(submitted);
    },
    renderSample() {
      tiles++;
    },
  };
  while (backend.samples < MODEL_RENDER_SAMPLES) {
    advanceModelRenderFrame(backend, () => 0);
    frames++;
  }
  assert.equal(tiles, MODEL_RENDER_SAMPLES * 9);
  assert.equal(frames, Math.ceil(tiles / 27));
  assert.ok(batches.every((batch) => batch <= 27));
  assert.equal(batches.at(-1), 9, 'The final batch stops at the exact final sample.');
  backend.beginFrame = () => 0;
  advanceModelRenderFrame(backend, () => 0);
  assert.equal(batches.at(-1), 0);
  assert.equal(tiles, MODEL_RENDER_SAMPLES * 9);
});

test('render frame yields at its submission deadline and stops exactly at convergence', () => {
  let samples = 0,
    calls = 0,
    elapsed = 0;
  const backend = {
    get samples() {
      return samples;
    },
    compiling: false,
    renderSample() {
      calls++;
      samples += 0.25;
      elapsed += 4;
    },
  };
  advanceModelRenderFrame(backend, () => elapsed);
  assert.equal(calls, 2, 'Submission yields after 8 ms even with a tile remaining in the batch.');
  samples = MODEL_RENDER_SAMPLES - 0.25;
  calls = 0;
  advanceModelRenderFrame(backend, () => elapsed);
  assert.equal(calls, 1);
  assert.equal(samples, MODEL_RENDER_SAMPLES);
  advanceModelRenderFrame(backend, () => elapsed);
  assert.equal(calls, 1, 'A completed image is presented without additional tracing.');
});

test('render frame starts preparation once and yields when the backend cannot advance', () => {
  for (const compiling of [false, true]) {
    let calls = 0;
    advanceModelRenderFrame(
      {
        samples: 0,
        compiling,
        renderSample() {
          calls++;
        },
      },
      () => 0,
    );
    assert.equal(calls, 1, 'Compilation or deferred work must not spin within the frame.');
  }
});

test('path tracing progresses in bounded batches, stops at convergence and re-presents without new samples', () => {
  const f = fixture(),
    originalCamera = f.camera.toJSON();
  f.setCompiling(true);
  assert.deepEqual(f.studio.render(f.camera, f.options), { samples: 0, complete: false });
  f.setCompiling(false);
  assert.deepEqual(f.studio.render(f.camera, f.options), { samples: 0.75, complete: false });
  for (let i = 1; i < MODEL_RENDER_SAMPLES * 4; i++) f.studio.render(f.camera, f.options);
  assert.equal(f.studio.samples, MODEL_RENDER_SAMPLES);
  const before = f.calls.samples;
  assert.deepEqual(f.studio.render(f.camera, f.options), {
    samples: MODEL_RENDER_SAMPLES,
    complete: true,
  });
  assert.equal(f.calls.samples, before);
  assert.equal(f.calls.scenes, 1, 'Accumulation cannot rebuild BVH geometry.');
  assert.equal(f.calls.sync, 1);
  assert.equal(f.calls.updates, 0);
  assert.notEqual(f.calls.cameras[0], f.camera, 'The tracer owns an independent camera.');
  assert.deepEqual(f.camera.toJSON(), originalCamera);
  assert.equal(f.original.children.length, 1);
  f.studio.dispose();
  f.studio.dispose();
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.sceneDisposed, 1);
  f.target.dispose();
});

test('GPU backpressure retains cached presentation and finalizes its fence after the draw', () => {
  const f = fixture();
  f.studio.render(f.camera, f.options);
  f.studio.render(f.camera, f.options);
  const beforeSamples = f.calls.samples;
  const order: string[] = [];
  const present = f.backend.present;
  f.backend.beginFrame = () => 0;
  f.backend.endFrame = (tiles) => {
    assert.equal(tiles, 0);
    order.push('submitted');
  };
  f.backend.present = (...args) => {
    order.push('present');
    present(...args);
  };
  f.backend.finishFrame = () => {
    order.push('fence');
  };
  f.studio.render(f.camera, f.options);
  assert.deepEqual(order, ['submitted', 'present', 'fence']);
  assert.equal(f.calls.samples, beforeSamples);
  f.studio.dispose();
  f.target.dispose();
});

test('accumulation continuations retain the raster image during compilation but explicit updates repaint', () => {
  const f = fixture();
  f.setCompiling(true);
  const continuation = { ...f.options, continuation: true };
  for (let index = 0; index < 30; index++) f.studio.render(f.camera, continuation);
  assert.equal(
    f.state.previews.length,
    1,
    'Waiting for the shader never redraws the same physical scene.',
  );
  f.studio.render(f.camera, f.options);
  assert.equal(
    f.state.previews.length,
    2,
    'An explicit view update repaints even without a new sample.',
  );
  f.camera.position.x += 1;
  f.studio.render(f.camera, continuation);
  f.state.drawing.set(1200, 900);
  f.studio.render(f.camera, continuation);
  f.setChanged();
  f.studio.invalidate();
  f.studio.render(f.camera, continuation);
  assert.equal(
    f.state.previews.length,
    5,
    'Camera, resize and physical-scene changes invalidate retained presentation.',
  );
  assert.equal(f.studio.samples, 0);
  f.studio.dispose();
  f.target.dispose();
});

test('backpressure and partial-sample continuations avoid duplicate copies while selection and capture repaint', () => {
  const f = fixture();
  const continuation = { ...f.options, continuation: true };
  f.studio.render(f.camera, continuation);
  f.studio.render(f.camera, continuation);
  const presents = f.calls.presents;
  f.backend.beginFrame = () => 1;
  let submitted = -1;
  f.backend.endFrame = (count) => {
    submitted = count;
  };
  f.studio.render(f.camera, continuation);
  assert.equal(submitted, 1);
  assert.equal(f.calls.presents, presents, 'Another partial tile keeps the same denoised image.');
  f.studio.render(f.camera, continuation);
  assert.equal(f.calls.presents, presents + 1, 'A completed sample presents once.');
  f.backend.beginFrame = () => 0;
  for (let index = 0; index < 30; index++) f.studio.render(f.camera, continuation);
  assert.equal(
    f.calls.presents,
    presents + 1,
    'A busy GPU receives no duplicate presentation commands.',
  );
  const selected = [new THREE.Object3D()];
  f.studio.render(f.camera, { ...continuation, selected });
  selected[0] = new THREE.Object3D();
  f.studio.render(f.camera, { ...continuation, selected });
  assert.equal(
    f.calls.presents,
    presents + 3,
    'Selection snapshots remain independent of caller arrays.',
  );
  f.studio.render(f.camera, { ...f.options, selected });
  assert.equal(
    f.calls.presents,
    presents + 4,
    'Explicit drawing/capture redraws the current canvas.',
  );
  const present = f.backend.present;
  f.backend.present = () => {
    throw Error('Presentation failed');
  };
  assert.throws(() => f.studio.render(f.camera, f.options), /Presentation failed/);
  f.backend.present = present;
  f.studio.render(f.camera, continuation);
  assert.equal(
    f.calls.presents,
    presents + 5,
    'A failed draw cannot leave a reusable presentation.',
  );
  f.studio.dispose();
  f.target.dispose();
});

test('movement and physical scene changes reset samples without needless geometry uploads', () => {
  const f = fixture();
  f.studio.render(f.camera, f.options);
  f.studio.invalidate();
  f.studio.render(f.camera, f.options);
  assert.equal(f.calls.scenes, 1, 'Invalidation checks for real physical changes.');
  const previewsBeforeMotion = f.state.previews.length;
  f.camera.position.x += 1;
  f.studio.render(f.camera, { ...f.options, moving: true });
  assert.equal(f.studio.samples, 0);
  assert.equal(f.state.previews.at(-1), f.physical);
  assert.equal(f.calls.scenes, 1);
  for (let index = 0; index < 24; index++) {
    f.camera.position.x += 1;
    f.studio.render(f.camera, { ...f.options, moving: true });
  }
  assert.equal(f.calls.resets, 1, 'Continuous motion clears accumulation targets only once.');
  assert.equal(
    f.state.previews.length - previewsBeforeMotion,
    25,
    'Every moving pose still redraws the current preview.',
  );
  f.studio.render(f.camera, f.options);
  assert.equal(f.calls.updates, 1);
  assert.equal(f.studio.samples, 0.75);
  f.setChanged();
  f.studio.invalidate();
  f.studio.render(f.camera, f.options);
  assert.equal(f.calls.scenes, 2);
  assert.equal(f.studio.samples, 0.75);
  f.studio.dispose();
  f.target.dispose();
});

test('path tracing bounds working resolution and restarts accumulation after resize', () => {
  const f = fixture();
  f.state.drawing.set(7680, 4320);
  f.state.css.set(1920, 1080);
  f.studio.render(f.camera, f.options);
  assert.deepEqual(f.calls.sizes.at(-1), [MODEL_RENDER_MAX_DIMENSION * 0.75, 1080]);
  f.state.drawing.set(1000, 800);
  f.state.css.set(1000, 800);
  f.studio.render(f.camera, f.options);
  assert.deepEqual(f.calls.sizes.at(-1), [750, 600]);
  assert.deepEqual(f.state.drawing.toArray(), [1000, 800], 'The output canvas keeps its size.');
  assert.equal(f.studio.samples, 0.75);
  f.studio.dispose();
  f.target.dispose();
});

test('failed GPU samples restore renderer state and leave source camera/scene retryable', () => {
  const f = fixture(),
    camera = f.camera.toJSON(),
    sample = f.backend.renderSample;
  f.backend.renderSample = () => {
    f.state.autoClear = false;
    f.state.xr.enabled = false;
    f.state.target = null;
    f.state.viewport.set(0, 0, 999, 999);
    f.state.scissor.set(0, 0, 999, 999);
    f.state.clearColor.set('#ffffff');
    f.state.clearAlpha = 1;
    throw new Error('GPU sample failed');
  };
  assert.throws(() => f.studio.render(f.camera, f.options), /GPU sample failed/);
  assert.equal(f.state.target, f.target);
  assert.equal(f.state.autoClear, true);
  assert.equal(f.state.xr.enabled, true);
  assert.equal(f.state.shadowMap.enabled, true);
  assert.equal(f.state.toneMapping, THREE.NoToneMapping);
  assert.equal(f.state.toneMappingExposure, 0.7);
  assert.equal(f.state.outputColorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(f.state.clearColor.getHexString(), '123456');
  assert.equal(f.state.clearAlpha, 0.3);
  assert.deepEqual(f.state.viewport.toArray(), [2, 3, 5, 7]);
  assert.deepEqual(f.state.scissor.toArray(), [1, 2, 3, 4]);
  assert.equal(f.state.scissorTest, true);
  assert.deepEqual(f.camera.toJSON(), camera);
  assert.equal(f.original.children.length, 1);
  f.backend.renderSample = sample;
  assert.deepEqual(f.studio.render(f.camera, f.options), { samples: 0.75, complete: false });
  f.studio.dispose();
  assert.throws(() => f.studio.render(f.camera, f.options), /disposed/);
  f.target.dispose();
});

test('subnanometre drift preserves samples and projection changes update only the render camera', () => {
  const f = fixture();
  f.studio.render(f.camera, f.options);
  f.camera.position.x += 1e-13;
  f.studio.render(f.camera, f.options);
  assert.equal(f.calls.updates, 0);
  assert.equal(f.studio.samples, 1.5);
  const orthographic = new THREE.OrthographicCamera(-30, 30, 20, -20, 0.1, 1000);
  orthographic.position.copy(f.camera.position);
  orthographic.quaternion.copy(f.camera.quaternion);
  f.studio.render(orthographic, f.options);
  assert.equal(
    f.calls.scenes,
    1,
    'Projection changes retain uploaded geometry, textures and lights.',
  );
  assert.equal(f.calls.updates, 1);
  assert.ok(f.calls.cameras.at(-1) instanceof THREE.OrthographicCamera);
  assert.notEqual(f.calls.cameras.at(-1), orthographic);
  f.studio.render(f.camera, { ...f.options, moving: true });
  f.studio.render(orthographic, { ...f.options, moving: true });
  f.studio.render(orthographic, f.options);
  assert.equal(
    f.calls.scenes,
    1,
    'A projection change during motion also retains the physical scene.',
  );
  assert.equal(f.calls.updates, 2);
  assert.equal(f.studio.samples, 0.75, 'The new camera starts a fresh accumulation.');
  f.studio.dispose();
  f.target.dispose();
});

test('GPU initialization failure restores shared state and can retry without replacing the native scene', () => {
  const f = fixture();
  const create = f.dependencies.createBackend;
  f.dependencies.createBackend = () => {
    f.state.target = null;
    f.state.autoClear = false;
    f.state.clearAlpha = 1;
    f.state.viewport.set(0, 0, 1, 1);
    throw new Error('GPU initialization failed');
  };
  assert.throws(() => f.studio.render(f.camera, f.options), /GPU initialization failed/);
  assert.equal(f.state.target, f.target);
  assert.equal(f.state.autoClear, true);
  assert.equal(f.state.clearAlpha, 0.3);
  assert.deepEqual(f.state.viewport.toArray(), [2, 3, 5, 7]);
  assert.equal(f.original.children.length, 1);
  f.dependencies.createBackend = create;
  assert.deepEqual(f.studio.render(f.camera, f.options), { samples: 0.75, complete: false });
  assert.equal(f.calls.scenes, 1);
  f.studio.dispose();
  f.target.dispose();
});

test('responsive preview restores shared optical materials after successful and failed raster draws', () => {
  const source = new THREE.MeshPhysicalMaterial({
    transmission: 0.78,
    roughness: 0.2,
    opacity: 0.9,
  });
  const sourceVersion = source.version;
  const owned = source.clone();
  const opaque = new THREE.MeshStandardMaterial();
  const hidden = source.clone();
  const geometry = new THREE.BoxGeometry();
  const scene = new THREE.Scene();
  const hiddenGroup = new THREE.Group();
  hiddenGroup.visible = false;
  hiddenGroup.add(new THREE.Mesh(geometry, hidden));
  scene.add(
    new THREE.Mesh(geometry, [owned, opaque]),
    new THREE.Mesh(geometry, owned),
    hiddenGroup,
  );
  for (const fail of [false, true]) {
    const renderer = {
      render(current: THREE.Scene) {
        assert.equal(current, scene);
        assert.equal(owned.transmission, 0, 'No per-Scene raster transmission target is needed.');
        assert.equal(owned.opacity, 0.9);
        assert.equal(hidden.transmission, 0.78);
        assert.equal(source.transmission, 0.78);
        if (fail) throw new Error('Preview draw failed');
      },
    } as unknown as THREE.WebGLRenderer;
    const render = () => renderModelRasterPreview(renderer, scene, new THREE.PerspectiveCamera());
    if (fail) assert.throws(render, /Preview draw failed/);
    else render();
    assert.equal(
      owned.transmission,
      0.78,
      'Every shared material restores its original optical value.',
    );
    assert.equal(source.transmission, 0.78);
    assert.equal(source.version, sourceVersion, 'Source materials are never touched.');
  }
  geometry.dispose();
  source.dispose();
  owned.dispose();
  opaque.dispose();
  hidden.dispose();
});
