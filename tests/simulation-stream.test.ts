import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendSimulationSamples,
  readSimulationEvents,
} from '../plugins/spice-simulation/renderer/simulation-stream';
import {
  waveformCursorIndex,
  validatedSimulationResult,
} from '../plugins/spice-simulation/domain/waveform';
import {
  createSpiceRawReader,
  liveSpiceNetlist,
} from '../plugins/spice-simulation/host/spice-raw.mjs';
import { startServer } from '../server/index.mjs';
import { switchingStageFixture } from './fixtures/switching-stage';
import {
  buildSpiceDeck,
  defaultTransient,
  type SpiceDeck,
  type SimulationResult,
} from '../plugins/spice-simulation/domain/spice';
import { createProject, serializeProject } from '../lib/project';

const deck: SpiceDeck = {
  netlist: '',
  stop: 1,
  assumptions: [],
  traces: [
    { label: 'Output', vector: 'v(out)', unit: 'V' },
    { label: 'Current', vector: '@r1[i]', unit: 'A' },
  ],
};
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function bytes(text: string, size = 7) {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(control) {
      for (let i = 0; i < data.length; i += size) control.enqueue(data.slice(i, i + size));
      control.close();
    },
  });
}
function nativeRows(rows: number[][]) {
  const buffer = Buffer.alloc(rows.length * 24);
  rows.forEach((row, i) => row.forEach((value, j) => buffer.writeDoubleLE(value, i * 24 + j * 8)));
  return buffer;
}
const header =
  'Title: Fixture\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: 3\nNo. Points: 0       \nVariables:\n0 time time\n1 i(@r1[i]) current\n2 v(out) voltage\nBinary:\n';

test('native raw reader waits for complete rows and maps saved currents without substituting device values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-live-raw-'));
  const file = path.join(directory, 'waveforms.raw');
  let result: SimulationResult | null = null;
  let packets = 0;
  const reader = createSpiceRawReader(file, deck, async (packet: unknown) => {
    packets++;
    result = appendSimulationSamples(result, packet, deck);
  });
  try {
    await reader.poll();
    await writeFile(file, header.slice(0, -4));
    await reader.poll();
    assert.equal(packets, 0);
    const first = nativeRows([
      [0, 0.1, 2],
      [0.25, 0.3, 4],
    ]);
    await appendFile(file, Buffer.concat([Buffer.from(header.slice(-4)), first.subarray(0, 31)]));
    await Promise.all([reader.poll(), reader.poll()]);
    assert.equal(packets, 1);
    await appendFile(file, first.subarray(31));
    await reader.poll();
    assert.deepEqual(result!.time, [0, 0.25]);
    assert.deepEqual(
      result!.traces.map((trace) => trace.values),
      [
        [2, 4],
        [0.1, 0.3],
      ],
    );
    assert.throws(() => validatedSimulationResult(result, deck), /Incompatible/);
    await appendFile(file, nativeRows([[0.5, NaN, 1]]));
    await assert.rejects(reader.poll(), /Invalid/);
    assert.equal(packets, 2, 'No part of an invalid packet can be published.');
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('live sample validation rejects gaps, backwards time, wrong probes, nonfinite data and out-of-range samples', () => {
  const first = appendSimulationSamples(
    null,
    {
      offset: 0,
      time: [0, 0.2],
      values: [
        [1, 2],
        [3, 4],
      ],
    },
    deck,
  );
  for (const packet of [
    { offset: 3, time: [0.3], values: [[3], [5]] },
    { offset: 2, time: [0.2], values: [[3], [5]] },
    { offset: 2, time: [0.3], values: [[3]] },
    { offset: 2, time: [0.3], values: [[Infinity], [5]] },
    { offset: 2, time: [1.2], values: [[3], [5]] },
  ])
    assert.throws(() => appendSimulationSamples(first, packet, deck), /Invalid/);
  assert.deepEqual(first.time, [0, 0.2]);
  assert.equal(waveformCursorIndex([0, 0.1, 0.2], null, 0, 2), 2);
  assert.equal(waveformCursorIndex([0, 0.05, 0.1, 0.15, 0.2], 0.1, 0, 4), 2);
  assert.equal(
    waveformCursorIndex([0, 0.1, 0.2, 0.3], 0.1, 0, 3),
    1,
    'A time remains stable through final resampling.',
  );
});

test('stiff-model preview reduction retains actual per-trace extrema with bounded output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-live-peaks-'));
  const file = path.join(directory, 'waveforms.raw');
  const rows = Array.from({ length: 10000 }, (_, i) => [
    i * 4e-8,
    i === 123 ? 50 : 0,
    i === 456 ? -20 : 2,
  ]);
  rows.push([0.0006, 0, 2]);
  let result: SimulationResult | null = null;
  const reader = createSpiceRawReader(
    file,
    { ...deck, netlist: 'linearize\n' },
    (packet: unknown) => {
      result = appendSimulationSamples(result, packet, deck);
    },
  );
  try {
    await writeFile(file, Buffer.concat([Buffer.from(header), nativeRows(rows)]));
    await reader.poll();
    assert.ok(result!.time.length < 20);
    assert.ok(result!.traces[0].values.includes(-20));
    assert.ok(result!.traces[1].values.includes(50));
    for (let i = 0; i < result!.time.length; i++) {
      const original = rows.find((row) => row[0] === result!.time[i])!;
      assert.equal(result!.traces[0].values[i], original[2]);
      assert.equal(result!.traces[1].values[i], original[1]);
    }
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a full native preview does not abort a simulation with more solver samples', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-live-full-'));
  const file = path.join(directory, 'waveforms.raw');
  let count = 0;
  const reader = createSpiceRawReader(file, deck, (packet: { offset: number; time: number[] }) => {
    assert.equal(packet.offset, count);
    count += packet.time.length;
  });
  try {
    const rows = Array.from({ length: 210001 }, (_, i) => [i / 210000, 1, 2]);
    await writeFile(file, Buffer.concat([Buffer.from(header), nativeRows(rows)]));
    await reader.poll();
    assert.equal(count, 200000);
    await reader.poll();
    assert.equal(count, 200000);
  } finally {
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation SSE handles fragmented UTF-8/CRLF, and requires successful completion after live samples', async () => {
  const events: unknown[] = [];
  await readSimulationEvents(
    bytes(
      frame({ type: 'started' }) +
        frame({ type: 'samples', label: 'µA' }) +
        frame({ type: 'result', result: {} }),
      1,
    ),
    (event) => events.push(event),
  );
  assert.equal(events.length, 3);
  assert.equal((events[1] as { label: string }).label, 'µA');
  await assert.rejects(
    readSimulationEvents(bytes(frame({ type: 'samples' })), () => {}),
    /before completion/,
  );
  await assert.rejects(
    readSimulationEvents(
      bytes(frame({ type: 'samples' }) + frame({ type: 'error', message: 'Solver failed' })),
      () => {},
    ),
    /Solver failed/,
  );
  await assert.rejects(
    readSimulationEvents(bytes(frame({ type: 'result' }) + frame({ type: 'samples' })), () => {}),
    /Incompatible/,
  );
});

