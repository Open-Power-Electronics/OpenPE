import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real Settings controls and modal HTML dialog; state stays in this renderer.
// No Electron, native files, service, provider or solver is started.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import SettingsDialog from './components/SettingsDialog';
      import {defaultAppearance} from './lib/appearance';
      function Fixture(){
        const [open,setOpen]=useState(false),[appearance,setAppearance]=useState(defaultAppearance);
        return <><button onClick={()=>setOpen(true)}>Open settings</button>
          {open&&<SettingsDialog appearance={{appearance,update:setAppearance,error:'',ready:true,resolvedTheme:'light',
            layoutPreferences:{enabled:false,busy:false,error:'',update:()=>{}}}}
            agents={[]} detecting={false} error='' onDetect={async()=>{}}
            onClose={()=>{window.settingsClosed++;setOpen(false)}}/>}</>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/appearance-escape-ui-bundle',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.settingsClosed = 0;
  });
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const color = dialog.getByRole('textbox', { name: 'Background', exact: true });
  const original = await color.inputValue();
  await color.fill('#nope');
  await color.press('Enter');
  assert.equal(await color.getAttribute('aria-invalid'), 'true');
  await color.press('Escape');
  assert.equal(
    await dialog.isVisible(),
    true,
    'Draft Escape must prevent native dialog cancellation.',
  );
  assert.equal(await color.inputValue(), original);
  assert.equal(await color.getAttribute('aria-invalid'), 'false');
  await color.fill('#123456');
  await color.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Background picker"]').value === '#123456',
  );
  await color.fill('#abcdef');
  await color.press('Escape');
  assert.equal(await color.inputValue(), '#123456', 'Escape restores the latest committed color.');
  await dialog.getByText('Advanced', { exact: true }).click();
  const size = dialog.getByRole('spinbutton', { name: 'Interface text size', exact: true });
  const originalSize = await size.inputValue();
  await size.fill('999');
  await size.press('Enter');
  assert.equal(await size.getAttribute('aria-invalid'), 'true');
  await size.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await size.inputValue(), originalSize);
  assert.equal(await size.getAttribute('aria-invalid'), 'false');
  await size.fill('18');
  await size.press('Enter');
  await size.fill('17');
  await size.press('Escape');
  assert.equal(await size.inputValue(), '18', 'Escape restores the latest committed numeric size.');
  assert.equal(await page.evaluate(() => window.settingsClosed), 0);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => window.settingsClosed),
    1,
    'Escape outside draft controls still closes Settings.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: color/number Escape discards drafts and errors, retains committed settings and keeps the native modal open; ordinary Escape closes it.',
  );
} finally {
  await browser.close();
}
