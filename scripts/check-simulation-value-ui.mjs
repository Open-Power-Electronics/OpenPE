import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Isolated renderer: no Electron, local service, provider or solver.
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import PartProperties from './components/PartProperties';
      import {createExample} from './lib/examples';
      import {parseProject, serializeProject} from './lib/project';
      function Fixture() {
        const [project, setProject] = useState(() => createExample('kicad-buck'));
        const [history, setHistory] = useState([]);
        const [ref, setRef] = useState('R101');
        window.valueState = {source: serializeProject(project), commits: history.length};
        const part = project.schematic.parts.find(p => p.ref === ref);
        return <>
          <button onClick={() => setRef('R101')}>Resistor</button>
          <button onClick={() => setRef('V101')}>Pulse</button>
          <button onClick={() => setProject(parseProject(serializeProject(project)))}>Reopen</button>
          <button onClick={() => {setProject(history.at(-1)); setHistory(h => h.slice(0,-1));}}>Undo</button>
          <div className="panel"><PartProperties key={part.id} part={part} onSave={(ref, value, fields) => {
            const next = structuredClone(project);
            Object.assign(next.schematic.parts.find(p => p.id === part.id), {ref, value, fields});
            setHistory(h => [...h, project]); setProject(next); return true;
          }}/></div>
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
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 820 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const path of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addStyleTag({
    content:
      '.panel {width:400px; padding:16px; margin:20px; border:1px solid #ddd; border-radius:16px;}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const value = page.getByLabel('Component value', { exact: true });
  await value.waitFor();
  assert.equal(await value.inputValue(), '5');
  await page.locator('summary').click();
  assert.equal(await page.getByLabel('Sim.Params', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Sim.Device', { exact: true }).inputValue(), 'R');
  assert.equal(await page.getByLabel('Sim.Pins', { exact: true }).inputValue(), '1=+ 2=-');
  const state = () => page.evaluate(() => window.valueState);
  const original = await state();
  await value.focus();
  await value.press('Tab');
  assert.deepEqual(await state(), original, 'unchanged blur stays clean');
  await value.fill('22');
  await value.press('Enter');
  let edited = await state();
  assert.equal(edited.commits, 1);
  const part = JSON.parse(edited.source).schematic.components.find((p) => p.reference === 'R101');
  assert.equal(part.value, '22');
  assert.equal(part.simulation.valueFormat, 'r=${VALUE}');
  assert.equal(part.fields['Sim.Params'], undefined);
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  assert.equal(await value.inputValue(), '22');
  assert.equal((await state()).commits, 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await value.inputValue(), '5');
  assert.deepEqual(await state(), original);
  await value.fill('r=22');
  await value.press('Enter');
  await page.getByRole('alert').waitFor();
  assert.deepEqual(await state(), original);
  await value.press('Escape');
  assert.equal(await value.inputValue(), '5');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/simulation-value.png' });
  await page.getByRole('button', { name: 'Pulse', exact: true }).click();
  await page.locator('summary').click();
  const params = page.getByLabel('Sim.Params', { exact: true });
  await params.waitFor();
  assert.match(await params.inputValue(), /y1=0 y2=15/);
  assert.deepEqual(errors, []);
  console.log(
    'Single value editing, no-op blur, JSON reopen, undo, invalid drafts and independent source parameters passed.',
  );
} finally {
  await browser.close();
}
