import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function agentIntegrationError(provider) {
  return provider === 'cursor'
    ? 'Cursor chat is unavailable because its CLI cannot provide a tool-isolated OpenPE session.'
    : null;
}

// These executable names and package entry points are owned by the service.
// Renderer input never selects a program, package, path or argument.
export const agentLaunchers = {
  codex: { commands: ['codex'], entries: ['@openai/codex/bin/codex.js'] },
  claude: { commands: ['claude'], entries: ['@anthropic-ai/claude-code/cli.js'] },
  deepseek: { commands: ['dsh'], entries: ['@deepseek-ai/dsh/lib/bin.js'] },
  pi: {
    commands: ['pi'],
    entries: [
      '@earendil-works/pi-coding-agent/dist/cli.js',
      '@mariozechner/pi-coding-agent/dist/cli.js',
    ],
  },
  cursor: { commands: ['agent', 'cursor-agent'], entries: [] },
};

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
