// Isolated SVG layout QA: no Electron, service, providers, solver or user files.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import manifest from '../resources/example-catalog/home-manifest.json' with { type: 'json' };

const catalog = [...manifest.recent, ...manifest.examples];
assert.equal(catalog.length, 10);
assert.equal(new Set(catalog.map((entry) => entry.id)).size, 10);
const output = 'test-results/example-text-layout';
const auditOnly = process.argv.includes('--audit');
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import Canvas from './components/Canvas';
      import {createHomeExample} from './lib/create-home-example';
      import {defaultSchematicLayers} from './lib/schematic-layers';
      import {pinPositions} from './lib/circuit';
      import {onWire,samePoint} from './lib/wiring';
      function describeRow(project){
        const d=project.schematic;
        const roots=d.parts.filter(p=>/^J\\d+$/.test(p.ref)&&/^Connector(?:_|:)/.test(p.libId)||p.ref==='V1'||p.libId==='Device:R'&&!project.pcb.footprints.some(f=>f.symbolId===p.id));
        const xs=[...new Set(roots.map(p=>p.x))].sort((a,b)=>a-b);
        const owners={};
        for(const [column,x] of xs.entries()){
          const parts=roots.filter(p=>p.x===x),points=parts.flatMap(p=>pinPositions(p,d.libraries[p.libId]));
          const wires=new Set();
          for(let changed=true;changed;){changed=false;for(const w of d.wires){if(wires.has(w.id)||!points.some(p=>onWire(p,w)))continue;wires.add(w.id);points.push(w.a,w.b);changed=true;}}
          const attached=p=>points.some(q=>samePoint(p,q))||d.wires.some(w=>wires.has(w.id)&&onWire(p,w));
          const members=[...parts,...d.parts.filter(p=>p.libId.startsWith('power:')&&pinPositions(p,d.libraries[p.libId]).some(attached)),...d.labels.filter(attached),...d.junctions.filter(attached),...(d.noConnects||[]).filter(attached)];
          for(const item of [...members,...[...wires].map(id=>({id}))]){if(owners[item.id]!==undefined&&owners[item.id]!==column)throw new Error('Example row assemblies are physically joined.');owners[item.id]=column;}
        }
        return {xs,owners,refs:Object.fromEntries(d.parts.filter(p=>owners[p.id]!==undefined).map(p=>[p.ref,owners[p.id]]))};
      }
      function Fixture(){const [project,setProject]=useState(createHomeExample(window.exampleId,id=>id));
        window.chooseExample=id=>{const next=createHomeExample(id,id=>id);window.expectedProjectId=next.id;setProject(next);};
        window.exampleProject=project;
        window.exampleRow=project.extensions['org.openpe.reference-example']?describeRow(project):null;
        return <Canvas key={project.id} doc={project.schematic} selection={[]} onSelection={()=>{}}
          onSelect={()=>{}} tool="select" setTool={()=>{}} kind="R"
          annotations={[]} annotationSessionId="example-text" onAnnotationsChange={()=>{}} onCommit={()=>false} fitKey={1}
          onPosition={()=>{}} grid={false} gridSpacing={1.27} layers={defaultSchematicLayers}/>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = (
  await Promise.all(['app/globals.css', 'app/workspace.css'].map((file) => readFile(file, 'utf8')))
).join('\n');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});

