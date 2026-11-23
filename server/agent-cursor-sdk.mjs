import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const version = '1.3.1';
const sdkName = '@cursor/sdk';
const loadExternalSdk = createRequire(import.meta.url);
const supportedHosts = new Set(['win32-x64', 'darwin-arm64', 'linux-x64']);
const platformId = `${process.platform}-${process.arch}`;
const platformName = `${sdkName}-${platformId}`;
const sdkEntry = 'dist/esm/index.js';

function isLocalAbsolute(directory) {
  return process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(directory) : path.isAbsolute(directory);
}

function moduleDirectories() {
  const configured = process.env.OPENPE_CURSOR_SDK_MODULES;
  if (configured !== undefined) return [configured];
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA;
    return roaming && isLocalAbsolute(roaming) ? [path.join(roaming, 'npm', 'node_modules')] : [];
  }
  return process.platform === 'darwin'
    ? ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
    : ['/usr/local/lib/node_modules', '/usr/lib/node_modules'];
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function localFile(directory, name) {
  const file = path.join(directory, name);
  const resolved = await realpath(file);
  const info = await lstat(file);
  if (resolved !== file || !info.isFile() || info.size === 0)
    throw new Error('Unexpected Cursor SDK file.');
  return { file, size: info.size };
}

async function packageManifest(directory, name) {
  const { file, size } = await localFile(directory, 'package.json');
  if (size > 64 * 1024) throw new Error('Invalid Cursor SDK package metadata.');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.name !== name || manifest.version !== version)
    throw new Error('Unsupported Cursor SDK package.');
  return manifest;
}

/** Inspect the external installation without evaluating SDK code or reading credentials. */
export async function findCursorSdk({ directories = moduleDirectories() } = {}) {
  if (!supportedHosts.has(platformId)) throw new Error('Cursor SDK is unavailable on this host.');
  for (const directory of directories) {
    if (!isLocalAbsolute(directory)) continue;
    try {
      const modules = await realpath(directory);
      if (!isLocalAbsolute(modules)) continue;
      const root = path.join(modules, sdkName);
      const manifest = await packageManifest(root, sdkName);
      if (manifest.exports?.['.']?.import !== `./${sdkEntry}`) continue;
      const { file: entry } = await localFile(root, sdkEntry);
      const resolveDependency = createRequire(entry).resolve;
      const platform = path.dirname(resolveDependency(`${platformName}/package.json`));
      if (!inside(modules, platform)) continue;
      await packageManifest(platform, platformName);
      for (const binding of ['tree-sitter', 'tree-sitter-bash'])
        await localFile(platform, `vendor/${binding}/binding.node`);
      return { entry, version };
    } catch {
      // A partial, unsupported or inaccessible installation remains unavailable.
    }
  }
  throw new Error(`Cursor SDK ${version} for ${platformId} was not detected.`);
}

export async function loadCursorSdk() {
  const { entry, version } = await findCursorSdk();
  let sdk;
  try {
    sdk = loadExternalSdk(entry);
  } catch {
    throw new Error('Could not load the detected Cursor SDK.');
  }
  if (typeof sdk.Agent?.create !== 'function' || typeof sdk.Cursor?.models?.list !== 'function')
    throw new Error('Cursor SDK did not export its local agent runtime.');
  if (typeof sdk.JsonlLocalAgentStore !== 'function' || typeof sdk.emptyFs !== 'function')
    throw new Error('Cursor SDK did not export its local isolation runtime.');
  return {
    Agent: sdk.Agent,
    Cursor: sdk.Cursor,
    JsonlLocalAgentStore: sdk.JsonlLocalAgentStore,
    emptyFs: sdk.emptyFs,
    CursorAgentError: sdk.CursorAgentError,
    version,
  };
}
