import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fillSource, readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

// Isolated mocked renderer only: no Electron, solver, provider or native writes.
await mkdir('test-results/project-directory-ui', { recursive: true });
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import SourceEditor from './components/SourceEditor';
    import{useProjectDirectory}from'./components/useProjectDirectory';
    import{captureAgentPresentation}from'./context/agent-presentation';
    window.capturePresentation=captureAgentPresentation;
    function Fixture(){const[native,setNative]=useState('{"design":true}');const[selected,setSelected]=useState('project.kicad_pro');
      const[destination,setDestination]=useState('project.kicad_pro');window.changeDestination=setDestination;
      const disk=useProjectDirectory('fixture-grant',destination,true,selected==='project.kicad_pro'?'':selected);
      const files=[{name:'project.kicad_pro',source:native},...disk.files.filter(f=>f.name!=='project.kicad_pro')];
      const current=files.find(f=>f.name===selected)||files[0];
      window.directoryState={native,selected};
      return <SourceEditor value={current.source} files={files} directories={disk.directories} activeFile={current.name}
        onSelectFile={setSelected} pending={native!=='{"design":true}'} error="" fileError={disk.error}
        onChange={value=>{window.nativeChanges=(window.nativeChanges||0)+1;setNative(value)}}
        onApply={()=>{window.applies=(window.applies||0)+1}} onCopy={()=>{window.copied=current.source;void navigator.clipboard.writeText(current.source)}}
        onRefreshFiles={disk.refresh}/>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {};
    let round = 0;
    window.openpe = {
      projectDirectory: async () => ({
        entries: [
          ...['footprints', 'models', 'spice', 'thermal', 'thermal/empty'].map((name) => ({
            name,
            kind: 'directory',
          })),
          ...[
            'spice/deck.cir',
            'models/part.step',
            'thermal/mesh.bin',
            'spice/late.log',
            ...(round++ ? ['notes/new.txt'] : []),
          ].map((name) => ({ name, kind: 'file', id: name })),
        ],
        truncated: false,
      }),
      projectFilePreview: async ({ id }) => {
        if (id === 'spice/late.log')
          return new Promise((resolve) => {
            window.resolveLate = resolve;
          });
        const source =
          id === 'spice/deck.cir'
            ? '* generated deck\n.tran 1u 10m'
            : id === 'models/part.step'
              ? 'ISO-10303-21;'
              : 'Binary file\nSize: 3 bytes\n';
        return { source, bytes: source.length, binary: id.endsWith('.bin'), truncated: false };
      },
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const name of ['footprints', 'models', 'spice', 'thermal']) {
    await page.getByRole('button', { name, exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name, exact: true }).getAttribute('aria-expanded'),
      'false',
    );
  }
  await page.getByRole('button', { name: 'thermal', exact: true }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'thermal/empty', exact: true })
      .getAttribute('aria-expanded'),
    'false',
  );
  await page.getByRole('button', { name: 'thermal', exact: true }).click();
  await fillSource(page, '{invalid native draft');
  const changes = await page.evaluate(() => window.nativeChanges);
  await selectSourceFile(page, 'spice/deck.cir');
  await page.waitForFunction(() =>
    document.querySelector('.cm-content')?.textContent.includes('generated deck'),
  );
  assert.equal(await page.locator('.cm-content').getAttribute('contenteditable'), 'false');
  assert.ok(await page.getByRole('button', { name: 'Apply', exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copied), '* generated deck\n.tran 1u 10m');
  assert.equal(await page.evaluate(() => window.nativeChanges), changes);
  const presentation = await page.evaluate(() => window.capturePresentation());
  assert.ok(!JSON.stringify(presentation).includes('generated deck'));
  assert.ok(!JSON.stringify(presentation).includes('spice/deck.cir'));
  await selectSourceFile(page, 'models/part.step');
  await page.waitForFunction(() =>
    document.querySelector('.cm-content')?.textContent.includes('ISO-10303-21'),
  );
  await selectSourceFile(page, 'thermal/mesh.bin');
  await page.waitForFunction(() =>
    document.querySelector('.source-editor')?.textContent.includes('Binary file metadata'),
  );
  await selectSourceFile(page, 'project.kicad_pro');
  assert.equal(await readSource(page), '{invalid native draft');
  assert.ok(!(await page.getByRole('button', { name: 'Apply', exact: true }).isDisabled()));
  await page.getByRole('button', { name: 'Refresh project files', exact: true }).click();
  await page.locator('button[data-source-file="notes/new.txt"]').waitFor({ state: 'attached' });
  assert.equal(
    await page.getByRole('button', { name: 'notes', exact: true }).getAttribute('aria-expanded'),
    'false',
  );
  assert.equal(
    await page.getByRole('button', { name: 'models', exact: true }).getAttribute('aria-expanded'),
    'true',
  );
  await selectSourceFile(page, 'spice/late.log');
  await page.waitForFunction(() => !!window.resolveLate);
  await page.evaluate(() => {
    window.changeDestination('next.kicad_pro');
  });
  await selectSourceFile(page, 'project.kicad_pro');
  await page.evaluate(() =>
    window.resolveLate({
      source: 'stale file from old destination',
      bytes: 10,
      binary: false,
      truncated: false,
    }),
  );
  assert.equal(await readSource(page), '{invalid native draft');
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/project-directory-ui/result.json',
    JSON.stringify(
      {
        passed: true,
        scope:
          'Mocked Source tree, empty folders, read-only previews, Copy, refresh, draft retention, destination guards and private Agent presentation.',
      },
      null,
      2,
    ),
  );
  console.log('Project directory Source UI passed.');
} finally {
  await browser.close();
}
