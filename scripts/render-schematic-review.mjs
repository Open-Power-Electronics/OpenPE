import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { projectFromNativeFiles } from '../server/project-format.mjs';

// Read-only native input; actual SchematicDrawing, CSS and production PNG export.
// No Electron window, Agent, solver, project Save or native source mutation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const match = /^--(before|after|output)=(.+)$/.exec(argument);
    if (!match)
      throw new Error(
        'Use --before=<native.kicad_pro> --after=<native.kicad_pro> --output=<review-directory>.',
      );
    return [match[1], path.resolve(match[2])];
  }),
);
if (!args.before || !args.after || !args.output)
  throw new Error(
    'Use --before=<native.kicad_pro> --after=<native.kicad_pro> --output=<review-directory>.',
  );
for (const input of [args.before, args.after]) {
  const relative = path.relative(path.dirname(input), args.output);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('Keep rendering evidence outside either native project directory.');
}
await mkdir(args.output, { recursive: true });
const output = await mkdtemp(path.join(args.output, 'capture-'));
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import SchematicDrawing from './components/SchematicDrawing';
      import { defaultSchematicLayers } from './lib/schematic-layers';
      import { visibleJunctions } from './lib/schematic-view';
      import { captureSchematicPNG } from './lib/drawing-export';
      const root = createRoot(document.getElementById('root'));
      const offset = () => ({x:0,y:0});
      const noop = () => {};
      window.renderNativeSchematicReview = circuit => {
        const points = [...circuit.parts, ...circuit.labels,
          ...circuit.wires.flatMap(wire => [wire.a,wire.b])];
        const minX = Math.min(...points.map(point => point.x)) - 20;
        const minY = Math.min(...points.map(point => point.y)) - 20;
        const width = Math.max(...points.map(point => point.x)) - minX + 20;
        const height = Math.max(...points.map(point => point.y)) - minY + 20;
        flushSync(() => root.render(<div className="canvas-wrap tool-select" data-schematic-theme="light">
          <svg data-testid="schematic-canvas" xmlns="http://www.w3.org/2000/svg"
            viewBox={[minX,minY,width,height].join(' ')} aria-label="Native schematic review">
            <SchematicDrawing drawing={circuit} libraries={circuit.libraries}
              junctions={visibleJunctions(circuit)} selection={[]}
              layers={{...defaultSchematicLayers,grid:false}}
              hitPadding={0.5} offset={offset} onPointerDown={noop} onPinPointerDown={noop}/>
          </svg>
        </div>));
      };
      window.captureNativeSchematicReview = () => captureSchematicPNG(document.querySelector('svg'));
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: path.join(output, 'bundle'),
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const report = {
  createdAt: new Date().toISOString(),
  renderer:
    'Production SchematicDrawing, stylesheet defaults and captureSchematicPNG; headless Chromium.',
  nativeInputsReadOnly: true,
  sourceMutation: false,
  output,
  images: [],
  errors: [],
};
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.setContent(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  for (const filename of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(path.join(root, filename), 'utf8') });
  await page.addStyleTag({
    content: 'html,body,#root { width:100%; height:100%; margin:0; overflow:hidden; }',
  });
  for (const css of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: css.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  for (const name of ['before', 'after']) {
    const input = args[name];
    const native = await readNativeProject(input);
    const project = projectFromNativeFiles(native);
    await page.evaluate(
      (circuit) => window.renderNativeSchematicReview(circuit),
      project.schematic,
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const image = await page.evaluate(() => window.captureNativeSchematicReview());
    const filename = path.join(output, name + '.png');
    await writeFile(filename, Buffer.from(image.dataUrl.split(',')[1], 'base64'));
    const screen = path.join(output, name + '-screen.png');
    await page.screenshot({ path: screen });
    const annotations = await page.getByTestId('schematic-canvas').evaluate((svg) => {
      const inverse = svg.getScreenCTM().inverse();
      return [...svg.querySelectorAll('.part-annotations text,.net-annotation text')].map(
        (text) => {
          const bounds = text.getBoundingClientRect();
          const a = new DOMPoint(bounds.left, bounds.top).matrixTransform(inverse);
          const b = new DOMPoint(bounds.right, bounds.bottom).matrixTransform(inverse);
          return {
            text: text.textContent,
            id: text.getAttribute('data-selection-id'),
            class: text.getAttribute('class'),
            x: a.x,
            y: a.y,
            width: b.x - a.x,
            height: b.y - a.y,
          };
        },
      );
    });
    const sourceHashes = Object.fromEntries(
      native.files.map((file) => [
        file.name,
        createHash('sha256')
          .update(Buffer.from(file.source, file.encoding === 'latin1' ? 'latin1' : 'utf8'))
          .digest('hex'),
      ]),
    );
    report.images.push({
      name,
      input,
      filename,
      screen,
      width: image.width,
      height: image.height,
      counts: {
        parts: project.schematic.parts.length,
        wires: project.schematic.wires.length,
        labels: project.schematic.labels.length,
      },
      sourceHashes,
      annotations,
    });
    console.log(
      JSON.stringify({ name, input, filename, screen, width: image.width, height: image.height }),
    );
  }
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  report.outcome = 'rendered';
} catch (error) {
  report.outcome = 'failed';
  report.errors.push(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(args.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
