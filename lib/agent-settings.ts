export type FollowUpMode = 'queue' | 'steer';
export type AgentSettings = { followUpMode: FollowUpMode };
export const defaultAgentSettings: AgentSettings = { followUpMode: 'queue' };
export const agentSettingsKey = 'openpe.agent-settings.v1';

export function validateAgentSettings(value: unknown): AgentSettings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'followUpMode') ||
    !['queue', 'steer'].includes((value as AgentSettings).followUpMode)
  )
    throw new Error('Invalid Agent settings.');
  return { followUpMode: (value as AgentSettings).followUpMode };
}
