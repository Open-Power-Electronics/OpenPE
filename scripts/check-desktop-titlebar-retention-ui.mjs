import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real titlebar with committed host actions; no IPC, files or native sends.
const bundle = await build({
  stdin: {
    contents: `import React,{StrictMode,Suspense,startTransition,useLayoutEffect,useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
      import Titlebar from './components/DesktopTitlebar';
      window.openpe={titleBarOverlay:false,titleBarInset:false};window.titlebarCalls=[];window.titlebarCounts={menus:{},navigation:0};window.titlebarSuspended=0;
      const initial={native:false,phase:'A',valid:true,back:true,forward:false,file:['New','Save'],view:['Schematic','Layout'],edit:['Undo'],help:['About'],suspend:false};
      const never=new Promise(()=>{});
      function Pause({state}){if(state.suspend){window.titlebarSuspended++;throw never}return null}
      function Fixture(){const[state,setState]=useState(initial);
        useLayoutEffect(()=>{window.committedTitlebar=state});
        window.patchTitlebar=patch=>flushSync(()=>setState(current=>({...current,...patch})));
        window.enableNativeTitlebar=()=>{window.openpe.titleBarOverlay=true;window.patchTitlebar({native:true})};
        window.interruptTitlebar=()=>startTransition(()=>setState(current=>({...current,phase:'ABANDONED',valid:true,suspend:true})));
        window.cancelTitlebar=()=>flushSync(()=>setState(window.committedTitlebar));
        const action=name=>()=>{window.titlebarCalls.push({name,phase:state.phase,allowed:state.valid})};
        const menus=[['File',state.file],['Edit',state.edit],['View',state.view],['Help',state.help]].map(([label,items])=>({label,items:items.map(item=>typeof item==='string'?{label:item,run:action(item)}:{label:item.label,items:item.items.map(label=>({label,run:action(label)}))})}));
        return <Suspense fallback={<span>Waiting</span>}><Titlebar key={String(state.native)} menus={menus}
          onBack={state.back?action('Back'):undefined} onForward={state.forward?action('Forward'):undefined}/><Pause state={state}/></Suspense>;
      }
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
  plugins: [
    {
      name: 'count-real-titlebar-jsx',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]DesktopTitlebar\.tsx$/ }, async ({ path: file }) => {
          let contents = await readFile(file, 'utf8');
          const menu = 'const element = (';
          const navigation = 'const navigation = useMemo(\n    () =>\n      visible && (';
          assert.ok(contents.includes(menu), 'Find actual menu JSX factory.');
          assert.ok(contents.includes(navigation), 'Find navigation JSX factory.');
          contents = contents.replace(
            menu,
            'window.titlebarCounts.menus[label]=(window.titlebarCounts.menus[label]||0)+1;\n' +
              menu,
          );
          contents = contents.replace(
            navigation,
            navigation + '\nwindow.titlebarCounts.navigation++,',
          );
          return { contents, loader: 'tsx', resolveDir: path.dirname(file) };
        });
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const patch = async (value) => {
    await page.evaluate((value) => window.patchTitlebar(value), value);
    await settle();
  };
  const counts = () => page.evaluate(() => structuredClone(window.titlebarCounts));
  const lastCall = () => page.evaluate(() => window.titlebarCalls.at(-1));
  const menu = (name) => page.getByRole('combobox', { name, exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  await settle();
  assert.equal(
    await page.locator('.desktop-titlebar').count(),
    0,
    'Browser-only windows render no native titlebar.',
  );
  await page.evaluate(() => window.enableNativeTitlebar());
  await menu('File').waitFor();
  await settle();
  assert.equal(await button('Back').isEnabled(), true);
  assert.equal(await button('Forward').isDisabled(), true);
  assert.equal(await button('Toggle sidebar').count(), 0);
  for (const name of ['Back', 'Forward']) {
    assert.equal(await button(name).innerText(), '');
    assert.equal(await button(name).getAttribute('title'), name, `${name} explains its icon.`);
  }
  const originalTheme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  const originalFocus = await page.evaluateHandle(() => document.activeElement);
  const captionContrast = (trigger) =>
    trigger.evaluate((element) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const painter = canvas.getContext('2d');
      const rgba = (color) => {
        painter.clearRect(0, 0, 1, 1);
        painter.fillStyle = color;
        painter.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = painter.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (foreground, background) =>
        foreground
          .slice(0, 3)
          .map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
      const luminance = (color) =>
        color.reduce((sum, channel, index) => {
          const value = channel / 255;
          const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + linear * [0.2126, 0.7152, 0.0722][index];
        }, 0);
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
      const background = ancestors.reduce(
        (behind, node) => over(rgba(getComputedStyle(node).backgroundColor), behind),
        [255, 255, 255],
      );
      const label = element.querySelector('.select-value');
      const foreground = over(rgba(getComputedStyle(label).color), background);
      const ink = luminance(foreground),
        ground = luminance(background);
      return {
        foreground,
        background,
        ink,
        ground,
        ratio: (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05),
      };
    });
  await mkdir('test-results', { recursive: true });
  try {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      );
      for (const name of ['File', 'Edit', 'View', 'Help']) {
        const trigger = menu(name);
        assert.equal(await trigger.getAttribute('aria-label'), name);
        assert.equal(
          await trigger.getAttribute('title'),
          null,
          `${name} omits a duplicate tooltip.`,
        );
        assert.equal(await trigger.locator('.select-value').textContent(), name);
        await trigger.hover();
        await settle();
        const hover = await captionContrast(trigger);
        assert.ok(
          hover.ratio >= 4.5 && hover.ink > hover.ground && hover.ground < 0.15,
          `${theme} ${name} hover keeps bright, readable text on a dark caption: ${JSON.stringify(hover)}`,
        );
        if (name === 'File')
          await page.locator('.desktop-titlebar-content').screenshot({
            path: `test-results/titlebar-hover-${theme}.png`,
          });
        await trigger.click();
        await page.mouse.move(800, 80);
        await settle();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        const expanded = await captionContrast(trigger);
        assert.ok(
          expanded.ratio >= 4.5 && expanded.ink > expanded.ground && expanded.ground < 0.15,
          `${theme} ${name} expanded state remains readable after hover leaves: ${JSON.stringify(expanded)}`,
        );
        await page.keyboard.press('Escape');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      }
    }
  } finally {
    await page.evaluate((theme) => {
      if (theme === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, originalTheme);
    await page.mouse.move(800, 80);
    await originalFocus.evaluate((element) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (element instanceof HTMLElement && element.isConnected)
        element.focus({ preventScroll: true });
    });
    await originalFocus.dispose();
    await settle();
  }
  const before = await counts();
  await page.evaluate(() => {
    window.retainedFile = document.querySelector('[role="combobox"][aria-label="File"]');
    window.retainedBack = document.querySelector('button[aria-label="Back"]');
  });
  await menu('File').click();
  await patch({ phase: 'BLOCKED', valid: false });
  assert.deepEqual(
    await counts(),
    before,
    'Same presentation retains every menu and navigation JSX group.',
  );
  assert.equal(
    await menu('File').getAttribute('aria-expanded'),
    'true',
    'Callback changes retain an already open menu.',
  );
  await page.getByRole('option', { name: 'Save', exact: true }).click();
  assert.deepEqual(
    await lastCall(),
    { name: 'Save', phase: 'BLOCKED', allowed: false },
    'Retained File Save reads the current guard.',
  );
  await menu('View').click();
  await patch({ phase: 'CURRENT', valid: true });
  await page.getByRole('option', { name: 'Layout', exact: true }).click();
  assert.deepEqual(
    await lastCall(),
    { name: 'Layout', phase: 'CURRENT', allowed: true },
    'Retained View Layout reads its latest callback.',
  );
  await button('Back').click();
  assert.equal((await lastCall()).phase, 'CURRENT');
  assert.equal(
    await page.evaluate(
      () =>
        window.retainedFile === document.querySelector('[role="combobox"][aria-label="File"]') &&
        window.retainedBack === document.querySelector('button[aria-label="Back"]'),
    ),
    true,
    'Retaining chrome preserves real controls.',
  );
  assert.deepEqual(await counts(), before);
  await menu('File').click();
  await patch({ file: ['Save', 'New'] });
  assert.deepEqual(
    await page.getByRole('option').allTextContents(),
    ['Save', 'New'],
    'Changed option order is current in an open menu.',
  );
  await page.keyboard.press('Escape');
  const afterFile = await counts();
  assert.ok(afterFile.menus.File > before.menus.File);
  for (const label of ['Edit', 'View', 'Help'])
    assert.equal(afterFile.menus[label], before.menus[label]);
  await patch({
    edit: [],
    help: ['Documentation'],
    back: false,
    forward: true,
  });
  assert.equal(await menu('Edit').isDisabled(), true);
  assert.equal(await button('Back').isDisabled(), true);
  assert.equal(await button('Forward').isEnabled(), true);
  await menu('Help').click();
  assert.equal(await page.getByRole('option', { name: 'Documentation', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  await patch({ phase: 'COMMITTED', valid: false });
  await menu('File').click();
  await page.evaluate(() => window.interruptTitlebar());
  await page.waitForFunction(() => window.titlebarSuspended > 0);
  await page.getByRole('option', { name: 'Save', exact: true }).click();
  assert.deepEqual(
    await lastCall(),
    { name: 'Save', phase: 'COMMITTED', allowed: false },
    'An abandoned StrictMode/Suspense render cannot replace committed actions.',
  );
  await page.evaluate(() => window.cancelTitlebar());
  await settle();
  await button('Forward').click();
  assert.equal((await lastCall()).phase, 'COMMITTED');
  await patch({ file: ['Save', { label: 'Example', items: ['Buck', 'Boost'] }] });
  await menu('File').click();
  await page.getByRole('option', { name: 'Example', exact: true }).hover();
  const examples = page.getByRole('listbox', { name: 'Example', exact: true });
  await examples.waitFor();
  const nestedCounts = await counts();
  await patch({ phase: 'NESTED_CURRENT', valid: true });
  assert.deepEqual(
    await counts(),
    nestedCounts,
    'Nested labels retain the open menu presentation.',
  );
  await examples.getByRole('option', { name: 'Buck', exact: true }).click();
  assert.deepEqual(await lastCall(), { name: 'Buck', phase: 'NESTED_CURRENT', allowed: true });
  await menu('File').click();
  await page.getByRole('option', { name: 'Example', exact: true }).hover();
  await patch({ file: ['Save', { label: 'Example', items: ['Boost', 'Flyback'] }], valid: false });
  assert.deepEqual(
    await examples.getByRole('option').allTextContents(),
    ['Boost', 'Flyback'],
    'Changed child labels refresh an already-open submenu.',
  );
  const changedChildren = await counts();
  assert.ok(changedChildren.menus.File > nestedCounts.menus.File);
  for (const label of ['Edit', 'View', 'Help'])
    assert.equal(changedChildren.menus[label], nestedCounts.menus[label]);
  const suspended = await page.evaluate(() => window.titlebarSuspended);
  await page.evaluate(() => window.interruptTitlebar());
  await page.waitForFunction((before) => window.titlebarSuspended > before, suspended);
  await examples.getByRole('option', { name: 'Flyback', exact: true }).click();
  assert.deepEqual(
    await lastCall(),
    { name: 'Flyback', phase: 'NESTED_CURRENT', allowed: false },
    'Nested actions also ignore an abandoned render and use their committed guard.',
  );
  await page.evaluate(() => window.cancelTitlebar());
  assert.deepEqual(errors, []);
  console.log(
    'DesktopTitlebar verified: readable light/dark hover and expanded labels without duplicate tooltips, retained menu/navigation presentation, current actions, guards and abandoned-render safety.',
  );
} finally {
  await browser.close();
}
