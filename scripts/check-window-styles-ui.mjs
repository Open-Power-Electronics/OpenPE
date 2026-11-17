import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Actual renderer windows and native fixture bytes; no Electron, Git, providers
// or solvers. The only host adapter is a read-only in-memory version catalog.
const { projectFromNativeFiles, serializeProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const project = projectFromNativeFiles({
  entry: 'rc-filter.kicad_pro',
  files: [
    { name: 'rc-filter.kicad_pro', source: '{"meta":{"version":1}}\n' },
    ...(await Promise.all(
      ['sch', 'pcb'].map(async (extension) => ({
        name: `rc-filter.kicad_${extension}`,
        source: await readFile(`tests/fixtures/rc-filter.kicad_${extension}`, 'utf8'),
      })),
    )),
  ],
});
const source = serializeProject(project);
const bundle = await build({
  stdin: {
    contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import PartsList from './components/PartsList';
      import ProjectHistoryView from './components/ProjectHistoryView';
      const source=${JSON.stringify(source)};
      const parts=${JSON.stringify(project.schematic.parts)};
      const writes=[];
      const host={
        async query(id,input){
          if(id==='versions.list') return {version:'mock Git',commits:[{id:'a'.repeat(40),date:'2026-11-05T10:00:00+08:00',message:'Initial design'}],more:false};
          if(id==='versions.read') return {source};
          throw Error('Unexpected query: '+id);
        },
        async execute(id,input){writes.push({id,input});throw Error('Style inspection must not edit designs');}
      };
      function Fixture(){
        const [config,setConfig]=useState({window:'list',open:true});
        window.windowStyles={writes,render:next=>flushSync(()=>setConfig(current=>({...current,...next})))};
        const close=()=>setConfig(current=>({...current,open:false}));
        return <>
          {config.open && config.window==='list' && <PartsList parts={parts} selected={null}
            onEdit={()=>writes.push('edit')} onLocate={()=>writes.push('locate')} onClose={close}/>}
          {config.open && config.window==='git' && <ProjectHistoryView visible source={source}
            sourcePending={false} fileId="fixture" capabilityHost={host}
            onSave={async()=>{writes.push('save');return 'cancelled'}}
            onRestore={()=>writes.push('restore')} onClose={close}/>}
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/window-styles-ui-bundle',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
let page;
const errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: output.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const dialog = () => page.locator('dialog[open]');
  async function settle() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function render(next) {
    await page.evaluate((next) => window.windowStyles.render(next), next);
    if (next.open === true) await dialog().waitFor();
    await settle();
  }
  async function shell() {
    return dialog().evaluate((element) => {
      const css = (node, fields) =>
        Object.fromEntries(fields.map((field) => [field, getComputedStyle(node)[field]]));
      const header = element.querySelector(':scope>.dialog-header');
      const title = header.querySelector('h2');
      const icon = header.querySelector(':scope > .dialog-icon');
      const graphic = icon?.querySelector('svg');
      const maximize = header.querySelector('[aria-label="Maximize dialog"]');
      const close = header.querySelector('[aria-label="Close dialog"]');
      return {
        outer: css(element, [
          'backgroundColor',
          'borderTopWidth',
          'borderTopColor',
          'borderRadius',
          'boxShadow',
        ]),
        header: {
          ...css(header, [
            'backgroundColor',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
            'borderBottomWidth',
            'borderBottomColor',
          ]),
          height: header.getBoundingClientRect().height,
        },
        title: css(title, ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']),
        maximize: css(maximize, ['width', 'height', 'borderRadius']),
        close: css(close, ['width', 'height', 'borderRadius']),
        actionGap: close.getBoundingClientRect().left - maximize.getBoundingClientRect().right,
        titleIcons: header.querySelectorAll('.dialog-icon').length,
        titleIcon:
          icon && graphic
            ? {
                ...css(icon, [
                  'width',
                  'height',
                  'backgroundColor',
                  'borderTopWidth',
                  'borderRadius',
                  'color',
                ]),
                graphic: css(graphic, ['width', 'height', 'strokeWidth', 'color']),
              }
            : null,
      };
    });
  }
  const references = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await render({ open: false });
    for (const kind of ['list', 'git']) {
      await render({ window: kind, open: true });
      if (kind === 'git')
        await waitForAsync(
          page,
          () =>
            document.querySelector('.project-history-view')?.getAttribute('aria-busy') === 'false',
        );
      if (kind === 'list') {
        const bounds = await dialog().boundingBox();
        assert.deepEqual(
          [Math.round(bounds.width), Math.round(bounds.height)],
          [900, 680],
          `${kind}: initial window dimensions in ${theme}`,
        );
        const viewport = page.viewportSize();
        assert.ok(bounds.x >= 24 && bounds.x + bounds.width <= viewport.width - 24);
        assert.ok(bounds.y >= 24 && bounds.y + bounds.height <= viewport.height - 24);
      }
      const actual = await shell();
      if (kind === 'list') references[theme] = actual;
      else
        assert.deepEqual(
          actual,
          references[theme],
          `${kind}: unified window exterior/header in ${theme}`,
        );
      assert.equal(
        actual.titleIcons,
        1,
        'Each window displays its corresponding logo before the title.',
      );
      assert.deepEqual(
        {
          width: actual.titleIcon.width,
          height: actual.titleIcon.height,
          borderTopWidth: actual.titleIcon.borderTopWidth,
          borderRadius: actual.titleIcon.borderRadius,
          backgroundColor: actual.titleIcon.backgroundColor,
        },
        {
          width: '18px',
          height: '18px',
          borderTopWidth: '0px',
          borderRadius: '0px',
          backgroundColor: 'rgba(0, 0, 0, 0)',
        },
        'Header logos share a flat compact slot without a decorative tile.',
      );
      assert.equal(actual.titleIcon.graphic.width, '16px');
      assert.equal(actual.titleIcon.graphic.height, '16px');
      const iconClass = {
        list: 'lucide-list',
        git: 'lucide-git',
      }[kind];
      const titleLogo = dialog().locator(
        `:scope > .dialog-header > .dialog-icon > svg.${iconClass}`,
      );
      assert.equal(await titleLogo.count(), 1, `${kind} uses its matching project-action logo.`);
      assert.equal(
        await titleLogo.locator('..').getAttribute('aria-hidden'),
        'true',
        'The visible window title supplies the accessible name.',
      );
      const logoBox = await titleLogo.boundingBox();
      const titleBox = await dialog().locator(':scope > .dialog-header h2').boundingBox();
      assert.ok(logoBox.x + logoBox.width <= titleBox.x, 'The logo sits to the left of the title.');
      assert.equal(await dialog().locator('.dialog-resize-edge').count(), 8);
      await dialog().getByRole('button', { name: 'Maximize dialog', exact: true }).waitFor();
      await dialog().getByRole('button', { name: 'Close dialog', exact: true }).waitFor();

      await page.screenshot({ path: `test-results/window-style-${kind}-${theme}.png` });
      await render({ open: false });
    }
  }
  assert.deepEqual(await page.evaluate(() => window.windowStyles.writes), []);
  assert.deepEqual(errors, []);
  console.log('PASS: List and Git share window styling in light and dark themes.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'test-results/window-styles-failure.png' });
    console.error(await page.locator('body').innerText(), errors);
  }
  throw error;
} finally {
  await browser.close();
}
