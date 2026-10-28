'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Crosshair, Download, Eye, Play, RefreshCw, Square, X } from 'lucide-react';
import { createCapabilityHost, type CapabilityHost } from '@/api/capabilities';
import { api } from '@/lib/bridge';
import { saveDrawingPNG } from '@/lib/drawing-export';
import { serializeProject, type Project } from '@/lib/project';
import {
  defaultThermalConfig,
  prepareThermalModel,
  validateThermalConfig,
  validateThermalResult,
  validateThermalSpiceImport,
  type ThermalConfig,
  type ThermalResult,
} from '@/lib/thermal';
import {
  registerThermalCapabilities,
  type ThermalCapabilityAdapter,
  type ThermalConfigurationInput,
} from '@/lib/thermal-capabilities';
import {
  closestThermalNode,
  pointOnThermalSurface,
  thermalColor,
  thermalSurface,
  type ThermalProbe,
  type ThermalSurface,
} from '@/lib/thermal-view';
import { THERMAL_PLUGIN_ID, workbenchPluginAvailability } from '@/lib/workbench-plugins';
import {
  agentThermalContext,
  type AgentThermalContext,
  type AgentThermalState,
} from '@/context/agent-thermal-context';
import Select from './Select';
import ThermalField from './ThermalField';
import type { ThermalLayoutPresentation } from './ThermalLayoutResults';
import styles from './ThermalSimulation.module.css';

type SolverStatus = NonNullable<AgentThermalState['solver']>;
type Session = {
  config: ThermalConfig | null;
  resultConfig: ThermalConfig | null;
  result: ThermalResult | null;
  resultSource: string;
  probe: ThermalProbe | null;
  surface: ThermalSurface;
  status: AgentThermalState['status'];
  solver: SolverStatus | null;
  error: string;
};
const fields = [
  ['ambientC', 'Ambient (°C)'],
  ['top', 'Front convection (W/m²·K)'],
  ['bottom', 'Back convection (W/m²·K)'],
  ['edge', 'Edge convection (W/m²·K)'],
  ['dielectricConductivity', 'Dielectric conductivity (W/m·K)'],
  ['copperConductivity', 'Copper conductivity (W/m·K)'],
  ['viaPlatingMm', 'Via plating (mm)'],
  ['meshSizeMm', 'Mesh size (mm)'],
] as const;
const formatted = (value: number) => Number(value.toPrecision(6)).toString();
const temperature = (value: number) => `${value.toFixed(2)} °C`;
function draftsFor(config: ThermalConfig | null): Record<string, string> {
  if (!config) return {};
  return Object.fromEntries([
    ...fields.map(([key]) => [
      key,
      formatted(
        key === 'top' || key === 'bottom' || key === 'edge' ? config.convection[key] : config[key],
      ),
    ]),
    ...config.copperThicknessMm.map((value, index) => [`copper:${index}`, formatted(value)]),
    ...config.heatSources.map((source) => [
      `power:${source.footprintId}`,
      formatted(source.powerW),
    ]),
  ]);
}

