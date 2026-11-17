'use client';

import { memo, useMemo } from 'react';
import type { Footprint } from '@/lib/pcb';
import { prepareThermalModel } from '@/plugins/layout-thermal/domain/thermal';
import { thermalPadReadouts } from '@/plugins/layout-thermal/domain/thermal-pad-view';
import {
  closestThermalNode,
  pointOnThermalSurface,
} from '@/plugins/layout-thermal/domain/thermal-view';
import type { ThermalLayoutPresentation } from './ThermalLayoutResults';
import styles from './ThermalSimulation.module.css';

/** The selected component's PCB temperature belongs to the retained result card. */
export default memo(function ThermalComponentReadout({
  project,
  result,
  resultConfig,
  surface,
  footprint,
}: Pick<ThermalLayoutPresentation, 'project' | 'result' | 'resultConfig' | 'surface'> & {
  footprint: Footprint;
}) {
  const readouts = useMemo(() => {
    if (!project.pcb || !resultConfig) return [];
    try {
      return thermalPadReadouts(prepareThermalModel(project.pcb, resultConfig), result);
    } catch {
      return [];
    }
  }, [project.pcb, resultConfig, result]);
  const reading = useMemo(() => {
    const source = readouts.find((row) => row.footprintId === footprint.id);
    if (source) return { value: source.padMaxC, description: 'Maximum PCB-pad temperature' };
    const probe = pointOnThermalSurface(result, footprint, surface)
      ? closestThermalNode(result, footprint, surface)
      : null;
    return {
      value: probe?.temperatureC ?? null,
      description: 'PCB surface temperature at component centre',
    };
  }, [readouts, result, footprint, surface]);
  const reference =
    footprint.reference ||
    project.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref ||
    footprint.id.slice(0, 8);
  return (
    <output
      className={styles.selectedReadout}
      data-thermal-component-readout={footprint.id}
      aria-label="Selected component temperature"
      aria-description={reading.description}
      aria-live="polite"
    >
      <strong>{reference}</strong>
      <span>{reading.value === null ? 'Unavailable' : `${reading.value.toFixed(2)} °C`}</span>
    </output>
  );
});
