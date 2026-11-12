// Opt-in main-thread geometry timing for connected footprint drag.
// Does not launch Electron. Painted frames stay in benchmark-editor-experience.mjs.
// node --import tsx scripts/benchmark-footprint-drag.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { projectFromNativeFiles } from '../lib/kicad-project.ts';
import { ownProjectData } from '../lib/immutable-project.ts';
import { createPCBInteractiveDrag } from '../lib/pcb-interactive-drag.ts';
import { previewConstrainedPCBTrackDrag } from '../lib/pcb-track-drag.ts';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const target = process.env.OPENPE_EXPERIENCE_TARGET_MS;
assert.ok(target === undefined || (Number(target) > 0 && Number.isFinite(Number(target))), 'OPENPE_EXPERIENCE_TARGET_MS must be a positive finite number when set.');

const boards = [
  ['emc-flyback', 'examples/project/emc-flyback/emc-flyback.kicad_pro'],
  ['lmr12010', 'examples/lmr12010-sot236-buck/lmr12010-sot236-buck.kicad_pro'],
];

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

async function measure(label, file) {
  const board = ownProjectData((await projectFromNativeFiles(await readNativeProject(file))).pcb);
  assert.ok(board, `${label} has a PCB.`);
  const candidates = board.footprints.filter(
    (footprint) =>
      !footprint.locked &&
      !footprint.graphics.some(
        (graphic) => graphic.layer.endsWith('.Cu') || graphic.layer === 'Edge.Cuts',
      ) &&
      !footprint.zones?.some((zone) => zone.keepout),
  );
  assert.ok(candidates.length, `${label} has a draggable footprint.`);
  let slowest = candidates[0];
  let slowestMs = -1;
  for (const footprint of candidates) {
    const engine = createPCBInteractiveDrag(board, [{ kind: 'footprint', id: footprint.id }], {
      clearance: 0.25,
    });
    engine.preview({ x: 0.2, y: 0 });
    const started = performance.now();
    engine.preview({ x: 0.8, y: 0.2 });
    const elapsed = performance.now() - started;
    if (elapsed > slowestMs) {
      slowest = footprint;
      slowestMs = elapsed;
    }
  }
  const engine = createPCBInteractiveDrag(board, [{ kind: 'footprint', id: slowest.id }], {
    clearance: 0.25,
  });
  const coldStarted = performance.now();
  const cold = engine.preview({ x: 0.5, y: 0 });
  const coldMs = performance.now() - coldStarted;
  const warm = [];
  for (let step = 1; step <= 20; step += 1) {
    const started = performance.now();
    const preview = engine.preview({ x: 0.35 + step * 0.03, y: 0.02 });
    warm.push(performance.now() - started);
    assert.equal(typeof preview.error, 'string');
  }
  const blockedStarted = performance.now();
  const blocked = previewConstrainedPCBTrackDrag(engine, board, { x: 8, y: 8 }, false, {
    x: 0.5,
    y: 0,
  });
  const blockedMs = performance.now() - blockedStarted;
  assert.ok(blocked.error === '' || blocked.board === board);
  const report = {
    label,
    reference: slowest.reference ?? slowest.id,
    counts: {
      footprints: board.footprints.length,
      pads: board.footprints.reduce((count, footprint) => count + footprint.pads.length, 0),
      tracks: board.tracks.length,
    },
    coldPreviewMs: Number(coldMs.toFixed(3)),
    warmPreviewP50Ms: Number(percentile(warm, 0.5).toFixed(3)),
    warmPreviewMaxMs: Number(Math.max(...warm).toFixed(3)),
    blockedBoundaryMs: Number(blockedMs.toFixed(3)),
    blocked: blocked.error || blocked.constraint?.reason || 'clear',
  };
  if (target !== undefined) {
    const limit = Number(target);
    assert.ok(report.warmPreviewP50Ms < limit, `${label} warm preview p50 is ${report.warmPreviewP50Ms} ms.`);
    assert.ok(report.blockedBoundaryMs < limit, `${label} blocked boundary is ${report.blockedBoundaryMs} ms.`);
  }
  return report;
}

const reports = [];
for (const [label, file] of boards) reports.push(await measure(label, file));
console.log(JSON.stringify({ targetMs: target ?? null, reports }, null, 2));
