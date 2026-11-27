import { useEffect, useId, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { PCBBarcode } from '@/lib/pcb-barcode';
import { pcbLayerColor } from '@/lib/pcb-display';
import { pcbStrokeText } from '@/lib/pcb-stroke-text';

type Matrix = { columns: number; rows: number; path: string };

function matrixPath(
  columns: number,
  rows: number,
  dark: (row: number, column: number) => boolean,
): Matrix {
  const marks = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      if (dark(row, column)) marks.push(`M${column} ${row}h1v1h-1z`);
  return { columns, rows, path: marks.join('') };
}

function encodeQR(barcode: Extract<PCBBarcode, { kind: 'qr' }>): Matrix {
  const { ecc, value } = barcode;
  const code = qrcode(0, ecc);
  const mode = /^\d+$/.test(value)
    ? 'Numeric'
    : /^[0-9A-Z $%*+./:-]+$/.test(value)
      ? 'Alphanumeric'
      : 'Byte';
  code.addData(value, mode);
  code.make();
  const count = code.getModuleCount();
  return matrixPath(count, count, (row, column) => code.isDark(row, column));
}

async function encodeDataMatrix(value: string): Promise<Matrix> {
  const module = await import('@bwip-js/generic');
  // The package declaration describes the classic default encoder API.
  const { raw } = (module as typeof module & { default: typeof module }).default;
  const [square] = raw('datamatrix', value, 'format=square');
  if (!square || !('pixs' in square)) throw new Error('Unable to display native PCB Data Matrix.');
  let matrix = square;
  try {
    const [rectangle] = raw('datamatrix', value, 'format=rectangle');
    if (
      rectangle &&
      'pixs' in rectangle &&
      rectangle.pixx * rectangle.pixy <= square.pixx * square.pixy
    )
      matrix = rectangle;
  } catch {
    // Longer payloads fit only the verified square symbol set.
  }
  return matrixPath(
    matrix.pixx,
    matrix.pixy,
    (row, column) => matrix.pixs[row * matrix.pixx + column] === 1,
  );
}

function barcodeCaption(barcode: PCBBarcode) {
  if (!barcode.showText) return;
  const size = barcode.textHeight;
  const stroke = pcbStrokeText(
    { value: barcode.value, rotation: 0, size: { x: size, y: size }, thickness: 0 },
    { x: 0, y: 0 },
  );
  if ('unsupported' in stroke || !stroke.paths.length) return;
  const points = stroke.paths.flat();
  const minX = Math.min(...points.map(({ x }) => x));
  const maxX = Math.max(...points.map(({ x }) => x));
  const minY = Math.min(...points.map(({ y }) => y));
  const maxY = Math.max(...points.map(({ y }) => y));
  const x = -(minX + maxX) / 2;
  const y = barcode.height / 2 + 1 - minY + stroke.width / 2;
  const path = stroke.paths
    .map((line) => line.map((pt, index) => `${index ? 'L' : 'M'}${pt.x + x} ${pt.y + y}`).join(' '))
    .join(' ');
  return {
    path,
    width: stroke.width,
    reach: (maxX - minX + stroke.width) / 2,
    bottom: y + maxY + stroke.width / 2,
  };
}

export default function LayoutBarcode({ barcode }: { barcode: PCBBarcode }) {
  const { id, layer, x, y, rotation, width, height, value, knockout } = barcode;
  const maskId = `pcb-barcode-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const qr = useMemo(() => (barcode.kind === 'qr' ? encodeQR(barcode) : undefined), [barcode]);
  const caption = useMemo(() => barcodeCaption(barcode), [barcode]);
  const [decoded, setDecoded] = useState<{ value: string; matrix?: Matrix; error?: Error }>();
  useEffect(() => {
    if (barcode.kind !== 'datamatrix') return;
    let active = true;
    encodeDataMatrix(value).then(
      (matrix) => {
        if (active) setDecoded({ value, matrix });
      },
      () => {
        if (active)
          setDecoded({ value, error: new Error('Unable to display native PCB Data Matrix.') });
      },
    );
    return () => {
      active = false;
    };
  }, [barcode.kind, value]);
  if (barcode.kind === 'datamatrix' && decoded?.value === value && decoded.error)
    throw decoded.error;
  const matrix = qr ?? (decoded?.value === value ? decoded.matrix : undefined);
  if (!matrix) return null;
  const color = pcbLayerColor(layer);
  const matrixTransform = `translate(${-width / 2} ${-height / 2}) scale(${width / matrix.columns} ${height / matrix.rows})`;
  const symbol = (ink: string) => (
    <>
      <path transform={matrixTransform} fill={ink} d={matrix.path} />
      {caption && (
        <path
          d={caption.path}
          fill="none"
          stroke={ink}
          strokeWidth={caption.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </>
  );
  const minimum = Math.ceil(Math.min(width, height)) / 10;
  const marginX = Math.max(minimum, barcode.marginX);
  const marginY = Math.max(minimum, barcode.marginY);
  const reach = Math.max(width / 2, caption?.reach ?? 0) + marginX;
  const top = -height / 2 - marginY;
  const bottom = Math.max(height / 2, caption?.bottom ?? 0) + marginY;
  const rectangle = { x: -reach, width: 2 * reach, y: top, height: bottom - top };
  return (
    <g
      data-layout-barcode={id}
      data-pcb-layer={layer}
      aria-label={`${barcode.kind === 'qr' ? 'QR code' : 'Data Matrix'} · ${value}`}
      transform={`translate(${x} ${y}) rotate(${-rotation})`}
    >
      <g transform={layer.startsWith('B.') ? 'scale(-1 1)' : undefined}>
        {knockout ? (
          <>
            <defs>
              <mask id={maskId} maskUnits="userSpaceOnUse" {...rectangle}>
                <rect {...rectangle} fill="white" />
                {symbol('black')}
              </mask>
            </defs>
            <rect {...rectangle} fill={color} mask={`url(#${maskId})`} />
          </>
        ) : (
          symbol(color)
        )}
      </g>
    </g>
  );
}
