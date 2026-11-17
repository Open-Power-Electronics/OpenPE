// Painted footprint-drag frames for EMC Flyback and LMR12010.
// Uses an isolated data directory. Does not replace the layout acceptance plan.
// node scripts/benchmark-footprint-drag-frames.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';

function ownedProcesses() {
  try {
    return execFileSync('pgrep', ['-fl', 'OpenPE'], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status === 1) return '';
    throw error;
  }
}

const owner = ownedProcesses()
  .split('\n')
  .filter((line) => /Electron|OpenPE\.app/.test(line) && !line.includes('Cursor Helper'))
  .join('\n');
if (owner) console.log(`Leaving existing OpenPE processes alone:\n${owner}`);

const boards = [
  ['emc-flyback', 'Open EMC Flyback example'],
  ['lmr12010', 'Open LMR12010 Buck example'],
];

function percentile(samples, fraction) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function summarize(samples) {
  if (!samples.length) return null;
  return {
    count: samples.length,
    p50: Number(percentile(samples, 0.5).toFixed(3)),
    p95: Number(percentile(samples, 0.95).toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3)),
  };
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function openBoard(page, label) {
  const home = page.getByRole('button', { name: 'Home', exact: true });
  if (await home.count()) await home.click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.locator('[data-layout-editor]').waitFor();
  await page.locator('[data-testid="layout-canvas"]').waitFor();
  await settle(page);
  await page.keyboard.press('Escape');
  await runCanvasAction(page, 'Fit board to canvas');
  await page.keyboard.press('Escape');
  await settle(page);
  await page.locator('[role="menu"], dialog[open]').waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
  await page.locator('[data-footprint-body]').first().waitFor();
  return page.locator('[data-testid="layout-canvas"]');
}

async function grabFootprint(page, canvas, preferredId) {
  const points = await canvas.evaluate((svg, preferredId) => {
    const canvasRect = svg.getBoundingClientRect();
    const found = [];
    for (const node of svg.querySelectorAll('[data-footprint-body]')) {
      const rect = node.getBoundingClientRect();
      const id = node.getAttribute('data-footprint-body');
      if (rect.width < 8 || rect.height < 8) continue;
      let chosen = null;
      for (let row = 1; row <= 3 && !chosen; row += 1)
        for (let column = 1; column <= 3; column += 1) {
          const clientX = rect.left + (rect.width * column) / 4;
          const clientY = rect.top + (rect.height * row) / 4;
          if (
            clientX < canvasRect.left + 4 ||
            clientY < canvasRect.top + 4 ||
            clientX > canvasRect.right - 4 ||
            clientY > canvasRect.bottom - 4
          )
            continue;
          const hit = document.elementFromPoint(clientX, clientY);
          if (hit?.closest('[data-pad-id], [data-layout-track-target], [data-via-type]')) continue;
          if (hit?.closest('[data-footprint-body]')?.getAttribute('data-footprint-body') !== id)
            continue;
          chosen = {
            id,
            x: clientX - canvasRect.left,
            y: clientY - canvasRect.top,
            clientX,
            clientY,
            area: rect.width * rect.height,
          };
          break;
        }
      if (chosen) found.push(chosen);
    }
    if (preferredId && !found.some((item) => item.id === preferredId)) {
      const node = svg.querySelector(`[data-footprint-body="${preferredId}"]`);
      const rect = node?.getBoundingClientRect();
      if (rect && rect.width >= 8 && rect.height >= 8) {
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        if (
          clientX > canvasRect.left + 4 &&
          clientY > canvasRect.top + 4 &&
          clientX < canvasRect.right - 4 &&
          clientY < canvasRect.bottom - 4
        )
          found.unshift({
            id: preferredId,
            x: clientX - canvasRect.left,
            y: clientY - canvasRect.top,
            clientX,
            clientY,
            area: rect.width * rect.height,
          });
      }
    }
    found.sort((left, right) => left.area - right.area);
    const preferred = found.find((item) => item.id === preferredId);
    const rest = found.filter((item) => item.id !== preferredId).slice(0, 8);
    return preferred ? [preferred, ...rest] : rest.slice(0, 8);
  }, preferredId);
  assert.ok(points.length, 'Fit board shows a footprint body.');
  for (const point of points) {
    await canvas.click({ position: { x: point.x, y: point.y } });
    await settle(page);
    const choice = page.getByRole('menu', { name: 'Choose layout object', exact: true });
    if (await choice.isVisible().catch(() => false)) {
      const item = choice.getByRole('menuitem').filter({ hasText: 'Footprint' });
      if (await item.count()) await item.first().click();
      else {
        await page.keyboard.press('Escape');
        continue;
      }
      await settle(page);
    }
    const selected = await page.evaluate(
      (id) => document.querySelector(`.layout-footprint.selected[data-selection-id="${id}"]`) !== null,
      point.id,
    );
    if (!selected) continue;
    return { id: point.id, x: point.clientX, y: point.clientY };
  }
  throw new Error('No rendered footprint could be selected.');
}