// These helpers deliberately test the drawn primitives, rather than the loose
// bounding box around (for example) an inductor or a multi-pin symbol.
function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}
function distanceToSegment(p, a, b) {
  const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = length
    ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length))
    : 0;
  return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
}
function intersects(a, b, c, d) {
  return (
    cross(a, b, c) * cross(a, b, d) <= 0 &&
    cross(c, d, a) * cross(c, d, b) <= 0 &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <=
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))
  );
}
function segmentHitsPolygon(a, b, polygon, padding = 0) {
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return true;
  return polygon.some((c, i) => {
    const d = polygon[(i + 1) % polygon.length];
    return (
      intersects(a, b, c, d) ||
      (padding > 0 &&
        Math.min(
          distanceToSegment(a, c, d),
          distanceToSegment(b, c, d),
          distanceToSegment(c, a, b),
          distanceToSegment(d, a, b),
        ) < padding)
    );
  });
}
function polygonsOverlap(a, b) {
  return (
    a.some((p) => pointInPolygon(p, b)) ||
    b.some((p) => pointInPolygon(p, a)) ||
    a.some((p, i) => segmentHitsPolygon(p, a[(i + 1) % a.length], b))
  );
}
function boundsOverlap(a, b, padding = 0) {
  return (
    a.x < b.x + b.width + padding &&
    a.x + a.width > b.x - padding &&
    a.y < b.y + b.height + padding &&
    a.y + a.height > b.y - padding
  );
}

