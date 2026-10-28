import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Isolated SVG renderer: no Electron, native host, provider or user documents.
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
      import React, { useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useAnnotationSelectionOutline } from './components/AnnotationSelectionOutline';
      import { captureAnnotationImage } from './lib/annotation-screenshot';
      import { captureSchematicPNG } from './lib/drawing-export';
      function Fixture() {
        const svg = useRef(null);
        const [ids, select] = useState(['circle']);
        const [width, zoom] = useState(160);
        useAnnotationSelectionOutline(svg, ids, true, { x: 0, y: 0, width });
        window.select = select;
        window.zoom = zoom;
        window.capture = () => captureAnnotationImage(svg.current, ids);
        window.exportPNG = () => captureSchematicPNG(svg.current);
        return <svg ref={svg} width="320" height="180" viewBox={'0 0 ' + width + ' ' + width * 180 / 320}>
          <g data-selection-id="circle">
            <rect data-export-exclude x="10" y="10" width="40" height="40" fill="transparent" />
            <circle cx="30" cy="30" r="10" fill="#333" />
          </g>
          <g transform="translate(80 30) rotate(30)">
            <path data-selection-id="triangle" d="M -10 10 L 0 -10 L 10 10 Z" fill="#333" />
          </g>
          <line data-selection-id="wire" x1="20" y1="65" x2="60" y2="65" stroke="#333" strokeWidth="1" />
          <g style={{ display: 'none' }}><circle data-selection-id="hidden" cx="110" cy="30" r="10" /></g>
        </svg>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 220 } });
  await page.setContent(
    '<style>body{margin:0;background:white}svg{--canvas:#fff;--annotation-mark:#528bff}</style><div id="root"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const outline = page.locator('[data-annotation-selection-outline]');
  await outline.waitFor({ state: 'attached' });
  assert.equal(await outline.locator('[data-selection-id]').count(), 0);
  assert.equal(
    await outline.locator('rect').count(),
    0,
    'Transparent hit rectangles never become outlines.',
  );
  const pixels = async () =>
    sharp(await page.locator('svg').screenshot())
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const blue = ({ data, info }, x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return data[offset + 2] > data[offset] + 60 && data[offset + 2] > data[offset + 1] + 30;
  };
  let image = await pixels();
  assert.ok(blue(image, 81, 60), 'The circle has a blue rim.');
  assert.ok(!blue(image, 80, 40), 'The circle has no bounding-box corner.');
  assert.ok(!blue(image, 60, 60), 'The original circle fill stays intact.');
  const captured = await page.evaluate(() => window.capture());
  const capturePixels = await sharp(Buffer.from(captured.dataUrl.split(',')[1], 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    capturePixels.some((channel, i) => i % 3 === 2 && channel > capturePixels[i - 2] + 60),
    'Element captures retain the blue contour.',
  );
  const exported = await page.evaluate(() => window.exportPNG());
  const exportPixels = await sharp(Buffer.from(exported.dataUrl.split(',')[1], 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    !exportPixels.some((channel, i) => i % 3 === 2 && channel > exportPixels[i - 2] + 60),
    'Ordinary PNG export excludes annotation contours.',
  );
  await page.evaluate(() => window.select(['triangle']));
  await page.waitForFunction(() =>
    document.querySelector('[data-annotation-selection-outline] path'),
  );
  image = await pixels();
  assert.ok(blue(image, 170, 42), 'A rotated triangle retains its transformed edge.');
  await page.evaluate(() => window.select(['wire']));
  await page.waitForFunction(() =>
    document.querySelector('[data-annotation-selection-outline] line'),
  );
  image = await pixels();
  assert.ok(
    blue(image, 80, 132),
    'A horizontal wire with zero geometric height retains its outline.',
  );
  await page.evaluate(() => window.zoom(80));
  await page.waitForFunction(() =>
    document.querySelector('svg').getAttribute('viewBox').includes('80'),
  );
  image = await pixels();
  // Select an on-screen circle after zoom and retain a two-screen-pixel rim.
  await page.evaluate(() => window.select(['circle']));
  await page.waitForFunction(() =>
    document.querySelector('[data-annotation-selection-outline] circle'),
  );
  image = await pixels();
  assert.ok(blue(image, 161, 120));
  assert.ok(!blue(image, 164, 120), 'Zoom does not enlarge the screen-space contour.');
  await page.evaluate(() => window.select(['hidden']));
  await page.waitForFunction(
    () => !document.querySelector('[data-annotation-selection-outline] circle'),
  );
  await page.evaluate(() => window.select([]));
  await outline.waitFor({ state: 'detached' });
  console.log(
    'PASS: circular/rotated/wire contours, zoom, hidden geometry, capture, export and cleanup.',
  );
} finally {
  await browser.close();
}
