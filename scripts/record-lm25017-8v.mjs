import { _electron as electron } from 'playwright';
import { copyFile, lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import nativeProject from '../electron/native-project.cjs';
import { projectFromNativeFiles } from '../server/project-format.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function prepareOutput(root, output) {
  const relative = path.relative(root, output);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Output must be inside the workspace.');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('Output and its parents must be regular, unlinked directories.');
  }
  const existing = await readdir(output).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.length) throw new Error('Output is not empty. Choose a new recording directory.');
  await mkdir(output, { recursive: true });
  const resolvedRelative = path.relative(await realpath(root), await realpath(output));
  if (
    !resolvedRelative ||
    resolvedRelative === '..' ||
    resolvedRelative.startsWith('..' + path.sep) ||
    path.isAbsolute(resolvedRelative)
  )
    throw new Error('Resolved output must stay inside the workspace.');
}

async function copyStage(source, target, prefix = '') {
  await mkdir(target);
  const files = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const name = prefix + entry.name;
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('Linked stage content is not supported: ' + name);
    if (info.isDirectory()) files.push(...(await copyStage(from, to, name + '/')));
    else if (info.isFile()) {
      await copyFile(from, to);
      const bytes = await readFile(to);
      files.push({ name, bytes: bytes.length, sha256: digest(bytes) });
    } else throw new Error('Unsupported stage content: ' + name);
  }
  return files;
}

