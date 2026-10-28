'use client';

import { memo } from 'react';
import type { Project } from '@/lib/project';
import type { ThermalResult } from '@/lib/thermal';
import { thermalColor, type ThermalProbe, type ThermalSurface } from '@/lib/thermal-view';
import styles from './ThermalSimulation.module.css';

/** A renderer-only observation; the plugin retains ownership of the solved field. */
export type ThermalLayoutPresentation = {
  project: Project;
  fileId?: string;
  result: ThermalResult;
  surface: ThermalSurface;
  probe: ThermalProbe | null;
  shown: boolean;
  probing: boolean;
  probeAt: (point: { x: number; y: number } | null) => void;
};

const temperature = (value: number) => `${value.toFixed(2)} °C`;
const coordinate = (value: number) => Number(value.toFixed(3)).toString();
const scale = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
  .map((value) => thermalColor(value, 0, 1))
  .join(', ')})`;

export default memo(function ThermalLayoutResults({
  result,
  surface,
  probe,
}: Pick<ThermalLayoutPresentation, 'result' | 'surface' | 'probe'>) {
  return (
    <section className={styles.layoutLegend} aria-label="Layout board temperature">
      <div className={styles.legendHeader}>
        <strong>Board temperature</strong>
        <span>{surface === 'front' ? 'Front' : 'Back'}</span>
      </div>
      <div className={styles.colorScale} style={{ background: scale }} />
      <div className={styles.legendRange}>
        <span>{temperature(result.statistics.minC)}</span>
        <span>{temperature(result.statistics.maxC)}</span>
      </div>
      {probe && (
        <div className={styles.layoutProbe} role="status">
          <strong>{temperature(probe.temperatureC)}</strong>
          <span>Node {probe.node}</span>
          <span>
            {coordinate(probe.x)}, {coordinate(probe.y)}, {coordinate(probe.z)} mm
          </span>
        </div>
      )}
    </section>
  );
});
