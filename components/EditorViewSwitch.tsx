'use client';

import { CircuitBoard, Code2 } from 'lucide-react';
import { ModelIcon, SchematicIcon } from './EditorIcons';
import RevealButton from './RevealButton';

export type EditorView = 'canvas' | 'layout' | '3d' | 'source';

export default function EditorViewSwitch({
  view,
  onChange,
}: {
  view: EditorView;
  onChange: (view: EditorView) => boolean | Promise<boolean>;
}) {
  return (
    <div className="editor-view-switch" role="group" aria-label="Editor view">
      <RevealButton
        icon={SchematicIcon}
        label="Schematic"
        active={view === 'canvas'}
        onClick={() => onChange('canvas')}
      />
      <RevealButton
        icon={CircuitBoard}
        label="Layout"
        active={view === 'layout'}
        onClick={() => onChange('layout')}
      />
      <RevealButton
        icon={ModelIcon}
        label="Model"
        active={view === '3d'}
        onClick={() => onChange('3d')}
      />
      <RevealButton
        icon={Code2}
        label="Source"
        active={view === 'source'}
        onClick={() => onChange('source')}
      />
    </div>
  );
}
