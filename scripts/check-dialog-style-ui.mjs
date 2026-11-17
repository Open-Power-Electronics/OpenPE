import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Compare the actual two local dialogs; no Electron or project writes.
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import Chooser from './components/LibraryChooser';import Drawing from './components/ComponentDrawingEditor';
    import Dialog from './components/Dialog';
    import Dialog from './components/Dialog';
    import{ProjectCore}from'./core/project-core';import{createBlankProject}from'./lib/create-blank-project';
    import{createCapabilityHost}from'./api/capabilities';import{registerProjectCapabilities}from'./core/register-project';
    import{appearanceVariables,defaultAppearance}from'./lib/appearance';
    const core=new ProjectCore(createBlankProject()),host=createCapabilityHost();registerProjectCapabilities(host,core);
    window.theme=value=>{document.documentElement.dataset.theme=value;for(const[key,color]of Object.entries(appearanceVariables(defaultAppearance,value)))document.documentElement.style.setProperty(key,color)};
    function App(){const[mode,setMode]=useState('chooser');window.show=setMode;
      if(['generic','compact','wide'].includes(mode))return <Dialog title="Generic" compact={mode==='compact'} wide={mode==='wide'} onClose={()=>{}}>Content</Dialog>;
      return ['generic','compact','wide'].includes(mode)?<Dialog title="Generic" compact={mode==='compact'} wide={mode==='wide'} onClose={()=>{}}><p>Content</p></Dialog>:mode==='chooser'?<Chooser onClose={()=>{}} onChoose={()=>{}} kind="symbols"/>:
      <Drawing project={core.getSnapshot().project} schematic={core.getSnapshot().project.schematic}
        capabilityHost={host} revision="0" onClose={()=>{}}/>}
    createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/dialog-style-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await mkdir('test-results/dialog-style', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/libraries/'))
      return route.fulfill({ json: { entries: [], libraries: [], total: 0, categories: [] } });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.evaluate(
    () =>
      (window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) }),
  );
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  for (const theme of ['light', 'dark']) {
    for (const width of [1480, 1120, 360]) {
      const styles = [];
      const viewportHeight = width === 1480 ? 1000 : 800;
      await page.setViewportSize({ width, height: viewportHeight });
      for (const mode of ['chooser', 'drawing']) {
        await page.evaluate((mode) => window.show(mode), mode);
        await page
          .getByRole('dialog', {
            name: mode === 'chooser' ? 'Components' : 'Draw component',
            exact: true,
          })
          .waitFor();
        await page.evaluate((theme) => window.theme(theme), theme);
        await page.waitForTimeout(250);
        if (mode === 'drawing') {
          for (const label of ['Name', 'Drawing target']) {
            const field = page.getByLabel(label, { exact: true });
            assert.ok(
              Math.abs((await field.boundingBox()).height - 30) < 0.5,
              `${label} matches the chooser field height.`,
            );
          }
        }
        const style = await page.evaluate(() => {
          const footer = document.querySelector('.dialog-footer'),
            rect = footer.getBoundingClientRect();
          const css = getComputedStyle(footer),
            buttons = [...footer.querySelectorAll('button')];
          const dialog = document.querySelector('.surface-dialog').getBoundingClientRect();
          return {
            dialogWidth: dialog.width,
            dialogHeight: dialog.height,
            height: rect.height,
            padding: css.padding,
            controls: buttons.map((button) => {
              const r = button.getBoundingClientRect(),
                s = getComputedStyle(button),
                svg = button.querySelector('svg');
              return {
                height: r.height,
                width: r.width,
                padding: s.padding,
                radius: s.borderRadius,
                stroke: svg?.getAttribute('stroke-width'),
                svgSize: svg?.getBoundingClientRect().width,
                center: Math.abs((r.top + r.bottom - rect.top - rect.bottom) / 2),
              };
            }),
          };
        });
        assert.ok(style.controls.every((control) => control.height === 30 && control.center < 1));
        assert.ok(
          style.controls.every(
            (control) => control.width === 30 && control.stroke === '2' && control.svgSize === 18,
          ),
        );
        assert.ok(style.height <= 43);
        assert.ok(Math.abs(style.dialogWidth - Math.min(1000, width - 48)) < 1);
        assert.ok(Math.abs(style.dialogHeight - Math.min(720, viewportHeight - 48)) < 1);
        styles.push(style);
        await page.screenshot({ path: `test-results/dialog-style/${mode}-${theme}-${width}.png` });
        await page.getByRole('button', { name: 'Maximize dialog', exact: true }).click();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: `test-results/dialog-style/${mode}-${theme}-${width}-max.png`,
        });
        await page.getByRole('button', { name: 'Restore dialog', exact: true }).click();
      }
      assert.equal(styles[0].height, styles[1].height);
      assert.equal(styles[0].dialogWidth, styles[1].dialogWidth);
      assert.equal(styles[0].dialogHeight, styles[1].dialogHeight);
      assert.equal(styles[0].padding, styles[1].padding);
      assert.equal(styles[0].controls[0].radius, styles[1].controls[0].radius);
      for (const mode of ['generic', 'compact', 'wide']) {
        await page.evaluate((mode) => window.show(mode), mode);
        await page.getByRole('dialog', { name: 'Generic', exact: true }).waitFor();
        const rect = await page.getByRole('dialog').boundingBox();
        assert.ok(Math.abs(rect.width - Math.min(mode === 'compact' ? 360 : 1000, width - 48)) < 1);
        if (mode === 'compact') assert.ok(rect.height < Math.min(720, viewportHeight - 48));
        else assert.ok(Math.abs(rect.height - Math.min(720, viewportHeight - 48)) < 1);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: chooser/drawing footer geometry and light/dark, narrow and maximized presentation.',
  );
} finally {
  await browser.close();
}
