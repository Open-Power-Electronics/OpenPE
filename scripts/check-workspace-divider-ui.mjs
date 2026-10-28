import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: {
    contents: `import React,{StrictMode,useState} from 'react';import{createRoot}from'react-dom/client';
      import Divider from './components/WorkspaceDivider';
      function Fixture(){const[active,setActive]=useState(true);const[second,setSecond]=useState(true);
        window.dividerFixture={setActive,setSecond};
        return <><div className="desktop-titlebar"/>{[0,...(second?[1]:[])].map(id=><section className="workspace" key={id} data-fixture={id}>
          <div className="nav-rail"/><div className="chat-panel"/><Divider active={active}/>
          <svg style={{cursor:'crosshair'}}>{Array.from({length:500},(_,i)=><rect key={i} x={i%30} y={Math.floor(i/30)} width="1" height="1"/>)}</svg>
        </section>)}</>}
      createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.OPENPE_RENDER_MODE || 'development'),
  },
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      '.workspace{height:330px;display:flex;width:1380px}.nav-rail{width:52px;flex-shrink:0}.chat-panel{flex:none}svg{flex:1;height:300px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const divider = page
    .getByRole('separator', { name: 'Resize conversation and schematic' })
    .first();
  await divider.waitFor();
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const marker = () => page.evaluate(() => document.body.getAttribute('data-workspace-resizing'));
  const start = async () => {
    const b = await divider.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await settle();
  };
  const cursor = () =>
    page
      .locator('svg rect')
      .first()
      .evaluate((node) => getComputedStyle(node).cursor);
  assert.equal(await marker(), null);
  assert.equal(await cursor(), 'crosshair');
  await start();
  assert.equal(await marker(), 'true');
  assert.match(await cursor(), /col-resize/);
  await page.mouse.up();
  await settle();
  assert.equal(await marker(), null);
  assert.equal(await cursor(), 'crosshair');
  const originalWidth = await page
    .locator('.chat-panel')
    .first()
    .evaluate((node) => node.getBoundingClientRect().width);
  await start();
  await page.mouse.move(620, 170);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await settle();
  assert.equal(await marker(), null);
  assert.equal(
    await page
      .locator('.chat-panel')
      .first()
      .evaluate((node) => node.getBoundingClientRect().width),
    originalWidth,
  );
  // Synthetic additional pointer IDs exercise independent retained instances;
  // real pointer capture above verifies the ordinary mouse path.
  await page.evaluate(() => {
    const capture = new WeakMap();
    for (const [name, fn] of Object.entries({
      setPointerCapture(id) {
        let ids = capture.get(this);
        if (!ids) capture.set(this, (ids = new Set()));
        ids.add(id);
      },
      hasPointerCapture(id) {
        return capture.get(this)?.has(id) || false;
      },
      releasePointerCapture(id) {
        capture.get(this)?.delete(id);
      },
    }))
      HTMLElement.prototype[name] = fn;
  });
  const synthetic = async (index, type, id) => {
    await page
      .getByRole('separator', { name: 'Resize conversation and schematic' })
      .nth(index)
      .dispatchEvent(type, { pointerId: id, button: 0, clientX: 500, clientY: 100, bubbles: true });
    await settle();
  };
  await synthetic(0, 'pointerdown', 91);
  assert.equal(await marker(), 'true');
  await synthetic(0, 'pointercancel', 91);
  assert.equal(await marker(), null);
  await synthetic(0, 'pointerdown', 91);
  await page.evaluate(() => window.dividerFixture.setActive(false));
  await settle();
  assert.equal(await marker(), null, 'Deactivation cancels and releases the global cursor.');
  await synthetic(0, 'pointerdown', 91);
  assert.equal(await marker(), null, 'Inactive dividers cannot start a gesture.');
  await page.evaluate(() => {
    window.dividerFixture.setActive(true);
    document.body.setAttribute('data-workspace-resizing', 'original');
  });
  await settle();
  await synthetic(0, 'pointerdown', 91);
  await synthetic(1, 'pointerdown', 92);
  assert.equal(await marker(), 'true');
  await synthetic(0, 'pointerup', 91);
  assert.equal(await marker(), 'true', 'One divider cannot release another divider owner.');
  await page.evaluate(() => window.dividerFixture.setSecond(false));
  await settle();
  assert.equal(
    await marker(),
    'original',
    'Unmount of the final owner restores the exact previous attribute.',
  );
  await page.evaluate(() => document.body.removeAttribute('data-workspace-resizing'));
  await settle();
  const session = await page.context().newCDPSession(page);
  async function insertionTrace(legacyControl = false) {
    const events = [];
    const collect = ({ value }) => events.push(...value);
    session.on('Tracing.dataCollected', collect);
    const done = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.start', {
      categories:
        'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking',
      transferMode: 'ReportEvents',
    });
    await page.evaluate((legacyControl) => {
      const span = document.createElement('span');
      span.className = legacyControl ? 'dirty-dot workspace-divider dragging' : 'dirty-dot';
      document.querySelector('.workspace').append(span);
      getComputedStyle(span).color;
    }, legacyControl);
    await settle();
    await session.send('Tracing.end');
    await done;
    session.off('Tracing.dataCollected', collect);
    return events;
  }
  const control = await page.addStyleTag({
    content:
      ':is(body:has(.workspace-divider.dragging),body:has(.workspace-divider.dragging) *){cursor:col-resize!important;user-select:none!important}',
  });
  await settle();
  // Trigger the legacy relation as a positive control for trace collection.
  // Browser releases vary in how aggressively false :has() matches invalidate.
  const before = await insertionTrace(true);
  await control.evaluate((node) => node.remove());
  await settle();
  const after = await insertionTrace();
  const globalInvalidations = (events) =>
    events.filter(
      (event) =>
        event.name === 'StyleInvalidatorInvalidationTracking' &&
        event.args.data.nodeName === 'BODY' &&
        event.args.data.invalidationList?.some((item) => item.allDescendantsMightBeInvalid),
    );
  assert.ok(
    globalInvalidations(before).length > 0,
    'The previous selector provides a positive control for whole-body invalidation.',
  );
  assert.equal(
    globalInvalidations(after).length,
    0,
    'An unrelated dirty marker no longer invalidates the whole body subtree.',
  );
  const recalculated = after
    .filter((event) => event.name === 'UpdateLayoutTree')
    .reduce((sum, event) => sum + (event.args.elementCount || 0), 0);
  assert.ok(
    recalculated < 500,
    `Unrelated insertion recalculates ${recalculated} elements, below the retained SVG's500nodes.`,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      dividerCursor: 'passed',
      cancelDeactivationUnmount: 'passed',
      concurrentOwners: 'passed',
      previousSelectorGlobalInvalidations: globalInvalidations(before).length,
      currentGlobalInvalidations: globalInvalidations(after).length,
      currentRecalculatedElements: recalculated,
    }),
  );
} finally {
  await browser.close();
}
