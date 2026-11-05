import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real measurement subscribers and SVG overlays, isolated from Electron and project I/O.
const bundle = await build({
  stdin: {
    contents: `
import React,{useLayoutEffect,useRef,useState}from'react';
import{createRoot}from'react-dom/client';
import{MeasurementReadout,MeasurementDrawing,ModelMeasurementDrawing}from'./components/CanvasMeasurement';
import EditorStatusBar from './components/EditorStatusBar';
import{createCanvasMeasurement}from'./lib/canvas-measurement';
const layout=createCanvasMeasurement(),model=createCanvasMeasurement();
const reset=()=>{layout.clear();model.clear();layout.place({x:10,y:10,z:0});layout.place({x:70,y:35,z:0});model.place({x:10,y:10,z:2});model.place({x:70,y:35,z:22});};reset();
function Fixture(){
 const host=useRef(null),redraw=useRef(()=>{}),factor=useRef(1),unitsPerPixel=useRef(()=>1/6),[scale,setScale]=useState(.1);
 const project=useRef(p=>({x:p.x*factor.current*6+20,y:p.y*4-p.z*2+70}));
 useLayoutEffect(()=>{const observer=new ResizeObserver(()=>{setScale(100/host.current.clientWidth);redraw.current();});observer.observe(host.current);return()=>observer.disconnect();},[]);
 window.measurementReview={layout,model,camera:()=>{factor.current=1.5;redraw.current();}};
 return <><nav><button onClick={reset}>Reset</button><button onClick={()=>{layout.clear();model.clear();}}>Clear</button></nav>
 <section ref={host} className="review-panel"><header>Layout</header><svg viewBox="0 0 100 50" style={{width:'100%',display:'block'}}><MeasurementDrawing measurement={layout} scale={scale}/></svg><EditorStatusBar mode="Measure distance" coordinates={<MeasurementReadout measurement={layout}/>} controls={<span className="grid-density">Grid 0.5 mm</span>} status=""/></section>
 <section className="review-panel"><header>Model</header><div style={{height:260,position:'relative'}}><ModelMeasurementDrawing measurement={model} project={project} redraw={redraw} unitsPerPixel={unitsPerPixel}/></div><EditorStatusBar mode="Measure distance" coordinates={<MeasurementReadout measurement={model} spatial/>} controls={<span className="grid-density">Grid 0.5 mm</span>} status=""/></section></>;
}createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content: `body{overflow:auto;padding:20px}nav{display:flex;gap:12px;margin-bottom:12px}nav button{padding:6px 12px}.review-panel{border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:16px;background:var(--canvas)}header{padding:12px;color:var(--text-strong)}`,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.measurement-distance').first().waitFor();
  assert.match(
    await page.locator('.measurement-distance').first().innerText(),
    /ΔX 60.000 mm · ΔY 25.000 mm · Angle 22.620°/,
  );
  assert.match(
    await page.locator('.measurement-distance').last().innerText(),
    /ΔZ 20.000 mm · XY angle 22.620° · Elevation 17.103°/,
  );
  const ticks = page.locator('[data-measurement-ticks]');
  assert.equal(await ticks.count(), 2);
  assert.equal(await ticks.locator('text').count(), 0);
  assert.ok((await ticks.first().locator('path').getAttribute('d')).includes('M'));
  assert.ok((await ticks.last().locator('path').getAttribute('d')).includes('M'));
  const before = await ticks.last().locator('path').getAttribute('d');
  await page.evaluate(() => window.measurementReview.camera());
  assert.notEqual(await ticks.last().locator('path').getAttribute('d'), before);
  assert.match(await page.locator('.measurement-distance').last().innerText(), /ΔZ 20.000 mm/);
  await mkdir('test-results/measurement-review', { recursive: true });
  await page.screenshot({ path: 'test-results/measurement-review/wide.png', fullPage: true });
  for (const width of [620, 360]) {
    await page.setViewportSize({ width, height: 1100 });
    const overflow = await page
      .locator('.status-bar')
      .evaluateAll((bars) =>
        bars.some(
          (bar) => bar.scrollWidth > bar.clientWidth + 1 || bar.scrollHeight > bar.clientHeight + 1,
        ),
      );
    assert.equal(overflow, false, `Readouts and grid controls fit at ${width}px.`);
    const clipped = await page.locator('.measurement-distance').evaluateAll((readouts) =>
      readouts.some((readout) => {
        const bounds = readout.getBoundingClientRect(),
          footer = readout.closest('footer').getBoundingClientRect();
        return bounds.right > footer.right || bounds.bottom > footer.bottom;
      }),
    );
    assert.equal(clipped, false);
  }
  await page.screenshot({ path: 'test-results/measurement-review/narrow.png', fullPage: true });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  assert.equal(await page.locator('.measurement-distance').count(), 0);
  assert.equal(await page.locator('.model-measurement-overlay').isVisible(), false);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.locator('.measurement-distance').first().waitFor();
  assert.equal(await page.locator('.model-measurement-overlay').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Measurement browser check passed: visible deltas/angles, graduated overlays, camera reprojection, narrow readouts and clear/retry.',
  );
} finally {
  await browser.close();
}
