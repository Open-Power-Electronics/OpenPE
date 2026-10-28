import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { selectSourceFile } from './source-editor-test-helpers.mjs';

// Exercise the real retained CodeMirror editor without native files or a service.
const renderMode = process.env.OPENPE_RENDER_MODE === 'development' ? 'development' : 'production';
const bundle = await build({
  stdin: {
    contents: `import React,{useLayoutEffect,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {EditorState} from '@codemirror/state';
      import {EditorView} from '@codemirror/view';
      import {undoDepth,redoDepth} from '@codemirror/commands';
      import SourceEditor from './components/SourceEditor';
      window.sourceWork={renders:0,creates:0,resets:0,mounts:0};
      window.sourceActions={select:0,apply:0};
      const create=EditorState.create;
      EditorState.create=function(...args){window.sourceWork.creates++;return create.apply(this,args)};
      const setState=EditorView.prototype.setState;
      EditorView.prototype.setState=function(...args){window.sourceWork.resets++;return setState.apply(this,args)};
      const find=()=>EditorView.findFromDOM(document.querySelector('.source-editor-code .cm-editor'));
      window.inspectSource=()=>{const view=find();return {text:view.state.doc.toString(),
        selection:view.state.selection.toJSON(),undo:undoDepth(view.state),redo:redoDepth(view.state),
        top:view.scrollDOM.scrollTop,left:view.scrollDOM.scrollLeft}};
      window.editSource=text=>{const view=find();view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},
        selection:{anchor:Math.min(50,text.length)}})};
      window.scrollSource=top=>{find().scrollDOM.scrollTop=top};
      window.sourceBeforePaint=[];
      function Fixture(){
        const [state,setState]=useState({visible:true,active:true,file:'schematics/power/main.kicad_sch',status:'Ready',error:'',
          values:{'schematics/power/main.kicad_sch':Array.from({length:600},(_,i)=>'(wire (id '+i+'))').join('\\n'),
            'schematics/control/main.kicad_sch':'(kicad_sch (title "Control"))',
            'settings.kicad_pro':'{\\n  "board": {}\\n}\\n','reference.txt':'Read-only reference'}});
        window.updateSource=update=>setState(previous=>({...previous,...update,
          ...(update.values?{values:{...previous.values,...update.values}}:{})}));
        useLayoutEffect(()=>{if(state.visible&&document.querySelector('.cm-editor'))
          window.sourceBeforePaint.push(window.inspectSource().text)},[state]);
        return <div style={{height:'760px',display:state.visible?'block':'none'}}>
          <SourceEditor visible={state.visible} active={state.active} value={state.values[state.file]}
            activeFile={state.file} files={Object.entries(state.values).filter(([name])=>name!=='reference.txt')
              .map(([name,source])=>({name,source}))}
            referenceFiles={[{name:'reference.txt',label:'Reference',source:state.values['reference.txt'],readOnly:true}]}
            pending error={state.error} status={state.status}
            onSelectFile={file=>{window.sourceActions.select++;setState(previous=>({...previous,file}))}}
            onChange={text=>setState(previous=>({...previous,values:{...previous.values,[previous.file]:text}}))}
            onCopy={()=>{window.sourceCopied=state.values[state.file]}} onApply={()=>{window.sourceActions.apply++}}/>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
  jsxDev: renderMode === 'development',
  define: { 'process.env.NODE_ENV': JSON.stringify(renderMode) },
  plugins: [
    {
      name: 'count-source-renders',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/]components[\\/]SourceEditor\.tsx$/ },
          async ({ path: file }) => {
            let contents = await readFile(file, 'utf8');
            const marker = '  const fileName = activeFile';
            assert.ok(contents.includes(marker));
            contents = contents.replace(marker, `  window.sourceWork.renders++;\n${marker}`);
            const mount = '    const view = new EditorView({';
            assert.ok(contents.includes(mount));
            contents = contents.replace(mount, `    window.sourceWork.mounts++;\n${mount}`);
            return { contents, loader: 'tsx', resolveDir: path.dirname(file) };
          },
        );
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
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
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.cm-editor').waitFor();
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const update = async (changes) => {
    await page.evaluate((changes) => window.updateSource(changes), changes);
    await settle();
  };
  const inspect = () => page.evaluate(() => window.inspectSource());
  const work = () => page.evaluate(() => ({ ...window.sourceWork }));
  const actions = () => page.evaluate(() => ({ ...window.sourceActions }));
  const mainName = 'schematics/power/main.kicad_sch';
  const siblingName = 'schematics/control/main.kicad_sch';
  const schematicsFolder = page.locator('button[data-source-folder="schematics"]');
  const powerFolder = page.locator('button[data-source-folder="schematics/power"]');
  const mainFile = page.locator('button[data-source-file="schematics/power/main.kicad_sch"]');
  await settle();
  assert.equal(await schematicsFolder.getAttribute('aria-expanded'), 'false');
  assert.equal(await powerFolder.getAttribute('aria-expanded'), 'false');
  assert.equal(
    await mainFile.isVisible(),
    false,
    'Folders start collapsed even with a nested active file.',
  );
  assert.equal((await mainFile.textContent()).trim(), 'main.kicad_sch');
  assert.equal(await mainFile.getAttribute('data-source-file'), mainName);
  await selectSourceFile(page, siblingName);
  await settle();
  assert.equal((await inspect()).text, '(kicad_sch (title "Control"))');
  await selectSourceFile(page, mainName);
  await settle();
  await page.evaluate(() => {
    window.retainedSourceDOM = document.querySelector('.cm-editor');
  });
  const initial = await inspect();
  const invalidDraft = '(' + initial.text;
  await page.evaluate((text) => window.editSource(text), invalidDraft);
  await settle();
  await page.evaluate(() => window.scrollSource(320));
  await settle();
  const draft = await inspect();
  assert.equal(draft.text, invalidDraft);
  assert.ok(draft.undo > 0);
  assert.ok(draft.top > 0, 'The fixture exercises retained scrolling.');
  const divider = page.getByRole('button', { name: 'Resize Source file list width', exact: true });
  const filePane = page.locator('.source-editor-files');
  const initialWidth = (await filePane.boundingBox()).width;
  const grip = await divider.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 40);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 100, grip.y + 40, { steps: 4 });
  await page.mouse.up();
  await settle();
  assert.ok((await filePane.boundingBox()).width > initialWidth + 90);
  assert.deepEqual(
    await inspect(),
    draft,
    'Source resizing retains the current draft and editor history.',
  );
  await divider.focus();
  const expandedWidth = (await filePane.boundingBox()).width;
  await page.keyboard.press('ArrowLeft');
  assert.ok(Math.abs((await filePane.boundingBox()).width - expandedWidth + 16) < 2);
  await page.keyboard.press('Home');
  assert.ok(Math.abs((await filePane.boundingBox()).width - initialWidth) < 2);
  const cancelGrip = await divider.boundingBox();
  await page.mouse.move(cancelGrip.x + 4, cancelGrip.y + 40);
  await page.mouse.down();
  await page.mouse.move(cancelGrip.x + 84, cancelGrip.y + 40);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.ok(
    Math.abs((await filePane.boundingBox()).width - initialWidth) < 2,
    'Escape restores the prior width.',
  );
  assert.deepEqual(await inspect(), draft);
  const beforeCollapse = await actions();
  const beforeCollapseWork = await work();
  await powerFolder.click();
  await schematicsFolder.click();
  await settle();
  assert.equal(await mainFile.isVisible(), false);
  assert.deepEqual(await inspect(), draft, 'Collapsing folders retains the exact active editor.');
  assert.deepEqual(
    await actions(),
    beforeCollapse,
    'Folder toggles neither select nor apply files.',
  );
  assert.equal((await work()).resets, beforeCollapseWork.resets);

  await update({ visible: false, active: false });
  const hidden = await work();
  for (let index = 0; index < 20; index++) await update({ status: 'Background ' + index });
  assert.deepEqual(
    await work(),
    hidden,
    'Hidden parent updates do no Source render or CodeMirror work.',
  );
  await update({ visible: true, active: true });
  assert.deepEqual(
    await inspect(),
    draft,
    'Reveal retains draft, selection, local history and scroll.',
  );
  assert.equal(
    (await work()).resets,
    hidden.resets,
    'Unchanged reveal does not replace EditorState.',
  );
  assert.equal(await schematicsFolder.getAttribute('aria-expanded'), 'false');
  await schematicsFolder.click();
  assert.equal(await powerFolder.getAttribute('aria-expanded'), 'false');
  await powerFolder.click();
  await settle();
  assert.equal(await mainFile.isVisible(), true);
  assert.deepEqual(await inspect(), draft, 'Reopening folders retains draft, history and scroll.');
  assert.deepEqual(await actions(), beforeCollapse);

  await powerFolder.click();
  await schematicsFolder.click();
  await selectSourceFile(page, siblingName);
  await settle();
  assert.equal((await inspect()).text, '(kicad_sch (title "Control"))');
  assert.equal(await powerFolder.getAttribute('aria-expanded'), 'false');
  await selectSourceFile(page, mainName);
  await settle();
  assert.equal(await powerFolder.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await inspect(), draft, 'Full-path selection distinguishes sibling basenames.');

  await update({ file: 'settings.kicad_pro' });
  const beforeFolding = await inspect();
  // CodeMirror also creates an invisible gutter marker to measure its width.
  const foldMarker = page.locator('.cm-foldGutter [aria-label="Fold line"]:visible').first();
  const unfoldMarker = page.locator('.cm-foldGutter [aria-label="Unfold line"]:visible').first();
  const foldPlaceholder = page.locator('.cm-foldPlaceholder');
  await foldMarker.waitFor();
  assert.equal(await foldMarker.getAttribute('title'), 'Fold line');
  await foldMarker.click();
  await foldPlaceholder.waitFor();
  assert.equal(await unfoldMarker.getAttribute('title'), 'Unfold line');
  assert.equal(await foldPlaceholder.getAttribute('title'), 'unfold');
  assert.equal(await foldPlaceholder.getAttribute('aria-label'), 'folded code');
  assert.equal(await foldPlaceholder.getAttribute('aria-description'), 'unfold');
  assert.doesNotMatch(await page.locator('.cm-content').innerText(), /"board"/);
  assert.equal((await inspect()).text, beforeFolding.text, 'Folding retains the native text.');
  await unfoldMarker.click();
  await foldPlaceholder.waitFor({ state: 'detached' });
  assert.match(await page.locator('.cm-content').innerText(), /"board"/);
  await foldMarker.click();
  await foldPlaceholder.click();
  await foldPlaceholder.waitFor({ state: 'detached' });
  assert.match(await page.locator('.cm-content').innerText(), /"board"/);
  const afterFolding = await inspect();
  assert.equal(afterFolding.text, beforeFolding.text);
  assert.equal(afterFolding.undo, beforeFolding.undo, 'Fold controls never create text edits.');
  assert.equal(afterFolding.redo, beforeFolding.redo);
  assert.equal(await foldMarker.getAttribute('title'), 'Fold line');
  await page.evaluate(() => window.editSource('{'));
  await settle();
  const settings = await inspect();
  await schematicsFolder.click();
  await update({ file: mainName });
  assert.equal(await schematicsFolder.getAttribute('aria-expanded'), 'true');
  assert.equal(await powerFolder.getAttribute('aria-expanded'), 'true');
  assert.equal(await mainFile.isVisible(), true, 'An active file change reveals its ancestors.');
  assert.deepEqual(await inspect(), draft, 'Each native file retains its own exact editor state.');
  await update({ visible: false, active: false });
  const hiddenFiles = await work();
  await update({ file: 'settings.kicad_pro' });
  assert.deepEqual(await work(), hiddenFiles, 'A hidden file switch defers editor work.');
  await update({ visible: true, active: true });
  assert.deepEqual(
    await inspect(),
    settings,
    'Reveal restores the requested file history and invalid draft.',
  );

  await update({ visible: false, active: false });
  const beforeExternal = await work();
  for (let index = 0; index < 20; index++)
    await update({ values: { 'settings.kicad_pro': JSON.stringify({ revision: index }) } });
  assert.deepEqual(
    await work(),
    beforeExternal,
    'Hidden design revisions never rebuild CodeMirror baselines.',
  );
  const latest = JSON.stringify({ revision: 19 });
  await update({ visible: true, active: true });
  assert.equal((await inspect()).text, latest);
  assert.equal(
    (await work()).resets,
    beforeExternal.resets + 1,
    'Reveal applies only the latest baseline.',
  );
  assert.equal(
    await page.evaluate(() => window.sourceBeforePaint.at(-1)),
    latest,
    'Latest Source is synchronized in layout effects before reveal paint.',
  );
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.sourceCopied),
    latest,
    'Copy reads the current native Source.',
  );

  await update({ active: false, values: { 'settings.kicad_pro': '{"modal":true}' } });
  assert.equal(
    (await inspect()).text,
    '{"modal":true}',
    'A visible editor still refreshes while global input is suspended.',
  );
  await update({ active: true, file: 'reference.txt' });
  assert.equal(await page.locator('.cm-content').getAttribute('contenteditable'), 'false');
  await update({ file: mainName });
  assert.deepEqual(await inspect(), draft);
  assert.equal(
    await page.evaluate(() => window.retainedSourceDOM === document.querySelector('.cm-editor')),
    true,
  );
  assert.equal(
    (await work()).mounts,
    1,
    'One CodeMirror view survives every visibility/file transition.',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ mode: renderMode, hiddenUpdates: 41, work: await work(), status: 'passed' }),
  );
} finally {
  await browser.close();
}
