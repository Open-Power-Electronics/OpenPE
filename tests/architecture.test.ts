import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkArchitecture, collectDependencies } from '../scripts/check-architecture.mjs';

async function fixture(t: TestContext, files: Record<string, string>) {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'openpe-architecture-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(`${parent}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        allowJs: true,
        resolveJsonModule: true,
        paths: { '@/*': ['./*'], '@host/*': ['./server/*'] },
      },
    }),
  );
  for (const [file, source] of Object.entries(files)) {
    const filename = path.join(directory, file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }
  return checkArchitecture(directory);
}

test('architecture parser distinguishes executable dependencies, erased types and ordinary strings', () => {
  const result = collectDependencies(
    `
    import type { A } from './a';
    import { type B, type C } from './b';
    import { type D, value } from './c';
    export type { E } from './d';
    export { type F } from './e';
    export * from './f';
    import Legacy = require('./g');
    type Imported = import('./h').Type;
    const lazy = import('./i');
    const common = require('./j');
    const legacy = module.require('./k');
    const text = 'require("node:fs")';
    // import 'node:crypto';
  `,
    'lib/example.ts',
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.dependencies.map(({ specifier, typeOnly }) => [specifier, typeOnly]),
    [
      ['./a', true],
      ['./b', true],
      ['./c', false],
      ['./d', true],
      ['./e', true],
      ['./f', false],
      ['./g', false],
      ['./h', true],
      ['./i', false],
      ['./j', false],
      ['./k', false],
    ],
  );
});

test('renderer rejects Node/Electron imports and host modules through relative paths and tsconfig aliases', async (t) => {
  const result = await fixture(t, {
    'app/page.tsx':
      "import 'fs/promises'; import('node:crypto'); require('electron'); import '@host/service';",
    'components/Canvas.tsx': "export { start } from '../electron/main.cjs';",
    'server/service.ts': 'export const service = true;',
    'electron/main.cjs': 'exports.start = () => {};',
  });
  assert.equal(result.issues.filter((issue) => issue.code === 'platform').length, 3);
  assert.equal(result.issues.filter((issue) => issue.code === 'layer').length, 2);
});

test('Core, API and Context enforce different dependency directions, including type dependencies', async (t) => {
  const result = await fixture(t, {
    'api/contract.ts':
      "import type { Model } from '../lib/model'; import type { State } from '../core/state';",
    'core/state.ts': "import type { View } from '../components/View'; import 'react';",
    'context/capture.ts': "import '../core/state'; import '../server/service';",
    'components/View.tsx': 'export type View = string;',
    'lib/model.ts': 'export type Model = string;',
    'server/service.ts': 'export const service = true;',
  });
  assert.equal(result.issues.filter((issue) => issue.code === 'layer').length, 5);
  assert.ok(
    result.issues.some((issue) => issue.file === 'core/state.ts' && issue.code === 'framework'),
  );
});

test('transitive engine and Context dependencies cannot hide runtime adapters in a domain helper', async (t) => {
  const result = await fixture(t, {
    'core/state.ts': "import '../lib/helper';",
    'context/capture.ts': "import '../lib/helper';",
    'lib/helper.ts': "export * from './library-capabilities';",
    'lib/library-capabilities.ts': "import '../core/state'; import './bridge';",
    'lib/bridge.ts': 'export const api = () => {};',
  });
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === 'core-runtime' &&
        issue.message.includes('core/state.ts -> lib/helper.ts -> lib/library-capabilities.ts'),
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === 'context-runtime' &&
        issue.message.includes('lib/library-capabilities.ts -> core/state.ts'),
    ),
  );
});

test('Node-only template factory is allowed for tooling but cannot enter renderer dependencies', async (t) => {
  const allowed = await fixture(t, {
    'lib/default-examples.ts': "import { createHash } from 'node:crypto'; export { createHash };",
    'lib/project-validator.mjs': 'const text = \'require("node:fs")\'; export default () => text;',
    'lib/chat-sessions.ts': 'export type Message = { text: string };',
    'components/Chat.tsx': "import type { Message } from '../lib/chat-sessions';",
  });
  assert.deepEqual(allowed.issues, []);
  const forbidden = await fixture(t, {
    'app/page.tsx': "import '../lib/helper';",
    'lib/helper.ts': "export * from './default-examples';",
    'lib/default-examples.ts': "import 'node:crypto';",
    'lib/chat-sessions.ts': "import type { Message } from '@/components/Chat';",
    'components/Chat.tsx': 'export type Message = { text: string };',
  });
  assert.ok(forbidden.issues.some((issue) => issue.code === 'node-only'));
  assert.ok(
    forbidden.issues.some(
      (issue) => issue.file === 'lib/chat-sessions.ts' && issue.code === 'layer',
    ),
  );
});

