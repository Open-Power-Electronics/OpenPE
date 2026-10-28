'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LayoutGrid } from 'lucide-react';
import { waveformGrid, waveformGridColumns, waveformGridRows } from '@/lib/waveform-layout';
import { scrollMovesAnchor } from '@/lib/popup-scroll';

const describe = (rows: number, columns: number) =>
  `${columns} ${columns === 1 ? 'column' : 'columns'} × ${rows} ${rows === 1 ? 'row' : 'rows'}`;

export default function WaveformLayoutPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Zero selects Auto; the other cells use row-major indexing.
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 300 });
  const selected = waveformGrid(value);
  const rows = active ? Math.ceil(active / waveformGridColumns) : 0;
  const columns = active ? ((active - 1) % waveformGridColumns) + 1 : 0;
  const label = selected ? describe(selected.rows, selected.columns) : 'Auto';

  function show() {
    setActive(selected ? (selected.rows - 1) * waveformGridColumns + selected.columns : 0);
    setOpen(true);
  }
  function choose(next: string) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const menu = popup.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const flip = below < menu.height && above > below;
    setPosition({
      left: Math.max(8, Math.min(rect.right - menu.width, window.innerWidth - menu.width - 8)),
      top: flip ? Math.max(8, rect.top - menu.height - 6) : rect.bottom + 6,
      maxHeight: Math.max(0, flip ? above : below),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const dismiss = () => setOpen(false);
    const scroll = (event: Event) => {
      if (scrollMovesAnchor(event, trigger.current)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="select-trigger select-compact"
        aria-label="Waveform layout"
        aria-description={`Waveform layout: ${label}`}
        title="Waveform layout"
        aria-haspopup="grid"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
          ) {
            event.preventDefault();
            if (!open) {
              show();
              return;
            }
            if (event.key === 'Home') setActive(0);
            else if (event.key === 'End') setActive(waveformGridRows * waveformGridColumns);
            else if (!active) setActive(event.key === 'ArrowUp' ? 0 : 1);
            else if (event.key === 'ArrowUp')
              setActive(rows === 1 ? 0 : active - waveformGridColumns);
            else if (event.key === 'ArrowDown')
              setActive(rows < waveformGridRows ? active + waveformGridColumns : active);
            else if (event.key === 'ArrowLeft') setActive(columns > 1 ? active - 1 : active);
            else setActive(columns < waveformGridColumns ? active + 1 : active);
          } else if (open && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            if (!event.repeat) choose(active ? `${rows}x${columns}` : 'auto');
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          } else if (event.key === 'Tab') setOpen(false);
        }}
      >
        <LayoutGrid size={17} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="select-popup waveform-layout-popup"
            style={position}
            onPointerDown={(event) => event.preventDefault()}
          >
            <div
              id={id}
              role="grid"
              aria-label="Waveform layout"
              aria-rowcount={waveformGridRows + 1}
              aria-colcount={waveformGridColumns}
            >
              <div role="row">
                <div
                  id={`${id}-0`}
                  role="gridcell"
                  aria-selected={value === 'auto'}
                  className={`select-option${active === 0 ? ' highlighted' : ''}`}
                  onPointerMove={() => setActive(0)}
                  onClick={() => choose('auto')}
                >
                  <span>Auto</span>
                  <Check
                    size={15}
                    className={value === 'auto' ? '' : 'select-check-hidden'}
                    aria-hidden="true"
                  />
                </div>
              </div>
              {Array.from({ length: waveformGridRows }, (_, row) => (
                <div role="row" className="waveform-layout-row" key={row}>
                  {Array.from({ length: waveformGridColumns }, (_, column) => {
                    const cell = row * waveformGridColumns + column + 1;
                    return (
                      <div
                        key={column}
                        id={`${id}-${cell}`}
                        role="gridcell"
                        aria-label={describe(row + 1, column + 1)}
                        title={describe(row + 1, column + 1).replace(' × ', ' ')}
                        aria-selected={value === `${row + 1}x${column + 1}`}
                        className={`waveform-layout-cell${row < rows && column < columns ? ' highlighted' : ''}`}
                        onPointerMove={() => setActive(cell)}
                        onClick={() => choose(`${row + 1}x${column + 1}`)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          trigger.current?.closest('dialog') ?? document.body,
        )}
    </>
  );
}
