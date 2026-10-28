import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createEnclosureExport } = createRequire(import.meta.url)(
  '../electron/enclosure-export.cjs',
);

const step = Buffer.from(
  'ISO-10303-21;\nHEADER;\n' +
    '/* checked CAD */'.repeat(12) +
    '\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;',
);
test('native CAD export validates before the picker and writes only its selected STEP destination', async () => {
  let picks = 0;
  const writes: unknown[] = [];
  const exporter = createEnclosureExport({
    parseProject: (source: string) => {
      assert.equal(source, 'validated');
      return { name: '../Flyback' };
    },
    createStep: async () => step,
    showSaveDialog: async (options: { title: string; defaultPath: string }) => {
      assert.equal(options.title, 'Export model STEP');
      assert.equal(options.defaultPath, '.._Flyback-model.step');
      picks++;
      return { filePath: 'F:/selected/enclosure.step' };
    },
    atomicWrite: async (...args: unknown[]) => writes.push(args),
  });
  await assert.rejects(
    exporter({ source: 'validated', path: 'F:/renderer-chosen.step' }),
    /validated project source/,
  );
  assert.equal(picks, 0);
  assert.deepEqual(await exporter({ source: 'validated' }), { name: 'enclosure.step' });
  assert.deepEqual(writes, [['F:/selected/enclosure.step', step]]);
});

test('CAD failure and picker cancellation never write, and later retries remain available', async () => {
  let valid = false,
    cancel = true,
    writes = 0;
  const exporter = createEnclosureExport({
    parseProject: () => ({ name: 'Flyback' }),
    createStep: async () => (valid ? step : Buffer.from('not STEP')),
    showSaveDialog: async () => ({ canceled: cancel, filePath: 'F:/selected/enclosure.stp' }),
    atomicWrite: async () => {
      writes++;
    },
  });
  await assert.rejects(exporter({ source: 'validated' }), /CAD engine/);
  valid = true;
  assert.equal(await exporter({ source: 'validated' }), null);
  assert.equal(writes, 0);
  cancel = false;
  assert.deepEqual(await exporter({ source: 'validated' }), { name: 'enclosure.stp' });
  assert.equal(writes, 1);
});

test('CAD export rechecks its originating frame after generation and destination selection', async () => {
  for (const invalidAt of [2, 3]) {
    let checks = 0,
      writes = 0,
      picks = 0;
    const exporter = createEnclosureExport({
      parseProject: () => ({ name: 'Flyback' }),
      createStep: async () => step,
      showSaveDialog: async () => {
        picks++;
        return { filePath: 'F:/selected/enclosure.step' };
      },
      atomicWrite: async () => {
        writes++;
      },
    });
    await assert.rejects(
      exporter({ source: 'validated' }, () => {
        if (++checks === invalidAt) throw new Error('Unauthorized window.');
      }),
      /Unauthorized window/,
    );
    assert.equal(picks, invalidAt === 2 ? 0 : 1);
    assert.equal(writes, 0);
  }
});