const reports = [];
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1080 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost/');
  await page.evaluate((id) => {
    window.exampleId = id;
  }, catalog[0].id);
  await page.addStyleTag({ content: css });
  await page.addStyleTag({
    content: 'html,body,#root,.canvas-wrap{height:100%;margin:0} body{overflow:hidden}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const entry of catalog) {
    await page.evaluate((id) => window.chooseExample(id), entry.id);
    await page.waitForFunction(() => window.exampleProject?.id === window.expectedProjectId);
    await page.getByTestId('schematic-canvas').waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const data = await page.getByTestId('schematic-canvas').evaluate((svg) => {
      const world = svg.getScreenCTM().inverse();
      const point = (node, x, y) => {
        const p = new DOMPoint(x, y).matrixTransform(node.getScreenCTM()).matrixTransform(world);
        return { x: p.x, y: p.y };
      };
      const visible = (node) => {
        for (let current = node; current && current !== svg; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          )
            return false;
        }
        return !node.closest('defs,[data-export-exclude],[data-selection-only]');
      };
      const bounds = (points) => {
        const xs = points.map((p) => p.x),
          ys = points.map((p) => p.y);
        const x = Math.min(...xs),
          y = Math.min(...ys);
        return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      };
      const texts = [...svg.querySelectorAll('text')]
        .filter(visible)
        .map((node, index) => {
          const box = node.getBBox();
          const polygon = [
            [box.x, box.y],
            [box.x + box.width, box.y],
            [box.x + box.width, box.y + box.height],
            [box.x, box.y + box.height],
          ].map(([x, y]) => point(node, x, y));
          const testId = node.getAttribute('data-testid') || '';
          const part = node
            .closest('[data-testid^="part-"]')
            ?.getAttribute('data-testid')
            ?.slice(5);
          const field = testId.match(/^annotation-(ref|value|field)-(.+)$/);
          return {
            id: testId || `symbol-text-${part || index}-${index}`,
            text: node.textContent,
            kind: field
              ? field[1] === 'ref'
                ? 'Reference'
                : field[1] === 'value'
                  ? 'Value'
                  : field[2].split('-').slice(1).join('-')
              : part
                ? 'pin-text'
                : node.closest('.net-annotation')
                  ? 'net-label'
                  : 'note',
            ref: field ? field[2].replace(/-Sim\.Params$/, '') : part || null,
            field: Boolean(field),
            owner: node.closest('[data-selection-id]')?.getAttribute('data-selection-id'),
            polygon,
            bbox: bounds(polygon),
            baseline: point(
              node,
              Number(node.getAttribute('x') || 0),
              Number(node.getAttribute('y') || 0),
            ),
            anchor: node.getAttribute('text-anchor') || 'start',
            font: getComputedStyle(node).font,
            localBox: { x: box.x, y: box.y, width: box.width, height: box.height },
          };
        })
        .filter((node) => node.text && node.bbox.width > 0 && node.bbox.height > 0);
      const shapes = [...svg.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')]
        .filter((node) => visible(node) && !node.hasAttribute('data-schematic-background'))
        .flatMap((node, index) => {
          const style = getComputedStyle(node);
          const hasStroke =
            style.stroke !== 'none' &&
            style.stroke !== 'transparent' &&
            Number(style.strokeOpacity) > 0;
          const hasFill =
            style.fill !== 'none' && style.fill !== 'transparent' && Number(style.fillOpacity) > 0;
          if ((!hasStroke && !hasFill) || !(node instanceof SVGGeometryElement)) return [];
          const length = node.getTotalLength();
          if (!Number.isFinite(length) || length <= 0) return [];
          const steps = Math.max(1, Math.ceil(length / 0.08));
          const points = Array.from({ length: steps + 1 }, (_, n) => {
            const p = node.getPointAtLength((length * n) / steps);
            return point(node, p.x, p.y);
          });
          const segments = [];
          for (let n = 1; n < points.length; n++) {
            // getPointAtLength can jump over a move-to into a distinct subpath.
            if (Math.hypot(points[n].x - points[n - 1].x, points[n].y - points[n - 1].y) < 0.2)
              segments.push([points[n - 1], points[n]]);
          }
          const part = node
            .closest('[data-testid^="part-"]')
            ?.getAttribute('data-testid')
            ?.slice(5);
          const net = node.closest('.net-annotation')?.getAttribute('data-testid');
          const kind = part
            ? 'symbol'
            : net
              ? 'net-label'
              : node.tagName === 'circle'
                ? 'junction'
                : 'wire';
          return [
            {
              id: `${kind}-${part || net || index}-${index}`,
              kind,
              ref: part || null,
              owner: node.closest('[data-selection-id]')?.getAttribute('data-selection-id'),
              tag: node.tagName,
              strokeWidth: hasStroke ? parseFloat(style.strokeWidth) : 0,
              filled: hasFill,
              points,
              segments,
              bbox: bounds(points),
              attributes: Object.fromEntries(
                [
                  'd',
                  'points',
                  'x',
                  'y',
                  'x1',
                  'x2',
                  'y1',
                  'y2',
                  'cx',
                  'cy',
                  'r',
                  'width',
                  'height',
                ]
                  .filter((name) => node.hasAttribute(name))
                  .map((name) => [name, node.getAttribute(name)]),
              ),
            },
          ];
        });
      return {
        projectId: window.exampleProject.id,
        row: window.exampleRow,
        fields: texts.filter((t) => t.field),
        texts: texts.filter((t) => !t.field),
        shapes,
      };
    });
    const collisions = [];
    for (const field of data.fields) {
      for (const text of [...data.texts, ...data.fields]) {
        if (text.id === field.id || (text.field && text.id < field.id)) continue;
        if (boundsOverlap(field.bbox, text.bbox) && polygonsOverlap(field.polygon, text.polygon))
          collisions.push({
            field: field.id,
            text: field.text,
            obstacle: text.id,
            kind: text.kind,
            obstacleText: text.text,
          });
      }
      for (const shape of data.shapes) {
        if (!boundsOverlap(field.bbox, shape.bbox, shape.strokeWidth / 2)) continue;
        if (
          (shape.strokeWidth &&
            shape.segments.some(([a, b]) =>
              segmentHitsPolygon(a, b, field.polygon, shape.strokeWidth / 2),
            )) ||
          (shape.filled &&
            (field.polygon.some((p) => pointInPolygon(p, shape.points)) ||
              shape.points.some((p) => pointInPolygon(p, field.polygon))))
        )
          collisions.push({
            field: field.id,
            text: field.text,
            obstacle: shape.id,
            kind: shape.kind,
            ref: shape.ref,
          });
      }
    }
    const items = [...data.fields, ...data.texts, ...data.shapes].map((item) => ({
      ...item,
      column: data.row?.owners[item.owner] ?? data.row?.refs[item.ref],
      left: item.bbox.x - (item.strokeWidth || 0) / 2,
      right: item.bbox.x + item.bbox.width + (item.strokeWidth || 0) / 2,
      top: item.bbox.y - (item.strokeWidth || 0) / 2,
      bottom: item.bbox.y + item.bbox.height + (item.strokeWidth || 0) / 2,
    }));
    const rowColumns = (data.row?.xs ?? []).map((x, column) => {
      const members = items.filter((item) => item.column === column);
      assert.ok(members.length, `${entry.id}: row column ${column} is visible.`);
      return {
        x,
        left: Math.min(...members.map((item) => item.left)),
        right: Math.max(...members.map((item) => item.right)),
        bottom: Math.max(...members.map((item) => item.bottom)),
      };
    });
    const lower = items.filter((item) => item.column === undefined);
    const lowerBounds = {
      left: Math.min(...lower.map((item) => item.left)),
      right: Math.max(...lower.map((item) => item.right)),
      top: Math.min(...lower.map((item) => item.top)),
    };
    const gaps = rowColumns.slice(1).map((column, i) => column.left - rowColumns[i].right);
    const rowLayout = data.row
      ? {
          columns: rowColumns,
          gaps,
          leftOffset: rowColumns[0].left - lowerBounds.left,
          rightOffset: rowColumns.at(-1).right - lowerBounds.right,
          verticalGap: lowerBounds.top - Math.max(...rowColumns.map((column) => column.bottom)),
        }
      : null;
    const report = {
      id: entry.id,
      fields: data.fields.length,
      collisions: collisions.length,
      rowLayout,
    };
    reports.push(report);
    await writeFile(
      `${output}/${entry.id}.json`,
      JSON.stringify({ id: entry.id, ...data, collisions, rowLayout }, null, 2),
    );
    await page.getByTestId('schematic-canvas').screenshot({ path: `${output}/${entry.id}.png` });
    console.log(`${entry.id}: ${data.fields.length} fields, ${collisions.length} overlaps`);
    if (rowLayout)
      console.log(
        `  Row gaps: ${gaps.map((gap) => gap.toFixed(2)).join(', ')} mm; edge offsets ${rowLayout.leftOffset.toFixed(2)}, ${rowLayout.rightOffset.toFixed(2)} mm; vertical gap ${rowLayout.verticalGap.toFixed(2)} mm`,
      );
    for (const collision of collisions.slice(0, 20))
      console.log(
        `  ${collision.field} (${collision.text}) / ${collision.obstacle} ${collision.obstacleText || ''}`,
      );
  }
  assert.deepEqual(errors, [], 'Renderer errors');
  await writeFile(`${output}/summary.json`, JSON.stringify(reports, null, 2));
  if (!auditOnly)
    assert.equal(
      reports.reduce((total, report) => total + report.collisions, 0),
      0,
      `Example annotations overlap; see ${output}/summary.json`,
    );
  if (!auditOnly)
    for (const report of reports) {
      if (!report.rowLayout) continue;
      const { gaps, leftOffset, rightOffset, verticalGap } = report.rowLayout;
      const precision = 0.001; // SVG glyph measurements use single-precision coordinates.
      assert.ok(Math.min(...gaps) > 0, `${report.id}: row columns overlap.`);
      assert.ok(
        Math.max(...gaps) - Math.min(...gaps) <= 1.27 + precision,
        `${report.id}: row gaps differ by more than grid tolerance.`,
      );
      assert.ok(
        Math.abs(leftOffset) <= 1.27 + precision && Math.abs(rightOffset) <= 1.27 + precision,
        `${report.id}: row width differs from the lower circuit.`,
      );
      assert.ok(
        verticalGap >= 2.54 - precision,
        `${report.id}: row annotations are too close to the lower circuit.`,
      );
    }
} finally {
  await browser.close();
}
