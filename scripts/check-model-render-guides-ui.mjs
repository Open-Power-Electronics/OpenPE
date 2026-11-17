import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated GPU functional coverage using synthetic radiance, not a path-tracing
// quality benchmark or evidence of native CAD/model parsing or optical accuracy.
const bundle = await build({
  stdin: {
    contents: `
import * as THREE from 'three';
import { createModelRenderGuides } from './components/model-render-guides';
import { createModelRenderDenoiser } from './components/model-render-denoise';

window.runGuideCheck = () => {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(2);
  renderer.setSize(256, 128);
  document.body.appendChild(renderer.domElement);
  const gl = renderer.getContext(), live = {};
  for (const kind of ['Texture', 'Framebuffer', 'Renderbuffer', 'Buffer', 'VertexArray', 'Program', 'Shader']) {
    const active = live[kind] = new Set();
    const create = gl['create' + kind].bind(gl), remove = gl['delete' + kind].bind(gl);
    gl['create' + kind] = (...args) => { const value = create(...args); if (value) active.add(value); return value; };
    gl['delete' + kind] = value => { active.delete(value); return remove(value); };
  }
  const width = 256, height = 128;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, .1, 10);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const paintPixels = new Uint8Array(width * height * 4);
  const sourcePixels = new Float32Array(width * height * 4);
  let seed = 0x4f50454e;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4, stripe = x >= 190 && x < 194;
    const paint = stripe ? 255 : 64;
    paintPixels.set([paint, paint, paint, 255], index);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296 * 2 - 1) * .04;
    const value = (x < 128 ? .25 : stripe ? 1.2 : .08) + noise;
    sourcePixels.set([value, value, value, 1], index);
  }
  const originalPixels = sourcePixels.slice();
  const paint = new THREE.DataTexture(paintPixels, width, height);
  paint.colorSpace = THREE.LinearSRGBColorSpace;
  paint.needsUpdate = true;
  const cutoutPixels = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
    cutoutPixels.set([204, 13, 5, x >= 1 && x <= 2 && y >= 1 && y <= 2 ? 0 : 255], (y * 4 + x) * 4);
  const cutout = new THREE.DataTexture(cutoutPixels, 4, 4);
  cutout.colorSpace = THREE.LinearSRGBColorSpace;
  cutout.needsUpdate = true;
  const baseMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: paint });
  const cutoutMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: cutout, alphaTest: .5 });
  const coverMaterial = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(.7, .8, .9), opacity: .4, transparent: true, transmission: .25 });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), baseMaterial);
  const mask = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), cutoutMaterial);
  mask.position.set(-1, 0, .5);
  const cover = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), coverMaterial);
  cover.position.set(1, 0, .5);
  scene.add(base, mask, cover);
  const guides = createModelRenderGuides(renderer);
  const denoiser = createModelRenderDenoiser(renderer);
  const source = new THREE.DataTexture(sourcePixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  source.needsUpdate = true;
  const output = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
  const read = (texture, x, y) => {
    const target = texture.renderTarget;
    const index = target.textures.indexOf(texture);
    const values = texture.type === THREE.HalfFloatType ? new Uint16Array(4) : new Float32Array(4);
    renderer.readRenderTargetPixels(target, x, y, 1, 1, values, 0, index);
    return Array.from(values, value => texture.type === THREE.HalfFloatType ? THREE.DataUtils.fromHalfFloat(value) : value);
  };
  let report;
  try {
    const guide = guides.render(scene, camera, width, height);
    const solid = { normalDepth: read(guide.normalDepth, 32, 32), albedo: read(guide.albedo, 32, 32) };
    const hole = { normalDepth: read(guide.normalDepth, 64, 64), albedo: read(guide.albedo, 64, 64) };
    const optical = { normalDepth: read(guide.normalDepth, 191, 64), albedo: read(guide.albedo, 191, 64) };
    const opticalNeighbour = read(guide.albedo, 180, 64);
    denoiser.render(source, output, scene, camera, 64);
    const filtered = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(output, 0, 0, width, height, filtered);
    const stats = (pixels, left, right, bottom, top) => {
      let count = 0, sum = 0, squares = 0;
      for (let y = bottom; y < top; y++) for (let x = left; x < right; x++) {
        const value = pixels[(y * width + x) * 4];
        count++; sum += value; squares += value * value;
      }
      return { mean: sum / count, variance: squares / count - (sum / count) ** 2 };
    };
    report = {
      evidence: 'Synthetic noisy radiance filtered on real WebGL; no path tracing or optical equivalence claim.',
      solid, hole, optical, opticalNeighbour,
      inputFlat: stats(sourcePixels, 26, 42, 40, 88),
      outputFlat: stats(filtered, 26, 42, 40, 88),
      inputMark: stats(sourcePixels, 190, 194, 40, 88),
      outputMark: stats(filtered, 190, 194, 40, 88),
      outputBesideMark: stats(filtered, 180, 184, 40, 88),
      sourceUnchanged: sourcePixels.every((value, index) => value === originalPixels[index]),
      materialsRestored: base.material === baseMaterial && mask.material === cutoutMaterial && cover.material === coverMaterial,
      finiteOutput: filtered.every(Number.isFinite),
      opaqueOutput: filtered.every((value, index) => index % 4 !== 3 || Math.abs(value - 1) < 1e-6),
    };
  } finally {
    guides.dispose(); denoiser.dispose(); output.dispose(); source.dispose();
    for (const object of [base, mask, cover]) { object.geometry.dispose(); object.material.dispose(); }
    paint.dispose(); cutout.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
  report.liveResources = Object.fromEntries(Object.entries(live).map(([name, values]) => [name, values.size]));
  return report;
};`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setContent('<!doctype html><title>OpenPE guide regression</title><body></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const report = await page.evaluate(() => window.runGuideCheck());
  await mkdir('test-results/model-render-guides-ui', { recursive: true });
  await writeFile(
    'test-results/model-render-guides-ui/summary.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  const close = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 0.002, `${message}: ${actual} versus ${expected}`);
  close(report.solid.normalDepth[2], 1, 'Front normal points toward the camera');
  close(report.solid.normalDepth[3], (4.5 - 0.1) / 9.9, 'Opaque cutout paint retains front depth');
  close(report.solid.albedo[0], 204 / 255, 'Mapped colour is linear, without tone mapping');
  close(
    report.hole.normalDepth[3],
    (5 - 0.1) / 9.9,
    'Alpha-test aperture reveals actual rear geometry',
  );
  close(report.hole.albedo[0], 64 / 255, 'Aperture reveals rear albedo, not a solid rectangle');
  close(report.optical.albedo[3], 0.6, 'Optical strength retains authored alpha/transmission');
  close(
    report.optical.normalDepth[3],
    (4.5 - 0.1) / 9.9,
    'Optical guide describes the nearest surface',
  );
  assert.deepEqual(
    report.optical.albedo,
    report.opticalNeighbour,
    'Raster guides intentionally cannot describe the high-contrast mark behind the cover.',
  );
  assert.ok(
    report.outputFlat.variance < report.inputFlat.variance * 0.15,
    'Guided reconstruction suppresses synthetic flat-surface variance.',
  );
  assert.ok(
    Math.abs(report.outputFlat.mean - report.inputFlat.mean) < 0.01,
    'Denoising retains mean linear radiance.',
  );
  assert.ok(
    report.outputMark.mean > 1.1,
    'The four-pixel mark retains its HDR brightness through the optical guard.',
  );
  assert.ok(
    report.outputBesideMark.mean < 0.12,
    'The optical guard prevents bright-mark bleeding.',
  );
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.materialsRestored, true);
  assert.equal(report.finiteOutput, true);
  assert.equal(report.opaqueOutput, true);
  for (const [kind, count] of Object.entries(report.liveResources))
    assert.equal(count, 0, `All test-owned ${kind} objects are released.`);
  assert.deepEqual(errors, [], 'Guide and filter shaders produce no browser errors.');
  console.log(
    'Model render guide GPU check passed: cutouts, first-surface optics, synthetic denoising, narrow marks and complete resource release.',
  );
} finally {
  await browser.close();
}
