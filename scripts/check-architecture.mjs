import { readdir, readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CommonJS loading skips ESM named-export lexing of the multi-megabyte compiler bundle.
const ts = createRequire(import.meta.url)('typescript');

// Import boundaries implementing assets/architecture.drawio and docs/ARCHITECTURE.md.
// This checks repository source dependencies, not the internals of npm packages,
// IPC authorization, runtime globals or whether a capability has been registered.
const browserAreas = ['api', 'context', 'core', 'lib', 'app', 'components'];
const hostAreas = new Set(['server', 'electron']);
const sourceAreas = [...browserAreas, ...hostAreas];
const scriptFile = /\.(?:[cm]?[jt]sx?)$/i;
const declarationFile = /\.d\.[cm]?ts$/i;
const nodeOnly = new Set(['lib/default-examples.ts']);
// Generated declarations describe the bounded runtime facades; they execute no
// domain source. Keep these forwards explicit instead of allowing all host types.
const hostDeclarationSources = new Map([
  ['server/project-format.d.mts', 'lib/project.ts'],
  ['server/manufacturing-format.d.mts', 'lib/manufacturing-export.ts'],
  ['server/spice-format.d.mts', 'lib/spice.ts'],
  ['server/thermal-format.d.mts', 'lib/thermal.ts'],
  ['server/model-cad-format.d.mts', 'lib/model-cad.ts'],
  ['server/workspace-format.d.mts', 'lib/workspace-state.ts'],
]);
const coreAdapters = new Set(['lib/library-capabilities.ts']);
const presentationAdapters = new Set([
  ...coreAdapters,
  'lib/provider-plugin-capabilities.ts',
  'lib/simulation-capabilities.ts',
  'lib/thermal-capabilities.ts',
  'lib/workbench-capabilities.ts',
  'lib/workbench-plugins.ts',
  'lib/bridge.ts',
  'lib/source-editor.ts',
  'lib/download.ts',
  'lib/drawing-export.ts',
  'lib/annotation-screenshot.ts',
  // Browser-only SVG flush callbacks connect captures to their mounted camera;
  // they are presentation bindings, never a transitive Core/domain dependency.
  'lib/layout-camera-presentation.ts',
  'lib/pcb-preview-cache.ts',
]);
const permittedAreas = {
  api: new Set(['api']),
  context: new Set(['context', 'api', 'lib']),
  core: new Set(['core', 'api', 'lib']),
  lib: new Set(['lib', 'api']),
  app: new Set(browserAreas),
  components: new Set(browserAreas),
  server: new Set(['server']),
  electron: new Set(['electron', 'server']),
};
const slash = (value) => value.replaceAll('\\', '/');
const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const framework = (specifier) =>
  /^(?:react(?:-dom)?|next|lucide-react|three)(?:\/|$)/.test(specifier) ||
  /^(?:@codemirror|@lezer)\//.test(specifier);
const platform = (specifier) =>
  specifier.startsWith('node:') || isBuiltin(specifier) || /^electron(?:\/|$)/.test(specifier);

/** Parse syntax, including erased type dependencies, without matching comments or strings. */
export function collectDependencies(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const dependencies = [];
  function add(node, argument, typeOnly, kind) {
    const point = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    dependencies.push({
      specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
      typeOnly: typeOnly || parsed.isDeclarationFile,
      kind,
      line: point.line + 1,
      column: point.character + 1,
    });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        !!clause?.isTypeOnly ||
        !!(
          clause &&
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((entry) => entry.isTypeOnly)
        );
      add(node, node.moduleSpecifier, typeOnly, 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const bindings = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        !!(
          bindings &&
          ts.isNamedExports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((entry) => entry.isTypeOnly)
        );
      add(node, node.moduleSpecifier, typeOnly, 'export');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression, node.isTypeOnly, 'import-equals');
    } else if (ts.isImportTypeNode(node)) {
      add(
        node,
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null,
        true,
        'import-type',
      );
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const requireCall = ts.isIdentifier(expression) && expression.text === 'require';
      const moduleRequire =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'module' &&
        expression.name.text === 'require';
      if (expression.kind === ts.SyntaxKind.ImportKeyword || requireCall || moduleRequire)
        add(
          node,
          node.arguments[0],
          false,
          requireCall || moduleRequire ? 'require' : 'dynamic-import',
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return {
    dependencies,
    errors: parsed.parseDiagnostics.map((diagnostic) => ({
      line: parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    })),
  };
}

async function listSources(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Architecture sources cannot be links: ${target}`);
    if (entry.isDirectory()) files.push(...(await listSources(target)));
    else if (entry.isFile() && scriptFile.test(entry.name)) files.push(target);
  }
  return files;
}

/** Read the real tsconfig so relative paths, aliases and JS-to-TS resolution agree with TypeScript. */
export async function checkArchitecture(
  root = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
) {
  root = path.resolve(root);
  const configPath = path.join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  // Only compiler options are needed: source discovery is independent of
  // tsconfig.include, so the host lists no files and TS18003 is expected.
  const { options, errors } = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readDirectory: () => [] },
    root,
  );
  const configErrors = errors.filter((error) => error.code !== 18003);
  if (configErrors.length)
    throw new Error(
      configErrors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  const filenames = (
    await Promise.all(sourceAreas.map((area) => listSources(path.join(root, area))))
  ).flat();
  const sources = await Promise.all(filenames.map((filename) => readFile(filename, 'utf8')));
  const modules = new Map();
  filenames.forEach((filename, index) => {
    const file = slash(path.relative(root, filename));
    modules.set(canonical(file), {
      file,
      filename,
      ...collectDependencies(sources[index], filename),
    });
  });
  const issues = [];
  const issueKeys = new Set();
  function report(module, dependency, code, message) {
    const issue = {
      file: module.file,
      line: dependency.line,
      column: dependency.column ?? 1,
      code,
      message,
    };
    const key = JSON.stringify(issue);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(issue);
    }
  }
  const cache = ts.createModuleResolutionCache(root, canonical, options);
  for (const module of modules.values()) {
    const area = module.file.split('/')[0];
    for (const error of module.errors) report(module, error, 'syntax', error.message);
    for (const dependency of module.dependencies) {
      const specifier = dependency.specifier;
      if (specifier === null) {
        report(
          module,
          dependency,
          'static-dependency',
          'Use a literal module name so its architecture boundary can be checked.',
        );
        continue;
      }
      if (platform(specifier) && !hostAreas.has(area) && !nodeOnly.has(module.file))
        report(
          module,
          dependency,
          'platform',
          `${area} cannot import the Node/Electron module "${specifier}".`,
        );
      if (framework(specifier) && (['core', 'api'].includes(area) || hostAreas.has(area)))
        report(
          module,
          dependency,
          'framework',
          `${area} must remain independent of UI frameworks ("${specifier}").`,
        );
      const resolution = ts.resolveModuleName(
        specifier,
        module.filename,
        options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!resolution) {
        const local =
          specifier.startsWith('.') ||
          specifier.startsWith('@/') ||
          Object.keys(options.paths ?? {}).some((alias) =>
            specifier.startsWith(alias.split('*')[0]),
          );
        if (
          local &&
          (!path.extname(specifier) || scriptFile.test(specifier) || specifier.endsWith('.json'))
        )
          report(
            module,
            dependency,
            'unresolved',
            `Cannot resolve repository module "${specifier}".`,
          );
        continue;
      }
      if (
        resolution.isExternalLibraryImport ||
        slash(resolution.resolvedFileName).includes('/node_modules/')
      )
        continue;
      dependency.target = slash(path.relative(root, resolution.resolvedFileName));
      if (!dependency.typeOnly && declarationFile.test(dependency.target)) {
        // TypeScript resolves ./project-format.mjs to its .d.mts facade. Runtime
        // graph traversal must inspect the executable .mjs instead of its types.
        const executable = dependency.target.replace(/\.d\.([cm]?)ts$/i, '.$1js');
        if (modules.has(canonical(executable))) dependency.target = executable;
        else
          report(
            module,
            dependency,
            'declaration-runtime',
            `Runtime module "${specifier}" resolves only to a declaration file.`,
          );
      }
      dependency.module = modules.get(canonical(dependency.target));
      // JSON, styles and images are data assets rather than source dependency layers.
      if (!scriptFile.test(dependency.target)) continue;
      const targetArea = dependency.target.split('/')[0];
      const adapterCore = area === 'lib' && coreAdapters.has(module.file) && targetArea === 'core';
      const declarationForward =
        dependency.typeOnly && hostDeclarationSources.get(module.file) === dependency.target;
      const nativeWriter =
        module.file === 'server/example-projects.mjs' &&
        dependency.target === 'electron/native-project.cjs';
      if (
        !permittedAreas[area].has(targetArea) &&
        !adapterCore &&
        !declarationForward &&
        !nativeWriter
      )
        report(
          module,
          dependency,
          'layer',
          `${area} cannot depend on ${targetArea} source ("${specifier}").`,
        );
      if (
        !dependency.typeOnly &&
        nodeOnly.has(dependency.target) &&
        !nodeOnly.has(module.file) &&
        !hostAreas.has(area)
      )
        report(
          module,
          dependency,
          'node-only',
          `${dependency.target} is Node-only and cannot enter browser/Core dependencies.`,
        );
    }
  }

  // A pure-looking helper must not smuggle renderer/host adapters into Core or Context.
  // Type-only edges are checked above but do not create runtime reachability.
  for (const area of ['core', 'api', 'context']) {
    const queue = [...modules.values()]
      .filter((module) => module.file.startsWith(`${area}/`))
      .map((module) => ({ module, chain: [module.file] }));
    const visited = new Set();
    for (let index = 0; index < queue.length; index++) {
      const { module, chain } = queue[index];
      if (visited.has(module.file)) continue;
      visited.add(module.file);
      for (const dependency of module.dependencies) {
        if (dependency.typeOnly || !dependency.specifier) continue;
        if (dependency.target && !scriptFile.test(dependency.target)) continue;
        const targetArea = dependency.target?.split('/')[0];
        const adapter = dependency.target && presentationAdapters.has(dependency.target);
        const forbidden =
          (targetArea && !permittedAreas[area].has(targetArea)) ||
          nodeOnly.has(dependency.target) ||
          (['core', 'api'].includes(area) && adapter) ||
          (module.file !== 'lib/default-examples.ts' && platform(dependency.specifier)) ||
          (['core', 'api'].includes(area) && framework(dependency.specifier));
        if (forbidden) {
          report(
            module,
            dependency,
            `${area}-runtime`,
            `${area} runtime crosses its boundary: ${[...chain, dependency.target ?? dependency.specifier].join(' -> ')}.`,
          );
          continue;
        }
        if (dependency.module)
          queue.push({ module: dependency.module, chain: [...chain, dependency.module.file] });
      }
    }
  }
  issues.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
  return {
    files: modules.size,
    dependencies: [...modules.values()].reduce(
      (count, module) => count + module.dependencies.length,
      0,
    ),
    issues,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkArchitecture();
  if (result.issues.length) {
    for (const issue of result.issues)
      console.error(`${issue.file}:${issue.line}:${issue.column} [${issue.code}] ${issue.message}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Architecture boundaries passed (${result.files} source files, ${result.dependencies} dependencies).`,
    );
  }
}
