import { Maximize2 } from 'lucide-react';

export default function LibraryPreviewFit({
  kind,
  onFit,
}: {
  kind: 'symbol' | 'footprint' | 'model';
  onFit: () => void;
}) {
  const label = `Fit ${kind} preview`;
  return (
    <button
      type="button"
      className="icon-button library-preview-fit"
      aria-label={label}
      title={label}
      onClick={onFit}
    >
      <Maximize2 size={16} aria-hidden="true" />
    </button>
  );
}
