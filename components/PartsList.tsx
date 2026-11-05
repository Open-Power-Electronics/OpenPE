import { useRef, useState } from 'react';
import { ArrowUpRight, List, Search, X } from 'lucide-react';
import type { Part } from '@/lib/circuit';
import { displayPartValue, partFields } from '@/lib/library';
import Dialog, { type DialogSizeProps } from './Dialog';

export default function PartsList({
  parts,
  selected,
  onEdit,
  onLocate,
  onClose,
  size,
  onResize,
}: {
  parts: Part[];
  selected: string | null;
  onEdit: (id: string) => void;
  onLocate: (id: string) => void;
  onClose: () => void;
} & DialogSizeProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const components = parts
    .filter((part) => !part.ref.startsWith('#'))
    .map((part) => ({
      part,
      value: displayPartValue(part),
      footprint: partFields(part).Footprint || '',
    }));
  const search = query.trim().toLowerCase();
  const matches = components.filter(({ part, value, footprint }) =>
    [part.ref, value, footprint].some((text) => text.toLowerCase().includes(search)),
  );
  return (
    <Dialog
      title="List"
      icon={<List size={16} />}
      className="independent-window parts-panel"
      onClose={onClose}
      size={size}
      onResize={onResize}
      minWidth={340}
    >
      <div className="parts-panel-navigation">
        <div className="library-search parts-panel-search">
          <Search size={16} aria-hidden />
          <input
            ref={searchRef}
            data-autofocus
            aria-label="Search parts"
            placeholder="Reference, value or footprint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== 'Escape') return;
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              ) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (matches.length === 1) onLocate(matches[0].part.id);
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear parts search"
              title="Clear parts search"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <X size={15} aria-hidden />
            </button>
          )}
        </div>
        <div className="parts-panel-heading" aria-hidden="true">
          <div>
            <span>Ref.</span>
            <span>Value</span>
            <span>Footprint</span>
          </div>
          <span />
        </div>
      </div>
      <div className="parts-panel-list">
        {matches.map(({ part: p, footprint: assignedFootprint, value }) => {
          const footprint = assignedFootprint || 'No footprint';
          return (
            <div className="parts-panel-row" key={p.id}>
              <button
                className="parts-panel-edit"
                aria-description={[p.ref, value, footprint].join(' · ')}
                aria-label={'Edit ' + p.ref}
                data-autofocus={selected === p.id || undefined}
                onClick={() => onEdit(p.id)}
              >
                <strong aria-description={p.ref}>{p.ref}</strong>
                <span aria-description={value}>{value}</span>
                <span className="parts-panel-footprint" aria-description={footprint}>
                  {footprint}
                </span>
              </button>
              <button
                className="parts-panel-locate"
                aria-label={'Locate ' + p.ref}
                title="Locate part"
                onClick={() => onLocate(p.id)}
              >
                <ArrowUpRight size={15} />
              </button>
            </div>
          );
        })}
        {!matches.length && (
          <p className="panel-empty">
            {components.length ? 'No matching components' : 'No components'}
          </p>
        )}
      </div>
    </Dialog>
  );
}
