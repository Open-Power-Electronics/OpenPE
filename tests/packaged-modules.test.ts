import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeSpecifiers,
  optionalDependencyApplies,
  packagedHost,
} from '../scripts/check-packaged-modules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('packaged module hosts are explicit for macOS arm64, Windows x64 and Linux x64', () => {
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
  assert.equal(packagedHost('darwin', 'arm64').canvas, '@napi-rs/canvas-darwin-arm64');
  assert.equal(packagedHost('win32', 'x64').canvas, '@napi-rs/canvas-win32-x64-msvc');
  assert.equal(
    packagedHost('linux', 'x64').executable,
    path.join(root, 'release/linux-unpacked/openpe'),
  );
  assert.equal(
    packagedHost('linux', 'x64').resources,
    path.join(root, 'release/linux-unpacked/resources'),
  );
  assert.equal(packagedHost('linux', 'x64').canvas, '@napi-rs/canvas-linux-x64-gnu');
  assert.throws(() => packagedHost('linux', 'arm64'), /Unsupported package host/);
});

test('Linux package checks require the GNU native canvas binding', () => {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(
    optionalDependencyApplies('@napi-rs/canvas-linux-x64-gnu', lock, 'linux', 'x64'),
    true,
  );
  assert.equal(
    optionalDependencyApplies('@napi-rs/canvas-linux-x64-musl', lock, 'linux', 'x64'),
    false,
  );
});

test('service specifier scan detects literal dependencies and ignores bundled ajv source strings', () => {
  const sample = `
    import express from 'express';
    const sdk = await import('occt-import-js');
    require.resolve('occt-import-js');
    const code = 'require("ajv/dist/runtime/equal").default';
    await import('./agent-acp.mjs');
  `;
  const specifiers = collectRuntimeSpecifiers(sample, 'agent.mjs', { dynamicImports: true });
  assert.deepEqual(specifiers.imported, ['express', 'occt-import-js', './agent-acp.mjs']);
  assert.deepEqual(specifiers.resolved, ['occt-import-js']);
  assert.deepEqual(specifiers.required, []);
  const generated = readFileSync(path.join(root, 'server', 'project-format.mjs'), 'utf8');
  const format = collectRuntimeSpecifiers(generated, 'project-format.mjs', {
    dynamicImports: true,
  });
  assert.equal(
    [...format.imported, ...format.required, ...format.resolved].some((specifier) =>
      specifier.startsWith('ajv'),
    ),
    false,
  );
});

test('Cursor SDK is external to the desktop package and dependency lock', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(Object.hasOwn(app.dependencies, '@cursor/sdk'), false);
  assert.equal(
    Object.keys(lock.packages).some((name) => name.includes('/@cursor/sdk')),
    false,
  );
  assert.equal(
    app.build.asarUnpack.some((name: string) => name.includes('@cursor/sdk')),
    false,
  );
});
