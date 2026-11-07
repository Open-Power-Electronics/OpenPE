import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { createAgentCapabilityBridge } from '../server/agent-capabilities.mjs';
import { runAgent } from '../server/agents.mjs';

// Opt-in real provider regression. No Electron, native file grant or solver is
// exposed. The Agent edits an in-memory ProjectCore; the test exports native
// artifacts only after its turn settles and labels failures explicitly.
const args = process.argv.slice(2);
if (!args.includes('--run-agent'))
  throw new Error('Use --run-agent to opt into the real Codex provider. No provider was launched.');
if (args.some((arg) => arg !== '--run-agent' && !/^--timeout-ms=\d+$/.test(arg)))
  throw new Error(
    'Usage: node scripts/check-schematic-drafting-agent.mjs --run-agent [--timeout-ms=600000]',
  );
if (args.filter((arg) => arg.startsWith('--timeout-ms=')).length > 1)
  throw new Error('Choose one provider deadline.');
const timeoutMs = Number(args.find((arg) => arg.startsWith('--timeout-ms='))?.slice(13) ?? 600000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  throw new Error('Choose a positive integer provider deadline.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(root, 'test-results/demos/lm25017-8v-20261107/design');
const sourceProject = path.join(sourceDirectory, 'lm25017-8v.kicad_pro');
const outputRoot = path.join(root, 'test-results');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'schematic-drafting-agent-'));
const cwd = path.join(output, 'agent-runtime');
const beforeDirectory = path.join(output, 'before');
const candidateDirectory = path.join(output, 'candidate');
const toolsDirectory = path.join(output, 'tools');
await mkdir(cwd);
await mkdir(toolsDirectory);
console.log('OUTPUT ' + output);

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const { ProjectCore } = await tsImport('../core/project-core.ts', import.meta.url);
const { createCapabilityHost } = await tsImport('../api/capabilities.ts', import.meta.url);
const { registerProjectCapabilities } = await tsImport(
  '../core/register-project.ts',
  import.meta.url,
);
const { projectFromNativeFiles, serializeProject, projectSchematics } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { projectNetGroups, projectPhysicalNetGroups } = await tsImport(
  '../lib/project-net-groups.ts',
  import.meta.url,
);
const { partFields, unitGraphics } = await tsImport('../lib/library.ts', import.meta.url);
const { symbolRole } = await tsImport('../lib/symbol-role.ts', import.meta.url);
const { child, children, val } = await tsImport('../lib/sexpr.ts', import.meta.url);
const { agentProject } = await tsImport('../lib/agent-project-access.ts', import.meta.url);
const { resolveAgentCapability } = await tsImport('../lib/chat-stream.ts', import.meta.url);

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
const inside = (directory, name) => {
  const result = path.resolve(directory, name);
  const relative = path.relative(directory, result);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Artifact path leaves its dedicated directory.');
  return result;
};
async function hashTree(directory) {
  const result = {};
  const visit = async (current) => {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error('Linked project artifacts are unsupported: ' + current);
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await visit(path.join(current, name));
    } else {
      if (!info.isFile()) throw new Error('Non-regular project artifact: ' + current);
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(current)) hash.update(bytes);
      result[path.relative(directory, current).split(path.sep).join('/')] = {
        bytes: info.size,
        sha256: hash.digest('hex'),
      };
    }
  };
  const resolved = await realpath(directory);
  assert.equal(
    resolved.toLowerCase(),
    path.resolve(directory).toLowerCase(),
    'Project path must not traverse links.',
  );
  await visit(directory);
  return result;
}
const bytesOf = (file) => {
  if (file.encoding !== undefined && file.encoding !== 'latin1')
    throw new Error('Unsupported native encoding.');
  return Buffer.from(file.source, file.encoding ?? 'utf8');
};
function componentSemantics(project) {
  return projectSchematics(project).map((schematic) => ({
    id: schematic.id,
    components: schematic.parts
      .map((part) => ({
        id: part.id,
        reference: part.ref,
        libraryId: part.libId,
        unit: part.unit ?? 1,
        value: part.value,
        excluded: part.excludeFromSimulation ?? false,
        fields: partFields(part),
        pins: unitGraphics(schematic.libraries[part.libId], part.unit || 1)
          .flatMap((unit) => children(unit, 'pin'))
          .map((pin) => ({
            number: val(child(pin, 'number')),
            name: val(child(pin, 'name')),
            type: val(pin),
          })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.unit - b.unit),
    librariesSha256: digest(canonical(schematic.libraries)),
  }));
}
function partitions(project) {
  return projectSchematics(project).map((schematic) => ({
    id: schematic.id,
    nets: projectNetGroups(schematic)
      .map((group) => [...new Set(group.pins.filter((pin) => !pin.startsWith('physical:')))].sort())
      .filter((group) => group.length)
      .sort((a, b) => canonical(a).localeCompare(canonical(b))),
  }));
}
function draftingMetrics(project, observation) {
  const circuit = project.schematic;
  const markers = new Set(
    circuit.parts
      .filter((part) => symbolRole(circuit.libraries[part.libId], part) === 'marker')
      .map((part) => part.id),
  );
  const groups = projectPhysicalNetGroups(circuit).map((group) => ({
    wires: group.wires.length,
    pins: [
      ...new Set(
        group.pins.filter(
          (pin) => !pin.startsWith('physical:') && !markers.has(JSON.parse(pin)[0]),
        ),
      ),
    ],
  }));
  const total = groups.reduce((count, group) => count + group.pins.length, 0);
  const directlyWired = groups
    .filter((group) => group.wires > 0 && group.pins.length > 1)
    .reduce((count, group) => count + group.pins.length, 0);
  return {
    counts: observation.counts,
    truncated: observation.truncated,
    labelLinks: observation.labelLinks,
    directlyWiredPins: directlyWired,
    nonMarkerPins: total,
    directlyWiredPinRatio: total ? directlyWired / total : 0,
  };
}

const startedAt = new Date().toISOString();
const started = performance.now();
const report = {
  outcome: 'running',
  sourceProject,
  output,
  startedAt,
  timeoutMs,
  provider: 'codex',
  solverExecuted: false,
};
let logQueue = Promise.resolve();
const record = (event) => {
  const row = { elapsedMs: Math.round(performance.now() - started), ...event };
  logQueue = logQueue.then(() =>
    appendFile(path.join(output, 'events.jsonl'), JSON.stringify(row) + '\n'),
  );
};
let core, host, dispose, unsubscribe, bridge;
let transcript = '';
const controller = new AbortController();
const pending = new Set();
const onInterrupt = () => controller.abort();
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
try {
  const inputHashes = await hashTree(sourceDirectory);
  report.inputFileCount = Object.keys(inputHashes).length;
  await cp(sourceDirectory, beforeDirectory, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  assert.deepEqual(
    await hashTree(beforeDirectory),
    inputHashes,
    'The complete before copy must preserve every input file.',
  );
  const native = await readNativeProject(sourceProject);
  const project = projectFromNativeFiles(native);
  core = new ProjectCore(project, { nativeEntryName: native.entry });
  const baseline = core.getSnapshot().project;
  const baselineNative = core.getNativeFiles();
  host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const queryNames = new Set([
    'core.state',
    'project.snapshot',
    'project.get',
    'project.source',
    'source.get',
    'source.files',
    'history.get',
    'schematic.list',
    'schematic.get',
    'schematic.drafting',
    'schematic.erc',
  ]);
  const commandNames = new Set([
    'schematic.move',
    'schematic.drag',
    'schematic.transform',
    'schematic.pose',
    'schematic.delete',
    'schematic.label',
    'schematic.text.position',
    'schematic.wire',
    'schematic.wires',
    'schematic.simplify',
    'part.properties',
    'history.undo',
    'history.redo',
  ]);
  // Register the actual Core handlers, retaining only this redraw scope. The
  // discovery catalog reflects these registrations; omitted authority is absent.
  dispose = registerProjectCapabilities(
    {
      ...host,
      register: (definition) =>
        (definition.kind === 'query' ? queryNames : commandNames).has(definition.id)
          ? host.register(definition)
          : () => {},
    },
    core,
  );
  unsubscribe = host.subscribe((event) => record({ type: 'capability-event', event }));
  const adapter = {
    query: (name, input, options = {}) => host.query(name, input, { ...options, actor: 'agent' }),
    execute: (name, input, options = {}) =>
      host.execute(name, input, { ...options, actor: 'agent' }),
    observe: (after) => host.observe(after),
  };
  const before = await core.query('schematic.drafting', { schematicId: baseline.schematic.id });
  report.before = draftingMetrics(baseline, before);
  await writeFile(path.join(output, 'before-drafting.json'), json(before));
  const revision = { current: String(core.getSnapshot().revision) };
  const calls = [];
  bridge = createAgentCapabilityBridge({
    sessionId: randomUUID(),
    origin: 'schematic-drafting-regression',
    signal: controller.signal,
    emit: (event) => {
      const index = calls.length + 1;
      const call = {
        index,
        tool: event.tool,
        arguments: structuredClone(event.arguments),
        startedAt: new Date().toISOString(),
      };
      calls.push(call);
      record({ type: 'tool-start', ...call });
      console.log('TOOL ' + index + ' ' + event.tool + ' ' + (event.arguments.name ?? 'events'));
      const respond = (payload) =>
        bridge.respond(
          {
            sessionId: event.sessionId,
            runId: event.runId,
            requestId: event.requestId,
            token: event.token,
            ...payload,
          },
          'schematic-drafting-regression',
        );
      const work = (async () => {
        try {
          const result = await resolveAgentCapability(
            event,
            adapter,
            'auto',
            () => {
              throw new Error(
                'This opt-in regression uses the shared Auto execution path, not queued reviews.',
              );
            },
            controller.signal,
            revision,
          );
          await writeFile(
            path.join(toolsDirectory, `${String(index).padStart(3, '0')}.json`),
            json({ ...call, result }),
          );
          call.completed = true;
          record({
            type: 'tool-completed',
            index,
            resultFile: `tools/${String(index).padStart(3, '0')}.json`,
          });
          respond({ result });
        } catch (error) {
          call.error = error.message;
          record({ type: 'tool-failed', index, error: error.message });
          if (!controller.signal.aborted)
            respond({ error: String(error.message).slice(0, 4000) || 'Capability failed.' });
        }
      })();
      pending.add(work);
      void work
        .finally(() => pending.delete(work))
        .catch((error) => record({ type: 'delivery-failed', index, error: error.message }));
    },
  });
  const prompt =
    "Redraw this existing LM25017 Fly-Buck electrical schematic so an engineer can read it as a connected circuit. Reply in English. This is a presentation redraw of the existing nominal 8 V design: preserve EVERY component ID/reference/value, symbol/pin mapping, hidden fields, model binding, participation flag and complete pin-to-net partition. Do not change the circuit design, run a solver or claim new simulation results. Preserve all PCB bytes and supporting files.\nUse the new schematic.drafting query for actual transformed pin anchors and body bounds. Start with a compact functional-block plan: input at left, controller and local bypass/UVLO/bootstrap/feedback network together, continuous SW-to-primary-winding-to-output power path, and the isolated rectifier/output grouped beside its winding. Keep local FB/ripple/bypass/bootstrap connections as ordinary orthogonal wires. Use sparse justified power or genuinely distant interface labels, not a separate repeated label on every pin.\nReposition existing connected parts with schematic.drag or the shared connected pose so attached geometry follows. Retain exact imported anchors even off-grid. ADD the intended direct routes while the old label-linked nets still hold electrical connectivity; use schematic.wires to commit your explicitly planned routes in batches. Once the direct paths exist, remove ONLY redundant labels or obsolete isolated stubs carefully. Keep one caption label for each existing net name where needed so the native PCB's net identities and bytes remain stable. Do not delete all wiring first, change values, create replacement components, use a whole-project replacement, or silently substitute a model. Existing wire geometry may change; electrical pin groups must not.\nRead schematic.drafting again to review physical islands and avoidable local label links. Aim for substantial improvement over this fixture's pin-label islands, not a global prohibition on legitimate remote labels. Verify complete current connectivity, and distinguish drafting advice from separate ERC evidence.\nThis test exposes only a scoped in-process Core and its real validated commands. There is no native Save/project-file host, library placement, renderer camera or solver authority. Do not ask to open/save a path. Finish after the accepted Core redraw with a concise actual result; the harness will export the native KiCad files and verify semantics independently.";
  await writeFile(path.join(output, 'prompt.txt'), prompt + '\n');
  const context = {
    id: baseline.schematic.id,
    workspace: {
      version: 1,
      capturedAt: new Date().toISOString(),
      project: agentProject(JSON.parse(serializeProject(baseline))),
      source: { pending: false, draft: null, error: '', draftCharacters: 0 },
      ui: {
        view: 'canvas',
        activeSchematicId: baseline.schematic.id,
        revision: revision.current,
        selection: [],
      },
      simulation: { status: 'not-opened' },
    },
  };
  report.providerResult = await runAgent(
    'codex',
    { prompt, context, history: [], effort: 'medium' },
    cwd,
    (event) => {
      record({ type: 'provider-event', event });
      if (event.type === 'text') transcript += (transcript ? '\n\n' : '') + event.text;
      else if (event.type === 'text-delta') transcript += event.delta;
      else if (event.type === 'text-replace') transcript = event.text;
      if (event.type === 'status' || event.type === 'error')
        console.log(event.type.toUpperCase() + ' ' + event.text);
      if (event.type === 'agent-info') report.observedAgent = event;
    },
    controller.signal,
    { capabilities: bridge, timeoutMs },
  );
  bridge.close();
  controller.abort();
  await Promise.allSettled([...pending]);
  const final = core.getSnapshot();
  const after = await core.query('schematic.drafting', { schematicId: baseline.schematic.id });
  report.after = draftingMetrics(final.project, after);
  report.calls = calls;
  report.efficiency = {
    toolCalls: calls.length,
    queryCalls: calls.filter((call) => call.tool === 'openpe_query').length,
    commandCalls: calls.filter((call) => call.tool === 'openpe_execute').length,
    modelArgumentBytes: calls.reduce(
      (sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments)),
      0,
    ),
    failedCalls: calls.filter((call) => call.error).length,
    measure: 'UTF-8 tool argument bytes, not provider tokens or overall model output.',
  };
  await writeFile(path.join(output, 'after-drafting.json'), json(after));
  await cp(sourceDirectory, candidateDirectory, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  assert.deepEqual(
    await hashTree(candidateDirectory),
    inputHashes,
    'Pre-existing candidate files must be copied without substitutions.',
  );
  const candidateNative = core.getNativeFiles();
  for (const file of candidateNative.files) {
    const target = inside(candidateDirectory, file.name);
    const bytes = bytesOf(file);
    let current;
    try {
      current = await readFile(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!current?.equals(bytes)) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  // Reparse actual exported native files, not a private editor snapshot.
  const exported = projectFromNativeFiles(
    await readNativeProject(path.join(candidateDirectory, native.entry)),
  );
  const candidateHashes = await hashTree(candidateDirectory);
  const inputAfter = await hashTree(sourceDirectory);
  const unchangedFiles = Object.keys(inputHashes).filter(
    (name) => !name.toLowerCase().endsWith('.kicad_sch'),
  );
  const baselineFiles = new Map(baselineNative.files.map((file) => [file.name, file]));
  const finalFiles = new Map(candidateNative.files.map((file) => [file.name, file]));
  const unchangedNative = [...baselineFiles].filter(
    ([name]) => !name.toLowerCase().endsWith('.kicad_sch'),
  );
  report.checks = {
    providerCompleted: report.providerResult.outcome === 'completed',
    noSourceDraft: final.sourceDraft === null,
    inputFilesUnchanged: canonical(inputHashes) === canonical(inputAfter),
    allPreExistingFilesRetained: Object.keys(inputHashes).every((name) =>
      Object.hasOwn(candidateHashes, name),
    ),
    nonSchematicFileBytesPreserved: unchangedFiles.every(
      (name) => canonical(inputHashes[name]) === canonical(candidateHashes[name]),
    ),
    nativeFileMembershipPreserved:
      canonical([...baselineFiles.keys()].sort()) === canonical([...finalFiles.keys()].sort()),
    nonSchematicNativeBytesPreserved: unchangedNative.every(
      ([name, file]) => finalFiles.has(name) && bytesOf(file).equals(bytesOf(finalFiles.get(name))),
    ),
    componentValuesIdsFieldsModelsAndPinsPreserved:
      canonical(componentSemantics(baseline)) === canonical(componentSemantics(exported)),
    completePinPartitionsPreserved:
      canonical(partitions(baseline)) === canonical(partitions(exported)),
    completeDraftingObservation: !before.truncated && !after.truncated,
    noNewDiagonalWiresOnThisFixture: after.counts.diagonalWires <= before.counts.diagonalWires,
    fewerLabelLinkedNetsOnThisFixture: after.counts.labelLinkedNets < before.counts.labelLinkedNets,
    fewerSinglePinStubIslandsOnThisFixture:
      after.counts.singlePinStubIslands < before.counts.singlePinStubIslands,
    greaterDirectWirePinRatioOnThisFixture:
      report.after.directlyWiredPinRatio > report.before.directlyWiredPinRatio,
    actualBatchWireEdit: calls.some(
      (call) =>
        call.tool === 'openpe_execute' &&
        call.arguments.name === 'schematic.wires' &&
        call.completed,
    ),
    draftingAuditUsed: calls.some(
      (call) =>
        call.tool === 'openpe_query' &&
        call.arguments.name === 'schematic.drafting' &&
        call.completed,
    ),
  };
  report.outcome = Object.values(report.checks).every(Boolean) ? 'passed' : 'failed';
  report.visualAcceptance =
    'Not implied by Core or efficiency metrics; requires independent visual comparison.';
  report.passedCoreChecksNativeDirectory = report.outcome === 'passed' ? candidateDirectory : null;
  report.candidateNativeDirectory = candidateDirectory;
  report.inputFiles = inputHashes;
  report.candidateFiles = candidateHashes;
  report.scope =
    'Actual provider and Core edit behavior; fixture-relative drafting improvement, not generic style certification or a new simulation result.';
  await writeFile(
    path.join(output, 'candidate-status.md'),
    `# ${report.outcome === 'passed' ? 'Core redraw checks passed; visual review required' : 'Failed redraw candidate'}\n\nThis is a native KiCad test artifact. Original source files were read-only. The candidate is ${report.outcome === 'passed' ? "verified only by this regression's preservation and physical-island checks" : 'not an accepted design; inspect report.json for failed checks'}. Existing spice/ files were copied as pre-existing evidence, not recalculated or certified for the redraw. No solver or native Save host ran. Visual quality is not accepted by these metrics; compare the actual drawing against an approved reference.\n`,
  );
} catch (error) {
  report.outcome = 'failed';
  report.error = error.stack ?? error.message;
  report.passedCoreChecksNativeDirectory = null;
  console.error(error.message);
} finally {
  controller.abort();
  bridge?.close();
  await Promise.allSettled([...pending]);
  dispose?.();
  unsubscribe?.();
  host?.dispose();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  await logQueue;
  await writeFile(path.join(output, 'transcript.txt'), transcript + '\n');
  report.endedAt = new Date().toISOString();
  report.elapsedSeconds = (performance.now() - started) / 1000;
  await writeFile(path.join(output, 'report.json'), json(report));
  console.log('RESULT ' + report.outcome + ' ' + path.join(output, 'report.json'));
  if (report.outcome !== 'passed') process.exitCode = 1;
}