test('type-only adapter references are erased while generated validator runtime imports are checked', async (t) => {
  const result = await fixture(t, {
    'core/state.ts':
      "import type { Adapter } from '../lib/library-capabilities'; import '../lib/project-validator.mjs';",
    'lib/library-capabilities.ts': "import 'react'; export type Adapter = string;",
    'lib/project-validator.mjs':
      "const text = 'require(\"fs\")'; export { text }; import 'node:fs';",
  });
  assert.ok(
    result.issues.some(
      (issue) => issue.file === 'lib/project-validator.mjs' && issue.code === 'platform',
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.code === 'core-runtime' && issue.message.includes('node:fs'),
    ),
  );
  assert.ok(!result.issues.some((issue) => issue.message.includes('react')));
});

test('nonliteral module loads, unresolved local imports and syntax errors fail visibly', async (t) => {
  const result = await fixture(t, {
    'lib/dynamic.ts': 'const destination = "node:fs"; import(destination); require(destination);',
    'core/missing.ts': "import '@/lib/absent';",
    'api/broken.ts': "import { from './bad';",
  });
  assert.equal(result.issues.filter((issue) => issue.code === 'static-dependency').length, 2);
  assert.ok(result.issues.some((issue) => issue.code === 'unresolved'));
  assert.ok(result.issues.some((issue) => issue.code === 'syntax'));
});

test('domain data assets and shared API imports preserve valid engine dependencies', async (t) => {
  const result = await fixture(t, {
    'api/capabilities.ts': 'export type Capability = string;',
    'core/state.ts':
      "import type { Capability } from '../api/capabilities'; import '../lib/model';",
    'context/capture.ts': "import '../lib/model';",
    'lib/model.ts': "import lock from '../resources/model-lock.json'; export const model = lock;",
    'resources/model-lock.json': '{}',
  });
  assert.deepEqual(result.issues, []);
});

test('service and Electron reject renderer and live engine/context source imports', async (t) => {
  const result = await fixture(t, {
    'server/leaks.mjs': `
      import '@/components/View';
      import('../core/state');
      require('../api/capabilities');
      export * from '../context/capture';
      import '../lib/model';
    `,
    'electron/main.cjs': "require('../app/page'); import('../core/state');",
    'components/View.tsx': 'export const View = true;',
    'core/state.ts': 'export const state = true;',
    'api/capabilities.ts': 'export const capability = true;',
    'context/capture.ts': 'export const capture = true;',
    'lib/model.ts': 'export const model = true;',
    'app/page.tsx': 'export const page = true;',
  });
  assert.equal(result.issues.filter((issue) => issue.code === 'layer').length, 7);
  assert.equal(result.issues.filter((issue) => issue.code === 'platform').length, 0);
});

test('hosts retain Node APIs, bounded runtime facades, pinned JSON and explicit native-writer/type forwards', async (t) => {
  const result = await fixture(t, {
    'electron/main.cjs': "require('electron'); require('node:fs'); import('../server/index.mjs');",
    'electron/native-project.cjs': "require('node:path'); exports.read = () => {};",
    'server/index.mjs':
      "import 'node:crypto'; import './project-format.mjs'; import './example-projects.mjs';",
    'server/example-projects.mjs':
      "import '../electron/native-project.cjs'; import metadata from '../resources/example-catalog/manifest.json' with { type: 'json' };",
    'server/project-format.mjs': 'export const parseProject = () => {}',
    'server/project-format.d.mts': 'export * from "../lib/project";',
    'plugins/spice-simulation/host/spice-format.mjs': 'export const spice = true;',
    'plugins/spice-simulation/host/spice-format.d.mts': 'export * from "../domain/spice";',
    'server/workspace-format.mjs': 'export const workspace = true;',
    'server/workspace-format.d.mts': 'export * from "../lib/workspace-state";',
    'lib/project.ts': 'export type Project = string;',
    'plugins/spice-simulation/domain/spice.ts': 'export type Result = string;',
    'lib/workspace-state.ts': 'export type Workspace = string;',
    'resources/example-catalog/manifest.json': '{}',
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    collectDependencies(
      'export * from "../lib/project";',
      'server/project-format.d.mts',
    ).dependencies.map((dependency) => dependency.typeOnly),
    [true],
  );
});

test('generated service facades cannot conceal live imports behind their declarations', async (t) => {
  const result = await fixture(t, {
    'server/index.mjs': "import './project-format.mjs';",
    'server/project-format.mjs': "export { state } from '../core/state';",
    'server/project-format.d.mts': 'export * from "../lib/project";',
    'server/new-format.d.mts': 'export * from "../lib/project";',
    'server/service.mjs': "import '../electron/main.cjs'; import 'react';",
    'electron/main.cjs': "require('electron');",
    'core/state.ts': 'export const state = true;',
    'lib/project.ts': 'export type Project = string;',
  });
  assert.ok(
    result.issues.some(
      (issue) => issue.file === 'server/project-format.mjs' && issue.code === 'layer',
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.file === 'server/new-format.d.mts' && issue.code === 'layer',
    ),
  );
  assert.ok(
    result.issues.some((issue) => issue.file === 'server/service.mjs' && issue.code === 'layer'),
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.file === 'server/service.mjs' && issue.code === 'framework',
    ),
  );
});
