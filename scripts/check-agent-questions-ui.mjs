// Isolated browser components: no Electron, provider, project or user files.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import Questions from './components/AgentQuestions';
    import Process from './components/AgentProcess';
    import Tool from './components/AgentToolCall';
    const questions=[{id:'voltage',header:'Voltage',question:'Output voltage?',options:[{label:'12 V',description:'Nominal'},{label:'24 V',description:'Higher'}],multiSelect:false},
      {id:'features',header:'Features',question:'Which features?',options:[{label:'Filter',description:''},{label:'Protection',description:''}],multiSelect:true}];
    window.answers=[];window.attempts=0;
    function Fixture(){const [running,setRunning]=useState(true),[attention,setAttention]=useState(false),[closed,setClosed]=useState(false);
      return <><div className="fixture-controls"><button onClick={()=>setRunning(false)}>Finish run</button><button onClick={()=>setAttention(true)}>Review needed</button><button onClick={()=>setClosed(true)}>Cancel question</button></div>
      <Process running={running} attention={attention}><p>Checking output</p>
        {attention && <Tool activity={{id:'review',messageId:'fixture',tool:'openpe_execute',name:'part.properties',status:'review',arguments:{text:'{"reference":"R1","value":"10k"}',truncated:false}}}
          onApply={()=>setAttention(false)} onReject={()=>setAttention(false)}/>}
      </Process>
      <p>Final answer remains visible</p>
      <Questions questions={questions} disabled={closed} onAnswer={async answers=>{window.attempts++;if(window.attempts===1)throw new Error('Retry delivery');window.answers.push(answers)}}/></>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const mount = async () => {
    await page.setContent('<div id="root" class="chat-panel"></div>');
    for (const file of ['app/globals.css', 'app/workspace.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addStyleTag({
      content:
        'html,body{height:auto;min-height:100%;overflow:auto}#root{width:100%;max-width:640px;margin:24px auto;padding:0 20px}.fixture-controls{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;font-size:12px}.fixture-controls button{padding:6px;background:var(--panel)}',
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
  };
  await mount();
  const form = page.getByRole('form', { name: 'Agent questions' });
  await form.waitFor();
  assert.equal(await form.locator('input:checked').count(), 0);
  assert.equal(
    await form.getByRole('button', { name: 'Continue', exact: true }).isDisabled(),
    true,
  );
  await form.getByRole('radio', { name: '12 V' }).check();
  await form.getByRole('radio', { name: '12 V' }).press('ArrowDown');
  assert.equal(await form.getByRole('radio', { name: '24 V' }).isChecked(), true);
  await form.getByRole('radio', { name: '24 V' }).press('ArrowUp');
  assert.equal(await form.getByRole('radio', { name: '12 V' }).isChecked(), true);
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await form.getByRole('checkbox', { name: 'Filter', exact: true }).check();
  await form.getByRole('checkbox', { name: 'Protection', exact: true }).check();
  await mkdir('test-results/agent-interaction', { recursive: true });
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-light.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-narrow.png',
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-dark.png',
    fullPage: true,
  });
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.setProperty('--font-step', '4px');
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-large-text.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));
  await page.setViewportSize({ width: 760, height: 1000 });
  const custom = form.getByRole('textbox', { name: 'Your answer: Voltage' });
  await custom.fill('15 V');
  await custom.dispatchEvent('compositionstart');
  await form.dispatchEvent('submit');
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await custom.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await custom.dispatchEvent('compositionend');
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await custom.inputValue(), '15 V');
  assert.equal(await form.locator('input:checked').count(), 2);
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  const receipt = page.getByLabel('Answers sent', { exact: true });
  await receipt.waitFor();
  assert.equal(await form.count(), 0);
  assert.equal(await receipt.evaluate((element) => element.open), false);
  await receipt.locator('summary').focus();
  await receipt.locator('summary').press('Enter');
  await receipt.getByText('15 V', { exact: true }).waitFor();
  await receipt.getByText('Filter, Protection', { exact: true }).waitFor();
  await receipt.locator('summary').click();
  assert.deepEqual(await page.evaluate(() => window.answers), [
    { voltage: ['15 V'], features: ['Filter', 'Protection'] },
  ]);
  await page.getByRole('button', { name: 'Finish run', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-process').open);
  await page.screenshot({ path: 'test-results/agent-interaction/completed.png', fullPage: true });
  assert.equal(
    await page.getByText('Final answer remains visible', { exact: true }).isVisible(),
    true,
  );
  await page.locator('.agent-process > summary').click();
  await page.getByText('Checking output', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Review needed', exact: true }).click();
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), true);
  assert.equal(
    await page.getByRole('button', { name: 'Apply part.properties', exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Reject part.properties', exact: true }).isVisible(),
    true,
  );
  await page.screenshot({ path: 'test-results/agent-interaction/review.png', fullPage: true });
  await page.getByRole('button', { name: 'Apply part.properties', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-process').open);
  await mount();
  await page.getByRole('button', { name: 'Cancel question', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Closed', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Agent question choices, custom/multiple answers, IME, retry, cancellation and process collapse passed.',
  );
} finally {
  await browser.close();
}
