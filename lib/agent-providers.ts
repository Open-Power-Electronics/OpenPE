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

/** Native protocol values; providers do not share an off/none alias. */
export const reasoningEfforts = [
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export const defaultReasoningEffort: ReasoningEffort = 'medium';
export const providerReasoningEfforts: Record<AgentProviderId, readonly ReasoningEffort[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  deepseek: [],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  cursor: reasoningEfforts,
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && reasoningEfforts.some((effort) => effort === value);
}

export function isProviderReasoningEffort(
  provider: unknown,
  value: unknown,
): value is ReasoningEffort {
  return (
    isAgentProvider(provider) &&
    isReasoningEffort(value) &&
    providerReasoningEfforts[provider].includes(value)
  );
}

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return agentProviders.some(({ id }) => id === value);
}

export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@\[\]-]{0,199}$/.test(value);
}

export function validAgentModelId(provider: string, value: unknown): value is string {
  // ACP select values are opaque and travel only in JSON, never CLI arguments.
  if (provider === 'deepseek')
    return (
      typeof value === 'string' &&
      value.length <= 512 &&
      Boolean(value.trim()) &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    );
  return validModelId(value);
}

export function agentName(value: string): string {
  return agentProviders.find(({ id }) => id === value)?.name ?? 'Agent';
}
