import { Eye, EyeOff } from 'lucide-react';
import { schematicLayerOptions, type SchematicLayers as Layers } from '@/lib/schematic-layers';

const textLayers = ['references', 'pinNames', 'pinNumbers', 'values', 'notes'] as const;

export default function SchematicLayers({
  layers,
  onChange,
  disabled,
  error,
}: {
  layers: Layers;
  onChange: (layers: Layers) => void;
  disabled: boolean;
  error: string;
}) {
  return (
    <div className="schematic-visibility-list">
      {textLayers.map((id) => {
        const { label, color } = schematicLayerOptions.find((option) => option.id === id)!;
        return (
          <label className="editor-visibility-row" key={id}>
            <span className="editor-visibility-name">
              <span
                className="editor-visibility-swatch"
                style={{ background: `var(${color})` }}
                aria-hidden="true"
              />
              <span>{label}</span>
            </span>
            <span
              className="editor-visibility-toggle"
              aria-description={layers[id] ? `Hide ${label}` : `Show ${label}`}
            >
              {layers[id] ? <Eye size={15} aria-hidden /> : <EyeOff size={15} aria-hidden />}
              <input
                type="checkbox"
                aria-label={label}
                checked={layers[id]}
                disabled={disabled}
                onChange={(event) => onChange({ ...layers, [id]: event.target.checked })}
              />
            </span>
          </label>
        );
      })}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
