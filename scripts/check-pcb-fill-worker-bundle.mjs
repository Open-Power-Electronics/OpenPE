import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createEmptyPCB, movePCBSelection } from '../lib/pcb-layout.ts';
import { fillCopperZones } from '../lib/pcb-polygons.ts';
import { uid } from '../lib/circuit.ts';

// Run after npm run build. Exercise the emitted browser worker with local chunk
// loading in an isolated Node worker; no Electron, host service or solver runs.
const chunks = path.resolve('.next/static/chunks');
let bootstrap;
let entries;
for (const name of await readdir(chunks)) {
  if (!name.endsWith('.js')) continue;
  const source = await readFile(path.join(chunks, name), 'utf8');
  if (!source.includes('OpenPE copper preview')) continue;
  const match = source.match(/\.f\("(static\/chunks\/turbopack-worker-[^"]+)",\[(.*?)\]\)/);
  if (match) {
    bootstrap = match[1];
    entries = JSON.parse(`[${match[2]}]`);
    break;
  }
}
assert.ok(bootstrap && entries, 'Production build includes a compiled worker bootstrap.');
const worker = new Worker(
  `
  const { parentPort, workerData } = require('node:worker_threads');
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  globalThis.self = globalThis;
  globalThis.WorkerGlobalScope = class { static [Symbol.hasInstance](value) { return value === globalThis; } };
  const params = [workerData.entries.map((entry) => '/_next/' + entry).reverse(), '', '/_next/'];
  globalThis.location = new URL('http://127.0.0.1/_next/' + workerData.bootstrap + '#params=' + encodeURIComponent(JSON.stringify(params)));
  globalThis.importScripts = (...urls) => {
    for (const url of urls) {
      const parsed = new URL(url, location.href);
      const relative = parsed.pathname.replace(/^\\/_next\\//, '');
      const target = path.resolve(workerData.root, relative);
      if (!target.startsWith(workerData.root + path.sep)) throw new Error('Worker chunk escaped its build.');
      vm.runInThisContext(readFileSync(target, 'utf8'), { filename: target });
    }
  };
  globalThis.postMessage = (message) => parentPort.postMessage(message);
  importScripts(location.href);
  parentPort.on('message', async (data) => {
    for (let attempt = 0; typeof self.onmessage !== 'function' && attempt < 100; attempt++)
      await new Promise(setImmediate);
    if (typeof self.onmessage !== 'function') throw new Error('Compiled worker entry did not start.');
    self.onmessage({ data });
  });
`,
  { eval: true, workerData: { bootstrap, entries, root: path.resolve('.next') } },
);
const board = createEmptyPCB();
board.nets = [
  { id: uid(), name: 'GND' },
  { id: uid(), name: 'Signal' },
];
const corners = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];
board.graphics = corners.map((start, index) => ({
  id: uid(),
  start,
  end: corners[(index + 1) % 4],
  layer: 'Edge.Cuts',
  width: 0.1,
}));
board.zones = [
  {
    id: uid(),
    netId: board.nets[0].id,
    layer: 'F.Cu',
    outline: corners,
    clearance: 0.25,
    minThickness: 0.1,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  },
];
board.tracks = [
  {
    id: uid(),
    netId: board.nets[1].id,
    layer: 'F.Cu',
    start: { x: 4, y: 8 },
    end: { x: 16, y: 8 },
    width: 0.4,
  },
];
const basis = fillCopperZones(board);
const candidate = movePCBSelection(
  basis,
  { kind: 'track', id: board.tracks[0].id },
  { x: 0, y: 3 },
);
let responseTimer;
const response = new Promise((resolve, reject) => {
  responseTimer = setTimeout(
    () => reject(new Error('Compiled copper worker did not reply.')),
    10_000,
  );
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) =>
    reject(new Error(`Compiled copper worker exited before replying (${code}).`)),
  );
});
try {
  worker.postMessage({ type: 'basis', generation: 1, board: basis });
  worker.postMessage({ type: 'fill', generation: 1, requestId: 1, board: candidate });
  const result = await response;
  assert.equal(result.error, undefined);
  assert.equal(result.requestId, 1);
  assert.equal(result.board.tracks[0].start.y, 11);
  assert.ok(result.paths[0][1].length > 0);
  assert.notDeepEqual(result.board.zones[0].filledPolygons, basis.zones[0].filledPolygons);
  process.stdout.write(
    'Compiled production copper worker completed real fill and SVG paths in an isolated worker runtime.\n',
  );
} finally {
  clearTimeout(responseTimer);
  await worker.terminate();
}
