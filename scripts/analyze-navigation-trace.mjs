import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const navigationTypes = new Set(['wheel', 'pointermove']);
const phases = [
  'EventDispatch',
  'Layout',
  'UpdateLayoutTree',
  'PrePaint',
  'Paint',
  'RunMicrotasks',
  'FunctionCall',
  'FireAnimationFrame',
  'BeginCommitCompositorFrame',
  'Commit',
];
const workPhases = new Set(phases);
const key = (event) => `${event.pid}:${event.tid}`;
const dispatchType = (event) => event.args?.data?.type ?? 'unknown';
const isSpan = (event) =>
  event.ph === 'X' && Number.isFinite(event.ts) && Number.isFinite(event.dur) && event.dur >= 0;
const end = (event) => event.ts + event.dur;
const rounded = (value) => Math.round(value * 1e6) / 1e6;

function statistics(values, total) {
  const sorted = values.slice().sort((a, b) => a - b);
  const length = sorted.length;
  return {
    count: length,
    medianMs: length
      ? rounded((sorted[Math.floor((length - 1) / 2)] + sorted[Math.floor(length / 2)]) / 2)
      : null,
    p95Ms: length ? rounded(sorted[Math.ceil(length * 0.95) - 1]) : null,
    maxMs: length ? rounded(sorted.at(-1)) : null,
    totalMs: rounded(total),
  };
}

function merged(intervals) {
  const result = [];
  for (const [start, finish] of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (finish <= start) continue;
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], finish);
    else result.push([start, finish]);
  }
  return result;
}
const durationMs = (intervals) => intervals.reduce((total, [a, b]) => total + b - a, 0) / 1000;

function subtract(interval, exclusions) {
  const result = [];
  let [start, finish] = interval;
  for (const [a, b] of exclusions) {
    if (b <= start) continue;
    if (a >= finish) break;
    if (a > start) result.push([start, a]);
    start = Math.max(start, b);
    if (start >= finish) return result;
  }
  if (start < finish) result.push([start, finish]);
  return result;
}

