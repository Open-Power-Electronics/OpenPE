import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { gridSpacingOptions } from '../lib/schematic-layers';
import { layoutGridSpacingOptions } from '../lib/layout-grid';
import { leftButtonDragOptions } from '../lib/selection-drag';
import {
  defaultAppearance,
  parseAppearance,
  textSizeOptions,
  sourceWhitespaceOptions,
  validateAppearance,
  appearanceVariables,
  appearanceSizes,
  activeProfile,
  smartPunctuationEdit,
} from '../lib/appearance';

test('appearance persists across service origins without creating or changing project recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-appearance-'));
  let server = await startServer({ dataDir: dir });
  const request = (body?: unknown, origin?: string) =>
    fetch(server.base + '/api/appearance', {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-OpenPE-Token': server.token,
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.deepEqual(await (await request()).json(), defaultAppearance);
    assert.equal((await readdir(dir)).includes('appearance-v1.json'), false);
    assert.equal((await readdir(dir)).includes('openpe-workspace-v2.json'), false);
    assert.equal((await fetch(server.base + '/api/appearance')).status, 401);
    assert.equal((await request(defaultAppearance, 'https://example.com')).status, 403);
    const recovery = '{preserved recovery}';
    await writeFile(path.join(dir, 'openpe-workspace-v2.json'), recovery);
    const chosen = {
      ...structuredClone(defaultAppearance),
      theme: 'dark',
      textSize: 'large',
      motion: 'reduced',
      sourceWhitespace: 'rainbow',
      gridSpacing: 5,
      modelGridSpacing: 10,
      schematicLayers: {
        ...defaultAppearance.schematicLayers,
        values: false,
        pinNumbers: false,
        grid: false,
      },
    };
    for (const { value: textSize } of textSizeOptions) {
      const settings = { ...chosen, textSize };
      assert.equal((await request(settings)).status, 200);
      assert.deepEqual(await (await request()).json(), settings);
      assert.deepEqual(
        parseAppearance(await readFile(path.join(dir, 'appearance-v1.json'), 'utf8')),
        settings,
      );
    }
    for (const { value: sourceWhitespace } of sourceWhitespaceOptions) {
      const settings = { ...chosen, sourceWhitespace };
      assert.equal((await request(settings)).status, 200);
      assert.deepEqual(await (await request()).json(), settings);
    }
    for (const { value: leftButtonDrag } of leftButtonDragOptions) {
      const settings = { ...chosen, leftButtonDrag };
      assert.equal((await request(settings)).status, 200);
      assert.deepEqual(await (await request()).json(), settings);
    }
    for (const gridSpacing of gridSpacingOptions) {
      const settings = { ...chosen, gridSpacing };
      assert.equal((await request(settings)).status, 200);
      assert.deepEqual(await (await request()).json(), settings);
    }
    assert.equal((await request(chosen)).status, 200);
    for (const layoutGridSpacing of layoutGridSpacingOptions) {
      const settings = { ...chosen, layoutGridSpacing };
      assert.equal((await request(settings)).status, 200);
      assert.deepEqual(await (await request()).json(), settings);
      assert.deepEqual(
        parseAppearance(await readFile(path.join(dir, 'appearance-v1.json'), 'utf8')),
        settings,
      );
    }
    for (const modelGridSpacing of gridSpacingOptions) {
      const settings = { ...chosen, modelGridSpacing };
      assert.equal((await request(settings)).status, 200);
      assert.deepEqual(await (await request()).json(), settings);
      assert.deepEqual(
        parseAppearance(await readFile(path.join(dir, 'appearance-v1.json'), 'utf8')),
        settings,
      );
    }
    assert.equal((await request(chosen)).status, 200);
    const saved = await readFile(path.join(dir, 'appearance-v1.json'), 'utf8');
    for (const invalid of [
      ...[0, -2, 3, 100, '2', null, [2]].map((gridSpacing) => ({ ...chosen, gridSpacing })),
      ...[0, -2, 3, 100, '2', null, [2]].map((modelGridSpacing) => ({
        ...chosen,
        modelGridSpacing,
      })),
      ...[0, 0.01, 0.05, 0.6, 1.1, 2, '0.1', null, [0.1]].map((layoutGridSpacing) => ({
        ...chosen,
        layoutGridSpacing,
      })),
      { ...chosen, schematicLayers: { wires: 'hidden' } },
      { ...chosen, schematicLayers: { unknown: true } },
      { ...chosen, schematicLayers: null },
      { ...chosen, theme: ['dark'] },
      { ...chosen, theme: 'unknown' },
      { ...chosen, textSize: 'huge' },
      { ...chosen, textSize: 19 },
      { ...chosen, motion: 'fast' },
      { ...chosen, sourceWhitespace: 'unknown' },
      { ...chosen, leftButtonDrag: 'unknown' },
      { ...chosen, leftButtonDrag: null },
      { ...chosen, leftButtonDrag: ['select'] },
      { ...chosen, sourceWhitespace: null },
      { ...chosen, sourceWhitespace: ['rainbow'] },
      { ...chosen, sourceWhitespace: 'markers' },
      { ...chosen, sourceWhitespace: 'none' },
      { ...chosen, path: '../openpe-workspace-v2.json' },
      { ...chosen, uiSize: 21 },
      { ...chosen, contentSize: 11 },
      { ...chosen, codeSize: 14.5 },
      { ...chosen, contrast: 101 },
      { ...chosen, sidebarOpacity: 0 },
      { ...chosen, fullWidth: 'true' },
      {
        ...chosen,
        profiles: {
          ...chosen.profiles,
          shared: { ...chosen.profiles.shared, background: 'url(file:///secret)' },
        },
      },
      {
        ...chosen,
        profiles: {
          ...chosen.profiles,
          shared: { ...chosen.profiles.shared, uiFont: 'remote-font' },
        },
      },
      { ...chosen, profiles: { ...chosen.profiles, extra: {} } },
      {},
    ])
      assert.equal((await request(invalid)).status, 400);
    assert.equal(await readFile(path.join(dir, 'appearance-v1.json'), 'utf8'), saved);
    const originalBase = server.base;
    const restarted = await startServer({ dataDir: dir });
    server.close();
    server = restarted;
    assert.notEqual(server.base, originalBase);
    assert.deepEqual(await (await request()).json(), chosen);
    for (const retired of [
      { theme: 'dark', textSize: 'large', motion: 'reduced' },
      ...['markers', 'none'].map((sourceWhitespace) => ({ ...chosen, sourceWhitespace })),
      { ...chosen, layoutGridSpacing: 0.05 },
      ...Object.keys(defaultAppearance).map((missing) =>
        Object.fromEntries(Object.entries(chosen).filter(([key]) => key !== missing)),
      ),
    ]) {
      const oldText = JSON.stringify(retired);
      await writeFile(path.join(dir, 'appearance-v1.json'), oldText);
      assert.equal((await request()).status, 500);
      assert.equal(await readFile(path.join(dir, 'appearance-v1.json'), 'utf8'), oldText);
    }
    assert.equal(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8'), recovery);
    const customized = structuredClone(defaultAppearance);
    customized.separateModes = true;
    customized.uiSize = 18;
    customized.contentSize = 22;
    customized.codeSize = 16;
    customized.translucentSidebar = true;
    customized.sidebarOpacity = 70;
    customized.fullWidth = true;
    customized.smartPunctuation = true;
    customized.motion = 'full';
    customized.contrast = 75;
    customized.profiles.light = {
      ...customized.profiles.light,
      preset: 'paper',
      uiFont: 'technical',
      contentStyle: 'italic',
    };
    customized.profiles.dark = {
      ...customized.profiles.dark,
      background: '#181b22',
      foreground: '#eeeeee',
      accent: '#88aaff',
      codeFont: 'consolas',
      codeStyle: 'medium',
    };
    assert.equal((await request(customized)).status, 200);
    const nextServer = await startServer({ dataDir: dir });
    server.close();
    server = nextServer;
    assert.deepEqual(await (await request()).json(), customized);
    assert.equal(await readFile(path.join(dir, 'openpe-workspace-v2.json'), 'utf8'), recovery);
    await writeFile(path.join(dir, 'appearance-v1.json'), '{broken');
    assert.equal((await request()).status, 500);
    assert.equal(await readFile(path.join(dir, 'appearance-v1.json'), 'utf8'), '{broken');
  } finally {
    server.close();
  }
});

