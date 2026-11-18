import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// These executable names and package entry points are owned by the service.
// Renderer input never selects a program, package, path or argument.
export const agentLaunchers = {
  codex: { commands: ['codex'] },
  claude: { commands: ['claude'], entries: ['@anthropic-ai/claude-code/cli.js'] },
  deepseek: { commands: ['dsh'], entries: ['@deepseek-ai/dsh/lib/bin.js'] },
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
