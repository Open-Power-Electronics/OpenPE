import { fileURLToPath } from 'node:url';
import { clockPrecisionMarginMs } from './editor-experience-clock.mjs';

export const inputTraceAllowlist = Object.freeze([
  'devtools.timeline',
  'blink.user_timing',
  'toplevel',
  'input',
  'latencyInfo',
  'sequence_manager',
  'renderer.scheduler',
  'blink.scheduler',
  'accessibility',
]);
const requiredCategories = Object.freeze([
  'devtools.timeline',
  'blink.user_timing',
  'toplevel',
  'input',
  'latencyInfo',
]);
const expectedThreads = Object.freeze(['CrBrowserMain', 'Chrome_IOThread', 'CrRendererMain']);

export function experienceTraceMode(value) {
  if (value === undefined || value === '0') return null;
  if (['1', 'light', 'input'].includes(value)) return value;
  throw new Error('OPENPE_PROFILE_TRACE must be 0, 1, light or input when set.');
}

export function selectInputTraceCategories(available) {
  if (
    !Array.isArray(available) ||
    available.length > 2048 ||
    !available.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 256)
  )
    throw new Error('Tracing.getCategories returned an unsupported category inventory.');
  const names = new Set(available);
  const selectedCategories = inputTraceAllowlist.filter((name) => names.has(name));
  const missingCategories = inputTraceAllowlist.filter((name) => !names.has(name));
  const missingRequiredCategories = requiredCategories.filter((name) => !names.has(name));
  return {
    mode: 'input',
    probeCount: 1,
    availableCategoryCount: names.size,
    allowlist: [...inputTraceAllowlist],
    requiredCategories: [...requiredCategories],
    selectedCategories,
    missingCategories,
    missingRequiredCategories,
    expectedThreads: [...expectedThreads],
    status: missingRequiredCategories.length ? 'inconclusive' : 'configured',
    scope:
      'Owned Electron instance BrowserMain/IO and renderer diagnostic. Category availability/metadata establish capture coverage, never a latency pass or causal attribution. Native accessibility mode is unchanged.',
  };
}

