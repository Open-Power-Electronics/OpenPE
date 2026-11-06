import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Real Next/Turbopack and WebGL lifecycle coverage. Every editable source is a
// private copy. Never connect to, reload, or edit the user's development app.
// Two fixture samples shorten this lifecycle check; this is not quality evidence.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, 'test-results', 'model-render-hmr', randomUUID());
const nonce = path.basename(output);
const fixtureRoot = path.join(output, 'app-fixture');
const originalHashes = new Map();
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fixturePath = (relative) => {
  const target = path.resolve(fixtureRoot, relative);
  assert.ok(
    target.startsWith(`${fixtureRoot}${path.sep}`),
    'Writes stay inside the private fixture.',
  );
  return target;
};
async function save(relative, contents) {
  const target = fixturePath(relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}
async function snapshot(relative, optional = false, jsonOnly = false) {
  const source = path.join(root, relative);
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw error;
  }
  assert.equal(info.isSymbolicLink(), false, `Snapshot rejects links: ${relative}`);
  if (info.isDirectory()) {
    for (const child of await readdir(source))
      await snapshot(path.join(relative, child), false, jsonOnly);
  } else if (
    info.isFile() &&
    (jsonOnly ? /\.json$/i : /\.(?:tsx?|[cm]?js|json|css|svg)$/i).test(relative)
  ) {
    const bytes = await readFile(source);
    originalHashes.set(relative, hash(bytes));
    await save(relative, bytes);
  }
}
function replaceOnce(source, marker, replacement) {
  const index = source.indexOf(marker);
  assert.ok(
    index >= 0 && source.indexOf(marker, index + marker.length) < 0,
    `Find one fixture marker: ${marker.trim().slice(0, 100)}`,
  );
  return source.slice(0, index) + replacement + source.slice(index + marker.length);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.notEqual(port, 3000);
  return port;
}
async function stopOwned(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  assert.equal(child.spawnfile, process.execPath);
  assert.equal(child.spawnargs[1], path.join(root, 'node_modules/next/dist/bin/next'));
  assert.ok(
    child.spawnargs.includes(fixtureRoot),
    'Cleanup belongs to this private fixture nonce.',
  );
  let closed = false;
  let terminationCode;
  const stopped = new Promise((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  if (process.platform === 'win32') {
    // Verify the still-running PID before terminating its complete Next worker
    // tree. The private UUID path distinguishes it from every user dev server.
    const verifier = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}').CommandLine`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let commandLine = '';
    verifier.stdout.on('data', (chunk) => {
      commandLine += chunk;
    });
    const verified = await new Promise((resolve, reject) => {
      verifier.once('error', reject);
      verifier.once('close', resolve);
    });
    assert.equal(verified, 0, 'Read the owned Next process identity before cleanup.');
    if (commandLine.trim()) {
      assert.ok(
        commandLine.includes(child.spawnargs[1]) && commandLine.includes(fixtureRoot),
        'Refuse to terminate a PID that is no longer the private fixture.',
      );
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      terminationCode = await new Promise((resolve, reject) => {
        killer.once('error', reject);
        killer.once('close', resolve);
      });
    }
  } else child.kill('SIGTERM');
  let timeout;
  try {
    await Promise.race([
      stopped,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `The private Next process did not close after cleanup (termination exit ${terminationCode}).`,
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

await mkdir(fixtureRoot, { recursive: true });
for (const directory of ['components', 'lib', 'api', 'core']) await snapshot(directory);
await snapshot('domain', true);
await snapshot('resources/example-catalog', false, true);
for (const name of [
  'example-models-lock.json',
  'emc-flyback-models-lock.json',
  'reference-models-lock.json',
])
  await snapshot(`resources/${name}`);
await snapshot('tests/fixtures/kicad/manifest.json', true);
for (const name of ['globals.css', 'workspace.css', 'layout-editor.css'])
  await snapshot(`app/${name}`);
await snapshot('public/brand/openpe-mark.svg', true);
await snapshot('public/cursors');

const pcbFile = 'components/PCBModelPreview.tsx';
const studioFile = 'components/model-studio-renderer.ts';
let pcb = await readFile(fixturePath(pcbFile), 'utf8');
assert.ok(
  /import\s*\{[^}]*createModelStudioRenderer[^}]*\}\s*from\s*['"]\.\/model-studio-renderer['"]/.test(
    pcb,
  ),
  'The real Model component has a static studio value dependency.',
);
assert.doesNotMatch(pcb, /import\(\s*['"]\.\/model-studio-renderer['"]\s*\)/);
pcb = replaceOnce(
  pcb,
  'export type PCB3DViewState = {',
  'if(typeof window!=="undefined") window.__hmrPcbModuleRevision = 0;\nexport type PCB3DViewState = {',
);
pcb = replaceOnce(
  pcb,
  '  const gridOptions = useRef(',
  '  if (typeof window !== "undefined") window.__hmrPcbRevision = 0;\n  const gridOptions = useRef(',
);
pcb = replaceOnce(
  pcb,
  '    const control = new AbortController(),',
  '    const effectGeneration = ++window.__hmrStats.effectsCreated;\n    const control = new AbortController(),',
);
pcb = replaceOnce(
  pcb,
  '      rendererDisposed = true;',
  '      rendererDisposed = true;\n      window.__hmrStats.renderersDisposed++;',
);
pcb = replaceOnce(
  pcb,
  'renderer = new THREE.WebGLRenderer(',
  'window.__hmrStats.renderersCreated++;\n      renderer = new THREE.WebGLRenderer(',
);
pcb = replaceOnce(
  pcb,
  '          setRenderProgress({ samples: 0, target: MODEL_RENDER_SAMPLES });',
  `          window.__hmrStats.studiosCreated++;
          const ownedStudio = studio, originalDispose = studio.dispose;
          let releasedStudio = false;
          studio.dispose = () => {
            if (!releasedStudio) { releasedStudio = true; window.__hmrStats.studiosDisposed++; }
            originalDispose.call(ownedStudio);
          };
          setRenderProgress({ samples: 0, target: MODEL_RENDER_SAMPLES });`,
);
pcb = replaceOnce(
  pcb,
  '      redraw.current = render;',
  `      redraw.current = render;
      window.__hmrStats.generation = effectGeneration;
      window.__hmrInspect = () => ({renderer, camera, group, board, modelCad});
      window.__hmrCaptureCallback = () => applyRenderMode.current;`,
);
pcb = replaceOnce(
  pcb,
  '    return () => {\n      restoreSketchCamera();',
  '    return () => {\n      window.__hmrStats.effectsDisposed++;\n      restoreSketchCamera();',
);
await save(pcbFile, pcb);
let studio = await readFile(fixturePath(studioFile), 'utf8');
studio = replaceOnce(
  studio,
  'export const MODEL_RENDER_SAMPLES = 64;',
  'if (typeof window !== "undefined") window.__hmrStudioRevision = 0;\nexport const MODEL_RENDER_SAMPLES = 2;',
);
studio = replaceOnce(
  studio,
  '  const startCompile = () => {',
  `  const startCompile = () => {
    if (window.__hmrHoldPreparing) { window.__hmrPreparingGeneration = window.__hmrStats.generation; return; }`,
);
await save(studioFile, studio);

const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const board = createEmptyPCB();
board.graphics = [
  {
    id: randomUUID(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 0, y: 0 },
    points: [
      { x: 40, y: 0 },
      { x: 40, y: 30 },
    ],
    end: { x: 0, y: 30 },
  },
];
const netId = randomUUID();
board.nets = [{ id: netId, name: 'GND' }];
board.tracks = [
  {
    id: randomUUID(),
    netId,
    layer: 'F.Cu',
    width: 2,
    start: { x: 3, y: 15 },
    end: { x: 37, y: 15 },
  },
];
const fixture = {
  board,
  modelCad: null,
  view: {
    boardId: board.id,
    position: [56, -52, 85],
    target: [20, -15, 0],
    up: [0, 0, 1],
    zoom: 1,
    extent: 58,
    orthographic: true,
    modelsVisible: true,
    boardDisplay: { substrate: true, copper: true, mask: true, silkscreen: true },
  },
};
await save('fixture.json', JSON.stringify(fixture));
await save(
  'package.json',
  JSON.stringify({ name: 'openpe-model-hmr-fixture', private: true, type: 'module' }),
);
await save(
  'next.config.mjs',
  `export default { devIndicators: false, reactStrictMode: true, turbopack: { root: ${JSON.stringify(root)} } };\n`,
);
await save(
  'tsconfig.json',
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['dom', 'esnext'],
        skipLibCheck: true,
        allowJs: true,
        jsx: 'react-jsx',
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        esModuleInterop: true,
        paths: { '@/*': ['./*'] },
      },
      include: ['**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    },
    null,
    2,
  ),
);
await save(
  'app/layout.tsx',
  `import './globals.css';import './workspace.css';import './layout-editor.css';
export default function Layout({children}){return <html lang="en"><head><link rel="icon" href="data:,"/></head><body style={{margin:0}}>{children}</body></html>;}`,
);
await save(
  'app/api/health/route.ts',
  `export function GET(){return new Response(${JSON.stringify(nonce)});}\n`,
);
let harness = `'use client';
import {useRef,useState} from 'react';import Preview from '../components/PCBModelPreview';import fixture from '../fixture.json';
if(typeof window!=='undefined')window.__hmrPageModuleRevision = 0;
function Footer({center}){return <footer className="status-bar"><div className="status-center">{center}</div></footer>;}
export default function Harness(){
 if(typeof window!=='undefined')window.__hmrPageRevision = 0;
 const [draft,setDraft]=useState(''),[active,setActive]=useState(true),[mounted,setMounted]=useState(true);
 const [board]=useState(()=>fixture.board),view=useRef(fixture.view);
 const [host]=useState(()=>({catalog:()=>[],execute:async()=>{window.__hmrCommits++;throw Error('This HMR fixture is read-only.');}}));
 if(typeof window!=='undefined'){
   window.__hmrStats??={effectsCreated:0,effectsDisposed:0,renderersCreated:0,renderersDisposed:0,studiosCreated:0,studiosDisposed:0,generation:0};
   window.__hmrControls={setActive,setMounted};
 }
 return <main><header style={{height:44,padding:6,boxSizing:'border-box'}}><label>Unsaved fixture draft <input aria-label="Unsaved fixture draft" value={draft} onChange={event=>setDraft(event.target.value)}/></label></header>
 <div style={{height:'calc(100vh - 44px)'}}>{mounted?<Preview board={board} modelCad={fixture.modelCad} viewState={view} active={active} visible={active} capabilityHost={host} errorTarget={null} statusBar={<Footer/>}/>:null}</div></main>;
}`;
await save('app/page.tsx', harness);

if (process.argv.includes('--prepare-only')) {
  console.log(`Prepared private HMR sources without launching a server or browser: ${output}`);
  process.exit(0);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logs = [];
let compilationFailure = '';
const child = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/next/dist/bin/next'),
    'dev',
    fixtureRoot,
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    cwd: fixtureRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  },
);
let spawnError;
child.once('error', (error) => {
  spawnError = error;
});
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 500) logs.shift();
    const recent = logs.slice(-2).join('');
    if (/Module not found|Can't resolve|Failed to compile/i.test(recent))
      compilationFailure = recent.slice(-8000);
  });
let browser;
let page;
let failure;
const messages = [],
  errors = [],
  badImports = [],
  failedResources = [],
  refreshMessages = [],
  websocketEvents = [],
  graphReads = new Set();
let pcbChunks = 0,
  navigations = 0,
  documentLoads = 0;
const frameNavigationUrls = [];
const checks = [];
let attemptedEdit;
async function browserState() {
  if (!page || page.isClosed()) return { closed: true };
  return page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibility: document.visibilityState,
      navigation: window.__hmrNavigation ?? null,
      pcbRevision: window.__hmrPcbRevision ?? null,
      pcbModuleRevision: window.__hmrPcbModuleRevision ?? null,
      pageRevision: window.__hmrPageRevision ?? null,
      pageModuleRevision: window.__hmrPageModuleRevision ?? null,
      refreshHelpers: typeof window.$RefreshHelpers$,
      updateListeners: {
        array: Array.isArray(window.TURBOPACK_CHUNK_UPDATE_LISTENERS),
        push: typeof window.TURBOPACK_CHUNK_UPDATE_LISTENERS?.push,
      },
      studioRevision: window.__hmrStudioRevision ?? null,
      stats: window.__hmrStats ?? null,
      preparing: window.__hmrPreparingGeneration ?? null,
      holdPreparing: window.__hmrHoldPreparing ?? false,
      input: document.querySelector('input[aria-label="Unsaved fixture draft"]')?.value ?? null,
      canvas: document.querySelector('.pcb-model-canvas')
        ? { ...document.querySelector('.pcb-model-canvas').dataset }
        : null,
      renderButton: [...document.querySelectorAll('button')]
        .filter((item) => item.textContent.trim() === 'Render')
        .map((item) => ({ pressed: item.getAttribute('aria-pressed'), disabled: item.disabled })),
      body: document.body.innerText.slice(0, 3000),
      scripts: [...document.scripts]
        .map((item) => item.src)
        .filter(Boolean)
        .slice(-20),
    }))
    .catch((error) => ({ error: String(error) }));
}
async function guarded(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setInterval(() => {
          const consoleError = messages.find((item) => item.type === 'error');
          if (
            spawnError ||
            compilationFailure ||
            errors.length ||
            consoleError ||
            child.exitCode !== null
          )
            reject(
              spawnError ??
                new Error(
                  compilationFailure ||
                    errors[0] ||
                    (consoleError
                      ? `${consoleError.text} (${consoleError.location?.url ?? failedResources.at(-1)?.url ?? 'unknown resource'})`
                      : 'Private Next exited unexpectedly.'),
                ),
            );
        }, 100);
      }),
    ]);
  } finally {
    clearInterval(timer);
  }
}
try {
  console.log(`Isolated HMR fixture: ${base} (${output})`);
  const deadline = Date.now() + 120000;
  while (true) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error(`Private Next exited: ${logs.join('').slice(-8000)}`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.text()) === nonce) break;
    } catch {}
    if (Date.now() >= deadline)
      throw new Error(`Private Next did not start: ${logs.join('').slice(-8000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({
    headless: true,
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  });
  page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (/HMR|Fast Refresh|Turbopack|WebSocket/i.test(text)) {
      refreshMessages.push({
        time: Date.now(),
        type: message.type(),
        text: text.slice(0, 4000),
        location: message.location(),
      });
      if (refreshMessages.length > 100) refreshMessages.shift();
    }
    if (messages.length < 500 && ['warning', 'error'].includes(message.type()))
      messages.push({
        type: message.type(),
        text: text.slice(0, 4000),
        location: message.location(),
      });
  });
  page.on('websocket', (socket) => {
    const record = (kind, payload = '') => {
      const text = String(payload);
      websocketEvents.push({
        time: Date.now(),
        kind,
        url: socket.url(),
        bytes: Buffer.byteLength(text),
        text: text.slice(0, 6000),
        markers: text.match(/__hmr(?:Pcb|Studio)Revision.{0,100}/g)?.slice(0, 6),
      });
      if (websocketEvents.length > 150) websocketEvents.shift();
    };
    record('created');
    socket.on('framesent', (event) => record('sent', event.payload));
    socket.on('framereceived', (event) => record('received', event.payload));
    socket.on('socketerror', (error) => record('error', error));
    socket.on('close', () => record('closed'));
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigations++;
      frameNavigationUrls.push({ time: Date.now(), url: frame.url() });
    }
  });
  page.on('load', () => {
    documentLoads++;
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResources.push({
        url: response.url(),
        status: response.status(),
        type: response.request().resourceType(),
      });
    if (
      !response.url().includes('/_next/static/chunks/') ||
      !new URL(response.url()).pathname.endsWith('.js')
    )
      return;
    const reading = response
      .text()
      .then((source) => {
        if (!source.includes('PCBModelPreview')) return;
        pcbChunks++;
        if (/model-studio-renderer\.ts[^"\n]{0,160}\(ecmascript, async loader\)/.test(source))
          badImports.push(response.url());
      })
      .catch(() => {})
      .finally(() => graphReads.delete(reading));
    graphReads.add(reading);
  });
  await page.addInitScript(() => {
    window.__hmrNavigation = crypto.randomUUID();
    window.__hmrCommits = 0;
  });
  const documentResponse = await guarded(
    page.goto(base, { timeout: 180000, waitUntil: 'domcontentloaded' }),
  );
  assert.ok(
    documentResponse?.ok(),
    `Private fixture document returns success (${documentResponse?.status()}).`,
  );
  const button = page.getByRole('button', { name: 'Render', exact: true });
  const host = page.locator('.pcb-model-canvas');
  const ready = async () => {
    await guarded(
      page.waitForFunction(
        () => window.__hmrInspect && document.querySelector('.pcb-model-canvas canvas'),
      ),
    );
    await guarded(
      page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (item) => item.textContent.trim() === 'Render' && !item.disabled,
        ),
      ),
    );
  };
  const complete = () =>
    guarded(
      page.waitForFunction(
        () =>
          Number(document.querySelector('.pcb-model-canvas')?.dataset.renderSamples ?? 0) >= 2 &&
          document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'studio',
      ),
    );
  await ready();
  const socketDeadline = Date.now() + 15000;
  while (!(
    websocketEvents.some(
      (event) => event.kind === 'received' && event.text.includes('turbopack-connected'),
    ) &&
    websocketEvents.some(
      (event) => event.kind === 'sent' && event.text.includes('turbopack-subscribe'),
    ) &&
    (await page.evaluate(
      () =>
        !Array.isArray(window.TURBOPACK_CHUNK_UPDATE_LISTENERS) &&
        typeof window.TURBOPACK_CHUNK_UPDATE_LISTENERS?.push === 'function',
    ))
  )) {
    if (Date.now() >= socketDeadline)
      throw new Error(
        'The private Next HMR transport did not finish handshake and chunk subscriptions.',
      );
    await page.waitForTimeout(100);
  }
  await button.waitFor();
  assert.equal(await button.isEnabled(), true);
  await page
    .getByRole('textbox', { name: 'Unsaved fixture draft' })
    .fill('Keep this unsaved draft through HMR');
  await host.hover();
  await page.mouse.wheel(0, -100);
  await waitForAsync(page, async () => {
    const values = () => {
      const camera = window.__hmrInspect().camera;
      return [...camera.position.toArray(), camera.zoom];
    };
    const before = values();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return values().every((value, index) => Math.abs(value - before[index]) < 1e-8);
  });
  const inspect = () =>
    page.evaluate(() => {
      const state = window.__hmrInspect();
      return {
        board: JSON.stringify(state.board),
        modelCad: JSON.stringify(state.modelCad),
        camera: [
          ...state.camera.position.toArray(),
          ...state.camera.quaternion.toArray(),
          state.camera.zoom,
        ],
        generation: window.__hmrStats.generation,
        navigation: window.__hmrNavigation,
        commits: window.__hmrCommits,
      };
    });
  const baseline = await inspect();
  const preserved = async (name) => {
    const value = await inspect();
    assert.equal(value.board, baseline.board, `${name}: native board is preserved.`);
    assert.equal(value.modelCad, baseline.modelCad, `${name}: CAD data is preserved.`);
    assert.equal(value.commits, 0, `${name}: viewing never commits.`);
    assert.equal(value.navigation, baseline.navigation, `${name}: no forced page reload.`);
    for (let index = 0; index < value.camera.length; index++)
      assert.ok(
        Math.abs(value.camera[index] - baseline.camera[index]) < 1e-6,
        `${name}: retained camera value ${index}.`,
      );
    assert.equal(
      await page.getByRole('textbox', { name: 'Unsaved fixture draft' }).inputValue(),
      'Keep this unsaved draft through HMR',
    );
    checks.push(name);
  };
  const edit = async (kind, revision, enabled) => {
    const before = await inspect();
    attemptedEdit = { kind, revision, enabled, before: await browserState(), time: Date.now() };
    if (kind === 'pcb') {
      for (const name of ['__hmrPcbRevision', '__hmrPcbModuleRevision'])
        pcb = pcb.replace(new RegExp(`window\\.${name} = \\d+;`), `window.${name} = ${revision};`);
      await save(pcbFile, pcb);
    } else {
      studio = studio.replace(
        /window\.__hmrStudioRevision = \d+;/,
        `window.__hmrStudioRevision = ${revision};`,
      );
      await save(studioFile, studio);
    }
    await guarded(
      page.waitForFunction(
        ({ kind, revision, generation }) =>
          window[kind === 'pcb' ? '__hmrPcbRevision' : '__hmrStudioRevision'] === revision &&
          window.__hmrStats.generation > generation,
        { kind, revision, generation: before.generation },
        { timeout: 45000 },
      ),
    );
    await ready();
    assert.equal(
      await button.getAttribute('aria-pressed'),
      String(enabled),
      `${kind} HMR retains Render.`,
    );
    if (enabled && !(await page.evaluate(() => window.__hmrHoldPreparing))) await complete();
    await preserved(`${kind} HMR revision ${revision}`);
  };

  attemptedEdit = { kind: 'page', revision: 1, before: await browserState(), time: Date.now() };
  for (const name of ['__hmrPageRevision', '__hmrPageModuleRevision'])
    harness = harness.replace(new RegExp(`window\\.${name} = \\d+;`), `window.${name} = 1;`);
  await save('app/page.tsx', harness);
  await guarded(
    page.waitForFunction(
      () => window.__hmrPageRevision === 1 && window.__hmrPageModuleRevision === 1,
      undefined,
      { timeout: 45000 },
    ),
  );
  await preserved('page Fast Refresh transport control');
  await page.evaluate(() => {
    window.__hmrRetiredCallback = window.__hmrCaptureCallback();
  });
  await edit('pcb', 1, false);
  await button.click();
  await complete();
  const beforeRetired = await page.evaluate(() => ({ ...window.__hmrStats }));
  await page.evaluate(() => window.__hmrRetiredCallback());
  assert.deepEqual(
    await page.evaluate(() => ({ ...window.__hmrStats })),
    beforeRetired,
    'Retired callbacks do not import or allocate against the new scene.',
  );
  await preserved('retired callback after enabling new instance');
  await edit('pcb', 2, true);
  await button.click();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'standard',
  );
  await edit('studio', 1, false);
  await button.click();
  await complete();
  await edit('studio', 2, true);
  await button.click();
  await page.evaluate(() => {
    window.__hmrHoldPreparing = true;
  });
  await button.click();
  await page.waitForFunction(
    () => window.__hmrPreparingGeneration === window.__hmrStats.generation,
  );
  await edit('studio', 3, true);
  await page.waitForFunction(
    () => window.__hmrPreparingGeneration === window.__hmrStats.generation,
  );
  await page.evaluate(() => {
    window.__hmrHoldPreparing = false;
  });
  await complete();
  await preserved('studio HMR during preparation');
  await button.click();
  for (let cycle = 0; cycle < 3; cycle++) {
    await button.click();
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
  }
  await button.click();
  await complete();
  await page.evaluate(() => window.__hmrControls.setActive(false));
  const frames = await host.getAttribute('data-render-count');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await host.getAttribute('data-render-count'),
    frames,
    'Hidden Model pauses its render loop.',
  );
  await page.evaluate(() => window.__hmrControls.setActive(true));
  await complete();
  await preserved('rapid toggles and hidden resume');
  await page.screenshot({ path: path.join(output, 'after-hmr.png') });
  await page.evaluate(() => window.__hmrControls.setMounted(false));
  await host.waitFor({ state: 'detached' });
  const resources = await page.evaluate(() => ({ ...window.__hmrStats }));
  for (const [created, disposed] of [
    ['effectsCreated', 'effectsDisposed'],
    ['renderersCreated', 'renderersDisposed'],
    ['studiosCreated', 'studiosDisposed'],
  ])
    assert.equal(
      resources[created],
      resources[disposed],
      `${created} allocations are disposed after unmount.`,
    );
  await Promise.allSettled([...graphReads]);
  assert.ok(pcbChunks > 0, 'Inspect the real served PCB dependency graph.');
  assert.deepEqual(badImports, [], 'PCB has no studio async-loader dependency.');
  assert.equal(documentLoads, 1, 'HMR never loads a replacement document.');
  assert.deepEqual(errors, [], 'HMR has no uncaught browser errors.');
  assert.deepEqual(
    messages.filter(
      (item) =>
        item.type === 'error' ||
        /Unexpected import|module factory|deleted by.*HMR|THREE\.(?:Clock|Source):|deprecat/i.test(
          item.text,
        ),
    ),
    [],
    'HMR has no retired imports, console errors, or deprecations.',
  );
  await writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify(
      {
        checks,
        resources,
        navigations,
        documentLoads,
        frameNavigationUrls,
        pcbChunks,
        fixtureSamples: 2,
        qualityEvidence: false,
        port,
        refreshMessages,
        websocketEvents,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error;
  const state = await browserState();
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(error.stack ?? error),
        checks,
        errors,
        messages,
        badImports,
        failedResources,
        attemptedEdit,
        browser: state,
        navigations,
        documentLoads,
        frameNavigationUrls,
        refreshMessages,
        websocketEvents,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await browser?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await stopOwned(child);
  } catch (error) {
    failure ??= error;
    await writeFile(path.join(output, 'cleanup-failure.txt'), String(error.stack ?? error));
  }
  await writeFile(path.join(output, 'next-dev.log'), logs.join(''));
  // Other chats can edit unrelated UI while the private snapshot runs. Verify
  // that the reviewed Model inputs remain current without claiming those
  // independent edits were made by this fixture.
  const reviewedInputs = new Set(
    [
      pcbFile,
      studioFile,
      'components/model-render-scene.ts',
      'components/model-render-environment.ts',
      'components/model-copper-relief.ts',
      'components/ModelDisplayPanel.tsx',
    ].map((relative) => path.normalize(relative)),
  );
  const changed = [];
  for (const [relative, expected] of originalHashes)
    if (
      reviewedInputs.has(path.normalize(relative)) &&
      hash(await readFile(path.join(root, relative))) !== expected
    )
      changed.push(relative);
  if (changed.length && !failure)
    failure = new Error(`Original sources changed during this snapshot run: ${changed.join(', ')}`);
}
if (failure) throw failure;
console.log(
  `Model render HMR passed: ${checks.length} state/lifecycle checks; private artifacts: ${output}`,
);
