'use client';

import { useMemo } from 'react';
import type { Project } from '@/lib/project';
import { prepareThermalModel, type ThermalConfig, type ThermalResult } from '@/lib/thermal';
import { thermalPadReadouts } from '@/lib/thermal-pad-view';
import styles from './ThermalSimulation.module.css';

export default function ThermalHeatPaths({
  project,
  result,
  config,
  onLocate,
}: {
  project: Project;
  result: ThermalResult;
  config: ThermalConfig;
  onLocate?: (footprintId: string) => boolean;
}) {
  const readout = useMemo(() => {
    try {
      const board = project.pcb!;
      const references = new Map(
        board.footprints.map((footprint) => [
          footprint.id,
          footprint.reference ||
            project.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref ||
            footprint.id.slice(0, 8),
        ]),
      );
      return {
        rows: thermalPadReadouts(prepareThermalModel(board, config), result, references)
          .filter((row) => row.padMaxC !== null)
          .sort(
            (a, b) =>
              b.padMaxC! - a.padMaxC! ||
              a.reference.localeCompare(b.reference, 'en', { numeric: true }),
          )
          .slice(0, 5),
        error: '',
      };
    } catch (error) {
      return { rows: [], error: (error as Error).message };
    }
  }, [project, config, result]);
  const temperature = (value: number | null) =>
    value === null ? 'Unavailable' : `${value.toFixed(2)} °C`;
  return (
    <div className={styles.heatPaths}>
      {readout.error ? (
        <p role="alert">{readout.error}</p>
      ) : (
        <ol
          aria-label="Hottest components"
          title="Top five modeled heat sources by maximum PCB-pad temperature"
        >
          {readout.rows.map((row) => (
            <li key={row.footprintId}>
              <button
                type="button"
                className={styles.heatComponent}
                aria-label={`Locate heat source ${row.reference}`}
                title={`${row.reference} · Mean pad ${temperature(row.padMeanC)} · Heat into PCB ${Number(row.powerW.toPrecision(5))} W`}
                disabled={!onLocate}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                    event.preventDefault();
                }}
                onClick={() => onLocate?.(row.footprintId)}
              >
                <strong>{row.reference}</strong>
                <span title="Maximum PCB-pad temperature">{temperature(row.padMaxC)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {!readout.error && !readout.rows.length && <p>Pad temperatures unavailable.</p>}
    </div>
  );
}
