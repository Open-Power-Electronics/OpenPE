import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPCBFillWorkerClient,
  type PCBFillWorkerPort,
  type PCBFillWorkerResult,
} from '../components/pcbFillWorkerClient';
import type {
  PCBFillWorkerRequest,
  PCBFillWorkerResponse,
} from '../components/pcbFillWorkerProtocol';
import { uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { PCB } from '../lib/pcb';

type Fill = Extract<PCBFillWorkerRequest, { type: 'fill' }>;
class WorkerPort implements PCBFillWorkerPort {
  messages: PCBFillWorkerRequest[] = [];
  onmessage: PCBFillWorkerPort['onmessage'] = null;
  onerror: PCBFillWorkerPort['onerror'] = null;
  terminated = 0;
  postMessage(message: PCBFillWorkerRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated++;
  }
  fills() {
    return this.messages.filter((message): message is Fill => message.type === 'fill');
  }
  emit(message: PCBFillWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<PCBFillWorkerResponse>);
  }
  complete(message = this.fills().at(-1)!) {
    this.emit({
      generation: message.generation,
      requestId: message.requestId,
      board: message.board,
      paths: [['zone', `pose ${message.requestId}`]],
    });
  }
}

function pose(basis: PCB, x: number): PCB {
  return {
    ...basis,
    vias: [{ id: 'via', x, y: 0, netId: 'net', diameter: 1, drill: 0.4 }],
  };
}

test('one active worker fill coalesces pending poses and advances continuously during movement', () => {
  const worker = new WorkerPort();
  const results: PCBFillWorkerResult[] = [];
  const client = createPCBFillWorkerClient(worker, (result) => results.push(result));
  const basis = createEmptyPCB();
  const poses = [1, 2, 3, 4, 5].map((x) => pose(basis, x));
  client.submit(basis, poses[0]);
  client.submit(basis, poses[1]);
  client.submit(basis, poses[2]);
  assert.equal(worker.fills().length, 1);
  worker.complete();
  assert.deepEqual(
    results.map((result) => result.candidate),
    [poses[0]],
  );
  assert.equal(worker.fills().length, 2);
  assert.equal(worker.fills()[1].board.vias[0].x, 3);

  client.submit(basis, poses[3]);
  client.submit(basis, poses[4]);
  worker.complete();
  assert.deepEqual(
    results.map((result) => result.candidate),
    [poses[0], poses[2]],
  );
  assert.equal(worker.fills().length, 3);
  assert.equal(worker.fills()[2].board.vias[0].x, 5);
  worker.complete();
  assert.deepEqual(
    results.map((result) => result.candidate),
    [poses[0], poses[2], poses[4]],
  );
  assert.ok(results.every((result) => result.basis === basis));
  assert.equal(worker.messages.filter((message) => message.type === 'basis').length, 1);
  client.dispose();
});

test('basis changes, clear and disposal reject stale generations and out-of-order worker replies', () => {
  const worker = new WorkerPort();
  const results: PCBFillWorkerResult[] = [];
  const client = createPCBFillWorkerClient(worker, (result) => results.push(result));
  const first = createEmptyPCB(),
    second = createEmptyPCB();
  client.submit(first, pose(first, 1));
  const stale = worker.fills()[0];
  const current = pose(second, 2);
  client.submit(second, current);
  worker.emit({
    generation: stale.generation,
    requestId: stale.requestId + 99,
    error: 'unrelated',
  });
  assert.equal(worker.fills().length, 1);
  worker.complete(stale);
  assert.equal(results.length, 0);
  assert.equal(worker.fills().length, 2);
  assert.equal(worker.messages.filter((message) => message.type === 'basis').length, 2);
  worker.complete(stale);
  assert.equal(results.length, 0);
  worker.complete();
  assert.equal(results.length, 1);
  assert.equal(results[0].candidate, current);

  client.submit(second, pose(second, 3));
  const cancelled = worker.fills().at(-1)!;
  client.submit(second, pose(second, 4));
  client.clear();
  worker.complete(cancelled);
  assert.equal(results.length, 1);
  assert.equal(worker.fills().length, 3, 'Clear discards the latest queued pose.');
  const final = pose(second, 5);
  assert.equal(client.submit(second, final), true);
  worker.complete();
  assert.equal(results[1].candidate, final);
  const lateMessage = worker.onmessage;
  const lateJob = worker.fills().at(-1)!;
  client.dispose();
  client.dispose();
  lateMessage?.({
    data: { generation: lateJob.generation, requestId: lateJob.requestId, error: 'late' },
  } as MessageEvent<PCBFillWorkerResponse>);
  assert.equal(results.length, 2);
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(client.submit(second, pose(second, 6)), false);
});

test('calculation errors deliver the right pose and permit retry while fatal worker errors terminate', () => {
  const worker = new WorkerPort();
  const results: PCBFillWorkerResult[] = [];
  const client = createPCBFillWorkerClient(worker, (result) => results.push(result));
  const basis = createEmptyPCB();
  const first = pose(basis, 1),
    latest = pose(basis, 2);
  client.submit(basis, first);
  client.submit(basis, latest);
  const failed = worker.fills()[0];
  worker.emit({
    generation: failed.generation,
    requestId: failed.requestId,
    error: 'Invalid outline.',
  });
  assert.equal(results[0].candidate, first);
  assert.equal(results[0].error, 'Invalid outline.');
  assert.equal(results[0].board, undefined);
  assert.equal(results[0].fatal, undefined);
  assert.equal(worker.fills().length, 2);
  worker.complete();
  assert.equal(results[1].candidate, latest);
  client.submit(basis, first);
  const pending = pose(basis, 3);
  client.submit(basis, pending);
  worker.onerror?.({ message: 'Worker unavailable.' } as ErrorEvent);
  assert.equal(results[2].candidate, pending);
  assert.equal(results[2].fatal, true);
  assert.equal(results[2].error, 'Worker unavailable.');
  assert.equal(worker.terminated, 1);
  assert.equal(client.submit(basis, first), false);
});

test('candidate messages omit board and footprint fills without reading any saved vertices', () => {
  const worker = new WorkerPort();
  const client = createPCBFillWorkerClient(worker, () => {});
  const basis = createEmptyPCB();
  const filledPolygons = new Proxy([], {
    get() {
      throw new Error('A moving pose must not traverse saved copper vertices.');
    },
  });
  const zone = {
    id: uid(),
    netId: null,
    layer: 'F.Cu' as const,
    outline: [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ],
    clearance: 0.3,
    minThickness: 0.1,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    filledPolygons,
  };
  basis.zones = [zone];
  basis.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Zone',
      x: 0,
      y: 0,
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [],
      zones: [{ ...zone, id: uid() }],
    },
  ];
  const candidate = pose(basis, 1);
  assert.equal(client.submit(basis, candidate), true);
  assert.equal(worker.messages[0].board, basis, 'The complete basis is sent only once.');
  const sent = worker.fills()[0].board;
  assert.equal(Object.hasOwn(sent.zones[0], 'filledPolygons'), false);
  assert.equal(Object.hasOwn(sent.footprints[0].zones![0], 'filledPolygons'), false);
  assert.equal(candidate.zones[0].filledPolygons, filledPolygons);
  assert.equal(candidate.footprints[0].zones![0].filledPolygons, filledPolygons);
  assert.equal(sent.tracks, candidate.tracks);
  assert.equal(sent.vias, candidate.vias);
  client.dispose();
});
