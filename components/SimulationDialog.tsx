'use client';
import QuantityInput from './QuantityInput';
import { quantityUnitFromLabel, quantityLabel } from './quantity-units';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Play, Square, X } from 'lucide-react';
import Select from './Select';
import { api } from '@/lib/bridge';
import { serializeProject, type Project } from '@/lib/project';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
  SPICE_PORT,
  SPICE_SWITCH,
  type SimulationResult,
  type TransientConfig,
} from '@/lib/spice';
import { createPortal } from 'react-dom';
import SimulationWaveforms from './SimulationWaveforms';
import AnalysisComponents from './AnalysisComponents';
import SavedResultLoading, { type SavedResultLoadingStage } from './SavedResultLoading';
import { paintAnalysisLoading } from '@/lib/analysis-loading';
import { tiPart } from '@/lib/ti-dcdc';
import { type ProbeTarget, spiceNets } from '@/lib/spice';
import { validatedSimulationResult } from '@/lib/waveform';
import { appendSimulationSamples, readSimulationEvents } from '@/lib/simulation-stream';
import { displayPartValue } from '@/lib/library';
import { isModelBuck } from '@/lib/spice-buck';
import { exampleSimulationProfile } from '@/lib/spice-examples';
import { isEmcFlyback } from '@/lib/spice-emc-flyback';
import { participatesInSimulation, simulationParts } from '@/lib/simulation-participation';
import { symbolRole } from '@/lib/symbol-role';
import { validateSimulationModels, type SimulationModelReference } from '@/lib/simulation-models';
import { circuitFingerprint } from '@/lib/circuit';
import {
  agentSimulationContext,
  type AgentSimulationContext,
  type AgentWaveformPresentation,
} from '@/context/agent-simulation-context';
import { createCapabilityHost, type CapabilityHost } from '@/api/capabilities';
import {
  registerSimulationCapabilities,
  type SimulationCapabilityAdapter,
  type SimulationConfigurationInput,
  type SimulationProbesInput,
} from '@/lib/simulation-capabilities';
import { SPICE_PLUGIN_ID, workbenchPluginAvailability } from '@/lib/workbench-plugins';

const numericFields = [
  ['voltage', 'Input voltage (V)', 1],
  ['frequency', 'PWM frequency (kHz)', 1000],
  ['duty', 'Duty cycle (%)', 1],
  ['stop', 'Duration (ms)', 0.001],
  ['step', 'Max. time step (µs)', 0.000001],
] as const;
type NumericKey = (typeof numericFields)[number][0];
const formatted = (v: number) => Number(v.toPrecision(5)).toString();

