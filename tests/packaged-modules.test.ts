import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectRuntimeSpecifiers, packagedHost } from '../scripts/check-packaged-modules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('packaged module hosts are explicit for macOS arm64 and Windows x64', () => {
  assert.equal(
    packagedHost('darwin', 'arm64').executable,
    path.join(root, 'release', 'mac-arm64', 'OpenPE.app', 'Contents', 'MacOS', 'OpenPE'),
  );
  assert.equal(
    packagedHost('darwin', 'arm64').resources,
    path.join(root, 'release', 'mac-arm64', 'OpenPE.app', 'Contents', 'Resources'),
  );
  assert.equal(
    packagedHost('win32', 'x64').executable,
    path.join(root, 'release', 'win-unpacked', 'OpenPE.exe'),
  );
  assert.equal(
    packagedHost('win32', 'x64').resources,
    path.join(root, 'release', 'win-unpacked', 'resources'),
  );
  assert.equal(packagedHost('darwin', 'arm64').cursor, '@cursor/sdk-darwin-arm64');
  assert.equal(packagedHost('win32', 'x64').cursor, '@cursor/sdk-win32-x64');
  assert.equal(packagedHost('darwin', 'arm64').canvas, '@napi-rs/canvas-darwin-arm64');
  assert.equal(packagedHost('win32', 'x64').canvas, '@napi-rs/canvas-win32-x64-msvc');
  assert.throws(() => packagedHost('linux', 'x64'), /Windows x64 and macOS arm64/);
});

test('Cursor SDK static imports include zod subpaths and skip the Bun sqlite loader', () => {
  const source = readFileSync(
    path.join(root, 'node_modules', '@cursor', 'sdk', 'dist', 'esm', 'index.js'),
    'utf8',
  );
  const closed = collectRuntimeSpecifiers(source, 'index.js', { dynamicImports: false });
  for (const specifier of ['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini', '@bufbuild/protobuf', '@connectrpc/connect'])
    assert.equal(closed.imported.includes(specifier), true, specifier);
  assert.equal([...closed.imported, ...closed.required, ...closed.resolved].includes('bun:sqlite'), false);
  assert.equal(source.includes('import("bun:sqlite")'), true);
});

test('service specifier scan keeps Cursor and ignores bundled ajv source strings', () => {
  const sample = `
    import express from 'express';
    const sdk = await import('@cursor/sdk');
    require.resolve('@cursor/sdk');
    const code = 'require("ajv/dist/runtime/equal").default';
    await import('./agent-acp.mjs');
  `;
  const specifiers = collectRuntimeSpecifiers(sample, 'agent.mjs', { dynamicImports: true });
  assert.deepEqual(specifiers.imported, ['express', '@cursor/sdk', './agent-acp.mjs']);
  assert.deepEqual(specifiers.resolved, ['@cursor/sdk']);
  assert.deepEqual(specifiers.required, []);
  const generated = readFileSync(path.join(root, 'server', 'project-format.mjs'), 'utf8');
  const format = collectRuntimeSpecifiers(generated, 'project-format.mjs', { dynamicImports: true });
  assert.equal(
    [...format.imported, ...format.required, ...format.resolved].some((specifier) =>
      specifier.startsWith('ajv'),
    ),
    false,
  );
});

test('zod dependency satisfies the Cursor SDK peer range', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sdk = JSON.parse(
    readFileSync(path.join(root, 'node_modules', '@cursor', 'sdk', 'package.json'), 'utf8'),
  );
  const installed = JSON.parse(readFileSync(path.join(root, 'node_modules', 'zod', 'package.json'), 'utf8'));
  assert.equal(sdk.peerDependencies.zod, '^3.25.0 || ^4.0.0');
  assert.equal(sdk.peerDependenciesMeta?.zod?.optional, undefined);
  assert.equal(app.dependencies.zod, '^4.6.7');
  assert.equal(installed.version, '4.6.7');
  assert.equal(typeof installed.exports['./v4'].import, 'string');
  assert.equal(typeof installed.exports['./v4-mini'].import, 'string');
});
