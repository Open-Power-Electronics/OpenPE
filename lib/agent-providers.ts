/** Supported Agent identities, independent of local installation and authentication. */
export const agentProviders = [
  {
    id: 'codex',
    name: 'Codex',
    settingsName: 'Codex CLI',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    settingsName: 'Claude Code',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Harness',
    settingsName: 'DeepSeek Harness',
  },
  {
    id: 'pi',
    name: 'Pi',
    settingsName: 'Pi',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    settingsName: 'Cursor',
  },
] as const;

export type AgentProviderId = (typeof agentProviders)[number]['id'];
export const agentProviderIds = agentProviders.map(({ id }) => id);

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return agentProviders.some(({ id }) => id === value);
}

export function agentName(value: string): string {
  return agentProviders.find(({ id }) => id === value)?.name ?? 'Agent';
}
