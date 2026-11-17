import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { checkDocumentation } from '../scripts/check-docs.mjs';

async function fixture(t: TestContext, files: Record<string, string>) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'documentation-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(`${parent}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'test' } }),
  );
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return checkDocumentation(directory, ['README.md']);
}

test('maintained documentation has consistent branding, local links and npm commands', async () => {
  const result = await checkDocumentation(path.resolve('.'));
  assert.deepEqual(result.issues, []);
});

test('documentation rejects retired branding and inconsistent case in visible copy', async (t) => {
  const retiredBrand = ['Open', 'EE'].join('');
  const result = await fixture(t, {
    'README.md': `# ${retiredBrand}\n\nUse OpenPe with [Openpe](https://example.invalid).\n\n![${retiredBrand} Home](assets/home.svg)\n\nOpenPE is the product name.`,
    'assets/home.svg': '<svg/>',
  });
  assert.deepEqual(
    result.issues.map((issue: { line: number }) => issue.line),
    [1, 3, 3, 5],
  );
  assert.ok(result.issues.every((issue: { message: string }) => issue.message.includes('OpenPE')));
});

test('documentation permits current identifiers and original source URLs in code and links', async (t) => {
  const result = await fixture(t, {
    'README.md':
      '# OpenPE\n\nUse `window.openpe`, `X-OpenPE-Token`, `OPENPE_DATA_DIR`, `OpenPE`, `openpe` and `spice-simulation@openpe`.\n\n[Source](https://openpe.invalid/OpenPE)\n\n```json\n{"format":"openpe","author":"OpenPE"}\n```',
  });
  assert.deepEqual(result.issues, []);
});

test('documentation resolves relative, root, encoded and reference links with heading anchors', async (t) => {
  const result = await fixture(t, {
    'README.md':
      '[Native](docs/Native%20Source.md#source--value)\n[Again][native]\n\n[native]: /docs/Native%20Source.md#source--value-1\n\n<img src="assets/mark.svg" />\n\n[Explicit](docs/Native%20Source.md#custom)\n`npm run test`',
    'docs/Native Source.md': '# Source & `Value`\n# Source & `Value`\n<a id="custom"></a>',
    'assets/mark.svg': '<svg/>',
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.links, 4);
});

test('documentation reports broken files, anchors, escaping paths and npm scripts', async (t) => {
  const result = await fixture(t, {
    'README.md':
      '[Missing](missing.md)\n[Anchor](target.md#removed)\n[Outside](../outside.md)\n`npm run removed`',
    'target.md': '# Current',
  });
  assert.equal(result.issues.length, 4);
  assert.deepEqual(
    result.issues.map((issue: { line: number }) => issue.line),
    [1, 2, 3, 4],
  );
});

test('documentation ignores external URLs and link examples inside code fences', async (t) => {
  const result = await fixture(t, {
    'README.md':
      '[Remote](https://example.invalid/page#heading)\n[Mail](mailto:example@example.invalid)\n```md\n[Example](missing.md)\n```',
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.links, 0);
});

test('documentation reads real HTML attributes and excludes tags from heading anchors', async (t) => {
  const result = await fixture(t, {
    'README.md':
      '[Heading](target.md#native-source)\n[Missing anchor](target.md#absent)\n\n<div data-src="missing.png" title="src=missing.png"></div>\n\n<!-- <img src="missing.png"> -->\n\n<img src="assets/mark.svg">\n\n`npm run test.missing`',
    'target.md':
      '# Native <code>Source</code>\n\n<div data-id="absent"></div>\n\n<!-- <a id="absent"></a> -->',
    'assets/mark.svg': '<svg/>',
  });
  assert.equal(result.links, 3);
  assert.deepEqual(
    result.issues.map((issue: { message: string }) => issue.message),
    [
      'Invalid local link "target.md#absent": Heading or explicit anchor is missing.',
      'Unknown npm script: test.missing',
    ],
  );
});
