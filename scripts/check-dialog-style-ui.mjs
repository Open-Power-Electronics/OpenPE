import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Compare actual dialog footers in a browser fixture.
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import Chooser from './components/LibraryChooser';import Drawing from './components/ComponentDrawingEditor';
    import Dialog from './components/Dialog';
    import Confirmation from './components/ConfirmationDialog';
    import FootprintModels from './components/FootprintModels';
    import Settings from './components/SettingsDialog';
    import SpiceChooser from './plugins/spice-simulation/renderer/SpiceModelChooser';
    import{ProjectCore}from'./core/project-core';import{createBlankProject}from'./lib/create-blank-project';
    import{createCapabilityHost}from'./api/capabilities';import{registerProjectCapabilities}from'./core/register-project';
    import{appearanceVariables,defaultAppearance}from'./lib/appearance';
    const core=new ProjectCore(createBlankProject()),host=createCapabilityHost();registerProjectCapabilities(host,core);
    const footprint={id:'fixture',models:[]};
    const appearance={appearance:defaultAppearance,update:()=>{},ready:true,error:'',resolvedTheme:'light'};
    window.theme=value=>{document.documentElement.dataset.theme=value;for(const[key,color]of Object.entries(appearanceVariables(defaultAppearance,value)))document.documentElement.style.setProperty(key,color)};
    function App(){const[mode,setMode]=useState('chooser');window.show=setMode;
      if(['generic','compact','wide'].includes(mode))return <Dialog title="Generic" compact={mode==='compact'} wide={mode==='wide'} onClose={()=>{}}>Content</Dialog>;
      if(mode==='confirm')return <Confirmation documentTitle="Fixture" busy={false} error="" onCancel={()=>{}}
        onConfirm={async(saveFirst)=>{window.closeChoice=saveFirst?'save':'discard';}}/>;
      if(mode==='spice') return <SpiceChooser component="U1 · LM25017" initialSearch="LM25017" onClose={()=>{}} onBrowse={()=>{}} onChoose={()=>{}} modelIssue={()=>''}/>;
      if(mode==='settings') return <Settings appearance={appearance} agents={[]} detecting={false} error="" onClose={()=>{}} onDetect={async()=>{}}/>;
      if(mode==='models') return <FootprintModels footprint={footprint} active onChange={()=>true}/>;
      if(mode==='drawing') return <Drawing project={core.getSnapshot().project} schematic={core.getSnapshot().project.schematic}
        capabilityHost={host} revision="0" onClose={()=>{}}/>
      return <Chooser key={mode} onClose={()=>{}} onChoose={()=>{}} kind={mode==='chooser'?'symbols':'footprints'}
        label={mode==='assignment'?'Choose component model':mode==='placement'?'Footprint placement':undefined}
        actionLabel={mode==='placement'?'Place':undefined} requireModel={mode==='assignment'}/>;
    }
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
    if (url.pathname.startsWith('/api/libraries/')) {
      if (url.searchParams.has('categories')) return route.fulfill({ json: { categories: [] } });
      const result = { entries: [], libraries: [], total: 0, nextOffset: null };
      if (route.request().headers().accept === 'application/x-ndjson')
        return route.fulfill({
          contentType: 'application/x-ndjson',
          body: JSON.stringify({ type: 'result', result }) + '\n',
        });
      return route.fulfill({ json: result });
    }
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
      for (const [mode, name, text] of [
        ['spice', 'Choose SPICE model', 'Download'],
        ['chooser', 'Components', 'Place'],
        ['footprint', 'Footprints', 'Assign'],
        ['placement', 'Footprint placement', 'Place'],
        ['assignment', 'Choose component model', 'Update'],
        ['drawing', 'Draw component', 'Apply'],
        ['settings', 'Settings', 'Done'],
        ['models', 'Component models', 'Done'],
      ]) {
        await page.evaluate((mode) => window.show(mode), mode);
        if (mode === 'models')
          await page.getByRole('button', { name: 'Manage assigned models', exact: true }).click();
        const dialog = page.getByRole('dialog', { name, exact: true });
        await dialog.waitFor();
        await page.evaluate((theme) => window.theme(theme), theme);
        if (mode === 'drawing') {
          for (const label of ['Name', 'Drawing target']) {
            const field = page.getByLabel(label, { exact: true });
            assert.ok(
              Math.abs((await field.boundingBox()).height - 30) < 0.5,
              `${label} matches the chooser field height.`,
            );
          }
        }
        const style = await dialog.evaluate((element) => {
          const footer = element.querySelector('.dialog-footer'),
            rect = footer.getBoundingClientRect();
          const css = getComputedStyle(footer),
            buttons = [...footer.querySelectorAll('button')];
          const frame = element.getBoundingClientRect();
          return {
            dialogWidth: frame.width,
            dialogHeight: frame.height,
            height: rect.height,
            padding: css.padding,
            controls: buttons.map((button) => {
              const r = button.getBoundingClientRect(),
                s = getComputedStyle(button),
                svg = button.querySelector('svg');
              return {
                height: r.height,
                width: r.width,
                primary: button.classList.contains('primary'),
                text: button.textContent.trim(),
                rightInset: rect.right - r.right,
                radius: s.borderRadius,
                stroke: svg?.getAttribute('stroke-width'),
                svgSize: svg?.getBoundingClientRect().width,
                center: Math.abs((r.top + r.bottom - rect.top - rect.bottom) / 2),
              };
            }),
          };
        });
        const context = `${mode} ${theme} at ${width}px`;
        assert.ok(style.controls.every((control) => control.height === 30 && control.center < 1), context);
        const primary = style.controls.at(-1);
        assert.equal(primary.primary, true);
        assert.equal(primary.text, text);
        assert.equal(primary.svgSize, undefined);
        assert.ok(primary.width > 30 && Math.abs(primary.rightInset - 12) < 1, context);
        assert.ok(
          style.controls
            .slice(0, -1)
            .every(
              (control) => control.width === 30 && control.stroke === '2' && control.svgSize === 18,
            ),
          context,
        );
        assert.ok(style.height <= 43, context);
        assert.ok(Math.abs(style.dialogWidth - Math.min(1000, width - 48)) < 1);
        assert.ok(Math.abs(style.dialogHeight - Math.min(720, viewportHeight - 48)) < 1);
        styles.push(style);
        if (width !== 1480 && mode !== 'chooser' && mode !== 'drawing') continue;
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
      for (const style of styles.slice(1)) {
        for (const key of ['height', 'dialogWidth', 'dialogHeight', 'padding'])
          assert.equal(style[key], styles[0][key]);
        assert.equal(style.controls.at(-1).radius, styles[0].controls.at(-1).radius);
      }
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
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.evaluate(() => {
    window.show('settings');
    document.documentElement.dataset.textSize = 'extra-large';
  });
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  const grip = await settings.locator('.dialog-resize-edge[data-direction="e"]').boundingBox();
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 600, y, { steps: 5 });
  await page.mouse.up();
  const compactSettings = await settings.evaluate((dialog) => {
    const pane = dialog.querySelector('.settings-pane:not([hidden])');
    const row = pane.querySelector('.appearance-row');
    return {
      width: dialog.getBoundingClientRect().width,
      columns: getComputedStyle(row).gridTemplateColumns.split(' ').length,
      overflow: pane.scrollWidth - pane.clientWidth,
      iconDisplay: getComputedStyle(dialog.querySelector('.settings-sidebar button svg')).display,
    };
  });
  assert.ok(compactSettings.width < 440);
  assert.equal(compactSettings.columns, 1);
  assert.ok(compactSettings.overflow <= 1);
  assert.equal(compactSettings.iconDisplay, 'none');
  await page.evaluate(() => window.show('confirm'));
  const confirmation = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await confirmation.waitFor();
  assert.deepEqual(
    await confirmation.locator('.dialog-footer button').allTextContents(),
    ['Cancel', 'Discard', 'Save'],
  );
  await confirmation.getByRole('button', { name: 'Discard', exact: true }).click();
  assert.equal(await page.evaluate(() => window.closeChoice), 'discard');
  assert.deepEqual(errors, []);
  console.log('PASS: shared dialog footer labels, control height, spacing and right alignment.');
} finally {
  await browser.close();
}