/** Analyze existing CDP data only. No browser connection or profiling is started. */
export function analyzeNavigationTrace(input, source = null) {
  const events = Array.isArray(input) ? input : input?.traceEvents;
  if (!Array.isArray(events)) throw new Error('Expected a CDP traceEvents array or trace object.');
  const mainThreads = new Map();
  const candidates = new Map();
  for (const event of events) {
    if (event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
      mainThreads.set(key(event), event.args.name);
    if (
      isSpan(event) &&
      event.name === 'EventDispatch' &&
      navigationTypes.has(dispatchType(event))
    ) {
      const id = key(event);
      const candidate = candidates.get(id) ?? { pid: event.pid, tid: event.tid, inputs: [] };
      candidate.inputs.push(event);
      candidates.set(id, candidate);
    }
  }
  const rendererCandidates = [...candidates].filter(([id]) => mainThreads.has(id));
  const eligible = rendererCandidates.length ? rendererCandidates : [...candidates];
  eligible.sort((a, b) => b[1].inputs.length - a[1].inputs.length || a[0].localeCompare(b[0]));
  if (!eligible.length) throw new Error('No wheel/pointermove EventDispatch spans were found.');
  const [threadKey, selected] = eligible[0];
  const navigation = selected.inputs.sort((a, b) => a.ts - b.ts);
  const start = navigation[0].ts;
  const lastInputEnd = navigation.reduce((latest, event) => Math.max(latest, end(event)), start);
  const finish = lastInputEnd + 200_000;
  const spans = events.filter((event) => key(event) === threadKey && isSpan(event));
  const excludedProfiler = merged(
    spans
      .filter((event) => /^(?:CpuProfiler::StartProfiling|Profiler\.start)$/.test(event.name))
      .map((event) => [Math.max(start, event.ts), Math.min(finish, end(event))]),
  );
  const clipped = (event) =>
    subtract([Math.max(start, event.ts), Math.min(finish, end(event))], excludedProfiler);
  const inWindow = (event) => event.ts < finish && end(event) >= start;
  const phaseIntervals = new Map(phases.map((name) => [name, []]));
  const phaseDurations = new Map(phases.map((name) => [name, []]));
  const dispatchIntervals = new Map();
  const dispatchDurations = new Map();
  const work = [];
  const activity = [];
  for (const event of spans) {
    if (!inWindow(event) || !workPhases.has(event.name)) continue;
    const intervals = clipped(event);
    const ms = durationMs(intervals);
    phaseIntervals.get(event.name).push(...intervals);
    phaseDurations.get(event.name).push(ms);
    work.push(...intervals);
    if (event.name === 'EventDispatch') {
      const type = dispatchType(event);
      if (!dispatchIntervals.has(type)) {
        dispatchIntervals.set(type, []);
        dispatchDurations.set(type, []);
      }
      dispatchIntervals.get(type).push(...intervals);
      dispatchDurations.get(type).push(ms);
    }
    if (
      (event.name === 'EventDispatch' && navigationTypes.has(dispatchType(event))) ||
      event.name === 'Layout' ||
      event.name === 'Paint'
    ) {
      // A zero-duration dispatch is still activity at its timestamp.
      activity.push([
        Math.max(start, event.ts),
        Math.min(finish, Math.max(end(event), event.ts + 0.001)),
      ]);
    }
  }
  const allWork = merged(work);
  const activeIntervals = merged(activity);
  const presentationEvents = events.filter(
    (event) =>
      event.name === 'AnimationFrame::Presentation' &&
      event.pid === selected.pid &&
      Number.isFinite(event.ts),
  );
  const sameThreadPresentations = presentationEvents.filter((event) => event.tid === selected.tid);
  const presentations = [
    ...new Set(
      (sameThreadPresentations.length >= 2 ? sameThreadPresentations : presentationEvents).map(
        (event) => event.ts,
      ),
    ),
  ].sort((a, b) => a - b);
  const activityFrames = [];
  const framedWork = [];
  let activityIndex = 0;
  let workIndex = 0;
  for (let index = 1; index < presentations.length; index++) {
    const frameStart = Math.max(start, presentations[index - 1]);
    const frameEnd = Math.min(finish, presentations[index]);
    if (frameStart >= frameEnd) continue;
    while (
      activityIndex < activeIntervals.length &&
      activeIntervals[activityIndex][1] <= frameStart
    )
      activityIndex++;
    if (activityIndex >= activeIntervals.length || activeIntervals[activityIndex][0] >= frameEnd)
      continue;
    while (workIndex < allWork.length && allWork[workIndex][1] <= frameStart) workIndex++;
    let workMs = 0;
    for (let at = workIndex; at < allWork.length && allWork[at][0] < frameEnd; at++) {
      const interval = [Math.max(frameStart, allWork[at][0]), Math.min(frameEnd, allWork[at][1])];
      workMs += durationMs([interval]);
      framedWork.push(interval);
    }
    activityFrames.push({
      startMs: rounded((frameStart - start) / 1000),
      endMs: rounded((frameEnd - start) / 1000),
      windowMs: rounded((frameEnd - frameStart) / 1000),
      mainThreadWorkMs: rounded(workMs),
    });
  }
  const summarize = (durations, intervals) => statistics(durations, durationMs(merged(intervals)));
  return {
    source,
    selectedMainThread: {
      pid: selected.pid,
      tid: selected.tid,
      name: mainThreads.get(threadKey) ?? null,
      navigationEventCount: navigation.length,
      selection: rendererCandidates.length
        ? 'CrRendererMain with the most wheel/pointermove EventDispatch spans'
        : 'No renderer thread metadata matched; thread with the most navigation spans',
    },
    analysisWindow: {
      startUs: start,
      endUs: finish,
      durationMs: rounded((finish - start) / 1000),
      tailAfterLastNavigationMs: 200,
      excludedProfilerMs: rounded(durationMs(excludedProfiler)),
    },
    eventDispatchByType: Object.fromEntries(
      [...dispatchDurations].map(([type, durations]) => [
        type,
        summarize(durations, dispatchIntervals.get(type)),
      ]),
    ),
    phaseMs: Object.fromEntries(
      phases.map((name) => [name, summarize(phaseDurations.get(name), phaseIntervals.get(name))]),
    ),
    mainThreadWorkUnionMs: rounded(durationMs(allWork)),
    activityFrameWorkMs: statistics(
      activityFrames.map((frame) => frame.mainThreadWorkMs),
      durationMs(framedWork),
    ),
    activityFrameWindowMs: statistics(
      activityFrames.map((frame) => frame.windowMs),
      activityFrames.reduce((total, frame) => total + frame.windowMs, 0),
    ),
    presentationCount: presentations.length,
    presentationScope: sameThreadPresentations.length >= 2 ? 'selected thread' : 'selected process',
    workOutsideActivityFramesMs: rounded(durationMs(allWork) - durationMs(framedWork)),
    activityFrames,
    method: [
      'Only the selected main thread and the first navigation start through last navigation end + 200 ms are analyzed; setup and Profiler.start are excluded.',
      'Durations are clipped to that window. Each phase total is the union of its intervals, excluding Profiler.start; phase totals overlap each other and must not be added.',
      'Activity frames are adjacent AnimationFrame::Presentation timestamp windows containing navigation input, Layout or Paint. Edge windows are clipped; work without two surrounding presentation anchors is not assigned a frame.',
      `Frame work unions X spans for ${phases.join(', ')}. Nested/overlapping work is counted once, and each interval is clipped to the frame.`,
      'Commit is included for Chromium versions that emit that commit-phase name instead of BeginCommitCompositorFrame.',
      'Presentation-window association is an estimate, not exact hardware-input-to-presentation attribution. Raster/GPU work and untraced native work are not included; these figures do not establish input latency.',
      'Median averages the middle pair; p95 is nearest-rank. Per-event percentiles describe inclusive clipped spans, not exclusive self time.',
    ],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/analyze-navigation-trace.mjs <cdp-trace.json>');
    const source = resolve(process.argv[2]);
    const trace = JSON.parse(await readFile(source, 'utf8'));
    process.stdout.write(`${JSON.stringify(analyzeNavigationTrace(trace, source), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
