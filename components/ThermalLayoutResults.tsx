'use client';

import { memo, type ReactNode } from 'react';
import type { Project } from '@/lib/project';
import type { Footprint } from '@/lib/pcb';
import type { ThermalConfig, ThermalResult } from '@/lib/thermal';
import { thermalColor, type ThermalProbe, type ThermalSurface } from '@/lib/thermal-view';
import styles from './ThermalSimulation.module.css';
import ThermalHeatPaths from './ThermalHeatPaths';
import ThermalComponentReadout from './ThermalComponentReadout';

/** A renderer-only observation; the plugin retains ownership of the solved field. */
export type ThermalLayoutPresentation = {
  project: Project;
  fileId?: string;
  result: ThermalResult;
  controls: ReactNode;
  resultConfig: ThermalConfig | null;
  onLocateFootprint?: (footprintId: string) => boolean;
  surface: ThermalSurface;
  probe: ThermalProbe | null;
  shown: boolean;
  outlinesShown: boolean;
  probing: boolean;
  probeAt: (point: { x: number; y: number } | null) => void;
};

const formatted = (value: number) => Number(value.toPrecision(6)).toString();
const temperature = (value: number) => `${value.toFixed(2)} °C`;
const scale = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
  .map((value) => thermalColor(value, 0, 1))
  .join(', ')})`;

export default memo(function ThermalLayoutResults({
  result,
  controls,
  probe,
  project,
  resultConfig,
  onLocateFootprint,
  surface,
  selectedFootprint,
}: Pick<
  ThermalLayoutPresentation,
  'result' | 'controls' | 'probe' | 'project' | 'resultConfig' | 'onLocateFootprint' | 'surface'
> & { selectedFootprint?: Footprint | null }) {
  return (
    <section className={styles.layoutLegend} aria-label="Layout board temperature">
      {controls}
      <div className={styles.colorScale} style={{ background: scale }} />
      <div className={styles.legendRange}>
        <span>{temperature(result.statistics.minC)}</span>
        <span>{temperature(result.statistics.maxC)}</span>
      </div>
      <ThermalResultStatistics result={result} />
      {project.pcb && resultConfig && (
        <ThermalHeatPaths
          project={project}
          result={result}
          config={resultConfig}
          onLocate={onLocateFootprint}
        />
      )}
      {selectedFootprint && (
        <ThermalComponentReadout
          project={project}
          result={result}
          resultConfig={resultConfig}
          surface={surface}
          footprint={selectedFootprint}
        />
      )}
      {probe && (
        <output
          className={styles.selectedReadout}
          data-thermal-probe-readout=""
          aria-label="Probe temperature"
          aria-description={`Node ${probe.node}; ${probe.x}, ${probe.y}, ${probe.z} mm`}
          aria-live="polite"
        >
          <span>Probe</span>
          <strong>{temperature(probe.temperatureC)}</strong>
        </output>
      )}
    </section>
  );
});

export function ThermalResultStatistics({ result }: { result: ThermalResult }) {
  return (
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
    </div>
  );
}
