import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const staticDirectoryDeclaration = "    staticDir: path.join(__dirname, '../out'),";
const rendererFS = Object.freeze({ lstat, realpath, readdir, readFile, open });
const rendererConcurrency = 4;
const rendererByteLimit = 256 * 1024 * 1024;

// Results/errors retain input order. A failed file stops later claims, while
// every already-started operation settles before a caller can retry. Directory
// metadata batches retain errors until their DFS position is visited.
async function rendererWork(items, operation, stopOnError = true) {
  const outcomes = new Array(items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      try {
        outcomes[index] = { ok: true, value: await operation(items[index], index) };
      } catch (error) {
        outcomes[index] = { ok: false, error };
        if (stopOnError) stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(rendererConcurrency, items.length) }, worker));
  return outcomes;
}

function rendererWorkValues(outcomes) {
  const failure = outcomes.find((outcome) => outcome?.ok === false);
  if (failure) throw failure.error;
  return outcomes.map((outcome) => outcome.value);
}

// Metadata reserves the complete allocation budget before reading. Repeat the
// path/type/size checks after queueing, bind the opened handle to that file, and
// read into exactly the reserved buffer. Growth cannot expand a readFile buffer;
// at most four constant one-byte probes exist beyond the admitted file bytes.
async function readRendererBytes(filename, name, expectedSize, io) {
  const metadata = await io.lstat(filename);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `Linked or unsupported renderer content is unsupported: ${name}`,
  );
  assert.equal(await io.realpath(filename), filename, `Linked renderer path: ${name}`);
  assert.equal(metadata.size, expectedSize, `Renderer file changed before reading: ${name}`);
  const handle = await io.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assert.ok(opened.isFile(), `Unsupported opened renderer content: ${name}`);
    assert.equal(opened.size, expectedSize, `Renderer file changed before allocation: ${name}`);
    assert.equal(opened.dev, metadata.dev, `Renderer file identity changed: ${name}`);
    assert.equal(opened.ino, metadata.ino, `Renderer file identity changed: ${name}`);
    assert.equal(await io.realpath(filename), filename, `Linked renderer path: ${name}`);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, offset);
      assert.ok(
        Number.isSafeInteger(bytesRead) && bytesRead > 0 && bytesRead <= expectedSize - offset,
        `Renderer file changed while reading: ${name}`,
      );
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(probe, 0, 1, expectedSize);
    assert.equal(bytesRead, 0, `Renderer file grew while reading: ${name}`);
    assert.equal(
      (await handle.stat()).size,
      expectedSize,
      `Renderer file changed while reading: ${name}`,
    );
    return bytes;
  } finally {
    await handle.close();
  }
}

async function retainedRendererSource(workspaceRoot, requested, io = rendererFS) {
  assert.ok(
    typeof requested === 'string' && requested.trim(),
    'Renderer snapshot must be a nonempty path.',
  );
  const sourceDirectory = path.resolve(workspaceRoot, requested);
  const segments = path.relative(workspaceRoot, sourceDirectory).split(path.sep);
  assert.ok(
    segments.length === 4 &&
      segments[0] === 'test-results' &&
      /^editor-experience-[a-zA-Z0-9_-]+$/.test(segments[1]) &&
      segments[2] === 'renderer' &&
      /^[12]$/.test(segments[3]),
    'Renderer snapshot must be a retained workspace/test-results/editor-experience-*/renderer/[1-2] directory.',
  );
  let current = workspaceRoot;
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    const metadata = await io.lstat(current);
    assert.ok(
      metadata.isDirectory() && !metadata.isSymbolicLink(),
      'Renderer snapshot ancestors cannot be links or non-directories.',
    );
    assert.equal(
      await io.realpath(current),
      current,
      'Renderer snapshot ancestors cannot contain links.',
    );
  }
  const sourceArtifactPath = path.join(
    workspaceRoot,
    ...segments.slice(0, 2),
    'renderer-artifact.json',
  );
  const metadata = await io.lstat(sourceArtifactPath);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 8 * 1024 * 1024,
    'Retained renderer artifact must be a bounded, unlinked file.',
  );
  assert.equal(
    await io.realpath(sourceArtifactPath),
    sourceArtifactPath,
    'Retained renderer artifact cannot contain links.',
  );
  const sourceArtifactBytes = await io.readFile(sourceArtifactPath);
  assert.equal(
    sourceArtifactBytes.length,
    metadata.size,
    'Retained renderer artifact changed while reading.',
  );
  const saved = JSON.parse(sourceArtifactBytes.toString('utf8'));
  assert.equal(
    saved.mode,
    'fixed-built-renderer',
    'Renderer source is not a retained built snapshot.',
  );
  assert.equal(
    saved.rendererPath,
    sourceDirectory,
    'Renderer source is not the retained accepted snapshot.',
  );
  assert.ok(
    saved.manifest && typeof saved.manifest.sha256 === 'string',
    'Retained renderer manifest is missing.',
  );
  return {
    sourceDirectory,
    sourceKind: 'retained-renderer-snapshot',
    sourceArtifactPath,
    sourceArtifactSha256: digest(sourceArtifactBytes),
    retainedManifest: saved.manifest,
  };
}

