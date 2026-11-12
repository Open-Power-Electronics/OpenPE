import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ELECTRON_RUN_AS_NODE resolves ESM imports by walking parent directories, which
// can leave app.asar and hit a workspace copy. Resolution uses Electron's
// asar-aware createRequire and rejects every path outside the packaged resources.
// `electron` is the host binary, not an archive dependency.
// Optional dependencies are required only when package-lock os/cpu matches this
// host. electron-builder packages the host install, not the other platform builds.
// asar stat reports the archived mode. Unpacked files keep the executable bit
// Electron extracts for the host, so bin checks stat that extracted file.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const workspaceRequire = createRequire(path.join(root, 'package.json'));
const typescript = () => workspaceRequire('typescript');

const hosts = {
  'darwin:arm64': {
    executable: path.join(root, 'release', 'mac-arm64', 'OpenPE.app', 'Contents', 'MacOS', 'OpenPE'),
    resources: path.join(root, 'release', 'mac-arm64', 'OpenPE.app', 'Contents', 'Resources'),
    cursor: '@cursor/sdk-darwin-arm64',
    canvas: '@napi-rs/canvas-darwin-arm64',
  },
  'win32:x64': {
    executable: path.join(root, 'release', 'win-unpacked', 'OpenPE.exe'),
    resources: path.join(root, 'release', 'win-unpacked', 'resources'),
    cursor: '@cursor/sdk-win32-x64',
    canvas: '@napi-rs/canvas-win32-x64-msvc',
  },
};

export function packagedHost(platform = process.platform, arch = process.arch) {
  const host = hosts[`${platform}:${arch}`];
  if (!host)
    throw new Error(
      `Unsupported package host ${platform} ${arch}. OpenPE packages Windows x64 and macOS arm64 only.`,
    );
  return host;
}

export function collectRuntimeSpecifiers(source, fileName, { dynamicImports = false } = {}) {
  const ts = typescript();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics?.length) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const text = diagnostic.messageText;
    throw new Error(
      `Cannot parse ${fileName}: ${typeof text === 'string' ? text : text.messageText}`,
    );
  }
  const imported = [];
  const required = [];
  const resolved = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        throw new Error(`Module specifier in ${fileName} must be a string literal.`);
      imported.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (dynamicImports) {
          const argument = node.arguments[0];
          if (!argument || !ts.isStringLiteral(argument))
            throw new Error(`Dynamic import in ${fileName} must be a string literal.`);
          imported.push(argument.text);
        }
      } else if (ts.isIdentifier(expression) && expression.text === 'require') {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) required.push(argument.text);
        else if (dynamicImports)
          throw new Error(`require in ${fileName} must be a string literal.`);
      } else if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'resolve' &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'require'
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument))
          throw new Error(`require.resolve in ${fileName} must be a string literal.`);
        resolved.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { imported, required, resolved };
}

function hostFile(file) {
  const resolved = path.resolve(file);
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = resolved.indexOf(marker);
  if (index < 0) return resolved;
  const extracted = path.join(
    resolved.slice(0, index),
    'app.asar.unpacked',
    resolved.slice(index + marker.length),
  );
  return existsSync(extracted) ? extracted : resolved;
}

function contained(file, directory) {
  const relative = path.relative(directory, path.resolve(file));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function classify(specifier) {
  if (specifier === 'electron') return 'host';
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return 'builtin';
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  )
    return 'relative';
  return 'bare';
}

function packageName(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    if (!scope || !name) throw new Error(`Invalid package specifier ${specifier}.`);
    return `${scope}/${name}`;
  }
  const name = specifier.split('/')[0];
  if (!name) throw new Error(`Invalid package specifier ${specifier}.`);
  return name;
}

