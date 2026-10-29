import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Actual form with immutable host updates. No service, native files or solver.
const bundle = await build({
  stdin: {
    contents: `import React, {useCallback,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import PartProperties from './components/PartProperties';
      window.propertyRenderCount=0; window.propertySaves=[]; window.propertyAcceptSaves=true;
      function Fixture(){
        const [spiceAvailable,setSpiceAvailable]=useState(true);
        window.setPropertySpiceAvailable=setSpiceAvailable;
        const [part,setPart]=useState({id:'first-part',libId:'Device:R',ref:'R1',value:'1k',x:0,y:0,rotation:0,
          fields:{Footprint:'',Note:'original'},raw:['symbol',['property','"Raw field"','"raw original"']]});
        window.updatePropertyPart=(patch)=>setPart(current=>({...current,...patch}));
        const onSave=useCallback((ref,value,fields)=>{
          window.propertySaves.push({id:part.id,ref,value,fields}); return window.propertyAcceptSaves;
        },[part.id]);
        return <div className="panel"><PartProperties part={part} spiceAvailable={spiceAvailable} onSave={onSave}/></div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.OPENPE_RENDER_MODE || 'production'),
  },
  plugins: [
    {
      name: 'count-real-properties-renders',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/]components[\\/]PartProperties\.tsx$/ },
          async ({ path: file }) => {
            const source = await readFile(file, 'utf8');
            const marker = '  const fields = partFields(part);';
            assert.ok(source.includes(marker));
            return {
              contents: source.replace(marker, `window.propertyRenderCount++;\n${marker}`),
              loader: 'tsx',
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: '.panel{width:400px;padding:16px;margin:20px}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const value = page.getByLabel('Component value', { exact: true });
  await value.waitFor();
  const count = () => page.evaluate(() => window.propertyRenderCount);
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const patch = async (update) => {
    await page.evaluate((next) => window.updatePropertyPart(next), update);
    await settle();
  };
  await value.fill('draft value');
  const beforePose = await count();
  await patch({ x: 1.27, y: -2.54, rotation: 90 });
  assert.equal(await count(), beforePose, 'Pose changes do not build the property form JSX.');
  assert.equal(
    await value.inputValue(),
    'draft value',
    'Pose changes retain the local value draft.',
  );
  assert.equal(await value.evaluate((input) => input === document.activeElement), true);
  await patch({ id: 'second-part' });
  assert.equal(
    await value.inputValue(),
    '1k',
    'A new stable ID cannot inherit another part draft.',
  );
  const invalidates = async (update, reason) => {
    const before = await count();
    await patch(update);
    assert.ok((await count()) > before, reason);
  };
  await invalidates({ libId: 'Device:R_ALT' }, 'Library association changes invalidate the form.');
  await invalidates({ unit: 2 }, 'Unit association changes invalidate the form.');
  await invalidates({ mirror: 'x' }, 'Mirror association stays exact.');
  await invalidates({ ref: 'R2' }, 'Reference changes invalidate the form.');
  assert.equal(await page.getByLabel('Component reference', { exact: true }).inputValue(), 'R2');
  await invalidates({ value: '4k' }, 'Value changes invalidate the form.');
  assert.equal(await value.inputValue(), '4k');
  await invalidates(
    { fields: { Footprint: '', Note: 'original' } },
    'A new fields association invalidates even with equal contents.',
  );
  await invalidates(
    { fields: { Footprint: '', Note: 'new source field' } },
    'Changed fields invalidate the form.',
  );
  assert.equal(await page.getByLabel('Note', { exact: true }).inputValue(), 'new source field');
  await invalidates(
    { raw: ['symbol', ['property', '"Raw field"', '"new raw source"']] },
    'Native raw association changes invalidate the form.',
  );
  assert.equal(await page.getByLabel('Raw field', { exact: true }).inputValue(), 'new raw source');
  await value.fill('retained participation draft');
  await invalidates(
    { excludeFromSimulation: true },
    'Simulation participation changes invalidate the form.',
  );
  assert.equal(await value.inputValue(), 'retained participation draft');
  assert.equal(
    await page.getByRole('switch').count(),
    0,
    'Properties has no participation switch.',
  );
  await value.fill('5k');
  await value.press('Enter');
  const saves = await page.evaluate(() => window.propertySaves);
  assert.equal(saves.at(-1).id, 'second-part');
  assert.equal(saves.at(-1).value, '5k');
  assert.equal(saves.at(-1).fields['Raw field'], 'new raw source');
  const error = page.getByRole('alert');
  await value.fill('');
  const beforeInvalid = await page.evaluate(() => window.propertySaves.length);
  await value.press('Enter');
  assert.equal(await value.inputValue(), '', 'Invalid drafts remain retryable.');
  assert.equal(await error.isVisible(), true);
  assert.equal(await page.evaluate(() => window.propertySaves.length), beforeInvalid);
  await value.press('Escape');
  await page.evaluate(() => {
    window.propertyAcceptSaves = false;
  });
  await value.fill('6k');
  await value.press('Enter');
  assert.equal(await value.inputValue(), '6k', 'A rejected host commit retains its draft.');
  assert.equal(await error.isVisible(), true);
  await page.evaluate(() => {
    window.propertyAcceptSaves = true;
  });
  await value.focus();
  await value.press('Enter');
  assert.equal(await error.count(), 0, 'The same rejected draft can be retried.');
  await value.fill('retained SPICE draft');
  const beforePluginVisibility = await page.evaluate(() => window.propertySaves.length);
  await page.evaluate(() => window.setPropertySpiceAvailable(false));
  await settle();
  assert.equal(await page.locator('.property-simulation').count(), 0);
  assert.equal(await value.inputValue(), 'retained SPICE draft');
  await page.evaluate(() => window.setPropertySpiceAvailable(true));
  await settle();
  assert.equal(await page.getByRole('switch').count(), 0);
  assert.equal(await value.inputValue(), 'retained SPICE draft');
  assert.equal(await page.evaluate(() => window.propertySaves.length), beforePluginVisibility);
  assert.deepEqual(errors, []);
  console.log(
    'PartProperties retention verified: live pose drafts, complete associations, stable ID, current native fields and property failure/retry.',
  );
} finally {
  await browser.close();
}