// Explicitly opt-in: launches a visible, isolated desktop and a real provider.
// Recording is continuous application content, without OS dialogs or audio.
// Only the native picker destination is automated. No service replies are mocked.
export async function startDemo(outputDirectory) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.resolve(outputDirectory);
  await prepareOutput(root, output);
  await mkdir(path.join(output, 'design'));
  await mkdir(path.join(output, 'raw-video'));
  const originals = {};
  for (const ext of ['kicad_pro', 'kicad_sch', 'kicad_pcb']) {
    const name = 'examples/lm25017-wson8-flybuck/lm25017-wson8-flybuck.' + ext;
    originals[name] = digest(await readFile(path.join(root, name)));
  }
  const started = Date.now();
  await writeFile(
    path.join(output, 'original-checksums.json'),
    json({
      capturedAt: new Date(started).toISOString(),
      algorithm: 'sha256',
      files: originals,
    }),
  );
  const destination = path.join(output, 'design', 'lm25017-8v.kicad_pro');
  const videoPath = path.join(output, '01-lm25017-8v-full.webm');
  const events = [],
    errors = [],
    prompts = [];
  let app,
    page,
    video,
    closed = false,
    finishing,
    transcriptTimer;
  let latestTranscript = '',
    transcriptWrite = Promise.resolve(),
    transcriptReading;
  const mark = async (stage, detail = '') => {
    events.push({
      stage,
      detail,
      elapsedSeconds: (Date.now() - started) / 1000,
      at: new Date().toISOString(),
    });
    await writeFile(path.join(output, 'chapters.json'), json(events));
    console.log(stage);
  };
  const refreshTranscript = () => {
    if (transcriptReading) return transcriptReading;
    if (!page || page.isClosed()) return Promise.resolve();
    transcriptReading = (async () => {
      try {
        const transcript = page.locator('.chat-transcript');
        if (!(await transcript.count())) return;
        const text = await transcript.innerText({ timeout: 1000 });
        if (text === latestTranscript) return;
        latestTranscript = text;
        transcriptWrite = transcriptWrite.then(() =>
          writeFile(path.join(output, 'conversation.txt'), text),
        );
        await transcriptWrite;
      } finally {
        transcriptReading = undefined;
      }
    })();
    return transcriptReading;
  };
  const capture = async (name) => {
    if (!page || page.isClosed()) return;
    await refreshTranscript();
    await page.screenshot({ path: path.join(output, name + '.png') });
  };
  const status = async ({ short = false } = {}) => {
    if (!page || page.isClosed()) return { busy: false, closed: true, errors: [...errors] };
    await refreshTranscript();
    return {
      busy: (await page.getByRole('button', { name: 'Stop generation', exact: true }).count()) > 0,
      closed,
      ...(!short ? { messages: latestTranscript } : {}),
      pendingReviews: await page.locator('.agent-tool-call[data-tool-status="review"]').count(),
      errors: [...errors],
    };
  };
  const waitForAgent = async (stage = 'Agent turn settled') => {
    while (true) {
      const current = await status({ short: true });
      if (current.closed) throw new Error('OpenPE closed while waiting for the Agent.');
      if (!current.busy) {
        await mark(stage);
        return status();
      }
      await delay(500);
    }
  };
  const send = async (stage, prompt) => {
    if ((await status({ short: true })).busy) await waitForAgent('Previous Agent turn settled');
    await mark(stage, prompt);
    prompts.push({ stage, prompt, at: new Date().toISOString() });
    await writeFile(path.join(output, 'prompts.json'), json(prompts));
    await page.getByRole('textbox', { name: 'Message your agent', exact: true }).fill(prompt);
    await delay(1000);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  const checkpoint = async (name) => {
    await capture(name);
    await mark(name);
  };
  const snapshot = async (stage) => {
    const name = String(stage)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    if (!name) throw new Error('A stage name must contain a letter or number.');
    const stageRoot = path.join(output, 'stages');
    const stageDirectory = path.join(stageRoot, name);
    await mkdir(stageRoot, { recursive: true });
    const existing = await lstat(stageDirectory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) throw new Error('Stage already exists: ' + name);
    await waitForAgent('Agent settled before stage Save');
    const saved = page.getByRole('status').filter({ hasText: /^Save project$/ });
    // Require a fresh Save success, including when the design was already clean.
    await saved.waitFor({ state: 'hidden', timeout: 10000 });
    await fileMenuAction(page, 'Save');
    await saved.waitFor({ state: 'visible' });
    await waitForAsync(page, () => {
      const active = document.querySelector('.project-navigation [aria-current="page"]');
      return Boolean(active) && !active.getAttribute('aria-label')?.includes('Unsaved changes');
    });
    const files = await copyStage(path.dirname(destination), stageDirectory);
    const project = projectFromNativeFiles(
      await nativeProject.readNativeProject(path.join(stageDirectory, path.basename(destination))),
    );
    const evidence = {
      stage,
      capturedAt: new Date().toISOString(),
      source: destination,
      directory: stageDirectory,
      files,
      schematics: [project.schematic, ...(project.additionalSchematics ?? [])].map((schematic) => ({
        id: schematic.id,
        title: schematic.title,
        parts: schematic.parts.map((part) => ({
          id: part.id,
          ref: part.ref,
          value: part.value,
          libId: part.libId,
        })),
        wires: schematic.wires,
        labels: schematic.labels,
        junctions: schematic.junctions,
      })),
    };
    await writeFile(path.join(stageRoot, name + '.evidence.json'), json(evidence));
    await checkpoint(name);
    return evidence;
  };
  const finish = (outcome = 'completed') =>
    (finishing ??= (async () => {
      clearInterval(transcriptTimer);
      const finalizationErrors = [];
      try {
        await capture('99-final');
      } catch (error) {
        finalizationErrors.push(error.message);
      }
      await transcriptWrite.catch((error) => finalizationErrors.push(error.message));
      await writeFile(path.join(output, 'conversation.txt'), latestTranscript);
      await mark('Recording ended', outcome);
      const unchanged = {};
      for (const [name, checksum] of Object.entries(originals)) {
        try {
          unchanged[name] = checksum === digest(await readFile(path.join(root, name)));
        } catch (error) {
          unchanged[name] = null;
          finalizationErrors.push(name + ': ' + error.message);
        }
      }
      const report = {
        outcome,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date().toISOString(),
        capture:
          'Continuous OpenPE renderer; native dialogs, other windows and audio are not captured.',
        dimensions: [1600, 1000],
        fps: 25,
        destination,
        originalFilesUnchanged: unchanged,
        originalChecksums: originals,
        errors,
        finalizationErrors,
        transcript: page?.isClosed()
          ? 'Latest transcript captured before the window closed.'
          : 'Final visible transcript.',
        video: { path: videoPath, saved: false },
      };
      await writeFile(path.join(output, 'recording-report.json'), json(report));
      if (app && !closed) {
        try {
          await app.close();
        } catch (error) {
          finalizationErrors.push(error.message);
        }
      }
      if (video) {
        try {
          await video.saveAs(videoPath);
          report.video.saved = true;
        } catch (error) {
          finalizationErrors.push(error.message);
        }
      }
      report.endedAt = new Date().toISOString();
      await writeFile(path.join(output, 'recording-report.json'), json(report));
      return output;
    })());
  try {
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...process.env,
        OPENPE_TEST: '1',
        OPENPE_DATA_DIR: path.join(output, 'profile'),
        OPENPE_DEV_URL: '',
      },
      recordVideo: {
        dir: path.join(output, 'raw-video'),
        size: { width: 1600, height: 1000 },
        fps: 25,
      },
    });
    app.once('close', () => {
      closed = true;
    });
    page = await app.firstWindow();
    video = page.video();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (error) => errors.push(error.message));
    transcriptTimer = setInterval(() => {
      void refreshTranscript().catch(() => {});
    }, 500);
    transcriptTimer.unref();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1600, 1000);
      window.show();
    });
    await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
    await mark('Home');
    await delay(1500);
    await page.getByRole('button', { name: 'Open LM25017 Fly-Buck example', exact: true }).click();
    await page.getByTestId('schematic-canvas').waitFor();
    await mark('Original LM25017 Fly-Buck');
    await delay(2000);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await fileMenuAction(page, 'Save as');
    await page
      .getByRole('status')
      .filter({ hasText: /^Save project$/ })
      .waitFor();
    await mark('Saved demonstration copy', 'Native Save as; scripted picker destination.');
    await capture('01-original');
    const permissions = page.getByRole('combobox', { name: 'Agent permissions', exact: true });
    await permissions.click();
    await page.getByRole('option', { name: /^Auto-approve/ }).click();
    return { app, page, output, send, status, waitForAgent, snapshot, checkpoint, mark, finish };
  } catch (error) {
    errors.push(error.message);
    await finish('initialization-failed');
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--record'))
    throw new Error('Use --record to opt into desktop/provider/solver execution.');
  const output =
    process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ??
    'test-results/demos/lm25017-8v-' + new Date().toISOString().replaceAll(':', '-');
  const demo = await startDemo(output);
  let closed = false;
  demo.app.once('close', () => {
    closed = true;
  });
  let outcome = 'closed-by-user';
  try {
    if (process.argv.includes('--control')) {
      // Saved local automation steps, outside the product's renderer/Agent boundary.
      // Each step exports default async (demo) => JSON-serializable result.
      const control = path.join(demo.output, 'control');
      await mkdir(control);
      const completed = new Set();
      console.log('RECORDING_READY ' + demo.output);
      while (!closed) {
        const names = (await readdir(control))
          .filter((name) => /^\d+.*\.mjs$/.test(name))
          .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
        for (const name of names) {
          if (completed.has(name) || closed) continue;
          completed.add(name);
          try {
            const step = await import(pathToFileURL(path.join(control, name)).href);
            const result = await step.default(demo);
            await writeFile(path.join(control, name + '.result.json'), json(result ?? null));
            console.log('STEP_OK ' + name);
          } catch (error) {
            await writeFile(
              path.join(control, name + '.result.json'),
              json({ error: error.message }),
            );
            console.error('STEP_FAILED ' + name + ': ' + error.message);
            outcome = 'control-step-failed';
            throw error;
          }
        }
        if (!closed) await delay(500);
      }
    } else {
      console.log(
        'Recording live in ' + demo.output + '. Use the OpenPE window; close it to finish.',
      );
      if (!closed) await new Promise((resolve) => demo.app.once('close', resolve));
    }
  } catch (error) {
    if (outcome !== 'control-step-failed') outcome = 'recording-failed';
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    await demo.finish(outcome);
  }
}
