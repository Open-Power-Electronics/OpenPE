import { Children, cloneElement, isValidElement, type CSSProperties, type ReactNode } from 'react';

const colors = [
  'wire',
  'symbol',
  'symbol-physical',
  'symbol-virtual',
  'schematic-reference',
  'schematic-value',
  'schematic-field',
  'schematic-pin-name',
  'schematic-pin-number',
  'schematic-net-label',
  'schematic-global-label',
  'schematic-note',
];
const sources = Object.fromEntries(
  colors.map((color) => [`--selection-source-${color}`, `var(--${color})`]),
) as CSSProperties;
const paint = Object.fromEntries(
  colors.map((color) => [
    `--${color}`,
    color === 'symbol' || color === 'symbol-physical'
      ? 'var(--schematic-selection-ink)'
      : `color-mix(in srgb, var(--selection-source-${color}), var(--schematic-selection-tone) 75%)`,
  ]),
) as CSSProperties;

function visualCopy(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<Record<string, unknown>>(child) || typeof child.type !== 'string')
      return child;
    return cloneElement(
      child,
      {
        id: undefined,
        'data-selection-id': undefined,
        'data-testid': undefined,
        onPointerDown: undefined,
        // Glyph classes can explicitly enable hit testing, overriding inheritance.
        style: { ...(child.props.style as CSSProperties | undefined), pointerEvents: 'none' },
      },
      visualCopy(child.props.children as ReactNode),
    );
  });
}

/** Strong selected paint without changing line geometry, body fills or exports. */
export default function SchematicSelectionPaint({
  selected,
  color,
  children,
}: {
  selected: boolean;
  color?: string;
  children: ReactNode;
}) {
  const rgb = color?.match(/[\d.]+/g)?.map(Number);
  const neutral = rgb?.length === 3 && Math.max(...rgb) - Math.min(...rgb) < 24;
  return (
    <g style={{ ...sources, ...(color ? { '--schematic-custom-color': color } : {}) }}>
      {children}
      {selected && (
        <g
          data-selection-only
          pointerEvents="none"
          aria-hidden="true"
          style={{
            ...paint,
            ...(color
              ? {
                  '--schematic-custom-color': neutral
                    ? 'var(--schematic-selection-ink)'
                    : `color-mix(in srgb, ${color}, var(--schematic-selection-tone) 75%)`,
                }
              : {}),
          }}
        >
          {visualCopy(children)}
        </g>
      )}
    </g>
  );
}
