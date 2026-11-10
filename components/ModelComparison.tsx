'use client';

import { useMemo, useRef, useState } from 'react';
import { modelCadFromProject } from '@/lib/model-cad';
import { parseProject, type Project } from '@/lib/project';
import PCBModelPreview, { type PCB3DViewState } from './PCBModelPreview';

function Preview({
  project,
  source,
  fileId,
  active,
}: {
  project: Project;
  source: string;
  fileId?: string;
  active: boolean;
}) {
  const viewState = useRef<PCB3DViewState | null>(null);
  const modelCad = useMemo(() => modelCadFromProject(project), [project]);
  return project.pcb ? (
    <PCBModelPreview
      board={project.pcb}
      schematic={project.schematic}
      modelCad={modelCad}
      projectSource={source}
      fileId={fileId}
      viewState={viewState}
      active={active}
      visible={active}
      readOnly
      grid={false}
      sidebarVisible={false}
      errorTarget={null}
    />
  ) : (
    <div className="compare-sheet-missing">PCB layout not present in this version.</div>
  );
}

export default function ModelComparison({
  active,
  beforeSource,
  afterSource,
  beforeLabel,
  afterLabel,
  fileId,
}: {
  active: boolean;
  beforeSource: string;
  afterSource: string;
  beforeLabel: string;
  afterLabel: string;
  fileId?: string;
}) {
  const [sources, setSources] = useState({ beforeSource, afterSource });
  if (active && (sources.beforeSource !== beforeSource || sources.afterSource !== afterSource))
    setSources({ beforeSource, afterSource });
  const before = useMemo(() => parseProject(sources.beforeSource), [sources.beforeSource]);
  const after = useMemo(() => parseProject(sources.afterSource), [sources.afterSource]);
  return (
    <section className="model-comparison" aria-label="Model comparison">
      <div className="schematic-compare-toolbar">
        <span className="history-preview-label">3D model · Read-only</span>
      </div>
      <div className="schematic-compare-panes">
        {(
          [
            { project: before, source: sources.beforeSource, label: beforeLabel, side: 'Before' },
            { project: after, source: sources.afterSource, label: afterLabel, side: 'After' },
          ] as const
        ).map(({ project, source, label, side }) => (
          <section key={side} className="schematic-compare-pane" aria-label={`${side} model`}>
            <header>
              <span>{side}</span>
              <strong title={label}>{label}</strong>
            </header>
            <Preview project={project} source={source} fileId={fileId} active={active} />
          </section>
        ))}
      </div>
    </section>
  );
}