export default function ThermalSimulation({
  project,
  fileId,
  visible,
  spiceAvailable = true,
  sourcePending,
  capabilityHost,
  onClose,
  agentContextRef,
  docked = false,
  onPresentationChange,
}: {
  project: Project;
  fileId?: string;
  visible: boolean;
  spiceAvailable?: boolean;
  sourcePending: boolean;
  capabilityHost?: CapabilityHost;
  onClose?: () => void;
  agentContextRef?: RefObject<(() => AgentThermalContext) | null>;
  docked?: boolean;
  onPresentationChange?: (presentation: ThermalLayoutPresentation | null) => void;
}) {
  const [localHost] = useState(createCapabilityHost);
  const host = capabilityHost ?? localHost;
  const source = useMemo(() => serializeProject(project), [project]);
  const initial = useMemo(
    () =>
      project.pcb
        ? {
            ...defaultThermalConfig(project.pcb),
            heatSources: project.pcb.footprints.map((footprint) => ({
              footprintId: footprint.id,
              powerW: 0,
            })),
          }
        : null,
    [project.pcb],
  );
  const [session, setSession] = useState<Session>(() => ({
    config: initial,
    resultConfig: null,
    result: null,
    resultSource: '',
    probe: null,
    surface: 'front',
    status: 'idle',
    solver: null,
    error: '',
  }));
  const current = useRef(session);
  const [drafts, setDrafts] = useState(() => draftsFor(initial));
  const [heatInput, setHeatInput] = useState<'manual' | 'spice'>('manual');
  const [layoutShown, setLayoutShown] = useState(true);
  const [layoutProbing, setLayoutProbing] = useState(false);
  const heatInputRef = useRef(heatInput);
  heatInputRef.current = heatInput;
  const [importingSpice, setImportingSpice] = useState(false);
  const draftRef = useRef(drafts);
  draftRef.current = drafts;
  const origin = useRef({ source, sourcePending, visible, project, fileId, spiceAvailable });
  origin.current = { source, sourcePending, visible, project, fileId, spiceAvailable };
  const runControl = useRef<AbortController | null>(null);
  const detectControl = useRef<AbortController | null>(null);
  const loadControl = useRef<AbortController | null>(null);
  const spiceControl = useRef<AbortController | null>(null);
  const configurationEdited = useRef(false);
  const adapterRef = useRef<ThermalCapabilityAdapter | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientId = useId().replaceAll(':', '');
  function update(change: Partial<Session>) {
    current.current = { ...current.current, ...change };
    setSession(current.current);
  }
  function read() {
    const state = current.current;
    const active = origin.current;
    const fresh = !active.sourcePending && state.resultSource === active.source;
    return agentThermalContext({
      boardId: active.project.pcb?.id ?? null,
      visible: active.visible,
      sourcePending: active.sourcePending,
      status: state.status,
      settings: state.config,
      resultSettings: fresh ? state.resultConfig : null,
      surface: state.surface,
      probe: fresh ? state.probe : null,
      error: state.error,
      solver: state.solver,
      result: fresh ? state.result : null,
    });
  }
  function parsedDrafts() {
    const board = origin.current.project.pcb;
    const config = current.current.config;
    if (!board || !config) throw new Error('This project has no PCB Layout to simulate.');
    const draft = draftRef.current;
    const number = (key: string) => (draft[key]?.trim() ? Number(draft[key]) : NaN);
    return validateThermalConfig(
      {
        ...config,
        ...Object.fromEntries(
          fields
            .filter(([key]) => !['top', 'bottom', 'edge'].includes(key))
            .map(([key]) => [key, number(key)]),
        ),
        convection: { top: number('top'), bottom: number('bottom'), edge: number('edge') },
        copperThicknessMm: board.layers.map((_, i) => number(`copper:${i}`)),
        heatSources: board.footprints.map((footprint) => ({
          footprintId: footprint.id,
          powerW: config.spiceSource
            ? (config.heatSources.find((source) => source.footprintId === footprint.id)?.powerW ??
              0)
            : number(`power:${footprint.id}`),
        })),
      },
      board,
    );
  }
  function cancelLookup() {
    loadControl.current?.abort();
    loadControl.current = null;
  }
  function setDraftConfig(config: ThermalConfig, edited = true) {
    if (edited) {
      configurationEdited.current = true;
      cancelLookup();
    }
    const nextDrafts = {
      ...Object.fromEntries(
        (origin.current.project.pcb?.footprints ?? []).map((footprint) => [
          `power:${footprint.id}`,
          '0',
        ]),
      ),
      ...draftsFor(config),
    };
    draftRef.current = nextDrafts;
    setDrafts(nextDrafts);
    update({ config, error: '' });
    if (config.spiceSource) {
      heatInputRef.current = 'spice';
      setHeatInput('spice');
    }
  }
  async function configure(input: ThermalConfigurationInput, signal: AbortSignal) {
    if (signal.aborted) throw new Error('Thermal settings update cancelled.');
    if (runControl.current) throw new Error('Stop the thermal run before changing its settings.');
    cancelSpiceImport();
    const merged = { ...current.current.config, ...input.config };
    if (input.config.heatSources && !input.config.spiceSource) delete merged.spiceSource;
    const config = validateThermalConfig(merged, origin.current.project.pcb ?? undefined);
    if (current.current.config?.spiceSource && !config.spiceSource) {
      heatInputRef.current = 'manual';
      setHeatInput('manual');
    }
    setDraftConfig(config);
    return read();
  }
  function cancelSpiceImport() {
    spiceControl.current?.abort();
    spiceControl.current = null;
    setImportingSpice(false);
  }
  function canImportSpice(): true | string {
    const active = origin.current;
    if (!active.spiceAvailable)
      return 'Install and enable SPICE Simulation in Plugins > Marketplace.';
    if (!active.visible || active.sourcePending || !active.project.pcb)
      return 'Open Thermal in Layout and apply Source edits before loading SPICE heat sources.';
    if (!active.fileId)
      return 'Save this project and complete its SPICE simulation before loading heat sources.';
    if (runControl.current) return 'Stop the thermal run before loading SPICE heat sources.';
    if (spiceControl.current) return 'SPICE heat sources are already loading.';
    return true;
  }
  async function importSpice(_input: unknown, signal: AbortSignal) {
    const allowed = canImportSpice();
    if (allowed !== true) throw new Error(allowed);
    const active = origin.current;
    const config = parsedDrafts();
    const control = new AbortController();
    const cancel = () => control.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) control.abort();
    configurationEdited.current = true;
    cancelLookup();
    spiceControl.current = control;
    setImportingSpice(true);
    update({ error: '' });
    try {
      const response = await api('thermal/spice-sources', {
        method: 'POST',
        body: JSON.stringify({ source: active.source, fileId: active.fileId }),
        signal: control.signal,
      });
      const body = await response.json();
      if (
        control.signal.aborted ||
        spiceControl.current !== control ||
        origin.current.source !== active.source ||
        origin.current.fileId !== active.fileId ||
        origin.current.sourcePending ||
        !origin.current.visible ||
        !origin.current.spiceAvailable
      )
        return read();
      const imported = validateThermalSpiceImport(body, active.project.pcb!);
      setDraftConfig(
        validateThermalConfig(
          { ...config, heatSources: imported.heatSources, spiceSource: imported.spiceSource },
          active.project.pcb!,
        ),
      );
      return read();
    } catch (error) {
      if (!control.signal.aborted && spiceControl.current === control) throw error;
      return read();
    } finally {
      signal.removeEventListener('abort', cancel);
      if (spiceControl.current === control) {
        spiceControl.current = null;
        setImportingSpice(false);
      }
    }
  }
  async function detect() {
    detectControl.current?.abort();
    const control = new AbortController();
    detectControl.current = control;
    update({ status: 'detecting' });
    try {
      const data = (await (
        await api('thermal/status', { signal: control.signal })
      ).json()) as SolverStatus;
      if (!control.signal.aborted && origin.current.visible) {
        if (typeof data.available !== 'boolean')
          throw new Error('The thermal solver status is invalid. Restart OpenPE and retry.');
        const solver = {
          available: data.available,
          ...(typeof data.gmsh === 'string' ? { gmsh: data.gmsh } : {}),
          ...(typeof data.elmer === 'string' ? { elmer: data.elmer } : {}),
          ...(typeof data.error === 'string' && data.error ? { error: data.error } : {}),
        };
        update({
          solver,
          status: runControl.current
            ? 'running'
            : data.available
              ? current.current.result
                ? 'completed'
                : 'idle'
              : 'unavailable',
        });
      }
    } catch (error) {
      if (!control.signal.aborted)
        update({
          solver: { available: false, error: (error as Error).message },
          status: runControl.current ? 'running' : 'unavailable',
        });
    } finally {
      if (detectControl.current === control) detectControl.current = null;
    }
  }
  async function run(signal: AbortSignal) {
    const active = origin.current;
    if (!active.visible || active.sourcePending || !active.project.pcb)
      throw new Error('Open Thermal in Layout and apply Source edits before running.');
    if (runControl.current) throw new Error('A thermal run is already active.');
    if (spiceControl.current) throw new Error('Wait for SPICE heat sources to finish loading.');
    if (heatInputRef.current === 'spice' && !current.current.config?.spiceSource)
      throw new Error('Load current SPICE heat sources before running Thermal.');
    if (heatInputRef.current === 'spice' && !active.spiceAvailable)
      throw new Error(
        'Enable SPICE Simulation or choose Manual heat input before running Thermal.',
      );
    if (detectControl.current)
      throw new Error('Solver detection is still running. Retry when detection completes.');
    const config = parsedDrafts();
    const expected = prepareThermalModel(active.project.pcb, config).basis;
    setDraftConfig(config);
    const control = new AbortController();
    const cancel = () => control.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) control.abort();
    runControl.current = control;
    update({
      status: 'running',
      result: null,
      resultConfig: null,
      resultSource: '',
      probe: null,
      error: '',
    });
    try {
      const response = await api('thermal/run', {
        method: 'POST',
        body: JSON.stringify({
          source: active.source,
          config,
          ...(active.fileId ? { fileId: active.fileId } : {}),
        }),
        signal: control.signal,
      });
      const body = await response.json();
      if (
        control.signal.aborted ||
        runControl.current !== control ||
        origin.current.source !== active.source ||
        origin.current.fileId !== active.fileId ||
        origin.current.sourcePending ||
        !origin.current.visible
      )
        return read();
      const result = validateThermalResult(body.result);
      if (result.basis !== expected)
        throw new Error(
          'The thermal result does not match the requested board and settings. Run again.',
        );
      update({ result, resultConfig: config, resultSource: active.source, status: 'completed' });
      return read();
    } catch (error) {
      if (runControl.current === control && origin.current.source === active.source) {
        update(
          control.signal.aborted
            ? { status: 'stopped', error: '' }
            : { status: 'failed', error: (error as Error).message },
        );
      }
      if (!control.signal.aborted) throw error;
      return read();
    } finally {
      signal.removeEventListener('abort', cancel);
      if (runControl.current === control) runControl.current = null;
    }
  }
  async function exportImage(signal: AbortSignal) {
    const svg = svgRef.current;
    if (
      !origin.current.visible ||
      !svg ||
      !current.current.result ||
      current.current.resultSource !== origin.current.source ||
      origin.current.sourcePending
    )
      throw new Error('Run Thermal and open its solved temperature map before exporting.');
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.style.removeProperty('display');
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', '1400');
    copy.setAttribute('height', '1100');
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }),
    );
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () =>
          reject(new Error('The temperature map could not be rendered for PNG export.'));
        image.src = url;
      });
      if (signal.aborted) throw new Error('Thermal image export cancelled.');
      const canvas = document.createElement('canvas');
      canvas.width = 1400;
      canvas.height = 1100;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PNG export is unavailable.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const name = await saveDrawingPNG(
        { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height },
        `${origin.current.project.name || origin.current.project.schematic.title}-thermal`,
      );
      return { exported: name !== null, name };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  adapterRef.current = {
    available: () => (capabilityHost ? workbenchPluginAvailability(THERMAL_PLUGIN_ID) : true),
    canRun: () =>
      !origin.current.visible
        ? 'Open Thermal in Layout before running.'
        : origin.current.sourcePending
          ? 'Apply Source edits before running Thermal.'
          : !origin.current.project.pcb
            ? 'This project has no PCB Layout to simulate.'
            : runControl.current
              ? 'A thermal run is already active.'
              : spiceControl.current
                ? 'Wait for SPICE heat sources to finish loading.'
                : heatInputRef.current === 'spice' && !current.current.config?.spiceSource
                  ? 'Load current SPICE heat sources before running Thermal.'
                  : heatInputRef.current === 'spice' && !origin.current.spiceAvailable
                    ? 'Enable SPICE Simulation or choose Manual heat input before running Thermal.'
                    : detectControl.current
                      ? 'Solver detection is still running. Retry when detection completes.'
                      : current.current.solver?.available
                        ? true
                        : current.current.solver?.error ||
                          'The bundled thermal solvers are not ready. Open Thermal and retry.',
    read,
    configure,
    canImport: canImportSpice,
    importSpice,
    run,
    exportImage,
    cancel: () => {
      const control = runControl.current;
      control?.abort();
      return { cancelled: !!control };
    },
    probe: async ({ point }, signal) => {
      if (signal.aborted) throw new Error('Thermal probe cancelled.');
      if (!point) update({ probe: null });
      else {
        const state = current.current;
        if (
          !state.result ||
          state.resultSource !== origin.current.source ||
          origin.current.sourcePending
        )
          throw new Error('Run Thermal before probing board temperatures.');
        update({ probe: closestThermalNode(state.result, point, state.surface) });
      }
      return read();
    },
  };
  useLayoutEffect(
    () =>
      registerThermalCapabilities(host, {
        available: () => adapterRef.current!.available(),
        canRun: () => adapterRef.current!.canRun(),
        read: () => adapterRef.current!.read(),
        configure: (input, signal) => adapterRef.current!.configure(input, signal),
        canImport: () => adapterRef.current!.canImport!(),
        importSpice: (input, signal) => adapterRef.current!.importSpice!(input, signal),
        run: (signal) => adapterRef.current!.run(signal),
        cancel: () => adapterRef.current!.cancel(),
        probe: (input, signal) => adapterRef.current!.probe(input, signal),
        exportImage: (signal) => adapterRef.current!.exportImage(signal),
      }),
    [host],
  );
  useLayoutEffect(() => {
    if (agentContextRef) agentContextRef.current = read;
  });
  useEffect(
    () => () => {
      runControl.current?.abort();
      detectControl.current?.abort();
      loadControl.current?.abort();
      spiceControl.current?.abort();
      if (agentContextRef) agentContextRef.current = null;
      if (!capabilityHost) localHost.dispose();
    },
    [agentContextRef, capabilityHost, localHost],
  );
  useEffect(() => {
    if (visible) void detect();
    else {
      runControl.current?.abort();
      detectControl.current?.abort();
      cancelLookup();
      cancelSpiceImport();
      if (current.current.status === 'running' || current.current.status === 'detecting')
        update({ status: current.current.result ? 'completed' : 'idle' });
    }
  }, [visible]);
  useEffect(() => {
    runControl.current?.abort();
    runControl.current = null;
    cancelLookup();
    cancelSpiceImport();
    const old = current.current.config;
    const retained = old ? { ...old } : null;
    if (retained) delete retained.spiceSource;
    const next =
      initial && old
        ? {
            ...retained!,
            copperThicknessMm: initial.copperThicknessMm.map(
              (fallback, i) => old.copperThicknessMm[i] ?? fallback,
            ),
            heatSources: initial.heatSources.map(
              (item) =>
                (old.spiceSource
                  ? undefined
                  : old.heatSources.find((source) => source.footprintId === item.footprintId)) ??
                item,
            ),
          }
        : initial;
    update({
      config: next,
      result: null,
      resultConfig: null,
      resultSource: '',
      probe: null,
      status: current.current.solver?.available
        ? 'idle'
        : current.current.status === 'detecting'
          ? 'detecting'
          : 'unavailable',
      error: '',
    });
    const nextDrafts = draftsFor(next);
    draftRef.current = nextDrafts;
    setDrafts(nextDrafts);
  }, [source, sourcePending, initial, fileId]);
  useEffect(() => {
    if (!spiceAvailable) {
      cancelSpiceImport();
      if (current.current.config?.spiceSource) runControl.current?.abort();
    }
  }, [spiceAvailable]);
  useEffect(() => {
    if (
      !visible ||
      sourcePending ||
      !fileId ||
      !session.solver?.available ||
      current.current.result ||
      runControl.current
    )
      return;
    const active = origin.current;
    let config: ThermalConfig | undefined;
    if (configurationEdited.current) {
      try {
        config = parsedDrafts();
        prepareThermalModel(active.project.pcb!, config);
      } catch {
        return;
      }
    }
    const control = new AbortController();
    loadControl.current = control;
    void (async () => {
      try {
        const response = await api('thermal/result', {
          method: 'POST',
          signal: control.signal,
          body: JSON.stringify({ source: active.source, fileId, ...(config ? { config } : {}) }),
        });
        const body = await response.json();
        if (
          control.signal.aborted ||
          loadControl.current !== control ||
          origin.current.source !== active.source ||
          origin.current.fileId !== active.fileId ||
          origin.current.sourcePending ||
          !origin.current.visible ||
          runControl.current ||
          !body.result
        )
          return;
        const restoredConfig = validateThermalConfig(body.config, active.project.pcb!);
        const result = validateThermalResult(body.result);
        if (result.basis !== prepareThermalModel(active.project.pcb!, restoredConfig).basis)
          throw new Error('The saved thermal result does not match this PCB and its settings.');
        setDraftConfig(restoredConfig, false);
        update({
          result,
          resultConfig: restoredConfig,
          resultSource: active.source,
          probe: null,
          status: 'completed',
        });
      } catch (failure) {
        if (!control.signal.aborted && origin.current.source === active.source)
          update({ error: (failure as Error).message });
      } finally {
        if (loadControl.current === control) loadControl.current = null;
      }
    })();
    return () => {
      control.abort();
      if (loadControl.current === control) loadControl.current = null;
    };
  }, [visible, source, sourcePending, fileId, session.solver?.available]);
  useEffect(() => {
    host.emit('thermal.changed', {
      boardId: project.pcb?.id ?? null,
      visible,
      sourcePending,
      status: session.status,
      error: session.error,
      surface: session.surface,
      hasResult: !!session.result,
    });
  }, [
    host,
    project.pcb?.id,
    visible,
    sourcePending,
    session.status,
    session.error,
    session.surface,
    session.result,
  ]);
  function execute(id: string, input: unknown = {}) {
    void host
      .execute(id, input, { actor: 'human' })
      .catch((error) => update({ error: (error as Error).message }));
  }
  function applyDrafts() {
    try {
      execute('thermal.configure', { config: parsedDrafts() });
    } catch (error) {
      update({ error: (error as Error).message });
    }
  }
  function changeHeatInput(value: string) {
    cancelSpiceImport();
    cancelLookup();
    heatInputRef.current = value as 'manual' | 'spice';
    setHeatInput(value as 'manual' | 'spice');
    configurationEdited.current = true;
    if (value === 'manual' && current.current.config) {
      try {
        const config = parsedDrafts();
        delete config.spiceSource;
        execute('thermal.configure', { config });
      } catch (error) {
        update({ error: (error as Error).message });
      }
    }
  }
  function field(key: string, label: string) {
    return (
      <label className={styles.field} key={key}>
        <span>{label}</span>
        <input
          type="text"
          inputMode="decimal"
          aria-label={label}
          value={drafts[key] ?? ''}
          disabled={
            session.status === 'running' || (key.startsWith('power:') && heatInput === 'spice')
          }
          onChange={(event) => {
            configurationEdited.current = true;
            cancelLookup();
            cancelSpiceImport();
            setDrafts((previous) => ({ ...previous, [key]: event.target.value }));
          }}
          onBlur={applyDrafts}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
              event.stopPropagation();
            }
          }}
        />
      </label>
    );
  }
  const result = !sourcePending && session.resultSource === source ? session.result : null;
  const probeAt = useCallback(
    (point: { x: number; y: number } | null) => {
      if (!point) {
        setLayoutProbing(false);
        return;
      }
      const state = current.current;
      if (
        !state.result ||
        !origin.current.visible ||
        origin.current.sourcePending ||
        state.resultSource !== origin.current.source ||
        !pointOnThermalSurface(state.result, point, state.surface)
      )
        return;
      void host
        .execute('thermal.probe', { point: { x: point.x, y: point.y } }, { actor: 'human' })
        .catch((error: Error) => {
          update({ error: error.message });
        });
    },
    [host],
  );
  useLayoutEffect(() => {
    onPresentationChange?.(
      visible && result
        ? {
            project,
            fileId,
            result,
            surface: session.surface,
            probe: session.probe,
            shown: layoutShown,
            probing: layoutShown && layoutProbing,
            probeAt,
          }
        : null,
    );
  }, [
    onPresentationChange,
    visible,
    result,
    project,
    fileId,
    session.surface,
    session.probe,
    layoutShown,
    layoutProbing,
    probeAt,
  ]);
  useLayoutEffect(() => () => onPresentationChange?.(null), [onPresentationChange]);
  useEffect(() => {
    if (!visible || !result || !layoutShown) setLayoutProbing(false);
  }, [visible, result, layoutShown]);
  const mesh = useMemo(
    () => (result ? thermalSurface(result, session.surface) : null),
    [result, session.surface],
  );
  const bounds = useMemo(() => {
    if (!result) return null;
    return result.points.reduce(
      (bounds, p) => ({
        minX: Math.min(bounds.minX, p.x),
        minY: Math.min(bounds.minY, p.y),
        maxX: Math.max(bounds.maxX, p.x),
        maxY: Math.max(bounds.maxY, p.y),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
  }, [result]);
  if (!visible) return null;
  const statusText = importingSpice
    ? 'Loading SPICE heat…'
    : session.status === 'running'
      ? 'Meshing and solving…'
      : session.status === 'detecting'
        ? 'Checking solvers…'
        : session.status === 'completed'
          ? 'Completed'
          : session.status === 'stopped'
            ? 'Stopped'
            : '';
  const error = sourcePending
    ? 'Apply Source edits before running Thermal.'
    : session.error ||
      session.solver?.error ||
      (!project.pcb ? 'This project has no PCB Layout to simulate.' : '');
  return (
    <section className={styles.panel} data-docked={docked || undefined} aria-label="Thermal FEM">
      <header className={styles.header}>
        <h2>Thermal FEM</h2>
        <span
          role="status"
          className={styles.status}
          aria-description={result?.diagnostics.join('\n') || undefined}
        >
          {statusText}
        </span>
        <button
          className="tool-button"
          aria-label="Close Thermal"
          title="Close"
          onClick={() =>
            host.catalog().some((item) => item.id === 'thermal.hide')
              ? execute('thermal.hide')
              : onClose?.()
          }
        >
          <X size={17} />
        </button>
      </header>
      <div className={styles.body}>
        {result && mesh && bounds && (
          <div className={styles.result}>
            <div className={styles.resultHeader}>
              <strong>Board temperature</strong>
              {onPresentationChange && (
                <>
                  <button
                    className={`tool-button${layoutShown ? ' active' : ''}`}
                    aria-label="Show temperature in Layout"
                    title="Show temperature"
                    aria-pressed={layoutShown}
                    onClick={() => setLayoutShown((shown) => !shown)}
                  >
                    <Eye size={16} />
                  </button>
                  <button
                    className={`tool-button${layoutProbing && layoutShown ? ' active' : ''}`}
                    aria-label="Probe Layout temperature"
                    title="Probe temperature"
                    aria-pressed={layoutProbing && layoutShown}
                    disabled={!layoutShown}
                    onClick={() => setLayoutProbing((probing) => !probing)}
                  >
                    <Crosshair size={16} />
                  </button>
                </>
              )}
              <Select
                label="Thermal surface"
                compact
                value={session.surface}
                options={[
                  { value: 'front', label: 'Front' },
                  { value: 'back', label: 'Back' },
                ]}
                onChange={(value) => update({ surface: value as ThermalSurface, probe: null })}
              />
              <button
                className="tool-button"
                aria-label="Export temperature map"
                title="Export temperature map"
                onClick={() => execute('thermal.exportImage')}
              >
                <Download size={16} />
              </button>
            </div>
            <svg
              ref={svgRef}
              className={styles.map}
              style={docked ? { display: 'none' } : undefined}
              viewBox="0 0 420 330"
              role="img"
              aria-label={`${session.surface} board temperature map, minimum ${temperature(result.statistics.minC)}, maximum ${temperature(result.statistics.maxC)}`}
              onClick={(event) => {
                const point = event.currentTarget.createSVGPoint();
                point.x = event.clientX;
                point.y = event.clientY;
                const matrix = event.currentTarget.getScreenCTM();
                if (!matrix) return;
                const local = point.matrixTransform(matrix.inverse());
                const scale = Math.min(
                  380 / Math.max(1e-6, bounds.maxX - bounds.minX),
                  230 / Math.max(1e-6, bounds.maxY - bounds.minY),
                );
                const left = (420 - (bounds.maxX - bounds.minX) * scale) / 2;
                const top = 25 + (230 - (bounds.maxY - bounds.minY) * scale) / 2;
                if (
                  local.x < left ||
                  local.x > 420 - left ||
                  local.y < top ||
                  local.y > top + (bounds.maxY - bounds.minY) * scale
                )
                  return;
                execute('thermal.probe', {
                  point: {
                    x: (local.x - left) / scale + bounds.minX,
                    y: (local.y - top) / scale + bounds.minY,
                  },
                });
              }}
            >
              <defs>
                <linearGradient id={gradientId}>
                  {[0, 0.25, 0.5, 0.75, 1].map((stop) => (
                    <stop
                      key={stop}
                      offset={`${stop * 100}%`}
                      stopColor={thermalColor(stop, 0, 1)}
                    />
                  ))}
                </linearGradient>
              </defs>
              <rect x="0" y="0" width="420" height="330" fill="#ffffff" />
              <text
                x="16"
                y="17"
                fontSize="12"
                fontFamily="Segoe UI, Arial, sans-serif"
                fill="#494949"
              >
                {session.surface === 'front' ? 'Front' : 'Back'} · board temperature (°C)
              </text>
              {(() => {
                const scale = Math.min(
                  380 / Math.max(1e-6, bounds.maxX - bounds.minX),
                  230 / Math.max(1e-6, bounds.maxY - bounds.minY),
                );
                const left = (420 - (bounds.maxX - bounds.minX) * scale) / 2;
                const top = 25 + (230 - (bounds.maxY - bounds.minY) * scale) / 2;
                return (
                  <g
                    transform={`translate(${left} ${top}) scale(${scale}) translate(${-bounds.minX} ${-bounds.minY})`}
                  >
                    <ThermalField result={result} surface={session.surface} probe={session.probe} />
                  </g>
                );
              })()}
              <rect x="24" y="273" width="372" height="12" rx="3" fill={`url(#${gradientId})`} />
              <text
                x="24"
                y="302"
                fontSize="12"
                fontFamily="Segoe UI, Arial, sans-serif"
                fill="#494949"
              >
                {temperature(result.statistics.minC)}
              </text>
              <text
                x="396"
                y="302"
                textAnchor="end"
                fontSize="12"
                fontFamily="Segoe UI, Arial, sans-serif"
                fill="#494949"
              >
                {temperature(result.statistics.maxC)}
              </text>
              {session.probe && (
                <text
                  x="210"
                  y="321"
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily="Segoe UI, Arial, sans-serif"
                  fill="#202020"
                >
                  Node {session.probe.node}: {temperature(session.probe.temperatureC)} at{' '}
                  {formatted(session.probe.x)}, {formatted(session.probe.y)},{' '}
                  {formatted(session.probe.z)} mm
                </text>
              )}
            </svg>
            <div className={styles.statistics}>
              <span>
                Minimum <strong>{temperature(result.statistics.minC)}</strong>
              </span>
              <span>
                Maximum <strong>{temperature(result.statistics.maxC)}</strong>
              </span>
              <span aria-description="Arithmetic mean of finite-element node temperatures">
                Mean <strong>{temperature(result.statistics.meanC)}</strong>
              </span>
              <span>
                Power into board <strong>{formatted(result.statistics.inputPowerW)} W</strong>
              </span>
              <span>
                Removed heat <strong>{formatted(result.statistics.outputPowerW)} W</strong>
              </span>
              <span>
                Energy imbalance{' '}
                <strong>{formatted(result.statistics.energyImbalanceRelative * 100)}%</strong>
              </span>
            </div>
            {!mesh.triangles.length && (
              <p className="simulation-error" role="alert">
                The result contains no triangles on this board surface.
              </p>
            )}
          </div>
        )}
        <div className={styles.fields}>
          {fields.map(([key, label]) => field(key, label))}
          {project.pcb?.layers.map((layer, index) =>
            field(`copper:${index}`, `${layer} thickness (mm)`),
          )}
        </div>
        <h3>Heat into board</h3>
        <div className={styles.sourceRow}>
          <span
            aria-description={
              session.config?.spiceSource
                ? `Completed SPICE dissipation averaged from ${formatted(session.config.spiceSource.startS * 1000)} to ${formatted(session.config.spiceSource.endS * 1000)} ms at the solver's original sampling resolution`
                : undefined
            }
          >
            Heat input
          </span>
          <Select
            label="Thermal heat input"
            compact
            value={heatInput}
            disabled={session.status === 'running'}
            options={[
              { value: 'manual', label: 'Manual' },
              { value: 'spice', label: 'SPICE' },
            ]}
            onChange={changeHeatInput}
          />
          {heatInput === 'spice' && (
            <button
              className="tool-button"
              aria-description={
                canImportSpice() === true
                  ? 'Load modeled dissipative losses averaged over the final 20% of the completed SPICE result at original sampling resolution; apply all selected power to footprint pads'
                  : String(canImportSpice())
              }
              aria-label="Load SPICE heat sources"
              title="Load heat sources"
              disabled={canImportSpice() !== true}
              onClick={() => execute('thermal.importSpice')}
            >
              <RefreshCw size={16} />
            </button>
          )}
        </div>
        <div className={styles.fields}>
          {project.pcb?.footprints.map((footprint) =>
            field(
              `power:${footprint.id}`,
              `${footprint.reference || project.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref || footprint.id.slice(0, 8)} (W)`,
            ),
          )}
        </div>
      </div>
      <footer className={styles.footer}>
        {error && (
          <p className="simulation-error" role="alert">
            {error}
          </p>
        )}
        {session.status === 'running' ? (
          <button className="dialog-button secondary" onClick={() => execute('thermal.cancel')}>
            <Square size={15} />
            Stop
          </button>
        ) : (
          <button
            className="dialog-button primary"
            disabled={
              sourcePending ||
              !project.pcb ||
              !session.solver?.available ||
              session.status === 'detecting' ||
              importingSpice ||
              (heatInput === 'spice' && (!session.config?.spiceSource || !spiceAvailable))
            }
            onClick={() => execute('thermal.run')}
          >
            <Play size={15} />
            Run
          </button>
        )}
      </footer>
    </section>
  );
}