test('appearance profiles, independent typography and reset produce isolated style variables', () => {
  const a = structuredClone(defaultAppearance);
  assert.deepEqual(appearanceSizes(a), { ui: 15, content: 15, code: 14 });
  a.textSize = 'large';
  assert.deepEqual(appearanceSizes(a), { ui: 17, content: 17, code: 16 });
  a.uiSize = 13;
  a.contentSize = 24;
  a.codeSize = 18;
  a.separateModes = true;
  a.profiles.light = { ...a.profiles.light, preset: 'paper', uiFont: 'technical' };
  a.profiles.dark = {
    ...a.profiles.dark,
    background: '#121212',
    foreground: '#efefef',
    accent: '#66ccff',
    contentFont: 'serif',
    codeFont: 'courier',
    codeStyle: 'italic',
  };
  assert.equal(activeProfile(a, 'light').preset, 'paper');
  const light = appearanceVariables(a, 'light');
  const dark = appearanceVariables(a, 'dark');
  assert.equal(light['--surface'], '#faf7ef');
  assert.match(light['--ui-font'], /Bahnschrift/);
  assert.equal(dark['--surface'], '#121212');
  assert.equal(dark['--brand'], '#66ccff');
  assert.equal(dark['--font-step'], '-2px');
  assert.equal(dark['--content-size'], '24px');
  assert.equal(dark['--code-size'], '18px');
  assert.match(dark['--content-font'], /Georgia/);
  assert.match(dark['--code-font'], /Courier/);
  assert.equal(dark['--code-style'], 'italic');
  a.separateModes = false;
  assert.equal(appearanceVariables(a, 'dark')['--surface'], undefined);
  a.contrast = 100;
  assert.notEqual(
    appearanceVariables(a, 'dark')['--line'],
    appearanceVariables({ ...a, contrast: 10 }, 'dark')['--line'],
  );
  assert.equal(appearanceVariables(defaultAppearance, 'light')['--surface'], undefined);
  const restored = parseAppearance(JSON.stringify(a));
  assert.deepEqual(restored, a);
  restored.profiles.light.accent = '#ff0000';
  assert.equal(a.profiles.light.accent, null);
  for (const bad of [NaN, Infinity, -1, '16', 16.5])
    assert.throws(() => validateAppearance({ ...a, uiSize: bad }));
});