test('live output preserves the generated transient timing and references literal native current vectors', () => {
  const circuit = switchingStageFixture();
  const original = buildSpiceDeck(circuit, defaultTransient(circuit));
  const live = liveSpiceNetlist(original);
  const command = /^tran (.+)$/m.exec(original.netlist)![1];
  assert.ok(live.includes(`.tran ${command}\n`));
  assert.ok(live.includes('run waveforms.raw\nload waveforms.raw'));
  assert.ok(live.includes('"i(@'));
  assert.equal(live.split('.tran ').length, 2);
});

test('authenticated simulation API delivers samples while the solver is still pending and finalizes separately', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-live-simulation-api-'));
  let release!: () => void;
  const pendingSolver = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  const server = await startServer({
    dataDir: directory,
    simulationRunner: async (
      generated: SpiceDeck,
      _signal: AbortSignal,
      _store: unknown,
      _root: unknown,
      samples: (value: unknown) => Promise<void>,
    ) => {
      await samples({
        offset: 0,
        time: [0, generated.stop / 2],
        values: generated.traces.map(() => [0, 1]),
      });
      await pendingSolver;
      await samples({ reset: true });
      await samples({
        offset: 0,
        time: [0, generated.stop / 4],
        values: generated.traces.map(() => [0, 2]),
      });
      completed = true;
      return {
        version: 'fixture',
        log: 'fixture',
        time: [0, generated.stop],
        traces: generated.traces.map((trace) => ({ ...trace, values: [0, 2] })),
      };
    },
  });
  const circuit = switchingStageFixture();
  let preview!: () => void;
  const previewed = new Promise<void>((resolve) => {
    preview = resolve;
  });
  try {
    const response = await fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers: {
        'X-OpenPE-Token': server.token,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        source: serializeProject(createProject(circuit)),
        config: defaultTransient(circuit),
      }),
    });
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const events: string[] = [];
    const reading = readSimulationEvents(response.body!, (event) => {
      events.push(event.type);
      if (event.type === 'samples') preview();
    });
    await previewed;
    assert.equal(completed, false);
    assert.deepEqual(events, ['started', 'samples']);
    release();
    await reading;
    assert.deepEqual(events, ['started', 'samples', 'retry', 'samples', 'result']);
  } finally {
    release();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
