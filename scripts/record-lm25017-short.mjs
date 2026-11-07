import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDemo } from './record-lm25017-8v.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';

// Explicit opt-in. All design actions use the visible UI or the real Agent.
// No precomputed replacement values, provider replies or solver results.
if (!process.argv.includes('--record'))
  throw new Error('Use --record to launch the desktop/provider/solver.');
const output =
  process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ??
  'test-results/demos/lm25017-short-' + new Date().toISOString().replaceAll(':', '-');
const started = Date.now();
const deadline = started + 315_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const demo = await startDemo(output);
const { page } = demo;
let outcome = 'incomplete';
const stopRequested = async () => {
  try {
    await readFile(path.join(demo.output, 'stop-recording'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const waitWithinBudget = async () => {
  await delay(1500);
  while (true) {
    const state = await demo.status({ short: true });
    await writeFile(
      path.join(demo.output, 'progress.json'),
      JSON.stringify(
        {
          elapsedSeconds: (Date.now() - started) / 1000,
          ...state,
        },
        null,
        2,
      ),
    );
    if (await stopRequested()) return false;
    if (!state.busy) return true;
    if (Date.now() >= deadline) return false;
    await delay(1000);
  }
};
try {
  const canvas = page.getByTestId('schematic-canvas');
  for (const ref of ['R4', 'R5', 'R6', 'C5', 'C6']) {
    await page.getByTestId('symbol-hit-' + ref).click();
    await page.keyboard.press('Delete');
    await page.getByTestId('symbol-hit-' + ref).waitFor({ state: 'detached' });
    await delay(350);
  }
  // Home example feedback/ripple branches, identified from its native geometry.
  // Only pointer clicks and Delete mutate the copy; shared rails are retained.
  const branchWires = [
    '12f7d531-96d0-445d-a3c1-c7f1ffeb8a8b',
    '317bba60-0fac-442c-861e-0273ae63861f',
    '505db09e-da7a-4349-82a8-53af18686afd',
    '536495fb-66fa-4131-ad88-24c2be67c49e',
    '6c1b0dc5-ce6c-4000-88bc-2847fb8053aa',
    '7270f8f3-f17a-4a69-9626-cbeedb833702',
    '740ccdfe-e97f-4100-b162-47443778b7b2',
    '99b81826-20f3-4c4d-907c-8b658031d27a',
    'a0abe731-96a0-4dbd-ba70-e09a5e6b5273',
    'b5cfe0cf-49a6-4733-85dd-478cd728eb1c',
    'c4146c1a-1ca3-4438-9a94-76346eac8619',
    'e6a279ef-d568-4ad7-b822-fbec44b17e3b',
    'e7f9e678-162e-4e9d-9da1-e2c808d61fab',
    'e8e2dd1d-c181-42f0-b33b-f177dc9f8845',
  ];
  for (const id of branchWires) {
    const wire = canvas.locator(`[data-selection-id="${id}"]`);
    if (!(await wire.count())) continue;
    const point = await wire.evaluate((element) => {
      const box = element.querySelector('line').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press('Delete');
    await wire.waitFor({ state: 'detached', timeout: 2000 });
  }
  await page.getByTestId('symbol-hit-#PWR08').click({ force: true });
  await page.keyboard.press('Delete');
  await page.getByTestId('symbol-hit-#PWR08').waitFor({ state: 'detached' });
  await canvas.press('Space');
  await fileMenuAction(page, 'Save');
  await demo.checkpoint('02-five-parts-removed');
  await demo.send(
    'Round 1 — complete and simulate',
    'Complete R4/R5/R6/C5/C6 for 24 V in, 8 V primary ±1% at 100 Ω, output ripple <100 mVpp and FB ripple 25–50 mVpp. Use the datasheet, keep it readable, and verify with 5 ms SPICE.',
  );
  if (await waitWithinBudget()) {
    await demo.checkpoint('03-first-reply');
    if (Date.now() < deadline - 25_000) {
      await demo.send(
        'Round 2 — verify and finish',
        'Check the final values, output voltage and FB ripple. Adjust and rerun if needed, then save and summarize what passed.',
      );
      outcome = (await waitWithinBudget())
        ? 'two-turns-finished-needs-evidence-review'
        : 'time-budget-reached';
    } else outcome = 'first-turn-used-time-budget';
  } else outcome = 'time-budget-reached';
} catch (error) {
  outcome = 'recording-step-failed: ' + error.message;
  console.error(outcome);
} finally {
  if ((await demo.status({ short: true })).busy) {
    await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
    await delay(1500);
  }
  try {
    await fileMenuAction(page, 'Save');
    await delay(1200);
  } catch (error) {
    await demo.mark('Final Save failed', error.message);
  }
  await demo.finish(outcome);
  console.log('RECORDING_FINISHED ' + demo.output + ' ' + outcome);
}