test('smart punctuation edits only the typed prose suffix and preserves numeric units and code', () => {
  for (const [input, expected] of [
    ['Wait...', 'Wait…'],
    ['Input ->', 'Input →'],
    ['Output <-', 'Output ←'],
    ['power--', 'power—'],
    ['"', '“'],
    ['“ready"', '“ready”'],
    ["don't", "don't"],
    ["don'", 'don’'],
    ['5"', '5"'],
    ["12'", "12'"],
    ['`x--', '`x--'],
    ['```\nx--', '```\nx--'],
    ['```x```\nWait...', '```x```\nWait…'],
  ])
    assert.deepEqual(smartPunctuationEdit(input, input.length), {
      value: expected,
      caret: expected.length,
    });
  assert.deepEqual(smartPunctuationEdit('Wait... here', 7), { value: 'Wait… here', caret: 5 });
});

test('appearance restoration rejects malformed storage instead of applying arbitrary styles', () => {
  assert.deepEqual(parseAppearance(null), defaultAppearance);
  assert.throws(() =>
    parseAppearance(JSON.stringify({ theme: 'light', textSize: 'standard', motion: 'system' })),
  );
  for (const textSize of ['standard', 'large']) {
    const saved = { ...defaultAppearance, textSize };
    assert.deepEqual(
      parseAppearance(JSON.stringify(saved)),
      saved,
      'Existing text-size preferences keep their original meaning.',
    );
  }
  for (const raw of [
    '{',
    'null',
    '[]',
    '{"theme":"dark"}',
    JSON.stringify({ ...defaultAppearance, theme: ['dark'] }),
  ]) {
    assert.throws(() => parseAppearance(raw));
  }
});