function fieldNames(pkg, field) {
  const value = pkg[field];
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${pkg.name} ${field} is invalid.`);
  return Object.keys(value);
}

function insideDirectory(file, directory) {
  const relative = path.relative(directory, path.resolve(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function runElectron(host) {
  return new Promise((resolve, reject) => {
    const child = spawn(host.executable, [fileURLToPath(import.meta.url), host.resources], {
      cwd: host.resources,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Packaged module check exited with ${signal ?? code}.`));
    });
  });
}

async function checkPackagedModules({ resources, host }) {
  const asarPath = path.join(resources, 'app.asar');
  const unpackedPath = `${asarPath}.unpacked`;
  if (!existsSync(asarPath)) throw new Error(`Packaged archive is missing: ${asarPath}`);
  const serverEntry = path.join(asarPath, 'server', 'index.mjs');
  if (!existsSync(serverEntry)) throw new Error(`Packaged service entry is missing: ${serverEntry}`);
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages))
    throw new Error('package-lock.json has no packages.');
  const requires = new Map();
  const requireFrom = (file) => {
    let value = requires.get(file);
    if (!value) {
      value = createRequire(file);
      requires.set(file, value);
    }
    return value;
  };
  const roots = [asarPath, unpackedPath];
  const insideApp = (file) => roots.some((directory) => contained(file, directory));
  let resolvedCount = 0;
  const resolveInside = (fromFile, specifier) => {
    let resolved;
    try {
      resolved = requireFrom(fromFile).resolve(specifier);
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
        throw new Error(`Cannot resolve ${specifier} from ${fromFile} inside the packaged app.`);
      throw error;
    }
    if (!insideApp(resolved))
      throw new Error(`Resolved ${specifier} from ${fromFile} outside the packaged app: ${resolved}`);
    resolvedCount += 1;
    return resolved;
  };
  const owningPackage = (file) => {
    const moduleRoots = [path.join(asarPath, 'node_modules'), path.join(unpackedPath, 'node_modules')];
    let directory = path.dirname(path.resolve(file));
    while (
      moduleRoots.some((moduleRoot) => contained(directory, moduleRoot) || directory === moduleRoot)
    ) {
      const manifestPath = path.join(directory, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string' && manifest.name)
          return { dir: directory, pkgPath: manifestPath, pkg: manifest };
        if (manifest.name !== undefined)
          throw new Error(`Packaged package.json has no name: ${manifestPath}`);
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error(`Packaged module is outside a package: ${file}`);
  };
  const containedFile = (directory, relative, name) => {
    if (typeof relative !== 'string' || !relative)
      throw new Error(`${name} entry is invalid.`);
    const file = path.resolve(directory, relative);
    if (!insideDirectory(file, directory))
      throw new Error(`${name} entry escapes the package: ${relative}`);
    if (!existsSync(file)) throw new Error(`${name} entry is missing: ${relative}`);
    if (!insideApp(file)) throw new Error(`${name} entry is outside the packaged app: ${file}`);
    return file;
  };
  const importFile = (resolved, specifier) => {
    const owned = owningPackage(resolved);
    if (classify(specifier) !== 'bare') return resolved;
    const name = packageName(specifier);
    if (owned.pkg.name !== name)
      throw new Error(`Resolved ${specifier} is ${owned.pkg.name} at ${resolved}.`);
    const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;
    const exported = owned.pkg.exports?.[subpath];
    if (typeof exported === 'string') return containedFile(owned.dir, exported, name);
    if (exported && typeof exported === 'object' && typeof exported.import === 'string')
      return containedFile(owned.dir, exported.import, name);
    return resolved;
  };
  const optionalApplies = (name) => {
    const needle = `node_modules/${name}`;
    const entries = Object.entries(lock.packages).filter(
      ([key]) => key === needle || key.endsWith(`/${needle}`),
    );
    if (!entries.length) throw new Error(`Lockfile is missing optional dependency ${name}.`);
    return entries.some(([, entry]) => {
      if (entry.os && !entry.os.includes(process.platform)) return false;
      if (entry.cpu && !entry.cpu.includes(process.arch)) return false;
      return true;
    });
  };
  const expanded = new Set();
  const packages = new Map();
  const scanQueue = [];
  const scanned = new Set();
  const importFiles = new Set();
  const enqueueScan = (file) => {
    if (scanned.has(file)) return;
    scanned.add(file);
    scanQueue.push(file);
  };
  const assertBins = (manifest, directory) => {
    if (manifest.bin === undefined) return;
    const bins =
      typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : manifest.bin;
    if (!bins || typeof bins !== 'object' || Array.isArray(bins))
      throw new Error(`${manifest.name} bin field is invalid.`);
    for (const relative of Object.values(bins)) {
      if (typeof relative !== 'string' || !relative)
        throw new Error(`${manifest.name} bin path is invalid.`);
      const file = hostFile(containedFile(directory, relative, manifest.name));
      if (!statSync(file).isFile()) throw new Error(`${manifest.name} bin is not a file: ${relative}`);
      if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0)
        throw new Error(`${manifest.name} bin is not executable: ${relative}`);
    }
  };
  const runtimeRelative = (manifest, directory) => {
    const dot = manifest.exports?.['.'];
    if (typeof dot === 'string') return dot;
    if (dot && typeof dot === 'object') {
      const relative =
        typeof dot.import === 'string'
          ? dot.import
          : typeof dot.require === 'string'
            ? dot.require
            : typeof dot.default === 'string'
              ? dot.default
              : null;
      if (!relative) throw new Error(`${manifest.name} export "." has no runtime entry.`);
      return relative;
    }
    if (manifest.exports && typeof manifest.exports === 'object') return null;
    if (manifest.main === false) return null;
    if (typeof manifest.main === 'string' && manifest.main) return manifest.main;
    return existsSync(path.join(directory, 'index.js')) ? 'index.js' : null;
  };
  const findPackagedPackage = (name, fromFile) => {
    const parts = name.split('/');
    let directory = path.dirname(path.resolve(fromFile));
    while (insideApp(directory)) {
      const candidate = path.join(directory, 'node_modules', ...parts, 'package.json');
      if (existsSync(candidate)) {
        if (!insideApp(candidate))
          throw new Error(`Resolved ${name} from ${fromFile} outside the packaged app: ${candidate}`);
        resolvedCount += 1;
        return candidate;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error(`Cannot resolve ${name} from ${fromFile} inside the packaged app.`);
  };
  const assertDependency = (name, fromFile) => {
    const manifestPath = findPackagedPackage(name, fromFile);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== name)
      throw new Error(`Packaged package ${manifestPath} is ${manifest.name}, not ${name}.`);
    const owned = { dir: path.dirname(manifestPath), pkgPath: manifestPath, pkg: manifest };
    expandPackage(owned);
    return owned;
  };
  const queueRuntime = (owned) => {
    const relative = runtimeRelative(owned.pkg, owned.dir);
    if (!relative) return;
    const runtime = containedFile(owned.dir, relative, owned.pkg.name);
    importFiles.add(runtime);
    enqueueScan(runtime);
  };
  function expandPackage(owned) {
    if (expanded.has(owned.dir)) return;
    expanded.add(owned.dir);
    packages.set(owned.pkg.name, owned);
    assertBins(owned.pkg, owned.dir);
    const names = new Set(fieldNames(owned.pkg, 'dependencies'));
    const peerMeta = owned.pkg.peerDependenciesMeta || {};
    for (const name of fieldNames(owned.pkg, 'peerDependencies')) {
      const meta = peerMeta[name];
      if (meta?.optional === true) continue;
      names.add(name);
    }
    for (const name of names) assertDependency(name, owned.pkgPath);
    for (const name of fieldNames(owned.pkg, 'optionalDependencies')) {
      if (!optionalApplies(name)) continue;
      assertDependency(name, owned.pkgPath);
    }
  }
  const drainScans = () => {
    while (scanQueue.length) {
      const file = scanQueue.pop();
      if (!/\.(?:[cm]?js)$/.test(file)) continue;
      const { imported } = collectRuntimeSpecifiers(readFileSync(file, 'utf8'), path.basename(file), {
        dynamicImports: false,
      });
      for (const specifier of new Set(imported)) {
        const kind = classify(specifier);
        if (kind === 'host' || kind === 'builtin') continue;
        const resolved = resolveInside(file, specifier);
        if (kind === 'bare') expandPackage(owningPackage(resolved));
        enqueueScan(importFile(resolved, specifier));
      }
    }
  };
  const note = (file, specifier, mode) => {
    const kind = classify(specifier);
    if (kind === 'host' || kind === 'builtin' || kind === 'relative') return;
    const resolved = resolveInside(file, specifier);
    expandPackage(owningPackage(resolved));
    if (mode === 'resolve') return;
    const runtime = importFile(resolved, specifier);
    importFiles.add(runtime);
    enqueueScan(runtime);
  };
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file);
      else if (info.isFile() && /\.(?:[cm]?js)$/.test(name)) {
        const specifiers = collectRuntimeSpecifiers(readFileSync(file, 'utf8'), name, {
          dynamicImports: true,
        });
        for (const specifier of specifiers.imported) note(file, specifier, 'import');
        for (const specifier of specifiers.required) note(file, specifier, 'require');
        for (const specifier of specifiers.resolved) note(file, specifier, 'resolve');
      }
    }
  };
  walk(path.join(asarPath, 'server'));
  walk(path.join(asarPath, 'electron'));
  const appManifest = JSON.parse(readFileSync(path.join(asarPath, 'package.json'), 'utf8'));
  for (const name of fieldNames(appManifest, 'dependencies')) queueRuntime(assertDependency(name, serverEntry));
  drainScans();
  const cursor = packages.get(host.cursor);
  if (!cursor) throw new Error(`Host Cursor platform package ${host.cursor} was not packaged.`);
  const vendor = path.join(cursor.dir, 'vendor');
  if (!existsSync(vendor) || !statSync(vendor).isDirectory())
    throw new Error(`Cursor platform package is missing vendor natives: ${vendor}`);
  const nativeNames = readdirSync(vendor);
  for (const required of ['tree-sitter', 'tree-sitter-bash']) {
    if (!nativeNames.includes(required))
      throw new Error(`Cursor platform package is missing ${required}.`);
  }
  for (const name of nativeNames) {
    const index = containedFile(vendor, path.join(name, 'index.js'), name);
    const binding = containedFile(vendor, path.join(name, 'binding.node'), name);
    if (!statSync(binding).isFile()) throw new Error(`Cursor native ${name} binding is missing.`);
    requireFrom(index)(index);
  }
  if (!packages.has(host.canvas))
    throw new Error(`Host canvas package ${host.canvas} was not packaged.`);
  requireFrom(serverEntry)(host.canvas);
  const before = new Set(Object.keys(requireFrom(serverEntry).cache));
  for (const file of importFiles) await import(pathToFileURL(file).href);
  for (const file of Object.keys(requireFrom(serverEntry).cache)) {
    if (before.has(file)) continue;
    if (!insideApp(file)) throw new Error(`Packaged module loaded from outside the app: ${file}`);
  }
  console.log(
    `Packaged service modules resolved inside ${resources} (${resolvedCount} resolutions, ${packages.size} packages).`,
  );
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const host = packagedHost();
  if (process.versions.electron) {
    if (!process.argv[2]) throw new Error('Packaged resources path is required.');
    const resources = path.resolve(process.argv[2]);
    if (resources !== path.resolve(host.resources))
      throw new Error(`Packaged resources path must be ${host.resources}.`);
    await checkPackagedModules({ resources, host });
  } else {
    if (!existsSync(host.executable))
      throw new Error(`Packaged executable is missing: ${host.executable}`);
    if (!existsSync(path.join(host.resources, 'app.asar')))
      throw new Error(`Packaged archive is missing: ${path.join(host.resources, 'app.asar')}`);
    await runElectron(host);
  }
}
