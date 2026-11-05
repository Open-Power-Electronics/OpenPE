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
      import {CircuitBoard} from 'lucide-react';
      import RuleCheckPanel from './components/RuleCheckPanel';
      import PartsList from './components/PartsList';
      import ProjectHistoryView from './components/ProjectHistoryView';
      import RevealButton from './components/RevealButton';
      import {SchematicIcon} from './components/EditorIcons';
      import {defaultPCBDesignRules} from './lib/design-rule-checks';
      const source=${JSON.stringify(source)};
      const parts=${JSON.stringify(project.schematic.parts)};
      const writes=[];
      const runs=[];
      const host={
        async query(id,input){
          if(id==='versions.list') return {version:'mock Git',commits:[{id:'a'.repeat(40),date:'2026-11-05T10:00:00+08:00',message:'Initial design'}],more:false};
          if(id==='versions.read') return {source};
          throw Error('Unexpected query: '+id);
        },
        async execute(id,input){writes.push({id,input});throw Error('Style inspection must not edit designs');}
      };
      function Fixture(){
        const [config,setConfig]=useState({window:'rules',open:true,kind:'erc',sourcePending:false,drcAvailable:true});
        window.windowStyles={writes,runs,render:next=>flushSync(()=>setConfig(current=>({...current,...next})))};
        const close=()=>setConfig(current=>({...current,open:false}));
        return <>
          <div id="reference" className="editor-view-switch" style={{position:'fixed',left:24,top:24}}>
            <RevealButton icon={SchematicIcon} label="Schematic" active onClick={()=>{}}/>
            <RevealButton icon={CircuitBoard} label="Layout" onClick={()=>{}}/>
          </div>
          {config.open && config.window==='rules' && <RuleCheckPanel kind={config.kind}
            onKindChange={kind=>setConfig(current=>({...current,kind}))}
            drcAvailable={config.drcAvailable} sourcePending={config.sourcePending}
            report={null} drcSettings={defaultPCBDesignRules} onRun={()=>runs.push('run')}
            onSelectIssue={()=>writes.push('locate')} onClose={close}/>}
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
  const tab = (name) => dialog().getByRole('tab', { name, exact: true });
  async function settle() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function render(next) {
    await page.evaluate((next) => window.windowStyles.render(next), next);
    if (next.open !== false) await dialog().waitFor();
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
  async function tabStyle(locator) {
    return locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(
        [
          'height',
          'minHeight',
          'paddingTop',
          'paddingRight',
          'paddingBottom',
          'paddingLeft',
          'borderTopWidth',
          'borderRightWidth',
          'borderBottomWidth',
          'borderLeftWidth',
          'borderTopColor',
          'borderRightColor',
          'borderBottomColor',
          'borderLeftColor',
          'borderTopLeftRadius',
          'borderTopRightRadius',
          'borderBottomRightRadius',
          'borderBottomLeftRadius',
          'backgroundColor',
          'color',
          'fontSize',
          'fontWeight',
          'lineHeight',
        ].map((field) => [field, style[field]]),
      );
    });
  }
  async function footerStyle(kind) {
    return dialog()
      .locator(kind === 'git' ? '.history-footer' : ':scope > .dialog-footer')
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(
          [
            'minHeight',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
            'backgroundColor',
            'borderTopWidth',
            'borderTopColor',
          ].map((field) => [field, style[field]]),
        );
      });
  }
  const references = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await render({ open: false });
    await page.mouse.move(1400, 940);
    // Theme changes animate the reference cards' colors and borders for 180 ms.
    await page.waitForTimeout(220);
    const referenceActive = await tabStyle(page.locator('#reference button').nth(0));
    const referenceInactive = await tabStyle(page.locator('#reference button').nth(1));
    await page.locator('#reference button').nth(1).hover();
    await page.waitForTimeout(220);
    const referenceHover = await tabStyle(page.locator('#reference button').nth(1));
    await page.mouse.move(1400, 940);
    let ruleFooter;
    for (const kind of ['rules', 'list', 'git']) {
      await render({
        window: kind,
        open: true,
        kind: 'erc',
        sourcePending: false,
        drcAvailable: true,
      });
      if (kind === 'git')
        await waitForAsync(
          page,
          () =>
            document.querySelector('.project-history-view')?.getAttribute('aria-busy') === 'false',
        );
      if (kind === 'rules' || kind === 'list') {
        const bounds = await dialog().boundingBox();
        assert.deepEqual(
          [Math.round(bounds.width), Math.round(bounds.height)],
          kind === 'rules' ? [720, 560] : [900, 680],
          `${kind}: initial window dimensions in ${theme}`,
        );
        const viewport = page.viewportSize();
        assert.ok(bounds.x >= 24 && bounds.x + bounds.width <= viewport.width - 24);
        assert.ok(bounds.y >= 24 && bounds.y + bounds.height <= viewport.height - 24);
      }
      const actual = await shell();
      if (kind === 'rules') references[theme] = actual;
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
        rules: 'lucide-clipboard-check',
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
      if (kind === 'rules') ruleFooter = await footerStyle(kind);
      if (kind === 'git')
        assert.deepEqual(
          await footerStyle(kind),
          ruleFooter,
          'Rule and Git use the same fixed footer surface and insets.',
        );
      await dialog().getByRole('button', { name: 'Maximize dialog', exact: true }).waitFor();
      await dialog().getByRole('button', { name: 'Close dialog', exact: true }).waitFor();
      if (kind === 'rules') {
        await page.mouse.move(1400, 940);
        await page.waitForTimeout(220);
        assert.deepEqual(
          await tabStyle(tab('ERC')),
          referenceActive,
          'ERC uses the active Schematic mode card style.',
        );
        assert.deepEqual(
          await tabStyle(tab('DRC')),
          referenceInactive,
          'DRC uses the inactive Layout mode card style.',
        );
        await tab('DRC').hover();
        await page.waitForTimeout(220);
        assert.deepEqual(
          await tabStyle(tab('DRC')),
          referenceHover,
          'ERC/DRC hover matches the editor mode card.',
        );
        await tab('ERC').focus();
        await tab('ERC').dispatchEvent('keydown', { key: 'ArrowRight', keyCode: 229 });
        assert.equal(
          await tab('ERC').getAttribute('aria-selected'),
          'true',
          'IME does not switch tabs.',
        );
        await tab('ERC').press('ArrowRight');
        assert.equal(await tab('DRC').getAttribute('aria-selected'), 'true');
        const clearance = dialog().getByRole('spinbutton', {
          name: 'Copper clearance (mm)',
          exact: true,
        });
        await clearance.fill('1000.1');
        await tab('ERC').click();
        await tab('DRC').click();
        assert.equal(
          Number(await clearance.inputValue()),
          1000.1,
          'Switching tabs retains the invalid DRC draft.',
        );
        assert.equal(await clearance.getAttribute('aria-invalid'), 'true');
        await tab('DRC').focus();
        await tab('DRC').press('Home');
        assert.equal(await tab('ERC').getAttribute('aria-selected'), 'true');
        await render({ sourcePending: true });
        assert.equal(await tab('ERC').isDisabled(), true);
        assert.equal(await tab('DRC').isDisabled(), true);
        await render({ sourcePending: false, drcAvailable: false });
        assert.equal(await tab('DRC').isDisabled(), true);
        await render({ drcAvailable: true });
      }
      await page.screenshot({ path: `test-results/window-style-${kind}-${theme}.png` });
      await render({ open: false });
    }
  }
  assert.deepEqual(await page.evaluate(() => window.windowStyles.writes), []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Rule checks/List/Git share window styling in light/dark; ERC/DRC matches editor mode cards and retains keyboard/IME/draft guards.',
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'test-results/window-styles-failure.png' });
    console.error(await page.locator('body').innerText(), errors);
  }
  throw error;
} finally {
  await browser.close();
}
