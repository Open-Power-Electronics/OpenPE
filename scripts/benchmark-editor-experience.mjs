// Opt-in: real Electron/Next or packaged-renderer interaction measurements.
// All native files, recovery and history live in an isolated temporary profile.
// OPENPE_DEV_URL=http://127.0.0.1:3000 node scripts/benchmark-editor-experience.mjs [label]
// Default: a short, acknowledged Layout pan/zoom sample, never a sustained load.
// Use dev:web (not dev, which already opens Electron) for the renderer server.
// Track, route and Model sequences require explicit opt-in; see the operation plan below.
// OPENPE_EXPERIENCE_OPERATIONS=route selects the complete bounded route sequence.
// OPENPE_EXPERIENCE_OPERATIONS=model-cad-edit measures four real CAD commits and four undos.
// OPENPE_EXPERIENCE_OPERATIONS=schematic-paced measures low-frequency individual inputs.
// OPENPE_EXPERIENCE_OPERATIONS=track-paced measures individual Layout drag inputs (v2).
// OPENPE_EXPERIENCE_OPERATIONS=layout-native-wheel opts into five guarded OS inputs.
// OPENPE_EXPERIENCE_TARGET_MS=50 selects a strict 50 ms acceptance target (default 100).
// OPENPE_EXPERIENCE_NATIVE_AX=1 requests full native AX in this isolated test process.
// Built runs copy and hash out into the isolated profile before launching Electron.
// OPENPE_EXPERIENCE_RENDERER_SNAPSHOT replays a retained workspace test snapshot.
// OPENPE_PROFILE_NODE=1 adds bounded Node/Playwright diagnostics without changing clocks.
// OPENPE_PROFILE_TRACE=input probes an exact BrowserMain/IO trace allowlist once.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { readNativeFiles } from './source-editor-test-helpers.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { prepareRendererArtifact, verifyRendererArtifact } from './editor-experience-artifact.mjs';
import {
  createNativeWheelWorker,
  inspectNativeOwnerIdentity,
  nativeWheelSummary,
  qpcClockBracket,
  validateNativeOwnerIdentity,
} from './editor-experience-native-input.mjs';
import { installLayoutCompositorPrototype } from './layout-camera-compositor-prototype.mjs';
import { createNodeInputDiagnostics } from './editor-experience-node-diagnostics.mjs';
import {
  experienceTraceMode,
  inputTraceMetadata,
  selectInputTraceCategories,
} from './editor-experience-trace.mjs';
import {
  actionTiming,
  clockBracket,
  experienceTargetMs,
  isCadCommitWithinTarget,
  layoutTrackActionSummary,
  layoutTrackProtocol,
  navigationActionSummary,
  schematicActionSummary,
  schematicPacedActionSummary,
} from './editor-experience-clock.mjs';
import { projectFromNativeFiles } from '../server/project-format.mjs';
import {
  acquireBenchmarkLock,
  bounded,
  closeOwnedApplication,
  createFailureEvidenceGate,
  createInputSender,
  createRunGuard,
  inputPolicy,
  runPacedInputs,
} from './editor-experience-safety.mjs';

async function assertVerticalNetLine(layout, netId, x) {
  assert.ok(
    await layout.evaluate(
      (svg, { netId, x }) =>
        [...svg.querySelectorAll('[data-net-id] [data-layout-track-target]')].some((line) => {
          const group = line.closest('[data-net-id]');
          return (
            group.getAttribute('data-net-id') === netId &&
            Math.abs(Number(line.getAttribute('x1')) - x) < 0.000001 &&
            Math.abs(Number(line.getAttribute('x2')) - x) < 0.000001 &&
            Math.abs(Number(line.getAttribute('y1')) - Number(line.getAttribute('y2'))) > 0.5
          );
        }),
      { netId, x },
    ),
    'Replanned copper reaches the current cursor line.',
  );
}

const nativeAccessibilityValue = process.env.OPENPE_EXPERIENCE_NATIVE_AX;
assert.ok(
  nativeAccessibilityValue === undefined || ['0', '1'].includes(nativeAccessibilityValue),
  'OPENPE_EXPERIENCE_NATIVE_AX must be 0 or 1 when set.',
);
const nativeAccessibilityRequestedMode =
  nativeAccessibilityValue === '1' ? 'forced-native-AX' : 'natural';

const label = process.argv[2] ?? 'current';
assert.match(label, /^[a-z0-9-]+$/);
const targetMs = experienceTargetMs(process.env.OPENPE_EXPERIENCE_TARGET_MS);
const traceMode = experienceTraceMode(process.env.OPENPE_PROFILE_TRACE);
const nodeDiagnosticsValue = process.env.OPENPE_PROFILE_NODE;
assert.ok(
  nodeDiagnosticsValue === undefined || ['0', '1'].includes(nodeDiagnosticsValue),
  'OPENPE_PROFILE_NODE must be 0 or 1 when set.',
);
assert.ok(
  traceMode !== 'input' || nodeDiagnosticsValue === '1',
  'OPENPE_PROFILE_TRACE=input requires OPENPE_PROFILE_NODE=1 for synchronized Node evidence.',
);
const rendererSnapshot = process.env.OPENPE_EXPERIENCE_RENDERER_SNAPSHOT;
assert.ok(
  rendererSnapshot === undefined || !process.env.OPENPE_DEV_URL,
  'OPENPE_EXPERIENCE_RENDERER_SNAPSHOT cannot be combined with OPENPE_DEV_URL.',
);
const trackOperations = [1, 2, 3]
  .flatMap((index) => [`layout-track-preview-${index}`, `layout-track-commit-${index}`])
  .concat([
    'layout-track-continuous-preview',
    'layout-track-pointer-drag',
    'layout-track-obstacle-preview',
    'layout-track-obstacle-commit',
  ]);
const modelOperations = [
  'model-open',
  'model-orbit',
  'model-zoom',
  'model-select',
  'model-cad-preview',
  'retained-schematic-edit',
  'model-return',
];
const trackPacedOperations = [
  'pickup',
  'preview',
  'commit',
  'pointer',
  'obstacle-pickup',
  'obstacle-preview',
  'obstacle-commit',
].map((phase) => `layout-track-paced-${phase}`);
const modelCadEditOperations = [
  'model-cad-edit-open',
  'model-cad-add-commit',
  'model-cad-move-commit',
  'model-cad-rotate-commit',
  'model-cad-properties-commit',
  ...[1, 2, 3, 4].map((index) => `model-cad-undo-${index}`),
];
const routeOperations = [
  'layout-route-pickup',
  'layout-route-detour-1',
  'layout-route-detour-2',
  'layout-route-detour-3',
  'layout-route-posture',
  'layout-route-cancel',
];
const navigationOperations = (name) => [
  `${name}-pan-continuous`,
  `${name}-zoom-continuous`,
  `${name}-pan-zoomed-out`,
];
const schematicPacedOperations = ['schematic-edit-paced', 'schematic-drag-paced'];
const variants = [
  ...new Set(process.env.OPENPE_NAVIGATION_VARIANTS?.split(',').filter(Boolean) ?? []),
];
assert.ok(
  variants.every((value) =>
    [
      'no-promotion',
      'grid-off',
      'no-promotion-grid-off',
      'layout-containment',
      'deferred-hit-targets',
      'compositor-camera',
    ].includes(value),
  ),
  'Unknown navigation variant',
);
const groups = {
  track: trackOperations,
  'track-paced': trackPacedOperations,
  model: modelOperations,
  'model-cad-edit': modelCadEditOperations,
  route: routeOperations,
  'layout-navigation': navigationOperations('layout'),
  'schematic-navigation': navigationOperations('schematic'),
  'schematic-paced': schematicPacedOperations,
};
const knownOperations = new Set([
  'schematic-edit',
  'schematic-drag',
  'schematic-pan',
  'layout-pan',
  'layout-zoom',
  'layout-pick',
  'project-reopen',
  'layout-native-wheel',
  ...Object.values(groups).flat(),
  ...variants.flatMap((variant) => navigationOperations(`layout-${variant}`)),
]);
const requested = process.env.OPENPE_EXPERIENCE_OPERATIONS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
assert.ok(!requested || requested.length, 'OPENPE_EXPERIENCE_OPERATIONS must not be empty');
const measuredOperations = new Set(
  requested
    ? requested.flatMap((name) => {
        assert.ok(
          knownOperations.has(name) || Object.hasOwn(groups, name),
          `Unknown operation or group: ${name}`,
        );
        return groups[name] ?? [name];
      })
    : ['layout-pan-continuous', 'layout-zoom-continuous'],
);
const navigationMode = process.env.OPENPE_EXPERIENCE_NAVIGATION;
assert.ok(
  !navigationMode || ['1', 'layout', 'schematic'].includes(navigationMode),
  'Unknown navigation mode',
);
if (navigationMode) {
  if (!requested) measuredOperations.clear();
  for (const name of navigationMode === '1' ? ['layout', 'schematic'] : [navigationMode])
    for (const operation of navigationOperations(name)) measuredOperations.add(operation);
}
if (process.env.OPENPE_EXPERIENCE_TRACK_DRAG === '1')
  for (const name of trackOperations) measuredOperations.add(name);
if (process.env.OPENPE_EXPERIENCE_MODEL === '1')
  for (const name of modelOperations) measuredOperations.add(name);
for (const variant of variants)
  for (const name of navigationOperations(`layout-${variant}`)) measuredOperations.add(name);
for (const [group, names] of [
  ['track', trackOperations],
  ['track-paced', trackPacedOperations],
  ['model', modelOperations],
  ['model-cad-edit', modelCadEditOperations],
  ['route', routeOperations],
  ['schematic-paced', schematicPacedOperations],
])
  assert.ok(
    !names.some((name) => measuredOperations.has(name)) ||
      names.every((name) => measuredOperations.has(name)),
    `Select the complete ${group} group; individual operations have dependent setup/assertions.`,
  );
assert.ok(
  process.env.OPENPE_EXPERIENCE_SKIP_MODEL !== '1' ||
    ![...modelOperations, ...modelCadEditOperations].some((name) => measuredOperations.has(name)),
  'SKIP_MODEL conflicts with the explicit model group',
);
const trackEnabled = trackOperations.every((name) => measuredOperations.has(name));
const trackPacedEnabled = trackPacedOperations.every((name) => measuredOperations.has(name));
const modelEnabled = modelOperations.every((name) => measuredOperations.has(name));
const modelCadEditEnabled = modelCadEditOperations.every((name) => measuredOperations.has(name));
const routeEnabled = routeOperations.every((name) => measuredOperations.has(name));
const schematicPacedEnabled = schematicPacedOperations.every((name) =>
  measuredOperations.has(name),
);
const pacedSourceEnabled = modelCadEditEnabled || schematicPacedEnabled;
const pacedSourceName = modelCadEditEnabled ? 'Model CAD' : 'Schematic paced';
const navigationPlan = new Map(
  [...measuredOperations]
    .filter((name) => /-(pan-continuous|zoom-continuous|pan-zoomed-out)$/.test(name))
    .map((name) => [name, name.endsWith('-zoom-continuous') ? 5 : 9]),
);
const schematicActionPlan = new Set(
  ['schematic-edit', 'schematic-drag', ...schematicPacedOperations].filter((name) =>
    measuredOperations.has(name),
  ),
);
const needsLayout =
  [...measuredOperations].some((name) => name.startsWith('layout-')) || modelEnabled;
const wallClockMs =
  trackEnabled || trackPacedEnabled || modelEnabled || modelCadEditEnabled ? 180_000 : 90_000;
const recordTrace = traceMode !== null;
let traceCaptureEnabled = recordTrace;
let inputTraceDiagnostic =
  traceMode === 'input' ? { mode: 'input', status: 'not-probed', records: [] } : null;
const nextVersion = JSON.parse(
  await readFile(new URL('../node_modules/next/package.json', import.meta.url), 'utf8'),
).version;
const benchmarkSource = await readFile(new URL(import.meta.url));
const benchmarkSha256 = createHash('sha256').update(benchmarkSource).digest('hex');
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/editor-experience-'));
const reports = [];
const releaseLock = await acquireBenchmarkLock(path.resolve('test-results/editor-experience.lock'));
const guard = createRunGuard({ wallClockMs });
const failureEvidenceGate = createFailureEvidenceGate();
const nodeDiagnostics = createNodeInputDiagnostics({ enabled: nodeDiagnosticsValue === '1' });
const inputs = createInputSender(guard, inputPolicy, {
  onSettled: (result) => nodeDiagnostics.finish(result),
});
let nodeDiagnosticsSource = null;
const coldBootstrap = {
  action: 'Home Open EMC Flyback example',
  protocol: 'common-controlled-click',
  transportTimeoutMs: 5_000,
  readinessTimeoutMs: 30_000,
  presentationTimeoutMs: 1_000,
  inputPolicy: null,
  excludedFromEditingTarget: true,
  separatelyReportedAs: 'project-open',
  actionInvokeToAcknowledgementMs: null,
  completed: false,
};
let application,
  ownedProcess,
  failure,
  failureEvidenceShutdown,
  teardown,
  shutdownPromise,
  layoutCommitTarget,
  modelCadCommitTarget,
  editorInputTarget,
  layoutInteractionTarget,
  navigationActionTarget = null,
  schematicActionTarget = null,
  nativeAccessibilityBefore = null,
  nativeAccessibilityAfter = null,
  rendererArtifact = null;
let nativeWheelWorker = null;
let nativeWheelDiagnostic = null;
let nativeOwnerEvidence = null;
const shutdown = () =>
  application && ownedProcess
    ? (shutdownPromise ??= closeOwnedApplication(application, ownedProcess))
    : Promise.resolve({ method: 'not-launched' });
