import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Opt-in: launches real desktop windows against isolated data, never user recovery.
const count = Number(process.argv[2] ?? 3);
const label = process.argv[3] ?? 'current';
assert.ok(Number.isInteger(count) && count >= 1 && count <= 5);
assert.match(label, /^[a-z0-9-]+$/);
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/desktop-startup-'));
const source = await readFile('tests/fixtures/reference/lm2596-to220-5-buck.json', 'utf8');
const results = [];
const round = (ms) => Math.round(ms * 10) / 10;
for (let sample = 1; sample <= count; sample++) {
  const profile = path.join(root, String(sample));
  await mkdir(profile);
  for (const mode of ['fresh', 'existing', 'recovery']) {
    const recoveryFile = path.join(profile, 'openpe-workspace-v2.json');
    if (mode === 'recovery') {
      const id = crypto.randomUUID(),
        sessionId = crypto.randomUUID();
      await writeFile(
        recoveryFile,
        JSON.stringify({
          version: 2,
          activeDocumentId: id,
          provider: 'codex',
          effort: 'low',
          approvalMode: 'review',
          models: {},
          documents: [
            {
              id,
              source,
              sourceDraft: null,
              dirty: false,
              filename: 'startup.kicad_pro',
              exampleKey: null,
              localExample: false,
              sessions: [{ id: sessionId, messages: [], draft: '' }],
              activeSessionId: sessionId,
            },
          ],
        }),
      );
    } else await rm(recoveryFile, { force: true });
    const start = performance.now();
    const application = await electron.launch({
      ...(process.env.OPENPE_EXECUTABLE
        ? { executablePath: process.env.OPENPE_EXECUTABLE, args: [] }
        : { args: ['.'] }),
      env: { ...process.env, OPENPE_TEST: '', OPENPE_DATA_DIR: profile, OPENPE_DEV_URL: '' },
      timeout: 90_000,
    });
    try {
      // Keep the packaged network path intact. Startup may detect installed CLIs,
      // but this check never submits an Agent request or runs a simulation.
      const page = await application.firstWindow({ timeout: 90_000 });
      const windowMs = round(performance.now() - start);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(90_000);
      await (
        mode === 'recovery'
          ? page.getByTestId('schematic-canvas')
          : page.getByRole('textbox', { name: 'Describe your circuit', exact: true })
      ).waitFor();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const readyMs = round(performance.now() - start);
      const clickStart = performance.now();
      await page
        .getByRole('button', { name: mode === 'recovery' ? 'Source' : 'New project', exact: true })
        .click();
      await (
        mode === 'recovery'
          ? page.getByRole('textbox', { name: 'Project file source', exact: true })
          : page.getByTestId('schematic-canvas')
      ).waitFor();
      const interactionMs = round(performance.now() - clickStart);
      const navigation = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        return {
          navigationMs: n.domContentLoadedEventEnd,
          paints: performance
            .getEntriesByType('paint')
            .map((p) => ({ name: p.name, ms: p.startTime })),
        };
      });
      // Startup ends without example I/O. Measure the first explicit example open separately.
      const exampleStart = performance.now();
      const opened = await page.evaluate(() =>
        window.openpe.openDefaultExample('example:reference-lm2596-to220-5-buck'),
      );
      const exampleOpenMs = round(performance.now() - exampleStart);
      assert.equal(JSON.parse(opened.source).format, 'openpe');
      await page.evaluate((fileId) => window.openpe.releaseFile(fileId), opened.fileId);
      assert.deepEqual(errors, []);
      const result = {
        mode,
        sample,
        windowMs,
        readyMs,
        interactionMs,
        exampleOpenMs,
        ...navigation,
      };
      results.push(result);
      console.log(JSON.stringify(result));
      if (process.env.OPENPE_STARTUP_HOLD === '1' && sample === count && mode === 'recovery') {
        console.log(
          'Desktop verification window remains open for 45 seconds for native inspection.',
        );
        await new Promise((resolve) => setTimeout(resolve, 45_000));
      }
    } finally {
      await application.close();
    }
  }
}
const median = (values) => {
  values.sort((a, b) => a - b);
  return round(
    (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2,
  );
};
const summary = Object.fromEntries(
  ['fresh', 'existing', 'recovery'].map((mode) => [
    mode,
    Object.fromEntries(
      ['windowMs', 'readyMs', 'interactionMs', 'exampleOpenMs'].map((metric) => [
        metric,
        median(results.filter((r) => r.mode === mode).map((r) => r[metric])),
      ]),
    ),
  ]),
);
await writeFile(
  `test-results/desktop-startup-${label}.json`,
  JSON.stringify({ profileRoot: root, results, summary }, null, 2),
);
console.log(JSON.stringify({ summary }));
