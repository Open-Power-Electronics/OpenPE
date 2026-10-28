import type { SimulationResult, TransientConfig } from '../lib/spice';
import { waveformCursorIndex, waveformIndices } from '../lib/waveform';
import { waveformSampleWindow, type WaveformAxis } from '../lib/waveform-view';

export type AgentWaveformPresentation = {
  layout: string;
  linked: boolean;
  visibleCursors: [boolean, boolean];
  traces: Record<
    string,
    {
      time: WaveformAxis;
      values: WaveformAxis;
      cursors: [number, number | null];
    }
  >;
};
export type AgentSimulationState = {
  circuitId: string;
  basis: string;
  settingsVisible: boolean;
  waveformsVisible: boolean;
  status:
    | 'idle'
    | 'detecting'
    | 'unavailable'
    | 'blocked'
    | 'running'
    | 'completed'
    | 'stopped'
    | 'failed';
  settings: { label: string; value: string; unit?: string }[];
  config: TransientConfig | null;
  // Retained waveforms can remain visible while the next run's settings are edited.
  resultConfig?: TransientConfig | null;
  errors: string[];
  probe: unknown;
  selected: string[];
  result: SimulationResult | null;
  live: boolean;
  partial?: boolean;
  presentation: AgentWaveformPresentation | null;
};

function statistics(values: number[], start = 0, end = values.length - 1) {
  let min = values[start],
    max = min;
  for (let i = start + 1; i <= end; i++) {
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  return { min, max, first: values[start], last: values[end] };
}

/** Read only at submission: never scan solver samples on pointer or conversation updates. */
export function agentSimulationContext(state: AgentSimulationState) {
  const { result, presentation, live, partial, ...context } = state;
  if (!result) return { ...context, presentation, result: null };
  // Every trace remains available. Curves retain native endpoints and bucket extrema;
  // full-series extrema and exact visible cursor samples are reported separately.
  const buckets = Math.max(
    1,
    Math.min(256, Math.floor(4000 / (2 * (result.traces.length + state.selected.length)))),
  );
  return {
    ...context,
    presentation,
    result: {
      status: live ? 'live' : partial ? 'partial' : 'completed',
      sampleCount: result.time.length,
      timeUnit: 's',
      timeRange: [result.time[0], result.time.at(-1)!],
      sampling:
        'Native solver samples reduced by endpoint and bucket extrema; curves are not the full sample series.',
      traces: result.traces.map((trace) => {
        const view = presentation?.traces[trace.vector];
        const [start, end] = view
          ? waveformSampleWindow(result.time, view.time)
          : [0, result.time.length - 1];
        const cursors =
          view &&
          presentation?.visibleCursors.map((visible, which) => {
            if (!visible) return null;
            const i = waveformCursorIndex(result.time, view.cursors[which], start, end);
            return { time: result.time[i], value: trace.values[i] };
          });
        const curve = (first: number, last: number) =>
          waveformIndices(trace.values, first, last, buckets).map((i) => [
            result.time[i],
            trace.values[i],
          ]);
        return {
          vector: trace.vector,
          label: trace.label,
          unit: trace.unit,
          targets: trace.targets ?? [],
          selected: state.selected.includes(trace.vector),
          statistics: statistics(trace.values),
          samples: curve(0, result.time.length - 1),
          ...(view
            ? {
                visibleWindow: {
                  time: view.time,
                  values: view.values,
                  statistics: statistics(trace.values, start, end),
                  samples: curve(start, end),
                  cursors,
                  delta:
                    cursors?.[0] && cursors[1]
                      ? {
                          time: cursors[1].time - cursors[0].time,
                          value: cursors[1].value - cursors[0].value,
                        }
                      : null,
                },
              }
            : {}),
        };
      }),
    },
  };
}

export type AgentSimulationContext = ReturnType<typeof agentSimulationContext>;