async function installFrameProbes(page, canvas) {
  await page.evaluate(() => {
    window.__openpeLayoutCommits = window.__openpeLayoutCommits ?? [];
    window.__openpeFrames = [];
    window.__openpeLongTasks = window.__openpeLongTasks ?? [];
    window.__openpeInput = window.__openpeInput ?? [];
    window.__openpePaint = [];
    if (window.__openpeFrame) cancelAnimationFrame(window.__openpeFrame);
    let previous = performance.now();
    const tick = (now) => {
      window.__openpeFrames.push({ dt: now - previous, at: now });
      previous = now;
      window.__openpeFrame = requestAnimationFrame(tick);
    };
    window.__openpeFrame = requestAnimationFrame(tick);
    if (!window.__openpeObservers) {
      window.__openpeObservers = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__openpeLongTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name !== 'pointermove' && entry.name !== 'pointerup' && entry.name !== 'pointerdown')
            continue;
          window.__openpeInput.push({
            name: entry.name,
            start: entry.startTime,
            duration: entry.duration,
            processingStart: entry.processingStart,
          });
        }
      }).observe({ type: 'event', durationThreshold: 16, buffered: false });
    }
  });
  await canvas.evaluate((svg) => {
    if (window.__openpePaintListener)
      window.__openpePaintCanvas?.removeEventListener('pointermove', window.__openpePaintListener, true);
    window.__openpePaintListener = () => {
      if (!window.__openpeGesture) return;
      const at = performance.now();
      requestAnimationFrame(() => window.__openpePaint.push(performance.now() - at));
    };
    window.__openpePaintCanvas = svg;
    svg.addEventListener('pointermove', window.__openpePaintListener, true);
  });
}

async function gesture(page, target, steps, stepX, stepY) {
  await page.evaluate(() => {
    window.__openpeLayoutCommits = [];
    window.__openpePaint = [];
    window.__openpeFootprintCommitMs = null;
    delete window.__openpeFootprintRelease;
    performance.clearMarks('openpe-footprint-release');
    performance.clearMarks('openpe-footprint-committed');
    window.__openpeGesture = false;
  });
  await page.mouse.move(target.x, target.y);
  const downAt = await page.evaluate(() => {
    window.__openpeGesture = true;
    return performance.now();
  });
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(target.x + step * stepX, target.y + step * stepY);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  const preview = page.locator('[data-footprint-drag-preview]');
  let attached = true;
  try {
    await preview.waitFor({ state: 'attached', timeout: 4_000 });
  } catch {
    attached = false;
  }
  const blocked = attached ? await preview.getAttribute('data-track-drag-blocked') : null;
  const constrained = attached ? await preview.getAttribute('data-track-drag-constrained') : null;
  await page.mouse.up();
  await settle(page);
  const finished = await page.evaluate(() => performance.now());
  const sample = await page.evaluate(
    ({ downAt, finished }) => {
      window.__openpeGesture = false;
      const frames = window.__openpeFrames
        .filter((frame) => frame.at >= downAt && frame.at <= finished)
        .map((frame) => frame.dt);
      const commits = (window.__openpeLayoutCommits ?? []).filter(
        (entry) => entry.at >= downAt && entry.at <= finished + 80,
      );
      const input = (window.__openpeInput ?? []).filter(
        (entry) => entry.start >= downAt && entry.start <= finished,
      );
      const tasks = (window.__openpeLongTasks ?? []).filter(
        (entry) => entry.start >= downAt && entry.start <= finished,
      );
      const release = performance.getEntriesByName('openpe-footprint-release').at(-1);
      const committed = performance.getEntriesByName('openpe-footprint-committed').at(-1);
      return {
        frames,
        commits: commits.map((entry) => entry.actualDuration),
        input: input.map((entry) => ({
          name: entry.name,
          duration: entry.duration,
          delay: entry.processingStart - entry.start,
        })),
        paint: [...(window.__openpePaint ?? [])],
        longTasks: tasks.map((entry) => entry.duration),
        releaseMs: window.__openpeFootprintCommitMs ?? null,
        markDelta:
          release && committed ? committed.startTime - release.startTime : null,
      };
    },
    { downAt, finished },
  );
  return { attached, blocked, constrained, sample };
}

function reportGesture(sample, attached, blocked, constrained) {
  const moves = sample.input.filter((entry) => entry.name === 'pointermove');
  return {
    attached,
    blocked: blocked === 'true',
    constrained: constrained === 'true',
    frames: summarize(sample.frames),
    droppedFrames: sample.frames.filter((frame) => frame > 33.3).length,
    inputToPaint: summarize(moves.map((entry) => entry.duration)),
    inputDelay: summarize(moves.map((entry) => entry.delay)),
    handlerToPaint: summarize(sample.paint),
    reactCommit: summarize(sample.commits),
    longTasks: sample.longTasks.map((duration) => Number(duration.toFixed(3))),
    releaseToCommitMs:
      sample.releaseMs === null || sample.releaseMs === undefined
        ? sample.markDelta === null
          ? null
          : Number(sample.markDelta.toFixed(3))
        : Number(sample.releaseMs.toFixed(3)),
  };
}