export function inputTraceMetadata(bytes, selection, { partial = false, anchor = null } = {}) {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  const trace = JSON.parse(text);
  if (!Array.isArray(trace.traceEvents)) throw new Error('Trace has no traceEvents array.');
  const processes = [],
    threads = [];
  const seen = new Set();
  let truncated = false;
  for (const event of trace.traceEvents) {
    if (event.ph !== 'M' || !['process_name', 'thread_name'].includes(event.name)) continue;
    const name = event.args?.name;
    if (
      !Number.isSafeInteger(event.pid) ||
      !Number.isSafeInteger(event.tid) ||
      typeof name !== 'string' ||
      name.length > 512
    )
      continue;
    const key = `${event.name}:${event.pid}:${event.tid}:${name}`;
    if (seen.has(key)) continue;
    if (seen.size >= 512) {
      truncated = true;
      continue;
    }
    seen.add(key);
    (event.name === 'process_name' ? processes : threads).push({
      pid: event.pid,
      tid: event.tid,
      name,
    });
  }
  const missingThreads = expectedThreads.filter(
    (name) => !threads.some((thread) => thread.name === name),
  );
  const reasons = [];
  if (selection.missingRequiredCategories.length)
    reasons.push(`Missing required categories: ${selection.missingRequiredCategories.join(', ')}.`);
  if (missingThreads.length)
    reasons.push(`Missing expected thread metadata: ${missingThreads.join(', ')}.`);
  if (truncated) reasons.push('Process/thread metadata exceeded its 512-entry bound.');
  if (partial) reasons.push('Input measurement aborted; trace is partial diagnostic evidence.');
  const markers = anchor
    ? trace.traceEvents.filter(
        (event) =>
          event.name === anchor.name &&
          typeof event.cat === 'string' &&
          event.cat.split(',').includes('blink.user_timing') &&
          Number.isFinite(event.ts),
      )
    : [];
  const validAnchor =
    markers.length === 1 &&
    threads.some(
      (thread) =>
        thread.name === 'CrRendererMain' &&
        thread.pid === markers[0].pid &&
        thread.tid === markers[0].tid,
    ) &&
    [
      anchor?.rendererBeforeMarkMs,
      anchor?.rendererAfterMarkMs,
      anchor?.markStartTimeMs,
      anchor?.timeOriginMs,
    ].every(Number.isFinite) &&
    anchor.rendererBeforeMarkMs <= anchor.markStartTimeMs &&
    anchor.markStartTimeMs <= anchor.rendererAfterMarkMs;
  if (!validAnchor)
    reasons.push(
      'Missing, duplicated or invalid renderer performance.mark/trace timestamp anchor.',
    );
  const marker = validAnchor ? markers[0] : null;
  const traceClockAnchor = {
    valid: validAnchor,
    renderer: anchor,
    matchingMarkerCount: markers.length,
    trace: marker
      ? {
          name: marker.name,
          pid: marker.pid,
          tid: marker.tid,
          ts: marker.ts,
          ph: marker.ph,
          cat: marker.cat,
        }
      : null,
    traceMinusRendererOffsetUs: marker
      ? {
          lower: marker.ts - anchor.rendererAfterMarkMs * 1000 - clockPrecisionMarginMs * 1000,
          upper: marker.ts - anchor.rendererBeforeMarkMs * 1000 + clockPrecisionMarginMs * 1000,
        }
      : null,
    precisionMarginMs: clockPrecisionMarginMs,
    scope:
      'Exact unique performance.mark name in this trace plus renderer before/after call bracket. Retain raw timestamps; mapping assumes its trace timestamp falls within that mark call and the recorded precision allowance. No arbitrary offset or GPU fence is inferred.',
  };
  return {
    status: reasons.length ? 'inconclusive' : 'captured',
    causalAttribution: 'not-inferred',
    traceEventCount: trace.traceEvents.length,
    traceClockAnchor,
    processes,
    threads,
    missingThreads,
    truncated,
    partial,
    reasons,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  const { default: assert } = await import('node:assert/strict');
  for (const [input, expected] of [
    [undefined, null],
    ['0', null],
    ['1', '1'],
    ['light', 'light'],
    ['input', 'input'],
  ])
    assert.equal(experienceTraceMode(input), expected);
  for (const input of ['', 'full', 'INPUT', 'true', '2', 1])
    assert.throws(() => experienceTraceMode(input), /OPENPE_PROFILE_TRACE/);
  const complete = selectInputTraceCategories([
    ...inputTraceAllowlist,
    'v8',
    '*',
    'disabled-by-default-accessibility',
  ]);
  assert.deepEqual(complete.selectedCategories, inputTraceAllowlist);
  assert.equal(complete.status, 'configured');
  assert.ok(complete.selectedCategories.includes('accessibility'));
  assert.ok(complete.selectedCategories.every((name) => !name.startsWith('disabled-')));
  for (const name of complete.requiredCategories) {
    const missing = selectInputTraceCategories(
      inputTraceAllowlist.filter((value) => value !== name),
    );
    assert.equal(missing.status, 'inconclusive');
    assert.deepEqual(missing.missingRequiredCategories, [name]);
  }
  const empty = selectInputTraceCategories(['v8']);
  assert.deepEqual(empty.selectedCategories, []);
  assert.equal(empty.status, 'inconclusive');
  for (const inventory of [null, ['input', null], [''], Array(2049).fill('input')])
    assert.throws(() => selectInputTraceCategories(inventory), /inventory/);
  const anchor = {
    name: 'openpe-input-trace:fixture',
    rendererBeforeMarkMs: 100,
    markStartTimeMs: 100.1,
    rendererAfterMarkMs: 100.2,
    timeOriginMs: 1_000_000,
  };
  const fixture = {
    traceEvents: [
      { ph: 'M', name: 'process_name', pid: 1, tid: 1, args: { name: 'Browser' } },
      ...expectedThreads.map((name, index) => ({
        ph: 'M',
        name: 'thread_name',
        pid: index === 2 ? 2 : 1,
        tid: index + 1,
        args: { name },
      })),
      { ph: 'X', name: 'RunTask', pid: 1, tid: 1, dur: 10 },
      { ph: 'R', cat: 'blink.user_timing', name: anchor.name, pid: 2, tid: 3, ts: 1_100_100 },
    ],
  };
  const metadata = inputTraceMetadata(JSON.stringify(fixture), complete, { anchor });
  assert.equal(metadata.status, 'captured');
  assert.equal(metadata.causalAttribution, 'not-inferred');
  assert.equal(metadata.processes.length, 1);
  assert.equal(metadata.threads.length, 3);
  assert.equal(metadata.traceClockAnchor.valid, true);
  assert.deepEqual(metadata.traceClockAnchor.traceMinusRendererOffsetUs, {
    lower: 997900,
    upper: 1002100,
  });
  assert.equal(inputTraceMetadata(JSON.stringify(fixture), complete).status, 'inconclusive');
  assert.equal(
    inputTraceMetadata(
      JSON.stringify({ traceEvents: [...fixture.traceEvents, fixture.traceEvents.at(-1)] }),
      complete,
      { anchor },
    ).traceClockAnchor.valid,
    false,
  );
  assert.equal(
    inputTraceMetadata(
      JSON.stringify({
        traceEvents: fixture.traceEvents.map((event) =>
          event.name === anchor.name ? { ...event, pid: 99 } : event,
        ),
      }),
      complete,
      { anchor },
    ).traceClockAnchor.valid,
    false,
  );
  assert.equal(
    inputTraceMetadata(JSON.stringify(fixture), complete, {
      anchor: { ...anchor, markStartTimeMs: 200 },
    }).traceClockAnchor.valid,
    false,
  );
  assert.equal(
    inputTraceMetadata(JSON.stringify(fixture), complete, { partial: true }).status,
    'inconclusive',
  );
  assert.equal(inputTraceMetadata(JSON.stringify(fixture), empty).status, 'inconclusive');
  assert.deepEqual(
    inputTraceMetadata('{"traceEvents":[]}', complete).missingThreads,
    expectedThreads,
  );
  assert.throws(() => inputTraceMetadata('{}', complete), /traceEvents/);
  const many = {
    traceEvents: [
      ...fixture.traceEvents,
      ...Array.from({ length: 520 }, (_, index) => ({
        ph: 'M',
        name: 'thread_name',
        pid: 3,
        tid: index,
        args: { name: `extra-${index}` },
      })),
    ],
  };
  const bounded = inputTraceMetadata(JSON.stringify(many), complete);
  assert.equal(bounded.processes.length + bounded.threads.length, 512);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.status, 'inconclusive');
  console.log(
    'PASS input trace diagnostic: supported/unsupported modes, exact available allowlist including AX, missing-category/thread inconclusive status, bounded metadata and no causal/pass inference (no browser)',
  );
}