export default function SimulationDialog({
  project,
  settingsHost,
  visible,
  onCloseSettings,
  sourcePending,
  probe,
  waveformHost,
  onWaveformVisibilityChange,
  onStoreModels,
  fileId,
  agentContextRef,
  capabilityHost,
  onParticipationChange,
  onLocatePart,
}: {
  project: Project;
  settingsHost: RefObject<HTMLDivElement | null>;
  visible: boolean;
  onCloseSettings?: () => void;
  sourcePending: boolean;
  probe: ProbeTarget | null;
  waveformHost: RefObject<HTMLDivElement | null>;
  onWaveformVisibilityChange: (open: boolean) => void;
  onStoreModels?: (models: SimulationModelReference[], expectedSource: string) => boolean;
  fileId?: string;
  agentContextRef?: RefObject<(() => AgentSimulationContext) | null>;
  capabilityHost?: CapabilityHost;
  onParticipationChange?: (partId: string, included: boolean) => boolean;
  onLocatePart?: (partId: string) => boolean;
}) {
  const [localCapabilityHost] = useState(createCapabilityHost);
  const host = capabilityHost ?? localCapabilityHost;
  const participationComposing = useRef(false);
  const capabilityAdapter = useRef<SimulationCapabilityAdapter | null>(null);
  const renderWaiters = useRef<
    {
      resolve: (state: unknown) => void;
      reject: (error: Error) => void;
      signal: AbortSignal;
      abort: () => void;
    }[]
  >([]);
  const [, refreshCapabilityState] = useState(0);
  const basis = useMemo(() => circuitFingerprint(project.schematic), [project.schematic]);
  const waveformPresentation = useRef<AgentWaveformPresentation | null>({
    layout: 'auto',
    linked: true,
    visibleCursors: [true, false],
    traces: {},
  });
  const requestSource = useMemo(() => serializeProject(project), [project]);
  // Adding verified model references does not change the circuit or invalidate its samples.
  const source = useMemo(() => {
    const circuit = { ...project };
    delete circuit.simulationModels;
    return serializeProject(circuit);
  }, [project]);
  const curatedExample =
    isEmcFlyback(project.schematic) || !!exampleSimulationProfile(project.schematic);
  const modelBuck = isModelBuck(project.schematic) || curatedExample;
  const initial = useMemo(() => defaultTransient(project.schematic), [project.schematic]);
  const supportError = useMemo(
    () => simulationSupportError(project.schematic),
    [project.schematic],
  );
  const components = useMemo(
    () =>
      [
        ...new Map(
          project.schematic.parts
            .filter(
              (part) => symbolRole(project.schematic.libraries[part.libId], part) !== 'marker',
            )
            .map((part) => [part.ref, part]),
        ).values(),
      ].map((part) => ({ id: part.id, reference: part.ref, part })),
    [project.schematic.parts, project.schematic.libraries],
  );
  const [selection, setSelection] = useState(initial);
  const vendor = tiPart(
    project.schematic.parts.find((p) => p.id === selection.switchId)?.libId || '',
  );
  const [drafts, setDrafts] = useState<Record<NumericKey, string>>(
    () =>
      Object.fromEntries(
        numericFields.map(([key, , scale]) => [key, formatted(initial[key] / scale)]),
      ) as Record<NumericKey, string>,
  );
  const [status, setStatus] = useState<{
    available: boolean;
    version?: string;
    error?: string;
  } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [savedResultStage, setSavedResultStage] = useState<SavedResultLoadingStage>('reading');
  const [error, setError] = useState('');
  const [convergenceFailure, setConvergenceFailure] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [storedResult, setResult] = useState<SimulationResult | null>(null);
  const [liveResult, setLiveResult] = useState<SimulationResult | null>(null);
  const [runConfig, setRunConfig] = useState<TransientConfig | null>(null);
  const [resultKey, setResultKey] = useState(0);
  const resultSource = useRef('');
  const result =
    resultSource.current === source && !sourcePending ? (liveResult ?? storedResult) : null;
  const [selected, setSelected] = useState<string[]>([]);
  const [probeMessage, setProbeMessage] = useState('');
  const [requestedProbe, setRequestedProbe] = useState<{
    source: string;
    target: ProbeTarget;
  } | null>(null);
  const [restoredWaveformSource, setRestoredWaveformSource] = useState<string | null>(null);
  const settingsEdited = useRef(false);
  const restoreSuppressed = useRef(false);
  const handledProbe = useRef<ProbeTarget | null>(null);
  const waveformOpen =
    (requestedProbe?.source === source || restoredWaveformSource === source) && !sourcePending;
  useLayoutEffect(() => {
    onWaveformVisibilityChange(waveformOpen);
  }, [waveformOpen, onWaveformVisibilityChange]);
  const runControl = useRef<AbortController | null>(null);
  const detectControl = useRef<AbortController | null>(null);
  const loadControl = useRef<AbortController | null>(null);
  const currentSource = useRef(source);
  currentSource.current = source;
  const pendingSource = useRef(sourcePending);
  pendingSource.current = sourcePending;
  const settingsVisible = useRef(visible);
  settingsVisible.current = visible;
  const config = useMemo(
    () =>
      ({
        ...(modelBuck ? initial : selection),
        ...Object.fromEntries(
          numericFields
            .filter(([key]) => !modelBuck || key === 'stop' || key === 'step')
            .map(([key, , scale]) => [key, drafts[key].trim() ? Number(drafts[key]) * scale : NaN]),
        ),
      }) as TransientConfig,
    [selection, drafts, modelBuck, initial],
  );
  const canRestoreTiming =
    curatedExample &&
    convergenceFailure &&
    (config.stop !== initial.stop || config.step !== initial.step);
  const preview = useMemo(() => {
    try {
      return { deck: buildSpiceDeck(project.schematic, config), error: '' };
    } catch (e) {
      return { deck: null, error: (e as Error).message };
    }
  }, [project.schematic, config]);
  const settingsError = [
    sourcePending ? 'Apply Source edits before simulating.' : '',
    supportError || preview.error,
    status?.error,
    error,
  ]
    .filter(Boolean)
    .join('\n');
  async function detect() {
    detectControl.current?.abort();
    const control = new AbortController();
    detectControl.current = control;
    setDetecting(true);
    try {
      const response = await api('simulation/status', { signal: control.signal });
      const data = await response.json();
      if (!control.signal.aborted) setStatus(data);
    } catch (e) {
      if (!control.signal.aborted) setStatus({ available: false, error: (e as Error).message });
    } finally {
      if (!control.signal.aborted) setDetecting(false);
    }
  }
  useEffect(() => {
    return () => {
      runControl.current?.abort();
      detectControl.current?.abort();
      loadControl.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (visible) {
      restoreSuppressed.current = false;
      void detect();
    } else {
      detectControl.current?.abort();
      setDetecting(false);
      if (runControl.current) {
        runControl.current.abort();
        setError('Simulation cancelled.');
      }
    }
  }, [visible]);
  useEffect(() => {
    settingsEdited.current = false;
    setSelection(initial);
    setDrafts(
      Object.fromEntries(
        numericFields.map(([key, , scale]) => [key, formatted(initial[key] / scale)]),
      ) as Record<NumericKey, string>,
    );
  }, [project.schematic.id]);
  useEffect(() => {
    restoreSuppressed.current = false;
    setResult(null);
    setLiveResult(null);
    setStopped(false);
    setRunConfig(null);
    setSelected([]);
    setProbeMessage('');
    setRequestedProbe(null);
    setRestoredWaveformSource(null);
    setConvergenceFailure(false);
    if (runControl.current) {
      runControl.current.abort();
      setError('The project changed. Run the simulation again.');
    }
  }, [source, sourcePending]);
  useEffect(() => {
    if (
      !visible ||
      sourcePending ||
      !fileId ||
      (!preview.deck && settingsEdited.current) ||
      result ||
      running ||
      restoreSuppressed.current
    )
      return;
    const control = new AbortController();
    loadControl.current = control;
    setSavedResultStage('reading');
    setLoadingSaved(true);
    const snapshot = source;
    const discover = !settingsEdited.current;
    void (async () => {
      try {
        await paintAnalysisLoading(control.signal);
        const response = await api('simulation/result', {
          method: 'POST',
          signal: control.signal,
          body: JSON.stringify({ source: requestSource, ...(discover ? {} : { config }), fileId }),
        });
        control.signal.throwIfAborted();
        if (loadControl.current !== control) return;
        setSavedResultStage('preparing');
        await paintAnalysisLoading(control.signal);
        const received = await response.json();
        if (
          control.signal.aborted ||
          loadControl.current !== control ||
          currentSource.current !== snapshot ||
          pendingSource.current ||
          !settingsVisible.current ||
          runControl.current
        )
          return;
        if (!received.result) return;
        if (!received.config) throw new Error('The saved simulation settings are missing.');
        const restoredConfig = received.config as TransientConfig;
        const deck = buildSpiceDeck(project.schematic, restoredConfig);
        if (
          !discover &&
          Object.keys(config).some(
            (key) =>
              restoredConfig[key as keyof TransientConfig] !== config[key as keyof TransientConfig],
          )
        )
          throw new Error('The saved simulation settings do not match this lookup.');
        const data = validatedSimulationResult(received.result, deck);
        resultSource.current = snapshot;
        if (discover) {
          setSelection(restoredConfig);
          setDrafts(
            Object.fromEntries(
              numericFields.map(([key, , scale]) => [key, String(restoredConfig[key] / scale)]),
            ) as Record<NumericKey, string>,
          );
        }
        setRunConfig(restoredConfig);
        setStopped(false);
        setResultKey((key) => key + 1);
        setResult(data);
        setRestoredWaveformSource(snapshot);
        setSelected((items) => {
          const retained = items.filter((vector) =>
            data.traces.some((trace) => trace.vector === vector),
          );
          if (retained.length) return retained;
          const output =
            data.traces.find(
              (trace) =>
                trace.unit === 'V' &&
                trace.targets?.some(
                  (target) => target.kind === 'voltage' && target.id === restoredConfig.outputId,
                ),
            ) ??
            data.traces.find((trace) => trace.unit === 'V') ??
            data.traces[0];
          return output ? [output.vector] : [];
        });
        setError('');
        setProbeMessage('');
      } catch (failure) {
        if (!control.signal.aborted && currentSource.current === snapshot)
          setError((failure as Error).message.split(/\r?\n/, 1)[0]);
      } finally {
        if (loadControl.current === control) {
          loadControl.current = null;
          setLoadingSaved(false);
        }
      }
    })();
    return () => {
      control.abort();
      if (loadControl.current === control) {
        loadControl.current = null;
        setLoadingSaved(false);
      }
    };
  }, [
    visible,
    sourcePending,
    fileId,
    preview.deck,
    result,
    running,
    source,
    requestSource,
    config,
  ]);
  useEffect(() => {
    // Only a fresh canvas click creates probe intent; saved-result restoration
    // owns its separate dock intent. Stale probes cannot survive document edits.
    if (probe === handledProbe.current) return;
    handledProbe.current = probe;
    if (!probe || sourcePending) return;
    // A probe from another schematic must not attach itself to newly completed data.
    if (
      ![
        ...project.schematic.parts,
        ...project.schematic.wires,
        ...project.schematic.labels,
        ...project.schematic.junctions,
      ].some((item) => item.id === probe.id)
    )
      return;
    void host
      .execute('simulation.probes', { target: probe }, { actor: 'human' })
      .catch((failure) => setProbeMessage((failure as Error).message));
  }, [probe, source, sourcePending]);
  useEffect(() => {
    if (!requestedProbe || requestedProbe.source !== source || sourcePending) return;
    const probe = requestedProbe.target;
    const part = project.schematic.parts.find((p) => p.id === probe.id);
    if (part && !participatesInSimulation(part)) {
      setProbeMessage(
        'This component is excluded from simulation. Enable it under Components in SPICE Simulation to inspect it.',
      );
      return;
    }
    if (!result) {
      setProbeMessage(
        running ? 'Simulation is running…' : 'Run the simulation to inspect this point.',
      );
      return;
    }
    const trace = result.traces.find((t) =>
      t.targets?.some(
        (target) =>
          target.kind === probe.kind && target.id === probe.id && target.pin === probe.pin,
      ),
    );
    if (trace) {
      setSelected((items) => [trace.vector, ...items.filter((vector) => vector !== trace.vector)]);
      setProbeMessage('');
    } else {
      const ground =
        probe.kind === 'voltage' &&
        spiceNets(project.schematic)
          .probeNodes()
          .some(
            (entry) =>
              entry.node === '0' && entry.target.id === probe.id && entry.target.pin === probe.pin,
          );
      setProbeMessage(
        ground
          ? 'Ground reference: 0 V.'
          : 'No current trace for this object. Probe a connected pin or wire for voltage.',
      );
    }
  }, [requestedProbe, result, sourcePending, source, running]);
  async function run(signal: AbortSignal) {
    if (!preview.deck)
      throw new Error(preview.error || 'This circuit does not support simulation.');
    if (runControl.current) throw new Error('A simulation is already running.');
    if (sourcePending) throw new Error('Apply Source edits before simulating.');
    if (!visible) throw new Error('Open Simulation before starting a transient run.');
    if (loadingSaved || (loadControl.current && !loadControl.current.signal.aborted))
      throw new Error('Wait for the saved simulation lookup to finish before running.');
    if (signal.aborted) throw new Error('Simulation cancelled.');
    loadControl.current?.abort();
    restoreSuppressed.current = true;
    settingsEdited.current = true;
    const control = new AbortController();
    const abort = () => control.abort();
    signal.addEventListener('abort', abort, { once: true });
    runControl.current = control;
    const snapshot = source;
    setRunning(true);
    setStopped(false);
    setError('');
    setConvergenceFailure(false);
    setResult(null);
    setLiveResult(null);
    setRunConfig(config);
    setResultKey((key) => key + 1);
    resultSource.current = snapshot;
    const live: { result: SimulationResult | null } = { result: null };
    let received: unknown;
    try {
      const response = await api('simulation/transient', {
        method: 'POST',
        body: JSON.stringify({ source: requestSource, config, ...(fileId ? { fileId } : {}) }),
        signal: control.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!response.body) throw new Error('Simulation stream is unavailable. Restart OpenPE.');
        await readSimulationEvents(response.body, (event) => {
          if (control.signal.aborted || currentSource.current !== snapshot || pendingSource.current)
            return;
          if (event.type === 'retry') {
            live.result = null;
            setLiveResult(null);
            setResultKey((key) => key + 1);
          } else if (event.type === 'samples') {
            live.result = appendSimulationSamples(live.result, event, preview.deck!);
            if (live.result.time.length >= 2) setLiveResult(live.result);
          } else if (event.type === 'result') received = event.result;
        });
      } else received = await response.json();
      if (control.signal.aborted) throw new Error('Simulation cancelled.');
      const completed = received as SimulationResult & {
        simulationModels?: SimulationModelReference[];
      };
      const data = validatedSimulationResult(completed, preview.deck);
      validateSimulationModels(completed.simulationModels);
      if (!control.signal.aborted && currentSource.current === snapshot && !pendingSource.current) {
        if (
          completed.simulationModels?.length &&
          onStoreModels &&
          !onStoreModels(completed.simulationModels, requestSource)
        )
          throw new Error('The project changed. Run the simulation again to store its models.');
        resultSource.current = snapshot;
        setResult(data);
        setLiveResult(null);
        setSelected((items) =>
          items.filter((vector) => data.traces.some((trace) => trace.vector === vector)),
        );
        setProbeMessage('');
      } else {
        throw new Error('The project changed. Run the simulation again.');
      }
    } catch (e) {
      if (
        control.signal.reason === 'stop' &&
        !signal.aborted &&
        currentSource.current === snapshot &&
        !pendingSource.current &&
        settingsVisible.current
      ) {
        // Explicit Stop retains only the validated samples already received by this run.
        // It never promotes them to completed results or commits portable model references.
        if (live.result && live.result.time.length >= 2) setResult(live.result);
        setStopped(true);
      } else {
        if (!control.signal.aborted) {
          setError((e as Error).message.split(/\r?\n/, 1)[0]);
          setConvergenceFailure((e as { code?: unknown }).code === 'OPENPE_SPICE_CONVERGENCE');
        }
        throw control.signal.aborted ? new Error('Simulation cancelled.') : e;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      if (runControl.current === control) {
        setLiveResult(null);
        runControl.current = null;
        setRunning(false);
      }
    }
    return afterRender(signal);
  }
  const parts = simulationParts(project.schematic);
  const options = (libId: string) =>
    parts
      .filter((p) => p.libId === libId)
      .map((p) => ({ value: p.id, label: `${p.ref} · ${displayPartValue(p)}` }));
  const clearRunError = () => {
    setError('');
    setConvergenceFailure(false);
  };
  const readSimulationContext = () =>
    agentSimulationContext({
      circuitId: project.schematic.id,
      basis,
      settingsVisible: visible,
      waveformsVisible: visible && waveformOpen,
      status: sourcePending
        ? 'blocked'
        : running
          ? 'running'
          : stopped
            ? 'stopped'
            : error
              ? 'failed'
              : result
                ? 'completed'
                : detecting
                  ? 'detecting'
                  : supportError || preview.error
                    ? 'blocked'
                    : status?.available === false
                      ? 'unavailable'
                      : 'idle',
      settings: numericFields
        .filter(([key]) =>
          modelBuck
            ? key === 'stop' || key === 'step'
            : !vendor || !['frequency', 'duty'].includes(key),
        )
        .map(([key, label]) => ({ label, value: drafts[key] })),
      config: preview.deck ? config : null,
      resultConfig: result ? runConfig : null,
      errors: [
        sourcePending ? 'Apply Source edits before simulating.' : '',
        supportError,
        preview.error,
        status?.error,
        error,
        probeMessage,
      ].filter((value): value is string => !!value),
      probe: requestedProbe?.source === source ? requestedProbe.target : null,
      selected,
      result: sourcePending ? null : result,
      live: !!liveResult,
      partial: stopped,
      presentation: waveformPresentation.current,
    });
  function afterRender(signal: AbortSignal) {
    return new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Simulation command cancelled.'));
        return;
      }
      const waiter = { resolve, reject, signal, abort: () => {} };
      waiter.abort = () => {
        renderWaiters.current = renderWaiters.current.filter((entry) => entry !== waiter);
        reject(new Error('Simulation command cancelled.'));
      };
      renderWaiters.current.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      refreshCapabilityState((revision) => revision + 1);
    });
  }
  async function configure(input: SimulationConfigurationInput, signal: AbortSignal) {
    if (runControl.current)
      throw new Error('Stop the active simulation before changing its settings.');
    const updates = input.config ?? {};
    const allowedNumbers = numericFields
      .filter(([key]) =>
        modelBuck
          ? key === 'stop' || key === 'step'
          : !vendor || !['frequency', 'duty'].includes(key),
      )
      .map(([key]) => key);
    for (const key of [...Object.keys(updates), ...Object.keys(input.drafts ?? {})]) {
      if (numericFields.some(([numeric]) => numeric === key)) {
        if (!allowedNumbers.includes(key as NumericKey))
          throw new Error(`This circuit does not expose the ${key} setting.`);
        if (key in updates && key in (input.drafts ?? {}))
          throw new Error(`Supply one value for ${key}.`);
      } else if (modelBuck)
        throw new Error('This circuit derives its terminals from the current schematic.');
    }
    const nextSelection = { ...selection, ...updates };
    const nextDrafts = { ...drafts, ...input.drafts };
    for (const [key, , scale] of numericFields) {
      if (typeof updates[key] === 'number') nextDrafts[key] = String(updates[key]! / scale);
    }
    if (input.config && !input.drafts) {
      buildSpiceDeck(project.schematic, {
        ...(modelBuck ? initial : nextSelection),
        ...Object.fromEntries(
          numericFields
            .filter(([key]) => !modelBuck || key === 'stop' || key === 'step')
            .map(([key, , scale]) => [
              key,
              nextDrafts[key].trim() ? Number(nextDrafts[key]) * scale : NaN,
            ]),
        ),
      } as TransientConfig);
    }
    clearRunError();
    if (
      Object.keys(nextSelection).some(
        (key) =>
          nextSelection[key as keyof TransientConfig] !== selection[key as keyof TransientConfig],
      ) ||
      numericFields.some(([key]) => nextDrafts[key] !== drafts[key])
    ) {
      settingsEdited.current = true;
      restoreSuppressed.current = false;
      loadControl.current?.abort();
    }
    setSelection(nextSelection);
    setDrafts(nextDrafts);
    return afterRender(signal);
  }
  async function configureProbes(input: SimulationProbesInput, signal: AbortSignal) {
    if (sourcePending) throw new Error('Apply Source edits before changing probes.');
    if (input.target) {
      const target = input.target;
      if (
        ![
          ...project.schematic.parts,
          ...project.schematic.wires,
          ...project.schematic.labels,
          ...project.schematic.junctions,
        ].some((item) => item.id === target.id)
      )
        throw new Error('Choose a probe target in the active schematic.');
    }
    if (input.selected?.some((vector) => !result?.traces.some((trace) => trace.vector === vector)))
      throw new Error('Choose waveform vectors from the current simulation result.');
    if ('target' in input) {
      setRequestedProbe(input.target ? { source, target: input.target } : null);
      if (!input.target) setRestoredWaveformSource(null);
    }
    if (input.selected) setSelected(input.selected);
    return afterRender(signal);
  }
  capabilityAdapter.current = {
    available: () => (capabilityHost ? workbenchPluginAvailability(SPICE_PLUGIN_ID) : true),
    canRun: () =>
      sourcePending
        ? 'Apply Source edits before simulating.'
        : !visible
          ? 'Open Simulation before starting a transient run.'
          : runControl.current
            ? 'A simulation is already running.'
            : loadingSaved || (loadControl.current && !loadControl.current.signal.aborted)
              ? 'Wait for the saved simulation lookup to finish before running.'
              : supportError ||
                preview.error ||
                (detecting
                  ? 'Solver detection is still running. Retry when detection completes.'
                  : status?.available
                    ? true
                    : status?.error ||
                      'The bundled solver is not ready. Open Simulation and retry.'),
    read: readSimulationContext,
    configure,
    probes: configureProbes,
    run,
    cancel: () => {
      const control = runControl.current;
      if (control && !control.signal.aborted) control.abort('stop');
      return { cancelled: !!control };
    },
  };
  useLayoutEffect(() => {
    if (agentContextRef) agentContextRef.current = readSimulationContext;
    for (const waiter of renderWaiters.current.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) waiter.reject(new Error('Simulation command cancelled.'));
      else waiter.resolve(readSimulationContext());
    }
  });
  useLayoutEffect(
    () =>
      registerSimulationCapabilities(host, {
        available: () => capabilityAdapter.current!.available(),
        canRun: () => capabilityAdapter.current!.canRun(),
        read: () => capabilityAdapter.current!.read(),
        configure: (input, signal) => capabilityAdapter.current!.configure(input, signal),
        probes: (input, signal) => capabilityAdapter.current!.probes(input, signal),
        run: (signal) => capabilityAdapter.current!.run(signal),
        cancel: () => capabilityAdapter.current!.cancel(),
      }),
    [host],
  );
  useEffect(() => {
    host.emit('simulation.changed', {
      circuitId: project.schematic.id,
      basis,
      visible,
      running,
      detecting,
      sourcePending,
      selected,
      error: settingsError,
    });
  }, [
    host,
    project.schematic.id,
    basis,
    visible,
    running,
    detecting,
    loadingSaved,
    sourcePending,
    selected,
    settingsError,
    config,
    resultKey,
  ]);
  useEffect(() => {
    return () => {
      if (agentContextRef) agentContextRef.current = null;
      for (const waiter of renderWaiters.current.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(new Error('Simulation closed.'));
      }
    };
  }, [agentContextRef]);
  function executeSimulation(id: string, input: unknown = {}) {
    void host
      .execute(id, input, { actor: 'human' })
      .catch((failure) => setError((failure as Error).message));
  }
  return (
    <>
      {settingsHost.current &&
        createPortal(
          <section
            className="simulation-settings"
            aria-label="Simulation settings"
            hidden={!visible}
          >
            <header className="simulation-settings-header">
              <h2>SPICE Simulation</h2>
              {onCloseSettings && (
                <button
                  className="tool-button"
                  aria-label="Close simulation settings"
                  title="Close"
                  onClick={() =>
                    host.catalog().some((entry) => entry.id === 'simulation.hide')
                      ? executeSimulation('simulation.hide')
                      : onCloseSettings()
                  }
                >
                  <X size={17} />
                </button>
              )}
            </header>
            <div className="simulation-settings-body" aria-busy={loadingSaved}>
              {!supportError && (
                <div className="simulation-fields">
                  {(
                    [
                      ['inputId', 'DC input', SPICE_PORT],
                      ['pwmId', 'PWM terminal', SPICE_PORT],
                      ['outputId', 'Output terminal', SPICE_PORT],
                      ['switchId', vendor ? 'Regulator' : 'Switch', vendor?.id || SPICE_SWITCH],
                      ['currentId', 'Output inductor', 'Device:L'],
                    ] as const
                  )
                    .filter(([key]) => !modelBuck && (!vendor || key !== 'pwmId'))
                    .map(([key, label, lib]) => (
                      <div className="simulation-field" key={key}>
                        <span>{label}</span>
                        <Select
                          label={label}
                          value={selection[key]}
                          options={options(lib)}
                          disabled={running}
                          onChange={(value) => {
                            executeSimulation('simulation.configure', { config: { [key]: value } });
                          }}
                        />
                      </div>
                    ))}
                  {numericFields
                    .filter(([key]) =>
                      modelBuck
                        ? key === 'stop' || key === 'step'
                        : !vendor || !['frequency', 'duty'].includes(key),
                    )
                    .map(([key, label]) => (
                      <label className="simulation-field" key={key}>
                        <span>{quantityLabel(label)}</span>
                        <QuantityInput
                          unit={quantityUnitFromLabel(label)}
                          aria-label={label}
                          type="text"
                          inputMode="decimal"
                          value={drafts[key]}
                          disabled={running}
                          onValueChange={(inputValue) => {
                            executeSimulation('simulation.configure', {
                              drafts: { [key]: inputValue },
                            });
                          }}
                        />
                      </label>
                    ))}
                </div>
              )}
              {canRestoreTiming && (
                <button
                  className="dialog-button secondary"
                  disabled={running || sourcePending}
                  onClick={() => {
                    executeSimulation('simulation.configure', {
                      config: { stop: initial.stop, step: initial.step },
                    });
                  }}
                >
                  Use default timing ({formatted(initial.stop * 1000)} ms,{' '}
                  {formatted(initial.step * 1000000)} µs)
                </button>
              )}
              <AnalysisComponents
                items={components}
                visible={visible}
                locateDisabled={sourcePending}
                onLocate={onLocatePart}
                locateDescription="Highlight in schematic"
                composingRef={participationComposing}
                renderControl={({ part }, collapsed) => (
                  <button
                    type="button"
                    role="switch"
                    className="appearance-toggle simulation-participation"
                    aria-label={`Include ${part.ref} in SPICE simulation`}
                    aria-checked={participatesInSimulation(part)}
                    disabled={
                      !visible || collapsed || running || sourcePending || !onParticipationChange
                    }
                    onKeyDown={(event) => {
                      if (
                        participationComposing.current ||
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    onClick={() => {
                      if (
                        !visible ||
                        collapsed ||
                        running ||
                        sourcePending ||
                        participationComposing.current ||
                        !onParticipationChange
                      )
                        return;
                      try {
                        if (!onParticipationChange(part.id, !participatesInSimulation(part)))
                          throw new Error('The component could not be updated. Try again.');
                        setError('');
                      } catch (failure) {
                        setError((failure as Error).message);
                      }
                    }}
                  >
                    <span aria-hidden="true" />
                  </button>
                )}
              />
            </div>
            <footer className="simulation-settings-footer">
              {settingsError && (
                <p className="simulation-error" role="alert">
                  {settingsError}
                </p>
              )}
              {visible && loadingSaved && (
                <SavedResultLoading analysis="spice" stage={savedResultStage} />
              )}
              {running ? (
                <button
                  className="dialog-button quiet analysis-footer-button"
                  aria-label="Stop"
                  title="Stop"
                  onClick={() => {
                    executeSimulation('simulation.cancel');
                  }}
                >
                  <Square aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="dialog-button quiet analysis-footer-button"
                  aria-label="Run"
                  title="Run"
                  disabled={
                    !preview.deck ||
                    !status?.available ||
                    detecting ||
                    loadingSaved ||
                    sourcePending
                  }
                  onClick={() => executeSimulation('simulation.run')}
                >
                  <Play aria-hidden="true" />
                </button>
              )}
            </footer>
          </section>,
          settingsHost.current,
        )}
      {waveformHost.current &&
        createPortal(
          <SimulationWaveforms
            capabilityHost={host}
            capabilityAvailability={() => capabilityAdapter.current?.available() ?? false}
            visible={visible && waveformOpen}
            result={sourcePending ? null : result}
            selected={selected}
            onSelected={(selected) => executeSimulation('simulation.probes', { selected })}
            frequency={curatedExample ? null : (runConfig ?? config).frequency}
            running={running}
            stopped={stopped}
            resultKey={resultKey}
            duration={(runConfig ?? config).stop}
            presentationRef={waveformPresentation}
            message={
              sourcePending
                ? 'Apply Source edits before simulating.'
                : loadingSaved && !result
                  ? 'Loading saved simulation…'
                  : probeMessage
            }
          />,
          waveformHost.current,
        )}
    </>
  );
}