// A private benchmark copy is retained as evidence. Never delete or rewrite out.
export function rendererManifest(directory) {
  return inspectRendererManifest(directory, rendererFS);
}

async function inspectRendererManifest(directory, io) {
  const root = path.resolve(directory);
  assert.equal(await io.realpath(root), root, 'Renderer directories cannot contain links.');
  assert.ok((await io.lstat(root)).isDirectory());
  const admitted = [];
  let totalBytes = 0;
  const visit = async (relative) => {
    const directoryPath = path.join(root, relative);
    if (relative) {
      // A sibling may wait behind an earlier DFS subtree after its metadata
      // batch. Recheck it immediately before following the directory.
      const current = await io.lstat(directoryPath);
      assert.ok(
        current.isDirectory() && !current.isSymbolicLink(),
        `Linked renderer directory: ${relative}`,
      );
      assert.equal(
        await io.realpath(directoryPath),
        directoryPath,
        `Linked renderer path: ${relative}`,
      );
    }
    const entries = await io.readdir(directoryPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    // Drain the parent batch before recursion, so nested directories cannot
    // multiply the fixed four-operation limit or retain semaphore permits.
    for (let start = 0; start < entries.length; start += rendererConcurrency) {
      const metadataResults = await rendererWork(
        entries.slice(start, start + rendererConcurrency),
        async (entry) => {
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          const filename = path.join(root, name);
          const metadata = await io.lstat(filename);
          assert.ok(!metadata.isSymbolicLink(), `Linked renderer content is unsupported: ${name}`);
          assert.equal(await io.realpath(filename), filename, `Linked renderer path: ${name}`);
          return { name, filename, metadata };
        },
        false,
      );
      for (const result of metadataResults) {
        if (!result.ok) throw result.error;
        const { name, metadata } = result.value;
        if (metadata.isDirectory()) await visit(name);
        else {
          assert.ok(metadata.isFile(), `Unsupported renderer entry: ${name}`);
          assert.ok(
            admitted.length < 10_000 &&
              Number.isSafeInteger(metadata.size) &&
              metadata.size >= 0 &&
              metadata.size <= rendererByteLimit - totalBytes,
            'Renderer snapshot exceeds the benchmark evidence bounds.',
          );
          totalBytes += metadata.size;
          admitted.push({ name, bytes: metadata.size });
        }
      }
    }
  };
  let metadataFailure;
  try {
    await visit('');
  } catch (error) {
    metadataFailure = { error };
  }
  // Earlier admitted files still precede a later metadata failure in the old
  // DFS error order. No suffix is admitted/read after that failure position.
  const files = rendererWorkValues(
    await rendererWork(admitted, async (file) => {
      const bytes = await readRendererBytes(path.join(root, file.name), file.name, file.bytes, io);
      return { name: file.name, bytes: bytes.length, sha256: digest(bytes) };
    }),
  );
  if (metadataFailure) throw metadataFailure.error;
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { sha256: digest(JSON.stringify(files)), fileCount: files.length, totalBytes, files };
}

function validateInitialAssets(manifest, html) {
  const names = new Set(manifest.files.map((file) => file.name));
  assert.ok(names.has('index.html'), 'The built renderer must contain index.html.');
  for (const match of html.matchAll(/(?:src|href)=["'](\/_next\/[^"']+)["']/g)) {
    const name = decodeURIComponent(match[1].split(/[?#]/, 1)[0]).slice(1);
    assert.ok(names.has(name), `The copied renderer is missing an initial asset: ${name}`);
  }
}

export function fixedRendererLaunchSource({
  workspaceRoot,
  mainPath,
  mainSha256,
  rendererPath,
  profile,
  instanceNonce,
}) {
  return `// Benchmark-only adapter: original host modules, fixed private renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const originalMainPath = ${JSON.stringify(mainPath)};
const bytes = fs.readFileSync(originalMainPath);
assert.equal(createHash('sha256').update(bytes).digest('hex'), ${JSON.stringify(mainSha256)},
  'Original Electron main changed after artifact preparation.');
const original = bytes.toString('utf8');
const declaration = ${JSON.stringify(staticDirectoryDeclaration)};
assert.equal(original.split(declaration).length, 2, 'Expected exactly one static renderer directory.');
const source = original.replace(declaration, ${JSON.stringify(`    staticDir: ${JSON.stringify(rendererPath)},`)});
const host = new Module(originalMainPath, module);
host.filename = originalMainPath;
host.paths = Module._nodeModulePaths(path.dirname(originalMainPath));
host.id = '.';
Module._cache[originalMainPath] = host;
process.mainModule = host;
host.require('electron').app.setAppPath(${JSON.stringify(workspaceRoot)});
Object.defineProperty(globalThis, '__openpeBenchmarkIdentity', { value: Object.freeze({
  nonce: ${JSON.stringify(instanceNonce)}, pid: process.pid, ppid: process.ppid,
  mainPath: originalMainPath, workspaceRoot: ${JSON.stringify(workspaceRoot)},
  rendererPath: ${JSON.stringify(rendererPath)}, profile: ${JSON.stringify(profile)}
}), writable: false, configurable: false });
host._compile(source, originalMainPath);
host.loaded = true;
`;
}

export async function prepareRendererArtifact({
  workspaceRoot,
  profile,
  rendererSnapshot,
  copy = copyFile,
}) {
  // No cancellation API is added here. A caller timeout still leaves bounded
  // filesystem work draining; it must not be described as cancellation.
  const root = path.resolve(workspaceRoot);
  const source =
    rendererSnapshot === undefined
      ? { sourceDirectory: path.join(root, 'out'), sourceKind: 'current-built-output' }
      : await retainedRendererSource(root, rendererSnapshot);
  const { sourceDirectory, retainedManifest, ...sourceProvenance } = source;
  const mainPath = path.join(root, 'electron/main.cjs');
  const mainBytes = await readFile(mainPath);
  assert.equal(
    mainBytes.toString('utf8').split(staticDirectoryDeclaration).length,
    2,
    'The benchmark adapter requires the exact original staticDir declaration.',
  );
  const artifact = {
    mode: 'fixed-built-renderer',
    sourceDirectory,
    ...sourceProvenance,
    profile,
    instanceNonce: randomUUID(),
    mainPath,
    mainSha256: digest(mainBytes),
    mainSourcePath: path.join(profile, 'electron-main.original.cjs'),
    attempts: [],
    condition:
      'Original Electron main is compiled under its original filename and module paths. Only the loopback staticDir points at a private renderer snapshot; app path is restored to the workspace. Source and copied manifests must match before launch.',
  };
  await writeFile(artifact.mainSourcePath, mainBytes, { flag: 'wx' });
  const snapshotRoot = path.join(profile, 'renderer');
  await mkdir(snapshotRoot);
  let accepted;
  for (let index = 1; index <= 2; index++) {
    const rendererPath = path.join(snapshotRoot, String(index));
    const attempt = { index, rendererPath, status: 'preparing' };
    artifact.attempts.push(attempt);
    try {
      const before = await rendererManifest(sourceDirectory);
      if (retainedManifest)
        assert.deepEqual(
          before,
          retainedManifest,
          'Retained renderer source differs from its recorded full manifest.',
        );
      attempt.sourceBeforeSha256 = before.sha256;
      await mkdir(rendererPath);
      rendererWorkValues(
        await rendererWork(before.files, async (file) => {
          const sourceFile = path.join(sourceDirectory, file.name);
          assert.equal(
            await realpath(sourceFile),
            sourceFile,
            'Renderer copy cannot follow links.',
          );
          const metadata = await lstat(sourceFile);
          assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
          assert.equal(metadata.size, file.bytes, 'Renderer source changed before copy.');
          const destination = path.join(rendererPath, file.name);
          await mkdir(path.dirname(destination), { recursive: true });
          await copy(sourceFile, destination, constants.COPYFILE_EXCL);
        }),
      );
      const after = await rendererManifest(sourceDirectory);
      const copied = await rendererManifest(rendererPath);
      attempt.sourceAfterSha256 = after.sha256;
      attempt.copiedSha256 = copied.sha256;
      assert.equal(after.sha256, before.sha256, 'Renderer output changed during snapshot copy.');
      assert.equal(
        copied.sha256,
        before.sha256,
        'Renderer snapshot differs from its stable source.',
      );
      validateInitialAssets(copied, await readFile(path.join(rendererPath, 'index.html'), 'utf8'));
      accepted = copied;
      Object.assign(artifact, {
        rendererPath,
        manifest: copied,
        sourceManifestSha256: before.sha256,
      });
      attempt.status = 'verified';
      break;
    } catch (error) {
      Object.assign(attempt, { status: 'failed', error: error.message ?? String(error) });
    }
  }
  if (!accepted) {
    await writeFile(
      path.join(profile, 'renderer-artifact.json'),
      JSON.stringify(artifact, null, 2) + '\n',
    );
    throw new Error(
      `Could not obtain a stable built renderer in two attempts: ${artifact.attempts.map((attempt) => attempt.error).join('; ')}`,
    );
  }
  const launchPath = path.join(profile, 'launch.cjs');
  const launchSource = fixedRendererLaunchSource({ workspaceRoot: root, ...artifact });
  await writeFile(launchPath, launchSource, { flag: 'wx' });
  Object.assign(artifact, { launchPath, launchSha256: digest(launchSource) });
  await writeFile(
    path.join(profile, 'renderer-artifact.json'),
    JSON.stringify(artifact, null, 2) + '\n',
  );
  return artifact;
}

export async function verifyRendererArtifact(artifact) {
  const current = await rendererManifest(artifact.rendererPath);
  assert.equal(
    current.sha256,
    artifact.manifest.sha256,
    'The private renderer snapshot changed during the benchmark.',
  );
  assert.equal(
    digest(await readFile(artifact.launchPath)),
    artifact.launchSha256,
    'The benchmark launch adapter changed during the run.',
  );
  assert.equal(
    digest(await readFile(artifact.mainSourcePath)),
    artifact.mainSha256,
    'The retained original Electron main source changed during the run.',
  );
  return { unchanged: true, sha256: current.sha256, verifiedAt: new Date().toISOString() };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(path.resolve('test-results/renderer-artifact-test-'));
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(path.join(workspaceRoot, 'out/_next'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'electron'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'node_modules/electron'), { recursive: true });
  const mainPath = path.join(workspaceRoot, 'electron/main.cjs');
  await writeFile(
    mainPath,
    `const path = require('node:path');
const settings = {
${staticDirectoryDeclaration}
};
const local = require('./local.cjs');
import('./entry.mjs').then(value => console.log(JSON.stringify({directory:__dirname,
  appPath:global.artifactAppPath,local,imported:value.default,staticDir:settings.staticDir,
  main:require.main.filename,identity:global.__openpeBenchmarkIdentity})));
`,
  );
  await writeFile(path.join(workspaceRoot, 'electron/local.cjs'), 'module.exports = 41;');
  await writeFile(path.join(workspaceRoot, 'electron/entry.mjs'), 'export default 42;');
  await writeFile(
    path.join(workspaceRoot, 'node_modules/electron/index.js'),
    'module.exports = {app:{setAppPath(value){global.artifactAppPath=value}}};',
  );
  await writeFile(
    path.join(workspaceRoot, 'out/index.html'),
    '<script src="/_next/fixture.js"></script>',
  );
  const assetPath = path.join(workspaceRoot, 'out/_next/fixture.js');
  await writeFile(assetPath, 'initial');
  await mkdir(path.join(workspaceRoot, 'test-results'));
  const profile = await mkdtemp(
    path.join(workspaceRoot, 'test-results/editor-experience-retained-'),
  );
  const artifact = await prepareRendererArtifact({ workspaceRoot, profile });
  assert.equal(artifact.attempts.length, 1);
  assert.equal((await verifyRendererArtifact(artifact)).unchanged, true);
  const result = await promisify(execFile)(process.execPath, [artifact.launchPath], {
    cwd: workspaceRoot,
  });
  const executed = JSON.parse(result.stdout);
  assert.equal(executed.identity.nonce, artifact.instanceNonce);
  assert.equal(executed.identity.mainPath, mainPath);
  assert.equal(executed.identity.profile, profile);
  assert.ok(
    Number.isSafeInteger(executed.identity.pid) && Number.isSafeInteger(executed.identity.ppid),
  );
  delete executed.identity;
  assert.deepEqual(executed, {
    directory: path.join(workspaceRoot, 'electron'),
    appPath: workspaceRoot,
    local: 41,
    imported: 42,
    staticDir: artifact.rendererPath,
    main: mainPath,
  });
  await writeFile(assetPath, 'new output after snapshot');
  assert.equal((await verifyRendererArtifact(artifact)).unchanged, true);
  assert.equal(
    await readFile(path.join(artifact.rendererPath, '_next/fixture.js'), 'utf8'),
    'initial',
  );
  const replayProfile = await mkdtemp(path.join(root, 'replay-'));
  const replay = await prepareRendererArtifact({
    workspaceRoot,
    profile: replayProfile,
    rendererSnapshot: artifact.rendererPath,
  });
  assert.equal(replay.sourceKind, 'retained-renderer-snapshot');
  assert.equal(replay.sourceDirectory, artifact.rendererPath);
  assert.equal(replay.sourceManifestSha256, artifact.manifest.sha256);
  assert.deepEqual(replay.manifest, artifact.manifest);
  assert.equal(replay.mainPath, artifact.mainPath);
  assert.equal(replay.mainSha256, artifact.mainSha256);
  assert.equal(
    await readFile(path.join(replay.rendererPath, '_next/fixture.js'), 'utf8'),
    'initial',
  );
  assert.equal((await verifyRendererArtifact(replay)).unchanged, true);
  const retryProfile = await mkdtemp(
    path.join(workspaceRoot, 'test-results/editor-experience-retry-'),
  );
  let copied = 0;
  const retry = await prepareRendererArtifact({
    workspaceRoot,
    profile: retryProfile,
    copy: async (...args) => {
      await copyFile(...args);
      if (++copied === 1) await writeFile(assetPath, 'changed during first copy');
    },
  });
  assert.equal(retry.attempts.length, 2);
  assert.equal(retry.attempts[0].status, 'failed');
  assert.equal(retry.attempts[1].status, 'verified');
  const replayTwo = await prepareRendererArtifact({
    workspaceRoot,
    profile: await mkdtemp(path.join(root, 'replay-two-')),
    rendererSnapshot: path.relative(workspaceRoot, retry.rendererPath),
  });
  assert.equal(path.basename(retry.rendererPath), '2');
  assert.deepEqual(replayTwo.manifest, retry.manifest);
  for (const rendererSnapshot of [
    '',
    path.join(workspaceRoot, 'out'),
    path.join(root, 'test-results/editor-experience-outside/renderer/1'),
    path.join(workspaceRoot, 'test-results/other/renderer/1'),
    path.join(profile, 'renderer/3'),
    path.join(retryProfile, 'renderer/1'),
    path.join(artifact.rendererPath, '_next'),
    path.join(workspaceRoot, 'test-results/editor-experience-missing/renderer/1'),
  ])
    await assert.rejects(
      prepareRendererArtifact({
        workspaceRoot,
        profile: await mkdtemp(path.join(root, 'invalid-')),
        rendererSnapshot,
      }),
    );
  const missingRecord = path.join(
    workspaceRoot,
    'test-results/editor-experience-no-record/renderer/1',
  );
  await mkdir(missingRecord, { recursive: true });
  await assert.rejects(
    prepareRendererArtifact({
      workspaceRoot,
      profile: await mkdtemp(path.join(root, 'no-record-')),
      rendererSnapshot: missingRecord,
    }),
  );
  // Exercise exact guard branches without requiring OS link privileges.
  // All other snapshot/copy/hash tests use real filesystem observations.
  for (const linked of [
    workspaceRoot,
    path.join(workspaceRoot, 'test-results'),
    profile,
    path.join(profile, 'renderer'),
    artifact.rendererPath,
  ])
    await assert.rejects(
      retainedRendererSource(workspaceRoot, artifact.rendererPath, {
        ...rendererFS,
        lstat: (filename) =>
          filename === linked
            ? Promise.resolve({ isDirectory: () => true, isSymbolicLink: () => true })
            : lstat(filename),
      }),
      /links/,
    );
  await assert.rejects(
    retainedRendererSource(workspaceRoot, artifact.rendererPath, {
      ...rendererFS,
      realpath: (filename) =>
        filename === profile ? Promise.resolve(path.join(root, 'outside')) : realpath(filename),
    }),
    /links/,
  );
  const failedProfile = await mkdtemp(path.join(root, 'failed-'));
  let changes = 0;
  await assert.rejects(
    prepareRendererArtifact({
      workspaceRoot,
      profile: failedProfile,
      copy: async (...args) => {
        await copyFile(...args);
        await writeFile(assetPath, `racing ${changes++}`);
      },
    }),
    /stable built renderer in two attempts/,
  );
  await writeFile(path.join(artifact.rendererPath, '_next/fixture.js'), 'tampered snapshot');
  await assert.rejects(verifyRendererArtifact(artifact), /snapshot changed/);
  await assert.rejects(
    prepareRendererArtifact({
      workspaceRoot,
      profile: await mkdtemp(path.join(root, 'tampered-source-')),
      rendererSnapshot: artifact.rendererPath,
    }),
    /recorded full manifest/,
  );
  await assert.rejects(
    inspectRendererManifest(retry.rendererPath, {
      ...rendererFS,
      lstat: (filename) =>
        filename === path.join(retry.rendererPath, '_next/fixture.js')
          ? Promise.resolve({ isSymbolicLink: () => true })
          : lstat(filename),
    }),
    /Linked renderer/,
  );
  let oversizedReads = 0;
  await assert.rejects(
    inspectRendererManifest(retry.rendererPath, {
      ...rendererFS,
      lstat: (filename) =>
        filename === path.join(retry.rendererPath, '_next/fixture.js')
          ? Promise.resolve({
              isSymbolicLink: () => false,
              isDirectory: () => false,
              isFile: () => true,
              size: 256 * 1024 * 1024 + 1,
            })
          : lstat(filename),
      open: async (...args) => {
        oversizedReads++;
        return open(...args);
      },
    }),
    /evidence bounds/,
  );
  assert.equal(oversizedReads, 0, 'Oversized metadata is rejected before file allocation.');

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let active = 0;
  let maximum = 0;
  const completionOrder = [];
  const ordered = rendererWorkValues(
    await rendererWork(
      Array.from({ length: 12 }, (_, i) => i),
      async (i) => {
        active++;
        maximum = Math.max(maximum, active);
        try {
          await delay(i === 0 ? 20 : 1);
          completionOrder.push(i);
          return `result-${i}`;
        } finally {
          active--;
        }
      },
    ),
  );
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.notEqual(completionOrder[0], 0);
  assert.deepEqual(
    ordered,
    Array.from({ length: 12 }, (_, i) => `result-${i}`),
  );
  const claimed = [];
  active = 0;
  const failedWork = await rendererWork([0, 1, 2, 3, 4, 5], async (i) => {
    claimed.push(i);
    active++;
    try {
      await delay(i === 2 ? 1 : 15);
      if (i === 1 || i === 2) throw new Error(`ordered failure ${i}`);
      return i;
    } finally {
      active--;
    }
  });
  assert.equal(active, 0, 'Every started job drains before failure returns.');
  assert.deepEqual(claimed, [0, 1, 2, 3], 'Failure prevents claiming the suffix.');
  assert.throws(() => rendererWorkValues(failedWork), /ordered failure 1/);

  const orderedRoot = path.join(root, 'ordered-manifest');
  const fixture = [
    ['a/first.txt', 'first'],
    ['a/last.txt', 'last'],
    ['b.txt', 'B'],
    ['c.txt', 'C'],
    ['d.txt', 'D'],
    ['e.txt', 'E'],
    ['empty.txt', ''],
  ];
  for (const [name, contents] of fixture) {
    await mkdir(path.dirname(path.join(orderedRoot, name)), { recursive: true });
    await writeFile(path.join(orderedRoot, name), contents);
  }
  const expectedFiles = fixture
    .map(([name, contents]) => ({
      name,
      bytes: Buffer.byteLength(contents),
      sha256: digest(Buffer.from(contents)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const expectedManifest = {
    sha256: digest(JSON.stringify(expectedFiles)),
    fileCount: expectedFiles.length,
    totalBytes: expectedFiles.reduce((sum, file) => sum + file.bytes, 0),
    files: expectedFiles,
  };
  let ioActive = 0;
  let ioMaximum = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => (releaseFirst = resolve));
  const closedFiles = [];
  const trackedIO = async (operation) => {
    ioActive++;
    ioMaximum = Math.max(ioMaximum, ioActive);
    try {
      return await operation();
    } finally {
      ioActive--;
    }
  };
  const inspected = await inspectRendererManifest(orderedRoot, {
    ...rendererFS,
    lstat: (...args) => trackedIO(() => lstat(...args)),
    realpath: (...args) => trackedIO(() => realpath(...args)),
    readdir: (...args) => trackedIO(() => readdir(...args)),
    readFile: () => {
      throw new Error('Renderer bytes must not use unbounded readFile.');
    },
    open: (...args) =>
      trackedIO(async () => {
        const handle = await open(...args);
        const name = path.relative(orderedRoot, args[0]).split(path.sep).join('/');
        return {
          stat: () => trackedIO(() => handle.stat()),
          read: (...readArgs) =>
            trackedIO(async () => {
              if (name === 'a/first.txt' && readArgs[3] === 0) await firstGate;
              return handle.read(...readArgs);
            }),
          close: () =>
            trackedIO(async () => {
              await handle.close();
              closedFiles.push(name);
              if (name !== 'a/first.txt') releaseFirst();
            }),
        };
      }),
  });
  assert.deepEqual(
    inspected,
    expectedManifest,
    'Out-of-order I/O preserves the original manifest bytes/SHA.',
  );
  assert.equal(ioMaximum, 4, 'Directory recursion and file reads share a four-I/O ceiling.');
  assert.equal(ioActive, 0);
  assert.notEqual(closedFiles[0], 'a/first.txt');
  assert.equal(closedFiles.length, fixture.length);

  const aggregateRoot = path.join(root, 'aggregate-bound');
  await mkdir(aggregateRoot);
  await writeFile(path.join(aggregateRoot, 'a.txt'), 'a');
  await writeFile(path.join(aggregateRoot, 'b.txt'), 'b');
  const aggregateOpens = [];
  await assert.rejects(
    inspectRendererManifest(aggregateRoot, {
      ...rendererFS,
      lstat: async (filename) => {
        const metadata = await lstat(filename);
        return filename === path.join(aggregateRoot, 'b.txt')
          ? new Proxy(metadata, {
              get: (target, key) => (key === 'size' ? rendererByteLimit : Reflect.get(target, key)),
            })
          : metadata;
      },
      open: (...args) => {
        aggregateOpens.push(args[0]);
        return open(...args);
      },
    }),
    /evidence bounds/,
  );
  assert.deepEqual(
    aggregateOpens,
    [path.join(aggregateRoot, 'a.txt')],
    'Aggregate admission refuses the individually legal second file before allocation.',
  );

  const countRoot = path.join(root, 'count-bound');
  const emptyMetadata = {
    size: 0,
    dev: 1,
    ino: 1,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  let countChecks = 0;
  let checksAtFirstOpen;
  let countOpened = 0;
  let countClosed = 0;
  await assert.rejects(
    inspectRendererManifest(countRoot, {
      ...rendererFS,
      realpath: async (filename) => filename,
      readdir: async (filename) => {
        assert.equal(filename, countRoot);
        return Array.from({ length: 10_020 }, (_, i) => ({
          name: `${String(i).padStart(5, '0')}.txt`,
        }));
      },
      lstat: async (filename) => {
        if (filename === countRoot) return { isDirectory: () => true };
        countChecks++;
        return emptyMetadata;
      },
      open: async () => {
        checksAtFirstOpen ??= countChecks;
        countOpened++;
        return {
          stat: async () => emptyMetadata,
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            countClosed++;
          },
        };
      },
    }),
    /evidence bounds/,
  );
  assert.equal(countOpened, 10_000);
  assert.equal(countClosed, countOpened);
  assert.ok(
    checksAtFirstOpen <= 10_008,
    'The file-count boundary stops later metadata batches, not just byte reads.',
  );

  const growthRoot = path.join(root, 'growth-bound');
  const growthPath = path.join(growthRoot, 'a.txt');
  await mkdir(growthRoot);
  await writeFile(growthPath, 'abc');
  let pathChecks = 0;
  let linkedOpens = 0;
  await assert.rejects(
    inspectRendererManifest(growthRoot, {
      ...rendererFS,
      lstat: async (filename) => {
        const metadata = await lstat(filename);
        if (filename !== growthPath || ++pathChecks === 1) return metadata;
        return new Proxy(metadata, {
          get: (target, key) => (key === 'isSymbolicLink' ? () => true : Reflect.get(target, key)),
        });
      },
      open: (...args) => {
        linkedOpens++;
        return open(...args);
      },
    }),
    /Linked/,
  );
  assert.equal(linkedOpens, 0, 'A link introduced after admission cannot be opened.');
  const directoryRaceRoot = path.join(root, 'directory-race');
  for (const name of ['a', 'b']) {
    await mkdir(path.join(directoryRaceRoot, name), { recursive: true });
    await writeFile(path.join(directoryRaceRoot, name, 'entry.txt'), name);
  }
  let queuedDirectoryChecks = 0;
  let linkedDirectoryReads = 0;
  await assert.rejects(
    inspectRendererManifest(directoryRaceRoot, {
      ...rendererFS,
      lstat: async (filename) => {
        const metadata = await lstat(filename);
        if (filename !== path.join(directoryRaceRoot, 'b') || ++queuedDirectoryChecks === 1)
          return metadata;
        return new Proxy(metadata, {
          get: (target, key) => (key === 'isSymbolicLink' ? () => true : Reflect.get(target, key)),
        });
      },
      readdir: (...args) => {
        if (args[0] === path.join(directoryRaceRoot, 'b')) linkedDirectoryReads++;
        return readdir(...args);
      },
    }),
    /Linked renderer directory/,
  );
  assert.equal(linkedDirectoryReads, 0, 'A queued directory is rechecked before traversal.');
  let growthReads = 0;
  let growthClosed = false;
  await assert.rejects(
    inspectRendererManifest(growthRoot, {
      ...rendererFS,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: async () =>
            new Proxy(await handle.stat(), {
              get: (target, key) =>
                key === 'size' ? rendererByteLimit + 1 : Reflect.get(target, key),
            }),
          read: (...readArgs) => {
            growthReads++;
            return handle.read(...readArgs);
          },
          close: async () => {
            await handle.close();
            growthClosed = true;
          },
        };
      },
    }),
    /changed before allocation/,
  );
  assert.equal(growthReads, 0);
  assert.equal(growthClosed, true);
  const { appendFile } = await import('node:fs/promises');
  const readRequests = [];
  growthClosed = false;
  await assert.rejects(
    inspectRendererManifest(growthRoot, {
      ...rendererFS,
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: () => handle.stat(),
          read: async (...readArgs) => {
            readRequests.push({
              allocated: readArgs[0].length,
              requested: readArgs[2],
              position: readArgs[3],
            });
            const result = await handle.read(...readArgs);
            if (readArgs[3] === 0) await appendFile(growthPath, '-grew');
            return result;
          },
          close: async () => {
            await handle.close();
            growthClosed = true;
          },
        };
      },
    }),
    /grew while reading/,
  );
  assert.deepEqual(
    readRequests,
    [
      { allocated: 3, requested: 3, position: 0 },
      { allocated: 1, requested: 1, position: 3 },
    ],
    'Growth receives only the admitted allocation and one fixed-byte probe.',
  );
  assert.equal(growthClosed, true);

  let earlierReadClosed = false;
  await assert.rejects(
    inspectRendererManifest(aggregateRoot, {
      ...rendererFS,
      lstat: async (filename) => {
        const metadata = await lstat(filename);
        return filename === path.join(aggregateRoot, 'b.txt')
          ? new Proxy(metadata, {
              get: (target, key) =>
                key === 'isSymbolicLink' ? () => true : Reflect.get(target, key),
            })
          : metadata;
      },
      open: async (...args) => {
        const handle = await open(...args);
        return {
          stat: () => handle.stat(),
          read: async () => {
            throw new Error('earlier read failure');
          },
          close: async () => {
            await handle.close();
            earlierReadClosed = true;
          },
        };
      },
    }),
    /earlier read failure/,
  );
  assert.equal(
    earlierReadClosed,
    true,
    'An earlier DFS read failure precedes a later metadata failure.',
  );

  for (let i = 0; i < 8; i++)
    await writeFile(path.join(workspaceRoot, 'out/_next', `parallel-${i}.js`), `parallel${i}`);
  const parallelProfile = await mkdtemp(path.join(root, 'parallel-copy-'));
  let copyActive = 0;
  let copyMaximum = 0;
  let firstBatch = 0;
  let releaseCopies;
  const copyGate = new Promise((resolve) => (releaseCopies = resolve));
  let retryStarted = false;
  const firstAttemptCopies = [];
  const parallelCopy = await prepareRendererArtifact({
    workspaceRoot,
    profile: parallelProfile,
    copy: async (source, destination, flags) => {
      assert.equal(flags, constants.COPYFILE_EXCL);
      const firstAttempt = destination.startsWith(
        path.join(parallelProfile, 'renderer/1') + path.sep,
      );
      if (!firstAttempt && !retryStarted) {
        assert.equal(copyActive, 0, 'Retry begins only after every first-attempt copy drains.');
        retryStarted = true;
      }
      copyActive++;
      copyMaximum = Math.max(copyMaximum, copyActive);
      try {
        if (firstAttempt) {
          firstAttemptCopies.push(path.basename(source));
          const failThisCopy = ++firstBatch === 1;
          if (firstBatch === 4) releaseCopies();
          await copyGate;
          if (failThisCopy) throw new Error('injected copy failure');
          await delay(10);
        }
        await copyFile(source, destination, flags);
      } finally {
        copyActive--;
      }
    },
  });
  assert.equal(copyMaximum, 4);
  assert.equal(copyActive, 0);
  assert.equal(firstAttemptCopies.length, 4);
  assert.equal(parallelCopy.attempts.length, 2);
  assert.equal(parallelCopy.attempts[0].status, 'failed');
  assert.equal(parallelCopy.attempts[1].status, 'verified');
  assert.deepEqual(parallelCopy.manifest, await rendererManifest(path.join(workspaceRoot, 'out')));
  console.log(
    'PASS renderer artifact: original replay/path/tamper/race/module checks; four-worker ordered I/O/copy, unchanged manifest SHA, bounded aggregate/handle reads, link/growth rejection, deterministic failure/drain/retry (no Electron/browser)',
  );
}
