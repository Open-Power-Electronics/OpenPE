import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// These executable names and package entry points are owned by the service.
// Renderer input never selects a program, package, path or argument.
export const agentLaunchers = {
  codex: { commands: ['codex'] },
  claude: { commands: ['claude'] },
  deepseek: { commands: ['dsh'] },
  pi: {
    commands: ['pi'],
    entries: [
      '@earendil-works/pi-coding-agent/dist/cli.js',
      '@mariozechner/pi-coding-agent/dist/cli.js',
    ],
  },
};

const windowsCodexTargets = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
};

export function windowsCodexNpmLaunch(shim, exists) {
  const target = windowsCodexTargets[process.arch];
  if (!target) return;
  const modules = path.join(path.dirname(shim), 'node_modules');
  const packageRoot = path.join(modules, '@openai', 'codex');
  if (!exists(path.join(packageRoot, 'bin', 'codex.js'))) return;
  const executable = path.join(
    '@openai',
    `codex-win32-${process.arch}`,
    'vendor',
    target,
    'bin',
    'codex.exe',
  );
  // npm can install the platform package under Codex or hoist it into the same prefix.
  const file = [path.join(packageRoot, 'node_modules'), modules]
    .map((directory) => path.join(directory, executable))
    .find(exists);
  if (!file) return;
  // Spawn the native CLI directly so the host controls its Windows console and stdio.
  return {
    file,
    args: [],
    env: { ...process.env, CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: packageRoot },
  };
}

export function windowsClaudeNpmLaunch(shim, exists) {
  const file = path.join(
    path.dirname(shim),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  if (exists(file)) return { file, args: [], env: process.env };
}

/**
 * @param {string} shim
 * @param {(file: string) => boolean} exists
 * @param {(file: string, args: string[], options: {env?: NodeJS.ProcessEnv, windowsHide?: boolean, timeout?: number, maxBuffer?: number}) => Promise<{stdout: string}>} [run]
 */
export async function windowsDeepSeekNpmLaunch(shim, exists, run = exec) {
  if (!path.isAbsolute(shim)) return;
  const directory = path.dirname(shim);
  const entry = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!exists(entry)) return;
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  // Harness native loader support follows its external Node installation, not
  // the Electron version hosting OpenPE. Never substitute process.execPath.
  // Keep discovery within ten seconds, with at most eight PATH candidates.
  const deadline = performance.now() + 10000;
  const remainingTimeout = () =>
    Math.max(0, Math.min(5000, Math.ceil(deadline - performance.now())));
  const inspected = new Set();
  async function inspect(file) {
    if (!path.isAbsolute(file) || path.basename(file).toLowerCase() !== 'node.exe') return;
    const identity = file.toLowerCase();
    if (inspected.has(identity) || !exists(file)) return;
    inspected.add(identity);
    const timeout = remainingTimeout();
    if (!timeout) return;
    try {
      const { stdout } = await run(
        file,
        [
          '--eval',
          'process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}))',
        ],
        {
          // A misidentified Electron executable must stay headless for this
          // probe, then be rejected by its runtime metadata.
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          timeout,
          maxBuffer: 4096,
        },
      );
      const metadata = JSON.parse(stdout);
      if (
        typeof metadata?.node !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(metadata.node) ||
        metadata.electron !== null
      )
        return;
      // Current DeepSeek Harness requires Node >=24.9.0.
      const [major, minor] = metadata.node.split('.').map(Number);
      if (major < 24 || (major === 24 && minor < 9)) return;
      return { file, args: [entry], env };
    } catch {
      // Continue only to another discovered Node executable, never Electron.
    }
  }
  const sibling = await inspect(path.join(directory, 'node.exe'));
  if (sibling) return sibling;
  let candidates = [];
  const timeout = remainingTimeout();
  try {
    if (timeout) {
      const { stdout } = await run('where.exe', ['node.exe'], {
        windowsHide: true,
        timeout,
        maxBuffer: 64 * 1024,
      });
      candidates = stdout.trim().split(/\r?\n/).slice(0, 8);
    }
  } catch {}
  for (const file of candidates) {
    const launch = await inspect(file);
    if (launch) return launch;
  }
  throw new Error(
    'DeepSeek Harness requires an external Node.js 24.9.0 or newer executable. Install Node.js on PATH and restart OpenPE.',
  );
}

export const piIsolationFlags = [
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-mcp',
  '--no-approve',
  '--offline',
  '--no-session',
];

export const codexIsolationArgs = [
  'features.shell_tool=false',
  'web_search="disabled"',
  'mcp_servers={}',
].flatMap((setting) => ['-c', setting]);

export const rawCodexIsolationArgs = [
  ...codexIsolationArgs,
  ...[
    'features.plugins=false',
    'features.multi_agent=false',
    'features.memories=false',
    'project_doc_max_bytes=0',
  ].flatMap((setting) => ['-c', setting]),
];

// Check the installed CLI's own flags without starting a conversation. Never
// fall back to an older invocation that leaves tools or local resources active.
export async function verifyPiIsolation(launch, options = {}) {
  const { stdout } = await (options.exec || exec)(launch.file, [...launch.args, '--help'], {
    env: launch.env,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (piIsolationFlags.some((flag) => !new RegExp(`${flag}\\b`).test(stdout)))
    throw new Error(
      'Update Pi to a version with isolated RPC support, then detect again in Agent connections.',
    );
}