async function undoDrag(page) {
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  if (await undo.isEnabled()) {
    await undo.click();
    await settle(page);
  }
}

async function measureBoard(page, label, key) {
  await page.evaluate(() => {
    window.__openpeMeasureDrag = true;
    window.__openpeLayoutCommits = [];
  });
  const canvas = await openBoard(page, key);
  const preferred = {
    'emc-flyback': 'b76c59b2-998d-4334-a859-2056b50232ca',
    lmr12010: '4f756ebc-02a2-48a3-a033-740355f5eeab',
  };
  const target = await grabFootprint(page, canvas, preferred[label]);
  await installFrameProbes(page, canvas);
  let warmup;
  let free;
  let push;
  try {
    warmup = await gesture(page, target, 8, 6, 3);
    assert.equal(warmup.attached, true, `${label} warmup drag attached to ${target.id}.`);
    assert.equal(warmup.blocked, 'false', `${label} warmup drag stayed attached.`);
    assert.ok(
      warmup.sample.commits.length > 0,
      `${label} layout commit marks were recorded during the drag.`,
    );
    await undoDrag(page);
    free = await gesture(page, target, 6, 4, 2);
    if (free.attached) assert.equal(free.blocked, 'false', `${label} free drag stayed attached.`);
    await undoDrag(page);
    push = await gesture(page, target, 14, 12, 6);
    assert.equal(push.attached, true, `${label} push drag attached to ${target.id}.`);
    assert.equal(push.blocked, 'false', `${label} push drag stayed attached.`);
    await undoDrag(page);
  } finally {
    await undoDrag(page);
    await page.evaluate(() => {
      if (window.__openpeFrame) cancelAnimationFrame(window.__openpeFrame);
    });
  }
  return {
    label,
    footprintId: target.id,
    warmup: reportGesture(warmup.sample, warmup.attached, warmup.blocked, warmup.constrained),
    free: reportGesture(free.sample, free.attached, free.blocked, free.constrained),
    push: reportGesture(push.sample, push.attached, push.blocked, push.constrained),
  };
}

const profile = await mkdtemp(path.join(tmpdir(), 'openpe-footprint-drag-'));
const launched = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DEV_URL: '',
    OPENPE_DATA_DIR: profile,
  },
  timeout: 60_000,
});
const owned = launched.process()?.pid;
const reports = [];
try {
  const page = await launched.firstWindow();
  await launched.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ width: 1440, height: 900 });
    window.show();
  });
  page.setDefaultTimeout(60_000);
  await page.getByRole('button', { name: 'New project', exact: true }).waitFor();
  await page.addInitScript(() => {
    window.__openpeMeasureDrag = true;
    window.__openpeLayoutCommits = [];
  });
  await page.evaluate(async () => {
    const { base, token } = await window.openpe.connection();
    const headers = { 'X-OpenPE-Token': token, 'Content-Type': 'application/json' };
    const current = await (await fetch(`${base}/api/appearance`, { headers })).json();
    current.leftButtonDrag = 'drag-selected';
    const saved = await fetch(`${base}/api/appearance`, {
      method: 'POST',
      headers,
      body: JSON.stringify(current),
    });
    if (!saved.ok) throw new Error(await saved.text());
  });
  await page.reload();
  await page.getByRole('button', { name: 'New project', exact: true }).waitFor();
  const dragMode = await page.evaluate(async () => {
    const { base, token } = await window.openpe.connection();
    const current = await (
      await fetch(`${base}/api/appearance`, { headers: { 'X-OpenPE-Token': token } })
    ).json();
    return current.leftButtonDrag;
  });
  assert.equal(dragMode, 'drag-selected', 'Isolated appearance uses the default drag mode.');
  await page.evaluate(() => {
    window.__openpeMeasureDrag = true;
    window.__openpeLayoutCommits = [];
  });
  for (const [label, key] of boards) reports.push(await measureBoard(page, label, key));
  const report = { profile, reports };
  writeFileSync('/tmp/openpe-footprint-drag-frames.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (owned) {
    console.log(`Stopping owned Electron pid ${owned}.`);
    let closed = false;
    let failure = null;
    const pending = launched.close().then(
      () => {
        closed = true;
      },
      (error) => {
        closed = true;
        failure = error;
      },
    );
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    if (!closed) {
      try {
        process.kill(owned, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      await pending;
    } else if (failure) throw failure;
  }
  await rm(profile, { recursive: true, force: true });
}