try {
  if (inputTraceDiagnostic) {
    const bytes = await readFile(new URL('./editor-experience-trace.mjs', import.meta.url));
    const filename = path.join(profile, 'trace-diagnostics-source.mjs');
    await writeFile(filename, bytes, { flag: 'wx' });
    inputTraceDiagnostic.source = {
      path: filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  if (nodeDiagnosticsValue === '1') {
    const bytes = await readFile(
      new URL('./editor-experience-node-diagnostics.mjs', import.meta.url),
    );
    const filename = path.join(profile, 'node-diagnostics-source.mjs');
    await writeFile(filename, bytes, { flag: 'wx' });
    nodeDiagnosticsSource = {
      path: filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  await writeFile(path.join(profile, 'benchmark-source.mjs'), benchmarkSource, { flag: 'wx' });
  rendererArtifact = process.env.OPENPE_DEV_URL
    ? {
        mode: 'mutable-dev-server',
        url: process.env.OPENPE_DEV_URL,
        condition:
          'Development renderer is live and mutable; no fixed built-renderer provenance is claimed.',
      }
    : await guard.run(
        () => prepareRendererArtifact({ workspaceRoot: process.cwd(), profile, rendererSnapshot }),
        {
          timeoutMs: 30_000,
          label: 'stable renderer artifact preparation',
        },
      );
  await guard.run(
    async () => {
      const launch = electron
        .launch({
          args:
            rendererArtifact.mode === 'fixed-built-renderer'
              ? [rendererArtifact.launchPath]
              : ['.'],
          cwd: process.cwd(),
          env: { ...process.env, OPENPE_DATA_DIR: profile, OPENPE_TEST: '1' },
          timeout: 30_000,
        })
        .then(async (launched) => {
          application = launched;
          ownedProcess = launched.process();
          // Keep ownership even if launch resolves after the round watchdog fired.
          if (guard.reason) await shutdown();
          return launched;
        });
      await launch;
      if (guard.reason) {
        await shutdown();
        guard.check();
      }
      const page = await application.firstWindow();
      const nativeAccessibilitySnapshot = ({ BrowserWindow, app }, setupWindow) => {
        if (setupWindow) {
          // The owned launch inherits the already validated benchmark option.
          if (process.env.OPENPE_EXPERIENCE_NATIVE_AX === '1') {
            if (typeof app.setAccessibilitySupportEnabled !== 'function')
              throw new Error('This Electron build cannot enable the requested native AX mode.');
            app.setAccessibilitySupportEnabled(true);
          }
          const window = BrowserWindow.getAllWindows()[0];
          window.setBounds({ width: 1100, height: 740 });
          window.show();
        }
        const read = (method) => {
          let supported = null;
          try {
            supported = typeof app[method] === 'function';
            return {
              supported,
              value: supported ? app[method]() : null,
              error: supported ? null : `Electron app.${method} is unavailable.`,
            };
          } catch (error) {
            return { supported, value: null, error: error.message ?? String(error) };
          }
        };
        try {
          const requestedMode =
            process.env.OPENPE_EXPERIENCE_NATIVE_AX === '1' ? 'forced-native-AX' : 'natural';
          const features = read('getAccessibilitySupportFeatures');
          const enabled = read('isAccessibilitySupportEnabled');
          return {
            versions: {
              electron: process.versions.electron ?? null,
              chrome: process.versions.chrome ?? null,
            },
            requestedMode,
            enableAttempted: setupWindow && requestedMode === 'forced-native-AX',
            enableVerified:
              requestedMode === 'forced-native-AX'
                ? enabled.supported === true && enabled.value === true
                : null,
            features,
            enabled,
            error: null,
          };
        } catch (error) {
          return { error: error.message ?? String(error) };
        }
      };
      nativeAccessibilityBefore = await application.evaluate(nativeAccessibilitySnapshot, true);
      if (nativeAccessibilityRequestedMode === 'forced-native-AX')
        assert.equal(
          nativeAccessibilityBefore.enableVerified,
          true,
          'The requested native AX mode was not verified enabled.',
        );
      await page.bringToFront();
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(15_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let activeNavigation = null;
      let activeSchematic = null;
      let activeTrack = null;
      let navigationMousePosition = null;
      const recordNavigationAction = (expected) => {
        if (!activeNavigation) return;
        activeNavigation.inputs.push({
          sampleId: activeNavigation.sampleId,
          inputIndex: activeNavigation.inputs.length,
          ...expected,
          nodeInvokedAtMs: performance.now(),
        });
        nodeDiagnostics.begin(activeNavigation.inputs.at(-1));
      };
      const recordSchematicAction = (action) => {
        if (!activeSchematic) return;
        activeSchematic.actions.push({
          sampleId: activeSchematic.sampleId,
          actionIndex: activeSchematic.actions.length,
          ...action,
          ...(activeSchematic.gesture ? { gesture: activeSchematic.gesture } : {}),
          nodeInvokedAtMs: performance.now(),
        });
      };
      const recordTrackAction = (action) => {
        if (!activeTrack) return;
        activeTrack.actions.push({
          sampleId: activeTrack.sampleId,
          actionIndex: activeTrack.actions.length,
          ...action,
          nodeInvokedAtMs: performance.now(),
        });
        nodeDiagnostics.begin(activeTrack.actions.at(-1));
      };
      const paced = async (label, operation) => {
        const result = await inputs.send(operation, label);
        await guard.sleep(inputPolicy.intervalMs);
        return result;
      };
      const controlled = (target) =>
        new Proxy(target, {
          get(object, name) {
            const value = object[name];
            if (typeof value !== 'function') return value;
            if (['click', 'press', 'focus', 'down', 'up', 'move', 'wheel'].includes(name))
              return (...args) => {
                const invoke = () => {
                  if (object === page.mouse && ['move', 'down', 'up'].includes(name)) {
                    if (name === 'move') navigationMousePosition = { x: args[0], y: args[1] };
                    recordNavigationAction({
                      transport: `playwright.mouse.${String(name)}`,
                      type:
                        name === 'move'
                          ? 'pointermove'
                          : name === 'down'
                            ? 'pointerdown'
                            : 'pointerup',
                      x: navigationMousePosition?.x,
                      y: navigationMousePosition?.y,
                      ...(name === 'move'
                        ? {}
                        : {
                            button: { left: 0, middle: 1, right: 2 }[args[0]?.button ?? 'left'],
                          }),
                    });
                    recordSchematicAction({
                      transport: `playwright.mouse.${String(name)}`,
                      method: name,
                      ...(name === 'move'
                        ? { x: args[0], y: args[1], steps: args[2]?.steps ?? 1 }
                        : { button: args[0]?.button ?? 'left' }),
                    });
                    recordTrackAction({
                      transport: `playwright.mouse.${String(name)}`,
                      method: name,
                      x: navigationMousePosition?.x,
                      y: navigationMousePosition?.y,
                      ...(name === 'move' ? { steps: args[2]?.steps ?? 1 } : {}),
                    });
                  }
                  if (name === 'press') {
                    recordSchematicAction({
                      transport: 'playwright.locator.press',
                      method: 'press',
                      key: args[0],
                    });
                    recordTrackAction({ method: 'press', key: args[0] });
                  }
                  if (object === page.keyboard && ['down', 'up'].includes(name))
                    recordTrackAction({
                      transport: `playwright.keyboard.${String(name)}`,
                      method: name === 'down' ? 'key-down' : 'key-up',
                      key: args[0],
                    });
                  return value.apply(object, args);
                };
                if (activeTrack)
                  return paced(`Layout paced ${activeTrack.sampleId}: ${String(name)}`, invoke);
                if (activeSchematic?.paced)
                  return paced(
                    `Schematic paced ${activeSchematic.sampleId} API ${activeSchematic.actions.length + 1}: ${String(name)}`,
                    invoke,
                  );
                const pending = guard.run(invoke, {
                  timeoutMs: 5_000,
                  label: `UI ${String(name)}`,
                });
                if (nodeDiagnosticsValue !== '1') return pending;
                return pending.then(
                  (result) => {
                    nodeDiagnostics.finish();
                    return result;
                  },
                  (error) => {
                    nodeDiagnostics.finish({ completed: false, error });
                    throw error;
                  },
                );
              };
            return value.bind(object);
          },
        });
      const mouse = controlled(page.mouse),
        keyboard = controlled(page.keyboard);
      const button = (name) => controlled(page.getByRole('button', { name, exact: true }));
      const settle = () =>
        guard.run(
          () =>
            page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            ),
          { timeoutMs: 1_000, label: 'renderer presentation' },
        );
      await page
        .getByRole('textbox', { name: 'Describe your circuit', exact: true })
        .waitFor({ timeout: 30_000 });
      const openStarted = performance.now();
      // Cold opening includes catalog/native preparation, outside editor input
      // sampling. Keep the same bounded bootstrap as navigation and CAD runs.
      await button('Open EMC Flyback example').click();
      coldBootstrap.actionInvokeToAcknowledgementMs = performance.now() - openStarted;
      await page.getByTestId('schematic-canvas').waitFor({ timeout: 30_000 });
      await settle();
      coldBootstrap.completed = true;
      const projectOpen = { name: 'project-open', elapsedMs: performance.now() - openStarted };
      reports.push(projectOpen);
      console.log(JSON.stringify(projectOpen));
      // CAD Source round 0 is the baseline, 1-8 verify commits and 9 verifies the tail.
      let sourceReadRound = 0;
      let sourceActiveFile = null;
      const sourceRole = (context, [role, options]) => {
        if (role === 'navigation' && options?.name === 'Project files')
          return { projectFiles: true };
        if (role === 'button' && context.projectFiles && typeof options?.name === 'string')
          return { projectFiles: true, selectFile: options.name };
        if (role === 'button' && options?.name === 'Copy') return { copy: true };
        return context;
      };
      // Preserve the public Source/Copy reader while pacing its real clicks
      // through the same acknowledgement/overload guard as the CAD inputs.
      const sourceLocator = (locator, context = {}) =>
        new Proxy(locator, {
          get(object, name) {
            const value = object[name];
            if (name === 'click')
              return async (...args) => {
                const action = context.selectFile
                  ? `select ${context.selectFile}`
                  : context.copy
                    ? `Copy ${sourceActiveFile ?? '<unknown active file>'}`
                    : 'click';
                const result = await paced(
                  `${pacedSourceName} Source round ${sourceReadRound}: ${action}`,
                  () => value.apply(object, args),
                );
                if (context.selectFile) sourceActiveFile = context.selectFile;
                return result;
              };
            if (['getByRole', 'locator', 'first', 'last', 'nth'].includes(name))
              return (...args) =>
                sourceLocator(
                  value.apply(object, args),
                  name === 'getByRole' ? sourceRole(context, args) : context,
                );
            return typeof value === 'function' ? value.bind(object) : value;
          },
        });
      const sourcePage = {
        evaluate: page.evaluate.bind(page),
        getByRole: (...args) => sourceLocator(page.getByRole(...args), sourceRole({}, args)),
        locator: (...args) => sourceLocator(page.locator(...args)),
      };
      if (pacedSourceEnabled)
        await paced(`${pacedSourceName} Source round 0: inspect Source (baseline)`, () =>
          button('Source').click(),
        );
      else await button('Source').click();
      const original = pacedSourceEnabled
        ? await guard.run(() => readNativeFiles(sourcePage), {
            timeoutMs: 15_000,
            label: `read ${pacedSourceName} native baseline, Source round 0`,
          })
        : await readNativeFiles(page);
      if (pacedSourceEnabled)
        await paced(`${pacedSourceName} Source round 0: return to Schematic (baseline)`, () =>
          button('Schematic').click(),
        );
      else await button('Schematic').click();
      await page.evaluate((observeKeyUp) => {
        window.experience = { running: false, frames: [], events: [], tasks: [] };
        window.experience.taskObserver = new PerformanceObserver((list) => {
          if (window.experience.running)
            window.experience.tasks.push(...list.getEntries().map((entry) => entry.duration));
        });
        window.experience.taskObserver.observe({ entryTypes: ['longtask'] });
        for (const type of [
          'keydown',
          'pointerdown',
          'pointermove',
          'pointerup',
          'wheel',
          ...(observeKeyUp ? ['keyup'] : []),
        ])
          window.addEventListener(
            type,
            (event) => {
              if (!window.experience.running) return;
              const metrics = window.experience;
              const started = performance.now();
              const queuedMs = Math.max(0, started - event.timeStamp);
              const target = event.target instanceof Element ? event.target : null;
              const canvas = target?.closest(
                '[data-testid="layout-canvas"], [data-testid="schematic-canvas"]',
              );
              const observed = {
                sampleId: metrics.sampleId,
                eventSequence: metrics.eventSequence++,
                type,
                key: event.key,
                code: event.code ?? null,
                repeat: event.repeat ?? null,
                isComposing: event.isComposing ?? null,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                inputObservedAtMs: started,
                eventTimeStampMs: event.timeStamp,
                clientX: event.clientX ?? null,
                clientY: event.clientY ?? null,
                button: event.button ?? null,
                buttons: event.buttons ?? null,
                deltaX: event.deltaX ?? null,
                deltaY: event.deltaY ?? null,
                deltaMode: event.deltaMode ?? null,
                wheelDeltaX: event.wheelDeltaX ?? null,
                wheelDeltaY: event.wheelDeltaY ?? null,
                isTrusted: event.isTrusted,
                pointerId: event.pointerId ?? null,
                pointerType: event.pointerType ?? null,
                target: target
                  ? {
                      tagName: target.tagName,
                      testId: target.getAttribute('data-testid'),
                      selectionId:
                        target.closest('[data-selection-id]')?.getAttribute('data-selection-id') ??
                        null,
                      canvasTestId: canvas?.getAttribute('data-testid') ?? null,
                      canvasHasPointerCapture: Number.isInteger(event.pointerId)
                        ? (canvas?.hasPointerCapture(event.pointerId) ?? false)
                        : null,
                    }
                  : null,
              };
              // Keep every captured input, including one whose second frame
              // has not completed. The legacy events array stays completed-only.
              metrics.observedEvents.push(observed);
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  if (metrics.running && metrics.sampleId === observed.sampleId) {
                    const presentedAtMs = performance.now();
                    const ms = presentedAtMs - started;
                    Object.assign(observed, {
                      presentedAtMs,
                      ms,
                      queuedMs,
                      fromEventMs: ms + queuedMs,
                    });
                    metrics.events.push(observed);
                  }
                }),
              );
            },
            true,
          );
      }, routeEnabled || trackPacedEnabled);
      const rawCdp = await page.context().newCDPSession(page);
      const cdp = {
        send: (method, params) =>
          guard.run(() => rawCdp.send(method, params), { timeoutMs: 5_000, label: method }),
        once: (...args) => rawCdp.once(...args),
      };
      await cdp.send('Performance.enable');
      if (inputTraceDiagnostic) {
        try {
          const { categories } = await cdp.send('Tracing.getCategories');
          Object.assign(inputTraceDiagnostic, selectInputTraceCategories(categories), {
            nativeAccessibilityRequestedMode,
            ignoredLegacyInvalidationFlag: process.env.OPENPE_PROFILE_INVALIDATIONS === '1',
          });
          traceCaptureEnabled = inputTraceDiagnostic.selectedCategories.length > 0;
        } catch (error) {
          Object.assign(inputTraceDiagnostic, {
            status: 'inconclusive',
            probeError: error.message ?? String(error),
          });
          throw error;
        }
      }
      const performanceMetrics = async () =>
        Object.fromEntries(
          (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [
            name,
            value,
          ]),
        );
      if (process.env.OPENPE_PROFILE_CPU === '1') await cdp.send('Profiler.enable');
      const recordInputTrace = (partial, bytes, arm, before, after, filename, aborted) => {
        if (!inputTraceDiagnostic) return;
        let metadata;
        try {
          metadata = inputTraceMetadata(bytes, inputTraceDiagnostic, {
            partial: aborted,
            anchor: arm.traceAnchor,
          });
        } catch (error) {
          metadata = {
            status: 'inconclusive',
            causalAttribution: 'not-inferred',
            reasons: [error.message ?? String(error)],
          };
        }
        const metricClock = (value) => ({
          Timestamp: value?.Timestamp ?? null,
          NavigationStart: value?.NavigationStart ?? null,
        });
        const record = {
          sampleId: partial.name,
          path: filename,
          metadata,
          performanceClockMetrics: { before: metricClock(before), after: metricClock(after) },
        };
        partial.inputTraceEvidence = record;
        if (inputTraceDiagnostic.records.length < 32) inputTraceDiagnostic.records.push(record);
        else inputTraceDiagnostic.recordLimitExceeded = true;
        inputTraceDiagnostic.status =
          inputTraceDiagnostic.missingRequiredCategories.length ||
          inputTraceDiagnostic.recordLimitExceeded ||
          inputTraceDiagnostic.records.some((entry) => entry.metadata.status === 'inconclusive')
            ? 'inconclusive'
            : 'captured';
        return metadata;
      };
      const retainAbortedEvidence = async (partial, arm, performanceBefore) => {
        const evidence = {
          sampleId: partial.name,
          status: 'partial-after-abort',
          withinTarget: false,
          readOnlyCleanupBudgetMs: 3_500,
          scope:
            'Bounded read-only cleanup after the original failure; no additional input or frame wait. Events may have incomplete endpoints. This evidence cannot establish acceptance, and traces include diagnostic cleanup.',
          armClock: arm,
          errors: [],
        };
        partial.abortedEvidence = evidence;
        const retain = async (stage, operation, timeoutMs = 1_000) => {
          try {
            const value = await bounded(operation, timeoutMs);
            evidence[stage] = value;
            return value;
          } catch (error) {
            evidence.errors.push({ stage, error: error.message ?? String(error) });
            return null;
          }
        };
        await retain('renderer', async () => {
          const beforeMs = performance.now();
          // The sticky input guard has already stopped the run. Read directly
          // with an independent bound so its original failure cannot suppress
          // evidence or be replaced by a diagnostic retrieval error.
          const metrics = await page.evaluate(() => {
            const metrics = window.experience;
            metrics.running = false;
            cancelAnimationFrame(metrics.frame);
            metrics.observer?.disconnect();
            const pendingTasks = metrics.taskObserver?.takeRecords() ?? [];
            metrics.tasks.push(...pendingTasks.map((entry) => entry.duration));
            metrics.taskObserver?.disconnect();
            return {
              sampleId: metrics.sampleId,
              frames: metrics.frames,
              events: metrics.events,
              observedEvents: metrics.observedEvents,
              tasks: metrics.tasks,
              dom: metrics.dom,
              clock: {
                sampleId: metrics.sampleId,
                rendererNowMs: performance.now(),
                timeOriginMs: performance.timeOrigin,
              },
            };
          });
          return {
            ...metrics,
            resultClock: clockBracket(beforeMs, performance.now(), metrics.clock),
          };
        });
        await retain('mainThreadTotalsMs', async () => {
          const after = Object.fromEntries(
            (await rawCdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [
              name,
              value,
            ]),
          );
          if (inputTraceDiagnostic)
            evidence.performanceAfter = {
              Timestamp: after.Timestamp ?? null,
              NavigationStart: after.NavigationStart ?? null,
            };
          return Object.fromEntries(
            ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(
              (key) => [key, 1000 * (after[key] - performanceBefore[key])],
            ),
          );
        });
        if (process.env.OPENPE_PROFILE_CPU === '1')
          await retain('cpuProfile', async () => {
            const { profile: cpu } = await rawCdp.send('Profiler.stop');
            const filename = path.resolve(
              `test-results/editor-experience-${label}-${partial.name}.partial.cpuprofile`,
            );
            await writeFile(filename, JSON.stringify(cpu));
            return { path: filename, partial: true };
          });
        if (traceCaptureEnabled)
          await retain(
            'trace',
            async () => {
              let onComplete;
              const complete = new Promise((resolve) => {
                onComplete = resolve;
                rawCdp.once('Tracing.tracingComplete', onComplete);
              });
              try {
                await rawCdp.send('Tracing.end');
                const { stream } = await complete;
                const chunks = [];
                let bytes = 0;
                try {
                  for (let index = 0; ; index++) {
                    assert.ok(index < 64, 'Partial trace exceeds the 64-chunk safety limit.');
                    const result = await rawCdp.send('IO.read', {
                      handle: stream,
                      size: 1024 * 1024,
                    });
                    chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'));
                    bytes += chunks.at(-1).length;
                    assert.ok(bytes <= 64 * 1024 * 1024, 'Partial trace exceeds 64 MB.');
                    if (result.eof) break;
                  }
                } finally {
                  await bounded(() => rawCdp.send('IO.close', { handle: stream }), 500);
                }
                const filename = path.resolve(
                  `test-results/editor-experience-${label}-${partial.name}.partial.trace.json`,
                );
                const content = Buffer.concat(chunks);
                await writeFile(filename, content);
                const metadata = recordInputTrace(
                  partial,
                  content,
                  arm,
                  performanceBefore,
                  evidence.performanceAfter,
                  filename,
                  true,
                );
                return { path: filename, bytes, partial: true, ...(metadata ? { metadata } : {}) };
              } finally {
                rawCdp.off('Tracing.tracingComplete', onComplete);
              }
            },
            3_000,
          );
      };
      const measure = async (name, operation, diagnosticCapture) => {
        guard.check();
        if (!measuredOperations.has(name)) return;
        const partial = { name, status: 'running' };
        if (diagnosticCapture) partial.diagnosticCapture = diagnosticCapture;
        reports.push(partial);
        await settle();
        // Diagnostic startup itself can block Chromium. Start before collecting
        // interaction frames so that startup is not reported as an editor stall.
        if (traceCaptureEnabled)
          await cdp.send('Tracing.start', {
            categories:
              traceMode === 'input'
                ? inputTraceDiagnostic.selectedCategories.join(',')
                : (traceMode === 'light'
                    ? 'devtools.timeline'
                    : 'devtools.timeline,disabled-by-default-devtools.timeline,v8,blink.user_timing') +
                  (process.env.OPENPE_PROFILE_INVALIDATIONS === '1'
                    ? ',disabled-by-default-devtools.timeline.invalidationTracking'
                    : ''),
            transferMode: 'ReturnAsStream',
          });
        if (process.env.OPENPE_PROFILE_CPU === '1') await cdp.send('Profiler.start');
        if (process.env.OPENPE_PROFILE_DOM === '1')
          await page.evaluate(() => {
            window.experience.dom = [];
            window.experience.observer = new MutationObserver((records) => {
              for (const record of records) {
                if (record.type !== 'childList') continue;
                const describe = (node) =>
                  node instanceof Element
                    ? {
                        tag: node.tagName,
                        cls: node.getAttribute('class'),
                        data: { ...node.dataset },
                        descendants: node.querySelectorAll('*').length,
                      }
                    : { text: node.textContent?.slice(0, 60) };
                window.experience.dom.push({
                  parent: describe(record.target),
                  added: [...record.addedNodes].map(describe),
                  removed: [...record.removedNodes].map(describe),
                });
              }
            });
            window.experience.observer.observe(document.body, { childList: true, subtree: true });
          });
        const performanceBefore = await performanceMetrics();
        const armBeforeMs = performance.now();
        const armClock = await page.evaluate(
          ({ sampleId, traceMarkName }) => {
            const metrics = window.experience;
            let schematicTarget = null;
            if (sampleId === 'schematic-edit' || sampleId === 'schematic-edit-paced') {
              const target = document.querySelector('[data-testid="symbol-hit-R1"]');
              const canvas = document.querySelector('[data-testid="schematic-canvas"]');
              const rect = target?.getBoundingClientRect();
              const viewport = canvas?.getBoundingClientRect();
              schematicTarget = {
                targetTestId: 'symbol-hit-R1',
                tag: target?.tagName ?? null,
                clientRectCount: target?.getClientRects().length ?? 0,
                rect: rect
                  ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                  : null,
                viewport: viewport
                  ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height }
                  : null,
                window: { width: innerWidth, height: innerHeight, scrollX, scrollY },
              };
            }
            metrics.frames = [];
            metrics.events = [];
            metrics.observedEvents = [];
            metrics.tasks = [];
            metrics.sampleId = sampleId;
            metrics.eventSequence = 0;
            metrics.running = true;
            let previous = performance.now();
            const tick = (now) => {
              if (!metrics.running) return;
              metrics.frames.push(now - previous);
              previous = now;
              metrics.frame = requestAnimationFrame(tick);
            };
            metrics.frame = requestAnimationFrame(tick);
            let traceAnchor;
            if (traceMarkName) {
              const rendererBeforeMarkMs = performance.now();
              const mark = performance.mark(traceMarkName);
              const rendererAfterMarkMs = performance.now();
              traceAnchor = {
                name: traceMarkName,
                rendererBeforeMarkMs,
                rendererAfterMarkMs,
                markStartTimeMs: mark.startTime,
                timeOriginMs: performance.timeOrigin,
              };
            }
            return {
              sampleId,
              rendererNowMs: performance.now(),
              timeOriginMs: performance.timeOrigin,
              ...(traceAnchor ? { traceAnchor } : {}),
              ...(schematicTarget ? { schematicTarget } : {}),
            };
          },
          {
            sampleId: name,
            traceMarkName: inputTraceDiagnostic ? `openpe-input-trace:${name}` : null,
          },
        );
        const armAfterMs = performance.now();
        const started = performance.now();
        const navigationCapture = navigationPlan.has(name) ? { sampleId: name, inputs: [] } : null;
        const schematicCapture = schematicActionPlan.has(name)
          ? { sampleId: name, actions: [], paced: name.endsWith('-paced'), gestures: [] }
          : null;
        const trackCapture = trackPacedOperations.includes(name)
          ? { sampleId: name, actions: [] }
          : null;
        if (trackCapture) {
          activeTrack = trackCapture;
          partial.layoutTrackActions = trackCapture.actions;
          partial.layoutTrackProtocol = {
            name: layoutTrackProtocol,
            version: 2,
            inputPolicy,
            timing:
              'Each raw pointer/key event has its own original API invocation recorded immediately before its send. The 250 ms idle pacing follows acknowledgement and is outside each invocation-to-second-frame interval. Keyboard down/up use separate CDP-backed Playwright APIs; the key stays held during pacing without OS key-repeat injection.',
            observesKeyUp: true,
            firstConnectedDragPickup: name === 'layout-track-paced-pickup',
            firstObstacleDragPickup: name === 'layout-track-paced-obstacle-pickup',
            pickupSetup:
              'Before arming either cold pickup, wait for the transient camera attribute to clear, then focus and move one CSS pixel past the pickup before returning to its exact coordinate and awaiting two frames. This read-only setup is outside input timing; it performs no selection click or electrical edit.',
          };
        }
        if (navigationCapture) {
          activeNavigation = navigationCapture;
          partial.navigationInvocations = navigationCapture.inputs;
        }
        if (schematicCapture) {
          if (name === 'schematic-edit' || name === 'schematic-edit-paced') {
            const target = armClock.schematicTarget;
            const rect = target?.rect,
              viewport = target?.viewport;
            assert.ok(
              target?.tag === 'rect' &&
                target.clientRectCount === 1 &&
                rect &&
                viewport &&
                [
                  rect.x,
                  rect.y,
                  rect.width,
                  rect.height,
                  viewport.x,
                  viewport.y,
                  viewport.width,
                  viewport.height,
                  target.window.width,
                  target.window.height,
                ].every(Number.isFinite) &&
                rect.width > 0 &&
                rect.height > 0 &&
                viewport.width > 0 &&
                viewport.height > 0 &&
                rect.x >= Math.max(0, viewport.x) &&
                rect.y >= Math.max(0, viewport.y) &&
                rect.x + rect.width <= Math.min(target.window.width, viewport.x + viewport.width) &&
                rect.y + rect.height <=
                  Math.min(target.window.height, viewport.y + viewport.height),
              'Schematic R1 click calibration requires one fully visible rectangular hit quad.',
            );
            schematicCapture.clickGeometry = target;
            schematicCapture.clickPoint = {
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
            };
          }
          activeSchematic = schematicCapture;
          partial.schematicActions = schematicCapture.actions;
          partial.schematicInputProtocol = schematicCapture.paced
            ? {
                name: 'paced-single-api-inputs',
                inputPolicy,
                dragHeadStepsPerAPI: 1,
                originalHeadCount: 10,
                comparableWithLegacyContinuousGesture: false,
              }
            : {
                name: 'legacy-whole-api-gestures',
                inputPolicy: null,
                transportTimeoutMs: 5_000,
                dragHeadStepsPerAPI: 10,
                acknowledgementPacing: false,
              };
          if (name === 'schematic-drag-paced')
            partial.schematicGestureGeometry = schematicCapture.gestures;
          if (schematicCapture.clickGeometry)
            partial.schematicClickGeometry = schematicCapture.clickGeometry;
        }
        let details;
        const releaseFailureEvidence = failureEvidenceGate.begin();
        try {
          const timeoutMs = schematicCapture?.paced
            ? 1_000 +
              (name === 'schematic-drag-paced' ? 42 : 15) *
                (inputPolicy.overloadMs + inputPolicy.intervalMs)
            : 15_000;
          details = await guard.run(operation, { timeoutMs, label: name });
        } catch (error) {
          Object.assign(partial, { status: 'aborted', reason: error.message ?? String(error) });
          await bounded(
            () =>
              retainAbortedEvidence(
                partial,
                clockBracket(armBeforeMs, armAfterMs, armClock),
                performanceBefore,
              ),
            3_500,
          ).catch((diagnosticError) => {
            partial.abortedEvidence.errors.push({
              stage: 'cleanup',
              error: diagnosticError.message ?? String(diagnosticError),
            });
          });
          throw error;
        } finally {
          releaseFailureEvidence();
          if (activeNavigation === navigationCapture) activeNavigation = null;
          if (activeSchematic === schematicCapture) activeSchematic = null;
          if (activeTrack === trackCapture) activeTrack = null;
        }
        await settle();
        const elapsedMs = performance.now() - started;
        const resultBeforeMs = performance.now();
        const metrics = await page.evaluate(() => {
          const metrics = window.experience;
          metrics.running = false;
          cancelAnimationFrame(metrics.frame);
          metrics.observer?.disconnect();
          return {
            frames: metrics.frames,
            events: metrics.events,
            observedEvents: metrics.observedEvents,
            tasks: metrics.tasks,
            dom: metrics.dom,
            clock: {
              sampleId: metrics.sampleId,
              rendererNowMs: performance.now(),
              timeOriginMs: performance.timeOrigin,
            },
          };
        });
        const resultAfterMs = performance.now();
        const performanceAfter = await performanceMetrics();
        const mainThreadTotalsMs = Object.fromEntries(
          ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((key) => [
            key,
            1000 * (performanceAfter[key] - performanceBefore[key]),
          ]),
        );
        const deliveredNavigationEvents = metrics.events.filter((event) =>
          ['pointermove', 'wheel'].includes(event.type),
        ).length;
        if (process.env.OPENPE_PROFILE_CPU === '1') {
          const { profile: cpu } = await cdp.send('Profiler.stop');
          await writeFile(
            `test-results/editor-experience-${label}-${name}.cpuprofile`,
            JSON.stringify(cpu),
          );
        }
        if (traceCaptureEnabled) {
          const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
          await cdp.send('Tracing.end');
          const { stream } = await guard.run(() => complete, {
            timeoutMs: 5_000,
            label: 'trace completion',
          });
          const chunks = [];
          let bytes = 0;
          for (;;) {
            const result = await cdp.send('IO.read', { handle: stream });
            chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'));
            bytes += chunks.at(-1).length;
            assert.ok(bytes <= 64 * 1024 * 1024, 'Diagnostic trace exceeds the 64 MB safety limit');
            if (result.eof) break;
          }
          await cdp.send('IO.close', { handle: stream });
          const content = Buffer.concat(chunks);
          const filename = path.resolve(
            `test-results/editor-experience-${label}-${name}.trace.json`,
          );
          await writeFile(filename, content);
          recordInputTrace(
            partial,
            content,
            armClock,
            performanceBefore,
            performanceAfter,
            filename,
            false,
          );
        }
        const summary = (values) => {
          const ordered = values.filter((value) => value >= 0).sort((a, b) => a - b);
          return {
            count: values.length,
            median: ordered[Math.floor(ordered.length / 2)] ?? 0,
            p95: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
            max: ordered.at(-1) ?? 0,
          };
        };
        const report = {
          name,
          elapsedMs,
          framesMs: summary(metrics.frames),
          inputToFrameMs: summary(metrics.events.map((event) => event.ms)),
          inputQueueMs: summary(metrics.events.map((event) => event.queuedMs)),
          eventToFrameMs: summary(metrics.events.map((event) => event.fromEventMs)),
          inputByTypeMs: Object.fromEntries(
            [...new Set(metrics.events.map((event) => event.type))].map((type) => [
              type,
              summary(
                metrics.events.filter((event) => event.type === type).map((event) => event.ms),
              ),
            ]),
          ),
          longTasks: metrics.tasks,
          mainThreadTotalsMs,
          ...(details?.requestedInputs && deliveredNavigationEvents
            ? {
                deliveredNavigationEvents,
                meanMainThreadMsPerDeliveredNavigationEvent:
                  mainThreadTotalsMs.TaskDuration / deliveredNavigationEvents,
              }
            : {}),
          keyEvents: metrics.events.filter((event) => event.key),
          ...(details === undefined ? {} : { details }),
          ...(metrics.dom ? { domChanges: metrics.dom } : {}),
          ...(navigationCapture
            ? {
                navigationActionTarget: navigationActionSummary(
                  name,
                  navigationCapture.inputs,
                  metrics.observedEvents,
                  clockBracket(armBeforeMs, armAfterMs, armClock),
                  clockBracket(resultBeforeMs, resultAfterMs, metrics.clock),
                  navigationPlan.get(name),
                  targetMs,
                ),
              }
            : {}),
          ...(schematicCapture
            ? {
                schematicActionTarget: (schematicCapture.paced
                  ? schematicPacedActionSummary
                  : schematicActionSummary)(
                  name,
                  schematicCapture.actions,
                  metrics.observedEvents,
                  clockBracket(armBeforeMs, armAfterMs, armClock),
                  clockBracket(resultBeforeMs, resultAfterMs, metrics.clock),
                  routeEnabled || trackPacedEnabled,
                  targetMs,
                ),
              }
            : {}),
          ...(trackCapture
            ? {
                layoutTrackActionTarget: layoutTrackActionSummary(
                  name,
                  trackCapture.actions,
                  metrics.observedEvents,
                  clockBracket(armBeforeMs, armAfterMs, armClock),
                  clockBracket(resultBeforeMs, resultAfterMs, metrics.clock),
                  targetMs,
                ),
              }
            : {}),
          ...(name === 'layout-native-wheel'
            ? {
                nativeWheelDiagnostic: nativeWheelSummary(
                  details.nativeInputs,
                  metrics.observedEvents,
                  [
                    clockBracket(armBeforeMs, armAfterMs, armClock),
                    clockBracket(resultBeforeMs, resultAfterMs, metrics.clock),
                  ],
                  details.qpcClocks,
                  targetMs,
                ),
              }
            : {}),
        };
        if (report.nativeWheelDiagnostic) {
          nativeWheelDiagnostic = report.nativeWheelDiagnostic;
          if (!nativeWheelDiagnostic.withinTarget) process.exitCode = 1;
        }
        Object.assign(partial, report, { status: 'complete' });
        console.log(JSON.stringify(report));
        if (metrics.tasks.some((ms) => ms > inputPolicy.overloadMs))
          throw guard.abort(
            new Error(
              `${name} overloaded: renderer long task exceeds ${inputPolicy.overloadMs} ms`,
            ),
          );
      };
      const drag = async (canvas, buttonName, dx, dy) => {
        const box = await canvas.boundingBox();
        assert.ok(box);
        const x = box.x + box.width * 0.5,
          y = box.y + box.height * 0.5;
        await mouse.move(x, y);
        await mouse.down({ button: buttonName });
        await mouse.move(x + dx, y + dy, { steps: 30 });
        await mouse.up({ button: buttonName });
      };
      // Deliberately paced samples: one transport acknowledgement, then 250 ms idle.
      // These measurements are not comparable to the former 60 Hz queued stream.
      const navigation = async (canvas, name) => {
        const center = async () => {
          const box = await canvas.boundingBox();
          assert.ok(box);
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        const stream = async (count, event) => {
          return runPacedInputs(inputs, guard, count, (index, total) => {
            const params = {
              ...event(index, total),
              timestamp: Date.now() / 1000,
            };
            recordNavigationAction({
              transport: 'cdp.Input.dispatchMouseEvent',
              type: params.type === 'mouseWheel' ? 'wheel' : 'pointermove',
              x: params.x,
              y: params.y,
              ...(params.type === 'mouseWheel'
                ? { deltaX: params.deltaX, deltaY: params.deltaY }
                : { buttons: params.buttons }),
              cdpParams: { ...params },
            });
            return rawCdp.send('Input.dispatchMouseEvent', params);
          });
        };
        const pan = async () => {
          const { x, y } = await center();
          await mouse.move(x, y);
          await mouse.down({ button: 'middle' });
          const details = await stream(6, (index, count) => ({
            type: 'mouseMoved',
            x: x + 45 * Math.sin((index * 2 * Math.PI) / count),
            y: y + 25 * Math.sin((index * 4 * Math.PI) / count),
            button: 'middle',
            buttons: 4,
            pointerType: 'mouse',
          }));
          await mouse.up({ button: 'middle' });
          return details;
        };
        if (measuredOperations.has(`${name}-pan-continuous`)) {
          await canvas.press('Home');
          await measure(`${name}-pan-continuous`, pan);
        }
        await measure(`${name}-zoom-continuous`, async () => {
          const { x, y } = await center();
          await mouse.move(x, y);
          return stream(4, (index) => ({
            type: 'mouseWheel',
            x,
            y,
            deltaX: 0,
            deltaY: index % 2 ? -50 : 50,
          }));
        });
        if (measuredOperations.has(`${name}-pan-zoomed-out`)) {
          await canvas.press('Home');
          const { x, y } = await center();
          await mouse.move(x, y);
          await stream(2, () => ({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: 50 }));
          await settle();
          await measure(`${name}-pan-zoomed-out`, pan);
        }
        if (navigationOperations(name).some((operation) => measuredOperations.has(operation)))
          await canvas.press('Home');
      };
      const schematic = controlled(page.getByTestId('schematic-canvas'));
      await measure('schematic-edit', async () => {
        for (let index = 0; index < 5; index++) {
          const hit = page.getByTestId('symbol-hit-R1');
          recordSchematicAction({
            transport: 'playwright.locator.click',
            method: 'click',
            targetTestId: 'symbol-hit-R1',
            point: activeSchematic?.clickPoint,
          });
          await hit.click();
          await schematic.press('ArrowRight');
          await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
          await schematic.press('Control+z');
          await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
        }
      });
      await measure('schematic-drag', async () => {
        for (let index = 0; index < 3; index++) {
          const bounds = await page.getByTestId('symbol-hit-R1').boundingBox();
          assert.ok(bounds);
          const distance = await schematic.evaluate((svg) =>
            Math.max(5.08 * svg.getScreenCTM().a, 8),
          );
          const x = bounds.x + bounds.width / 2,
            y = bounds.y + bounds.height / 2;
          await mouse.click(x, y);
          await mouse.move(x, y);
          await mouse.down();
          await mouse.move(x + distance, y, { steps: 10 });
          await mouse.up();
          await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
          await schematic.press('Control+z');
          await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
        }
      });
      await measure('schematic-edit-paced', async () => {
        for (let index = 0; index < 5; index++) {
          const hit = page.getByTestId('symbol-hit-R1');
          await paced(
            `Schematic paced schematic-edit-paced API ${activeSchematic.actions.length + 1}: click R1`,
            () => {
              recordSchematicAction({
                transport: 'playwright.locator.click',
                method: 'click',
                targetTestId: 'symbol-hit-R1',
                point: activeSchematic.clickPoint,
              });
              return hit.click();
            },
          );
          await schematic.press('ArrowRight');
          await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
          await schematic.press('Control+z');
          await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
        }
      });
      await measure('schematic-drag-paced', async () => {
        for (let index = 0; index < 3; index++) {
          const bounds = await page.getByTestId('symbol-hit-R1').boundingBox();
          assert.ok(bounds);
          const scale = await schematic.evaluate((svg) => {
            const ctmA = svg.getScreenCTM().a;
            return { ctmA, distance: Math.max(5.08 * ctmA, 8) };
          });
          const begin = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          const end = { x: begin.x + scale.distance, y: begin.y };
          const gesture = { round: index, bounds: { ...bounds }, ...scale, begin, end };
          activeSchematic.gesture = gesture;
          activeSchematic.gestures.push(gesture);
          await mouse.click(begin.x, begin.y);
          await mouse.move(begin.x, begin.y, { steps: 1 });
          await mouse.down();
          for (let step = 1; step <= 10; step++) {
            const fraction = step / 10;
            await mouse.move(
              begin.x + (end.x - begin.x) * fraction,
              begin.y + (end.y - begin.y) * fraction,
              { steps: 1 },
            );
          }
          await mouse.up();
          await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
          await schematic.press('Control+z');
          await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
        }
      });
      await measure('schematic-pan', () => drag(schematic, 'middle', 160, 70));
      if (navigationOperations('schematic').some((name) => measuredOperations.has(name)))
        await navigation(schematic, 'schematic');
      if (needsLayout) {
        await button('Layout').click();
        const layout = controlled(page.getByTestId('layout-canvas'));
        await layout.waitFor();
        if (measuredOperations.has('layout-native-wheel')) {
          assert.equal(process.platform, 'win32', 'OS-injected wheel diagnostic requires Windows.');
          assert.equal(
            rendererArtifact.mode,
            'fixed-built-renderer',
            'Native wheel requires the verified nonce-bound built renderer adapter.',
          );
          await layout.focus();
          nativeOwnerEvidence = {
            expected: {
              spawnPid: ownedProcess.pid,
              instanceNonce: rendererArtifact.instanceNonce,
              mainPath: rendererArtifact.mainPath,
              workspaceRoot: process.cwd(),
              profile,
              rendererPath: rendererArtifact.rendererPath,
            },
            observed: await inspectNativeOwnerIdentity(application, page),
            verified: false,
          };
          const ownedWindow = validateNativeOwnerIdentity(
            nativeOwnerEvidence.observed,
            nativeOwnerEvidence.expected,
          );
          nativeOwnerEvidence.verified = true;
          const viewport = await layout.evaluate((svg) => {
            const rect = svg.getBoundingClientRect();
            return {
              width: innerWidth,
              height: innerHeight,
              ratio: devicePixelRatio,
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          });
          nativeWheelWorker = await createNativeWheelWorker(profile);
          const initialized = await nativeWheelWorker.request('init', {
            hwnd: ownedWindow.hwnd,
            pid: ownedWindow.pid,
            ...viewport,
          });
          const nativeCapture = {
            nativeInputs: [],
            qpcClocks: [],
            initialized,
            ownedWindow,
            viewport,
            worker: nativeWheelWorker.metadata,
          };
          await measure(
            'layout-native-wheel',
            async () => {
              const nativeInputs = nativeCapture.nativeInputs;
              const arm = qpcClockBracket(await nativeWheelWorker.request('clock'));
              nativeCapture.qpcClocks.push(arm);
              for (let index = 0; index < 5; index++) {
                await inputs.send(
                  async () => {
                    const live = await layout.evaluate((svg, initial) => {
                      const rect = svg.getBoundingClientRect();
                      const point = document.elementFromPoint(initial.clientX, initial.clientY);
                      return {
                        canvasOwnsPoint: Boolean(point && (point === svg || svg.contains(point))),
                        focused: document.activeElement === svg,
                        width: innerWidth,
                        height: innerHeight,
                        ratio: devicePixelRatio,
                        left: rect.left,
                        top: rect.top,
                        right: rect.right,
                        bottom: rect.bottom,
                        camera:
                          svg.getAttribute('data-layout-camera-view') ??
                          svg.getAttribute('viewBox'),
                      };
                    }, initialized);
                    assert.equal(
                      live.canvasOwnsPoint,
                      true,
                      'Native destination must remain on the actual canvas.',
                    );
                    assert.equal(live.focused, true, 'Native canvas focus changed.');
                    for (const key of [
                      'width',
                      'height',
                      'ratio',
                      'left',
                      'top',
                      'right',
                      'bottom',
                    ])
                      assert.ok(
                        Math.abs(live[key] - viewport[key]) <= 1e-3,
                        `Native canvas ${key} changed.`,
                      );
                    const input = await nativeWheelWorker.request(index === 0 ? 'move' : 'wheel');
                    input.cameraBefore = live.camera;
                    nativeInputs.push(input);
                    await page.waitForFunction(
                      (count) => {
                        const observed = window.experience.observedEvents;
                        return (
                          observed.length > count ||
                          (observed.length === count &&
                            Number.isFinite(observed.at(-1).presentedAtMs))
                        );
                      },
                      index + 1,
                      { timeout: inputPolicy.timeoutMs },
                    );
                    const observed = await page.evaluate(() => window.experience.observedEvents);
                    assert.equal(
                      observed.length,
                      index + 1,
                      'Native inputs cannot have extra, duplicate or coalesced events.',
                    );
                    const event = observed[index];
                    assert.equal(event.sampleId, 'layout-native-wheel');
                    assert.equal(event.eventSequence, index);
                    assert.equal(event.type, index ? 'wheel' : 'pointermove');
                    assert.equal(event.isTrusted, true);
                    if (index) assert.equal(event.wheelDeltaY, index % 2 ? -120 : 120);
                    input.cameraAfter = await layout.evaluate(
                      (svg) =>
                        svg.getAttribute('data-layout-camera-view') ?? svg.getAttribute('viewBox'),
                    );
                    if (index)
                      assert.notEqual(
                        input.cameraAfter,
                        input.cameraBefore,
                        'Every native wheel must update the observed canvas camera.',
                      );
                  },
                  `native OS ${index === 0 ? 'move' : `wheel ${index}`}`,
                );
                await guard.sleep(inputPolicy.intervalMs);
              }
              const result = qpcClockBracket(await nativeWheelWorker.request('clock'));
              nativeCapture.qpcClocks.push(result);
              return nativeCapture;
            },
            nativeCapture,
          );
          await nativeWheelWorker.close();
          nativeWheelWorker = null;
        }
        if (
          [...measuredOperations].some(
            (name) => name.startsWith('layout-') && /continuous|zoomed-out/.test(name),
          )
        ) {
          const mode = await layout.evaluate((svg) => ({
            name: 'layout-camera-mode',
            viewBox: svg.getAttribute('viewBox'),
            viewport: {
              width: svg.getBoundingClientRect().width,
              height: svg.getBoundingClientRect().height,
            },
            tracks: svg.querySelectorAll('[data-layout-track-target]').length,
            fixedTracks: svg.querySelectorAll('[data-layout-fixed-track]').length,
            bodies: svg.querySelectorAll('[data-layout-body-bounds]').length,
            fixedBodies: svg.querySelectorAll('[data-layout-fixed-body]').length,
            ancestors: [
              svg,
              ...(() => {
                const nodes = [];
                for (let node = svg.parentElement; node; node = node.parentElement)
                  nodes.push(node);
                return nodes;
              })(),
            ].map((node) => ({
              tag: node.tagName,
              className: node.getAttribute('class'),
              width: getComputedStyle(node).width,
              height: getComputedStyle(node).height,
              transform: getComputedStyle(node).transform,
              zoom: getComputedStyle(node).zoom,
            })),
          }));
          reports.push(mode);
          console.log(JSON.stringify(mode));
        }
        if (routeEnabled) {
          const project = projectFromNativeFiles(original);
          const anchors = project.pcb?.tracks.filter(
            (item) =>
              item.layer === 'F.Cu' &&
              item.width === 0.4 &&
              item.start.x === 77.78 &&
              item.start.y === 119 &&
              item.end.x === 81.52 &&
              item.end.y === 118.86,
          );
          assert.equal(anchors?.length, 1, 'The pinned EMC copper geometry is unambiguous.');
          const anchor = anchors[0];
          assert.ok(
            anchor && anchor.layer === 'F.Cu' && anchor.netId,
            'The pinned EMC copper anchor retains its real front-layer net.',
          );
          const start = { x: 77.78, y: 119 };
          const endpoint = { x: 81.52, y: 114.86 };
          assert.deepEqual(
            anchor.start,
            start,
            'The route uses the exact retained copper endpoint.',
          );
          const centre = { x: (start.x + endpoint.x) / 2, y: (start.y + endpoint.y) / 2 };
          const screen = (point) =>
            layout.evaluate((svg, point) => {
              const mapped = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
              return { x: mapped.x, y: mapped.y };
            }, point);
          const pacedRouteInput = async (name, operation) => {
            await inputs.send(operation, `route ${name}`);
            await guard.sleep(inputPolicy.intervalMs);
          };
          await layout.press('Escape');
          await button('F.Cu').click();
          const sidebarInitiallyVisible =
            (await button('Toggle right sidebar').getAttribute('aria-pressed')) === 'true';
          if (sidebarInitiallyVisible) await button('Toggle right sidebar').click();
          await button('Fit board to canvas').click();
          await settle();
          const viewport = await layout.boundingBox();
          const pivot = await screen(centre);
          await pacedRouteInput('center pointer', () => mouse.move(pivot.x, pivot.y));
          await pacedRouteInput('center pan pickup', () => mouse.down({ button: 'middle' }));
          await pacedRouteInput('center pan', () =>
            mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2),
          );
          await pacedRouteInput('center pan release', () => mouse.up({ button: 'middle' }));
          // Distinct 0.02 mm heads need more than one actual pointer pixel.
          // The centre pan keeps both the exact anchor and detour head visible.
          for (let step = 0; step < 32; step++) {
            if (
              (await layout.evaluate((svg) =>
                Math.hypot(svg.getScreenCTM().a, svg.getScreenCTM().b),
              )) >= 64
            )
              break;
            const at = await screen(centre);
            await pacedRouteInput(`zoom pointer ${step + 1}`, () => mouse.move(at.x, at.y));
            await pacedRouteInput(`zoom ${step + 1}`, () => mouse.wheel(0, -120));
          }
          const scale = await layout.evaluate((svg) =>
            Math.hypot(svg.getScreenCTM().a, svg.getScreenCTM().b),
          );
          assert.ok(
            scale >= 64,
            'The route head spacing resolves to distinct native pointer pixels.',
          );
          const onCanvas = async (point) => {
            const at = await screen(point),
              rect = await layout.boundingBox();
            assert.ok(
              at.x > rect.x + 8 &&
                at.x < rect.x + rect.width - 8 &&
                at.y > rect.y + 8 &&
                at.y < rect.y + rect.height - 8,
              `The real route pointer remains inside the visible canvas: ${JSON.stringify({ point, at, rect })}`,
            );
            return at;
          };
          await onCanvas(start);
          await onCanvas(endpoint);
          assert.equal(await page.locator('.dirty-dot').count(), 0);
          const preview = layout.locator('[data-route-preview]');
          const readPreview = async () => {
            const value = await preview.getAttribute('points');
            return {
              value,
              blocked: await preview.getAttribute('data-route-blocked'),
              points: value
                .trim()
                .split(/\s+/)
                .map((point) => point.split(',').map(Number)),
            };
          };
          const assertPreview = (result, target, detour = false) => {
            assert.equal(
              result.blocked,
              'false',
              `A legal EMC route preview remains available: ${result.value}`,
            );
            assert.deepEqual(
              result.points[0],
              [start.x, start.y],
              'Preview retains the exact native copper anchor.',
            );
            assert.ok(
              result.points.every((point) => point.length === 2 && point.every(Number.isFinite)),
            );
            if (target) {
              const actual = result.points.at(-1);
              assert.ok(
                Math.hypot(actual[0] - target.x, actual[1] - target.y) <= 1.5 / scale + 0.000002,
                `Preview follows the real pointer within its native-pixel resolution: ${JSON.stringify({ target, actual, scale })}`,
              );
            }
            if (detour)
              assert.ok(
                result.points.length >= 5,
                'The known EMC case still takes a real obstacle detour.',
              );
            for (let index = 1; index < result.points.length; index++) {
              const dx = Math.abs(result.points[index][0] - result.points[index - 1][0]);
              const dy = Math.abs(result.points[index][1] - result.points[index - 1][1]);
              assert.ok(
                dx < 0.000003 || dy < 0.000003 || Math.abs(dx - dy) < 0.000003,
                'Every displayed route span is horizontal, vertical or exactly 45 degrees.',
              );
            }
          };
          await measure('layout-route-pickup', async () => {
            await pacedRouteInput('activate tool', () => button('Route tracks').click());
            const at = await onCanvas(start);
            await pacedRouteInput('anchor pointer', () => mouse.move(at.x, at.y));
            await pacedRouteInput('copper anchor pickup', () => mouse.click(at.x, at.y));
            await preview.waitFor({ state: 'attached' });
            const result = await readPreview();
            assertPreview(result);
            assert.equal(await page.locator('.dirty-dot').count(), 0);
            const settings = page.getByRole('complementary', {
              name: 'Routing settings',
              exact: true,
            });
            assert.equal(
              await settings
                .getByRole('spinbutton', { name: 'Track width (mm)', exact: true })
                .inputValue(),
              '0.4',
            );
            assert.equal(await settings.getByRole('spinbutton').count(), 3);
            return {
              anchorId: anchor.id,
              start,
              netId: anchor.netId,
              pixelsPerMm: scale,
              preview: result.value,
            };
          });
          let previous = await readPreview();
          for (const [index, delta] of [0, 0.02, -0.02].entries()) {
            const target = { x: Number((endpoint.x + delta).toFixed(6)), y: endpoint.y };
            await measure(`layout-route-detour-${index + 1}`, async () => {
              if (index === 0) {
                await pacedRouteInput('disable object snapping', () => keyboard.down('Shift'));
                await pacedRouteInput('disable grid snapping', () => keyboard.down('Control'));
              }
              const at = await onCanvas(target);
              await pacedRouteInput(`distinct detour head ${index + 1}`, () =>
                mouse.move(at.x, at.y),
              );
              const result = await readPreview();
              assertPreview(result, target, true);
              assert.notEqual(
                result.value,
                previous.value,
                'Every distinct head changes the actual displayed route.',
              );
              assert.equal(await page.locator('.dirty-dot').count(), 0);
              previous = result;
              return {
                requestedHead: target,
                actualHead: result.points.at(-1),
                preview: result.value,
              };
            });
          }
          await measure('layout-route-posture', async () => {
            await pacedRouteInput('restore grid snapping', () => keyboard.up('Control'));
            const postureHead = { x: 78.5, y: 118 };
            const at = await onCanvas(postureHead);
            await pacedRouteInput('place two-posture head', () => mouse.move(at.x, at.y));
            const before = await readPreview();
            assertPreview(before, postureHead);
            // Numpad Divide delivers '/' while Shift retains object-snap bypass.
            await pacedRouteInput('switch posture', () => keyboard.press('NumpadDivide'));
            const switched = await readPreview();
            assertPreview(switched);
            assert.notEqual(switched.value, before.value, 'The two legal postures visibly differ.');
            assert.deepEqual(
              switched.points.at(-1),
              before.points.at(-1),
              'Changing posture retains the resolved route head.',
            );
            await pacedRouteInput('restore posture', () => keyboard.press('NumpadDivide'));
            const restored = await readPreview();
            assertPreview(restored);
            assert.equal(
              restored.value,
              before.value,
              'Restoring posture restores the exact preview.',
            );
            await pacedRouteInput('restore object snapping', () => keyboard.up('Shift'));
            return {
              before: before.value,
              switched: switched.value,
              restored: restored.value,
              changed: switched.value !== before.value,
            };
          });
          await measure('layout-route-cancel', async () => {
            await pacedRouteInput('cancel draft', () => keyboard.press('Escape'));
            await preview.waitFor({ state: 'detached' });
            assert.equal(
              await page.locator('.dirty-dot').count(),
              0,
              'Cancelling the entire route leaves the native project clean.',
            );
            return { previewRemoved: true, dirty: false };
          });
          if (sidebarInitiallyVisible) await button('Toggle right sidebar').click();
          await button('Fit board to canvas').click();
          await settle();
        }
        if (trackEnabled || trackPacedEnabled) {
          const project = projectFromNativeFiles(original);
          const track = project.pcb?.tracks.find(
            (item) =>
              item.layer === 'F.Cu' &&
              !item.locked &&
              Math.abs(item.start.x - 114.3) < 0.001 &&
              Math.abs(item.start.y - 64.9017) < 0.001 &&
              Math.abs(item.end.x - 118.7931) < 0.001,
          );
          assert.ok(track, 'The retained EMC VBUS segment supplies a real connected-drag case.');
          const neighbor = project.pcb.tracks.find(
            (item) =>
              item.layer === 'F.Cu' &&
              Math.abs(item.start.x - track.end.x) < 0.000001 &&
              Math.abs(item.start.y - track.end.y) < 0.000001 &&
              Math.abs(item.end.x - 119.4999) < 0.000001 &&
              Math.abs(item.end.y - 64.1949) < 0.000001,
          );
          assert.ok(neighbor, 'The original 45-degree EMC neighbor is retained.');
          const assertVisibleTrack = async (id) => {
            const painted = layout
              .locator(`[data-selection-id="${id}"] line:not([data-layout-track-target])`)
              .first();
            await painted.waitFor({ state: 'attached' });
            const drawing = await painted.evaluate((line) => {
              const target = line
                .closest('[data-selection-id]')
                ?.querySelector('[data-layout-track-target]');
              const attributes = ['x1', 'y1', 'x2', 'y2'];
              const coordinates = attributes.map((name) => Number(line.getAttribute(name)));
              const sameGeometry =
                target &&
                attributes.every(
                  (name, index) => Number(target.getAttribute(name)) === coordinates[index],
                );
              const matrix = line.getScreenCTM();
              const style = getComputedStyle(line);
              let stylesVisible = true;
              for (let ancestor = line; ancestor; ancestor = ancestor.parentElement) {
                const computed = getComputedStyle(ancestor);
                if (
                  computed.display === 'none' ||
                  computed.visibility !== 'visible' ||
                  Number(computed.opacity) <= 0
                )
                  stylesVisible = false;
              }
              const viewport = line.ownerSVGElement?.getBoundingClientRect();
              const rect = line.getBoundingClientRect();
              const width = Number.parseFloat(style.strokeWidth);
              const start = matrix
                ? new DOMPoint(coordinates[0], coordinates[1]).matrixTransform(matrix)
                : null;
              const end = matrix
                ? new DOMPoint(coordinates[2], coordinates[3]).matrixTransform(matrix)
                : null;
              const radius = matrix
                ? (width *
                    Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))) /
                  2
                : 0;
              return {
                sameGeometry,
                nonzeroLength:
                  Math.hypot(coordinates[2] - coordinates[0], coordinates[3] - coordinates[1]) > 0,
                stylesVisible,
                paintedStroke:
                  style.stroke !== 'none' &&
                  style.stroke !== 'transparent' &&
                  Number(style.strokeOpacity) > 0 &&
                  width > 0,
                viewportOverlap: Boolean(
                  viewport &&
                  start &&
                  end &&
                  Math.max(start.x, end.x) + radius > viewport.left &&
                  Math.min(start.x, end.x) - radius < viewport.right &&
                  Math.max(start.y, end.y) + radius > viewport.top &&
                  Math.min(start.y, end.y) - radius < viewport.bottom,
                ),
                hasArea: rect.width > 0 && rect.height > 0,
              };
            });
            assert.ok(
              drawing.sameGeometry &&
                drawing.nonzeroLength &&
                drawing.stylesVisible &&
                drawing.paintedStroke &&
                drawing.viewportOverlap,
              `The actual track paint must match current geometry and be visible: ${JSON.stringify({ id, ...drawing })}`,
            );
            // Playwright's box-area predicate rejects axis-aligned SVG centerlines;
            // their positive stroke and viewport overlap are checked above.
            if (drawing.hasArea) assert.equal(await painted.isVisible(), true);
          };
          const assertTrackShape = async () => {
            await assertVisibleTrack(track.id);
            await assertVisibleTrack(neighbor.id);
            const points = await layout.evaluate(
              (svg, ids) =>
                ids.map((id) => {
                  const line = svg.querySelector(
                    `[data-selection-id="${id}"] [data-layout-track-target]`,
                  );
                  if (!line) return null;
                  return ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)));
                }),
              [track.id, neighbor.id],
            );
            assert.ok(points.every(Boolean));
            const [moved, right] = points;
            assert.ok(
              Math.abs(moved[0] - track.start.x) < 0.000001 &&
                Math.abs(moved[1] - track.start.y - 0.5) < 0.000001 &&
                Math.abs(moved[3] - track.end.y - 0.5) < 0.000001,
              `The real selected segment moves by the complete half-millimetre drag: ${JSON.stringify({ moved, right, original: track })}`,
            );
            assert.ok(
              Math.abs(right[2] - neighbor.end.x) < 0.000001 &&
                Math.abs(right[3] - neighbor.end.y) < 0.000001,
              'The neighboring remote terminal stays fixed.',
            );
            assert.ok(
              Math.abs(Math.abs(right[2] - right[0]) - Math.abs(right[3] - right[1])) < 0.000001,
              'The neighboring span remains one exact 45-degree line.',
            );
            assert.ok(
              Math.hypot(moved[2] - right[0], moved[3] - right[1]) < 0.000001,
              'The dragged span and its neighbor share their exact endpoint.',
            );
            assert.equal(
              await layout.locator('[data-layout-track-target]').count(),
              project.pcb.tracks.length,
              'Dragging extends original spans without extra reconnect doglegs.',
            );
          };
          await button('Fit board to canvas').click();
          const midpoint = { x: (track.start.x + track.end.x) / 2, y: track.start.y };
          const screen = (point) =>
            layout.evaluate((svg, point) => {
              const mapped = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
              return { x: mapped.x, y: mapped.y };
            }, point);
          const prepareColdDragPickup = async (point) => {
            // Setup stays outside measure(): wait for the native idle camera
            // pose, then force a fresh hover event even if a prior zoom left
            // the pointer at this exact coordinate. No selection or drag warms
            // the cold pickup before its measured D key.
            await guard.run(
              () =>
                waitForAsync(
                  page,
                  () => {
                    const svg = document.querySelector('[data-testid="layout-canvas"]');
                    return Boolean(
                      svg?.isConnected && !svg.hasAttribute('data-layout-camera-view'),
                    );
                  },
                  undefined,
                  { timeout: 5_000, polling: 25 },
                ),
              { timeoutMs: 6_000, label: 'settled Layout pickup camera' },
            );
            const start = await screen(point);
            await layout.focus();
            await mouse.move(start.x + 1, start.y, { steps: 1 });
            await mouse.move(start.x, start.y, { steps: 1 });
            await settle();
            return start;
          };
          const ensureDragScale = async () => {
            // At Fit, a half-millimetre displacement can be one physical
            // pointer pixel and quantize to the adjacent snap cell. Verify
            // these exact-pose edits at a scale that resolves that movement.
            for (let step = 0; step < 24; step++) {
              if ((await layout.evaluate((svg) => svg.getScreenCTM().a)) >= 24) break;
              const at = await screen(midpoint);
              await mouse.move(at.x, at.y);
              await mouse.wheel(0, -240);
              await settle();
            }
            assert.ok(
              (await layout.evaluate((svg) => svg.getScreenCTM().a)) >= 24,
              'The half-millimetre drag exceeds the four-pixel pickup threshold.',
            );
          };
          await ensureDragScale();
          if (trackPacedEnabled) {
            await layout.press('Escape');
            assert.equal(
              await page.locator('.dirty-dot').count(),
              0,
              'Cold connected-drag pickup starts from the clean native baseline.',
            );
            assert.equal(
              await layout.locator('[data-track-drag-preview]').count(),
              0,
              'Cold pickup has no preceding connected-drag preview.',
            );
            const start = await prepareColdDragPickup(midpoint);
            await measure('layout-track-paced-pickup', async () => {
              await keyboard.down('d');
              await keyboard.up('d');
            });
            await layout.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
            await measure('layout-track-paced-preview', async () => {
              for (const delta of [0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5]) {
                const target = await screen({ x: midpoint.x, y: midpoint.y + delta });
                await mouse.move(target.x, target.y, { steps: 1 });
              }
            });
            await layout.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
            await assertTrackShape();
            await measure('layout-track-paced-commit', async () => {
              await keyboard.down('Enter');
              await keyboard.up('Enter');
              await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
            });
            await assertTrackShape();
            await layout.press('Control+z');
            await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
            await layout.press('Escape');
            await mouse.click(start.x, start.y);
            await mouse.move(start.x, start.y);
            await measure('layout-track-paced-pointer', async () => {
              await mouse.down();
              for (const delta of [0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5]) {
                const target = await screen({ x: midpoint.x, y: midpoint.y + delta });
                await mouse.move(target.x, target.y, { steps: 1 });
              }
              await layout.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
              await assertTrackShape();
              await mouse.up();
              await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
            });
            await assertTrackShape();
            await layout.press('Control+z');
            await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
            await settle();
            await button('Fit board to canvas').click();
            await layout.press('Escape');
            await button('B.Cu').click();
            const obstacleTrack = project.pcb.tracks.find(
              (item) =>
                item.layer === 'B.Cu' &&
                !item.locked &&
                Math.abs(item.start.x - 87) < 0.000001 &&
                Math.abs(item.start.y - 119.1195) < 0.000001 &&
                Math.abs(item.end.x - 87) < 0.000001 &&
                Math.abs(item.end.y - 109.38) < 0.000001,
            );
            assert.ok(
              obstacleTrack,
              'The pinned EMC DRV span exercises continuous local obstacle avoidance.',
            );
            const obstaclePickup = { x: 87, y: 114.24975 };
            await prepareColdDragPickup(obstaclePickup);
            assert.equal(await page.locator('.dirty-dot').count(), 0);
            assert.equal(await layout.locator('[data-track-drag-preview]').count(), 0);
            await measure('layout-track-paced-obstacle-pickup', async () => {
              await keyboard.down('d');
              await keyboard.up('d');
            });
            await layout.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
            const readObstacleTrack = async () => {
              await assertVisibleTrack(obstacleTrack.id);
              return layout.evaluate((svg, id) => {
                const line = svg.querySelector(
                  `[data-selection-id="${id}"] [data-layout-track-target]`,
                );
                return line
                  ? ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)))
                  : null;
              }, obstacleTrack.id);
            };
            await measure('layout-track-paced-obstacle-preview', async () => {
              const heads = [];
              for (const delta of [-0.5, -1, -1.5, -2, -1.5, -1, -2]) {
                const target = await screen({ x: obstaclePickup.x + delta, y: obstaclePickup.y });
                await mouse.move(target.x, target.y, { steps: 1 });
                await layout.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
                const state = await layout
                  .locator('[data-track-drag-preview]')
                  .evaluate((node) => ({
                    blocked: node.getAttribute('data-track-drag-blocked'),
                    constrained: node.getAttribute('data-track-drag-constrained'),
                  }));
                assert.equal(
                  state.blocked,
                  'false',
                  'Every displayed obstacle head remains committable.',
                );
                const displayed = await readObstacleTrack();
                assert.ok(displayed);
                if (delta <= -1.5) {
                  assert.equal(
                    state.constrained,
                    'false',
                    'A reachable cursor keeps replanning around fixed copper.',
                  );
                  await assertVerticalNetLine(layout, obstacleTrack.netId, 87 + delta);
                }
                heads.push({ delta, ...state, displayed });
              }
              return { heads };
            });
            await layout.locator('[data-track-drag-constrained="false"]').waitFor();
            const replannedTrack = await readObstacleTrack();
            assert.ok(replannedTrack);
            await assertVerticalNetLine(layout, obstacleTrack.netId, 85);
            await measure('layout-track-paced-obstacle-commit', async () => {
              await keyboard.down('Enter');
              await keyboard.up('Enter');
              await page.locator('.dirty-dot').first().waitFor();
            });
            assert.deepEqual(
              await readObstacleTrack(),
              replannedTrack,
              'The exact displayed current-request detour commits once.',
            );
            await button('Source').click();
            const obstacleNative = await guard.run(() => readNativeFiles(page), {
              timeoutMs: 15_000,
              label: 'verify committed EMC DRV obstacle native files',
            });
            const nativeObstacleTrack = projectFromNativeFiles(obstacleNative).pcb?.tracks.find(
              (item) => item.id === obstacleTrack.id,
            );
            assert.ok(nativeObstacleTrack);
            assert.deepEqual(
              [
                nativeObstacleTrack.start.x,
                nativeObstacleTrack.start.y,
                nativeObstacleTrack.end.x,
                nativeObstacleTrack.end.y,
              ],
              replannedTrack,
              'The actual native board contains the exact replanned preview geometry.',
            );
            assert.deepEqual(
              obstacleNative.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
              original.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
              'The obstacle drag retains all non-PCB native bytes.',
            );
            await button('Layout').click();
            await layout.press('Control+z');
            await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
            await button('F.Cu').click();
            await button('Fit board to canvas').click();
            await settle();
          }
          if (trackEnabled) {
            await ensureDragScale();
            for (let index = 1; index <= 3; index++) {
              await layout.press('Escape');
              const start = await screen(midpoint);
              const target = await screen({ x: midpoint.x, y: midpoint.y + 0.5 });
              await mouse.move(start.x, start.y);
              await layout.focus();
              await keyboard.press('d');
              await measure(`layout-track-preview-${index}`, async () => {
                await mouse.move(target.x, target.y, { steps: 8 });
              });
              await assertTrackShape();
              if (process.env.OPENPE_EXPERIENCE_SCREENSHOTS === '1')
                await page.screenshot({
                  path: `test-results/editor-experience-${label}-track-preview-${index}.png`,
                });
              await measure(`layout-track-commit-${index}`, async () => {
                await keyboard.press('Enter');
                await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
              });
              await assertTrackShape();
              await layout.press('Control+z');
              await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
              await settle();
            }
            await layout.press('Escape');
            const continuousStart = await screen(midpoint);
            await mouse.move(continuousStart.x, continuousStart.y);
            await layout.focus();
            await keyboard.press('d');
            await measure('layout-track-continuous-preview', async () => {
              for (const delta of [0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5]) {
                const target = await screen({ x: midpoint.x, y: midpoint.y + delta });
                await mouse.move(target.x, target.y, { steps: 8 });
                await settle();
              }
            });
            await assertTrackShape();
            await layout.press('Escape');
            await settle();
            // Exercise direct pointer pickup/release as well as the explicit D/Enter path.
            await ensureDragScale();
            await measure('layout-track-pointer-drag', async () => {
              const start = await screen(midpoint),
                target = await screen({ x: midpoint.x, y: midpoint.y + 0.5 });
              await mouse.click(start.x, start.y);
              await mouse.move(start.x, start.y);
              await mouse.down();
              await mouse.move(target.x, target.y, { steps: 12 });
              await assertTrackShape();
              await mouse.up();
              await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
            });
            await assertTrackShape();
            await layout.press('Control+z');
            await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
            await button('Fit board to canvas').click();
            await settle();

            // A real fixed-obstacle EMC drag replans a local detour at each cursor position.
            await layout.press('Escape');
            await button('B.Cu').click();
            const obstacleTrack = project.pcb.tracks.find(
              (item) =>
                item.layer === 'B.Cu' &&
                Math.abs(item.start.x - 87) < 0.000001 &&
                Math.abs(item.start.y - 119.1195) < 0.000001 &&
                Math.abs(item.end.x - 87) < 0.000001 &&
                Math.abs(item.end.y - 109.38) < 0.000001,
            );
            assert.ok(obstacleTrack);
            const pickup = { x: 87, y: 114.24975 };
            const obstacleStart = await screen(pickup);
            const obstacleTarget = await screen({ x: pickup.x - 2, y: pickup.y });
            await mouse.move(obstacleStart.x, obstacleStart.y);
            await layout.focus();
            await keyboard.press('d');
            await measure('layout-track-obstacle-preview', () =>
              mouse.move(obstacleTarget.x, obstacleTarget.y, { steps: 8 }),
            );
            await layout.locator('[data-track-drag-constrained="false"]').waitFor();
            const readObstacleTrack = () =>
              layout.evaluate((svg, id) => {
                const line = svg.querySelector(
                  `[data-selection-id="${id}"] [data-layout-track-target]`,
                );
                return ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)));
              }, obstacleTrack.id);
            const replannedTrack = await readObstacleTrack();
            await assertVerticalNetLine(layout, obstacleTrack.netId, 85);
            await measure('layout-track-obstacle-commit', async () => {
              await keyboard.press('Enter');
              await page.locator('.dirty-dot').first().waitFor();
            });
            assert.deepEqual(
              await readObstacleTrack(),
              replannedTrack,
              'The exact displayed current-request detour commits once.',
            );
            await layout.press('Control+z');
            await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
            await button('F.Cu').click();
            await settle();
          }
        }
        await measure('layout-pan', () => drag(layout, 'middle', 180, 70));
        await measure('layout-zoom', async () => {
          const box = await layout.boundingBox();
          await mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let index = 0; index < 8; index++) {
            await mouse.wheel(0, index < 4 ? -100 : 100);
            await settle();
          }
        });
        if (navigationOperations('layout').some((name) => measuredOperations.has(name)))
          await navigation(layout, 'layout');
        for (const variant of variants) {
          assert.ok(
            [
              'no-promotion',
              'grid-off',
              'no-promotion-grid-off',
              'layout-containment',
              'deferred-hit-targets',
              'compositor-camera',
            ].includes(variant),
          );
          let variantState = await layout.evaluate((svg, variant) => {
            window.navigationVariantCleanup?.();
            window.navigationVariantCleanup = null;
            for (const [node, style] of window.navigationVariantStyles ?? []) {
              if (style === null) node.removeAttribute('style');
              else node.setAttribute('style', style);
            }
            for (const [node, attributes] of window.navigationVariantAttributes ?? [])
              for (const [name, value] of attributes) {
                if (value === null) node.removeAttribute(name);
                else node.setAttribute(name, value);
              }
            window.navigationVariantStyles = [];
            window.navigationVariantAttributes = [];
            const save = (node) => {
              if (node) window.navigationVariantStyles.push([node, node.getAttribute('style')]);
              return node;
            };
            if (variant.includes('no-promotion')) {
              const drawing = save(svg.querySelector('[data-layout-drawing]'));
              drawing.style.willChange = 'auto';
              drawing.style.transform = 'none';
            }
            if (variant.includes('grid-off'))
              save(svg.querySelector('[data-layout-grid]')).style.display = 'none';
            if (variant === 'deferred-hit-targets') {
              const geometry = () => {
                const matrix = svg.getScreenCTM();
                return {
                  viewport: svg.getBoundingClientRect().toJSON(),
                  screenCTM: Object.fromEntries(
                    ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => [key, matrix[key]]),
                  ),
                };
              };
              const visibleDrawing = () => {
                const clone = svg.cloneNode(true);
                for (const target of clone.querySelectorAll(
                  '[data-layout-track-target], [data-layout-body-bounds], [data-layout-via-target], [data-layout-graphic-target]',
                ))
                  target.remove();
                return clone.outerHTML;
              };
              const before = geometry();
              const visibleBefore = visibleDrawing();
              const scale = svg.viewBox.baseVal.width / before.viewport.width;
              const remember = (node, names) =>
                window.navigationVariantAttributes.push([
                  node,
                  names.map((name) => [name, node.getAttribute(name)]),
                ]);
              const tracks = svg.querySelectorAll('[data-layout-track-target]');
              for (const target of tracks) {
                remember(target, ['vector-effect', 'data-layout-fixed-track', 'stroke-width']);
                target.removeAttribute('vector-effect');
                target.removeAttribute('data-layout-fixed-track');
                target.setAttribute(
                  'stroke-width',
                  Math.max(Number(target.dataset.layoutTrackTarget), scale * 7),
                );
              }
              const bodies = svg.querySelectorAll('[data-layout-body-bounds]');
              for (const target of bodies) {
                remember(target, [
                  'vector-effect',
                  'data-layout-fixed-body',
                  'stroke',
                  'stroke-width',
                  'stroke-linejoin',
                  'x',
                  'y',
                  'width',
                  'height',
                ]);
                for (const name of [
                  'vector-effect',
                  'data-layout-fixed-body',
                  'stroke',
                  'stroke-width',
                  'stroke-linejoin',
                ])
                  target.removeAttribute(name);
                const [minX, minY, maxX, maxY] = target.dataset.layoutBodyBounds
                  .split(' ')
                  .map(Number);
                const margin = scale * 2;
                target.setAttribute('x', minX - margin);
                target.setAttribute('y', minY - margin);
                target.setAttribute('width', maxX - minX + margin * 2);
                target.setAttribute('height', maxY - minY + margin * 2);
              }
              return {
                name: 'layout-navigation-variant',
                variant,
                before,
                after: geometry(),
                visibleDrawingUnchanged: visibleDrawing() === visibleBefore,
                changedTransparentTargets: { tracks: tracks.length, bodies: bodies.length },
                scope:
                  'Navigation only. Transparent hit padding is initialized once and intentionally not accepted as picking evidence.',
              };
            }
            if (variant === 'layout-containment') {
              const geometry = () => {
                const matrix = svg.getScreenCTM();
                return {
                  viewport: svg.getBoundingClientRect().toJSON(),
                  screenCTM: Object.fromEntries(
                    ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => [key, matrix[key]]),
                  ),
                };
              };
              const before = geometry();
              const drawing = svg.outerHTML;
              const canvas = save(svg.closest('.layout-canvas'));
              canvas.style.contain = 'layout paint';
              return {
                name: 'layout-navigation-variant',
                variant,
                before,
                after: geometry(),
                svgUnchanged: svg.outerHTML === drawing,
                containment: getComputedStyle(canvas).contain,
              };
            }
          }, variant);
          if (variant === 'compositor-camera')
            variantState = await layout.evaluate(installLayoutCompositorPrototype);
          if (variantState) {
            assert.deepEqual(
              variantState.after,
              variantState.before,
              'Layout containment retains the exact SVG viewport and screen transform.',
            );
            assert.equal(
              variantState.visibleDrawingUnchanged ?? variantState.svgUnchanged,
              true,
              'Layout containment retains every drawing node and attribute.',
            );
            reports.push(variantState);
            console.log(JSON.stringify(variantState));
          }
          await navigation(layout, `layout-${variant}`);
          if (variant === 'compositor-camera') {
            const details = await layout.evaluate(() => window.layoutCompositorPrototype.finish());
            reports.push({ name: 'layout-compositor-prototype', ...details });
            assert.ok(
              details.maximumMatrixError < 0.001,
              'Transient CSS camera and exact native rebase retain the world-to-screen transform.',
            );
          }
        }
        await measure('layout-pick', async () => {
          const point = await layout.evaluate((svg) => {
            const viewport = svg.getBoundingClientRect();
            for (const element of svg.querySelectorAll('[data-pad-id]')) {
              const bounds = element.getBoundingClientRect();
              const x = bounds.x + bounds.width / 2,
                y = bounds.y + bounds.height / 2;
              if (
                bounds.width &&
                bounds.height &&
                x > viewport.left + 20 &&
                x < viewport.right - 20 &&
                y > viewport.top + 20 &&
                y < viewport.bottom - 20
              )
                return { x, y };
            }
            return null;
          });
          assert.ok(point, 'A real EMC pad remains visible for picking.');
          for (let index = 0; index < 5; index++) {
            await mouse.click(point.x, point.y);
            await settle();
            await keyboard.press('Escape');
            await settle();
          }
        });
        if (modelEnabled) {
          const model = page.locator('.pcb-model-canvas canvas');
          await measure('model-open', async () => {
            await button('Model').click();
            await model.waitFor();
            await page.locator('.pcb-model-status').waitFor({ state: 'hidden', timeout: 120_000 });
          });
          await settle();
          const modelBefore = await model.screenshot();
          await measure('model-orbit', async () => {
            await drag(model, 'left', 180, 60);
            await page.waitForTimeout(500);
          });
          assert.notDeepEqual(
            await model.screenshot(),
            modelBefore,
            'Orbit changes the rendered view.',
          );
          await measure('model-zoom', async () => {
            const box = await model.boundingBox();
            await mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            for (let index = 0; index < 8; index++) {
              await mouse.wheel(0, index < 4 ? -80 : 80);
              await settle();
            }
            await page.waitForTimeout(300);
          });
          await measure('model-select', async () => {
            const box = await model.boundingBox();
            for (const [x, y] of [
              [0.5, 0.5],
              [0.4, 0.4],
              [0.6, 0.6],
              [0.5, 0.65],
              [0.6, 0.45],
            ]) {
              await mouse.click(box.x + box.width * x, box.y + box.height * y);
              await settle();
            }
          });
          await button('Place box').click();
          await measure('model-cad-preview', async () => {
            const box = await model.boundingBox();
            await mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
            await mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 30 });
          });
          await page.locator('.pcb-model-canvas').press('Escape');
          await page.evaluate(() => {
            window.retainedExperienceModel = document.querySelector('.pcb-model-canvas canvas');
          });
          await button('Schematic').click();
          await measure('retained-schematic-edit', async () => {
            for (let index = 0; index < 3; index++) {
              await page.getByTestId('symbol-hit-R1').click();
              await schematic.press('ArrowRight');
              await page.locator('.dirty-dot').first().waitFor();
              await schematic.press('Control+z');
              await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
            }
          });
          await measure('model-return', async () => {
            await button('Model').click();
            await model.waitFor();
            await page.locator('.pcb-model-status').waitFor({ state: 'hidden' });
          });
          assert.ok(
            await page.evaluate(
              () =>
                window.retainedExperienceModel ===
                document.querySelector('.pcb-model-canvas canvas'),
            ),
            'Schematic poses retain the built Model scene and camera across view switches.',
          );
        }
      }
      let verifyModelCadTailNativeFiles;
      if (modelCadEditEnabled) {
        const modelHost = page.locator('.pcb-model-canvas');
        const modelCanvas = modelHost.locator('canvas');
        const modelRegion = page.getByRole('region', { name: '3D board preview', exact: true });
        const cadButton = (name) => modelRegion.getByRole('button', { name, exact: true });
        const inspector = page.getByRole('complementary', {
          name: 'Solid properties settings',
          exact: true,
        });
        const nativeVariable = 'OPENPE_MODEL_CAD';
        const extension = 'org.openpe.model-cad';
        const settingsWithoutCad = (source) => {
          const settings = JSON.parse(source);
          if (settings.text_variables) {
            delete settings.text_variables[nativeVariable];
            if (!Object.keys(settings.text_variables).length) delete settings.text_variables;
          }
          return settings;
        };
        const cadFromFiles = (bundle) => {
          const entry = bundle.files.find((file) => file.name === bundle.entry);
          assert.ok(entry && /\.kicad_pro$/i.test(entry.name));
          const value = JSON.parse(entry.source).text_variables?.[nativeVariable];
          if (value === undefined) return null;
          assert.equal(typeof value, 'string', 'Native CAD data is a JSON text variable.');
          return JSON.parse(value);
        };
        const originalEntry = original.files.find((file) => file.name === original.entry);
        assert.ok(originalEntry);
        const baselineCad = cadFromFiles(original);
        const baselineCount = baselineCad?.objects.length ?? 0;
        assert.ok(baselineCount < 64, 'The bounded Model test needs one available CAD slot.');
        const baselineSettings = settingsWithoutCad(originalEntry.source);
        const baselineOtherFiles = original.files.filter((file) => file.name !== original.entry);
        verifyModelCadTailNativeFiles = async () => {
          const round = ++sourceReadRound;
          await paced(`Model CAD Source round ${round}: inspect Source (tail verification)`, () =>
            button('Source').click(),
          );
          const bundle = await guard.run(() => readNativeFiles(sourcePage), {
            timeoutMs: 15_000,
            label: `verify final Model CAD native files, Source round ${round}`,
          });
          assert.deepEqual(
            bundle,
            original,
            'Edits undo exactly; camera gestures retain every native byte.',
          );
        };
        const clickCad = (name) => paced(`Model CAD ${name}`, () => cadButton(name).click());
        const replaceField = async (panel, name, value) => {
          const field = panel.getByLabel(name, { exact: true });
          await paced(`Model CAD focus ${name}`, () => field.click());
          await paced(`Model CAD select ${name}`, () => keyboard.press('ControlOrMeta+a'));
          for (const character of String(value))
            await paced(`Model CAD type ${name}`, () =>
              keyboard.press(character === ' ' ? 'Space' : character),
            );
          assert.equal(await field.inputValue(), String(value));
        };
        await measure('model-cad-edit-open', async () => {
          await button('Model').click();
          await modelCanvas.waitFor();
          await page.locator('.pcb-model-status').waitFor({ state: 'hidden', timeout: 120_000 });
        });
        await settle();
        await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
        assert.equal(await cadButton('Undo').isDisabled(), true, 'The CAD group starts clean.');
        assert.equal(Number(await modelHost.getAttribute('data-cad-objects')), baselineCount);

        // Observe existing renderer markers; do not patch rendering, invoke a
        // capability or synthesize input. Equal-valued CAD attribute writes are
        // distinct rebuild epochs, which is essential for move/rotate/undo.
        await modelHost.evaluate((host) => {
          const canvas = host.querySelector('canvas');
          // Three already created this WebGL2 context; this only reads its
          // current loss state and does not create a second renderer/context.
          const context = canvas.getContext('webgl2');
          if (!context || context.isContextLost())
            throw new Error('Model WebGL context is unavailable or already lost.');
          const probe = { host, canvas, epoch: 0, pending: null, failure: null };
          const fail = (message) => {
            probe.failure ??= message;
            if (probe.pending) probe.pending.error ??= message;
          };
          const valid = () => {
            if (!host.isConnected || host.querySelector('canvas') !== canvas) {
              fail('Model canvas was replaced or removed during the CAD group.');
              return false;
            }
            if (context.isContextLost()) {
              fail('Model WebGL context was lost during the CAD group.');
              return false;
            }
            return !probe.failure;
          };
          const invalidate = (sample) => {
            sample.generation++;
            cancelAnimationFrame(sample.frame);
            sample.frame = 0;
          };
          const observer = new MutationObserver((records) => {
            if (!valid()) return;
            const valueAt = (index) => {
              const record = records[index];
              for (let next = index + 1; next < records.length; next++)
                if (records[next].attributeName === record.attributeName)
                  return records[next].oldValue;
              return host.getAttribute(record.attributeName);
            };
            for (let index = 0; index < records.length; index++) {
              const record = records[index];
              if (record.type !== 'attributes') continue;
              const sample = probe.pending;
              if (record.attributeName === 'data-cad-objects') {
                probe.epoch++;
                if (sample?.startedAt !== undefined && !sample.completed) {
                  invalidate(sample);
                  sample.cadEpoch = probe.epoch;
                  sample.cadObjects = Number(valueAt(index));
                  sample.meshObservedAt = performance.now();
                }
              } else if (
                record.attributeName === 'data-cad-tool' &&
                sample?.startedAt !== undefined &&
                !sample.completed
              ) {
                invalidate(sample);
                sample.tool = valueAt(index);
              } else if (
                record.attributeName === 'data-render-count' &&
                sample?.startedAt !== undefined &&
                !sample.completed &&
                !sample.frame &&
                sample.cadEpoch > sample.startEpoch &&
                sample.cadObjects === sample.expectedCount &&
                sample.tool === 'select'
              ) {
                const generation = sample.generation;
                const renderCount = Number(valueAt(index));
                if (renderCount <= sample.startRenderCount) continue;
                const renderObservedAt = performance.now();
                sample.frame = requestAnimationFrame(() => {
                  sample.frame = 0;
                  if (
                    !valid() ||
                    probe.pending !== sample ||
                    sample.generation !== generation ||
                    host.dataset.cadTool !== 'select'
                  )
                    return;
                  const presentedAt = performance.now();
                  sample.completed = {
                    sampleId: sample.sampleId,
                    inputType: sample.type,
                    key: sample.key,
                    queuedMs: sample.queuedMs,
                    cadEpoch: sample.cadEpoch,
                    cadObjects: sample.cadObjects,
                    renderCount,
                    inputToMeshObservedMs: sample.meshObservedAt - sample.startedAt,
                    inputToRenderObservedMs: renderObservedAt - sample.startedAt,
                    inputToPresentationMs: presentedAt - sample.startedAt,
                    fromEventMs: presentedAt - sample.startedAt + sample.queuedMs,
                    rendererTimes: {
                      inputEventTimeStampMs: sample.eventTimeStamp,
                      inputObservedAtMs: sample.startedAt,
                      meshObservedAtMs: sample.meshObservedAt,
                      renderObservedAtMs: renderObservedAt,
                      presentedAtMs: presentedAt,
                    },
                    readiness:
                      'New CAD scene-update attribute write, subsequent renderer.render return marker, then one animation frame.',
                  };
                });
              }
            }
          });
          observer.observe(host, {
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['data-cad-objects', 'data-render-count', 'data-cad-tool'],
            childList: true,
          });
          const capture = (event) => {
            const sample = probe.pending;
            if (!sample || sample.startedAt !== undefined || !valid()) return;
            const target = event.target instanceof Element ? event.target : null;
            const matches =
              sample.type === 'keydown'
                ? event.type === 'keydown' &&
                  event.key.toLowerCase() === sample.key.toLowerCase() &&
                  !event.repeat &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey &&
                  host.contains(target)
                : event.type === 'click' && target?.closest('button') === sample.button;
            if (!matches) return;
            observer.takeRecords();
            sample.startedAt = performance.now();
            sample.eventTimeStamp = event.timeStamp;
            sample.queuedMs = Math.max(0, sample.startedAt - event.timeStamp);
            sample.startEpoch = probe.epoch;
            sample.startRenderCount = Number(host.dataset.renderCount ?? 0);
            sample.tool = host.dataset.cadTool;
          };
          const contextLost = () => fail('Model WebGL context was lost during the CAD group.');
          canvas.addEventListener('webglcontextlost', contextLost);
          window.addEventListener('keydown', capture, true);
          window.addEventListener('click', capture, true);
          probe.arm = (settings) => {
            if (!valid()) throw new Error(probe.failure);
            observer.takeRecords();
            if (probe.pending) cancelAnimationFrame(probe.pending.frame);
            probe.pending = { ...settings, generation: 0, frame: 0 };
            return {
              sampleId: probe.pending.sampleId,
              rendererNowMs: performance.now(),
              timeOriginMs: performance.timeOrigin,
            };
          };
          probe.dispose = () => {
            observer.disconnect();
            if (probe.pending) cancelAnimationFrame(probe.pending.frame);
            canvas.removeEventListener('webglcontextlost', contextLost);
            window.removeEventListener('keydown', capture, true);
            window.removeEventListener('click', capture, true);
          };
          window.experienceCad = probe;
        });
        let cadSampleSequence = 0;
        try {
          const commit = async (name, expectedCount, key, control) => {
            await measure(name, async () => {
              const sampleId = `${name}:${++cadSampleSequence}`;
              const settings = { sampleId, expectedCount, type: key ? 'keydown' : 'click', key };
              const armBeforeMs = performance.now();
              const armClock = control
                ? await control.evaluate(
                    (element, settings) =>
                      window.experienceCad.arm({ ...settings, button: element }),
                    settings,
                  )
                : await page.evaluate((settings) => window.experienceCad.arm(settings), settings);
              const armAfterMs = performance.now();
              let nodeInvokedAtMs;
              await paced(`Model CAD ${name}`, () => {
                // This is the original Playwright action invocation, not its
                // eventual browser dispatch. Arming and pacing are outside it.
                nodeInvokedAtMs = performance.now();
                return key ? modelHost.press(key) : control.click();
              });
              await page.waitForFunction(() => {
                const probe = window.experienceCad;
                return (
                  probe.failure ||
                  !probe.host.isConnected ||
                  probe.host.querySelector('canvas') !== probe.canvas ||
                  probe.pending?.error ||
                  probe.pending?.completed
                );
              });
              const resultBeforeMs = performance.now();
              const result = await page.evaluate(() => {
                const probe = window.experienceCad;
                const result = {
                  failure:
                    probe.failure ??
                    probe.pending?.error ??
                    (!probe.host.isConnected || probe.host.querySelector('canvas') !== probe.canvas
                      ? 'Model canvas was replaced or removed.'
                      : null),
                  cadCommit: probe.pending?.completed ?? null,
                  clock: {
                    sampleId: probe.pending?.sampleId ?? null,
                    rendererNowMs: performance.now(),
                    timeOriginMs: performance.timeOrigin,
                  },
                };
                probe.pending = null;
                return result;
              });
              const resultAfterMs = performance.now();
              assert.equal(result.failure, null);
              assert.ok(
                result.cadCommit,
                'A real CAD rebuild and subsequent rendered frame are required.',
              );
              return {
                cadCommit: {
                  ...result.cadCommit,
                  actionInvokeToCadPresentation: actionTiming(
                    sampleId,
                    nodeInvokedAtMs,
                    clockBracket(armBeforeMs, armAfterMs, armClock),
                    clockBracket(resultBeforeMs, resultAfterMs, result.clock),
                    result.cadCommit,
                    targetMs,
                  ),
                },
              };
            });
          };
          const readCommitted = async (dirty = true) => {
            const round = ++sourceReadRound;
            await page.waitForFunction(
              (expected) => Boolean(document.querySelector('.dirty-dot')) === expected,
              dirty,
            );
            await paced(`Model CAD Source round ${round}: inspect Source`, () =>
              button('Source').click(),
            );
            const bundle = await guard.run(() => readNativeFiles(sourcePage), {
              timeoutMs: 15_000,
              label: `read committed Model CAD native files, Source round ${round}`,
            });
            assert.equal(bundle.entry, original.entry);
            assert.deepEqual(
              bundle.files.filter((file) => file.name !== bundle.entry),
              baselineOtherFiles,
              'CAD edits retain every schematic, PCB and supporting native byte.',
            );
            assert.deepEqual(
              settingsWithoutCad(bundle.files.find((file) => file.name === bundle.entry).source),
              baselineSettings,
              'CAD edits change only the native OPENPE_MODEL_CAD setting.',
            );
            const cad = cadFromFiles(bundle);
            assert.deepEqual(
              projectFromNativeFiles(bundle).extensions[extension] ?? null,
              cad,
              'The full native project accepts the exact committed CAD settings.',
            );
            await paced(`Model CAD Source round ${round}: return to Model`, () =>
              button('Model').click(),
            );
            await modelCanvas.waitFor();
            await page.locator('.pcb-model-status').waitFor({ state: 'hidden' });
            assert.equal(
              await modelHost.evaluate(
                (host) => host.querySelector('canvas') === window.experienceCad.canvas,
              ),
              true,
              'Native inspections retain the same Model renderer.',
            );
            await settle();
            return { bundle, cad };
          };
          const snapshots = [{ bundle: original, cad: baselineCad }];
          await clickCad('Place box');
          const placement = page.getByRole('complementary', { name: 'Box settings', exact: true });
          for (const [name, value] of [
            ['Length (mm)', '24'],
            ['Width (mm)', '16'],
            ['Height (mm)', '8'],
            ['Solid X position (mm)', '53.8'],
            ['Solid Y position (mm)', '112.6'],
            ['Solid Z position (mm)', '6'],
          ])
            await replaceField(placement, name, value);
          await commit('model-cad-add-commit', baselineCount + 1, 'Enter');
          await placement.waitFor({ state: 'hidden' });
          await page.locator('.dirty-dot').first().waitFor();
          const added = await readCommitted();
          const originalIds = new Set(baselineCad?.objects.map((object) => object.id) ?? []);
          const newObjects = added.cad.objects.filter((object) => !originalIds.has(object.id));
          assert.equal(newObjects.length, 1);
          const body = newObjects[0];
          assert.match(body.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
          assert.deepEqual(body, {
            id: body.id,
            name: 'Box',
            kind: 'box',
            position: { x: 53.8, y: 112.6, z: 6 },
            rotation: { x: 0, y: 0, z: 0 },
            size: { x: 24, y: 16, z: 8 },
            material: 'aluminium',
            opacity: 1,
          });
          const expected = { version: 1, objects: [...(baselineCad?.objects ?? []), body] };
          assert.deepEqual(added.cad, expected);
          snapshots.push(added);

          await paced('Model CAD pick up move', () => modelHost.press('m'));
          const movePanel = page.getByRole('complementary', {
            name: 'Move solid settings',
            exact: true,
          });
          await replaceField(movePanel, 'Solid X position (mm)', '56.8');
          await replaceField(movePanel, 'Solid Y position (mm)', '115.6');
          await commit('model-cad-move-commit', baselineCount + 1, 'Enter');
          const moved = await readCommitted();
          expected.objects = expected.objects.map((object) =>
            object.id === body.id ? { ...object, position: { x: 56.8, y: 115.6, z: 6 } } : object,
          );
          assert.deepEqual(moved.cad, expected);
          snapshots.push(moved);

          await commit('model-cad-rotate-commit', baselineCount + 1, 'r');
          const rotated = await readCommitted();
          expected.objects = expected.objects.map((object) =>
            object.id === body.id ? { ...object, rotation: { x: 0, y: 0, z: 90 } } : object,
          );
          assert.deepEqual(rotated.cad, expected);
          snapshots.push(rotated);

          await inspector.waitFor();
          await replaceField(inspector, 'Height (mm)', '12');
          await commit(
            'model-cad-properties-commit',
            baselineCount + 1,
            null,
            inspector.getByRole('button', { name: 'Apply', exact: true }),
          );
          const changed = await readCommitted();
          expected.objects = expected.objects.map((object) =>
            object.id === body.id ? { ...object, size: { x: 24, y: 16, z: 12 } } : object,
          );
          assert.deepEqual(changed.cad, expected);
          assert.equal(
            await inspector.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
            true,
          );

          for (let index = 1; index <= 4; index++) {
            const expectedSnapshot = snapshots[4 - index];
            await commit(
              `model-cad-undo-${index}`,
              expectedSnapshot.cad?.objects.length ?? 0,
              null,
              cadButton('Undo'),
            );
            const undone = await readCommitted(index !== 4);
            assert.deepEqual(
              undone.cad,
              expectedSnapshot.cad,
              'Each commit is reversed by exactly one undo.',
            );
            assert.deepEqual(
              undone.bundle,
              expectedSnapshot.bundle,
              'Each undo restores the exact prior native file bytes.',
            );
            if (index === 4) {
              assert.deepEqual(
                undone.bundle,
                original,
                'Four CAD undos restore every native byte.',
              );
              await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
              assert.equal(await cadButton('Undo').isDisabled(), true);
            }
          }
        } finally {
          if (!guard.reason)
            await guard.run(
              () =>
                page.evaluate(() => {
                  window.experienceCad?.dispose();
                  delete window.experienceCad;
                }),
              { timeoutMs: 1_000, label: 'dispose Model CAD observation' },
            );
        }
      }
      if (process.env.OPENPE_EXPERIENCE_SCREENSHOTS === '1')
        await page.screenshot({ path: `test-results/editor-experience-${label}.png` });
      if (modelCadEditEnabled) await verifyModelCadTailNativeFiles();
      else if (schematicPacedEnabled) {
        sourceReadRound = 1;
        await paced('Schematic paced Source round 1: inspect Source (tail)', () =>
          button('Source').click(),
        );
        assert.deepEqual(
          await guard.run(() => readNativeFiles(sourcePage), {
            timeoutMs: 15_000,
            label: 'read Schematic paced native tail, Source round 1',
          }),
          original,
          'Paced schematic edits undo exactly and restore every native byte.',
        );
      } else {
        await button('Source').click();
        assert.deepEqual(
          await readNativeFiles(page),
          original,
          'Edits undo exactly; camera gestures retain every native byte.',
        );
      }
      // Separate a usable, prepared example open from the first fresh-profile open,
      // which also waits for preparation/history initialization of the full catalog.
      if (measuredOperations.has('project-reopen')) {
        await button('Schematic').click();
        await page.locator('.project-file-tabs .file-tab-close').click();
        await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
        await measure('project-reopen', async () => {
          await button('Open EMC Flyback example').click();
          await page.getByTestId('schematic-canvas').waitFor();
        });
      }
      assert.deepEqual(errors, []);
      // This read is outside all input measurements. Metadata failures do not
      // change acceptance, and an aborted round never starts another main call.
      if (!guard.reason) {
        try {
          nativeAccessibilityAfter = await bounded(
            () =>
              guard.reason
                ? { error: 'Benchmark aborted before native accessibility metadata capture.' }
                : application.evaluate(nativeAccessibilitySnapshot, false),
            1_000,
          );
        } catch (error) {
          nativeAccessibilityAfter = {
            error:
              error.message === 'Owned application shutdown timed out'
                ? 'Native accessibility metadata timed out after 1000 ms.'
                : (error.message ?? String(error)),
          };
        }
        if (nativeAccessibilityRequestedMode === 'forced-native-AX') {
          assert.equal(
            nativeAccessibilityAfter?.enableVerified,
            true,
            'The requested native AX mode was not verified enabled after the run.',
          );
          assert.ok(
            nativeAccessibilityAfter.features?.supported === true &&
              nativeAccessibilityAfter.features.error === null &&
              nativeAccessibilityAfter.features.value != null,
            'The native AX feature snapshot could not be read after the run.',
          );
        }
      }
      const layoutCommitSamples = reports.flatMap((report) =>
        report.name.startsWith('layout-track-commit-') ||
        report.name === 'layout-track-obstacle-commit'
          ? report.keyEvents.filter((event) => event.key === 'Enter').map((event) => event.ms)
          : report.name === 'layout-track-pointer-drag'
            ? [report.inputByTypeMs.pointerup.median]
            : [],
      );
      layoutCommitTarget = {
        targetMs,
        samplesMs: layoutCommitSamples,
        withinTarget:
          layoutCommitSamples.length > 0 && layoutCommitSamples.every((ms) => ms < targetMs),
      };
      if (modelCadEditEnabled) {
        const samples = reports.flatMap((report) =>
          report.details?.cadCommit ? [{ name: report.name, ...report.details.cadCommit }] : [],
        );
        modelCadCommitTarget = {
          targetMs,
          timing: `Both input event timestamp and Node Playwright action invocation through a new CAD mesh rebuild, a subsequent renderer.render return marker and the next animation frame. The invocation interval includes Playwright preparation and browser input dispatch waits; its calibrated upper bound must be strictly below ${targetMs} ms.`,
          expectedCommits: 8,
          samples,
          withinTarget:
            samples.length === 8 &&
            samples.every((sample) => isCadCommitWithinTarget(sample, targetMs)),
          overBudget: samples
            .filter((sample) => !isCadCommitWithinTarget(sample, targetMs))
            .map((sample) => ({
              name: sample.name,
              maximumMs: sample.fromEventMs,
              actionInvokeStatus: sample.actionInvokeToCadPresentation?.status ?? 'missing',
              actionInvokeLowerMs: sample.actionInvokeToCadPresentation?.lowerMs ?? null,
              actionInvokeUpperMs: sample.actionInvokeToCadPresentation?.upperMs ?? null,
              reasons: sample.actionInvokeToCadPresentation?.reasons ?? [],
            })),
        };
        console.log(JSON.stringify({ name: 'model-cad-commit-target', ...modelCadCommitTarget }));
        if (!modelCadCommitTarget.withinTarget) process.exitCode = 1;
      }
      if (navigationPlan.size) {
        const groups = reports.filter((report) => navigationPlan.has(report.name));
        const samples = groups.flatMap((report) =>
          (report.navigationActionTarget?.samples ?? []).map((sample) => ({
            operation: report.name,
            ...sample,
          })),
        );
        const expectedSamples = [...navigationPlan.values()].reduce(
          (total, count) => total + count,
          0,
        );
        navigationActionTarget = {
          targetMs,
          timing: `Original event-to-second-frame duration and calibrated Node action-invocation-to-second-frame upper bound must both be strictly below ${targetMs} ms, with strict ordered event/type/coordinate pairing and the recorded clock precision/drift assumption. No GPU fence is observed.`,
          scope:
            'Only selected navigation() pan/zoom measurements. A normal pan/zoom pair has 9+5=14 samples; a separately selected zoomed-out pan adds 9. Home, setup zooms and other editor operations are outside this target.',
          samplesPerPan: 9,
          samplesPerZoom: 5,
          samplesPerPanZoomPair: 14,
          expectedSamples,
          groups: groups.map((report) => ({
            name: report.name,
            expectedSamples: navigationPlan.get(report.name),
            valid: report.navigationActionTarget?.valid ?? false,
            withinTarget: report.navigationActionTarget?.withinTarget ?? false,
            reasons: report.navigationActionTarget?.reasons ?? [
              'Missing navigation action result.',
            ],
          })),
          samples,
          withinTarget:
            groups.length === navigationPlan.size &&
            samples.length === expectedSamples &&
            groups.every((report) => report.navigationActionTarget?.withinTarget === true),
          notWithinTarget: samples.filter((sample) => !sample.withinTarget),
        };
        console.log(
          JSON.stringify({ name: 'navigation-action-target', ...navigationActionTarget }),
        );
        if (!navigationActionTarget.withinTarget) process.exitCode = 1;
      }
      if (schematicActionPlan.size) {
        const groups = reports.filter((report) => schematicActionPlan.has(report.name));
        const samples = groups.flatMap((report) =>
          (report.schematicActionTarget?.samples ?? []).map((sample) => ({
            operation: report.name,
            ...sample,
          })),
        );
        const expectedSamples = [...schematicActionPlan].reduce(
          (total, name) =>
            total +
            (name.startsWith('schematic-edit')
              ? routeEnabled || trackPacedEnabled
                ? 45
                : 30
              : routeEnabled || trackPacedEnabled
                ? 51
                : 45),
          0,
        );
        schematicActionTarget = {
          targetMs,
          timing: `Strict original Playwright API invocation to each observed schematic event and its second animation frame, including preparation and browser dispatch waits. Every same-order input/event pair must pass its original event duration and calibrated action upper bound strictly below ${targetMs} ms, under the recorded clock precision/drift assumption.`,
          scope:
            'Selected legacy schematic-edit/drag and/or independent schematic-paced cases. Legacy steps:10 samples include cumulative whole-API gesture duration, not individual event latency. Paced drag uses ten separate steps:1 APIs. Click/modifier-key subevents share their real invocation; no per-dispatch timestamp or document/GPU completion is inferred.',
          observeKeyUp: routeEnabled || trackPacedEnabled,
          expectedSamples,
          expectedOriginalActions: [...schematicActionPlan].reduce(
            (total, name) => total + (name === 'schematic-drag-paced' ? 42 : 15),
            0,
          ),
          groups: groups.map((report) => ({
            name: report.name,
            protocol: report.schematicInputProtocol,
            valid: report.schematicActionTarget?.valid ?? false,
            withinTarget: report.schematicActionTarget?.withinTarget ?? false,
            reasons: report.schematicActionTarget?.reasons ?? ['Missing schematic action result.'],
          })),
          samples,
          withinTarget:
            groups.length === schematicActionPlan.size &&
            samples.length === expectedSamples &&
            groups.every((report) => report.schematicActionTarget?.withinTarget === true),
          notWithinTarget: samples.filter((sample) => !sample.withinTarget),
        };
        console.log(JSON.stringify({ name: 'schematic-action-target', ...schematicActionTarget }));
        if (!schematicActionTarget.withinTarget) process.exitCode = 1;
      }
      const selectedLayoutInputs = [...measuredOperations].filter(
        (name) =>
          (name.startsWith('layout-') && navigationPlan.has(name)) ||
          /^layout-track-/.test(name) ||
          ['layout-pan', 'layout-zoom'].includes(name),
      );
      if (selectedLayoutInputs.length) {
        const groups = selectedLayoutInputs.map((name) => {
          const report = reports.find((item) => item.name === name);
          const target = report?.navigationActionTarget ?? report?.layoutTrackActionTarget;
          const samples = target?.samples ?? [];
          return {
            name,
            protocol: target?.protocol ?? report?.layoutTrackProtocol?.name ?? null,
            status: report?.status ?? 'missing',
            calibrated: Boolean(target),
            expectedSamples: target?.expectedCount ?? null,
            sampleCount: samples.length,
            maximumOriginalEventMs: report?.eventToFrameMs?.max ?? null,
            maximumActionUpperMs:
              samples.length && samples.every((sample) => sample.actionInvokeToPresentation?.valid)
                ? Math.max(...samples.map((sample) => sample.actionInvokeToPresentation.upperMs))
                : null,
            valid: target?.valid === true,
            withinTarget: report?.status === 'complete' && target?.withinTarget === true,
            reasons: target?.reasons ?? [
              'Original invocation pairing is unavailable for this legacy operation.',
            ],
          };
        });
        const goalCoverageComplete =
          selectedLayoutInputs.includes('layout-pan-continuous') &&
          selectedLayoutInputs.includes('layout-zoom-continuous') &&
          trackPacedEnabled;
        const withinTarget = groups.every((group) => group.calibrated)
          ? groups.every((group) => group.withinTarget)
          : null;
        layoutInteractionTarget = {
          targetMs,
          pacedTrackProtocol: trackPacedEnabled ? layoutTrackProtocol : null,
          timing:
            'Each original event and calibrated original API invocation through its second animation frame. Every sample must be strictly below the target; missing/incomplete evidence cannot pass. No GPU fence is observed.',
          scope:
            'Selected bounded EMC Layout operations; v2 paced track uses one original API per raw pointer/key event, including independent key down/up. Legacy multi-step operations remain event-only diagnostics.',
          groups,
          requiredTrackOperations: trackPacedOperations,
          withinTarget,
          goalCoverageComplete,
          goalWithinTarget: goalCoverageComplete && withinTarget === true,
        };
        console.log(
          JSON.stringify({ name: 'layout-interaction-target', ...layoutInteractionTarget }),
        );
        if (withinTarget === false) process.exitCode = 1;
      }
      const measuredInputs = reports.filter(
        (report) => report.name !== 'layout-native-wheel' && report.eventToFrameMs?.count > 0,
      );
      editorInputTarget = {
        targetMs,
        timing:
          'Input event timestamp through the second animation frame, including renderer input queue time.',
        measuredOperations: measuredInputs.length,
        applicable: measuredInputs.length > 0,
        withinTarget:
          measuredInputs.length === 0
            ? null
            : measuredInputs.every((report) => report.eventToFrameMs.max < targetMs) &&
              (!modelCadEditEnabled || modelCadCommitTarget.withinTarget) &&
              (!navigationActionTarget || navigationActionTarget.withinTarget) &&
              (!schematicActionTarget || schematicActionTarget.withinTarget) &&
              (!layoutInteractionTarget || layoutInteractionTarget.withinTarget !== false),
        overBudget: measuredInputs
          .filter((report) => report.eventToFrameMs.max >= targetMs)
          .map((report) => ({
            name: report.name,
            maximumMs: report.eventToFrameMs.max,
            p95Ms: report.eventToFrameMs.p95,
          })),
      };
      console.log(JSON.stringify({ name: 'editor-input-target', ...editorInputTarget }));
      if (editorInputTarget.withinTarget === false) process.exitCode = 1;
    },
    { timeoutMs: wallClockMs, label: 'complete benchmark round' },
  );
} catch (error) {
  failure = guard.abort(error);
  if (inputTraceDiagnostic)
    Object.assign(inputTraceDiagnostic, {
      status: 'inconclusive',
      aborted: true,
      failure: failure.message,
    });
  for (const report of reports)
    if (report.status === 'running')
      Object.assign(report, { status: 'aborted', reason: failure.message });
  console.error(`Benchmark stopped; later operations skipped: ${failure.message}`);
  process.exitCode = 1;
} finally {
  failureEvidenceShutdown = await failureEvidenceGate.beforeShutdown(
    failure ?? guard.reason,
    guard.deadlineAtMs,
  );
  nodeDiagnostics.stop();
  guard.dispose();
  if (nativeWheelWorker) {
    try {
      await nativeWheelWorker.close();
    } catch (error) {
      failure ??= error;
      process.exitCode = 1;
    }
  }
  try {
    teardown = await shutdown();
  } catch (error) {
    teardown = { error: error.message };
    process.exitCode = 1;
  }
  if (rendererArtifact?.mode === 'fixed-built-renderer') {
    try {
      rendererArtifact.verificationAfter = await bounded(
        () => verifyRendererArtifact(rendererArtifact),
        5_000,
      );
    } catch (error) {
      rendererArtifact.verificationAfter = {
        unchanged: false,
        error: error.message ?? String(error),
      };
      failure ??= error;
      if (layoutInteractionTarget) layoutInteractionTarget.goalWithinTarget = false;
      process.exitCode = 1;
    }
  }
  try {
    await bounded(
      () =>
        writeFile(
          `test-results/editor-experience-${label}.json`,
          JSON.stringify(
            {
              profile,
              devUrl: process.env.OPENPE_DEV_URL ?? null,
              nextVersion,
              benchmarkSha256,
              benchmarkSourcePath: path.join(profile, 'benchmark-source.mjs'),
              rendererArtifact,
              targetMs,
              coldBootstrap,
              nativeAccessibilityBefore,
              nativeAccessibilityAfter,
              nativeAccessibilityRequest: {
                mode: nativeAccessibilityRequestedMode,
                value: nativeAccessibilityValue ?? null,
              },
              nativeWheelDiagnostic,
              nativeOwnerEvidence,
              status: failure ? 'aborted' : 'complete',
              failure: failure?.message ?? null,
              failureEvidenceShutdown,
              skippedRemainingOperations: Boolean(failure),
              plannedOperations: [...measuredOperations],
              inputTiming: 'Captured input event to the second requestAnimationFrame',
              navigationProtocol:
                'short sequential acknowledged samples with idle pacing; not a 60 Hz sustained stress test',
              comparableWithLegacyQueuedNavigation: false,
              schematicInputProtocols: {
                legacy: {
                  operations: ['schematic-edit', 'schematic-drag'].filter((name) =>
                    measuredOperations.has(name),
                  ),
                  timing:
                    'Whole original API invocation; a steps:10 call includes cumulative gesture duration, not single-event latency.',
                  transportTimeoutMs: 5_000,
                  acknowledgementPacing: false,
                  inputPolicy: null,
                },
                paced: {
                  operations: schematicPacedOperations.filter((name) =>
                    measuredOperations.has(name),
                  ),
                  timing:
                    'Low-frequency single-API inputs; ten original interpolation heads use ten separate public steps:1 calls.',
                  inputPolicy: schematicPacedEnabled ? inputPolicy : null,
                  bootstrapInputPaced: false,
                  sourceInputsPaced: schematicPacedEnabled,
                  comparableWithLegacyContinuousGesture: false,
                },
              },
              safety: {
                wallClockMs,
                inputPolicy,
                panInputs: 6,
                zoomInputs: 4,
                wheelDelta: 50,
                window: { width: 1100, height: 740 },
                deviceScaleFactor: 'native, unchanged',
              },
              inputAcknowledgements: inputs.samples,
              nodeInputDiagnostics: {
                ...nodeDiagnostics.snapshot(),
                ...(nodeDiagnosticsSource ? { source: nodeDiagnosticsSource } : {}),
              },
              teardown,
              cpuSampling: process.env.OPENPE_PROFILE_CPU === '1',
              traceRecording: traceCaptureEnabled,
              traceRequested: recordTrace,
              traceMode: recordTrace ? traceMode : null,
              inputTraceDiagnostic,
              domObservation: process.env.OPENPE_PROFILE_DOM === '1',
              layoutCommitTarget,
              layoutInteractionTarget,
              modelCadCommitTarget,
              navigationActionTarget,
              schematicActionTarget,
              editorInputTarget,
              reports,
            },
            null,
            2,
          ),
        ),
      2_000,
    );
  } finally {
    await releaseLock();
  }
}
