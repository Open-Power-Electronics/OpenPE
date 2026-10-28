// Opt-in desktop profiling. Uses an isolated profile and never submits Agent
// requests, runs solvers or touches the user's open projects/recovery.
// OPENPE_DEV_URL=http://127.0.0.1:3000 node scripts/benchmark-desktop-interaction.mjs [filter|all] [label]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const filter = process.argv[2] ?? 'all';
const label = process.argv[3] ?? 'current';
const cpuSampling = process.env.OPENPE_PROFILE_CPU !== '0';
assert.match(label, /^[a-z0-9-]+$/);
const home = JSON.parse(await readFile('resources/example-catalog/home-manifest.json', 'utf8'));
const catalog = [...home.recent, ...home.examples];
const examples = catalog.filter((entry) => filter === 'all' || entry.id.includes(filter));
assert.ok(examples.length, 'No matching Home example.');
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/desktop-interaction-'));
const application = await electron.launch({
  args: ['.'],
  env: { ...process.env, OPENPE_TEST: '1', OPENPE_DATA_DIR: profile },
  timeout: 90_000,
});
const reports = [];
try {
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.bringToFront();
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
  console.log('Isolated desktop ready.');
  const cdp = await page.context().newCDPSession(page);
  if (cpuSampling) await cdp.send('Profiler.enable');
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  for (const entry of examples) {
    if (reports.length) await page.getByRole('button', { name: 'Home', exact: true }).click();
    const start = performance.now();
    await page.getByRole('button', { name: `Open ${entry.title} example`, exact: true }).click();
    const canvas = page.getByTestId('schematic-canvas');
    await canvas.waitFor();
    console.log(`Opened ${entry.title}.`);
    await settle();
    const openMs = performance.now() - start;
    await page.getByTestId('symbol-hit-R1').click();
    await canvas.focus();
    await settle();
    await page.evaluate(() => {
      window.interactionTasks = [];
      window.interactionObserver?.disconnect();
      window.interactionObserver = new PerformanceObserver((list) => {
        window.interactionTasks.push(
          ...list.getEntries().map((item) => ({
            start: item.startTime,
            duration: item.duration,
          })),
        );
      });
      window.interactionObserver.observe({ entryTypes: ['longtask'] });
    });
    if (cpuSampling) await cdp.send('Profiler.start');
    const operations = [];
    for (const key of [
      'ArrowRight',
      'Control+z',
      'ArrowRight',
      'Control+z',
      'ArrowRight',
      'Control+z',
    ]) {
      if (key.startsWith('Arrow')) {
        await page.getByTestId('symbol-hit-R1').click();
        await canvas.focus();
        await settle();
      }
      const before = performance.now();
      await canvas.press(key);
      await settle();
      operations.push({ key, ms: performance.now() - before });
      console.log(JSON.stringify(operations.at(-1)));
      if (key.startsWith('Arrow'))
        await page.locator('.dirty-dot').first().waitFor({ timeout: 10_000 });
      else
        await page.waitForFunction(() => !document.querySelector('.dirty-dot'), null, {
          timeout: 10_000,
        });
    }
    for (let index = 0; index < 3; index++) {
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    }
    if (cpuSampling) {
      const { profile: cpu } = await cdp.send('Profiler.stop');
      await writeFile(
        `test-results/desktop-interaction-${label}-${entry.id}.cpuprofile`,
        JSON.stringify(cpu),
      );
    }
    await settle();
    const longTasks = await page.evaluate(() => window.interactionTasks);
    const nudgeTimes = operations
      .filter((operation) => operation.key.startsWith('Arrow'))
      .map((operation) => operation.ms)
      .sort((a, b) => a - b);
    const report = {
      id: entry.id,
      openMs,
      operations,
      nudgeMedianMs: nudgeTimes[1],
      longTasks,
      longestTaskMs: Math.max(0, ...longTasks.map((task) => task.duration)),
    };
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/desktop-interaction-${label}.json`,
    JSON.stringify(
      { profile, devUrl: process.env.OPENPE_DEV_URL ?? null, cpuSampling, reports },
      null,
      2,
    ),
  );
} catch (error) {
  const page = application.windows()[0];
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText()).slice(-6000));
    await page.screenshot({ path: `test-results/desktop-interaction-${label}-error.png` });
  }
  throw error;
} finally {
  await application.close();
}
